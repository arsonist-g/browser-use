// 单元测试:日常浏览器自启(DEC-040)。
// 覆盖三块:进程快照判定(别把自己起的浏览器当成用户的日常浏览器;**必须认出"有窗口就是开着"**)/
// 纯决策(要不要拉起/等多久)/ CLI 面(参数、输出、退出码)。CLI 段用桩 daemon,不碰真实 ~/.browser-use。
import { test, after } from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import http from "node:http";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import url from "node:url";

const ROOT = path.dirname(path.dirname(path.dirname(url.fileURLToPath(import.meta.url))));
const CLI = path.join(ROOT, "bin", "browser-use.mjs");
const CLI_TIMEOUT_MS = 20000;
const TMP_HOME = fs.mkdtempSync(path.join(os.tmpdir(), "bu-daily-browser-"));

after(() => {
  if (TMP_HOME.startsWith(os.tmpdir())) fs.rmSync(TMP_HOME, { recursive: true, force: true, maxRetries: 5 });
});

const {
  summarizeProcesses, parseProcessJson, planDailyEnsure, ensureDailyBrowser,
  WAIT_AFTER_LAUNCH_MS, WAIT_WHEN_RUNNING_MS,
} = await import("../../lib/daily-browser.mjs");
const { ERROR_CODES } = await import("../../lib/error-codes.mjs");

const PROFILES_ROOT = "C:\\Users\\tester\\.browser-use";
const EDGE = "C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe";
// 用户的日常 Edge:主进程命令行可能仍带 --no-startup-window(启动加速主进程被提升成有窗口的浏览器后,
// 旗标原样保留),真正的信号是 MainWindowHandle。
const DAILY_WITH_WINDOW = { pid: 30208, commandLine: `"${EDGE}" --no-startup-window`, mainWindowHandle: 2232222 };
const DAILY_NO_WINDOW = { pid: 30208, commandLine: `"${EDGE}" --no-startup-window`, mainWindowHandle: 0 };

// ---- 进程快照判定 ----

test("daily-browser:带 --no-startup-window 但有窗口的主进程 = 开着(本 bug 的回归用例)", () => {
  const s = summarizeProcesses([DAILY_WITH_WINDOW], { profileRoot: PROFILES_ROOT });
  assert.deepEqual(s, { processes: 1, windows: 1 });
});

test("daily-browser:同为常驻进程但没有窗口 → 只算进程,不算开着", () => {
  assert.deepEqual(summarizeProcesses([DAILY_NO_WINDOW], { profileRoot: PROFILES_ROOT }),
    { processes: 1, windows: 0 });
});

test("daily-browser:本工具起的会话实例不算日常浏览器(哪怕它有窗口)", () => {
  const procs = [{
    pid: 1, mainWindowHandle: 777,
    commandLine: `"${EDGE}" --remote-debugging-port=18000 --user-data-dir=${PROFILES_ROOT}\\profiles\\s-20260926-1`,
  }];
  assert.deepEqual(summarizeProcesses(procs, { profileRoot: PROFILES_ROOT }), { processes: 0, windows: 0 });
});

test("daily-browser:渲染/GPU 等子进程不算主进程(--type= 一律排除)", () => {
  const procs = [{ pid: 2, mainWindowHandle: 999, commandLine: `"${EDGE}" --type=renderer --user-data-dir="C:\\Users\\tester\\AppData\\Local\\Microsoft\\Edge\\User Data"` }];
  assert.deepEqual(summarizeProcesses(procs, { profileRoot: PROFILES_ROOT }), { processes: 0, windows: 0 });
});

test("daily-browser:空快照 / 读不到命令行 → 全 0(不臆测)", () => {
  assert.deepEqual(summarizeProcesses([], { profileRoot: PROFILES_ROOT }), { processes: 0, windows: 0 });
  assert.deepEqual(summarizeProcesses([{ pid: 9, commandLine: "", mainWindowHandle: 5 }], { profileRoot: PROFILES_ROOT }),
    { processes: 0, windows: 0 });
});

test("daily-browser:PowerShell JSON 解析(单对象/数组/空/坏 JSON/null 字段)", () => {
  assert.deepEqual(parseProcessJson(""), []);
  assert.deepEqual(parseProcessJson("not json"), []);
  assert.deepEqual(parseProcessJson('{"ProcessId":1,"CommandLine":"a","MainWindowHandle":5}'),
    [{ pid: 1, commandLine: "a", mainWindowHandle: 5 }]);
  assert.deepEqual(parseProcessJson('[{"ProcessId":1,"CommandLine":"a"},{"ProcessId":2,"CommandLine":null,"MainWindowHandle":null}]'),
    [{ pid: 1, commandLine: "a", mainWindowHandle: 0 }, { pid: 2, commandLine: "", mainWindowHandle: 0 }]);
});

