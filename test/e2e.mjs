#!/usr/bin/env node
// Browser-Use e2e 回归测试:驱动真实 CLI,对本地 fixture 页验证 P0 工具面全能力。
// 用法: node test/e2e.mjs [--headed](默认 headless)
// 前置: 桥扩展已装且日常浏览器打开(login 断言在桥离线时自动 SKIP)
// 退出码: 0 = 全过;1 = 有 fail(fail 明细列在汇总)
import { spawn, execFileSync, spawnSync } from "node:child_process";
import { once } from "node:events";
import path from "node:path";
import os from "node:os";
import url from "node:url";
import fs from "node:fs";
import { WebSocket } from "ws";

const ROOT = path.dirname(path.dirname(url.fileURLToPath(import.meta.url)));
const CLI = path.join(ROOT, "bin", "browser-use.mjs");
const FIXTURE_PORT = 18123;
const BASE = `http://127.0.0.1:${FIXTURE_PORT}`;
const HEADED = process.argv.includes("--headed");
// 无头启动已从 CLI 移除(反检测红线):测试进程经本环境变量显式放行,无头只作补充形态
if (!HEADED) process.env.BU_DEV_ALLOW_HEADLESS = "1";
// 日常浏览器自启在测试里必须关掉:否则 session.start 会去拉起用户真实的日常 Edge
// (真实副作用,且与断言无关);回归该能力用 test/unit/daily-browser.test.mjs。
process.env.BU_DEV_NO_DAILY_AUTOSTART = "1";

let pass = 0, fail = 0, skipped = 0;
const fails = [];
function ok(name, cond, detail = "") {
  if (cond) { pass++; console.log(`  ✔ ${name}`); }
  else { fail++; fails.push(name); console.log(`  ✘ ${name}${detail ? ` — ${detail}` : ""}`); }
}
function skip(name, reason) { skipped++; console.log(`  ○ SKIP ${name} — ${reason}`); }

function bu(args, timeoutMs = 60000) {
  return execFileSync(process.execPath, [CLI, ...args], {
    encoding: "utf8", timeout: timeoutMs, env: { ...process.env },
  });
}

// 失败路径要用退出码与错误码本身做断言:execFileSync 遇非 0 退出即抛,这里自己收
function buTry(args, timeoutMs = 60000) {
  const r = spawnSync(process.execPath, [CLI, ...args], {
    encoding: "utf8", timeout: timeoutMs, env: { ...process.env },
  });
  return { status: r.status, stdout: r.stdout ?? "", stderr: r.stderr ?? "" };
}

// 错误码断言取 JSON(stdout)优先,JSON 缺失时退回 stderr 的 error[CODE] 行
function errorCodeOf(r) {
  try { return JSON.parse(r.stdout).error?.code ?? null; } catch { /* 非 JSON */ }
  const m = /error\[([A-Z_]+)\]/.exec(r.stderr);
  return m ? m[1] : null;
}

function parseSnapUid(text, labelIncludes) {
  for (const line of text.split("\n")) {
    if (line.includes(labelIncludes)) {
      const m = line.match(/uid=(\d+_\d+)/);
      if (m) return m[1];
    }
  }
  return null;
}

function snapshotDocUrl(text) {
  const m = text.match(/^doc url="([^"]+)"/m);
  return m ? m[1] : null;
}

function readPages(session) {
  return JSON.parse(bu(["list_pages", "--session", session, "--output-format=json"])).pages;
}

function pageIdForUrl(session, expectedUrl) {
  const page = readPages(session).find((p) => p.url === expectedUrl);
  return page?.page_id ?? null;
}

function sessionPort(session) {
  const home = process.env.BROWSER_USE_HOME ?? path.join(os.homedir(), ".browser-use");
  const doc = JSON.parse(fs.readFileSync(path.join(home, "sessions", session, "session.json"), "utf8"));
  return doc.port;
}

async function pageTargets(port) {
  return (await (await fetch(`http://127.0.0.1:${port}/json/list`)).json())
    .filter((t) => t.type === "page" && t.url.startsWith("http"));
}

async function waitForActivePage(port, expectedUrl, timeoutMs = 5000) {
  const deadline = Date.now() + timeoutMs;
  do {
    const [active] = await pageTargets(port);
    if (active?.url === expectedUrl) return true;
    await new Promise((r) => setTimeout(r, 100));
  } while (Date.now() < deadline);
  return false;
}

async function waitForActivePagePrefix(port, expectedPrefix, timeoutMs = 5000) {
  const deadline = Date.now() + timeoutMs;
  do {
    const [active] = await pageTargets(port);
    if (active?.url?.startsWith(expectedPrefix)) return active.url;
    await new Promise((r) => setTimeout(r, 100));
  } while (Date.now() < deadline);
  return null;
}

async function waitForPageTarget(port, expectedUrl, timeoutMs = 5000) {
  const deadline = Date.now() + timeoutMs;
  do {
    const target = (await pageTargets(port)).find((t) => t.url === expectedUrl);
    if (target) return target;
    await new Promise((r) => setTimeout(r, 100));
  } while (Date.now() < deadline);
  return null;
}

function hasPageChangeNotice(text, pageId, url) {
  const idPattern = new RegExp(`page_id\\s*[=:]\\s*["']?${pageId}["']?`, "i");
  return idPattern.test(text) && text.includes(url)
    && /(unexpected|changed|switch|opened|navigat|background|foreground|active)/i.test(text);
}

function hasUnexpectedNotice(text) {
  return /unexpected\s+(?:page\s+)?change/i.test(text);
}

/** 非工具入口的后台页:模拟真实后台 popup,不经过显式 new_page。 */
async function createBackgroundTarget(port, expectedUrl, keepActiveUrl) {
  const version = await (await fetch(`http://127.0.0.1:${port}/json/version`)).json();
  await cdpCall(version.webSocketDebuggerUrl, "Target.createTarget", { url: expectedUrl, background: true });
  if (!(await waitForPageTarget(port, expectedUrl))) {
    throw new Error(`background target not observed: ${expectedUrl}`);
  }
  await activatePageByUrl(port, keepActiveUrl);
}

function cdpCall(wsUrl, method, params = {}, timeoutMs = 5000) {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(wsUrl);
    const timer = setTimeout(() => {
      try { ws.terminate(); } catch { /* */ }
      reject(new Error(`CDP timeout: ${method}`));
    }, timeoutMs);
    ws.once("open", () => ws.send(JSON.stringify({ id: 1, method, params })));
    ws.once("error", (err) => {
      clearTimeout(timer);
      reject(err);
    });
    ws.on("message", (data) => {
      const msg = JSON.parse(data.toString());
      if (msg.id !== 1) return;
      clearTimeout(timer);
      ws.close();
      if (msg.error) reject(new Error(`CDP ${method}: ${msg.error.message}`));
      else resolve(msg.result);
    });
  });
}

/** 独立活动页机制:经浏览器 CDP websocket 激活,不经过 select_page。 */
async function activatePageByUrl(port, expectedUrl) {
  const target = (await pageTargets(port)).find((t) => t.url === expectedUrl);
  if (!target) throw new Error(`active-tab target not found: ${expectedUrl}`);
  const version = await (await fetch(`http://127.0.0.1:${port}/json/version`)).json();
  const browserWs = version.webSocketDebuggerUrl;
  const errors = [];
  try {
    const win = await cdpCall(browserWs, "Browser.getWindowForTarget", { targetId: target.id });
    try {
      await cdpCall(browserWs, "Browser.setWindowBounds", {
        windowId: win.windowId, bounds: { windowState: "minimized" },
      });
      await cdpCall(browserWs, "Browser.setWindowBounds", {
        windowId: win.windowId, bounds: { windowState: "normal" },
      });
    } catch (e) {
      errors.push(`Browser.setWindowBounds: ${e.message}`);
    }
    await cdpCall(browserWs, "Target.activateTarget", { targetId: target.id });
  } catch (e) {
    errors.push(`Target.activateTarget: ${e.message}`);
  }
  try {
    await cdpCall(target.webSocketDebuggerUrl, "Page.bringToFront");
  } catch (e) {
    errors.push(`Page.bringToFront: ${e.message}`);
  }
  if (!(await waitForActivePage(port, expectedUrl, 3000))) {
    throw new Error(`active-tab switch not observed: ${expectedUrl}${errors.length ? ` (${errors.join("; ")})` : ""}`);
  }
}

