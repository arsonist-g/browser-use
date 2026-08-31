// bu-daemon 常驻单例:HTTP /rpc /status /health + 会话编排(DEC-007/008)
// 编排序列见 backend-design/api-contract.md §2.1 session.start
import http from "node:http";
import fs from "node:fs";
import path from "node:path";
import { loadConfig } from "./config.mjs";
import { ensureHome, BU_HOME, DAEMON_LOG_PATH, DAEMON_PID_PATH, PROFILES_DIR, sessionDir } from "./paths.mjs";
import { createSessionDoc, loadSession, listSessions, terminateSession, updateSession, saveSession } from "./sessions.mjs";
import { CoreProcess } from "./core-manager.mjs";
import { PipeBrowser } from "./pipe-browser.mjs";
import { BridgeServer, toDpCookie } from "./bridge-server.mjs";

const VERSION = "0.1.0";
const EXT_ALIVE_PROBE_MS = 2000; // Edge 进程探测间隔

const config = loadConfig(true);
ensureHome();

const logBuf = [];
function log(tag, line) {
  const entry = JSON.stringify({ ts: new Date().toISOString(), tag, msg: String(line) });
  logBuf.push(entry);
  if (logBuf.length > 500) logBuf.shift();
  try { fs.appendFileSync(DAEMON_LOG_PATH, entry + "\n"); } catch { /* */ }
}

// ---- 日志滚动(oldest-first,DEC-010) ----
function rollLog() {
  try {
    const st = fs.statSync(DAEMON_LOG_PATH);
    if (st.size > config.log_max_bytes) {
      fs.renameSync(DAEMON_LOG_PATH, DAEMON_LOG_PATH + ".1");
    }
  } catch { /* 不存在 */ }
}
setInterval(rollLog, 60000).unref();

// ---- 浏览器存活探测:桥扩展自身连接与否才是真信号 ----

// ---- 桥(无感配对:回环即信任,DEC-012) ----
const bridge = new BridgeServer({
  port: config.bridge_ws_port,
  timeoutMs: config.bridge_req_timeout_ms,
  log,
});

// ---- 会话表(内存:session_id -> {core}) ----
const liveCores = new Map();
// 会话浏览器进程(session_id -> PipeBrowser;pipe 通道为 PWA/Extensions 域唯一入口)
const liveBrowsers = new Map();

function findFreePort() {
  const used = new Set(listSessions().filter((s) => ["starting", "ready", "in_use"].includes(s.state)).map((s) => s.port));
  const [lo, hi] = config.port_range;
  for (let p = lo; p <= hi; p++) if (!used.has(p)) return p;
  throw Object.assign(new Error(`端口段 ${lo}-${hi} 已用尽`), { code: "PORT_EXHAUSTED" });
}

function resolveBrowserExe(override) {
  if (override) return override;
  if (config.browser_exe) return config.browser_exe;
  const candidates = [
    "C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe",
    "C:\\Program Files\\Microsoft\\Edge\\Application\\msedge.exe",
    "C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe",
    "C:\\Program Files (x86)\\Google\\Chrome\\Application\\chrome.exe",
  ];
  for (const c of candidates) {
    try { fs.accessSync(c); return c; } catch { /* next */ }
  }
  throw Object.assign(new Error("未找到 Edge/Chrome,请用 config set browser_exe 指定"), { code: "BROWSER_NOT_RUNNING" });
}