// ---- 纯决策 ----

test("daily-browser:决策表(桥已连 / 有窗口只等 / 没窗口就拉起 / 不允许拉起只提示)", () => {
  assert.deepEqual(planDailyEnsure({ bridgeConnected: true, processes: 0, windows: 0, launch: true }),
    { action: "none", waitMs: 0 });
  assert.deepEqual(planDailyEnsure({ bridgeConnected: false, processes: 1, windows: 1, launch: true }),
    { action: "wait", waitMs: WAIT_WHEN_RUNNING_MS });
  assert.deepEqual(planDailyEnsure({ bridgeConnected: false, processes: 1, windows: 0, launch: true }),
    { action: "launch", waitMs: WAIT_AFTER_LAUNCH_MS });
  assert.deepEqual(planDailyEnsure({ bridgeConnected: false, processes: 0, windows: 0, launch: true }),
    { action: "launch", waitMs: WAIT_AFTER_LAUNCH_MS });
  assert.deepEqual(planDailyEnsure({ bridgeConnected: false, processes: 0, windows: 0, launch: false }),
    { action: "hint", waitMs: 0 });
});

// ---- ensureDailyBrowser(注入探针/拉起/等待,不碰真实进程) ----

function fakes({ procs = [], connected = false, waitConnects = false, waitedMs = 10 } = {}) {
  const bridge = { connected };
  const calls = { probe: [], launch: [], wait: [] };
  return {
    bridge, calls,
    deps: {
      probeProcesses: async (name) => { calls.probe.push(name); return procs; },
      launchBrowser: (exe) => { calls.launch.push(exe); return 4242; },
      waitBridge: async (_b, budgetMs) => {
        calls.wait.push(budgetMs);
        if (waitConnects) _b.connected = true;
        return waitedMs;
      },
    },
  };
}

test("daily-browser:桥已连 → 什么都不做,连进程探测都不跑", async () => {
  const f = fakes({ connected: true });
  const r = await ensureDailyBrowser({ bridge: f.bridge, exe: EDGE, profileRoot: PROFILES_ROOT, ...f.deps });
  assert.equal(r.action, "none");
  assert.equal(r.bridge_connected, true);
  assert.deepEqual(f.calls.probe, [], "桥已连时不得为一次探测付进程快照的开销");
  assert.deepEqual(f.calls.launch, []);
});

test("daily-browser:日常浏览器已开着(有窗口)→ 绝不拉起,只等桥回来", async () => {
  const f = fakes({ procs: [DAILY_WITH_WINDOW], connected: false, waitConnects: true, waitedMs: 2084 });
  const r = await ensureDailyBrowser({ bridge: f.bridge, exe: EDGE, profileRoot: PROFILES_ROOT, ...f.deps });
  assert.deepEqual(f.calls.launch, [], "开着就不许再开一个窗口(用户可见的噪声)");
  assert.deepEqual(f.calls.wait, [WAIT_WHEN_RUNNING_MS]);
  assert.equal(r.action, "wait");
  assert.equal(r.launched, false);
  assert.equal(r.browser_windows, 1);
  assert.equal(r.browser_processes, 1);
  assert.equal(r.bridge_connected, true);
  assert.equal(r.hint, null);
});

test("daily-browser:只剩常驻进程(没有窗口)→ 拉起并等桥连上", async () => {
  const f = fakes({ procs: [DAILY_NO_WINDOW], connected: false, waitConnects: true, waitedMs: 1234 });
  const r = await ensureDailyBrowser({ bridge: f.bridge, exe: EDGE, profileRoot: PROFILES_ROOT, ...f.deps });
  assert.deepEqual(f.calls.probe, ["msedge.exe"], "按 exe 名查主进程");
  assert.deepEqual(f.calls.launch, [EDGE]);
  assert.deepEqual(f.calls.wait, [WAIT_AFTER_LAUNCH_MS]);
  assert.equal(r.action, "launch");
  assert.equal(r.launched, true);
  assert.equal(r.browser_windows, 0);
  assert.equal(r.bridge_connected, true);
});

test("daily-browser:完全没进程 → 拉起(不带参数 = 用户默认 profile)", async () => {
  const f = fakes({ procs: [], connected: false, waitConnects: true });
  const r = await ensureDailyBrowser({ bridge: f.bridge, exe: EDGE, profileRoot: PROFILES_ROOT, ...f.deps });
  assert.deepEqual(f.calls.launch, [EDGE]);
  assert.equal(r.action, "launch");
  assert.equal(r.launched, true);
});