/** 安全执行单个 CLI 调用:失败返回 null 并记 fail(不炸整个 run) */
function safeBu(name, args, timeoutMs = 60000) {
  try { return bu(args, timeoutMs); }
  catch (e) { ok(name, false, e.message.slice(0, 160)); return null; }
}

const serverProc = spawn(process.platform === "win32" ? "python" : "python3",
  [path.join(ROOT, "test", "fixture", "server.py"), String(FIXTURE_PORT)],
  { stdio: "ignore", windowsHide: true });
// 跨域 iframe 宿主页需要 127.0.0.2 上的同端口第二实例(host 不同 = 跨站 → OOPIF;
// 实测 127.0.0.1 双端口不产生 OOPIF——site isolation 按 host 不按端口)
const serverProc2 = spawn(process.platform === "win32" ? "python" : "python3",
  [path.join(ROOT, "test", "fixture", "server.py"), String(FIXTURE_PORT), "127.0.0.2"],
  { stdio: "ignore", windowsHide: true });
// 嵌套 iframe 的跨站深页需要 127.0.0.3 第三实例(B 的孙 frame 与 B 跨站 → OOPIF 孙)
const serverProc3 = spawn(process.platform === "win32" ? "python" : "python3",
  [path.join(ROOT, "test", "fixture", "server.py"), String(FIXTURE_PORT), "127.0.0.3"],
  { stdio: "ignore", windowsHide: true });
let sessionId = null;

