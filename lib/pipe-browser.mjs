// 浏览器自托管启动 + CDP 双通道客户端:
//   - HTTP 调试端口(DrissionPage 经它 attach,且浏览器级 ws 复用同一端口)
//   - --remote-debugging-pipe(node stdio 数组第 4/5 项 = 子进程 fd 3(命令入)/fd 4(响应出),
//     libuv 以 lpReserved2 块传句柄,Windows 可用);消息为 \0 结尾 JSON。
// 两通道可并存。CDP 域按通道分工(实测):Extensions 域在浏览器级 ws 上可用(与是否带
// pipe flag 无关),PWA 域仅 pipe 可达(需要 AllowUnsafeOperations,只有 pipe handler 给)。
import { spawn } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { WebSocket } from "ws";

const PORT_WAIT_MS = 20000;
// 双通道试探窗口。Chromium 自 M113 起:命令行带 --remote-debugging-pipe 而 fd 3/4 未
// 打开时,浏览器在 HTTP handler 启动前就以 UNSUPPORTED_PARAM 退出
// (chrome_main_delegate.cc: "Remote debugging pipe file descriptors are not open."),
// 表现为"端口永远不来"——这是上游既有行为,不是 Edge ≥152 的端口抑制,pipe 与端口本可并存。
// 正常环境两通道并存(端口 ~0.14s 就绪),该窗口只作异常环境(如受限令牌下浏览器自我重启、
// pipe 句柄未被继承)的兜底;超时才改 port-only 重起。port-only 下 Extensions 五个工具
// 仍经浏览器级 ws 可用,只损失 PWA 四个工具。
const PIPE_PROBE_MS = 4000;

/**
 * 浏览器级 CDP 方法的通道归属(DEC-030)。Target.* 与 Extensions.* 都是 browser 端点命令,
 * 经浏览器级 ws 可达 —— port-only 降级态下同样成立;PWA.* 需要 AllowUnsafeOperations,
 * 只有 pipe 通道给。daemon 的 /pipe/cdp 按本函数分流,core 侧不关心通道。
 */
export function browserWsMethod(method) {
  return method.startsWith("Target.") || method.startsWith("Extensions.");
}

// 浏览器原生 UI 弹窗种子(启动前写入 profile,浏览器 PrefService 首次启动时合并):
// 翻译气泡 / 密码保存与自动登录 / 地址与信用卡填充 / 通知权限请求。
// 键名均为 Chromium 源码级现行键(prefs 种子机制 = chrome-launcher 官方配方)。
// AI 场景语义:这些气泡是浏览器 UI(非页面元素,点击工具不可达),只能预关;
// 页面级 alert/confirm/prompt 不在此列(走 handle_dialog 工具)。
const POPUP_PREFS = {
  translate: { enabled: false },                    // Chrome 138+ 翻译气泡仅由此 pref 控制
  credentials_enable_service: false,                // 保存密码气泡
  credentials_enable_autosignin: false,
  autofill: { profile_enabled: false, credit_card_enabled: false },  // 保存地址/银行卡
  profile: { default_content_setting_values: { notifications: 2 } },  // 通知权限自动拒绝
};

/** 一次性 profile 的弹窗种子(Default/Preferences + Local State)。 */
function seedPopupPrefs(profileDir) {
  try {
    const def = path.join(profileDir, "Default");
    fs.mkdirSync(def, { recursive: true });
    const prefPath = path.join(def, "Preferences");
    const base = fs.existsSync(prefPath) ? JSON.parse(fs.readFileSync(prefPath, "utf8")) : {};
    fs.writeFileSync(prefPath, JSON.stringify({ ...base, ...POPUP_PREFS }));
    // Local State:命令行 flag 安全警告黄条(本项目大量传 flag,黄条必现)+ 推广通知
    const lsPath = path.join(profileDir, "Local State");
    const lsBase = fs.existsSync(lsPath) ? JSON.parse(fs.readFileSync(lsPath, "utf8")) : {};
    fs.writeFileSync(lsPath, JSON.stringify({
      ...lsBase,
      browser: {
        ...lsBase.browser,
        command_line_flag_security_warnings_enabled: false,
        promotions_enabled: false,
      },
    }));
    return true;
  } catch { return false; }
}

