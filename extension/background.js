// Browser-Use Bridge 桥扩展 service worker
// 职责单一:连 daemon(17990, 无感配对 DEC-012)→ 响应 getCookies(chrome.cookies.getAll 全量含 httpOnly)
// 自愈:WS onclose 指数退避重连 + chrome.alarms 30s 兜底(协议 v1,api-contract §3)
// 图标角标:三态徽章(绿 ON 已连 / 黄 LINK daemon在线未连 / 红 OFF daemon离线),不点开即可见
const DAEMON_WS = "ws://127.0.0.1:17990";
const DAEMON_HTTP = "http://127.0.0.1:17981";
let ws = null;
let backoffMs = 1000;

const BADGE = {
  connected: { text: "ON", color: "#2fbf71", title: "Browser-Use Bridge: 已连接 daemon · cookie 通道就绪" },
  link: { text: "LINK", color: "#e0a52e", title: "Browser-Use Bridge: daemon 在线,等待连接(自动重连中)" },
  off: { text: "OFF", color: "#ef5a5f", title: "Browser-Use Bridge: daemon 离线 — 运行 browser-use start 拉起" },
};

function setBadge(state) {
  const b = BADGE[state] ?? BADGE.off;
  chrome.action.setBadgeText({ text: b.text });
  chrome.action.setBadgeBackgroundColor({ color: b.color });
  chrome.action.setTitle({ title: b.title });
  setUiState(state, b.title);
}

function setUiState(state, detail) {
  chrome.storage.local.set({ uiState: state, uiDetail: detail ?? "" });
}

async function connect() {
  if (ws && (ws.readyState === WebSocket.OPEN || ws.readyState === WebSocket.CONNECTING)) return;
  // 无感配对(DEC-012):回环即信任,daemon 在线即自动连接,零交互
  try {
    ws = new WebSocket(`${DAEMON_WS}?proto=1`);
  } catch (e) {
    setBadge("off");
    scheduleReconnect();
    return;
  }
  ws.onopen = () => {
    backoffMs = 1000;
    setBadge("connected");
    ws.send(JSON.stringify({ type: "hello", proto: 1, extVersion: chrome.runtime.getManifest().version }));
  };
  ws.onmessage = async (ev) => {
    let m;
    try { m = JSON.parse(ev.data); } catch { return; }
    if (m.type === "getCookies") {
      try {
        const data = await chrome.cookies.getAll({});
        ws.send(JSON.stringify({ type: "cookies", reqId: m.reqId, data }));
      } catch (e) {
        ws.send(JSON.stringify({ type: "error", reqId: m.reqId, message: String(e) }));
      }
    } else if (m.type === "ping") {
      ws.send(JSON.stringify({ type: "pong" }));
    } else if (m.type === "hello") {
      setBadge("connected");
    }
  };
  ws.onclose = (ev) => {
    ws = null;
    if (ev.code === 4002) {
      setBadge("off");
      setUiState("error", "协议版本不匹配:请更新扩展或 daemon");
      return;
    }
    setBadge("link"); // daemon 大概率在线(否则下一轮探测定 OFF)
    scheduleReconnect();
  };
  ws.onerror = () => {};
}

function scheduleReconnect() {
  setTimeout(connect, backoffMs);
  backoffMs = Math.min(backoffMs * 2, 30000);
}

/** 状态校准:ws 断开时区分"daemon 离线(OFF)"与"daemon 在线未连(LINK)" */
async function probeDaemon() {
  if (ws && ws.readyState === WebSocket.OPEN) return; // 已连接,角标正确
  try {
    const r = await fetch(`${DAEMON_HTTP}/health`, { cache: "no-store" });
    if (r.ok) setBadge("link");
    else setBadge("off");
  } catch {
    setBadge("off");
  }
  connect(); // 顺带触发重连
}

chrome.alarms.create("reconnect", { periodInMinutes: 0.5 });
chrome.alarms.onAlarm.addListener(() => probeDaemon());
chrome.runtime.onMessage.addListener((msg, _s, sendResponse) => {
  if (msg?.type === "reconnect") {
    if (ws) { try { ws.close(); } catch { /* */ } ws = null; }
    probeDaemon();
    sendResponse({ ok: true });
  }
  if (msg?.type === "getStatus") {
    sendResponse({ connected: !!(ws && ws.readyState === WebSocket.OPEN) });
  }
});

setBadge("off");
connect();
setInterval(probeDaemon, 5000);
