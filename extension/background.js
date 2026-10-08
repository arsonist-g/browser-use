// Browser-Use Bridge 桥扩展 service worker
// 职责单一:连 daemon(17990, 无感配对 DEC-012)→ 响应 getCookies(chrome.cookies.getAll 全量含 httpOnly)
// 自愈:WS onclose 指数退避重连 + chrome.alarms 兜底(协议 v1,api-contract §3)
// 图标即状态:深色底 + 品牌字 + 右下状态圆点(绿=已连/黄=等待/红=离线),绘制全防御
const DAEMON_WS = "ws://127.0.0.1:17990";
const DAEMON_HTTP = "http://127.0.0.1:17981";
const STATE_COLORS = { connected: "#2fbf71", link: "#e0a52e", off: "#ef5a5f" };
const STATE_TITLES = {
  connected: "Browser-Use Bridge: 已连接 daemon · 登录态通道就绪(cookie + Web 存储)",
  link: "Browser-Use Bridge: daemon 在线,等待连接(自动重连中)",
  off: "Browser-Use Bridge: daemon 离线 — 运行 browser-use start 拉起",
};

let ws = null;
let backoffMs = 1000;

function setUiState(state, detail) {
  try {
    chrome.storage.local.set({ uiState: state, uiDetail: detail ?? "" });
  } catch (e) { /* */ }
}

function drawIcon(state) {
  const dot = STATE_COLORS[state] ?? STATE_COLORS.off;
  try {
    const imageData = {};
    for (const size of [16, 32]) {
      const canvas = new OffscreenCanvas(size, size);
      const ctx = canvas.getContext("2d");
      const s = size / 32;
      ctx.fillStyle = "#1f2229";
      ctx.beginPath();
      if (ctx.roundRect) ctx.roundRect(1 * s, 1 * s, 30 * s, 30 * s, 7 * s);
      else ctx.rect(1 * s, 1 * s, 30 * s, 30 * s);
      ctx.fill();
      ctx.lineWidth = 1.5 * s;
      ctx.strokeStyle = "#3a4150";
      ctx.stroke();
      ctx.fillStyle = "#e8eaee";
      ctx.font = "bold " + Math.round(19 * s) + "px sans-serif";
      ctx.textAlign = "center";
      ctx.textBaseline = "middle";
      ctx.fillText("B", 14 * s, 16 * s);
      ctx.beginPath();
      ctx.arc(24 * s, 24 * s, 6.5 * s, 0, Math.PI * 2);
      ctx.fillStyle = dot;
      ctx.fill();
      ctx.lineWidth = 2 * s;
      ctx.strokeStyle = "#16181d";
      ctx.stroke();
      imageData[size] = ctx.getImageData(0, 0, size, size);
    }
    chrome.action.setIcon({ imageData });
    chrome.action.setBadgeText({ text: "" });
  } catch (e) {
    try {
      chrome.action.setBadgeText({ text: state === "connected" ? "" : "!" });
      chrome.action.setBadgeBackgroundColor({ color: dot });
    } catch (e2) { /* */ }
  }
  try {
    chrome.action.setTitle({ title: STATE_TITLES[state] ?? STATE_TITLES.off });
  } catch (e) { /* */ }
  setUiState(state, STATE_TITLES[state] ?? "");
}

