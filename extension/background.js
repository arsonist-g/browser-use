// Browser-Use Bridge 桥扩展 service worker
// 职责单一:连 daemon(17990, token 配对)→ 响应 getCookies(chrome.cookies.getAll 全量含 httpOnly)
// 自愈:WS onclose 指数退避重连 + chrome.alarms 30s 兜底(协议 v1,api-contract §3)
const DAEMON_WS = "ws://127.0.0.1:17990";
let ws = null;
let backoffMs = 1000;

async function getToken() {
  const { bridgeToken } = await chrome.storage.local.get("bridgeToken");
  return bridgeToken ?? "";
}

function setUiState(state, detail) {
  chrome.storage.local.set({ uiState: state, uiDetail: detail ?? "" });
}

async function connect() {
  if (ws && (ws.readyState === WebSocket.OPEN || ws.readyState === WebSocket.CONNECTING)) return;
  const token = await getToken();
  if (!token) { setUiState("error", "未配对:先运行 browser-use extension 获取 token"); return; }
  try {
    ws = new WebSocket(`${DAEMON_WS}?token=${encodeURIComponent(token)}&proto=1`);
  } catch (e) {
    setUiState("disconnected", String(e));
    scheduleReconnect();
    return;
  }
  ws.onopen = () => {
    backoffMs = 1000;
    setUiState("connected", "已连接 daemon");
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
      setUiState("connected", `daemon ${m.daemonVersion ?? ""}`);
    }
  };
  ws.onclose = (ev) => {
    ws = null;
    if (ev.code === 4001) { setUiState("error", "token 不匹配:重新复制 browser-use extension 的 token"); return; }
    setUiState("disconnected", "daemon 不可达,自动重连中");
    scheduleReconnect();
  };
  ws.onerror = () => {};
}

function scheduleReconnect() {
  setTimeout(connect, backoffMs);
  backoffMs = Math.min(backoffMs * 2, 30000);
}

chrome.alarms.create("reconnect", { periodInMinutes: 0.5 });
chrome.alarms.onAlarm.addListener(() => { if (!ws || ws.readyState !== WebSocket.OPEN) connect(); });
chrome.runtime.onMessage.addListener((msg, _s, sendResponse) => {
  if (msg?.type === "saveToken") {
    chrome.storage.local.set({ bridgeToken: msg.token }, () => {
      if (ws) { try { ws.close(); } catch { /* */ } ws = null; }
      connect();
      sendResponse({ ok: true });
    });
    return true;
  }
  if (msg?.type === "reconnect") {
    if (ws) { try { ws.close(); } catch { /* */ } ws = null; }
    connect();
    sendResponse({ ok: true });
  }
  if (msg?.type === "getStatus") {
    sendResponse({ connected: !!(ws && ws.readyState === WebSocket.OPEN) });
  }
});

connect();
