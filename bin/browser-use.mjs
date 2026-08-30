#!/usr/bin/env node
// Browser-Use CLI(AI 调用面;bin: browser-use)
// 命令面契约见 backend-design/api-contract.md §6;工具名/参数对齐 chrome-devtools-mcp v1.8.0
import { parseArgs } from "node:util";
import http from "node:http";
import { spawn } from "node:child_process";
import path from "node:path";
import fs from "node:fs";
import url from "node:url";

const ROOT = path.dirname(path.dirname(url.fileURLToPath(import.meta.url)));
const VERSION = "0.1.0";

// ---- 工具位置参数表(P0;M2/M3 占位工具原样转发 flags) ----
const TOOL_POS = {
  click: ["uid"], fill: ["uid", "value"], hover: ["uid"], drag: ["from_uid", "to_uid"],
  press_key: ["key"], type_text: ["text"], upload_file: ["uid", "filePaths"],
  handle_dialog: ["action"], navigate_page: ["url"], new_page: ["url"],
  select_page: ["page_id"], close_page: ["page_id"], wait_for: ["text"],
  evaluate_script: ["function"], get_network_request: ["reqid"], get_console_message: ["msgid"],
  take_screenshot: [], take_snapshot: [], scroll: [],
};
const BOOL_FLAGS = new Set(["includeSnapshot", "dblClick", "ignoreCache", "fullPage", "verbose",
  "headless", "bringToFront", "fix"]);

// ---- utils ----
function out(text) { process.stdout.write(text + "\n"); }
function outJson(obj) { out(JSON.stringify(obj, null, 2)); }
function die(code, msg) { process.stderr.write(`error: ${msg}\n`); process.exit(code); }

function rpc(op, payload, timeoutMs = 60000) {
  return new Promise((resolve, reject) => {
    const body = JSON.stringify({ v: 1, id: `r-${Math.random().toString(36).slice(2)}`, op, payload });
    const req = http.request({
      host: "127.0.0.1", port: Number(process.env.BU_DAEMON_PORT ?? 17981),
      path: "/rpc", method: "POST",
      headers: { "Content-Type": "application/json", "Content-Length": Buffer.byteLength(body) },
      timeout: timeoutMs,
    }, (res) => {
      let data = "";
      res.on("data", (c) => (data += c));
      res.on("end", () => {
        try {
          const obj = JSON.parse(data);
          if (obj.ok) resolve(obj.result);
          else reject(Object.assign(new Error(obj.error?.message ?? "rpc failed"),
            { code: obj.error?.code, retryable: obj.error?.retryable }));
        } catch { reject(new Error(`bad daemon response: ${data.slice(0, 200)}`)); }
      });
    });
    req.on("error", reject);
    req.on("timeout", () => { req.destroy(new Error("daemon timeout")); });
    req.end(body);
  });
}

function daemonAlive() {
  return new Promise((resolve) => {
    const req = http.get({ host: "127.0.0.1", port: Number(process.env.BU_DAEMON_PORT ?? 17981),
      path: "/health", timeout: 1500 }, (res) => {
      res.resume();
      resolve(res.statusCode === 200);
    });
    req.on("error", () => resolve(false));
    req.on("timeout", () => { req.destroy(); resolve(false); });
  });
}

async function ensureDaemon() {
  if (await daemonAlive()) return;
  // 单例探活失败 → 后台拉起(分离进程,不随 CLI 退出)
  const daemonJs = path.join(ROOT, "lib", "daemon.mjs");
  const child = spawn(process.execPath, [daemonJs], {
    detached: true, stdio: "ignore",
    env: { ...process.env },
  });
  child.unref();
  const deadline = Date.now() + 10000;
  while (Date.now() < deadline) {
    if (await daemonAlive()) return;
    await new Promise((r) => setTimeout(r, 200));
  }
  die(3, "daemon 启动超时(检查 node 环境与 ~/.browser-use/daemon.log)");
}

function fmtResult(tool, r) {
  // markdown 主消费面:take_snapshot 正文直出;其余键值行
  if (tool === "take_snapshot" && r?.text) return r.text;
  if (tool === "list_pages" && r?.pages) {
    return r.pages.map((p) => `page ${p.page_id}: ${p.title}  ${p.url}`).join("\n");
  }
  if (r?.snapshot) return `${r.snapshot}\n`;
  return Object.entries(r ?? {}).map(([k, v]) => `${k}: ${typeof v === "object" ? JSON.stringify(v) : v}`).join("\n");
}