/** session.start 编排:spawn 浏览器(pipe+port)→ spawn core(attach)→ 桥读 cookie → 注入 */
async function startSession({ headless, browser_exe, extra_flags }) {
  const port = findFreePort();
  const exe = resolveBrowserExe(browser_exe);
  const headlessFlag = headless ?? config.headless_default;
  const flags = [...new Set([...(config.extra_flags ?? []), ...(extra_flags ?? [])])];
  const doc = createSessionDoc({ port, profileDir: PROFILES_DIR, browserExe: exe, headless: headlessFlag });
  const id = doc.session_id;
  const finalProfile = path.join(PROFILES_DIR, id);
  updateSession(id, { profile_dir: finalProfile });
  fs.mkdirSync(finalProfile, { recursive: true });

  // 1. daemon 自托管浏览器进程(port 给 DP 接管,pipe 给 PWA/Extensions 域)
  const browser = new PipeBrowser({ log });
  try {
    await browser.launch({ exe, port, profileDir: finalProfile, headless: headlessFlag,
      extraFlags: flags, disableExtensions: !!config.disable_extensions });
  } catch (e) {
    terminateSession(id, "failed", e.message);
    throw e;
  }
  liveBrowsers.set(id, browser);
  updateSession(id, { edge_pid_root: browser.pid });

  // 2. spawn core(attach 模式接管已运行实例)
  const core = new CoreProcess({
    sessionId: id, port, profileDir: finalProfile, headless: headlessFlag,
    browserExe: exe, sessionDir: sessionDir(id), log,
    daemonPort: config.daemon_http_port,
    extraArgs: ["--attach", ...flags.map((f) => `--extra-flag=${f}`)],
  });
  liveCores.set(id, core);
  core.onExit = (code, signal) => {
    if (code !== 0 && code !== null) {
      log("core", `abnormal exit session=${id} code=${code}`);
      try { terminateSession(id, "crashed", `core exited code=${code}`); } catch { /* */ }
      liveBrowsers.get(id)?.killTree().catch(() => {});
      liveBrowsers.delete(id);
    }
    liveCores.delete(id);
  };

  try {
    await core.start(); // core.startup:DP 接管实例
    const s = loadSession(id);
    s.core_pid = core.proc.pid;
    saveSession(s);
  } catch (e) {
    await core.killTree();
    await browser.killTree().catch(() => {});
    liveBrowsers.delete(id);
    terminateSession(id, "failed", e.message);
    liveCores.delete(id);
    throw e;
  }

  // 桥读 cookie + 注入(失败不终止 —— AI 裁决,PM 场景主线)
  const login = await injectLogin(id, core);
  updateSession(id, { state: "ready", login_state: login });
  return { session_id: id, state: "ready", port, login_state: login, login_hint: login === "injected" ? null : "aid_ecide" };
}

async function injectLogin(id, core) {
  if (!bridge.connected) {
    log("bridge", `session=${id} bridge not connected -> login_state=empty(aid_ecide)`);
    return "empty";
  }
  try {
    const cookies = await bridge.getCookies();
    const dpCookies = cookies.map(toDpCookie);
    const res = await core.call("cookie.inject", { cookies: dpCookies }, config.bridge_req_timeout_ms + 10000);
    updateSession(id, {
      login_state: res.injected > 0 ? "injected" : "empty",
      snapshots: [...loadSession(id).snapshots, {
        snapshot_id: `snap-${Date.now()}`,
        captured_at: new Date().toISOString(),
        count: res.injected,
        http_only_count: dpCookies.filter((c) => c.httpOnly).length,
        source: "bridge:v1",
        result: res.injected > 0 ? "injected" : "empty",
      }],
    });
    return res.injected > 0 ? "injected" : "empty";
  } catch (e) {
    log("bridge", `session=${id} cookie inject failed: ${e.message}`);
    return "empty";
  }
}

// ---- 兜底清理 ----
async function stopSession(id) {
  const doc = loadSession(id);
  const core = liveCores.get(id);
  if (core) {
    try { await core.call("core.stop", {}, 5000); } catch { /* 强杀路径 */ }
    await core.killTree();
    liveCores.delete(id);
  }
  // 浏览器进程兜底清理(core.stop 已 quit 时为 no-op)
  const browser = liveBrowsers.get(id);
  if (browser) {
    await browser.killTree();
    liveBrowsers.delete(id);
  }
  // profile 删除(独立于 core 生命周期)
  try { fs.rmSync(doc.profile_dir, { recursive: true, force: true }); } catch { /* 可能仍被占用,保留失败标记 */ }
  const done = terminateSession(id, "cleaned", doc.last_error);
  // 摘要:toollog 行数 + artifacts 文件数
  let toolCount = 0;
  try {
    const lines = fs.readFileSync(path.join(sessionDir(id), "toollog.jsonl"), "utf8").trim().split("\n");
    toolCount = lines.filter(Boolean).length;
  } catch { /* 无日志 */ }
  let artifactCount = 0;
  try { artifactCount = fs.readdirSync(path.join(sessionDir(id), "artifacts")).length; } catch { /* */ }
  const summary = {
    tools: toolCount, artifacts: artifactCount,
    duration_ms: done.ended_at ? Date.parse(done.ended_at) - Date.parse(doc.created_at) : 0,
  };
  return { state: done.state, summary };
}

