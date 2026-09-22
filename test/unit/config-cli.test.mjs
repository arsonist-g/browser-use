// 单元测试:config 子命令契约(能用 + 写错一律 INVALID_ARG/退出码 2,不外泄 JS TypeError)
// 隔离:CLI 子进程的 BROWSER_USE_HOME 指向临时目录,不碰真实 ~/.browser-use;config 全程不联系 daemon
import { test, after } from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import url from "node:url";

const ROOT = path.dirname(path.dirname(path.dirname(url.fileURLToPath(import.meta.url))));
const CLI = path.join(ROOT, "bin", "browser-use.mjs");
const CLI_TIMEOUT_MS = 20000;

const TMP_HOME = fs.mkdtempSync(path.join(os.tmpdir(), "bu-config-cli-"));
process.env.BROWSER_USE_HOME = TMP_HOME;
const CONFIG_PATH = path.join(TMP_HOME, "config.json");

after(() => {
  if (TMP_HOME.startsWith(os.tmpdir())) {
    fs.rmSync(TMP_HOME, { recursive: true, force: true, maxRetries: 5 });
  }
});

const { DEFAULTS } = await import("../../lib/config.mjs");
const { ERROR_CODES } = await import("../../lib/error-codes.mjs");
const USAGE_EXIT = ERROR_CODES.INVALID_ARG.exit;

function runCli(args) {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [CLI, ...args], {
      cwd: ROOT,
      env: { ...process.env, BROWSER_USE_HOME: TMP_HOME },
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

function configFile() {
  try {
    return JSON.parse(fs.readFileSync(CONFIG_PATH, "utf8"));
  } catch {
    return {};   // 首次无文件
  }
}

// 每一个"写错"用例都要求:退出码 2 + INVALID_ARG + 配置文件一字未动
async function assertRejected(args, pattern) {
  const before = fs.existsSync(CONFIG_PATH) ? fs.readFileSync(CONFIG_PATH, "utf8") : null;
  const r = await runCli(args);
  assert.equal(r.status, USAGE_EXIT,
    `${args.join(" ")} 必须以退出码 ${USAGE_EXIT} 拒绝,实际 ${r.status};stderr=${JSON.stringify(r.stderr.trim())}`);
  assert.match(r.stderr, /error\[INVALID_ARG\]/,
    `${args.join(" ")} 的码必须是 INVALID_ARG,实际 ${JSON.stringify(r.stderr.trim())}`);
  assert.match(r.stderr, pattern,
    `${args.join(" ")} 的正文必须说明原因,实际 ${JSON.stringify(r.stderr.trim())}`);
  const after2 = fs.existsSync(CONFIG_PATH) ? fs.readFileSync(CONFIG_PATH, "utf8") : null;
  assert.equal(after2, before, `${args.join(" ")} 被拒绝后不得改动配置文件`);
}

test("config:列表与取值可用(默认导入回归)", async () => {
  const list = await runCli(["config", "list"]);
  assert.equal(list.status, 0, `config list 应成功,stderr=${JSON.stringify(list.stderr.trim())}`);
  assert.deepEqual(JSON.parse(list.stdout), DEFAULTS, "config list 必须输出全部默认键");

  const one = await runCli(["config", "get", "tool_default_timeout_ms"]);
  assert.equal(one.status, 0, `config get 应成功,stderr=${JSON.stringify(one.stderr.trim())}`);
  assert.deepEqual(JSON.parse(one.stdout), { tool_default_timeout_ms: DEFAULTS.tool_default_timeout_ms });
});

test("config:set 生效并落盘", async () => {
  const r = await runCli(["config", "set", "tool_default_timeout_ms", "45000"]);
  assert.equal(r.status, 0, `config set 应成功,stderr=${JSON.stringify(r.stderr.trim())}`);
  assert.equal(JSON.parse(r.stdout).tool_default_timeout_ms, 45000);
  assert.equal(configFile().tool_default_timeout_ms, 45000);
  await runCli(["config", "reset", "tool_default_timeout_ms"]);
  assert.equal(configFile().tool_default_timeout_ms, DEFAULTS.tool_default_timeout_ms);
});

test("config:set 缺值 → INVALID_ARG,不写 NaN 之类坏值", async () => {
  await assertRejected(["config", "set", "tool_default_timeout_ms"], /需要键与值/);
});

test("config:未知键 → INVALID_ARG 并列出可选键(get/set/reset 三条路径)", async () => {
  await assertRejected(["config", "set", "nope_key", "1"], /未知配置键: nope_key/);
  await assertRejected(["config", "get", "nope_key"], /未知配置键: nope_key/);
  await assertRejected(["config", "reset", "nope_key"], /未知配置键: nope_key/);
  const r = await runCli(["config", "set", "nope_key", "1"]);
  assert.match(r.stderr, /tool_default_timeout_ms/, "报错正文必须自带可选键清单(下一步动作)");
});

test("config:值类型不符 → INVALID_ARG(数字/布尔/数组三型)", async () => {
  await assertRejected(["config", "set", "tool_default_timeout_ms", "abc"], /需要数字/);
  await assertRejected(["config", "set", "disable_extensions", "yes"], /需要 true 或 false/);
  await assertRejected(["config", "set", "extra_flags", "not-json"], /需要 JSON 数组/);
});

test("config:未知子命令 → INVALID_ARG 并给出用法", async () => {
  await assertRejected(["config", "wat"], /未知 config 子命令: wat/);
});

