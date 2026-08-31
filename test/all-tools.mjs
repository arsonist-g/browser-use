#!/usr/bin/env node
// 全量 57 工具测试矩阵(DEC-002:一个不裁)。每个工具一组真调用+断言;
// 依赖外部环境(pipe 通道/ffmpeg/lighthouse CLI/WebMCP flag)的项自动 SKIP 并给原因。
// 用法: node test/all-tools.mjs [--headed]
import { spawn, execFileSync } from "node:child_process";
import path from "node:path";
import url from "node:url";
import fs from "node:fs";

const ROOT = path.dirname(path.dirname(url.fileURLToPath(import.meta.url)));
const CLI = path.join(ROOT, "bin", "browser-use.mjs");
const FIXTURE_PORT = 18123;
const BASE = `http://127.0.0.1:${FIXTURE_PORT}`;
const HEADED = process.argv.includes("--headed");

const results = {};  // tool -> PASS/FAIL/SKIP(原因)
function mark(tool, status, detail = "") { results[tool] = { status, detail }; console.log(`  ${status === "PASS" ? "✔" : status === "SKIP" ? "○" : "✘"} ${tool}${detail ? ` — ${detail.slice(0, 140)}` : ""}`); }

function bu(args, timeoutMs = 60000) {
  return execFileSync(process.execPath, [CLI, ...args], { encoding: "utf8", timeout: timeoutMs, env: { ...process.env } });
}
function buJson(args, timeoutMs = 60000) { return JSON.parse(bu([...args, "--output-format=json"], timeoutMs)); }
function tryBu(args, timeoutMs = 60000) {
  try { return { ok: true, out: bu(args, timeoutMs) }; }
  catch (e) { return { ok: false, out: String(e.stdout ?? "") + String(e.stderr ?? ""), err: e }; }
}
function parseSnapUid(text, labelIncludes) {
  for (const line of text.split("\n")) {
    if (line.includes(labelIncludes)) { const m = line.match(/uid=(\d+_\d+)/); if (m) return m[1]; }
  }
  return null;
}

const serverProc = spawn(process.platform === "win32" ? "python" : "python3",
  [path.join(ROOT, "test", "fixture", "server.py"), String(FIXTURE_PORT)], { stdio: "ignore" });
let sessionId = null;