async function cleanOrphans() {
  const cleaned = [];
  for (const doc of listSessions()) {
    if (["cleaned", "failed"].includes(doc.state)) continue;
    const core = liveCores.get(doc.session_id);
    if (!core) {
      // 非本 daemon 实例的会话,pid 存活性检查
      try { process.kill(doc.core_pid, 0); continue; } catch { /* dead */ }
      killTreeByPid(doc.edge_pid_root); // 孤儿浏览器进程(上一代 daemon 遗留)
      try { fs.rmSync(doc.profile_dir, { recursive: true, force: true }); } catch { /* */ }
      terminateSession(doc.session_id, "cleaned", "orphan cleaned");
      cleaned.push(doc.session_id);
    }
  }
  return { cleaned, kept: [] };
}

function killTreeByPid(pid) {
  if (!pid) return;
  try {
    if (process.platform === "win32") {
      import("node:child_process").then(({ spawn }) =>
        spawn("taskkill", ["/PID", String(pid), "/T", "/F"], { stdio: "ignore" }));
    } else {
      process.kill(pid, "SIGKILL");
    }
  } catch { /* 已退出 */ }
}

// ---- RPC 路由 ----
async function route(op, payload) {
  switch (op) {
    case "session.start": return startSession(payload ?? {});
    case "session.stop": return stopSession(payload.session_id);
    case "session.bare": {
      if (!payload.session_id || !liveCores.has(payload.session_id)) {
        throw Object.assign(new Error("session not found or not live"), { code: "SESSION_NOT_FOUND" });
      }
      return { session_id: payload.session_id, state: "ready", login_state: "bare" };
    }
    case "session.list": return { sessions: listSessions(payload?.state).map(shrink) };
    case "session.clean": return cleanOrphans();
    case "bridge.status": return {
      connected: bridge.connected, proto: bridge.extHello?.proto ?? null,
      last_cookie_at: bridge.lastCookieAt ? new Date(bridge.lastCookieAt).toISOString() : null,
    };
    case "bridge.wait": {
      const deadline = Date.now() + Math.min(payload?.timeout_ms ?? config.self_heal_timeout_ms, 120000);
      while (Date.now() < deadline) {
        if (bridge.connected) return { connected: true };
        await new Promise((r) => setTimeout(r, 500));
      }
      throw Object.assign(new Error("桥等待超时"), { code: "BRIDGE_TIMEOUT", retryable: true });
    }
    case "tool.call": {
      const core = liveCores.get(payload.session_id);
      if (!core) throw Object.assign(new Error(`session not found: ${payload.session_id}`), { code: "SESSION_NOT_FOUND" });
      updateSession(payload.session_id, { state: "in_use" });
      const timeoutMs = Math.min(Number(payload.timeout_ms) || config.tool_default_timeout_ms, 600000);
      return await core.call("tool.call", { tool: payload.tool, args: payload.args ?? {} }, timeoutMs);
    }
    default:
      throw Object.assign(new Error(`unknown op: ${op}`), { code: "INVALID_ARG" });
  }
}

function shrink(doc) {
  const { session_id, state, login_state, created_at, ended_at, port, last_error } = doc;
  return { session_id, state, login_state, created_at, ended_at, port, last_error };
}

