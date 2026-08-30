// popup 逻辑(无感配对版):只展示状态;daemon 在线时扩展自动连接
const dot = document.getElementById("dot");
const st = document.getElementById("statusText");
const msg = document.getElementById("msg");
document.getElementById("extV").textContent = chrome.runtime.getManifest().version;

function setLight(cls, text, msgText) {
  dot.className = "dot " + cls;
  st.textContent = text;
  if (msgText !== undefined) msg.textContent = msgText;
}

async function refresh() {
  // daemon 侧状态是真信号(扩展 WS 是否被 daemon 接受)
  try {
    const r = await fetch("http://127.0.0.1:17981/status", { cache: "no-store" });
    const s = await r.json();
    document.getElementById("daemonV").textContent = s.version;
    if (s.bridge?.connected) { setLight("ok", "已连接 daemon · cookie 通道就绪"); return; }
  } catch { /* daemon 不在线 */ }
  const { uiState = "", uiDetail = "" } = await chrome.storage.local.get(["uiState", "uiDetail"]);
  if (uiState === "connected") setLight("warn", "扩展已连 daemon(守护进程状态未知)");
  else if (uiState === "error") setLight("err", uiDetail || "连接被拒");
  else setLight("err", "未连接 · 自动重连中", "运行 browser-use start 拉起 daemon 后自动连接");
}

document.getElementById("reconnect").addEventListener("click", () => {
  chrome.runtime.sendMessage({ type: "reconnect" }, () => setTimeout(refresh, 1200));
});

refresh();
setInterval(refresh, 5000);