async function main() {
  // 等 fixture server 就绪
  let up = false;
  for (let i = 0; i < 20 && !up; i++) {
    try { await fetch(`${BASE}/echo-cookie`); up = true; } catch { await new Promise(r => setTimeout(r, 250)); }
  }
  console.log(`fixture server: ${up ? "up" : "FAILED"}`);
  if (!up) { console.log(`fail: ${fail + 1}`); process.exit(1); }

  // ---- 1. 会话启动 ----
  console.log("\n[1] 会话生命周期");
  let out = bu(["start"]);
  sessionId = (out.match(/session=(\S+)/) ?? [])[1];
  ok("start 输出 session id", !!sessionId, out.slice(0, 120));
  const st = JSON.parse(bu(["status", "--output-format=json"]));
  const my = st.sessions.find(s => s.session_id === sessionId);
  ok("start 后 state=ready", my?.state === "ready", JSON.stringify(my));
  const bridgeOn = st.bridge.connected;
  if (bridgeOn) ok("login=injected(桥在线,登录态已注入)", my?.login_state === "injected", `实际 ${my?.login_state}`);
  else skip("login=injected", "桥未连接(日常浏览器/扩展未开)");

  // ---- 2. fixture 页快照(基础/穿透/滚动标注) ----
  console.log("\n[2] 快照与穿透");
  bu(["navigate_page", "--session", sessionId, `${BASE}/`]);
  let snap = bu(["take_snapshot", "--session", sessionId]);
  ok("快照含页面标题", snap.includes("BU Fixture 主页"));
  ok("shadow-root(open)元素穿透可见", snap.includes("open-shadow按钮"));
  ok("shadow-root(closed)元素穿透可见", snap.includes("closed-shadow按钮"));
  ok("滚动容器带 scroll 标注", /scroll=div\.[^ ]* ↓\d+(\.\d+)?p/.test(snap), "未找到 scroll= 行");
  ok("懒加载哨兵可见", snap.includes("lazy-sentinel"));

  // ---- 3. shadow 交互 ----
  console.log("\n[3] shadow-root 交互");
  const shadowUid = parseSnapUid(snap, "open-shadow按钮");
  ok("shadow 按钮取得 uid", !!shadowUid);
  if (shadowUid) {
    safeBu("click shadow 按钮", ["click", "--session", sessionId, shadowUid]);
    const ev = safeBu("evaluate 读日志区", ["evaluate_script", "--session", sessionId,
      "() => document.getElementById('log').textContent"]);
    const logText = (() => { try { return JSON.parse(ev).value; } catch { return String(ev); } })();
    ok("shadow 按钮点击生效(log 直读)", String(logText).includes("open-shadow-clicked"), String(logText).slice(0, 120));
    snap = bu(["take_snapshot", "--session", sessionId]);
    ok("shadow 点击可见于快照", snap.includes("open-shadow-clicked"));
  }

  // ---- 4. 表单:fill/checkbox/select/提交 ----
  console.log("\n[4] 表单");
  // 诊断:dump textbox/combobox/checkbox 相关行(定位 a11y 命名行为)
  for (const line of snap.split("\n")) {
    if (/textbox|combobox|checkbox|姓名|城市|同意|简介/.test(line)) console.log("    [snap]", line.trim().slice(0, 110));
  }
  const nameUid = parseSnapUid(snap, "textbox") ?? parseSnapUid(snap, '"姓名"');
  ok("姓名输入框取得 uid", !!nameUid, snap.split("\n").filter(l => l.includes("姓名")).join(" || ").slice(0, 150));
  if (nameUid) { const r = safeBu("fill 姓名", ["fill", "--session", sessionId, nameUid, "张三"]); }
  const agreeUid = parseSnapUid(snap, "同意条款");
  if (agreeUid) { const r = safeBu("click 同意条款", ["click", "--session", sessionId, agreeUid]); }
  // select 行(combobox)而非 option 行(option 未展开无几何)
  const cityUid = parseSnapUid(snap, "combobox") ?? parseSnapUid(snap, '"城市"');
  ok("城市下拉取得 uid(combobox)", !!cityUid);
  if (cityUid) { const r = safeBu("fill 城市", ["fill", "--session", sessionId, cityUid, "bj"]); }
  // textarea 的 AX 名带尾随空格("简介 ")——用 textbox+名前缀匹配,防精确串失配
  const bioUid = parseSnapUid(snap, 'textbox "简介');
  ok("简介输入框取得 uid", !!bioUid);
  if (bioUid) { const r = safeBu("fill 简介", ["fill", "--session", sessionId, bioUid, "e2e 简介内容"]); }
  const submitUid = parseSnapUid(snap, "提交表单");
  if (submitUid) { const r = safeBu("click 提交", ["click", "--session", sessionId, submitUid]); }
  snap = bu(["take_snapshot", "--session", sessionId]);
  ok("表单提交:name", snap.includes("name=张三"));
  ok("表单提交:city=bj(select)", snap.includes("city=bj"));
  ok("表单提交:agree=True(checkbox)", /agree=True/i.test(snap));
  // "e2e 简介内容".length === 8:精确回显长度,bio 未被置值时为 bioLen=0 必红
  ok("表单提交:bio 长度回显", snap.includes("bioLen=8"));

  // ---- 5. 文件上传 ----
  console.log("\n[5] 上传");
  const tmpUp = path.join(ROOT, "test", "fixture", "upload-sample.txt");
  fs.writeFileSync(tmpUp, "e2e upload sample");
  const fileUid = parseSnapUid(snap, "附件上传");
  ok("文件输入取得 uid", !!fileUid, snap.split("\n").filter(l => l.includes("附件") || l.includes("file")).join(" || ").slice(0, 150));
  if (fileUid) {
    bu(["upload_file", "--session", sessionId, fileUid, tmpUp]);
    snap = bu(["take_snapshot", "--session", sessionId]);
    ok("上传回显(file-selected)", snap.includes("file-selected=upload-sample.txt"));
  }

  // ---- 6. 动态重建(uid 失效防护) ----
  console.log("\n[6] 动态重建");
  const rebuildUid = parseSnapUid(snap, "重建列表");
  const staleUid = parseSnapUid(snap, "item-a");   // 重建前持有的引用:重建后必然失效
  bu(["click", "--session", sessionId, rebuildUid]);
  snap = bu(["take_snapshot", "--session", sessionId]);
  ok("重建后新内容可见(rebuilt-0)", snap.includes("rebuilt-0"));
  ok("重建后 log 记录", snap.includes("list-rebuilt"));

  // ---- 6.5 错误契约:失效引用与工具级超时都不得被协议层/传输层抢走真原因 ----
  console.log("\n[6.5] 错误契约");
  if (staleUid) {
    const stale = buTry(["click", "--session", sessionId, staleUid, "--output-format=json"]);
    ok("失效 uid → STATE_EXPIRED(退出码 5,可重试;不是 CDP_ERROR)",
      stale.status === 5 && errorCodeOf(stale) === "STATE_EXPIRED",
      `exit=${stale.status} code=${errorCodeOf(stale)} err=${(stale.stderr || stale.stdout).trim().slice(0, 160)}`);
  } else {
    ok("失效 uid → STATE_EXPIRED(退出码 5,可重试;不是 CDP_ERROR)", false, "重建前未取到 item-a 的 uid");
  }
  const tWait = Date.now();
  const waitMiss = buTry(["wait_for", "--session", sessionId, "e2e-不会出现的文本",
    "--timeout=1500", "--output-format=json"]);
  const waitWall = Date.now() - tWait;
  ok("wait_for 未命中 → TIMEOUT(不是传输层 CORE_TIMEOUT)",
    waitMiss.status === 5 && errorCodeOf(waitMiss) === "TIMEOUT",
    `exit=${waitMiss.status} code=${errorCodeOf(waitMiss)} wall=${waitWall}ms err=${(waitMiss.stderr || waitMiss.stdout).trim().slice(0, 160)}`);
  ok("工具级预算先于传输层到点(不在 +5s 余量处才被杀)", waitWall < 1500 + 4000, `wall=${waitWall}ms`);
  const emu = buTry(["emulate", "--session", sessionId, "--userAgent=red-line-probe/1.0", "--output-format=json"]);
  ok("emulate 红线维度 → UNSUPPORTED(不得静默 done)",
    emu.status === 2 && errorCodeOf(emu) === "UNSUPPORTED",
    `exit=${emu.status} code=${errorCodeOf(emu)} err=${(emu.stderr || emu.stdout).trim().slice(0, 160)}`);

  // ---- 7. 滚动与懒加载(分步滚,避免 scrollBy 瞬移跳过 IntersectionObserver 哨兵) ----
  console.log("\n[7] 滚动与懒加载");
  for (let i = 0; i < 3; i++) {
    bu(["scroll", "--session", sessionId, "down", "--amount", "600"]);
    snap = bu(["take_snapshot", "--session", sessionId]);
    if (snap.includes("lazy-item-b1")) break;
  }
  ok("懒加载第一批被触发(lazy-item-b1)", snap.includes("lazy-item-b1"), "滚动后快照未见懒加载内容");

  // ---- 7.5 iframe 内滚动(uid 落点在同进程 iframe:滚动量按该 frame 读,主文档不动) ----
  console.log("\n[7.5] iframe 内滚动");
  bu(["navigate_page", "--session", sessionId, `${BASE}/scroll-host`]);
  snap = bu(["take_snapshot", "--session", sessionId]);
  const tallUid = parseSnapUid(snap, "深滚按钮");
  ok("iframe 内深部按钮取得 uid", !!tallUid);
  if (tallUid) {
    // 预热:先消费一次 uid(hover)让 scrollIntoViewIfNeeded 的副作用发生在基线
    // 之前——否则基线采样后工具内部的 scrollIntoView 会污染 delta(审查复审指正)
    bu(["hover", "--session", sessionId, tallUid]);
    // 基线:预热后读 [iframe.scrollY, 主文档.scrollY];按钮下方余量 ≥800px
    // 保证工具滚轮的增量可被单独判别
    const base = JSON.parse(bu(["evaluate_script", "--session", sessionId,
      `() => [document.getElementById('scroller').contentWindow.scrollY, window.scrollY]`,
      "--output-format=json"]));
    const r = JSON.parse(bu(["scroll", "--session", sessionId, "down", "--amount", "400",
      "--uid", tallUid, "--output-format=json"]));
    const after = JSON.parse(bu(["evaluate_script", "--session", sessionId,
      `() => [document.getElementById('scroller').contentWindow.scrollY, window.scrollY]`,
      "--output-format=json"]));
    const delta = (after.value?.[0] ?? 0) - (base.value?.[0] ?? 0);
    ok("iframe 内滚动生效(预热后增量,主文档不动)",
      delta > 50 && delta < 700 && (after.value?.[1] ?? -1) === 0 && (base.value?.[1] ?? -1) === 0,
      `scrollY 基线=${base.value?.[0]} → ${after.value?.[0]}(delta=${delta},纯滚轮窗) 主文档=${after.value?.[1]} wheel=${r.result?.wheel_used}`);
  }

  // ---- 8. dialog:工具撞上未处理弹窗报错属 blockedByDialog 预期语义(cdt 同);
  //         handle_dialog accept 后流程恢复 ----
  console.log("\n[8] 对话框");
  bu(["navigate_page", "--session", sessionId, `${BASE}/`]);  // 回主页([7.5] 曾导航去滚动页)
  snap = bu(["take_snapshot", "--session", sessionId]);
  const alertUid = parseSnapUid(snap, "弹 alert");
  let dialogErr = null;
  try {
    bu(["click", "--session", sessionId, alertUid]);
  } catch (e) { if (!/未处理|dialog/i.test(e.message)) dialogErr = e.message; }
  // blockedByDialog 预检腿:弹窗挂起期间,下一个执行类工具必须立即报
  // "A dialog is open"引导 handle_dialog(而非挂死)——DEC-018 预检路径的真断言
  let blockedHit = false;
  try {
    bu(["evaluate_script", "--session", sessionId, "() => 1"]);
  } catch (e) { blockedHit = /A dialog is open/i.test(String(e.stdout ?? "") + String(e.stderr ?? "") + e.message); }
  ok("弹窗挂起时后续工具预检报错(blockedByDialog)", blockedHit);
  try {
    bu(["handle_dialog", "--session", sessionId, "accept"]);
  } catch (e) { dialogErr = (dialogErr ?? "") + " / accept: " + e.message; }
  // accept 后 evaluate 可执行 = 页面 JS 已从弹窗阻塞中恢复
  let recovered = false;
  try {
    const ev = bu(["evaluate_script", "--session", sessionId, "() => 1+1", "--output-format=json"]);
    recovered = ev.includes("2");
  } catch { /* 未恢复 */ }
  ok("alert+accept 流程收尾(工具报错→accept→恢复)", !dialogErr && recovered, dialogErr ?? "");
  snap = bu(["take_snapshot", "--session", sessionId]);
  const confirmUid = parseSnapUid(snap, "弹 confirm");
  let confirmErr = null;
  try {
    bu(["click", "--session", sessionId, confirmUid]);
  } catch (e) { if (!/未处理|dialog/i.test(e.message)) confirmErr = e.message; }
  try {
    bu(["handle_dialog", "--session", sessionId, "accept"]);
  } catch (e) { confirmErr = (confirmErr ?? "") + " / accept: " + e.message; }
  let confirmLog = "";
  try {
    const ev = JSON.parse(bu(["evaluate_script", "--session", sessionId,
      "() => document.getElementById('log').textContent", "--output-format=json"]));
    confirmLog = String(ev.value ?? "");
  } catch { /* 未恢复 */ }
  ok("confirm+accept 回执写入 log", !confirmErr && confirmLog.includes("confirm-result=true"), confirmErr ?? confirmLog.slice(0, 100));

  // ---- 9. cookie 管道(会话实例内 set→echo) ----
  console.log("\n[9] cookie 管道");
  bu(["navigate_page", "--session", sessionId, `${BASE}/set-cookie`]);
  bu(["navigate_page", "--session", sessionId, `${BASE}/echo-cookie`]);
  snap = bu(["take_snapshot", "--session", sessionId]);
  // 锚定 echo 端点的回显前缀:第二跳导航静默失败时快照停在 set-cookie 页
  // (其响应体含 "cookie set: bu_e2e=..."),宽断言 bu_e2e= 会假绿——前缀钉死页面
  ok("会话 cookie 栈(set→echo 回读 bu_e2e)", snap.includes("echo-cookie: bu_e2e="),
    snap.split("\n").find(l => l.includes("bu_e2e"))?.slice(0, 100));

  // ---- 10. iframe:同 host(同进程,主树直含)+ 跨域(OOPIF,per-frame 拼树) ----
  console.log("\n[10] iframe 穿透");
  bu(["navigate_page", "--session", sessionId, `${BASE}/`]);
  snap = bu(["take_snapshot", "--session", sessionId]);
  ok("同 host iframe 内容在快照", snap.includes("子页按钮"));
  // 跨域:iframe 加载 + OOPIF target 建立需要时间,navigate 只等主文档
  bu(["navigate_page", "--session", sessionId, `${BASE}/xo-host`]);
  await new Promise(r => setTimeout(r, 2000));
  snap = bu(["take_snapshot", "--session", sessionId]);
  ok("跨域 iframe 内容进快照(子页按钮)", snap.includes("子页按钮"),
     "OOPIF 拼树未生效——检查 take_snapshot 的 per-frame 拼接");
  const xoUid = parseSnapUid(snap, "子页按钮");
  ok("跨域 iframe 内按钮取得 uid", !!xoUid);
  if (xoUid) {
    bu(["click", "--session", sessionId, xoUid]);
    snap = bu(["take_snapshot", "--session", sessionId]);
    ok("跨域 iframe 内点击生效(child-clicked)", snap.includes("child-clicked"),
       "uid 消费未按 frame session 路由或点击未达子 frame");
    // uid 随快照轮换:截图用最新快照的 uid
    const xoUid2 = parseSnapUid(snap, "子页按钮");
    try { bu(["take_screenshot", "--session", sessionId, "--uid", xoUid2]); ok("跨域 iframe 元素截图", true); }
    catch (e) { ok("跨域 iframe 元素截图", false, e.message.slice(0, 120)); }
  }

  // ---- 11. 嵌套 frame:A(127.0.0.1)→ B(127.0.0.2,OOPIF)→ 深页两嵌套形态
  //         (B 内同进程子 frame:same @127.0.0.2;B 内跨站子 frame:xo @127.0.0.3 → OOPIF 孙) ----
  console.log("\n[11] 嵌套 frame");
  bu(["navigate_page", "--session", sessionId, `${BASE}/xo-nested`]);
  await new Promise(r => setTimeout(r, 3000));  // 两层 iframe 加载 + 递归 auto-attach 需要时间
  snap = bu(["take_snapshot", "--session", sessionId]);
  ok("嵌套快照含 B 内同进程深页(same)", snap.includes("深页same按钮"),
     "OOPIF 内同进程子 frame 未拼入——检查 _frame_map 子树遍历");
  ok("嵌套快照含 B 内跨站深页(xo)", snap.includes("深页xo按钮"),
     "OOPIF 孙 frame(递归 auto-attach)未拼入");
  const sameUid = parseSnapUid(snap, "深页same按钮");
  if (sameUid) {
    bu(["click", "--session", sessionId, sameUid]);
    snap = bu(["take_snapshot", "--session", sessionId]);
    ok("同进程深页点击生效(deep-same-clicked)", snap.includes("deep-same-clicked"));
  }
  const xoDeepUid = parseSnapUid(snap, "深页xo按钮");
  if (xoDeepUid) {
    bu(["click", "--session", sessionId, xoDeepUid]);
    snap = bu(["take_snapshot", "--session", sessionId]);
    ok("跨站深页点击生效(deep-xo-clicked)", snap.includes("deep-xo-clicked"),
       "OOPIF 孙 uid 点击未路由到其 session");
  }

  // ---- 11.5 中部大偏移跨域 iframe(坐标换算防退化) ----
  // iframe 宿主偏移 ~440px + 内部按钮偏移 ~150px:换算缺失时落点必落主视口左上角空白
  console.log("\n[11.5] 中部偏移 iframe 落点");
  bu(["navigate_page", "--session", sessionId, `${BASE}/xo-offset`]);
  await new Promise(r => setTimeout(r, 2000));
  snap = bu(["take_snapshot", "--session", sessionId]);
  ok("偏移 iframe 内容进快照(偏移子页按钮)", snap.includes("偏移子页按钮"),
     "OOPIF 拼树未生效");
  const offUid = parseSnapUid(snap, "偏移子页按钮");
  ok("偏移 iframe 内按钮取得 uid", !!offUid);
  if (offUid) {
    bu(["click", "--session", sessionId, offUid]);
    snap = bu(["take_snapshot", "--session", sessionId]);
    ok("中部偏移 iframe 点击命中(inner-clicked)", snap.includes("inner-clicked"),
       "宿主偏移换算缺失——点击落点仍在主视口左上角");
    const offUid2 = parseSnapUid(snap, "偏移子页按钮");
    try { bu(["take_screenshot", "--session", sessionId, "--uid", offUid2]); ok("中部偏移 iframe 元素截图(smoke)", true); }
    catch (e) { ok("中部偏移 iframe 元素截图(smoke)", false, e.message.slice(0, 120)); }
  }

  // ---- 12. 页作用域工具跟随浏览器活动标签 ----
  console.log("\n[12] 活动标签路由");
  const tabMain = `${BASE}/?tab=main`;
  const tabBackground = `${BASE}/child.html?tab=background`;
  const tabManual = `${BASE}/deep.html?tab=manual`;
  const tabClose = `${BASE}/child.html?tab=close-selected`;
  const blankUrl = `${BASE}/child.html`;
  const debugPort = sessionPort(sessionId);

  // Oracle: specified（fixture 的 href/target）——target=_blank 后活动页必须是 child.html。
  try {
    bu(["navigate_page", "--session", sessionId, tabMain]);
    snap = bu(["take_snapshot", "--session", sessionId]);
    const blankUid = parseSnapUid(snap, "新窗口打开子页");
    ok("新窗口链接取得 uid", !!blankUid, snap.split("\n").filter((l) => l.includes("新窗口")).join(" || ").slice(0, 160));
    if (blankUid) {
      bu(["click", "--session", sessionId, blankUid]);
      const activeChanged = await waitForActivePage(debugPort, blankUrl);
      ok("click target=_blank 后浏览器活动页切换", activeChanged,
        `独立活动页机制未观察到 ${blankUrl}`);
      snap = bu(["take_snapshot", "--session", sessionId]);
      ok("click target=_blank 后 take_snapshot 跟随新活动页", snapshotDocUrl(snap) === blankUrl,
        `doc=${snapshotDocUrl(snap)}(期望 ${blankUrl})`);
      const blankPageId = pageIdForUrl(sessionId, blankUrl);
      ok("click target=_blank 后快照提示新前台页", !!blankPageId && hasPageChangeNotice(snap, blankPageId, blankUrl),
        `page_id=${blankPageId} notice=${snap.split("\n").filter((l) => /page_id|changed|switch|opened|unexpected/i.test(l)).join(" || ").slice(0, 180)}`);
    } else {
      ok("click target=_blank 后 take_snapshot 跟随新活动页", false, "缺少新窗口链接 uid");
    }
  } catch (e) {
    ok("click target=_blank 后 take_snapshot 跟随新活动页", false, e.message.slice(0, 180));
  }
  try {
    const blankId = pageIdForUrl(sessionId, blankUrl);
    if (blankId) bu(["close_page", "--session", sessionId, blankId]);
    const mainId = pageIdForUrl(sessionId, tabMain);
    if (mainId) bu(["select_page", "--session", sessionId, mainId]);
  } catch { /* 后续用例会重新建立页面状态 */ }

  // Oracle: specified + derived——显式选择后台页应保持；独立 CDP 活动页变化应覆盖它。
  try {
    bu(["navigate_page", "--session", sessionId, tabMain]);
    bu(["new_page", "--session", sessionId, tabBackground]);
    bu(["new_page", "--session", sessionId, tabManual]);
    await activatePageByUrl(debugPort, tabMain);
    const backgroundId = pageIdForUrl(sessionId, tabBackground);
    ok("后台页可从 list_pages 定位", !!backgroundId, `backgroundId=${backgroundId}`);
    if (backgroundId) {
      bu(["select_page", "--session", sessionId, backgroundId]);
      snap = bu(["take_snapshot", "--session", sessionId]);
      ok("显式 select_page 后 take_snapshot 读取所选后台页", snapshotDocUrl(snap) === tabBackground,
        `doc=${snapshotDocUrl(snap)}(期望 ${tabBackground})`);
      await activatePageByUrl(debugPort, tabManual);
      snap = bu(["take_snapshot", "--session", sessionId]);
      ok("浏览器活动标签变化覆盖显式选择", snapshotDocUrl(snap) === tabManual,
        `doc=${snapshotDocUrl(snap)}(期望 ${tabManual})`);
    } else {
      ok("显式 select_page 后 take_snapshot 读取所选后台页", false, "后台页未定位");
      ok("浏览器活动标签变化覆盖显式选择", false, "后台页未定位");
    }
  } catch (e) {
    ok("显式 select_page 后 take_snapshot 读取所选后台页", false, e.message.slice(0, 180));
    ok("浏览器活动标签变化覆盖显式选择", false, e.message.slice(0, 180));
  }
  try {
    for (const u of [tabBackground, tabManual]) {
      const id = pageIdForUrl(sessionId, u);
      if (id) bu(["close_page", "--session", sessionId, id]);
    }
    bu(["list_pages", "--session", sessionId]);
    const mainId = pageIdForUrl(sessionId, tabMain);
    if (mainId) bu(["select_page", "--session", sessionId, mainId]);
  } catch { /* 后续用例会重新建立页面状态 */ }

  // Oracle: derived——关闭选中页后，take_snapshot 必须匹配独立机制解析出的活动页。
  try {
    bu(["navigate_page", "--session", sessionId, tabMain]);
    const created = JSON.parse(bu(["new_page", "--session", sessionId, tabClose, "--output-format=json"]));
    ok("关闭场景的新页成为当前选中页", created.url === tabClose, `url=${created.url}`);
    bu(["close_page", "--session", sessionId, created.page_id]);
    const recoveredActive = await waitForActivePage(debugPort, tabMain);
    ok("关闭选中页后浏览器解析到新活动页", recoveredActive, `独立活动页机制未观察到 ${tabMain}`);
    snap = bu(["take_snapshot", "--session", sessionId]);
    ok("关闭选中页后 take_snapshot 跟随新活动页", snapshotDocUrl(snap) === tabMain,
      `doc=${snapshotDocUrl(snap)}(期望 ${tabMain})`);
  } catch (e) {
    ok("关闭选中页后 take_snapshot 跟随新活动页", false, e.message.slice(0, 180));
  }
  try {
    bu(["list_pages", "--session", sessionId]);
    const mainId = pageIdForUrl(sessionId, tabMain);
    if (mainId) bu(["select_page", "--session", sessionId, mainId]);
  } catch { /* 收尾不依赖该恢复 */ }

  // ---- 12.5 DEC-033:显式前台化 / 页面变化提醒 / 跨 tab listen 缓冲 ----
  console.log("\n[12.5] DEC-033 页面变化与网络状态");
  const d33Main = `${BASE}/?dec033=main`;
  const d33Background = `${BASE}/child.html?dec033=explicit-background`;
  const d33Popup = `${BASE}/deep.html?dec033=cdp-background`;
  const d33Nav = `${BASE}/child.html?dec033=same-tab-nav`;
  const d33Explicit = `${BASE}/deep.html?dec033=explicit-new`;
  const d33NetworkOld = `${BASE}/?dec033=network-old`;
  const d33NetworkChildPrefix = `${BASE}/child.html?dec033_net=`;

  // Oracle: specified——select_page 必须真实前台化，而不是只改驱动路由。
  try {
    bu(["navigate_page", "--session", sessionId, d33Main]);
    const bgCreated = JSON.parse(bu(["new_page", "--session", sessionId, d33Background,
      "--background", "--output-format=json"]));
    const bgId = pageIdForUrl(sessionId, d33Background);
    ok("DEC-033 后台 new_page 不成为当前页", await waitForActivePage(debugPort, d33Main),
      `独立活动页机制未观察到 ${d33Main}`);
    const bgSnap = bu(["take_snapshot", "--session", sessionId]);
    ok("DEC-033 后台 new_page 后快照仍读当前页", snapshotDocUrl(bgSnap) === d33Main,
      `doc=${snapshotDocUrl(bgSnap)}(期望 ${d33Main})`);
    ok("DEC-033 显式 new_page 不产生冗余 unexpected 提示", !hasUnexpectedNotice(bgSnap),
      bgSnap.split("\n").filter((l) => /unexpected/i.test(l)).join(" || ").slice(0, 160));
    if (bgId) {
      await activatePageByUrl(debugPort, d33Main);
      bu(["select_page", "--session", sessionId, bgId]);
      const selectedActive = await waitForActivePage(debugPort, d33Background);
      ok("DEC-033 select_page 实际前台化所选页", selectedActive,
        `独立活动页机制未观察到 ${d33Background}`);
      const selectedSnap = bu(["take_snapshot", "--session", sessionId]);
      ok("DEC-033 select_page 后快照读取所选页", snapshotDocUrl(selectedSnap) === d33Background,
        `doc=${snapshotDocUrl(selectedSnap)}(期望 ${d33Background})`);
      ok("DEC-033 select_page 不产生冗余 unexpected 提示", !hasUnexpectedNotice(selectedSnap),
        selectedSnap.split("\n").filter((l) => /unexpected/i.test(l)).join(" || ").slice(0, 160));
    } else {
      ok("DEC-033 select_page 实际前台化所选页", false, `page_id not found for ${d33Background}`);
      ok("DEC-033 select_page 后快照读取所选页", false, "后台页未定位");
      ok("DEC-033 select_page 不产生冗余 unexpected 提示", false, "后台页未定位");
    }
    const mainId = pageIdForUrl(sessionId, d33Main);
    if (mainId) {
      await activatePageByUrl(debugPort, d33Background);
      bu(["select_page", "--session", sessionId, mainId, "--bringToFront"]);
      ok("DEC-033 select_page --bringToFront 兼容并前台化", await waitForActivePage(debugPort, d33Main),
        `独立活动页机制未观察到 ${d33Main}`);
    } else {
      ok("DEC-033 select_page --bringToFront 兼容并前台化", false, "主页面未定位");
    }
    if (bgId) bu(["close_page", "--session", sessionId, bgId]);
  } catch (e) {
    ok("DEC-033 select_page 实际前台化所选页", false, e.message.slice(0, 180));
  }
  try {
    bu(["list_pages", "--session", sessionId]);
    const mainId = pageIdForUrl(sessionId, d33Main);
    if (mainId) bu(["select_page", "--session", sessionId, mainId, "--bringToFront"]);
  } catch { /* */ }

  // Oracle: derived——非工具入口创建后台页；CDP background=true 明确声明模拟真实后台 popup。
  try {
    await createBackgroundTarget(debugPort, d33Popup, d33Main);
    const popupId = pageIdForUrl(sessionId, d33Popup);
    ok("DEC-033 后台 CDP 新页不成为当前页", await waitForActivePage(debugPort, d33Main),
      `独立活动页机制未观察到 ${d33Main}`);
    const popupSnap = bu(["take_snapshot", "--session", sessionId]);
    ok("DEC-033 后台 CDP 新页快照仍读当前页", snapshotDocUrl(popupSnap) === d33Main,
      `doc=${snapshotDocUrl(popupSnap)}(期望 ${d33Main})`);
    ok("DEC-033 后台 CDP 新页快照提示包含 page_id+URL",
      !!popupId && hasPageChangeNotice(popupSnap, popupId, d33Popup),
      `page_id=${popupId} notice=${popupSnap.split("\n").filter((l) => /page_id|changed|switch|opened|background|unexpected/i.test(l)).join(" || ").slice(0, 180)}`);
    if (popupId) bu(["close_page", "--session", sessionId, popupId]);
  } catch (e) {
    ok("DEC-033 后台 CDP 新页快照提示包含 page_id+URL", false, e.message.slice(0, 180));
  }

  // Oracle: specified——同标签 URL 导航在下一次快照中必须可见提醒。
  try {
    bu(["navigate_page", "--session", sessionId, d33Main]);
    bu(["navigate_page", "--session", sessionId, d33Nav]);
    const navId = pageIdForUrl(sessionId, d33Nav);
    const navSnap = bu(["take_snapshot", "--session", sessionId]);
    ok("DEC-033 同标签 URL 导航快照提示包含 page_id+URL",
      !!navId && snapshotDocUrl(navSnap) === d33Nav && hasPageChangeNotice(navSnap, navId, d33Nav),
      `page_id=${navId} doc=${snapshotDocUrl(navSnap)} notice=${navSnap.split("\n").filter((l) => /page_id|changed|navigat|unexpected/i.test(l)).join(" || ").slice(0, 180)}`);
  } catch (e) {
    ok("DEC-033 同标签 URL 导航快照提示包含 page_id+URL", false, e.message.slice(0, 180));
  }

  // Oracle: specified——显式 new_page 已知目标，不再重复"意外变化"提示。
  try {
    bu(["new_page", "--session", sessionId, d33Explicit]);
    const explicitSnap = bu(["take_snapshot", "--session", sessionId]);
    const explicitPages = readPages(sessionId);
    const explicitPage = explicitPages.find((p) => p.url === d33Explicit);
    ok("DEC-033 显式 new_page 后快照读取新页且无冗余 unexpected 提示",
      snapshotDocUrl(explicitSnap) === d33Explicit && !!explicitPage && !hasUnexpectedNotice(explicitSnap),
      `doc=${snapshotDocUrl(explicitSnap)} unexpected=${hasUnexpectedNotice(explicitSnap)}`);
    if (explicitPage) bu(["close_page", "--session", sessionId, explicitPage.page_id]);
  } catch (e) {
    ok("DEC-033 显式 new_page 后快照读取新页且无冗余 unexpected 提示", false, e.message.slice(0, 180));
  }

  // Oracle: derived——旧页唯一请求由 fixture 发起；切回后该页 listen 缓冲仍可取。
  try {
    bu(["navigate_page", "--session", sessionId, d33NetworkOld]);
    await waitForActivePage(debugPort, d33NetworkOld);
    bu(["list_network_requests", "--session", sessionId, "--output-format=json"]); // 开启/排空旧页监听
    snap = bu(["take_snapshot", "--session", sessionId]);
    const netBtn = parseSnapUid(snap, "旧页请求后开新窗口");
    ok("DEC-033 旧页请求按钮取得 uid", !!netBtn,
      snap.split("\n").filter((l) => l.includes("旧页请求")).join(" || ").slice(0, 160));
    if (netBtn) {
      bu(["click", "--session", sessionId, netBtn]);
      const childUrl = await waitForActivePagePrefix(debugPort, d33NetworkChildPrefix);
      ok("DEC-033 旧页按钮打开并跟随前台新页", !!childUrl, `active=${childUrl}`);
      const childToken = childUrl ? new URL(childUrl).searchParams.get("dec033_net") : null;
      let childEarlyFound = false;
      let childEarlyDetail = "";
      for (let i = 0; i < 10 && !childEarlyFound && childToken; i++) {
        const childNet = JSON.parse(bu(["list_network_requests", "--session", sessionId, "--output-format=json"]));
        const urls = (childNet.requests ?? []).map((r) => r.url);
        childEarlyFound = urls.some((u) => String(u).includes("dec033_early=") && String(u).includes(childToken));
        childEarlyDetail = `token=${childToken} urls=${JSON.stringify(urls.slice(-4))}`;
        if (!childEarlyFound) await new Promise((r) => setTimeout(r, 200));
      }
      ok("DEC-033 跟随新页后可见新页首包", childEarlyFound, childEarlyDetail);
      const oldId = pageIdForUrl(sessionId, d33NetworkOld);
      if (oldId) bu(["select_page", "--session", sessionId, oldId]);
      const token = JSON.parse(bu(["evaluate_script", "--session", sessionId,
        "() => window.__buLastNetworkToken", "--output-format=json"])).value;
      let netFound = false;
      let netDetail = "";
      for (let i = 0; i < 10 && !netFound && token; i++) {
        const net = JSON.parse(bu(["list_network_requests", "--session", sessionId, "--output-format=json"]));
        const urls = (net.requests ?? []).map((r) => r.url);
        netFound = urls.some((u) => String(u).includes(String(token)));
        netDetail = `token=${token} urls=${JSON.stringify(urls.slice(-4))}`;
        if (!netFound) await new Promise((r) => setTimeout(r, 200));
      }
      ok("DEC-033 切回旧页后保留旧页唯一网络请求", netFound, netDetail);
      const child = readPages(sessionId).find((p) => p.url.startsWith(d33NetworkChildPrefix));
      if (child) bu(["close_page", "--session", sessionId, child.page_id]);
    } else {
      ok("DEC-033 切回旧页后保留旧页唯一网络请求", false, "请求按钮 uid 未取得");
    }
  } catch (e) {
    ok("DEC-033 切回旧页后保留旧页唯一网络请求", false, e.message.slice(0, 180));
  }

  // ---- 13. stop(完整删除口径:session 目录 + profile 一律不留) ----
  console.log("\n[13] 收尾");
  out = bu(["stop", "--session", sessionId]);
  ok("stop → cleaned", out.includes("state=cleaned"), out.slice(0, 120));
  const buHome = process.env.BROWSER_USE_HOME ?? path.join(os.homedir(), ".browser-use");
  ok("stop 后 session 目录已删", !fs.existsSync(path.join(buHome, "sessions", sessionId)),
     "会话产物清理不完整——sessions/<id> 仍存在");
  ok("stop 后 profile 目录已删", !fs.existsSync(path.join(buHome, "profiles", sessionId)),
     "profile 仍存在");
  const listed = bu(["sessions", "list", "--output-format=json"]);
  ok("session list 不含已 stop 会话", !listed.includes(sessionId));

  // ---- 14. port-only 会话:降级态的通道契约 ----
  console.log("\n[14] port-only 会话通道");
  await portOnlySection();

  // ---- 15. Web 存储搬运:localStorage/sessionStorage 种入 ----
  console.log("\n[15] Web 存储搬运");
  await webStorageSection();
}