// ---- HTTP ----
const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, "http://127.0.0.1");
  const send = (code, obj) => {
    const body = JSON.stringify(obj);
    res.writeHead(code, { "Content-Type": "application/json" });
    res.end(body);
  };
  if (req.method === "GET" && url.pathname === "/health") return send(200, { ok: true, version: VERSION });
  if (req.method === "GET" && url.pathname === "/status") {
    return send(200, {
      version: VERSION, uptime_s: Math.floor(process.uptime()),
      bridge: { connected: bridge.connected, proto: bridge.extHello?.proto ?? null },
      sessions: listSessions().filter((s) => ["starting", "ready", "in_use"].includes(s.state)).map(shrink),
    });
  }
  if (req.method === "POST" && url.pathname === "/pipe/cdp") {
    // pipe 通道转发(core 的 PWA/Extensions 工具经此调浏览器 fd3/4 直连 CDP)
    let body = "";
    req.on("data", (c) => (body += c));
    req.on("end", async () => {
      let p;
      try { p = JSON.parse(body); } catch { return send(400, errorBody("INVALID_ARG", "bad json")); }
      const { session_id, method, params, timeout_ms } = p ?? {};
      const browser = session_id ? liveBrowsers.get(session_id) : null;
      if (!browser) return send(404, errorBody("SESSION_NOT_FOUND", `session not found or browser not live: ${session_id}`));
      if (!method) return send(400, errorBody("INVALID_ARG", "need method"));
      try {
        // Extensions.triggerAction 要求 tab target id(page target 不被接受);tab id 仅
        // daemon 侧 auto-attach 层级可见,此处按 page targetId 翻译
        let cdpParams = params ?? {};
        if (method === "Extensions.triggerAction" && cdpParams.targetId && browser.pageToTab.has(cdpParams.targetId)) {
          cdpParams = { ...cdpParams, targetId: browser.pageToTab.get(cdpParams.targetId) };
        }
        const msg = await browser.call(method, cdpParams, timeout_ms ?? 30000);
        if (msg.error) {
          return send(200, { v: 1, ok: false, error: { code: "CDP_ERROR", message: msg.error.message ?? JSON.stringify(msg.error) } });
        }
        return send(200, { v: 1, ok: true, result: msg.result ?? {} });
      } catch (e) {
        return send(503, errorBody(e.code ?? "INTERNAL", e.message));
      }
    });
    return;
  }
  if (req.method === "POST" && url.pathname === "/rpc") {
    let body = "";
    req.on("data", (c) => (body += c));
    req.on("end", async () => {
      let envelope;
      try { envelope = JSON.parse(body); } catch { return send(400, errorBody("INVALID_ARG", "bad json")); }
      const { v, id, op, payload } = envelope ?? {};
      if (v !== 1 || !op) return send(400, errorBody("INVALID_ARG", "need v:1 and op", id));
      try {
        const result = await route(op, payload ?? {});
        send(200, { v: 1, id, op, ok: true, result });
      } catch (e) {
        const code = e.code ?? "INTERNAL";
        const httpCode = { INVALID_ARG: 400, SESSION_NOT_FOUND: 404, SESSION_STATE_CONFLICT: 409, BROWSER_NOT_RUNNING: 503, BRIDGE_NOT_CONNECTED: 200, BRIDGE_TIMEOUT: 200, CORE_DEAD: 503, CORE_TIMEOUT: 503, PORT_EXHAUSTED: 500 }[code] ?? 500;
        send(httpCode, { v: 1, id, op, ok: false, error: { code, message: e.message, retryable: !!e.retryable } });
      }
    });
    return;
  }
  send(404, errorBody("INVALID_ARG", "not found"));
});

function errorBody(code, message, id = null) {
  return { v: 1, id, ok: false, error: { code, message, retryable: false } };
}

server.listen(config.daemon_http_port, "127.0.0.1", () => {
  log("daemon", `listening on 127.0.0.1:${config.daemon_http_port}, bridge ws on ${config.bridge_ws_port}`);
  // pid 文件(单例探活)——必须落在 BU_HOME 绝对路径
  fs.writeFileSync(DAEMON_PID_PATH, String(process.pid));
});

process.on("SIGINT", async () => {
  for (const [, core] of liveCores) await core.killTree().catch(() => {});
  for (const [, browser] of liveBrowsers) await browser.killTree().catch(() => {});
  process.exit(0);
});
