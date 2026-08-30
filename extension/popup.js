// popup 逻辑:轮询 daemon /status(daemon 在线时)+ storage.uiState(扩展内状态)
const dot = document.getElementById("dot");
const st = document.getElementById("statusText");
const msg = document.getElementById("msg");
document.getElementById("extV").textContent = chrome.runtime.getManifest().version;

function setLight(cls, text, msgText, msgCls) {
  dot.className = "dot " + cls;
  st.textContent = text;
  if (msgText !== undefined) {
    msg.className = "msg " + (msgCls ?? "");
    msg.textContent = msgText;
  }
}

async function refresh() {
  // 1) daemon 侧(可观测桥连接 = 真信号)
  try {
    const r = await fetch("http://127.0.0.1:17981/status", { cache: "no-store" });
    const s = await r.json();
    document.getElementById("daemonV").textContent = s.version;
    if (s.bridge?.connected) { setLight("ok", "已连接 daemon · cookie 通道就绪"); return; }
  } catch { /* daemon 不在线 */ }
  // 2) 扩展内状态(background 写)
  const { uiState = "", uiDetail = "" } = await chrome.storage.local.get(["uiState", "uiDetail"]);
  if (uiState === "connected") setLight("warn", "扩展已连 daemon(守护进程状态未知)");
  else if (uiState === "error") setLight("err", uiDetail || "连接被拒", "请从 browser-use extension 重新复制 token", "err");
  else setLight("err", "未连接 · 自动重连中", "请确认已运行 browser-use start(拉起 daemon)", "err");
}

document.getElementById("save").addEventListener("click", () => {
  const token = document.getElementById("token").value.trim();
  if (!token) { setLight("warn", "请粘贴 token", "token 为空", "err"); return; }
  chrome.runtime.sendMessage({ type: "saveToken", token }, () => {
    setLight("warn", "已保存 token,重连中…");
    setTimeout(refresh, 1500);
  });
});
document.getElementById("reconnect").addEventListener("click", () => {
  chrome.runtime.sendMessage({ type: "reconnect" }, () => setTimeout(refresh, 1200));
});

refresh();
setInterval(refresh, 5000);
