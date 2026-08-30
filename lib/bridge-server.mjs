// 桥 WS 服务端(DEC-006/011):token 配对、proto 握手、单连接、请求队列不拒绝、TTL 缓存
// 协议 v1 见 backend-design/api-contract.md §3
import crypto from "node:crypto";
import { WebSocketServer } from "ws";

const PING_MS = 25000;
const TTL_MS = 2000;

export class BridgeServer {
  constructor({ port, timeoutMs, log }) {
    this.port = port;
    this.timeoutMs = timeoutMs;
    this.log = log;
    this.ext = null;
    this.extHello = null;
    this.lastCookieAt = 0;
    this.queue = [];          // 排队不拒绝(DEC-006 根因修复)
    this.draining = false;
    this.cache = { at: 0, data: null };
    this.wss = new WebSocketServer({ port, host: "127.0.0.1" });
    this.wss.on("connection", (ws, req) => this._onConnection(ws, req));
    this.pingTimer = setInterval(() => {
      if (this.ext && this.ext.readyState === this.ext.OPEN) {
        this.ext.send(JSON.stringify({ type: "ping" }));
      }
    }, PING_MS);
  }

  get connected() {
    return !!(this.ext && this.ext.readyState === this.ext.OPEN);
  }

  _onConnection(ws, req) {
    const url = new URL(req.url, "http://127.0.0.1");
    if (url.searchParams.get("proto") !== "1") {
      ws.close(4002, "proto mismatch");
      return;
    }
    // 无感配对:回环绑定即信任边界(daemon 仅 127.0.0.1);无 token 交互 —— DEC-012
    this.ext = ws;
    this.log("bridge", "extension connected");
    ws.send(JSON.stringify({ type: "hello", proto: 1, daemonVersion: "0.1.0" }));
    ws.on("message", (raw) => this._onMessage(ws, raw));
    ws.on("close", () => {
      if (this.ext === ws) {
        this.ext = null;
        this.extHello = null;
        this.log("bridge", "extension disconnected, waiting reconnect");
      }
    });
    ws.on("error", () => {});
  }

  _onMessage(ws, raw) {
    let m;
    try { m = JSON.parse(raw.toString()); } catch { return; }
    if (m.type === "cookies") {
      this.lastCookieAt = Date.now();
      this.cache = { at: Date.now(), data: m.data };
      this._resolvePending(m.reqId, m.data);
    } else if (m.type === "pong" || m.type === "hello") {
      if (m.type === "hello") this.extHello = m;
    } else if (m.type === "error") {
      this._resolvePending(m.reqId, null, m.message ?? "bridge error");
    }
  }

  _resolvePending(reqId, data, error) {
    this.queue = this.queue.filter((q) => {
      if (q.reqId !== reqId) return true;
      clearTimeout(q.timer);
      if (error) q.reject(new Error(error));
      else q.resolve(data);
      return false;
    });
  }

  /** 读全量 cookie:排队(TTL 内合并)→ 现拉;解析后 reject,不占用队列。 */
  getCookies() {
    if (this.cache.data && Date.now() - this.cache.at < TTL_MS) {
      return Promise.resolve(this.cache.data);
    }
    if (!this.connected) {
      return Promise.reject(Object.assign(
        new Error("桥扩展未连接(请确认日常浏览器已打开且已加载 Browser-Use Bridge)"),
        { code: "BRIDGE_NOT_CONNECTED" }));
    }
    return new Promise((resolve, reject) => {
      const reqId = `r-${crypto.randomUUID()}`;
      const entry = { reqId, resolve, reject, timer: null };
      entry.timer = setTimeout(() => {
        this.queue = this.queue.filter((q) => q !== entry);
        reject(Object.assign(new Error(`桥响应超时(${this.timeoutMs}ms)`), { code: "BRIDGE_TIMEOUT", retryable: true }));
      }, this.timeoutMs);
      this.queue.push(entry);
      this._drain();
    });
  }

  _drain() {
    if (this.draining || !this.connected) return;
    const next = this.queue[0];
    if (!next) return;
    this.draining = true;
    this.ext.send(JSON.stringify({ type: "getCookies", reqId: next.reqId }));
    // 响应经 _resolvePending 移除队首后由 _afterDrain 继续其后的请求
    const wait = setInterval(() => {
      if (this.queue[0] !== next || !this.connected) {
        clearInterval(wait);
        this.draining = false;
        this._drain();
      }
    }, 50);
  }

  close() {
    clearInterval(this.pingTimer);
    try { this.wss.close(); } catch { /* */ }
  }
}

/** chrome.cookies.Cookie → DP set.cookies 格式(实测字段映射) */
export function toDpCookie(c) {
  const sameSiteMap = { no_restriction: "None", strict: "Strict", lax: "Lax", unspecified: null };
  const out = {
    name: c.name,
    value: c.value,
    domain: c.domain,
    path: c.path || "/",
    secure: !!c.secure,
    httpOnly: !!c.httpOnly,
  };
  if (typeof c.expirationDate === "number") out.expires = c.expirationDate;
  const ss = sameSiteMap[c.sameSite];
  if (ss) out.sameSite = ss;
  return out;
}
