// bu-core 进程管理:spawn + stdio NDJSON + 存活监视 + 进程树兜底清理(DEC-007/008)
import { spawn } from "node:child_process";
import crypto from "node:crypto";
import path from "node:path";
import url from "node:url";
import readline from "node:readline";

const CORE_DIR = path.join(path.dirname(url.fileURLToPath(import.meta.url)), "..", "core");
const PY_TIMEOUT_KILL_MS = 5000;

export class CoreProcess {
  constructor({ sessionId, port, profileDir, headless, browserExe, sessionDir, log, daemonPort = 17981, extraArgs = [] }) {
    this.sessionId = sessionId;
    this.log = log;
    this.proc = null;
    this.pending = new Map();   // id -> {resolve, reject, timer}
    this.ready = null;
    this.args = [
      "-m", "bu_core",
      "--session-id", sessionId,
      "--port", String(port),
      "--profile", profileDir,
      "--session-dir", sessionDir,
      ...extraArgs,
    ];
    if (browserExe) this.args.push("--browser-exe", browserExe);
    if (headless) this.args.push("--headless");
    this.env = { ...process.env, PYTHONPATH: CORE_DIR, PYTHONIOENCODING: "utf-8", BU_DAEMON_PORT: String(daemonPort) };
  }

  start() {
    // windowsHide: Windows 上被无控制台方式调用时,python 子进程会自建控制台窗口(黑窗)
    this.proc = spawn(process.platform === "win32" ? "python" : "python3", this.args, {
      env: this.env,
      stdio: ["pipe", "pipe", "pipe"],
      windowsHide: true,
    });
    this.proc.stdout.setEncoding("utf8");
    const rl = readline.createInterface({ input: this.proc.stdout });
    rl.on("line", (line) => this._onLine(line));
    this.proc.stderr.setEncoding("utf8");
    this.proc.stderr.on("data", (d) => this.log("core-stderr", d.trim()));
    this.proc.on("exit", (code, signal) => this._onExit(code, signal));
    // 启动握手
    this.ready = this.call("core.startup", {}, 30000);
    return this.ready;
  }

  _onLine(line) {
    if (!line.trim()) return;
    let msg;
    try { msg = JSON.parse(line); } catch { this.log("core-badline", line.slice(0, 200)); return; }
    const p = this.pending.get(msg.id);
    if (p) {
      clearTimeout(p.timer);
      this.pending.delete(msg.id);
      if (msg.ok) p.resolve(msg.result);
      else {
        const err = new Error(msg.error?.message ?? "core error");
        err.code = msg.error?.code ?? "CORE_ERROR";
        p.reject(err);
      }
    }
  }

  _onExit(code, signal) {
    for (const [, p] of this.pending) {
      clearTimeout(p.timer);
      p.reject(Object.assign(new Error(`core exited (code=${code} signal=${signal})`), { code: "CORE_DEAD" }));
    }
    this.pending.clear();
    this.onExit?.(code, signal);
  }

  call(op, payload = {}, timeoutMs = 30000) {
    if (!this.proc || this.proc.exitCode !== null) {
      return Promise.reject(Object.assign(new Error("core process not running"), { code: "CORE_DEAD" }));
    }
    const id = `r-${crypto.randomUUID()}`;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(Object.assign(new Error(`core timeout on ${op} (${timeoutMs}ms)`), { code: "CORE_TIMEOUT", retryable: true }));
      }, timeoutMs);
      this.pending.set(id, { resolve, reject, timer });
      this.proc.stdin.write(JSON.stringify({ v: 1, id, op, payload }) + "\n");
    });
  }

  /** 进程树兜底清理:taskkill /T(Windows)。返回后进程树应消失。 */
  async killTree() {
    if (!this.proc || this.proc.exitCode !== null) return;
    const pid = this.proc.pid;
    if (process.platform === "win32") {
      spawn("taskkill", ["/PID", String(pid), "/T", "/F"], { stdio: "ignore", windowsHide: true });
    } else {
      try { this.proc.kill("SIGKILL"); } catch { /* already gone */ }
    }
    await new Promise((r) => {
      const t = setTimeout(r, PY_TIMEOUT_KILL_MS);
      this.proc.once("exit", () => { clearTimeout(t); r(); });
    });
  }
}
