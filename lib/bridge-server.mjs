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
    this.extStorageProto = 1; // hello 报的存储协商版本;旧扩展没有该字段 → 1(存储捎在 cookie 回复里)
    this.lastCookieAt = 0;
    this.round = null;        // 最近一轮读登录态:{reqId, storage, waiter};storage 到齐前为 null
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
        this.extStorageProto = 1;
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
      // 协商 1 的扩展把存储捎在同一条回复里(旧路径,当场结算);协商 2 的扩展随后单独发 storage
      if (this.extStorageProto < 2 && (m.storage !== undefined || m.storageStats !== undefined)) {
        this._setRoundStorage(m.reqId, m.storage, m.storageStats);
      }
      this._resolvePending(m.reqId, m.data);
    } else if (m.type === "storage") {
      this._setRoundStorage(m.reqId, m.storage, m.storageStats);
    } else if (m.type === "pong" || m.type === "hello") {
      if (m.type === "hello") {
        this.extHello = m;
        this.extStorageProto = Number(m.storageProto) >= 2 ? 2 : 1;
      }
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

  /**
   * 读全量 cookie:排队(TTL 内合并)→ 现拉;解析后 reject,不占用队列。
   * withStorage=true 表示这一轮还要页内 Web 存储,取法按扩展协商的 storageProto 分两条路
   * (见 waitForWebStorage)。**cookie 与存储分开结算**:存储慢、卡住都不再拖着 cookie 一起等。
   */
  getCookies({ withStorage = false } = {}) {
    if (this.cache.data && Date.now() - this.cache.at < TTL_MS) {
      return Promise.resolve(this.cache.data); // 同一轮:round 原样留着,它的存储就是这一轮的
    }
    if (!this.connected) {
      return Promise.reject(Object.assign(
        new Error("桥扩展未连接(请确认日常浏览器已打开且已加载 Browser-Use Bridge)"),
        { code: "BRIDGE_NOT_CONNECTED" }));
    }
    return new Promise((resolve, reject) => {
      const reqId = `r-${crypto.randomUUID()}`;
      const entry = { reqId, resolve, reject, timer: null, withStorage: !!withStorage };
      this.round = { reqId, storage: null, storageTimedOut: false, waiter: null };
      entry.timer = setTimeout(() => {
        this.queue = this.queue.filter((q) => q !== entry);
        reject(Object.assign(new Error(`桥响应超时(${this.timeoutMs}ms)`), { code: "BRIDGE_TIMEOUT", retryable: true }));
      }, this.timeoutMs);
      this.queue.push(entry);
      this._drain();
    });
  }

  /** 存储到了:记进"要它的那一轮"并唤醒等待方;迟到的旧轮不惊动当前轮。 */
  _setRoundStorage(reqId, rawOrigins, stats) {
    const round = this.round;
    if (!round || round.reqId !== reqId) return;
    round.storage = { origins: normalizeStorage(rawOrigins), stats: stats ?? null };
    const waiter = round.waiter;
    round.waiter = null;
    if (waiter) waiter(round.storage);
  }

  /**
   * 等"最近一轮"的 Web 存储,返回 {origins, stats, arrived, timed_out}。
   * 协商 2:存储走单独一条消息,这里等它;到预算还没来就报 timed_out 并记住这一轮别再等
   * (现场 2026-10-08:日常浏览器里有个标签页不回话时,老实现拖着 cookie 一起等到桥超时,
   * 整次注入判空、start 报 login=empty —— 超时只该丢掉存储这半)。
   * 协商 1 的旧扩展:cookie 到手时答案就已经在了(没有 storage 字段就是它没有这个能力),不等。
   */
  waitForWebStorage({ waitMs = 5000 } = {}) {
    const empty = { origins: [], stats: null, arrived: false, timed_out: false };
    const round = this.round;
    if (round?.storage) return Promise.resolve({ ...round.storage, arrived: true, timed_out: false });
    if (this.extStorageProto < 2) return Promise.resolve(empty);
    if (!round || round.storageTimedOut || !this.connected) {
      return Promise.resolve({ ...empty, timed_out: !!round?.storageTimedOut });
    }
    return new Promise((resolve) => {
      const onStorage = (storage) => {
        clearTimeout(timer);
        resolve({ ...storage, arrived: true, timed_out: false });
      };
      const timer = setTimeout(() => {
        round.storageTimedOut = true;
        if (round.waiter === onStorage) round.waiter = null;
        resolve({ ...empty, timed_out: true });
      }, waitMs);
      round.waiter = onStorage;
    });
  }

  _drain() {
    if (this.draining || !this.connected) return;
    const next = this.queue[0];
    if (!next) return;
    this.draining = true;
    this.ext.send(JSON.stringify({
      type: "getCookies", reqId: next.reqId, wantStorage: !!next.withStorage,
    }));
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

/**
 * 扩展上报的 Web 存储 → 直达 core 的规范形态 [{origin, local, session}]。
 * 来自扩展(跨进程输入),所以逐项验形:坏项丢掉而不是把畸形数据塞进会话。
 */
export function normalizeStorage(raw) {
  if (!Array.isArray(raw)) return [];
  const out = [];
  for (const rec of raw) {
    if (!rec || typeof rec.origin !== "string") continue;
    let origin;
    try { origin = new URL(rec.origin).origin; } catch { continue; }
    if (origin !== rec.origin || !/^https?:$/.test(new URL(origin).protocol)) continue;
    const pick = (v) => {
      if (!v || typeof v !== "object" || Array.isArray(v)) return {};
      const o = {};
      for (const [k, val] of Object.entries(v)) if (typeof val === "string") o[k] = val;
      return o;
    };
    const local = pick(rec.local);
    const session = pick(rec.session);
    if (!Object.keys(local).length && !Object.keys(session).length) continue;
    out.push({ origin, local, session });
  }
  return out;
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