// ---- commands ----
async function main() {
  const argv = process.argv.slice(2);
  const command = argv[0];
  if (!command || command === "--help" || command === "-h" || command === "help") {
    out(`browser-use ${VERSION}
usage:
  browser-use start [--headless] [--browser-exe <path>]
  browser-use stop --session=<id>
  browser-use sessions list [--state=<s>] | sessions clean
  browser-use status
  browser-use <tool> --session=<id> [位置参数] [flags]   # take_snapshot/click/fill/...
  browser-use config get [k] | set <k> <v> | list | reset [k]
  browser-use extension          # 打印桥扩展目录与配对 token
  browser-use doctor [--fix]`);
    return;
  }

  const { values, positionals } = parseArgs({
    args: argv.slice(1), allowPositionals: true,
    options: {
      session: { type: "string" }, headless: { type: "boolean" },
      "browser-exe": { type: "string" }, state: { type: "string" },
      "output-format": { type: "string", default: "md" }, timeout: { type: "string" },
      url: { type: "string" }, uid: { type: "string" }, value: { type: "string" },
      key: { type: "string" }, text: { type: "string" }, direction: { type: "string" },
      amount: { type: "string" }, action: { type: "string" }, type: { type: "string" },
      pageId: { type: "string" }, reqid: { type: "string" }, includeSnapshot: { type: "boolean" },
      dblClick: { type: "boolean" }, fullPage: { type: "boolean" }, verbose: { type: "boolean" },
      filePath: { type: "string" }, fix: { type: "boolean" },
    },
  });

  const jsonMode = values["output-format"] === "json";
  const need = () => { if (!values.session) die(2, "需要 --session=<id>(由 start 输出)"); return values.session; };

  try {
    switch (command) {
      case "start": {
        await ensureDaemon();
        const r = await rpc("session.start", { headless: values.headless, browser_exe: values["browser-exe"] });
        if (jsonMode) return outJson(r);
        out(`session=${r.session_id}`);
        if (r.login_state === "injected") out("login=injected(登录态已注入)");
        else out(`login=${r.login_state}\n提示: 未取得登录态。若任务需要登录:确认日常浏览器已打开、扩展已配对(popup 显示已连接);若不需要:browser-use session.bare --session=${r.session_id} 跳过。`);
        return;
      }
      case "session.bare": {
        const r = await rpc("session.bare", { session_id: need() });
        return jsonMode ? outJson(r) : out(`session=${r.session_id} state=ready login=bare`);
      }
      case "stop": {
        await ensureDaemon();
        const r = await rpc("session.stop", { session_id: need() });
        return jsonMode ? outJson(r) : out(`state=${r.state} tools=${r.summary.tools} artifacts=${r.summary.artifacts}`);
      }
      case "sessions": {
        await ensureDaemon();
        const sub = positionals[0] ?? "list";
        if (sub === "clean") {
          const r = await rpc("session.clean", {});
          return jsonMode ? outJson(r) : out(`cleaned: ${r.cleaned.join(", ") || "(none)"}`);
        }
        const r = await rpc("session.list", { state: values.state });
        return jsonMode ? outJson(r)
          : out(r.sessions.map((s) => `${s.session_id}  state=${s.state} login=${s.login_state} port=${s.port}`).join("\n") || "(no sessions)");
      }
      case "status": {
        await ensureDaemon();
        const alive = await new Promise((resolve) => {
          const req = http.get({ host: "127.0.0.1", port: 17981, path: "/status", timeout: 2000 }, (res) => {
            let d = ""; res.on("data", (c) => (d += c)); res.on("end", () => resolve(d));
          });
          req.on("error", () => resolve(null));
        });
        return jsonMode ? outJson(JSON.parse(alive ?? "{}")) : out(alive ?? "daemon 不在线");
      }
      case "config": {
        const { default: cfg } = await import("../lib/config.mjs");
        const sub = positionals[0] ?? "list";
        if (sub === "set") cfg.setConfigKey(positionals[1], positionals[2]);
        else if (sub === "reset") cfg.resetConfigKey(positionals[1]);
        const c = cfg.loadConfig(true);
        if (sub === "get") return outJson({ [positionals[1] ?? ""]: c[positionals[1] ?? ""] ?? c });
        return outJson(c);
      }
      case "extension": {
        const extDir = path.join(ROOT, "extension");
        if (jsonMode) return outJson({ extension_dir: extDir });
        out(`extension_dir: ${extDir}\n\n步骤: edge://extensions → 开发者模式 → 加载解压缩的扩展(${extDir})。无感配对:daemon 在线时自动连接,无需任何配置。`);
        return;
      }
      case "doctor": {
        return cmdDoctor(values.fix, jsonMode);
      }
      default: {
        // 工具命令(未知命令按工具名转发,M2/M3 未实现时 core 返回 NOT_IMPLEMENTED)
        await ensureDaemon();
        const sid = need();
        const args = {};
        const pos = TOOL_POS[command] ?? [];
        pos.forEach((k, i) => { if (positionals[i] !== undefined) args[k] = positionals[i]; });
        const flagMap = { pageId: "page_id", "browser-exe": "browser_exe" };
        for (const [k, v] of Object.entries(values)) {
          if (v === undefined || k === "output-format" || k === "session" || k === "timeout") continue;
          args[flagMap[k] ?? k] = (BOOL_FLAGS.has(k)) ? !!v : (typeof v === "string" && v !== "" && !isNaN(Number(v)) && !["url"].includes(k) ? v : v);
        }
        const r = await rpc("tool.call", { session_id: sid, tool: command, args });
        if (jsonMode) return outJson(r);
        return out(fmtResult(command, r));
      }
    }
  } catch (e) {
    if (jsonMode) {
      outJson({ error: { code: e.code ?? "INTERNAL", message: e.message, retryable: !!e.retryable } });
    } else {
      process.stderr.write(`error[${e.code ?? "INTERNAL"}]: ${e.message}\n`);
      if (e.code === "BRIDGE_NOT_CONNECTED" || e.code === "BRIDGE_TIMEOUT") {
        process.stderr.write("提示: 请确认日常浏览器已打开、Bridge 扩展 popup 显示已连接;或 browser-use session.bare --session=<id> 跳过登录态。\n");
      }
    }
    process.exit(e.code === "BRIDGE_NOT_CONNECTED" || e.code === "BRIDGE_TIMEOUT" ? 4 : 5);
  }
}