// 一部分站的登录态不在 cookie 里,只在 localStorage/sessionStorage;桥把日常浏览器读到的值
// 随 cookie 同一次往返捎回,daemon 交给 core 做 init script 种入。
// 这一节用隔离 home + 扮演扩展的假桥走通 daemon → core → 浏览器整条链(真扩展的采集逻辑
// 由 test/unit/extension-bridge.test.mjs 覆盖;这里要证的是"种子先于站点脚本落下")。
async function webStorageSection() {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "bu-webstorage-home-"));
  const daemonPort = 27991;
  const bridgePort = 27992;
  const env = { ...process.env, BROWSER_USE_HOME: home, BU_DAEMON_PORT: String(daemonPort) };
  const run = (args, timeoutMs = 120000) => spawnSync(process.execPath, [CLI, ...args],
    { encoding: "utf8", timeout: timeoutMs, env });
  // 假桥要在会话启动期间应答 daemon,所以这一步起必须异步:spawnSync 会把事件循环钉住,
  // WS 消息进不来也回不去,daemon 只会等到 BRIDGE_TIMEOUT(这条曾经真的把本节测成红的)。
  const runAsync = (args, timeoutMs = 120000) => new Promise((resolve) => {
    const child = spawn(process.execPath, [CLI, ...args],
      { env, windowsHide: true, stdio: ["ignore", "pipe", "pipe"] });
    let stdout = "";
    let stderr = "";
    const timer = setTimeout(() => { try { child.kill("SIGKILL"); } catch { /* */ } }, timeoutMs);
    child.stdout.on("data", (d) => { stdout += d; });
    child.stderr.on("data", (d) => { stderr += d; });
    child.on("close", (status) => { clearTimeout(timer); resolve({ status, stdout, stderr }); });
  });
  let stSession = null;
  let liveBrowser = false;
  let bridge = null;
  try {
    fs.writeFileSync(path.join(home, "config.json"), JSON.stringify({
      port_range: [18570, 18620], daemon_http_port: daemonPort, bridge_ws_port: bridgePort,
      daily_browser_autostart: false, storage_wait_ms: 400,
    }));
    const st = run(["status", "--output-format=json"]);
    ok("web-storage daemon 起在隔离 home", st.status === 0, (st.stderr || "").slice(0, 160));

    // 假桥 = 扩展的 daemon 侧那一半(采集本身不在这里测)。两种协商形态各演一遍:
    // legacy = 协商 1,存储捎在 cookie 回复里;proto2 = 协商 2,存储单独一条消息。
    const seedLocal = { bu_e2e_token: "bu-e2e-seed-1" };
    const seedSession = { bu_e2e_sid: "bu-e2e-session-1" };
    const seedStorage = [{ origin: BASE, local: seedLocal, session: seedSession }];
    const seedStats = { tabs: 1, read: 1, origins: 1, bytes: 64, truncated: false,
      timed_out: 0, skipped_stuck: 0, budget_exhausted: false, errors: [] };
    // 协商 2 那一轮用的 cookie:非空才能断言 login=injected(采集卡住不该牵连 cookie 这半)
    const COOKIE = { name: "bu_e2e_sid", value: "bu-e2e-1", domain: "127.0.0.1", path: "/",
      secure: false, httpOnly: false };
    let mode = "legacy";
    let silent = false; // 协商 2 下:存储那条永不来(模拟扩展的采集卡在某个标签页上)
    const asked = [];
    bridge = new WebSocket(`ws://127.0.0.1:${bridgePort}/?proto=1`);
    bridge.on("message", (raw) => {
      const m = JSON.parse(raw.toString());
      if (m.type !== "getCookies") return;
      asked.push(m);
      if (mode === "legacy") {
        bridge.send(JSON.stringify({
          type: "cookies", reqId: m.reqId, data: [],
          storage: seedStorage, storageStats: seedStats,
        }));
        return;
      }
      bridge.send(JSON.stringify({ type: "cookies", reqId: m.reqId, data: [COOKIE] }));
      if (!silent) {
        bridge.send(JSON.stringify({ type: "storage", reqId: m.reqId, storage: seedStorage, storageStats: seedStats }));
      }
    });
    await once(bridge, "open");

    const started = await runAsync(["start", "--output-format=json"]);
    let r = {};
    try { r = JSON.parse(started.stdout); } catch { /* 断言在下一行给出 */ }
    stSession = r.session_id ?? null;
    liveBrowser = !!stSession;
    ok("会话启动时向桥要了 Web 存储(wantStorage)",
      asked.some((m) => m.wantStorage === true),
      `asked=${JSON.stringify(asked)} status=${started.status} err=${(started.stderr || "").slice(0, 160)}`);
    ok("start 自报 Web 存储种入(cookie 为空也照常注入)",
      r.web_storage?.injected === true && r.web_storage.origins === 1 && r.web_storage.reported === true,
      `web_storage=${JSON.stringify(r.web_storage)}`);
    if (stSession) {
      await runAsync(["navigate_page", `${BASE}/storage-seed`, "--session", stSession]);
      const snap = await runAsync(["take_snapshot", "--session", stSession]);
      ok("种子先于站点脚本落下(文档开始读到的就是日常浏览器的值)",
        /at-load token=bu-e2e-seed-1 sid=bu-e2e-session-1/.test(snap.stdout),
        (snap.stdout.split("\n").find((l) => l.includes("storage-seed")) ?? snap.stdout).slice(0, 200));
      // 会话内站点自己写的值不得被种子覆盖回去(种子只填缺失的键)
      await runAsync(["navigate_page", `${BASE}/storage-write`, "--session", stSession]);
      await runAsync(["navigate_page", `${BASE}/storage-seed`, "--session", stSession]);
      const snap2 = await runAsync(["take_snapshot", "--session", stSession]);
      ok("种子只填不覆盖:会话内站点写入的值仍在",
        /now token=page-written/.test(snap2.stdout),
        (snap2.stdout.split("\n").find((l) => l.includes("storage-seed")) ?? snap2.stdout).slice(0, 200));
      const stopped = run(["stop", "--session", stSession]);
      ok("web-storage 会话可正常 stop", stopped.stdout.includes("state=cleaned"), stopped.stdout.slice(0, 120));
      stSession = null;
    }

    // ---- 采集卡住时的降级(2026-10-08 现场:一个不回话的标签页曾让整次注入超时) ----
    // 协商 2 的扩展把 cookie 单独先回、存储那条永不来:cookie 必须照常注入,存储如实报 timeout。
    // 这里断言的是人读的那几行(用户看到的就是它),所以不带 --output-format=json。
    mode = "proto2";
    silent = true;
    bridge.send(JSON.stringify({ type: "hello", proto: 1, extVersion: "0.2.1", storageProto: 2 }));
    await new Promise((r) => setTimeout(r, 200)); // 让 daemon 记下协商版本
    const stuckStart = await runAsync(["start"]);
    const stuckSession = (stuckStart.stdout.match(/session=(\S+)/) ?? [])[1] ?? null;
    liveBrowser = liveBrowser || !!stuckSession;
    ok("存储采集卡住:cookie 照常注入(不再退回 login=empty)",
      stuckStart.stdout.includes("login=injected") && !stuckStart.stdout.includes("login=empty"),
      stuckStart.stdout.split("\n").slice(0, 4).join(" | ").slice(0, 220));
    ok("存储采集卡住:存储如实报 timeout(不报成扩展没装/没连)",
      stuckStart.stdout.includes("storage=timeout(") && !stuckStart.stdout.includes("storage=skipped("),
      stuckStart.stdout.split("\n").filter((l) => l.startsWith("storage=")).join(" | ").slice(0, 220));
    if (stuckSession) {
      const stopped2 = run(["stop", "--session", stuckSession]);
      ok("采集卡住那一轮的会话可正常 stop", stopped2.stdout.includes("state=cleaned"), stopped2.stdout.slice(0, 120));
    }
  } finally {
    try { bridge?.close(); } catch { /* */ }
    if (stSession) { try { run(["stop", "--session", stSession], 30000); } catch { /* */ } }
    try {
      const pid = Number(fs.readFileSync(path.join(home, "daemon.pid"), "utf8").trim());
      if (pid) process.kill(pid);
    } catch { /* 未起或已退出 */ }
    if (liveBrowser && fs.existsSync(path.join(home, "profiles"))) {
      const escaped = home.replace(/'/g, "''");
      spawnSync("powershell", ["-NoProfile", "-NonInteractive", "-Command",
        `Get-CimInstance Win32_Process -Filter "Name='msedge.exe'" | Where-Object ` +
        `{ $_.CommandLine -like '*${escaped}*' } | ForEach-Object ` +
        `{ Stop-Process -Id $_.ProcessId -Force -ErrorAction SilentlyContinue }`],
      { stdio: "ignore", windowsHide: true });
    }
    await new Promise((r) => setTimeout(r, 800));
    for (let i = 0; i < 3; i++) {
      try { fs.rmSync(home, { recursive: true, force: true }); break; }
      catch { await new Promise((r) => setTimeout(r, 500)); }
    }
  }
}

