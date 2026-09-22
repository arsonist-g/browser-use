// 单元测试:无头启动禁用契约(CLI 显式拒绝 --headless / config 键 headless_default 已移除)
// 隔离:子进程不继承 BU_DEV_ALLOW_HEADLESS,daemon 端口指向本进程内的桩服务,
// 因此本文件不拉起真实 daemon、不拉起浏览器、不访问外网
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

// 临时 home:本进程的 config 读写与 CLI 子进程都落在临时目录,不碰真实 ~/.browser-use
const TMP_HOME = fs.mkdtempSync(path.join(os.tmpdir(), "bu-headless-ban-"));
process.env.BROWSER_USE_HOME = TMP_HOME;

const { DEFAULTS, setConfigKey } = await import("../../lib/config.mjs");

after(() => {
  if (TMP_HOME.startsWith(os.tmpdir())) {
    fs.rmSync(TMP_HOME, { recursive: true, force: true, maxRetries: 5 });
  }
});

// 桩 daemon:占住 BU_DAEMON_PORT 并记录收到的请求。
// 作用一:CLI 的探活成功,不会派生出真实 daemon 子进程(即使被拒绝逻辑回归);
// 作用二:用「收到 0 个请求」观测「拒绝发生在联系 daemon 之前」
async function withStubDaemon(fn) {
  const seen = [];
  const server = http.createServer((req, res) => {
    seen.push(`${req.method} ${req.url}`);
    res.setHeader("Content-Type", "application/json");
    res.setHeader("Connection", "close");
    res.statusCode = 200;
    res.end(req.url === "/health"
      ? JSON.stringify({ ok: true })
      : JSON.stringify({ ok: false, error: { code: "STUB_DAEMON", message: "测试桩不执行会话" } }));
  });
  await new Promise((r) => server.listen(0, "127.0.0.1", r));
  const port = server.address().port;
  try {
    return await fn(port, seen);
  } finally {
    await new Promise((r) => {
      server.close(r);
      server.closeAllConnections?.();
    });
  }
}

function childEnv(port) {
  const env = { ...process.env, BROWSER_USE_HOME: TMP_HOME, BU_DAEMON_PORT: String(port) };
  delete env.BU_DEV_ALLOW_HEADLESS;   // 剔除测试放行开关:被测契约只在未放行时成立
  return env;
}

function runCli(args, env) {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [CLI, ...args], {
      cwd: ROOT, env, windowsHide: true, stdio: ["ignore", "pipe", "pipe"],
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

test("start --headless:退出码 2(裸写法与 =value 写法都拒绝)", async () => {
  // 两种写法走 CLI 参数解析的不同分支,都属于「--headless 参数出现」这一等价类
  for (const form of ["--headless", "--headless=true"]) {
    await withStubDaemon(async (port) => {
      const r = await runCli(["start", form], childEnv(port));
      assert.equal(r.status, 2,
        `start ${form} 必须以退出码 2 拒绝,实际 ${r.status};stderr=${JSON.stringify(r.stderr.trim())}`);
    });
  }
});

test("start --headless:stderr 说明无头启动已禁用", async () => {
  await withStubDaemon(async (port) => {
    const r = await runCli(["start", "--headless"], childEnv(port));
    assert.match(r.stderr, /无头启动已禁用/,
      `stderr 必须给出禁用文案,实际 ${JSON.stringify(r.stderr.trim())}`);
  });
});

test("start --headless:拒绝发生在联系 daemon 之前", async () => {
  await withStubDaemon(async (port, seen) => {
    const r = await runCli(["start", "--headless"], childEnv(port));
    assert.deepEqual(seen, [],
      `拒绝前不得向 daemon 发任何请求,实际收到 ${JSON.stringify(seen)};退出码 ${r.status}`);
  });
});

test("config: DEFAULTS 不再暴露 headless_default", () => {
  assert.ok(!("headless_default" in DEFAULTS),
    `DEFAULTS 不应含 headless_default,实际键 ${Object.keys(DEFAULTS).join(",")}`);
});

test("config: setConfigKey 拒绝 headless_default", () => {
  // 契约:未知键是调用方写错参数(INVALID_ARG),正文必须列出可选键
  assert.throws(() => setConfigKey("headless_default", "true"), /未知配置键: headless_default/);
});