async function cmdDoctor(fix, jsonMode) {
  const checks = [];
  const add = (name, ok, detail, fixable) => checks.push({ name, ok, detail, fixable });

  add("node", Number(process.versions.node.split(".")[0]) >= 20, `node ${process.versions.node}`);
  // python
  const py = await new Promise((resolve) => {
    const p = spawn("python", ["--version"]);
    let o = "";
    p.stdout.on("data", (d) => (o += d)); p.stderr.on("data", (d) => (o += d));
    p.on("close", () => resolve(o.trim()));
    p.on("error", () => resolve(null));
  });
  add("python", !!py && /3\.(1[0-9]|[2-9][0-9])/.test(py ?? ""), py ?? "python 不可用");
  // DrissionPage
  const dp = await new Promise((resolve) => {
    const p = spawn("python", ["-c", "import DrissionPage"]);
    p.on("close", (c) => resolve(c === 0 ? "installed" : null));
    p.on("error", () => resolve(null));
  });
  add("DrissionPage", !!dp, dp ?? "未安装(fix: pip install 内嵌 core)");
  // Edge
  let edge = false;
  for (const c of ["C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe",
    "C:\\Program Files\\Microsoft\\Edge\\Application\\msedge.exe"]) {
    try { fs.accessSync(c); edge = true; break; } catch { /* */ }
  }
  add("edge", edge, edge ? "msedge.exe found" : "未找到 Edge");

  if (fix) {
    if (checks.find((c) => c.name === "DrissionPage" && !c.ok)) {
      const coreDir = path.join(ROOT, "core");
      await new Promise((resolve) => {
        const p = spawn("python", ["-m", "pip", "install", "-e", coreDir], { stdio: "inherit", shell: true });
        p.on("close", resolve);
      });
    }
  }
  const allOk = checks.every((c) => c.ok);
  if (jsonMode) return outJson({ ok: allOk, checks });
  for (const c of checks) out(`${c.ok ? "✔" : "✘"} ${c.name}: ${c.detail}`);
  process.exitCode = allOk ? 0 : 3;
}

main().catch((e) => die(5, e.message));
