// 单元测试:未知工具名契约(CLI 在联系 daemon 之前以退出码 2 拒绝,并给出最接近的工具名)
// 隔离:临时 home + 本进程内的桩 daemon,不拉起真实 daemon、不拉起浏览器、不访问外网
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
const SYNTHETIC_SESSION = "s-20260101-000000-abcd";

const TMP_HOME = fs.mkdtempSync(path.join(os.tmpdir(), "bu-unknown-tool-"));
process.env.BROWSER_USE_HOME = TMP_HOME;

after(() => {
  if (TMP_HOME.startsWith(os.tmpdir())) {
    fs.rmSync(TMP_HOME, { recursive: true, force: true, maxRetries: 5 });
  }
});

// 桩 daemon:占住 BU_DAEMON_PORT 并记录收到的请求,用「收到 0 个请求」观测拒绝发生在联系 daemon 之前
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

function runCli(args, port) {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [CLI, ...args], {
      cwd: ROOT,
      env: { ...process.env, BROWSER_USE_HOME: TMP_HOME, BU_DAEMON_PORT: String(port) },
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

test("未知工具名:退出码 2,并给出最接近的工具名(不作为工具执行失败上报)", async () => {
  await withStubDaemon(async (port) => {
    const r = await runCli(["navigate", `--session=${SYNTHETIC_SESSION}`, "https://example.com"], port);
    assert.equal(r.status, 2, `实际 ${r.status};stderr=${JSON.stringify(r.stderr.trim())}`);
    assert.match(r.stderr, /未知工具: navigate/, `stderr 未报出未知工具名:${JSON.stringify(r.stderr.trim())}`);
    assert.match(r.stderr, /navigate_page/, `stderr 未给出最接近的工具名:${JSON.stringify(r.stderr.trim())}`);
    assert.doesNotMatch(r.stderr + r.stdout, /NOT_IMPLEMENTED/,
      `拼写错误不得报成 NOT_IMPLEMENTED:${JSON.stringify(r.stderr.trim())}`);
  });
});

test("未知工具名:拒绝发生在联系 daemon 之前", async () => {
  await withStubDaemon(async (port, seen) => {
    const r = await runCli(["no_such_tool", `--session=${SYNTHETIC_SESSION}`], port);
    assert.equal(r.status, 2);
    assert.deepEqual(seen, [], `拒绝前不得向 daemon 发任何请求,实际 ${JSON.stringify(seen)}`);
  });
});
