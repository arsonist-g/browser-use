// 浏览器自托管启动 + --remote-debugging-pipe 客户端(PWA/Extensions 域仅 pipe 可达,ws 上实测不可达)。
// node stdio 数组第 4/5 项即子进程 fd 3(命令入)/fd 4(响应出)
// (libuv 以 lpReserved2 块传句柄,Windows 可用);消息为 \0 结尾 JSON。
import { spawn } from "node:child_process";

const PORT_WAIT_MS = 20000;

export class PipeBrowser {
  constructor({ log }) {
    this.log = log;
    this.proc = null;
    this.pid = null;
    this.pending = new Map();  // id -> resolve
    this._id = 0;
    this._buf = Buffer.alloc(0);
    this._tabSessionToTab = new Map();  // tab sessionId -> tab targetId(auto-attach 层级)
    this._pageTab = new Map();          // page targetId -> tab targetId(Extensions.triggerAction 用)
  }

  /** page targetId → tab targetId(tab target 不出现在 Target.getTargets,仅 auto-attach 层级可见)。 */
  get pageToTab() {
    return this._pageTab;
  }

  /** 启动浏览器(port+pipe 双通道)并等待调试端口就绪。 */
  async launch({ exe, port, profileDir, headless, extraFlags = [], disableExtensions = false }) {
    // 端口被残留浏览器占用时,新实例会静默丢失调试端口、接管到僵尸 → 启动前置检直接失败
    if (await this._portAlive(port)) {
      throw Object.assign(new Error(`调试端口 ${port} 已被占用(疑似残留浏览器进程,请 session.clean 或结束该进程)`),
        { code: "PORT_EXHAUSTED" });
    }
    const args = [
      `--remote-debugging-port=${port}`,
      "--remote-debugging-pipe",
      // pipe 启动会使 Chromium 启用 Blink AutomationControlled(navigator.webdriver=true,
      // 一级自动化信号,CF 类检测直接拒绝);显式关掉,恢复浏览器的天然状态。
      // --test-type 抑制 disable-blink-features 触发的"不受支持的命令行标记"黄条(实测占 ~47px 视口)
      "--disable-blink-features=AutomationControlled",
      "--test-type",
      `--user-data-dir=${profileDir}`,
      "--no-first-run",
      "--no-default-browser-check",
      // Edge 首启/同步/更新提示类弹窗与页面全面禁用(与 core 启动模式同套)
      "--disable-features=msFirstRunExperience,msSeamlessWebToBrowserSignIn,msImplicitSignin," +
        "EdgeWelcomePage,EdgeUpdateToast,msEdgeUpdateToast",
      ...extraFlags,
    ];
    // 注意:默认不加 --disable-extensions——CDP Extensions 域在该 flag 下域失效(实测);
    // 洁净度由一次性 profile + 内建页屏蔽 + core prune 保证。
    if (disableExtensions) args.push("--disable-extensions");
    if (headless) args.push("--headless=new");
    this.proc = spawn(exe, args, { stdio: ["ignore", "ignore", "ignore", "pipe", "pipe"] });
    this.pid = this.proc.pid;
    this.proc.stdio[4].on("data", (chunk) => this._onData(chunk));
    this.proc.on("exit", (code) => this.log("browser", `exit session-browser pid=${this.pid} code=${code}`));

    const deadline = Date.now() + PORT_WAIT_MS;
    while (Date.now() < deadline) {
      if (await this._portAlive(port)) {
        // 建 page→tab 映射(Extensions.triggerAction 需要 tab target id)。
        // 浏览器级 auto-attach 以 filter 排除 page,tab target 才会显形(同 puppeteer
        // TargetManager);但不用它的 waitForDebuggerOnStart:true——那会把新 tab 暂停,
        // 与 DP new_tab 竞态(实测偶发 >30s 卡死);纯映射场景无需暂停。
        try {
          await this.call("Target.setAutoAttach", {
            waitForDebuggerOnStart: false, flatten: true, autoAttach: true,
            filter: [{ type: "page", exclude: true }, {}],
          }, 10000);
        } catch { /* */ }
        return { pid: this.pid };
      }
      await new Promise((r) => setTimeout(r, 250));
    }
    await this.killTree();
    throw Object.assign(new Error(`浏览器调试端口 ${port} 未就绪(等待 ${PORT_WAIT_MS}ms 超时)`),
      { code: "BROWSER_NOT_RUNNING" });
  }

  _portAlive(port) {
    return new Promise((resolve) => {
      const req = fetch(`http://127.0.0.1:${port}/json/version`, { signal: AbortSignal.timeout(1500) });
      req.then((r) => resolve(r.ok)).catch(() => resolve(false));
    });
  }

  _onData(chunk) {
    this._buf = Buffer.concat([this._buf, chunk]);
    let idx;
    while ((idx = this._buf.indexOf(0)) !== -1) {
      const raw = this._buf.slice(0, idx).toString("utf8");
      this._buf = this._buf.slice(idx + 1);
      let msg;
      try { msg = JSON.parse(raw); } catch { continue; }
      if (msg.id && this.pending.has(msg.id)) {
        const p = this.pending.get(msg.id);
        this.pending.delete(msg.id);
        p(msg);
      } else if (msg.method === "Target.attachedToTarget") {
        // flatten 模式:信封 sessionId = 父会话;params.sessionId = 新子会话。
        // 全程 waitForDebuggerOnStart:false,无目标被暂停,无需 runIfWaitingForDebugger。
        const ti = msg.params?.targetInfo ?? {};
        const sid = msg.params?.sessionId;
        if (ti.type === "tab") {
          this._tabSessionToTab.set(sid, ti.targetId);
          this._sendRaw({ id: ++this._id, sessionId: sid, method: "Target.setAutoAttach",
            params: { waitForDebuggerOnStart: false, flatten: true, autoAttach: true } });
        } else if (ti.type === "page") {
          const tab = this._tabSessionToTab.get(msg.sessionId);
          if (tab && ti.targetId) this._pageTab.set(ti.targetId, tab);
        }
      }
    }
  }

  _sendRaw(obj) {
    try { this.proc.stdio[3].write(Buffer.from(JSON.stringify(obj) + "\0", "utf8")); } catch { /* */ }
  }

  /** pipe 通道 CDP 调用;返回原始响应({result} 或 {error})。 */
  call(method, params = {}, timeoutMs = 30000) {
    if (!this.proc || this.proc.exitCode !== null) {
      return Promise.reject(Object.assign(new Error("browser process not running"), { code: "BROWSER_NOT_RUNNING" }));
    }
    const id = ++this._id;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(Object.assign(new Error(`pipe CDP ${method} timeout (${timeoutMs}ms)`), { code: "CORE_TIMEOUT" }));
      }, timeoutMs);
      this.pending.set(id, (msg) => { clearTimeout(timer); resolve(msg); });
      this.proc.stdio[3].write(Buffer.from(JSON.stringify({ id, method, params }) + "\0", "utf8"));
    });
  }

  /** 进程树兜底清理(Windows taskkill /T)。 */
  async killTree() {
    if (!this.proc || this.proc.exitCode !== null) return;
    const pid = this.pid;
    if (process.platform === "win32") {
      spawn("taskkill", ["/PID", String(pid), "/T", "/F"], { stdio: "ignore", windowsHide: true });
    } else {
      try { this.proc.kill("SIGKILL"); } catch { /* already gone */ }
    }
    await new Promise((r) => setTimeout(r, 300));
  }
}
