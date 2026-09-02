#!/usr/bin/env node
// Browser-Use e2e 回归测试:驱动真实 CLI,对本地 fixture 页验证 P0 工具面全能力。
// 用法: node test/e2e.mjs [--headed](默认 headless)
// 前置: 桥扩展已装且日常浏览器打开(login 断言在桥离线时自动 SKIP)
// 退出码: 0 = 全过;1 = 有 fail(fail 明细列在汇总)
import { spawn, execFileSync } from "node:child_process";
import path from "node:path";
import os from "node:os";
import url from "node:url";
import fs from "node:fs";

const ROOT = path.dirname(path.dirname(url.fileURLToPath(import.meta.url)));
const CLI = path.join(ROOT, "bin", "browser-use.mjs");
const FIXTURE_PORT = 18123;
const BASE = `http://127.0.0.1:${FIXTURE_PORT}`;
const HEADED = process.argv.includes("--headed");

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

function parseSnapUid(text, labelIncludes) {
  for (const line of text.split("\n")) {
    if (line.includes(labelIncludes)) {
      const m = line.match(/uid=(\d+_\d+)/);
      if (m) return m[1];
    }
  }
  return null;
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
  let out = bu(["start", "--headless"]);
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
  bu(["click", "--session", sessionId, rebuildUid]);
  snap = bu(["take_snapshot", "--session", sessionId]);
  ok("重建后新内容可见(rebuilt-0)", snap.includes("rebuilt-0"));
  ok("重建后 log 记录", snap.includes("list-rebuilt"));

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

  // ---- 12. stop(完整删除口径:session 目录 + profile 一律不留) ----
  console.log("\n[12] 收尾");
  out = bu(["stop", "--session", sessionId]);
  ok("stop → cleaned", out.includes("state=cleaned"), out.slice(0, 120));
  const buHome = process.env.BROWSER_USE_HOME ?? path.join(os.homedir(), ".browser-use");
  ok("stop 后 session 目录已删", !fs.existsSync(path.join(buHome, "sessions", sessionId)),
     "会话产物清理不完整——sessions/<id> 仍存在");
  ok("stop 后 profile 目录已删", !fs.existsSync(path.join(buHome, "profiles", sessionId)),
     "profile 仍存在");
  const listed = bu(["sessions", "list", "--output-format=json"]);
  ok("session list 不含已 stop 会话", !listed.includes(sessionId));
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
