// 单元测试:错误码契约一致性(JS 码表 ↔ core 分类学 ↔ 技能文档码表)。
// 码表是 AI 消费面的契约:任一测漂移(AI 查到不存在的码、或代码产生未登记的码)都会让 AI 误判下一步。
import { test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import url from "node:url";
import { ERROR_CODES } from "../../lib/error-codes.mjs";
import { cliRpcTimeoutMs, coreCallTimeoutMs, MAX_TOOL_BUDGET_MS, toolBudgetMs } from "../../lib/budget.mjs";

const ROOT = path.dirname(path.dirname(path.dirname(url.fileURLToPath(import.meta.url))));
const CODES = Object.keys(ERROR_CODES);

function coreTaxonomy() {
  const script = [
    "import json, sys",
    `sys.path.insert(0, ${JSON.stringify(path.join(ROOT, "core"))})`,
    "from bu_core import errors",
    "out = {}",
    "for name in dir(errors):",
    "    obj = getattr(errors, name)",
    "    if isinstance(obj, type) and issubclass(obj, errors.ToolFailure):",
    "        out[obj.code] = bool(obj.retryable)",
    "print(json.dumps(out))",
  ].join("\n");
  const r = spawnSync("python", ["-c", script], { encoding: "utf8", cwd: ROOT, windowsHide: true });
  assert.equal(r.status, 0, `取 core 分类学失败: ${r.stderr}`);
  return JSON.parse(r.stdout);
}

function codeLiteralsIn(files, pattern) {
  const out = [];
  for (const f of files) {
    const src = fs.readFileSync(f, "utf8");
    for (const m of src.matchAll(pattern)) out.push({ file: path.relative(ROOT, f), code: m[1] });
  }
  return out;
}

function listFiles(dir, ext) {
  const out = [];
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    const p = path.join(dir, e.name);
    if (e.isDirectory()) out.push(...listFiles(p, ext));
    else if (e.name.endsWith(ext)) out.push(p);
  }
  return out;
}

test("core 分类学的每个码都在 JS 码表里,且 retryable 一致", () => {
  const py = coreTaxonomy();
  assert.ok(Object.keys(py).length >= 9, `core 分类学过少: ${JSON.stringify(py)}`);
  for (const [code, retryable] of Object.entries(py)) {
    assert.ok(ERROR_CODES[code], `core 会产生 ${code},JS 码表却没有(幽灵码)`);
    assert.equal(ERROR_CODES[code].retryable, retryable, `${code} 的 retryable 两侧不一致`);
  }
});