test("daily-browser:拉起失败(pid 拿不到)不得被说成\"没拉起\",而要指向真原因", async () => {
  const f = fakes({ procs: [], connected: false });
  const r = await ensureDailyBrowser({
    bridge: f.bridge, exe: EDGE, profileRoot: PROFILES_ROOT, ...f.deps,
    launchBrowser: () => null,
  });
  assert.equal(r.launched, false);
  assert.equal(r.bridge_connected, false);
  assert.match(r.hint, /拉起日常浏览器失败/);
});

test("daily-browser:拉起了但桥仍没连 → 提示指向桥扩展", async () => {
  const f = fakes({ procs: [], connected: false, waitConnects: false, waitedMs: 500 });
  const r = await ensureDailyBrowser({ bridge: f.bridge, exe: EDGE, profileRoot: PROFILES_ROOT, ...f.deps });
  assert.equal(r.launched, true);
  assert.equal(r.bridge_connected, false);
  assert.match(r.hint, /Browser-Use Bridge/);
});

test("daily-browser:开着但桥没连 → 提示指明是扩展问题,不是实例问题", async () => {
  const f = fakes({ procs: [DAILY_WITH_WINDOW], connected: false, waitConnects: false, waitedMs: 6000 });
  const r = await ensureDailyBrowser({ bridge: f.bridge, exe: EDGE, profileRoot: PROFILES_ROOT, ...f.deps });
  assert.equal(r.bridge_connected, false);
  assert.match(r.hint, /有可见窗口/);
  assert.match(r.hint, /扩展的问题/);
});

test("daily-browser:launch=false 的只读形态不等不拉,提示指向下一步动作", async () => {
  const f = fakes({ procs: [], connected: false });
  const r = await ensureDailyBrowser({ bridge: f.bridge, exe: EDGE, profileRoot: PROFILES_ROOT, launch: false, ...f.deps });
  assert.equal(r.action, "hint");
  assert.deepEqual(f.calls.launch, []);
  assert.deepEqual(f.calls.wait, [], "只看事实的形态不为桥白等");
  assert.match(r.hint, /未自动拉起/);
});

test("daily-browser:waitMs 覆盖决策预算", async () => {
  const f = fakes({ procs: [], connected: false, waitConnects: true });
  await ensureDailyBrowser({ bridge: f.bridge, exe: EDGE, profileRoot: PROFILES_ROOT, waitMs: 50, ...f.deps });
  assert.deepEqual(f.calls.wait, [50]);
});

// ---- CLI 面 ----

function runCli(args, env = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [CLI, ...args], {
      cwd: ROOT,
      env: { ...process.env, BROWSER_USE_HOME: TMP_HOME, ...env },
      windowsHide: true,
      stdio: ["ignore", "pipe", "pipe"],
    });
    let stdout = "";
    let stderr = "";
    const timer = setTimeout(() => {
      child.kill("SIGKILL");
      reject(new Error(`CLI 未在 ${CLI_TIMEOUT_MS}ms 内结束: ${args.join(" ")}`));
    }, CLI_TIMEOUT_MS);
    child.stdout.on("data", (d) => { stdout += d; });
    child.stderr.on("data", (d) => { stderr += d; });
    child.on("error", (e) => { clearTimeout(timer); reject(e); });
    child.on("close", (code) => { clearTimeout(timer); resolve({ status: code, stdout, stderr }); });
  });
}

/** 桩 daemon:记下 /rpc 收到的信封,按 canned 结果回包;不发真命令,不碰真实进程。 */
async function withStubDaemon(result, fn) {
  const seen = [];
  const server = http.createServer((req, res) => {
    let body = "";
    req.on("data", (c) => { body += c; });
    req.on("end", () => {
      res.setHeader("Content-Type", "application/json");
      if (req.url === "/health") return res.end(JSON.stringify({ ok: true }));
      seen.push(body ? JSON.parse(body) : null);
      res.end(JSON.stringify({ v: 1, ok: true, result }));
    });
  });
  await new Promise((r) => server.listen(0, "127.0.0.1", r));
  try {
    return await fn(server.address().port, seen);
  } finally {
    await new Promise((r) => { server.close(r); server.closeAllConnections?.(); });
  }
}

const RESULT_OPEN = {
  bridge_connected: true, action: "none", launched: false, waited_ms: 0,
  browser_processes: 1, browser_windows: 1, hint: null,
};

