#!/usr/bin/env node
// 真实场景测试集:对工具逐一锚定真实页面行为(持续请求、下载、大响应体、慢导航、
// SPA/beforeunload、真实公网),重点覆盖"参数面对齐但逻辑会挂"的路径。
// 断言全部落在可观察结果:请求的具体 URL/resourceType/status、body 长度、落盘文件尺寸、
// 调用耗时上限——不是"调用成功"。
// 用法: node test/real-world.mjs [--headed](默认 headless)
// 外部网络用例(RW11/RW12)失败按 SKIP 记(外部依赖),不掩盖真实缺陷。
import { spawn, execFileSync } from "node:child_process";
import path from "node:path";
import fs from "node:fs";
import os from "node:os";
import url from "node:url";

const ROOT = path.dirname(path.dirname(url.fileURLToPath(import.meta.url)));
const CLI = path.join(ROOT, "bin", "browser-use.mjs");
const FIXTURE_PORT = 18124;
const BASE = `http://127.0.0.1:${FIXTURE_PORT}`;
const HEADED = process.argv.includes("--headed");
const ART = fs.mkdtempSync(path.join(os.tmpdir(), "bu-rw-"));

let pass = 0, fail = 0, skipped = 0;
const fails = [];
function ok(name, cond, detail = "") {
  if (cond) { pass++; console.log(`  ✔ ${name}${detail ? ` — ${detail}` : ""}`); }
  else { fail++; fails.push(name); console.log(`  ✘ ${name}${detail ? ` — ${detail}` : ""}`); }
}
function skip(name, reason) { skipped++; console.log(`  ○ SKIP ${name} — ${reason}`); }
function bu(args, timeoutMs = 60000) {
  return execFileSync(process.execPath, [CLI, ...args], { encoding: "utf8", timeout: timeoutMs });
}
function buJson(args, timeoutMs = 60000) {
  return JSON.parse(bu([...args, "--output-format=json"], timeoutMs));
}
/** 计时执行:返回 {ms, result, err}(err=CORE_TIMEOUT 等错误码)。
 * 注意先求 result 再算耗时——对象字面量按属性顺序求值,ms 写前面会记成调用前瞬间。 */
function timedBu(args, timeoutMs = 60000) {
  const t0 = Date.now();
  try {
    const result = buJson(args, timeoutMs);
    return { ms: Date.now() - t0, result, err: null };
  } catch (e) {
    const core = /CORE_TIMEOUT/.test(String(e.stdout ?? "")) ? "CORE_TIMEOUT" : null;
    return { ms: Date.now() - t0, result: null, err: core ?? e.message.slice(0, 80) };
  }
}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const serverProc = spawn(process.platform === "win32" ? "python" : "python3",
  [path.join(ROOT, "test", "fixture", "server.py"), String(FIXTURE_PORT)],
  { stdio: "ignore", windowsHide: true });
let sessionId = null;