export class PipeBrowser {
  constructor({ log }) {
    this.log = log;
    this.proc = null;
    this.pid = null;
    this.profileDir = null;
    this.port = null;
    /** pipe CDP 通道是否可用(浏览器是否接受了 fd 3/4) */
    this.pipeAvailable = false;
    this._ws = null;           // 浏览器级 ws(Extensions 域通道)
    this.pending = new Map();  // id -> resolve(两条通道共用,id 由 _id 全局递增)
    this._id = 0;
    this._buf = Buffer.alloc(0);
    this._tabSessionToTab = new Map();  // tab sessionId -> tab targetId(auto-attach 层级)
    this._pageTab = new Map();          // page targetId -> tab targetId(Extensions.triggerAction 用)
  }

  /** page targetId → tab targetId(tab target 不出现在 Target.getTargets,仅 auto-attach 层级可见)。 */
  get pageToTab() {
    return this._pageTab;
  }

  /**
   * 启动浏览器:先试 port+pipe 双通道;短窗口内端口不来(浏览器因 fd 3/4 未打开而以 pipe
   * flag 启动失败)就杀掉改 port-only 重起,并把 pipe 标为不可用。
   */
  async launch({ exe, port, profileDir, headless, extraFlags = [], disableExtensions = false }) {
    // 端口被残留浏览器占用时,新实例会静默丢失调试端口、接管到僵尸 → 启动前置检直接失败
    if (await this._portAlive(port)) {
      throw Object.assign(new Error(`调试端口 ${port} 已被占用(疑似残留浏览器进程,请 session.clean 或结束该进程)`),
        { code: "PORT_EXHAUSTED" });
    }
    const opts = { exe, port, profileDir, headless, extraFlags, disableExtensions };

    // 测试钩子:强制 port-only 形态。该形态只在异常环境(如受限令牌下浏览器自我重启)自然
    // 出现,不给出这个开关这条通道就无法回归。只读进程环境,不进 agent 文档,
    // 与 BU_DEV_ALLOW_HEADLESS 同一口径。
    const forcePortOnly = process.env.BU_DEV_FORCE_PORT_ONLY === "1";
    const piped = forcePortOnly
      ? false
      : await this._spawnAndWait({ ...opts, usePipe: true, waitMs: PIPE_PROBE_MS });
    if (piped) return { pid: this.pid };

    await this.killTree();
    this.log("browser",
      forcePortOnly
        ? "port-only session forced by BU_DEV_FORCE_PORT_ONLY (test hook)"
        : `pipe unavailable: the browser aborted with --remote-debugging-pipe (fd 3/4 were not accepted, ` +
          `so startup failed before the HTTP port opened); retrying with the port only — ` +
          `PWA tools are unavailable for this session, Extensions tools still work over the browser ws`);
    const portOnly = await this._spawnAndWait({ ...opts, usePipe: false, waitMs: PORT_WAIT_MS });
    if (!portOnly) {
      await this.killTree();
      throw Object.assign(new Error(`浏览器调试端口 ${port} 未就绪(等待 ${PORT_WAIT_MS}ms 超时)`),
        { code: "BROWSER_NOT_RUNNING" });
    }
    return { pid: this.pid };
  }

