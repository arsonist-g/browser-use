// 单元测试:port-only(无 pipe)会话的通道契约。
// 两层断言:(1) 浏览器级 CDP 方法的通道归属 —— Target/Extensions 是 browser 端点命令,
// 走浏览器级 ws(Port-only 会话下同样可达),PWA 只有 pipe 给;(2) daemon 报出的失败码
// 在 core 侧按码透传,不得折叠成 CDP_ERROR —— 折叠后 AI 读到"协议层坏了、别重试",
// 而真原因是"这个会话没有该通道,换个工具或重开会话"。
import { test } from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import http from "node:http";
import fs from "node:fs";
import path from "node:path";
import url from "node:url";
import { browserWsMethod } from "../../lib/pipe-browser.mjs";

const ROOT = path.dirname(path.dirname(path.dirname(url.fileURLToPath(import.meta.url))));

// 必须异步跑子进程:桩服务与 python 调用同在一个 node 进程里,spawnSync 会阻塞事件循环,
// 桩服务无法应答(表现为 python 侧 timed out)。
function runPython(script, env) {
  return new Promise((resolve) => {
    const p = spawn("python", ["-c", script], {
      cwd: ROOT, windowsHide: true,
      env: { ...process.env, PYTHONIOENCODING: "utf-8", ...env },
    });
    let stdout = "", stderr = "";
    p.stdout.on("data", (d) => (stdout += d));
    p.stderr.on("data", (d) => (stderr += d));
    p.on("close", (status) => resolve({ status, stdout, stderr }));
  });
}

test("通道按域名分工:Target/Extensions 走浏览器级 ws,PWA 只走 pipe", () => {
  for (const m of ["Target.createBrowserContext", "Target.createTarget", "Target.getTargets",
    "Extensions.getExtensions", "Extensions.triggerAction"]) {
    assert.equal(browserWsMethod(m), true, `${m} 是 browser 端点命令,应走浏览器级 ws`);
  }
  for (const m of ["PWA.getOsAppState", "PWA.launch", "PWA.install", "PWA.uninstall",
    "Page.navigate", "Browser.getVersion"]) {
    assert.equal(browserWsMethod(m), false, `${m} 不该走浏览器级 ws`);
  }
});

test("daemon 的 /pipe/cdp 分流只经 browserWsMethod(单一来源)", () => {
  const src = fs.readFileSync(path.join(ROOT, "lib", "daemon.mjs"), "utf8");
  assert.match(src, /browserWsMethod\(method\)\s*\?/, "分流必须经 browserWsMethod");
  assert.doesNotMatch(src, /method\.startsWith\("Extensions\."\)\s*\?/, "旧的分流写法应已移除");
  assert.match(src, /port-only/, "daemon 侧仍须说明 port-only 降级语义");
});

test("daemon 的失败码在 core 侧按码透传(不折叠成 CDP_ERROR)", async (t) => {
  const bodies = {
    "PWA.getOsAppState": [503, { ok: false, error: { code: "PIPE_UNAVAILABLE", retryable: false,
      message: "pipe CDP unavailable: this browser did not accept fd 3/4 for --remote-debugging-pipe, "
        + "so the session runs port-only; PWA tools are not available" } }],
    "Target.createBrowserContext": [503, { ok: false, error: { code: "CORE_TIMEOUT", retryable: true,
      message: "ws CDP Target.createBrowserContext timeout (30000ms)" } }],
    "Extensions.getExtensions": [200, { ok: false, error: { code: "CDP_ERROR",
      message: "No node found for given backend id" } }],
    "Page.captureScreenshot": [200, { ok: false, error: { code: "CDP_ERROR",
      message: "Some other protocol failure" } }],
  };
  const server = http.createServer((req, res) => {
    let raw = "";
    req.on("data", (c) => (raw += c));
    req.on("end", () => {
      let method = "";
      try { method = JSON.parse(raw).method; } catch { /* 断言由 python 侧给出 */ }
      const [status, body] = bodies[method] ?? [500, { ok: false, error: { code: "INTERNAL", message: "unexpected method" } }];
      res.writeHead(status, { "Content-Type": "application/json" });
      res.end(JSON.stringify(body));
    });
  });
  await new Promise((r) => server.listen(0, "127.0.0.1", r));
  const port = server.address().port;

  const script = [
    "import json, sys",
    `sys.path.insert(0, ${JSON.stringify(path.join(ROOT, "core"))})`,
    "from bu_core.cdp_events import pipe_call",
    "from bu_core.errors import ToolFailure",
    'methods = ["PWA.getOsAppState", "Target.createBrowserContext",',
    '           "Extensions.getExtensions", "Page.captureScreenshot"]',
    "out = {}",
    "for method in methods:",
    "    try:",
    "        pipe_call('s1', method, timeout=5)",
    '        out[method] = {"code": None}',
    "    except ToolFailure as e:",
    '        out[method] = {"code": e.code, "retryable": bool(e.retryable), "message": str(e)}',
    "print(json.dumps(out, ensure_ascii=False))",
  ].join("\n");
  let r;
  try {
    r = await runPython(script, { BU_DAEMON_PORT: String(port) });
  } finally {
    server.close();
  }
  if (/ModuleNotFoundError|ImportError/.test(r.stderr ?? "")) return t.skip("core 依赖(websocket-client)未安装");
  assert.equal(r.status, 0, `调用失败: ${r.stderr}`);
  const got = JSON.parse(r.stdout);

  assert.equal(got["PWA.getOsAppState"].code, "PIPE_UNAVAILABLE",
    "port-only 会话的 PWA 工具必须报 PIPE_UNAVAILABLE(报 CDP_ERROR 会让 AI 以为会话坏了)");
  assert.equal(got["PWA.getOsAppState"].retryable, false);
  assert.match(got["PWA.getOsAppState"].message, /port-only/,
    "正文必须是原因本身(会话没有 pipe 通道),不是「协议层失败」");

  assert.equal(got["Target.createBrowserContext"].code, "CORE_TIMEOUT",
    "daemon 等浏览器回话超时按 CORE_TIMEOUT 上报(可重试),不得折叠成不可重试的 CDP_ERROR");
  assert.equal(got["Target.createBrowserContext"].retryable, true);

  assert.equal(got["Extensions.getExtensions"].code, "STATE_EXPIRED",
    "同一端点上带引用失效特征的 CDP 报错仍按引用失效归类");
  assert.equal(got["Extensions.getExtensions"].retryable, true);

  assert.equal(got["Page.captureScreenshot"].code, "CDP_ERROR", "无关协议错误仍是 CDP_ERROR");
  assert.equal(got["Page.captureScreenshot"].retryable, false);
});