async function main() {
  let up = false;
  for (let i = 0; i < 20 && !up; i++) {
    try { await fetch(`${BASE}/tick`); up = true; } catch { await new Promise(r => setTimeout(r, 250)); }
  }
  console.log(`fixture server: ${up ? "up" : "FAILED"}`);
  if (!up) { console.log(`fail: 1`); process.exit(1); }
  try {
  console.log("\n[RW] 会话启动");
  const out = bu(["start", ...(HEADED ? [] : ["--headless"])]);
  sessionId = (out.match(/session=(\S+)/) ?? [])[1];
  ok("RW0 start", !!sessionId, out.slice(0, 80));

  // ---- RW1 持续请求页:list_network_requests 收割必须有界 ----
  // 真实场景:现代页面常态(统计心跳/预加载/SSE)。修复前 steps 每收一包重置 0.5s
  // 窗口 → 300ms 心跳令收割永不退出 → CORE_TIMEOUT。
  console.log("\n[RW1] 持续请求页收割(list_network_requests)");
  bu(["navigate_page", "--session", sessionId, "--url", `${BASE}/chatty`]);
  await sleep(1500); // 心跳跑起来
  const rw1 = timedBu(["list_network_requests", "--session", sessionId], 30000);
  const tickReqs = rw1.result?.requests?.filter((r) => r.url.includes("/tick")) ?? [];
  ok("RW1 收割有界返回", rw1.err === null && rw1.ms < 3000, `${rw1.ms}ms err=${rw1.err}`);
  ok("RW1 抓到持续请求(fetch)", tickReqs.length > 0 && tickReqs[0].resourceType === "fetch",
    `tick 请求 ${tickReqs.length} 条`);

  // ---- RW2 连续收割不瘫:core 单线程被收割卡死后会话全瘫(用户实测的"反复重试全挂")----
  console.log("\n[RW2] 连续收割不瘫");
  let rw2ok = true, rw2detail = [];
  for (let i = 0; i < 3; i++) {
    const r = timedBu(["list_network_requests", "--session", sessionId], 30000);
    rw2detail.push(`${r.ms}ms${r.err ? "!" + r.err : ""}`);
    if (r.err !== null || r.ms >= 3000) rw2ok = false;
    await sleep(300);
  }
  ok("RW2 三连收割全部快速返回", rw2ok, rw2detail.join(", "));

  // ---- RW3 下载直链:navigate 触发下载 → 抓到下载请求 + 详情 ----
  console.log("\n[RW3] 下载直链抓取");
  bu(["navigate_page", "--session", sessionId, "--url", `${BASE}/static`]);
  const nav3 = buJson(["navigate_page", "--session", sessionId, "--url", `${BASE}/download`]);
  const lst3 = buJson(["list_network_requests", "--session", sessionId]);
  const dl3 = lst3.requests.find((r) => r.url.includes("/download"));
  ok("RW3 下载请求被抓到", !!dl3 && dl3.resourceType === "document",
    dl3 ? `reqid=${dl3.reqid} type=${dl3.resourceType} status=${dl3.status}` : "未捕获");
  if (dl3) {
    const det3 = buJson(["get_network_request", "--session", sessionId, dl3.reqid]);
    // content-disposition 锚:证明捕获的就是这条下载请求且响应元数据收割完整
    const cd = Object.entries(det3.request?.responseHeaders ?? {})
      .find(([k]) => k.toLowerCase() === "content-disposition")?.[1] ?? "";
    ok("RW3 下载请求详情", det3.request?.status === 200 && det3.body === null && /attachment/.test(cd),
      `status=${det3.request?.status} body=${det3.body === null ? "null(下载流,符合预期)" : typeof det3.body} cd=${cd.slice(0, 50)}`);
  } else ok("RW3 下载请求详情", false, "无请求可查");
  ok("RW3 下载直链导航报错行(attachment 语义)", /Unable to navigate/.test(nav3.message ?? ""),
    nav3.message?.slice(0, 80));

  // ---- RW4 大响应体内联 ----
  console.log("\n[RW4] 大响应体(get_network_request)");
  bu(["navigate_page", "--session", sessionId, "--url", `${BASE}/big?kb=512`]);
  const lst4 = buJson(["list_network_requests", "--session", sessionId]);
  const big4 = lst4.requests.find((r) => r.url.includes("/big"));
  if (big4) {
    const det4 = buJson(["get_network_request", "--session", sessionId, big4.reqid]);
    const len = typeof det4.body === "string" ? det4.body.length : -1;
    // fixture 确定性输出("x"*1024+"\n")*512 = 524800 字节,精确等值兼防上限截断
    ok("RW4 大响应体内联完整", len === 524800, `body 长度=${len}(精确期望 524800)`);
    // ---- RW5 落盘:传非规范扩展名(验证 _force_ext 强制改写),内容逐字节比对 ----
    const fpRaw = path.join(ART, "big.txt");
    const det5 = buJson(["get_network_request", "--session", sessionId, big4.reqid,
      "--responseFilePath", fpRaw]);
    const fpOut = det5.response_body_file_path;
    let rw5ok = false, rw5detail = "response_body_file_path 字段缺失";
    if (fpOut) {
      const expectPath = fpRaw.replace(/\.txt$/, ".network-response");
      const contentOk = fs.existsSync(fpOut) && fs.readFileSync(fpOut, "utf8") === det4.body;
      rw5ok = fpOut === expectPath && contentOk;
      rw5detail = `path=${fpOut} 扩展名改写=${fpOut === expectPath} 内容一致=${contentOk} size=${fs.existsSync(fpOut) ? fs.statSync(fpOut).size : -1}`;
    }
    ok("RW5 大响应体落盘", rw5ok, rw5detail);
  } else { ok("RW4 大响应体内联完整", false, "/big 请求未捕获"); ok("RW5 大响应体落盘", false, "-"); }

  // ---- RW6 慢导航预算:navigate 默认预算必须 < RPC 上限 ----
  // 真实场景:慢站。修复前 DP get 默认 page_load 30s + doc_loaded 15s = 45s > 30s RPC
  // → 必 CORE_TIMEOUT;修复后 20s 预算返回明确错误行。
  console.log("\n[RW6] 慢导航预算(navigate_page)");
  const rw6 = timedBu(["navigate_page", "--session", sessionId, "--url", `${BASE}/slow?ms=40000`], 45000);
  // 窗口断言:上界防预算回归 45s(RPC 30s 处 CORE_TIMEOUT 必红);下界防预算缩水
  // (回归 0s/5s 时快速返回 TimeoutError,消息同为 Unable——只有耗时下界能抓)
  ok("RW6 慢导航有界返回(预算窗口)", rw6.err === null && rw6.ms >= 15000 && rw6.ms < 28000,
    `${rw6.ms}ms err=${rw6.err}`);
  // pin 消息钉死默认预算 20s(实现 _nav_reason 无显式 timeout 时输出 20000)
  ok("RW6 返回明确失败行(预算 20s)", /Navigation timeout of 20000 ms exceeded/.test(rw6.result?.message ?? ""),
    rw6.result?.message?.slice(0, 90));
  const back6 = bu(["navigate_page", "--session", sessionId, "--url", `${BASE}/static`]);

  // ---- RW7 节流真实生效(emulate Slow 3G → fetch 变慢 → 重置后恢复)----
  console.log("\n[RW7] 网络节流真实生效(emulate)");
  const fetchMs = () => buJson(["evaluate_script", "--session", sessionId,
    `async () => { const t0 = performance.now(); await fetch('${BASE}/big?kb=256', {cache: 'no-store'}); return Math.round(performance.now() - t0); }`]).value;
  bu(["emulate", "--session", sessionId, "--networkConditions", "Slow 3G"]);
  const slowMs = fetchMs();
  bu(["emulate", "--session", sessionId, "--colorScheme", "dark"]); // 全量重置 → 节流清除
  const resetMs = fetchMs();
  ok("RW7 Slow 3G 下 fetch 真实变慢", slowMs >= 2000, `${slowMs}ms(256KB @ Slow3G)`);
  ok("RW7 重置后恢复", resetMs < 1500, `重置后 ${resetMs}ms`);

  // ---- RW8 SPA 点击 → 异步 fetch → DOM 更新 → 网络收割 ----
  console.log("\n[RW8] SPA 路由行为");
  bu(["navigate_page", "--session", sessionId, "--url", `${BASE}/spa`]);
  const snap8 = bu(["take_snapshot", "--session", sessionId]);
  const uid8 = (snap8.split("\n").find((l) => l.includes("SPA 跳转"))?.match(/uid=(\d+_\d+)/) ?? [])[1];
  ok("RW8 SPA 按钮取得 uid", !!uid8);
  if (uid8) {
    bu(["click", "--session", sessionId, uid8]);
    // 轮询代替固定 sleep:异步 fetch 完成时间有波动,轮询到目标文本或 5s 超时
    let eval8val = "";
    for (let i = 0; i < 25 && !/route-2-loaded\(200\)/.test(eval8val); i++) {
      await sleep(200);
      eval8val = buJson(["evaluate_script", "--session", sessionId,
        "() => document.getElementById('route').textContent"]).value ?? "";
    }
    ok("RW8 点击后 DOM 真实更新", /route-2-loaded\(200\)/.test(eval8val), eval8val);
    const lst8 = buJson(["list_network_requests", "--session", sessionId]);
    ok("RW8 SPA fetch 被收割", lst8.requests.some((r) => r.url.includes("spa=")),
      `共 ${lst8.requests.length} 条`);
  }

  // ---- RW9 beforeunload:navigate 离开 + handleBeforeUnload=accept ----
  // 前提声明:本用例假定 DP 对 beforeunload 弹窗抛"存在未处理的提示框"错误(实现
  // 的弹窗分支因此被走到)。若未来 Chromium/DP 行为变化导致弹窗不触发(get 直接
  // 成功),accept 快速路径与正常导航的 message 相同,本用例无信号虚绿——那需要
  // 新的观测手段,届时重审。
  console.log("\n[RW9] beforeunload 弹窗");
  bu(["navigate_page", "--session", sessionId, "--url", `${BASE}/beforeunload`]);
  const rw9 = buJson(["navigate_page", "--session", sessionId, "--url", `${BASE}/static`,
    "--handleBeforeUnload", "accept"]);
  ok("RW9 accept 后导航成功", rw9.url?.includes("/static") && /Successfully/.test(rw9.message ?? ""),
    `${rw9.url} ${rw9.message?.slice(0, 60)}`);

  // ---- RW9b beforeunload dismiss:导航被取消,留在原页 ----
  bu(["navigate_page", "--session", sessionId, "--url", `${BASE}/beforeunload`]);
  const rw9b = buJson(["navigate_page", "--session", sessionId, "--url", `${BASE}/static`,
    "--handleBeforeUnload", "dismiss"]);
  ok("RW9b dismiss 后导航取消(留原页)",
    rw9b.url?.includes("/beforeunload") && /canceled/.test(rw9b.message ?? ""),
    `${rw9b.url} ${rw9b.message?.slice(0, 70)}`);

  // ---- RW9c click 触发 beforeunload → 后续工具自动 accept 放行 ----
  // 真实场景:AI 点击离开链接,页面弹"未保存"确认弹窗挂起导航。治理语义 =
  // beforeunload 型弹窗自动 accept(纯噪音),下一个工具不再被 "A dialog is open"
  // 拦截,导航完成;alert/confirm/prompt 型仍走 handle_dialog。
  console.log("\n[RW9c] beforeunload 自动 accept");
  const snap9c = bu(["take_snapshot", "--session", sessionId]);
  const uid9c = (snap9c.split("\n").find((l) => l.includes("离开链接"))?.match(/uid=(\d+_\d+)/) ?? [])[1];
  ok("RW9c 离开链接取得 uid", !!uid9c);
  if (uid9c) {
    bu(["click", "--session", sessionId, uid9c]);
    await sleep(600); // 弹窗挂起窗口
    const ev9c = buJson(["evaluate_script", "--session", sessionId,
      "() => location.href", "--timeout", "20000"], 30000);
    ok("RW9c 后续工具自动放行(弹窗被 accept,导航完成)",
      typeof ev9c.value === "string" && ev9c.value.includes("/static"),
      `href=${ev9c.value}`);
  }

  // ---- RW10 点击触发下载(a[download])----
  // 断言锚 = 独立命名的下载文件落地(fixture ?src=click → bu-fixture-click.bin,
  // 与 RW3 直链场景的 bu-fixture.bin 隔离,消除交叉污染;Chromium 同名下载会去重
  // 加 (1) 后缀,"文件存在"对点击失效不敏感——必须断言新名字出现)。
  // 请求收割不在此断言:点击触发的下载走 DownloadManager 通道,不派发常规 Network
  // 事件(实证零事件,CDP/浏览器结构性边界,preflight 同类);直链场景收割由 RW3 承担。
  console.log("\n[RW10] 点击触发下载");
  // 入口导航显式断言:RW9b dismiss 后页面留在 /beforeunload,此处离开弹窗页走
  // navigate 对 beforeunload 的默认 accept 分支——把隐式链路依赖变成被测行为
  const nav10 = buJson(["navigate_page", "--session", sessionId, "--url", `${BASE}/dl-page`]);
  ok("RW10 进入下载页(默认 accept 离开弹窗页)", /Successfully/.test(nav10.message ?? ""),
    nav10.message?.slice(0, 70));
  const snap10 = bu(["take_snapshot", "--session", sessionId]);
  const uid10 = (snap10.split("\n").find((l) => l.includes("下载文件"))?.match(/uid=(\d+_\d+)/) ?? [])[1];
  ok("RW10 下载链接取得 uid", !!uid10);
  if (uid10) {
    const dlDir = path.join(os.homedir(), ".browser-use", "sessions", sessionId, "downloads");
    const before = new Set(fs.existsSync(dlDir) ? fs.readdirSync(dlDir) : []);
    bu(["click", "--session", sessionId, uid10]);
    // 轮询新文件(200ms × 10s):下载未完成时是 .crdownload 中间名,精确名+精确尺寸出现才算
    let dlFile = null;
    for (let i = 0; i < 50 && !dlFile; i++) {
      await sleep(200);
      if (fs.existsSync(dlDir)) {
        for (const f of fs.readdirSync(dlDir)) {
          const st = fs.statSync(path.join(dlDir, f));
          if (!before.has(f) && f === "bu-fixture-click.bin" && st.size === 2 * 1024 * 1024) dlFile = f;
        }
      }
    }
    ok("RW10 点击后新下载文件落地", dlFile === "bu-fixture-click.bin",
      dlFile ? `${path.join(dlDir, dlFile)} size=2097152` : `10s 内未出现(前状态:${[...before].join(",") || "空"})`);
  }

  // ---- RW13 console 持续收割:chatty 页的 console 流(增量 + epoch 去重)----
  // 真实场景:统计类页面持续 console 输出。验证收割的增量语义与跨调用去重
  // (DEC-014 hook 链:每文档随机 epoch + seq,core 侧按 epoch+seq 去重)。
  console.log("\n[RW13] console 持续收割");
  bu(["navigate_page", "--session", sessionId, "--url", `${BASE}/chatty`]);
  await sleep(1200);
  const c1 = buJson(["list_console_messages", "--session", sessionId]);
  const ticks1 = c1.messages?.filter((m) => /chatty-tick-\d+/.test(m.text ?? "")) ?? [];
  await sleep(1000); // 流继续
  const c2 = buJson(["list_console_messages", "--session", sessionId]);
  const ticks2 = c2.messages?.filter((m) => /chatty-tick-\d+/.test(m.text ?? "")) ?? [];
  const texts1 = ticks1.map((m) => m.text), texts2 = ticks2.map((m) => m.text);
  const overlap = texts1.filter((t) => texts2.includes(t));
  ok("RW13 首轮收割到 console 流", ticks1.length >= 2, `chatty-tick ${ticks1.length} 条`);
  ok("RW13 二轮增量(新条目出现)", ticks2.length >= 2, `增量 ${ticks2.length} 条`);
  ok("RW13 跨轮去重(无重复条目)", overlap.length === 0,
    `重复=${overlap.length}(两轮样本:${texts1.length}+${texts2.length})`);
  if (ticks1.length) {
    const d13 = buJson(["get_console_message", "--session", sessionId, ticks1[0].msgid]);
    ok("RW13 console 详情精确", d13.message?.text === ticks1[0].text && d13.message?.type === "log",
      `text=${d13.message?.text} type=${d13.message?.type}`);
  }
  // 跨文档 epoch:导航离开再回 /chatty(新文档新 epoch),收割应得新 tick 且不被
  // "仅按 seq 去重"的退化误杀(回归成 seq-only 去重时,新文档 seq 从 0 重来会被
  // 当作已见丢弃 → 收割为空)
  bu(["navigate_page", "--session", sessionId, "--url", `${BASE}/static`]);
  bu(["navigate_page", "--session", sessionId, "--url", `${BASE}/chatty`]);
  await sleep(1200);
  const c3 = buJson(["list_console_messages", "--session", sessionId]);
  const ticks3 = c3.messages?.filter((m) => /chatty-tick-\d+/.test(m.text ?? "")) ?? [];
  ok("RW13 跨文档收割(epoch 维度)", ticks3.length >= 2, `新文档 tick ${ticks3.length} 条(epoch 机制存在理由)`);

  // ---- RW14 heapsnapshot 大页真实规模 ----
  // 真实场景:真实大 DOM 站点的堆快照。简单页 nodes>0 断言无法暴露"大页超预算/
  // 截断"类问题;3 万节点页要求快照完整落盘且规模在正确数量级。
  // headed 实测 ~25s、耗时方差大(几秒~30s,54MB 落盘),显式工具超时。
  console.log("\n[RW14] heapsnapshot 大页");
  bu(["navigate_page", "--session", sessionId, "--url", `${BASE}/huge-dom`]);
  const t14 = Date.now();
  let h14 = null, err14 = null;
  try { h14 = buJson(["take_heapsnapshot", "--session", sessionId, "--timeout", "180000"], 200000); }
  catch (e) { err14 = String(e.stdout || e.stderr || e.message).slice(0, 140); }
  const hsPath14 = h14?.filePath ?? h14?.path;
  const hsSize = hsPath14 && fs.existsSync(hsPath14) ? fs.statSync(hsPath14).size : -1;
  // 阈值 300000:实测 ~769k,简单页基线约几万——中间留 10 倍判别带(审查收紧)
  ok("RW14 大页快照规模在数量级", err14 === null && (h14?.nodes ?? 0) > 300000,
    err14 ? `工具失败: ${err14}` : `nodes=${h14.nodes}(${Math.round((Date.now() - t14) / 1000)}s,期望 >300000)`);
  ok("RW14 快照落盘真实", hsSize > 1024 * 1024, `file=${hsPath14?.slice(-40)} size=${(hsSize / 1048576).toFixed(1)}MB`);
  if (hsPath14) {
    // close 真断言(审查补充:closed 回执 + 二次 close 必须报 not loaded)
    let closed14 = null, again14 = "";
    try { closed14 = buJson(["close_heapsnapshot", "--session", sessionId, "--filePath", hsPath14]); }
    catch (e) { again14 = String(e.stdout || e.stderr || e.message).slice(0, 80); }
    let second14 = "";
    if (closed14?.closed) {
      try { bu(["close_heapsnapshot", "--session", sessionId, "--filePath", hsPath14]); second14 = "(二次未报错!)"; }
      catch (e) { second14 = /not loaded/i.test(String(e.stdout || e.stderr || e.message)) ? "(报错正确)" : String(e.stdout || e.message).slice(0, 60); }
    }
    ok("RW14 close 生命周期", closed14?.closed === hsPath14 && second14 === "(报错正确)",
      `closed=${closed14?.closed === hsPath14} 二次 close=${second14}`);
  }

  // ---- RW15 performance trace 真实交互流 ----
  // 真实场景:对真实交互+导航+长任务录制 trace。手动模式(--autoStop false,
  // start 默认路径是 reload+5s+自动停的阻塞形态,中间无法插入交互;矩阵同款
  // --timeout 经验)。锚 = 事件量级、落盘文件与返回一致、analyze 结构。
  console.log("\n[RW15] performance 真实交互");
  bu(["navigate_page", "--session", sessionId, "--url", `${BASE}/spa`]);
  bu(["performance_start_trace", "--session", sessionId,
    "--reload", "false", "--autoStop", "false", "--timeout", "180000"], 200000);
  const snap15 = bu(["take_snapshot", "--session", sessionId]);
  const uid15 = (snap15.split("\n").find((l) => l.includes("SPA 跳转"))?.match(/uid=(\d+_\d+)/) ?? [])[1];
  ok("RW15 SPA 按钮取得 uid(trace 中)", !!uid15);  // 交互门:点击被静默跳过会让"交互页 trace"名存实亡(审查收紧)
  if (uid15) bu(["click", "--session", sessionId, uid15]); // trace 中交互(fetch+DOM)
  bu(["navigate_page", "--session", sessionId, "--url", `${BASE}/long-task`]); // trace 中导航+长任务
  const st15 = buJson(["performance_stop_trace", "--session", sessionId,
    "--output-format=json", "--timeout", "180000"], 200000);
  const traceOk = st15.path && fs.existsSync(st15.path)
    ? JSON.parse(fs.readFileSync(st15.path, "utf8")).traceEvents?.length === st15.events : false;
  ok("RW15 交互页 trace 事件量级", (st15.events ?? 0) > 100, `events=${st15.events}`);
  ok("RW15 trace 落盘与返回一致", traceOk, st15.path?.slice(-40) ?? "无路径");
  // 点击相关事件锚:trace 含 click 的 Input 派发与 SPA fetch 的网络事件——钉住
  // "交互真的被录进 trace"(仅靠导航事件也能过量级断言,审查收紧)
  if (st15.path && fs.existsSync(st15.path)) {
    const names15 = new Set(JSON.parse(fs.readFileSync(st15.path, "utf8")).traceEvents.map((e) => e.name));
    const clickHit = [...names15].some((n) => /EventDispatch|InputHidePinch|HandleInputEvent/i.test(n));
    const fetchHit = [...names15].some((n) => /ResourceSendRequest|ResourceWillSendRequest/.test(n));
    ok("RW15 点击与 fetch 事件入 trace", clickHit && fetchHit, `click类=${clickHit} 网络类=${fetchHit}`);
  }
  const a15 = buJson(["performance_analyze_insight", "--session", sessionId,
    "--filePath", st15.path, "--timeout", "120000"], 150000);
  ok("RW15 analyze 结构", "long_tasks_over_50ms" in (a15 ?? {}), `keys=${Object.keys(a15 ?? {}).slice(0, 6).join(",")}`);
  ok("RW15 长任务被真实捕获", (a15?.long_tasks_over_50ms ?? 0) >= 1,
    `long_tasks_over_50ms=${a15?.long_tasks_over_50ms}(long-task 页 400ms 阻塞应计入)`);

  // ---- RW16 输入类工具在持续请求页(uid 消费不受网络活动干扰)----
  // 真实场景:现代页面边交互边发请求。uid 消费(坐标换算/焦点/置值)若受
  // 持续网络活动干扰(重渲染/事件竞争)会在此时暴露。
  console.log("\n[RW16] 输入组在持续请求页");
  bu(["navigate_page", "--session", sessionId, "--url", `${BASE}/busy-inputs`]);
  const snap16 = bu(["take_snapshot", "--session", sessionId]);
  const uidIn = (snap16.split("\n").find((l) => l.includes("输入框"))?.match(/uid=(\d+_\d+)/) ?? [])[1];
  const uidHz = (snap16.split("\n").find((l) => l.includes("hover 区"))?.match(/uid=(\d+_\d+)/) ?? [])[1];
  const uidSrc = (snap16.split("\n").find((l) => l.includes("拖我"))?.match(/uid=(\d+_\d+)/) ?? [])[1];
  const uidDz = (snap16.split("\n").find((l) => l.includes("drop 区"))?.match(/uid=(\d+_\d+)/) ?? [])[1];
  ok("RW16 输入元素 uid 取得", !!uidIn && !!uidHz && !!uidSrc && !!uidDz,
    `in=${uidIn} hz=${uidHz} src=${uidSrc} dz=${uidDz}`);
  if (uidIn) {
    bu(["fill", "--session", sessionId, uidIn, "pre-"]);
    bu(["press_key", "--session", sessionId, "s"]);
    bu(["type_text", "--session", sessionId, "-busy"]);
    const v16 = buJson(["evaluate_script", "--session", sessionId,
      "() => document.getElementById('typer').value"]).value;
    ok("RW16 press_key+type_text 追加输入", v16 === "pre-s-busy", `value=${JSON.stringify(v16)}`);
  }
  if (uidHz) {
    bu(["hover", "--session", sessionId, uidHz]);
    const h16 = buJson(["evaluate_script", "--session", sessionId,
      "() => document.getElementById('busy-log').textContent"]).value;
    ok("RW16 hover 命中(心跳页)", /hover-entered-\d+/.test(h16 ?? ""), h16);
  }
  if (uidSrc && uidDz) {
    bu(["drag", "--session", sessionId, uidSrc, uidDz]);
    const d16 = buJson(["evaluate_script", "--session", sessionId,
      "() => document.getElementById('busy-log').textContent"]).value;
    ok("RW16 drag 落点(心跳页)", /drop-released-\d+/.test(d16 ?? ""), d16);
  }

  // ---- RW11 真实公网页面 ----
  // SKIP 门槛 = 仅外网不可达(navigate 明确报 net::ERR_*);工具域错误(工具挂死回归
  // exit 5 / CORE_TIMEOUT / snapshot 缺陷)一律 FAIL——外网波动不掩盖工具缺陷。
  console.log("\n[RW11] 真实公网页面");
  try {
    const nav11 = buJson(["navigate_page", "--session", sessionId, "--url", "https://example.com"], 40000);
    if (/Unable to navigate/.test(nav11.message ?? "")) {
      skip("RW11 真实公网页面", `外网不可达: ${nav11.message.slice(0, 80)}`);
    } else {
      const snap11 = bu(["take_snapshot", "--session", sessionId], 40000);
      ok("RW11 公网页面快照含标题", /Example Domain/.test(snap11));
      const lst11 = buJson(["list_network_requests", "--session", sessionId]);
      const doc11 = lst11.requests.find((r) => r.url === "https://example.com/");
      ok("RW11 公网 document 请求被抓取", !!doc11 && doc11.status === 200,
        doc11 ? `status=${doc11.status}` : `未捕获;增量=${JSON.stringify(lst11.requests.map((r) => r.url.slice(-45)))}`);
      if (doc11) {
        const det11 = buJson(["get_network_request", "--session", sessionId, doc11.reqid]);
        ok("RW11 公网请求详情", det11.request?.status === 200 && typeof det11.body === "string" && det11.body.includes("Example Domain"),
          `status=${det11.request?.status} body 含标题=${typeof det11.body === "string" && det11.body.includes("Example Domain")}`);
      }
    }
  } catch (e) { ok("RW11 公网链路(工具错误)", false, String(e.stdout || e.message || e.stderr).slice(0, 120)); }

  // ---- RW12 真实公网下载(GitHub release 直链,固化验收场景)----
  // SKIP 仅三类真外网路径:navigate net::ERR_* / API 非 200(限流、波动)/ release
  // 资产列表为空。API 200 之后的一切失败(body 丢失、解析失败、正则不命中、下载
  // 收割丢失)都是工具域或测试数据过期 → FAIL(正则不命中时列出资产名强制更新)。
  console.log("\n[RW12] 真实公网下载");
  try {
    const nav12 = buJson(["navigate_page", "--session", sessionId, "--url",
      "https://api.github.com/repos/git-for-windows/git/releases/latest"], 60000);
    if (/Unable to navigate/.test(nav12.message ?? "")) {
      skip("RW12 真实公网下载", `外网不可达: ${nav12.message.slice(0, 80)}`);
    } else {
      const api12 = buJson(["list_network_requests", "--session", sessionId])
        .requests.find((r) => r.url.includes("api.github.com/repos/git-for-windows"));
      if (!api12) {
        const got12 = buJson(["list_network_requests", "--session", sessionId, "--includePreservedRequests", "true"]);
        throw new Error(`API 请求未捕获(收割丢失);增量+全量=${JSON.stringify(got12.requests.map((r) => r.url.slice(-45)))}`);
      }
      const det12 = buJson(["get_network_request", "--session", sessionId, api12.reqid]);
      const st12 = det12.request?.status;
      if (st12 !== 200) { skip("RW12 真实公网下载", `GitHub API HTTP ${st12}(限流/波动)`); }
      else if (det12.body === null || det12.body === undefined) {
        ok("RW12 API body 可取", false, "body=null/undefined(body 丢失,工具缺陷等价类)");
      }
      else {
        // body 健康形态二种:DP 已解析对象(JSON 响应)或 string(未解析)
        let body12 = det12.body;
        if (typeof body12 === "string") {
          try { body12 = JSON.parse(body12); }
          catch { ok("RW12 API body 可解析", false, `JSON.parse 失败,body 前 100:${body12.slice(0, 100)}`); body12 = null; }
        }
        if (body12) {
          // 结构判据:非数组 assets = 200 但非 release 结构对象(代理异常体等,工具/
          // 中间件域)→ FAIL;空数组 = release 真无资产(外网波动)→ SKIP
          if (!Array.isArray(body12.assets)) {
            ok("RW12 release 结构有效", false,
              `200 但非 release 结构:keys=${Object.keys(body12).join(",")} tag_name=${typeof body12.tag_name}`);
          } else if (body12.assets.length === 0) {
            skip("RW12 真实公网下载", `release ${body12.tag_name} 资产列表为空(外网波动)`);
          } else {
            const asset = body12.assets.find((a) => /-64-bit\.exe$/.test(a.name));
            if (!asset) { ok("RW12 资产正则命中", false, `tag=${body12.tag_name} 现有资产:${body12.assets.map((a) => a.name).join(", ").slice(0, 200)}(正则需更新)`); }
            else {
              const navDl = buJson(["navigate_page", "--session", sessionId, "--url", asset.browser_download_url], 60000);
              const hit12 = buJson(["list_network_requests", "--session", sessionId])
                .requests.some((r) => r.url.includes(asset.name));
              ok("RW12 真实下载请求被抓取", hit12, `tag=${body12.tag_name} asset=${asset.name} nav=${(navDl.message ?? "").slice(0, 50)}`);
            }
          }
        } else { ok("RW12 API body 非空", false, `JSON.parse 得 falsy:${JSON.stringify(body12)}`); }
      }
    }
  } catch (e) { ok("RW12 公网下载链路(工具错误)", false, String(e.stdout || e.message || e.stderr).slice(0, 120)); }

  // ---- 收尾 ----
  console.log("\n[RW] 收尾");
  const stopOut = bu(["stop", "--session", sessionId]);
  ok("RW stop → cleaned", /cleaned/.test(stopOut), stopOut.slice(0, 60));
  } catch (e) {
    ok("测试集执行", false, e.message.slice(0, 120));
  } finally {
    try { if (sessionId) bu(["stop", "--session", sessionId]); } catch { /* */ }
    serverProc.kill();
    try { fs.rmSync(ART, { recursive: true, force: true }); } catch { /* */ }
  }
}

main().finally(() => {
  console.log(`\n===== real-world 汇总: pass=${pass} fail=${fail} skip=${skipped} =====`);
  if (fails.length) console.log(`fails: ${fails.join(", ")}`);
  process.exit(fail > 0 ? 1 : 0);
});