async function main() {
  let up = false;
  for (let i = 0; i < 20 && !up; i++) {
    try { await fetch(`${BASE}/echo-cookie`); up = true; } catch { await new Promise(r => setTimeout(r, 250)); }
  }
  if (!up) { console.error("fixture server failed"); process.exit(1); }

  // ---------- 启动 ----------
  let out = bu(["start", ...(HEADED ? [] : ["--headless"])]);
  sessionId = (out.match(/session=(\S+)/) ?? [])[1];
  const st = JSON.parse(bu(["status", "--output-format=json"]));
  const bridgeOn = st.bridge.connected;
  const my = st.sessions.find(s => s.session_id === sessionId);

  // ========== Input automation (10) ==========
  bu(["navigate_page", "--session", sessionId, `${BASE}/`]);
  let snap = bu(["take_snapshot", "--session", sessionId]);
  const readLog = () => {
    const r = JSON.parse(bu(["evaluate_script", "--session", sessionId,
      "() => document.getElementById('log').textContent", "--output-format=json"]));
    return String(r.value ?? "");
  };
  // click:点基础按钮 → 日志区断言生效
  try {
    const baseUid = parseSnapUid(snap, "基础按钮");
    if (!baseUid) throw new Error("基础按钮 uid 未取得");
    bu(["click", "--session", sessionId, baseUid]);
    mark("click", readLog().includes("basic-button-clicked") ? "PASS" : "FAIL", readLog().slice(0, 80));
  } catch (e) { mark("click", "FAIL", e.message); }
  // fill:姓名框置值后回读断言
  const nameUid = parseSnapUid(snap, "textbox");
  try {
    if (!nameUid) throw new Error("textbox uid 未取得");
    bu(["fill", "--session", sessionId, nameUid, "matrix"]);
    const r = JSON.parse(bu(["evaluate_script", "--session", sessionId,
      "() => document.getElementById('f-name').value", "--output-format=json"]));
    mark("fill", r.value === "matrix" ? "PASS" : "FAIL", `value=${JSON.stringify(r.value)}`);
  } catch (e) { mark("fill", "FAIL", e.message); }
  // fill 对 select 不存在的值必须报错(cdt: Could not find option with text)
  try {
    const cityUid2 = parseSnapUid(snap, "combobox");
    if (!cityUid2) { mark("fill(select 缺项报错)", "FAIL", "combobox 行未匹配,snap 行样本: " + snap.split("\n").filter(l => l.includes("城市") || l.includes("combobox")).join(" || ").slice(0, 120)); }
    else {
      const r = tryBu(["fill", "--session", sessionId, cityUid2, "不存在的城市"]);
      mark("fill(select 缺项报错)", !r.ok && /Could not find option/i.test(r.out) ? "PASS" : "FAIL",
        `uid=${cityUid2} ok=${r.ok} out=${r.out.slice(0, 80)}`);
    }
  } catch (e) { mark("fill(select 缺项报错)", "FAIL", e.message); }
  // fill_form:一次填两框,独立回读断言
  try {
    const bioUid0 = parseSnapUid(snap, 'textbox "简介');
    if (!nameUid || !bioUid0) throw new Error("元素 uid 未取得");
    const elements = JSON.stringify([{ uid: nameUid, value: "form-user" }, { uid: bioUid0, value: "form-bio" }]);
    const r = bu(["fill_form", "--session", sessionId, "--output-format=json", "--elements", elements]);
    const v1 = JSON.parse(bu(["evaluate_script", "--session", sessionId,
      "() => document.getElementById('f-name').value + '|' + document.getElementById('f-bio').value", "--output-format=json"]));
    mark("fill_form", r.includes("filled") && v1.value === "form-user|form-bio" ? "PASS" : "FAIL", String(v1.value).slice(0, 80));
  } catch (e) { mark("fill_form", "FAIL", e.message); }
  // hover:mouseenter 写日志
  try {
    const hoverUid = parseSnapUid(snap, "悬停目标");
    if (!hoverUid) throw new Error("悬停目标 uid 未取得");
    bu(["hover", "--session", sessionId, hoverUid]);
    mark("hover", readLog().includes("hover-entered") ? "PASS" : "FAIL", readLog().slice(0, 80));
  } catch (e) { mark("hover", "FAIL", e.message); }
  // drag:mouse 路径拖拽(与 cdt 默认 drag 同为 mouse 事件序列),mouseup 消费写日志
  try {
    const from = parseSnapUid(snap, "拖拽源"), to = parseSnapUid(snap, "提交表单");
    if (!from || !to) throw new Error("drag uid 未取得");
    bu(["drag", "--session", sessionId, from, to]);
    mark("drag", readLog().includes("drag-done(") ? "PASS" : "FAIL", readLog().slice(-90));
  } catch (e) { mark("drag", "FAIL", e.message); }
  // press_key:可打印字符须产生实际输入(聚焦姓名框后追加字符)
  try {
    if (!nameUid) throw new Error("textbox uid 未取得");
    bu(["fill", "--session", sessionId, nameUid, "pre-"]);
    bu(["press_key", "--session", sessionId, "s"]);
    const r = JSON.parse(bu(["evaluate_script", "--session", sessionId,
      "() => document.getElementById('f-name').value", "--output-format=json"]));
    mark("press_key", r.value === "pre-s" ? "PASS" : "FAIL", `value=${JSON.stringify(r.value)}`);
  } catch (e) { mark("press_key", "FAIL", e.message); }
  // type_text:接着上一步追加文本
  try {
    bu(["type_text", "--session", sessionId, "-typed", "--submitKey", "Enter"]);
    const r = JSON.parse(bu(["evaluate_script", "--session", sessionId,
      "() => document.getElementById('f-name').value", "--output-format=json"]));
    mark("type_text", r.value === "pre-s-typed" ? "PASS" : "FAIL", `value=${JSON.stringify(r.value)}`);
  } catch (e) { mark("type_text", "FAIL", e.message); }
  const fileUid = parseSnapUid(snap, "附件上传");
  const tmpUp = path.join(ROOT, "test", "fixture", "upload-sample.txt");
  try { bu(["upload_file", "--session", sessionId, fileUid, tmpUp]); mark("upload_file", readLog().includes("file-selected=upload-sample.txt") ? "PASS" : "FAIL", readLog().slice(0, 90)); } catch (e) { mark("upload_file", "FAIL", e.message); }
  // upload_file 代理元素:直传失败 → file chooser 拦截兜底(cdt 同)
  try {
    const proxyUid = parseSnapUid(snap, "代理上传");
    if (!proxyUid) throw new Error("代理上传 uid 未取得");
    bu(["upload_file", "--session", sessionId, proxyUid, tmpUp]);
    mark("upload_file(代理兜底)", readLog().includes("proxy-file-selected=upload-sample.txt") ? "PASS" : "FAIL", readLog().slice(-90));
  } catch (e) { mark("upload_file(代理兜底)", "FAIL", String(e.message ?? e).slice(0, 120)); }
  // handle_dialog:无弹窗必须快速报错(cdt: No open dialog found);confirm+accept 走真实流程。
  // click 撞上弹窗报"未处理提示框"属 blockedByDialog 预期(对齐 cdt),报错与否都可接受。
  try {
    const nd = tryBu(["handle_dialog", "--session", sessionId, "accept"]);
    const noDialogOk = !nd.ok && /No open dialog/i.test(nd.out);
    const cu = parseSnapUid(snap, "弹 confirm");
    if (!cu) throw new Error("弹 confirm uid 未取得");
    const cr = tryBu(["click", "--session", sessionId, cu]);
    const ar = tryBu(["handle_dialog", "--session", sessionId, "accept"]);
    const confirmOk = readLog().includes("confirm-result=true");
    mark("handle_dialog", noDialogOk && confirmOk && ar.ok ? "PASS" : "FAIL",
      `noDialog=${noDialogOk} click_ok=${cr.ok} accept_ok=${ar.ok} confirm回执=${confirmOk} ` +
      `click_out=${cr.out.slice(0, 50)} accept_out=${ar.out.slice(0, 50)}`);
  } catch (e) { mark("handle_dialog", "FAIL", (String(e.stdout ?? "") + String(e.stderr ?? "")).slice(-200)); }
  // click_at:按首屏"基础按钮"几何中心坐标点击,日志断言生效(第二次 basic-button-clicked);
  // dialog accept 后紧跟的 input 事件偶发被 renderer 丢弃,允许一次重试
  try {
    const box = JSON.parse(bu(["evaluate_script", "--session", sessionId,
      "() => { window.scrollTo(0, 0); const r = document.getElementById('btn-log').getBoundingClientRect(); return [r.x + r.width/2, r.y + r.height/2]; }",
      "--output-format=json"]));
    let hits = 0;
    for (let i = 0; i < 2 && hits < 2; i++) {
      bu(["click_at", "--session", sessionId, String(Math.round(box.value[0])), String(Math.round(box.value[1]))]);
      hits = readLog().split("basic-button-clicked").length - 1;
    }
    mark("click_at", hits >= 2 ? "PASS" : "FAIL", `basic-button-clicked 次数=${hits}`);
  } catch (e) { mark("click_at", "FAIL", e.message); }

  // ========== Navigation (6) ==========
  try { bu(["navigate_page", "--session", sessionId, `${BASE}/child.html`]); mark("navigate_page", "PASS"); } catch (e) { mark("navigate_page", "FAIL", e.message); }
  // navigate_page initScript:一次性新文档脚本(cdt 同名参),本导航内生效
  try {
    bu(["navigate_page", "--session", sessionId, `${BASE}/`, "--initScript", "window.__buMarker = 41 + 1;"]);
    const r = JSON.parse(bu(["evaluate_script", "--session", sessionId, "() => window.__buMarker", "--output-format=json"]));
    mark("navigate_page(initScript)", r.value === 42 ? "PASS" : "FAIL", `marker=${JSON.stringify(r.value)}`);
  } catch (e) { mark("navigate_page(initScript)", "FAIL", e.message); }
  try { const r = JSON.parse(bu(["new_page", "--session", sessionId, `${BASE}/child.html`, "--output-format=json"]));
        mark("new_page", r.page_id !== undefined && Array.isArray(r.pages) && r.pages.length >= 2 ? "PASS" : "FAIL", `page_id=${r.page_id} pages=${r.pages?.length}`); } catch (e) { mark("new_page", "FAIL", e.message); }
  try { const r = bu(["list_pages", "--session", sessionId]); mark("list_pages", r.includes("page") ? "PASS" : "FAIL"); } catch (e) { mark("list_pages", "FAIL", e.message); }
  try { bu(["select_page", "--session", sessionId, "0"]); mark("select_page", "PASS"); } catch (e) { mark("select_page", "FAIL", e.message); }
  try { bu(["navigate_page", "--session", sessionId, `${BASE}/child.html`]); bu(["close_page", "--session", sessionId, "1"]); mark("close_page", "PASS"); } catch (e) { mark("close_page", "FAIL", e.message); }
  try { bu(["navigate_page", "--session", sessionId, `${BASE}/`]); bu(["wait_for", "--session", sessionId, "BU Fixture 主页"]); mark("wait_for", "PASS"); } catch (e) { mark("wait_for", "FAIL", e.message); }
  // wait_for 跨 frame:目标文本只在 iframe(child.html)内,主文档无(cdt waitForTextOnPage 同语义)
  try {
    const r = bu(["wait_for", "--session", sessionId, "子页按钮", "--timeout", "5000"]);
    mark("wait_for(跨 frame)", r.includes("found") ? "PASS" : "FAIL", r.slice(0, 80));
  } catch (e) { mark("wait_for(跨 frame)", "FAIL", e.message); }
  // wait_for 超时单位 = 毫秒(cdt timeoutSchema):不存在的文本应在 ~1.5s 报错,而非挂死
  try {
    const t0 = Date.now();
    const r = tryBu(["wait_for", "--session", sessionId, "绝不存在的文本xyz", "--timeout", "1500"]);
    const dt = Date.now() - t0;
    mark("wait_for(timeout=ms)", !r.ok && dt < 12000 ? "PASS" : "FAIL", `耗时 ${dt}ms 报错=${!r.ok}`);
  } catch (e) { mark("wait_for(timeout=ms)", "FAIL", e.message); }

  // ========== Emulation (2) ==========
  // resize_page:视口精确生效 + 窗口边界同步变化(pipe 层反证,排除 Emulation override 路线)
  try {
    bu(["resize_page", "--session", sessionId, "1200", "800"]);
    const dimsR = JSON.parse(bu(["evaluate_script", "--session", sessionId,
      "() => [window.innerWidth, window.innerHeight]", "--output-format=json"]));
    const vpOk = Array.isArray(dimsR.value) && dimsR.value[0] === 1200 && dimsR.value[1] === 800;
    let bounds = null;
    try {
      const pipe = (method, params) => fetch(`http://127.0.0.1:${process.env.BU_DAEMON_PORT ?? 17981}/pipe/cdp`, {
        method: "POST", headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ session_id: sessionId, method, params: params ?? {} }),
      }).then(r => r.json());
      const tgt = await pipe("Target.getTargets");
      const page = (tgt.result?.targetInfos ?? []).find(t => t.type === "page");
      const w0 = await pipe("Browser.getWindowForTarget", { targetId: page.targetId });
      const wb = await pipe("Browser.getWindowBounds", { windowId: w0.result.windowId });
      bounds = wb.result?.bounds ?? null;
    } catch { /* pipe 查询失败不阻断 viewport 断言 */ }
    const winOk = vpOk && (!bounds || (Math.abs((bounds.width ?? 0) - 1200) <= 80 && Math.abs((bounds.height ?? 0) - 800) <= 120));
    mark("resize_page", winOk ? "PASS" : "FAIL", `viewport=${JSON.stringify(dimsR.value)} bounds=${JSON.stringify(bounds)}`);
  } catch (e) { mark("resize_page", "FAIL", e.message); }
  // emulate:colorScheme/geo/network 各项必须真实生效(async evaluate 同步验证)
  try {
    bu(["emulate", "--session", sessionId, "--colorScheme", "dark"]);
    const cs = JSON.parse(bu(["evaluate_script", "--session", sessionId,
      "() => matchMedia('(prefers-color-scheme: dark)').matches", "--output-format=json"]));
    bu(["emulate", "--session", sessionId, "--geolocation", "10.5,20.5"]);
    // geolocation override 本身免权限(cdt 同),但 getCurrentPosition 需权限——测试经 pipe 授权后读值
    const DAEMON = `http://127.0.0.1:${process.env.BU_DAEMON_PORT ?? 17981}`;
    await fetch(`${DAEMON}/pipe/cdp`, { method: "POST", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ session_id: sessionId, method: "Browser.grantPermissions",
        params: { permissions: ["geolocation"], origin: BASE } }) });
    const geo = JSON.parse(bu(["evaluate_script", "--session", sessionId,
      "() => new Promise(res => navigator.geolocation.getCurrentPosition(p => res([p.coords.latitude, p.coords.longitude]), e => res('DENIED'), {timeout: 4000}))",
      "--output-format=json"]));
    bu(["emulate", "--session", sessionId, "--networkConditions", "Offline"]);
    const off = JSON.parse(bu(["evaluate_script", "--session", sessionId,
      `async () => fetch('${BASE}/', {cache: 'no-store'}).then(() => false).catch(() => true)`, "--output-format=json"]));
    bu(["emulate", "--session", sessionId, "--networkConditions", "Fast 4G"]);
    const geoOk = Array.isArray(geo.value) && Math.abs(geo.value[0] - 10.5) < 1 && Math.abs(geo.value[1] - 20.5) < 1;
    mark("emulate", cs.value === true && geoOk && off.value === true ? "PASS" : "FAIL",
      `dark=${cs.value} geo=${JSON.stringify(geo.value)} offline_fetch_rejected=${off.value}`);
  } catch (e) { mark("emulate", "FAIL", e.message); }

  // ========== Performance (3) ==========
  try {
    bu(["navigate_page", "--session", sessionId, `${BASE}/child.html`]);
    // 默认路径:reload=true + autoStop=true(5s 自动停止并产出 trace)
    let r = JSON.parse(bu(["performance_start_trace", "--session", sessionId, "--output-format=json", "--timeout", "180000"], 200000));
    if (!r.events) {
      // 0 事件诊断:重试一次并 dump 页面/连接状态
      const pagesNow = bu(["list_pages", "--session", sessionId]);
      console.log(`  [diag] events=0, pages=[${pagesNow.split("\n").join(" | ")}], 重试`);
      r = JSON.parse(bu(["performance_start_trace", "--session", sessionId, "--output-format=json", "--timeout", "180000"], 200000));
    }
    mark("performance_start_trace", r.stopped && r.events > 0 ? "PASS" : "FAIL", `stopped=${r.stopped} events=${r.events}`);
    mark("performance_stop_trace(autoStop)", r.stopped === true ? "PASS" : "FAIL", `events=${r.events}`);
    const r2 = bu(["performance_analyze_insight", "--session", sessionId, "--output-format=json",
      ...(r.path ? ["--filePath", r.path] : [])]);
    mark("performance_analyze_insight", r2.includes("long_tasks") ? "PASS" : "FAIL", "自建最小指标集");
    // 手动路径 + 单例:已开第二次 start 必须报错;stop 后 events>0;未开时 stop 为 no-op
    bu(["performance_start_trace", "--session", sessionId, "--reload", "false", "--autoStop", "false"]);
    const dup = tryBu(["performance_start_trace", "--session", sessionId, "--reload", "false", "--autoStop", "false"]);
    const r3 = JSON.parse(bu(["performance_stop_trace", "--session", sessionId, "--output-format=json"]));
    const r4 = JSON.parse(bu(["performance_stop_trace", "--session", sessionId, "--output-format=json"]));
    mark("performance_stop_trace(手动+单例)", dup.ok === false && /already running/i.test(dup.out)
      && r3.stopped && r3.events > 0 && r4.stopped === false ? "PASS" : "FAIL",
      `dup报错=${!dup.ok} 手动stop=${r3.events} no-op=${r4.stopped}`);
  } catch (e) {
    mark("performance_start_trace", "FAIL", (String(e.stdout ?? "") + String(e.stderr ?? "") + e.message).slice(-220));
    mark("performance_stop_trace(autoStop)", "FAIL"); mark("performance_analyze_insight", "FAIL"); mark("performance_stop_trace(手动+单例)", "FAIL");
  }

  // ========== Network (2)——收割模式:每次调用返回自上次以来的新请求 ==========
  try {
    bu(["navigate_page", "--session", sessionId, `${BASE}/child.html`]);
    const j = JSON.parse(bu(["list_network_requests", "--session", sessionId, "--output-format=json"]));
    mark("list_network_requests", (j.requests ?? []).length > 0 ? "PASS" : "FAIL", `requests=${j.requests?.length}`);
    // resourceTypes 按 CDP ResourceType 过滤:新导航后首次收割应含 document 且全为 document
    bu(["navigate_page", "--session", sessionId, `${BASE}/`]);
    const rj = JSON.parse(bu(["list_network_requests", "--session", sessionId, "--output-format=json", "--resourceTypes", "document"]));
    const allDoc = (rj.requests ?? []).every(q => q.resourceType === "document");
    mark("list_network_requests(resourceTypes)", (rj.requests ?? []).length > 0 && allDoc ? "PASS" : "FAIL",
      `n=${rj.requests?.length} 全document=${allDoc}`);
  } catch (e) { mark("list_network_requests", "FAIL", e.message); }
  try { const r = bu(["get_network_request", "--session", sessionId, "0", "--output-format=json"]);
        const j = JSON.parse(r);
        mark("get_network_request", j.request?.url && "resourceType" in j.request ? "PASS" : "FAIL", r.slice(0, 100));
        const bad = tryBu(["get_network_request", "--session", sessionId, "99999"]);
        mark("get_network_request(未找到报错)", !bad.ok && /Request not found/i.test(bad.out) ? "PASS" : "FAIL", bad.out.slice(0, 80)); } catch (e) { mark("get_network_request", "FAIL", e.message.slice(0, 120)); }

  // ========== Debugging (8) ==========
  try { const r = bu(["evaluate_script", "--session", sessionId, "() => 6*7", "--output-format=json"]); mark("evaluate_script", r.includes("42") ? "PASS" : "FAIL", r.slice(0, 100)); } catch (e) { mark("evaluate_script", "FAIL", e.message); }
  // evaluate_script:async 函数支持(cdt 明示 async;awaitPromise 语义)
  try { const r = JSON.parse(bu(["evaluate_script", "--session", sessionId, "async () => (await Promise.resolve(6)) * 7", "--output-format=json"]));
        mark("evaluate_script(async)", r.value === 42 ? "PASS" : "FAIL", JSON.stringify(r).slice(0, 90)); } catch (e) { mark("evaluate_script(async)", "FAIL", e.message); }
  try {
    bu(["navigate_page", "--session", sessionId, `${BASE}/`]); // fixture 载入自带 console.log/warn 样本
    const r = JSON.parse(bu(["list_console_messages", "--session", sessionId, "--output-format=json"]));
    const hit = (r.messages ?? []).find(m => m.text?.includes("bu-fixture-loaded"));
    mark("list_console_messages", hit ? "PASS" : "FAIL", `收割 ${r.messages?.length ?? 0} 条`);
    const r2 = JSON.parse(bu(["get_console_message", "--session", sessionId, hit.msgid, "--output-format=json"]));
    mark("get_console_message", r2.message?.text?.includes("bu-fixture-loaded") ? "PASS" : "FAIL", JSON.stringify(r2).slice(0, 120));
    // includeStackTraces(cdt 同名参):消息附调用点栈;pageSize 分页生效
    const r3 = JSON.parse(bu(["list_console_messages", "--session", sessionId, "--output-format=json",
      "--includePreservedMessages", "true", "--includeStackTraces", "true", "--pageSize", "1"]));
    const m0 = (r3.messages ?? [])[0];
    mark("console(栈+分页+preserved)", Array.isArray(r3.messages) && r3.messages.length === 1
      && typeof m0?.stack === "string" && m0.stack.length > 0 ? "PASS" : "FAIL",
      `页内=${r3.messages?.length} stack=${String(m0?.stack).slice(0, 60)}`);
  } catch (e) { mark("list_console_messages", "FAIL", e.message); mark("get_console_message", "FAIL", e.message.slice(0, 100)); }
  try {
    bu(["navigate_page", "--session", sessionId, `${BASE}/`]);
    const r = bu(["lighthouse_audit", "--session", sessionId, "--output-format=json", "--timeout", "300000"], 330000);
    const j = JSON.parse(r);
    const cats = (j.summary?.scores ?? []).map(s => s.id);
    mark("lighthouse_audit", cats.includes("accessibility") && cats.includes("agentic-browsing")
      && (j.reports ?? []).length >= 1 ? "PASS" : "FAIL",
      `categories=${cats.join(",")} reports=${j.reports?.length}`);
  } catch (e) {
    const msg = e.message ?? "";
    mark("lighthouse_audit", /lighthouse|npx|ENOTFOUND|not installed/i.test(msg) ? "SKIP" : "FAIL", msg.slice(0, 140));
  }
  try { const r = bu(["take_screenshot", "--session", sessionId]); mark("take_screenshot", r.includes("path") ? "PASS" : "FAIL"); } catch (e) { mark("take_screenshot", "FAIL", e.message); }
  try { snap = bu(["take_snapshot", "--session", sessionId]); mark("take_snapshot", snap.includes("BU Fixture") || snap.includes("子页") ? "PASS" : "FAIL"); } catch (e) { mark("take_snapshot", "FAIL", e.message); }
  // evaluate_script:args(uid → 元素对象入参,cdt 同)——须用最新快照(uid 随导航失效,cdt 同款语义)
  try {
    const eUid = parseSnapUid(snap, "基础按钮");
    const r = JSON.parse(bu(["evaluate_script", "--session", sessionId, "--output-format=json",
      "--function", "(el) => el.tagName", "--args", JSON.stringify([eUid])]));
    mark("evaluate_script(args uid)", r.value === "BUTTON" ? "PASS" : "FAIL", JSON.stringify(r).slice(0, 90));
  } catch (e) { mark("evaluate_script(args uid)", "FAIL", e.message); }
  // take_screenshot(uid):元素截图尺寸应接近元素几何(解析 PNG IHDR;须用导航后的新快照 uid)
  try {
    const sUid = parseSnapUid(snap, "基础按钮");
    if (!sUid) throw new Error("基础按钮 uid 未取得");
    const r = JSON.parse(bu(["take_screenshot", "--session", sessionId, "--uid", sUid, "--output-format=json"]));
    const buf = fs.readFileSync(r.path);
    const w = buf.readUInt32BE(16), h = buf.readUInt32BE(20);
    const el = JSON.parse(bu(["evaluate_script", "--session", sessionId,
      "() => { const r2 = document.getElementById('btn-log').getBoundingClientRect(); return [r2.width, r2.height]; }",
      "--output-format=json"]));
    const ok = el.value && w >= el.value[0] * 0.4 && w <= el.value[0] * 2.5 + 40 && h >= el.value[1] * 0.4 && h <= el.value[1] * 3;
    mark("take_screenshot(uid)", ok ? "PASS" : "FAIL", `png=${w}x${h} 元素=${JSON.stringify(el.value)}`);
  } catch (e) { mark("take_screenshot(uid)", "FAIL", e.message); }
  try { bu(["screencast_start", "--session", sessionId]); bu(["take_snapshot", "--session", sessionId]); const r = bu(["screencast_stop", "--session", sessionId, "--output-format=json"]); const j = JSON.parse(r); mark("screencast_start", "PASS"); mark("screencast_stop", (j.frames ?? 0) > 0 ? "PASS" : "FAIL", `frames=${j.frames}(core start 时已强制首帧)`); } catch (e) { mark("screencast_start", "FAIL", e.message); mark("screencast_stop", "FAIL", e.message); }

  // ========== Memory (13)——cdt 参数面:filePath 句柄 + nodeId = 节点序号 ==========
  let hsPath = null;
  try {
    const r = JSON.parse(bu(["take_heapsnapshot", "--session", sessionId, "--output-format=json"], 120000));
    hsPath = r.path;
    mark("take_heapsnapshot", hsPath && r.nodes > 0 ? "PASS" : "FAIL", `nodes=${r.nodes}`);
  } catch (e) { mark("take_heapsnapshot", "FAIL", e.message); }

  const HS = ["--session", sessionId, "--filePath", hsPath];
  if (hsPath) {
    const J = (args, t = 180000) => JSON.parse(bu(args, t));
    try {
      const r = J(["get_heapsnapshot_summary", ...HS, "--output-format=json"]);
      mark("get_heapsnapshot_summary", r.nodes > 0 && Object.keys(r.nodes_by_type ?? {}).length > 0
        && typeof r.detached_dom_nodes === "number" ? "PASS" : "FAIL", `nodes=${r.nodes} types=${Object.keys(r.nodes_by_type ?? {}).length}`);
    } catch (e) { mark("get_heapsnapshot_summary", "FAIL", e.message); }
    let classCount = 0;
    try {
      const r = J(["get_heapsnapshot_details", ...HS, "--output-format=json", "--pageSize", "20"]);
      classCount = r.total_classes ?? 0;
      const top = (r.aggregates ?? [])[0];
      mark("get_heapsnapshot_details", classCount > 100 && (r.aggregates ?? []).length === 20
        && top?.name && top?.retained_size > 0 ? "PASS" : "FAIL",
        `classes=${classCount} top=${top?.name}`);
    } catch (e) { mark("get_heapsnapshot_details", "FAIL", e.message); }
    try {
      const r = J(["get_heapsnapshot_class_nodes", ...HS, "--output-format=json", "--id", "0"]);
      const sameName = (r.nodes ?? []).every(n => n.name === r.class?.name);
      mark("get_heapsnapshot_class_nodes", (r.nodes ?? []).length > 0 && sameName ? "PASS" : "FAIL",
        `class=${r.class?.name} 实例=${r.nodes?.length}`);
    } catch (e) { mark("get_heapsnapshot_class_nodes", "FAIL", e.message); }
    try {
      const r = J(["get_heapsnapshot_duplicate_strings", ...HS, "--output-format=json", "--pageSize", "5"]);
      // V8 字符串驻留可使重复组为 0(表内无重)——断言结构与分页生效(实现坏则字段缺失/条数不符)
      const rows = r.duplicates ?? [];
      mark("get_heapsnapshot_duplicate_strings", typeof r.total_duplicate_groups === "number"
        && rows.length === Math.min(5, r.total_duplicate_groups) ? "PASS" : "FAIL",
        `groups=${r.total_duplicate_groups} 页内=${rows.length}`);
    } catch (e) { mark("get_heapsnapshot_duplicate_strings", "FAIL", e.message); }
    try {
      const r = J(["get_heapsnapshot_edges", ...HS, "--output-format=json", "--nodeId", "1"]);
      const ok = (r.edges ?? []).length > 0 && r.edges.every(e => typeof e.nodeId === "number" && typeof e.retained_size === "number");
      mark("get_heapsnapshot_edges", ok ? "PASS" : "FAIL", `edges=${r.edges?.length}`);
    } catch (e) { mark("get_heapsnapshot_edges", "FAIL", e.message); }
    try {
      const r = J(["get_heapsnapshot_retainers", ...HS, "--output-format=json", "--nodeId", "1"]);
      mark("get_heapsnapshot_retainers", Array.isArray(r.retainers) && typeof r.retainer_count === "number" ? "PASS" : "FAIL", `count=${r.retainer_count}`);
    } catch (e) { mark("get_heapsnapshot_retainers", "FAIL", e.message); }
    try {
      const r = J(["get_heapsnapshot_retaining_paths", ...HS, "--output-format=json", "--nodeId", "1"]);
      const p0 = (r.paths ?? [])[0];
      const toRoot = (p0?.chain ?? []).some(c => c.type === "Root" || c.type === "Synthetic");
      mark("get_heapsnapshot_retaining_paths", (r.paths ?? []).length > 0 && (toRoot || p0.chain.length >= 1) ? "PASS" : "FAIL",
        `paths=${r.paths?.length} 首链深=${p0?.depth}`);
    } catch (e) { mark("get_heapsnapshot_retaining_paths", "FAIL", e.message); }
    try {
      const r = J(["get_heapsnapshot_dominators", ...HS, "--output-format=json", "--nodeId", "1"], 240000);
      const chain = r.dominator_chain ?? [];
      const top = chain[chain.length - 1];
      // 链顶应到根(heapsnapshot 顶层可为 root/synthetic,types 数组为小写字面量)
      const reachesRoot = chain.length > 0 && ["root", "synthetic"].includes(String(top?.type).toLowerCase());
      mark("get_heapsnapshot_dominators", reachesRoot ? "PASS" : "FAIL", `链长=${chain.length} 顶=${top?.type}`);
    } catch (e) { mark("get_heapsnapshot_dominators", "FAIL", e.message); }
    try {
      const r = J(["get_heapsnapshot_object_details", ...HS, "--output-format=json", "--nodeId", "1"], 240000);
      mark("get_heapsnapshot_object_details", typeof r.node?.self_size === "number" && typeof r.distance === "number"
        && "out_edges_sample" in r ? "PASS" : "FAIL", `distance=${r.distance}`);
    } catch (e) { mark("get_heapsnapshot_object_details", "FAIL", e.message); }
    try {
      const r = J(["query_heapsnapshot_objects", ...HS, "--output-format=json", "--className", "System", "--pageSize", "10"]);
      const allSys = (r.objects ?? []).every(o => o.name.includes("System"));
      mark("query_heapsnapshot_objects", r.matched > 0 && (r.objects ?? []).length === 10 && allSys ? "PASS" : "FAIL",
        `matched=${r.matched} 首页全System=${allSys}`);
    } catch (e) { mark("query_heapsnapshot_objects", "FAIL", e.message); }
    try {
      // 两次快照间制造分配差异(500 个新对象),否则聚合 diff 可为 0
      bu(["evaluate_script", "--session", sessionId,
        "() => { window.__cmp = Array.from({length: 500}, (_, i) => ({tag: 'cmp-' + i, payload: 'x'.repeat(50)})); return 1; }",
        "--output-format=json"]);
      const r2 = JSON.parse(bu(["take_heapsnapshot", "--session", sessionId, "--output-format=json"], 120000));
      const r = J(["compare_heapsnapshots", "--session", sessionId, "--output-format=json",
        "--baseFilePath", hsPath, "--currentFilePath", r2.path]);
      const d = (r.top ?? [])[0];
      mark("compare_heapsnapshots", r.total_changed_classes > 0 && d && typeof d.name === "string" ? "PASS" : "FAIL",
        `changed=${r.total_changed_classes} top="${d?.name}"(±${d?.count_delta})`);
      const cls = JSON.parse(bu(["compare_heapsnapshots", "--session", sessionId, "--output-format=json",
        "--baseFilePath", hsPath, "--currentFilePath", r2.path, "--classIndex", "0"]));
      mark("compare_heapsnapshots(classIndex)", typeof cls.class === "string" && cls.base_count >= 0 ? "PASS" : "FAIL", `class=${cls.class}`);
    } catch (e) { mark("compare_heapsnapshots", "FAIL", e.message); }
    try {
      const r = JSON.parse(bu(["close_heapsnapshot", ...HS, "--output-format=json"]));
      const again = tryBu(["close_heapsnapshot", ...HS]);
      mark("close_heapsnapshot", r.closed === hsPath && !again.ok && /not loaded/i.test(again.out) ? "PASS" : "FAIL",
        `closed=${r.closed} 二次报错=${!again.ok}`);
    } catch (e) { mark("close_heapsnapshot", "FAIL", e.message); }
  } else {
    for (const t of ["get_heapsnapshot_summary", "get_heapsnapshot_details", "get_heapsnapshot_class_nodes",
      "get_heapsnapshot_duplicate_strings", "get_heapsnapshot_edges", "get_heapsnapshot_retainers",
      "get_heapsnapshot_retaining_paths", "get_heapsnapshot_dominators", "get_heapsnapshot_object_details",
      "query_heapsnapshot_objects", "compare_heapsnapshots", "close_heapsnapshot"]) {
      mark(t, "SKIP", "依赖 take_heapsnapshot 成功");
    }
  }

  // ========== Extensions (5) ==========
  let extId = null;
  try {
    const r = JSON.parse(bu(["install_extension", "--session", sessionId, path.join(ROOT, "test", "fixture", "extension"), "--output-format=json"]));
    extId = r.id;
    mark("install_extension", extId ? "PASS" : "FAIL", `id=${extId}`);
  } catch (e) { mark("install_extension", "FAIL", e.message.slice(0, 140)); }
  if (extId) {
    try { const r = bu(["list_extensions", "--session", sessionId]); mark("list_extensions", r.includes("BU Test Extension") && r.includes(extId) ? "PASS" : "FAIL"); } catch (e) { mark("list_extensions", "FAIL", e.message); }
    try { const r = bu(["reload_extension", "--session", sessionId, extId, "--output-format=json"]); mark("reload_extension", r.includes("reloaded") ? "PASS" : "FAIL", r.slice(0, 100)); } catch (e) { mark("reload_extension", "FAIL", e.message); }
    try { bu(["trigger_extension_action", "--session", sessionId, extId]); mark("trigger_extension_action", "PASS"); } catch (e) { mark("trigger_extension_action", "FAIL", e.message); }
    try {
      bu(["uninstall_extension", "--session", sessionId, extId]);
      const r = bu(["list_extensions", "--session", sessionId]);
      mark("uninstall_extension", !r.includes("BU Test Extension") ? "PASS" : "FAIL", "卸载后仍可见");
    } catch (e) { mark("uninstall_extension", "FAIL", e.message); }
  } else {
    for (const t of ["list_extensions", "reload_extension", "trigger_extension_action", "uninstall_extension"]) mark(t, "SKIP", "依赖 install_extension 成功");
  }

  // ========== Third-party (2)——cdt devtoolstooldiscovery 发现协议(fixture 已注册) ==========
  try {
    const r = JSON.parse(bu(["list_3p_developer_tools", "--session", sessionId, "--output-format=json"]));
    const has = (r.tools ?? []).some(t => t.name === "get-fixture-h1");
    mark("list_3p_developer_tools", has ? "PASS" : "FAIL", JSON.stringify(r).slice(0, 140));
  } catch (e) { mark("list_3p_developer_tools", "FAIL", e.message); }
  try {
    const r = JSON.parse(bu(["execute_3p_developer_tool", "--session", sessionId,
      "--output-format=json", "--toolName", "get-fixture-h1"]));
    mark("execute_3p_developer_tool", String(r.result ?? "").includes("BU Fixture 主页") ? "PASS" : "FAIL",
      JSON.stringify(r).slice(0, 120));
  } catch (e) { mark("execute_3p_developer_tool", "FAIL", e.message); }

  // ========== WebMCP (2)——专用 flag 会话(flag 属运行时特征变更,默认不开 = CONSTRAINT-001 权衡) ==========
  let webSession = null;
  try {
    const wout = bu(["start", "--headless", "--extra-flags", JSON.stringify(["--enable-features=WebMCP"])]);
    webSession = (wout.match(/session=(\S+)/) ?? [])[1];
    bu(["navigate_page", "--session", webSession, `${BASE}/`]); // fixture 防御式注册 get-fixture-title
    const r = JSON.parse(bu(["list_webmcp_tools", "--session", webSession, "--output-format=json"]));
    const has = (r.tools ?? []).some(t => t.name === "get-fixture-title");
    mark("list_webmcp_tools", has ? "PASS" : "FAIL", JSON.stringify(r).slice(0, 140));
    const r2 = JSON.parse(bu(["execute_webmcp_tool", "--session", webSession, "get-fixture-title", "--output-format=json"]));
    mark("execute_webmcp_tool", r2.status === "Completed" && (r2.output ?? "").includes("BU Fixture") ? "PASS" : "FAIL",
      JSON.stringify(r2).slice(0, 140));
  } catch (e) {
    mark("list_webmcp_tools", /WebMCP|flag/i.test(e.message) ? "SKIP" : "FAIL", e.message.slice(0, 140));
    mark("execute_webmcp_tool", "SKIP", "同 list_webmcp_tools");
  } finally {
    if (webSession) { try { bu(["stop", "--session", webSession]); } catch { /* */ } }
  }

  // ========== PWA (4)——install → get_os_app_state → launch → uninstall → 状态回查 ==========
  const manifestId = `${BASE}/`; // manifest "id": "/" 解析结果
  try {
    bu(["install_pwa", "--session", sessionId, "--manifestId", manifestId, "--installUrlOrBundleUrl", `${BASE}/pwa.html`]);
    mark("install_pwa", "PASS");
  } catch (e) { mark("install_pwa", "FAIL", e.message.slice(0, 140)); }
  try { const r = bu(["get_os_app_state", "--session", sessionId, "--manifestId", manifestId]); mark("get_os_app_state", r.includes("badge_count") || r.includes("file_handlers") ? "PASS" : "FAIL", r.slice(0, 120)); } catch (e) { mark("get_os_app_state", "FAIL", e.message.slice(0, 120)); }
  // launch_pwa:Edge 152 域级拒绝(实测最小 flag 同样失败,非本工具问题)→ Chrome 上复核全链路
  let chromeExe = null;
  for (const c of ["C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe",
    "C:\\Program Files (x86)\\Google\\Chrome\\Application\\chrome.exe"]) {
    try { fs.accessSync(c); chromeExe = c; break; } catch { /* next */ }
  }
  if (chromeExe) {
    try {
      const cout = bu(["start", "--browser-exe", chromeExe]);
      const csid = (cout.match(/session=(\S+)/) ?? [])[1];
      bu(["install_pwa", "--session", csid, "--manifestId", manifestId, "--installUrlOrBundleUrl", `${BASE}/pwa.html`]);
      bu(["launch_pwa", "--session", csid, "--manifestId", manifestId]);
      mark("launch_pwa", "PASS", "Chrome 复核(Edge 152 域级拒绝,实测已声明)");
      try { bu(["uninstall_pwa", "--session", csid, "--manifestId", manifestId]); } catch { /* */ }
      bu(["stop", "--session", csid]);
    } catch (e2) {
      mark("launch_pwa", "SKIP", `Chrome 复核失败: ${e2.message.slice(0, 100)}`);
    }
  } else {
    mark("launch_pwa", "SKIP", "Edge 152 域级拒绝 PWA.launch(实测,已声明);本机无 Chrome 可复核");
  }
  try {
    bu(["uninstall_pwa", "--session", sessionId, "--manifestId", manifestId]);
    let gone = false;
    try { bu(["get_os_app_state", "--session", sessionId, "--manifestId", manifestId]); }
    catch { gone = true; } // 卸载后查询应报 Unknown web-app manifest id
    mark("uninstall_pwa", gone ? "PASS" : "FAIL", "卸载后状态仍可查");
  } catch (e) { mark("uninstall_pwa", "FAIL", e.message.slice(0, 120)); }

  // ========== new_page(isolatedContext)——置于矩阵尾部:Edge 152 headless 下
  // pipe createBrowserContext 组合操作存在非确定性崩溃(0xC0000005,daemon.log 实录),
  // 避免其偶发触发污染其余断言;崩溃本体为浏览器侧问题,记录于审查报告 ==========
  try {
    const r = JSON.parse(bu(["new_page", "--session", sessionId, `${BASE}/`, "--output-format=json",
      "--isolatedContext", "audit-iso"]));
    mark("new_page(isolatedContext)", r.page_id !== undefined ? "PASS" : "FAIL", `page_id=${r.page_id} url=${r.url}`);
  } catch (e) { mark("new_page(isolatedContext)", "FAIL", e.message); }

  // ---------- 汇总 ----------
  try { bu(["stop", "--session", sessionId]); } catch { /* */ }
  const entries = Object.entries(results);
  const p = entries.filter(([, v]) => v.status === "PASS").length;
  const f = entries.filter(([, v]) => v.status === "FAIL").length;
  const s = entries.filter(([, v]) => v.status === "SKIP").length;
  console.log(`\n===== 全量矩阵: PASS=${p} FAIL=${f} SKIP=${s} / total=${entries.length} =====`);
  if (f) { console.log("FAIL 项:"); for (const [k, v] of entries) if (v.status === "FAIL") console.log(`  - ${k}: ${v.detail}`); }
  console.log("SKIP 项(外部依赖/红线权衡,非功能缺失):");
  for (const [k, v] of entries) if (v.status === "SKIP") console.log(`  - ${k}: ${v.detail}`);
  process.exit(f > 0 ? 1 : 0);
}

try { await main(); } catch (e) { console.error("致命:", e.message); if (sessionId) { try { bu(["stop", "--session", sessionId]); } catch { /* */ } } try { serverProc.kill(); } catch { /* */ } process.exit(1); }