// port-only(无 pipe)形态只在异常环境自然出现(浏览器自我重启丢失 fd 3/4),
// 用测试钩子隔离 home + 隔离 daemon 强制降级,回归降级态的通道契约:
// 隔离上下文仍可用(Target 域走浏览器级 ws),PWA 工具按 PIPE_UNAVAILABLE 如实上报。
async function portOnlySection() {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "bu-portonly-home-"));
  const daemonPort = 27985;
  const env = {
    ...process.env, BROWSER_USE_HOME: home, BU_DAEMON_PORT: String(daemonPort),
    BU_DEV_FORCE_PORT_ONLY: "1",
  };
  const run = (args, timeoutMs = 120000) => spawnSync(process.execPath, [CLI, ...args],
    { encoding: "utf8", timeout: timeoutMs, env });
  let poSession = null;
  let liveBrowser = false;
  try {
    // 隔离 home 自带端口段与桥端口:否则两个 daemon 会各自认领同一批端口
    fs.writeFileSync(path.join(home, "config.json"), JSON.stringify({
      port_range: [18450, 18500], daemon_http_port: daemonPort, bridge_ws_port: 17997,
    }));
    const st = run(["status", "--output-format=json"]);
    ok("port-only daemon 起在隔离 home", st.status === 0, (st.stderr || "").slice(0, 160));
    const started = run(["start", "--output-format=json"]);
    let r = {};
    try { r = JSON.parse(started.stdout); } catch { /* 断言在下一行给出 */ }
    poSession = r.session_id ?? null;
    liveBrowser = !!poSession;
    ok("port-only 会话启动并自报降级(pipe_available=false + warning)",
      started.status === 0 && r.pipe_available === false && /port-only/.test(r.warning ?? ""),
      `status=${started.status} pipe_available=${r.pipe_available} warning=${(r.warning ?? "").slice(0, 140)}`);
    if (poSession) {
      const np = run(["new_page", `${BASE}/echo-cookie`, "--isolatedContext=e2e-iso",
        "--session", poSession, "--output-format=json"]);
      let npj = {};
      try { npj = JSON.parse(np.stdout); } catch { /* */ }
      ok("port-only 会话下 new_page --isolatedContext 可用(走浏览器级 ws)",
        np.status === 0 && String(npj.url ?? "").startsWith(`${BASE}/echo-cookie`),
        `status=${np.status} url=${npj.url} err=${(np.stderr || np.stdout).trim().slice(0, 160)}`);
      const ext = run(["list_extensions", "--session", poSession, "--output-format=json"]);
      ok("port-only 会话下 Extensions 工具可用", ext.status === 0,
        `status=${ext.status} err=${(ext.stderr || ext.stdout).trim().slice(0, 160)}`);
      const pwa = run(["launch_pwa", "--manifestId=e2e-nonexistent", "--session", poSession,
        "--output-format=json"]);
      ok("port-only 会话下 PWA 工具报 PIPE_UNAVAILABLE(不谎报 CDP_ERROR)",
        pwa.status === 4 && errorCodeOf(pwa) === "PIPE_UNAVAILABLE",
        `exit=${pwa.status} code=${errorCodeOf(pwa)} err=${(pwa.stderr || pwa.stdout).trim().slice(0, 160)}`);
      const stopped = run(["stop", "--session", poSession]);
      ok("port-only 会话可正常 stop", stopped.stdout.includes("state=cleaned"), stopped.stdout.slice(0, 120));
      poSession = null;
    }
  } finally {
    if (poSession) { try { run(["stop", "--session", poSession], 30000); } catch { /* */ } }
    try {
      const pid = Number(fs.readFileSync(path.join(home, "daemon.pid"), "utf8").trim());
      if (pid) process.kill(pid);   // Windows 上等同强杀:daemon 不会自己收尾
    } catch { /* 未起或已退出 */ }
    if (liveBrowser && fs.existsSync(path.join(home, "profiles"))) {
      // 强杀 daemon 可能留下它自托管的浏览器:按本次 home 路径精确清扫,不碰别人的 Edge
      const escaped = home.replace(/'/g, "''");
      spawnSync("powershell", ["-NoProfile", "-NonInteractive", "-Command",
        `Get-CimInstance Win32_Process -Filter "Name='msedge.exe'" | Where-Object ` +
        `{ $_.CommandLine -like '*${escaped}*' } | ForEach-Object ` +
        `{ Stop-Process -Id $_.ProcessId -Force -ErrorAction SilentlyContinue }`],
      { stdio: "ignore", windowsHide: true });
    }
    await new Promise((r) => setTimeout(r, 800));
    for (let i = 0; i < 3; i++) {
      try { fs.rmSync(home, { recursive: true, force: true }); break; }
      catch { await new Promise((r) => setTimeout(r, 500)); }
    }
  }
}

try {
  await main();
} catch (e) {
  fail++; fails.push(`致命: ${e.message}`);
  console.error("\n致命错误:", e.message);
  if (sessionId) { try { bu(["stop", "--session", sessionId]); } catch { /* */ } }
} finally {
  try { serverProc.kill(); } catch { /* */ }
  try { serverProc2.kill(); } catch { /* */ }
  try { serverProc3.kill(); } catch { /* */ }
  console.log(`\n===== e2e 汇总: pass=${pass} fail=${fail} skip=${skipped} =====`);
  if (fails.length) console.log("失败项:\n  - " + fails.join("\n  - "));
  process.exit(fail > 0 ? 1 : 0);
}
