// 单元测试:CLI 的 daemon 端口单一来源。
// status 曾写死默认端口:用 BU_DAEMON_PORT 起隔离 daemon(开发/测试/多实例)时,
// 只有 status 这一条路径打到别人的 daemon 上——读到的会话列表里没有自己的会话,
// 表现为"start 后 state=ready 失败",而真正的原因在端口,不在会话。
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
const TMP_HOME = fs.mkdtempSync(path.join(os.tmpdir(), "bu-daemon-port-"));
const CLI_TIMEOUT_MS = 20000;
const MARKER = "stub-daemon-marker";

after(() => {
  if (TMP_HOME.startsWith(os.tmpdir())) fs.rmSync(TMP_HOME, { recursive: true, force: true, maxRetries: 5 });
});

// 桩 daemon:占住给定端口,记录收到的路径;每个端点都回带 marker,便于断言"打到的是这个桩"
async function withStubDaemon(fn) {
  const seen = [];
  const server = http.createServer((req, res) => {
    seen.push(req.url);
    res.setHeader("Content-Type", "application/json");
    res.setHeader("Connection", "close");
    res.statusCode = 200;
    res.end(JSON.stringify({ ok: true, marker: MARKER, path: req.url }));
  });
  await new Promise((r) => server.listen(0, "127.0.0.1", r));
  try {
    return await fn(server.address().port, seen);
  } finally {
    await new Promise((r) => { server.close(r); server.closeAllConnections?.(); });
  }
}

function runCli(args, port) {
  return new Promise((resolve, reject) => {
    const env = { ...process.env, BROWSER_USE_HOME: TMP_HOME, BU_DAEMON_PORT: String(port) };
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

test("status 走 BU_DAEMON_PORT 指向的 daemon(不写死默认端口)", async () => {
  await withStubDaemon(async (port, seen) => {
    const r = await runCli(["status"], port);
    assert.ok(seen.includes("/status"), `桩 daemon 未收到 /status,收到: ${seen.join(", ")}`);
    assert.match(r.stdout, new RegExp(MARKER), `status 未读到本桩 daemon 的响应: ${r.stdout}`);
  });
});

test("sessions list 同样走 BU_DAEMON_PORT", async () => {
  await withStubDaemon(async (port, seen) => {
    await runCli(["sessions", "list"], port);
    assert.ok(seen.includes("/rpc"), `桩 daemon 未收到 /rpc,收到: ${seen.join(", ")}`);
  });
});