  /** 起一次浏览器并等端口就绪。成功 true / 超时 false(调用方决定是否改参数重试)。 */
  async _spawnAndWait({ exe, port, profileDir, headless, extraFlags, disableExtensions, usePipe, waitMs }) {
    const args = [
      `--remote-debugging-port=${port}`,
      // pipe 启动会使 Chromium 启用 Blink AutomationControlled(navigator.webdriver=true,
      // 一级自动化信号,CF 类检测直接拒绝);显式关掉,恢复浏览器的天然状态。
      // --test-type 抑制 disable-blink-features 触发的"不受支持的命令行标记"黄条(实测占 ~47px 视口)
      "--disable-blink-features=AutomationControlled",
      "--test-type",
      `--user-data-dir=${profileDir}`,
      "--no-first-run",
      "--no-default-browser-check",
      // 权限气泡(通知/定位/摄像头等)一律自动拒绝不出 UI:气泡是浏览器 UI,
      // 点击工具不可达;AI 需要权限时经 CDP Browser.grantPermissions 显式授予
      "--deny-permission-prompts",
      // Edge 首启/同步/更新提示类弹窗与页面全面禁用(与 core 启动模式同套)
      "--disable-features=msFirstRunExperience,msSeamlessWebToBrowserSignIn,msImplicitSignin," +
        "EdgeWelcomePage,EdgeUpdateToast,msEdgeUpdateToast",
      ...(usePipe ? ["--remote-debugging-pipe"] : []),
      ...extraFlags,
    ];
    // 注意:默认不加 --disable-extensions——CDP Extensions 域在该 flag 下域失效(实测);
    // 洁净度由一次性 profile + 内建页屏蔽 + core prune 保证。
    if (disableExtensions) args.push("--disable-extensions");
    if (headless) args.push("--headless=new");
    seedPopupPrefs(profileDir);  // 翻译/密码/填充/通知弹窗的 Preferences 种子(spawn 前写)

    // stderr 落 daemon 日志:浏览器启动失败此前是完全静默的(stdio 全 ignore),
    // 这类"端口没起来"的问题因此无法诊断。
    const stdio = usePipe
      ? ["ignore", "ignore", "pipe", "pipe", "pipe"]
      : ["ignore", "ignore", "pipe"];
    this.proc = spawn(exe, args, { stdio });
    this.pid = this.proc.pid;
    this.profileDir = profileDir;
    this.port = port;
    this.proc.stderr.on("data", (chunk) => this.log("browser-stderr", chunk.toString().trim().slice(0, 800)));
    if (usePipe) this.proc.stdio[4].on("data", (chunk) => this._onData(chunk));
    this.proc.on("exit", (code) => this.log("browser", `exit session-browser pid=${this.pid} code=${code}`));

    const deadline = Date.now() + waitMs;
    while (Date.now() < deadline) {
      if (await this._portAlive(port)) {
        this.pipeAvailable = usePipe;
        // 建 page→tab 映射(Extensions.triggerAction 需要 tab target id)。
        // 浏览器级 auto-attach 以 filter 排除 page,tab target 才会显形(同 puppeteer
        // TargetManager);但不用它的 waitForDebuggerOnStart:true——那会把新 tab 暂停,
        // 与 DP new_tab 竞态(实测偶发 >30s 卡死);纯映射场景无需暂停。
        // pipe 可用时在此建;不可用时由浏览器级 ws 建同一份映射(见 _wsBrowser)。
        if (usePipe) {
          try {
            await this.call("Target.setAutoAttach", {
              waitForDebuggerOnStart: false, flatten: true, autoAttach: true,
              filter: [{ type: "page", exclude: true }, {}],
            }, 10000);
          } catch { /* */ }
        }
        return true;
      }
      await new Promise((r) => setTimeout(r, 250));
    }
    return false;
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
      this._dispatch(msg, (o) => this._sendRaw(o));
    }
  }

  /** 通道无关的消息派发:响应按 id 回收,target 事件建 page→tab 映射。send 决定回哪个通道。 */
  _dispatch(msg, send) {
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
        send({ id: ++this._id, sessionId: sid, method: "Target.setAutoAttach",
          params: { waitForDebuggerOnStart: false, flatten: true, autoAttach: true } });
      } else if (ti.type === "page") {
        const tab = this._tabSessionToTab.get(msg.sessionId);
        if (tab && ti.targetId) this._pageTab.set(ti.targetId, tab);
      }
    }
  }

  /**
   * 浏览器级 ws 连接(懒建)。Extensions 域走这条通道:它由 target 层级门控
   * (browser target 可用,page target 报 Method not available),与传输无关,
   * 因此 port-only 降级态下同样可用。PWA 域不在此列(需 pipe)。
   */
  async _wsBrowser() {
    if (this._ws && this._ws.readyState === WebSocket.OPEN) return this._ws;
    if (!this.port) throw Object.assign(new Error("browser port unknown"), { code: "BROWSER_NOT_RUNNING" });
    let info = null;
    try {
      const r = await fetch(`http://127.0.0.1:${this.port}/json/version`, { signal: AbortSignal.timeout(3000) });
      if (r.ok) info = await r.json();
    } catch { /* 下面统一报错 */ }
    if (!info?.webSocketDebuggerUrl) {
      throw Object.assign(new Error(`browser ws endpoint unavailable on port ${this.port}`), { code: "BROWSER_NOT_RUNNING" });
    }
    const ws = new WebSocket(info.webSocketDebuggerUrl, { perMessageDeflate: false });
    await new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(Object.assign(new Error("browser ws connect timeout"), { code: "CORE_TIMEOUT" })), 5000);
      ws.once("open", () => { clearTimeout(timer); resolve(); });
      ws.once("error", (e) => { clearTimeout(timer); reject(Object.assign(new Error(`browser ws connect failed: ${e.message}`), { code: "BROWSER_NOT_RUNNING" })); });
    });
    ws.on("message", (d) => {
      let msg;
      try { msg = JSON.parse(d.toString()); } catch { return; }
      this._dispatch(msg, (o) => { try { ws.send(JSON.stringify(o)); } catch { /* */ } });
    });
    ws.on("error", (e) => this.log("browser-ws", `error: ${e.message}`));
    ws.on("close", () => { if (this._ws === ws) this._ws = null; });
    this._ws = ws;
    // 建 page→tab 映射(Extensions.triggerAction 的 targetId 翻译需要 tab target id);
    // 失败只影响该工具,不阻断其余 Extensions 调用
    try {
      await this._wsCall(ws, "Target.setAutoAttach", {
        waitForDebuggerOnStart: false, flatten: true, autoAttach: true,
        filter: [{ type: "page", exclude: true }, {}],
      }, 10000);
    } catch { /* */ }
    this.log("browser-ws", `connected ${info.Browser ?? ""}`.trim());
    return ws;
  }

  /** 浏览器级 ws 的 CDP 调用;返回原始响应({result} 或 {error})。 */
  async wsCall(method, params = {}, timeoutMs = 30000) {
    return this._wsCall(await this._wsBrowser(), method, params, timeoutMs);
  }

  _wsCall(ws, method, params, timeoutMs) {
    const id = ++this._id;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(Object.assign(new Error(`ws CDP ${method} timeout (${timeoutMs}ms)`), { code: "CORE_TIMEOUT" }));
      }, timeoutMs);
      this.pending.set(id, (msg) => { clearTimeout(timer); resolve(msg); });
      try { ws.send(JSON.stringify({ id, method, params })); }
      catch (e) {
        this.pending.delete(id); clearTimeout(timer);
        reject(Object.assign(new Error(`ws CDP send failed: ${e.message}`), { code: "BROWSER_NOT_RUNNING" }));
      }
    });
  }

  _sendRaw(obj) {
    try { this.proc.stdio[3].write(Buffer.from(JSON.stringify(obj) + "\0", "utf8")); } catch { /* */ }
  }

  /** pipe 通道 CDP 调用(PWA 域专用);返回原始响应({result} 或 {error})。 */
  call(method, params = {}, timeoutMs = 30000) {
    if (!this.pipeAvailable) {
      return Promise.reject(Object.assign(new Error(
        "pipe CDP unavailable: this browser did not accept fd 3/4 for --remote-debugging-pipe " +
        "(Chromium aborts startup in that case, e.g. when the browser relaunches itself in a restricted context), " +
        "so the session runs port-only; PWA tools are not available"),
        { code: "PIPE_UNAVAILABLE" }));
    }
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

  /**
   * 进程树清理。Edge 的 msedge.exe 启动器会立刻退出、真实浏览器是它的子进程,此时
   * `taskkill /PID <launcher> /T` 找不到树 → 会留下孤儿浏览器(会话因此长期停在
   * in_use)。所以除了按 pid 杀,再按本次会话的 profile 路径精确匹配浏览器进程 ——
   * 只杀本会话起的那个实例,绝不误杀用户自己开的 Edge。
   */
  async killTree() {
    try { this._ws?.close(); } catch { /* */ }
    this._ws = null;
    const pid = this.pid;
    if (process.platform === "win32") {
      if (pid && this.proc && this.proc.exitCode === null) {
        spawn("taskkill", ["/PID", String(pid), "/T", "/F"], { stdio: "ignore", windowsHide: true });
      }
      if (this.profileDir) {
        const escaped = this.profileDir.replace(/'/g, "''");
        const ps = `Get-CimInstance Win32_Process -Filter "Name='msedge.exe'" | ` +
          `Where-Object { $_.CommandLine -like '*${escaped}*' } | ` +
          `ForEach-Object { Stop-Process -Id $_.ProcessId -Force -ErrorAction SilentlyContinue }`;
        await new Promise((resolve) => {
          const killer = spawn("powershell", ["-NoProfile", "-NonInteractive", "-Command", ps], { stdio: "ignore", windowsHide: true });
          killer.on("close", resolve);
          killer.on("error", resolve);
        });
      }
    } else {
      try { this.proc?.kill("SIGKILL"); } catch { /* already gone */ }
    }
    await new Promise((r) => setTimeout(r, 300));
  }
}
