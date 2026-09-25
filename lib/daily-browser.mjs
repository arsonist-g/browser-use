// 日常浏览器自启(DEC-040):桥扩展活在用户的日常浏览器里,日常浏览器没开 → 桥离线 → 登录态注入为空。
// 这里把「日常浏览器在不在 → 要不要拉起 → 桥有没有连上」收成一个动作:
// session.start 自动跑(config.daily_browser_autostart 可关),AI 也可单独跑 browser-use daily-browser。
import { spawn } from "node:child_process";
import path from "node:path";
import { BU_HOME } from "./paths.mjs";

// 等桥预算:刚拉起要给冷启动留时间(Edge 有启动加速常驻进程时约 1s,完全冷启数秒);
// 已经在跑却还没连上时只留一个轮询周期(扩展每 5s 探一次 daemon),不为一次探测白等。
export const WAIT_AFTER_LAUNCH_MS = 15000;
export const WAIT_WHEN_RUNNING_MS = 6000;
const POLL_MS = 250;

/**
 * 进程快照 → 日常浏览器的主进程数与其中有可见窗口的数量(纯函数)。
 * 两条排除:Chromium 子进程一律带 --type=(渲染/GPU/工具进程,不代表浏览器);本工具自己起的
 * 会话实例带 --user-data-dir=<BU_HOME>(不能把自己的浏览器当成用户的日常浏览器)。
 * **「有窗口」只看 MainWindowHandle,不看命令行的 --no-startup-window**:Edge 的启动加速主进程
 * 被提升成有窗口的浏览器后,命令行里那面旗标原样保留(本机实测:窗口标题为"新标签页 - 个人 -
 * Microsoft Edge"的主进程,命令行仍带 --no-startup-window)。拿旗标当"没打开"的判据会把"开着"
 * 判成"没开",于是每次会话都去多开一个窗口 —— 这正是 DEC-040 追记里修正的缺陷。
 */
export function summarizeProcesses(procs, { profileRoot = BU_HOME } = {}) {
  let processes = 0;
  let windows = 0;
  for (const p of procs ?? []) {
    const cl = String(p?.commandLine ?? "");
    if (!cl) continue;
    if (cl.includes("--type=")) continue;
    if (profileRoot && cl.includes(profileRoot)) continue;
    processes += 1;
    if (Number(p?.mainWindowHandle ?? 0) > 0) windows += 1;
  }
  return { processes, windows };
}

/** PowerShell `ConvertTo-Json -Compress` 的输出 → [{pid, commandLine, mainWindowHandle}];空与坏 JSON 归为空表。 */
export function parseProcessJson(stdout) {
  const text = String(stdout ?? "").trim();
  if (!text) return [];
  let parsed;
  try { parsed = JSON.parse(text); } catch { return []; }
  const rows = Array.isArray(parsed) ? parsed : [parsed];
  return rows
    .filter((r) => r && typeof r === "object")
    .map((r) => ({
      pid: r.ProcessId ?? null,
      commandLine: r.CommandLine ?? "",
      mainWindowHandle: Number(r.MainWindowHandle ?? 0) || 0,
    }));
}

/**
 * 取浏览器主进程快照(带顶层窗口句柄)。非 Windows 平台直接给空表(本工具的运行环境是 Windows);
 * powershell 不可用或超时同样给空表——探测失败不能把会话启动拖垮,只能当"读不到"处理。
 */
export function probeBrowserProcesses(exeName, { timeoutMs = 15000 } = {}) {
  return new Promise((resolve) => {
    if (process.platform !== "win32" || !exeName) return resolve([]);
    const ps = `Get-CimInstance Win32_Process -Filter "Name='${exeName}'" | ` +
      "Where-Object { $_.CommandLine -notlike '*--type=*' } | " +
      "ForEach-Object { $h = 0; try { $h = [int64](Get-Process -Id $_.ProcessId -ErrorAction Stop).MainWindowHandle } catch { } " +
      "[pscustomobject]@{ ProcessId = $_.ProcessId; CommandLine = $_.CommandLine; MainWindowHandle = $h } } | " +
      "ConvertTo-Json -Compress";
    let out = "";
    let settled = false;
    const done = (rows) => { if (!settled) { settled = true; resolve(rows); } };
    let child;
    try {
      child = spawn("powershell", ["-NoProfile", "-NonInteractive", "-Command", ps],
        { stdio: ["ignore", "pipe", "ignore"], windowsHide: true });
    } catch { return done([]); }
    const timer = setTimeout(() => { try { child.kill(); } catch { /* */ } done([]); }, timeoutMs);
    child.stdout.on("data", (d) => { out += d; });
    child.on("error", () => { clearTimeout(timer); done([]); });
    child.on("close", () => { clearTimeout(timer); done(parseProcessJson(out)); });
  });
}

/**
 * 纯决策:桥已连就什么都不做;日常浏览器有可见窗口就只等(它确实开着,再拉起只会多开一个窗口);
 * 没窗口(全关或只剩启动加速的后台进程)就把它打开——开窗口同时唤醒扩展,再等桥连上;
 * 不允许拉起(launch=false = 只看状态)就只提示,连等都不等。
 */