// Web 存储搬运:很多站的登录态(token/uid)只落在 localStorage/sessionStorage,光有 cookie
// 打开仍是未登录。扩展能读到它的唯一途径是页内注入(chrome.scripting),所以采集范围就是日常
// 浏览器**当前打开着的** http/https 标签页;没打开的源采不到(调用方按"采到多少算多少"处理)。
// 上限只为防一个巨型站点把 WS 消息撑爆;触发即置 truncated,由调用方如实转述,不静默丢弃。
const STORAGE_ORIGIN_MAX_BYTES = 1024 * 1024;
const STORAGE_TOTAL_MAX_BYTES = 4 * 1024 * 1024;
// 采集预算:每个被采集的标签页必须在这段时间内回话,不回话就当它卡住(崩掉的、被冻结的、
// 挂着对话框的页都长这样)。卡住的标签页进 stuckTabs 并冷却一段时间,冷却期内本轮与后续轮都不再碰它
// (标签页关掉即移出);注入按波并发(见 WAVE_SIZE),所以一个卡住的页只占住自己那一格预算,不会排队挡住后面的页。
// 这些值只决定"存储这半最多拖多久" —— cookie 在采集之前就已经单独回给 daemon 了,不在这条路上等。
const STORAGE_TAB_TIMEOUT_MS = 800;
const STORAGE_TOTAL_BUDGET_MS = 3000;
const STORAGE_WAVE_SIZE = 8;
// 冷却而不是永久拉黑:实测 service worker 会靠着 WS 常连活很久,永久拉黑等于让那些源在整个 SW
// 生命里一直采不到 —— 而它们可能只是当时忙(会话冷启动那几秒机器很重),或者已被点开过(点开会解冻页面)。
// 冷却到期后重试的代价有上界:一轮最多花掉一个整轮预算。
const STORAGE_STUCK_COOLDOWN_MS = 10 * 60 * 1000;
const stuckTabs = new Map(); // tabId → 可再次尝试的时刻

/** 回归钩子:单测(假 chrome + vm)把上面的预算压到毫秒级;浏览器里没有这几个键,取默认值。 */
function budgetOverride(key, fallback) {
  const v = globalThis[key];
  return typeof v === "number" && v > 0 ? v : fallback;
}

/** 给一次注入加预算:到点以 __storageTimeout 标记的错拒绝;原 promise 迟到的失败由自己接下,不冒泡。 */
function withTimeout(promise, ms) {
  promise.catch(() => {});
  let timer;
  return Promise.race([
    promise,
    new Promise((_, reject) => {
      timer = setTimeout(() => {
        reject(Object.assign(new Error(`该标签页 ${ms}ms 内没回话`), { __storageTimeout: true }));
      }, ms);
    }),
  ]).finally(() => clearTimeout(timer));
}

/** 页内函数(经 chrome.scripting 注入执行):原样导出两个 storage 的键值。 */
function readWebStorage() {
  const dump = (store) => {
    const out = {};
    try {
      for (let i = 0; i < store.length; i++) {
        const k = store.key(i);
        if (k === null || k === undefined) continue;
        const v = store.getItem(k);
        if (typeof v === "string") out[k] = v;
      }
    } catch (e) { /* 该源禁止访问 */ }
    return out;
  };
  return {
    origin: location.origin,
    local: dump(window.localStorage),
    session: dump(window.sessionStorage),
  };
}

