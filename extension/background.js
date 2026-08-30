// Browser-Use Bridge 桥扩展 service worker
// 职责单一:连 daemon(17990, 无感配对 DEC-012)→ 响应 getCookies(chrome.cookies.getAll 全量含 httpOnly)
// 自愈:WS onclose 指数退避重连 + chrome.alarms 兜底(协议 v1,api-contract §3)
// 图标即状态:深色底 + 品牌字 + 右下状态圆点(绿=已连/黄=等待/红=离线),绘制全防御
const DAEMON_WS = "ws://127.0.0.1:17990";
const DAEMON_HTTP = "http://127.0.0.1:17981";
const STATE_COLORS = { connected: "#2fbf71", link: "#e0a52e", off: "#ef5a5f" };
const STATE_TITLES = {
  connected: "Browser-Use Bridge: 已连接 daemon · cookie 通道就绪",
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
    try { ws.send(JSON.stringify({ type: "hello", proto: 1, extVersion: chrome.runtime.getManifest().version })); } catch (e) { /* */ }
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