export function planDailyEnsure({ bridgeConnected, processes, windows, launch }) {
  if (bridgeConnected) return { action: "none", waitMs: 0 };
  if (windows > 0) return { action: "wait", waitMs: WAIT_WHEN_RUNNING_MS };
  if (!launch) return { action: "hint", waitMs: 0 };
  return { action: "launch", waitMs: WAIT_AFTER_LAUNCH_MS };
}

/**
 * 拉起用户的日常浏览器:不带任何参数 = 用户自己的默认 profile(桥扩展与登录态都在那儿)。
 * detached + unref:那是用户的程序,不随 daemon 生死;stdio ignore 避免句柄串到 daemon。
 */
export function launchDailyBrowser(exe, { log = () => {} } = {}) {
  try {
    const child = spawn(exe, [], { detached: true, stdio: "ignore" });
    // 没有 error 监听时 spawn 失败会以未捕获事件打崩 daemon
    child.on("error", (e) => log("daily-browser", `launch failed: ${e.message}`));
    child.unref();
    log("daily-browser", `launched ${exe} pid=${child.pid ?? "?"}`);
    return child.pid ?? null;
  } catch (e) {
    log("daily-browser", `launch failed: ${e.message}`);
    return null;
  }
}

/** 等桥连上,返回实际等待毫秒数(到点未连也照常返回)。 */
export async function waitForBridge(bridge, budgetMs, { pollMs = POLL_MS } = {}) {
  const start = Date.now();
  while (Date.now() - start < budgetMs) {
    if (bridge?.connected) break;
    await new Promise((r) => setTimeout(r, pollMs));
  }
  return Date.now() - start;
}

/** 拿到事实之后给下一步动作:连上了就没有提示;没连上则分清"没拉起 / 拉起失败 / 已开但桥离线"。 */
export function ensureHint({ action, launched, launchFailed, connected, windows }) {
  if (connected) return null;
  if (launchFailed) {
    return "拉起日常浏览器失败(浏览器进程没能起来):检查 config browser_exe 是否指向存在的浏览器,"
      + "或手动打开日常浏览器后重试。";
  }
  if (launched) {
    return "已拉起日常浏览器但桥仍未连接:确认 Browser-Use Bridge 扩展已加载并启用"
      + "(browser-use extension 打印目录);稍后可用 browser-use daily-browser 重试。";
  }
  if (windows > 0) {
    return "日常浏览器已经开着(有可见窗口)但桥未连接:这不是浏览器实例的问题,是扩展的问题——"
      + "确认 Browser-Use Bridge 扩展已加载并启用(browser-use extension 打印目录)。";
  }
  return "日常浏览器未打开,且本次未自动拉起(launch=false 或 config daily_browser_autostart=false);"
    + "要取得登录态请先打开日常浏览器,或让本工具用 browser-use daily-browser 拉起。";
}

/**
 * 保证"日常浏览器开着 + 桥连着"。返回的是事实,不是承诺:
 * { bridge_connected, action: none|launch|wait|hint, launched, waited_ms,
 *   browser_processes, browser_windows, hint }。
 * probeProcesses / launchBrowser / waitBridge 可注入,便于回归不碰真实进程。
 */
export async function ensureDailyBrowser({
  bridge, exe, profileRoot = BU_HOME, log = () => {}, launch = true, waitMs,
  probeProcesses = probeBrowserProcesses, launchBrowser = launchDailyBrowser, waitBridge = waitForBridge,
} = {}) {
  if (bridge?.connected) {
    log("daily-browser", "bridge already connected; nothing to do");
    return { bridge_connected: true, action: "none", launched: false, waited_ms: 0,
      browser_processes: null, browser_windows: null, hint: null };
  }
  const procs = await probeProcesses(path.win32.basename(String(exe ?? "")));
  const { processes, windows } = summarizeProcesses(procs, { profileRoot });
  const plan = planDailyEnsure({ bridgeConnected: false, processes, windows, launch });
  let launched = false;
  if (plan.action === "launch") {
    launched = launchBrowser(exe, { log }) !== null;
  }
  const launchFailed = plan.action === "launch" && !launched;
  const budget = waitMs ?? plan.waitMs;
  const waited = budget > 0 && plan.action !== "hint" ? await waitBridge(bridge, budget) : 0;
  const connected = !!bridge?.connected;
  const result = {
    bridge_connected: connected,
    action: plan.action,
    launched,
    waited_ms: waited,
    browser_processes: processes,
    browser_windows: windows,
    hint: ensureHint({ action: plan.action, launched, launchFailed, connected, windows }),
  };
  log("daily-browser",
    `action=${result.action} launched=${launched} launch_failed=${launchFailed} ` +
    `browser_processes=${processes} browser_windows=${windows} ` +
    `bridge_connected=${connected} waited_ms=${waited}`);
  return result;
}