test("daily-browser:未知子命令 → INVALID_ARG + 退出码 2 且带用法", async () => {
  const r = await runCli(["daily-browser", "wat"]);
  assert.equal(r.status, ERROR_CODES.INVALID_ARG.exit, `stderr=${JSON.stringify(r.stderr.trim())}`);
  assert.match(r.stderr, /error\[INVALID_ARG\]/);
  assert.match(r.stderr, /未知 daily-browser 子命令: wat/);
  assert.match(r.stderr, /用法: browser-use daily-browser/);
});

test("daily-browser:--wait-ms 非数字 → INVALID_ARG(在联系 daemon 之前就拒绝)", async () => {
  const r = await runCli(["daily-browser", "ensure", "--wait-ms=soon"]);
  assert.equal(r.status, ERROR_CODES.INVALID_ARG.exit, `stdout=${JSON.stringify(r.stdout.trim())}`);
  assert.match(r.stderr, /--wait-ms 需要非负毫秒数/);
});

test("daily-browser:ensure 发 daily.ensure{launch:true},桥连上时退出码 0 且报窗口数", async () => {
  await withStubDaemon(RESULT_OPEN, async (port, seen) => {
    const r = await runCli(["daily-browser", "ensure"], { BU_DAEMON_PORT: String(port) });
    assert.equal(r.status, 0, `stderr=${JSON.stringify(r.stderr.trim())}`);
    assert.equal(seen.length, 1);
    assert.equal(seen[0].op, "daily.ensure");
    assert.equal(seen[0].payload.launch, true);
    assert.equal(seen[0].payload.wait_ms, undefined, "默认交给 daemon 侧的等待预算");
    assert.match(r.stdout, /daily_browser=open windows=1 processes=1 bridge=connected action=none/);
  });
});

test("daily-browser:status 传 launch:false + wait_ms:0(只读事实,不拉起也不等)", async () => {
  const canned = {
    bridge_connected: false, action: "hint", launched: false, waited_ms: 0,
    browser_processes: 0, browser_windows: 0, hint: "日常浏览器未打开",
  };
  await withStubDaemon(canned, async (port, seen) => {
    const r = await runCli(["daily-browser", "status"], { BU_DAEMON_PORT: String(port) });
    assert.equal(seen[0].payload.launch, false);
    assert.equal(seen[0].payload.wait_ms, 0);
    assert.match(r.stdout, /daily_browser=closed windows=0 processes=0 bridge=disconnected action=hint/);
    assert.match(r.stdout, /hint: 日常浏览器未打开/);
    // 桥没连上就不是成功:以 BRIDGE_NOT_CONNECTED 的退出码收尾,AI 据此判断登录态还拿不到
    assert.equal(r.status, ERROR_CODES.BRIDGE_NOT_CONNECTED.exit,
      `stdout=${JSON.stringify(r.stdout.trim())}`);
  });
});

test("daily-browser:--no-launch 与 --wait-ms 如实进 payload;JSON 形态回原样字段", async () => {
  const canned = {
    bridge_connected: false, action: "hint", launched: false, waited_ms: 0,
    browser_processes: 1, browser_windows: 0, hint: null,
  };
  await withStubDaemon(canned, async (port, seen) => {
    const r = await runCli(["daily-browser", "ensure", "--no-launch", "--wait-ms=1234", "--output-format=json"],
      { BU_DAEMON_PORT: String(port) });
    assert.equal(seen[0].payload.launch, false);
    assert.equal(seen[0].payload.wait_ms, 1234);
    assert.deepEqual(JSON.parse(r.stdout), canned);
  });
});

test("daily-browser:config 键 daily_browser_autostart 默认 true 且可按布尔书写", async () => {
  const get = await runCli(["config", "get", "daily_browser_autostart"]);
  assert.equal(get.status, 0, `stderr=${JSON.stringify(get.stderr.trim())}`);
  assert.deepEqual(JSON.parse(get.stdout), { daily_browser_autostart: true });

  const set = await runCli(["config", "set", "daily_browser_autostart", "false"]);
  assert.equal(set.status, 0, `stderr=${JSON.stringify(set.stderr.trim())}`);
  assert.equal(JSON.parse(set.stdout).daily_browser_autostart, false);

  const bad = await runCli(["config", "set", "daily_browser_autostart", "yes"]);
  assert.equal(bad.status, ERROR_CODES.INVALID_ARG.exit);
  assert.match(bad.stderr, /需要 true 或 false/);

  await runCli(["config", "reset", "daily_browser_autostart"]);
});