/** 采一份 Web 存储快照:遍历打开的标签页 → 逐页注入读取 → 按 origin 合并 + 上限裁剪。 */
async function harvestWebStorage() {
  const tabTimeoutMs = budgetOverride("__BU_STORAGE_TAB_TIMEOUT_MS", STORAGE_TAB_TIMEOUT_MS);
  const budgetMs = budgetOverride("__BU_STORAGE_TOTAL_BUDGET_MS", STORAGE_TOTAL_BUDGET_MS);
  const waveSize = Math.max(1, Math.floor(budgetOverride("__BU_STORAGE_WAVE_SIZE", STORAGE_WAVE_SIZE)));
  const cooldownMs = budgetOverride("__BU_STORAGE_STUCK_COOLDOWN_MS", STORAGE_STUCK_COOLDOWN_MS);
  const startedAt = Date.now();
  const stats = { tabs: 0, read: 0, origins: 0, bytes: 0, truncated: false,
    timed_out: 0, skipped_stuck: 0, budget_exhausted: false, errors: [] };
  const byOrigin = new Map();
  let tabs = [];
  try {
    tabs = await chrome.tabs.query({});
  } catch (e) {
    stats.errors.push(String(e));
    return { origins: [], stats };
  }
  const present = new Set();
  const candidates = [];
  for (const tab of tabs) {
    // tab.url 只在扩展有该页 host 权限时才有值(manifest 已 <all_urls>);非 http(s) 与本桥无关
    if (!tab || typeof tab.id !== "number") continue;
    if (tab.discarded) continue; // 已丢弃的标签页没有渲染进程:注入会把它唤醒重载,是额外副作用
    if (!/^https?:\/\//i.test(String(tab.url ?? ""))) continue;
    present.add(tab.id);
    const retryAt = stuckTabs.get(tab.id);
    if (retryAt && retryAt > Date.now()) { stats.skipped_stuck += 1; continue; } // 冷却期内不再试它
    candidates.push(tab);
  }
  // 分波并发注入:一轮等待 = 最慢的那一格,而不是所有页之和。串行时(0.2.1 首版)四个不回话的页
  // 就能把整轮预算吃光,后面的健康页永远轮不到 —— 现场实测:每轮只走到 5 个页、攒下的卡住页从
  // 4 涨到 12,存储那半一直残缺。
  for (let i = 0; i < candidates.length; i += waveSize) {
    if (Date.now() - startedAt >= budgetMs) { stats.budget_exhausted = true; break; }
    const wave = candidates.slice(i, i + waveSize);
    const settled = await Promise.all(wave.map(async (tab) => {
      stats.tabs += 1;
      try {
        return await withTimeout(
          chrome.scripting.executeScript({ target: { tabId: tab.id }, func: readWebStorage }), tabTimeoutMs);
      } catch (e) {
        if (e && e.__storageTimeout) {
          stats.timed_out += 1;
          stuckTabs.set(tab.id, Date.now() + cooldownMs);
        } else {
          stats.errors.push(String(e)); // 页面已丢弃/受保护/权限自定站点:跳过该页,不中断整轮
        }
        return [];
      }
    }));
    for (const results of settled) {
      for (const r of results ?? []) {
        const rec = r && r.result;
        if (!rec || typeof rec.origin !== "string" || !rec.origin || rec.origin === "null") continue;
        stats.read += 1;
        const acc = byOrigin.get(rec.origin) ?? { origin: rec.origin, local: {}, session: {} };
        // 同源多标签共享同一份 localStorage,值本就相同;sessionStorage 逐标签不同,约定先到者留
        for (const [store, bucket] of [["local", rec.local], ["session", rec.session]]) {
          for (const k of Object.keys(bucket ?? {})) {
            if (!(k in acc[store])) acc[store][k] = bucket[k];
          }
        }
        byOrigin.set(rec.origin, acc);
      }
    }
  }
  // 已经不在了的标签页从记忆里去掉:免得它下次再出现时被一份过期的判断误伤
  for (const id of [...stuckTabs.keys()]) if (!present.has(id)) stuckTabs.delete(id);
  const origins = [];
  let used = 0;
  for (const acc of byOrigin.values()) {
    const capped = capBytes(acc, STORAGE_ORIGIN_MAX_BYTES);
    if (capped.truncated) stats.truncated = true;
    const size = JSON.stringify(capped.rec).length;
    if (used + size > STORAGE_TOTAL_MAX_BYTES) {
      stats.truncated = true;
      continue; // 总量超限:该源整体跳过(记在 truncated 上,不作静默丢失)
    }
    used += size;
    origins.push(capped.rec);
  }
  stats.origins = origins.length;
  stats.bytes = used;
  return { origins, stats };
}

/** 按插入顺序保留键值直到触顶(超出的键丢弃并标记),避免巨型站点撑爆一次 WS 往返。 */
function capBytes(rec, maxBytes) {
  let budget = maxBytes;
  const out = { origin: rec.origin, local: {}, session: {} };
  let truncated = false;
  for (const store of ["local", "session"]) {
    for (const [k, v] of Object.entries(rec[store] ?? {})) {
      const cost = k.length + v.length + 8;
      if (cost > budget) { truncated = true; continue; }
      budget -= cost;
      out[store][k] = v;
    }
  }
  return { rec: out, truncated };
}

/** 发一条消息:采集要遍历标签页、可能花掉几秒,期间连接可能已经断了 —— 迟到的那条丢掉,不把整段处理带崩。 */
function send(payload) {
  try {
    if (ws && ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify(payload));
  } catch (e) { /* */ }
}

async function connect() {
  if (ws && (ws.readyState === WebSocket.OPEN || ws.readyState === WebSocket.CONNECTING)) return;
  // 无感配对(DEC-012):回环即信任,daemon 在线即自动连接,零交互
  try {
    ws = new WebSocket(DAEMON_WS + "?proto=1");
  } catch (e) {
    drawIcon("off");
    scheduleReconnect();
    return;
  }
  ws.onopen = () => {
    backoffMs = 1000;
    drawIcon("connected");
    // storageProto=2:存储走单独一条 storage 消息,不再与 cookie 同一条回复(协商 1 = 旧扩展的捎带形态)
    try {
      ws.send(JSON.stringify({ type: "hello", proto: 1, extVersion: chrome.runtime.getManifest().version,
        storageProto: 2 }));
    } catch (e) { /* */ }
  };
  ws.onmessage = async (ev) => {
    let m;
    try { m = JSON.parse(ev.data); } catch { return; }
    if (m.type === "getCookies") {
      try {
        const data = await chrome.cookies.getAll({});
        // cookie 先单独送:它 100ms 内就能拿到,而采存储要遍历标签页、可能耗上几秒,还可能卡在
        // 某个不回话的页上。两条分开送,存储出任何问题都不会再牵连 cookie(2026-10-08 现场:
        // 同一条回复时,一个卡住的标签页让整次注入超时,start 报 login=empty)。
        send({ type: "cookies", reqId: m.reqId, data });
        if (!m.wantStorage) return;
        let s;
        try {
          s = await harvestWebStorage();
        } catch (e) {
          s = { origins: [], stats: { tabs: 0, read: 0, origins: 0, bytes: 0, truncated: false,
            timed_out: 0, skipped_stuck: 0, budget_exhausted: false, errors: [String(e)] } };
        }
        send({ type: "storage", reqId: m.reqId, storage: s.origins, storageStats: s.stats });
      } catch (e) {
        send({ type: "error", reqId: m.reqId, message: String(e) });
      }
    } else if (m.type === "ping") {
      ws.send(JSON.stringify({ type: "pong" }));
    } else if (m.type === "hello") {
      drawIcon("connected");
    }
  };
  ws.onclose = (ev) => {
    ws = null;
    if (ev.code === 4002) {
      drawIcon("off");
      setUiState("error", "协议版本不匹配:请更新扩展或 daemon");
      return;
    }
    drawIcon("link"); // daemon 大概率在线(否则下一轮探测定 off)
    scheduleReconnect();
  };
  ws.onerror = () => {};
}

function scheduleReconnect() {
  setTimeout(connect, backoffMs);
  backoffMs = Math.min(backoffMs * 2, 30000);
}

/** 状态校准:ws 断开时区分"daemon 离线(off)"与"daemon 在线未连(link)" */
async function probeDaemon() {
  if (ws && ws.readyState === WebSocket.OPEN) return;
  try {
    const r = await fetch(DAEMON_HTTP + "/health", { cache: "no-store" });
    if (r.ok) drawIcon("link");
    else drawIcon("off");
  } catch (e) {
    drawIcon("off");
  }
  connect();
}

chrome.runtime.onMessage.addListener((msg, _s, sendResponse) => {
  if (msg?.type === "reconnect") {
    if (ws) { try { ws.close(); } catch (e) { /* */ } ws = null; }
    probeDaemon();
    sendResponse({ ok: true });
  }
  if (msg?.type === "getStatus") {
    sendResponse({ connected: !!(ws && ws.readyState === WebSocket.OPEN) });
  }
});

try {
  chrome.alarms.onAlarm.addListener(() => probeDaemon());
  chrome.alarms.create("reconnect", { periodInMinutes: 1 });
} catch (e) { /* */ }

try {
  drawIcon("off");
  connect();
} catch (e) {
  try { drawIcon("off"); } catch (e2) { /* */ }
}
try {
  setInterval(probeDaemon, 5000);
} catch (e) { /* */ }