test("core 源码里写死的码字面量都在码表里", () => {
  const lits = codeLiteralsIn(listFiles(path.join(ROOT, "core", "bu_core"), ".py"),
    /(?:error\(req,\s*|code\s*=\s*)"([A-Z_]{4,})"/g);
  assert.ok(lits.length > 0, "未扫到任何码字面量,正则失效");
  for (const { file, code } of lits) {
    assert.ok(CODES.includes(code), `${file} 用的 ${code} 不在码表里`);
  }
});

test("JS 侧(daemon/桥/pipe/CLI)写死的码字面量都在码表里", () => {
  const files = [...listFiles(path.join(ROOT, "lib"), ".mjs"), path.join(ROOT, "bin", "browser-use.mjs")];
  const lits = codeLiteralsIn(files, /code[^A-Za-z\n]{0,14}"([A-Z_]{4,})"/g);
  assert.ok(lits.length > 0, "未扫到任何码字面量,正则失效");
  for (const { file, code } of lits) {
    assert.ok(CODES.includes(code), `${file} 用的 ${code} 不在码表里`);
  }
});

test("技能文档的码表列全了码表里的每一个码", () => {
  for (const name of ["SKILL.md", "SKILL-ZH.md"]) {
    const md = fs.readFileSync(path.join(ROOT, "skills", "browser-use", name), "utf8");
    const section = md.slice(md.indexOf("## Errors and retry"), md.indexOf("## Red lines"));
    const listed = new Set([...section.matchAll(/^\| `([A-Z_]+)` \|/gm)].map((m) => m[1]));
    assert.equal(listed.size, CODES.length, `${name} 码表行数 ${listed.size},应为 ${CODES.length}`);
    for (const code of CODES) assert.ok(listed.has(code), `${name} 缺码表行: ${code}`);
  }
});

test("已废弃的码不再出现在代码与技能文档里", () => {
  const files = [
    ...listFiles(path.join(ROOT, "core", "bu_core"), ".py"),
    ...listFiles(path.join(ROOT, "lib"), ".mjs"),
    path.join(ROOT, "bin", "browser-use.mjs"),
    path.join(ROOT, "skills", "browser-use", "SKILL.md"),
    path.join(ROOT, "skills", "browser-use", "SKILL-ZH.md"),
  ];
  for (const dead of ["TOOL_ERROR", "NOT_IMPLEMENTED", "SESSION_STATE_CONFLICT"]) {
    for (const f of files) {
      assert.doesNotMatch(fs.readFileSync(f, "utf8"), new RegExp(dead),
        `${path.relative(ROOT, f)} 仍提到已废弃的 ${dead}`);
    }
  }
});

test("引用失效的 CDP 错误归类为 STATE_EXPIRED,其余仍归 CDP_ERROR", (t) => {
  const script = [
    "import json, sys",
    `sys.path.insert(0, ${JSON.stringify(path.join(ROOT, "core"))})`,
    "from bu_core.cdp_events import cdp_failure",
    "cases = {",
    '  "backend_id": ("DOM.getContentQuads", {"code": -32000, "message": "No node found for given backend id"}),',
    '  "detached": ("DOM.scrollIntoViewIfNeeded", "Node is detached from document"),',
    '  "context": ("Runtime.evaluate", {"code": -32000, "message": "Cannot find context with specified id"}),',
    '  "object_id": ("Runtime.callFunctionOn", json.dumps({"code": -32000, "message": "Could not find object with given id"})),',
    '  "unrelated": ("Page.captureScreenshot", {"code": -32000, "message": "Some other protocol failure"}),',
    "}",
    "out = {}",
    "for name, (method, detail) in cases.items():",
    "    e = cdp_failure(method, detail)",
    '    out[name] = {"code": e.code, "retryable": bool(e.retryable), "message": str(e)}',
    "print(json.dumps(out, ensure_ascii=False))",
  ].join("\n");
  const r = spawnSync("python", ["-c", script], { encoding: "utf8", cwd: ROOT, windowsHide: true });
  if (/ModuleNotFoundError|ImportError/.test(r.stderr ?? "")) return t.skip("core 依赖(websocket-client)未安装");
  assert.equal(r.status, 0, `取 CDP 失败分类失败: ${r.stderr}`);
  const got = JSON.parse(r.stdout);
  for (const name of ["backend_id", "detached", "context", "object_id"]) {
    assert.equal(got[name].code, "STATE_EXPIRED",
      `${name} 是引用失效(应可重试),报成 ${got[name].code}`);
    assert.equal(got[name].retryable, true, `${name} 应 retryable`);
    assert.match(got[name].message, /take_snapshot/, `${name} 的正文必须给出刷新动作`);
    assert.doesNotMatch(got[name].message, /^CDP .*\{/, `${name} 的正文应是原因本身,不是整个 error 对象`);
  }
  assert.equal(got.unrelated.code, "CDP_ERROR", "非引用失效的协议错误不得被归成 STATE_EXPIRED");
  assert.equal(got.unrelated.retryable, false);
});

test("超时预算阶梯:CLI > daemon→core > 工具级(传输层不得抢走工具自己的失败语义)", () => {
  for (const requested of [undefined, 800, 30000, 900000]) {
    const budget = toolBudgetMs(requested, 30000);
    assert.ok(budget >= 1, `工具预算下限: ${budget}`);
    assert.ok(coreCallTimeoutMs(budget) > budget,
      `daemon→core 传输预算(${coreCallTimeoutMs(budget)})须晚于工具预算(${budget})到点`);
    assert.ok(cliRpcTimeoutMs(budget) > coreCallTimeoutMs(budget),
      `CLI→daemon 传输预算(${cliRpcTimeoutMs(budget)})须晚于 daemon→core(${coreCallTimeoutMs(budget)})`);
  }
  assert.equal(toolBudgetMs(900000, 30000), MAX_TOOL_BUDGET_MS, "工具预算须封顶");
  assert.equal(toolBudgetMs(undefined, 12345), 12345, "缺省用 config.tool_default_timeout_ms");
  assert.equal(toolBudgetMs("abc", 12345), 12345, "非法值退回缺省,不得算出 1ms 级预算");
  // 阶梯必须是两侧共用的同一份实现:任一侧自己算,就是"传输层先杀"这类缺陷的复发点
  assert.match(fs.readFileSync(path.join(ROOT, "lib", "daemon.mjs"), "utf8"),
    /coreCallTimeoutMs\(budgetMs\)/, "daemon 的 tool.call 须用 coreCallTimeoutMs");
  assert.match(fs.readFileSync(path.join(ROOT, "bin", "browser-use.mjs"), "utf8"),
    /cliRpcTimeoutMs\(budgetMs\)/, "CLI 的 tool.call 须用 cliRpcTimeoutMs");
});
