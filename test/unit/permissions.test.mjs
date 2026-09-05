// 单元测试:命令放行逻辑(目标表完整性 / 三形态站点 / 幂等合并 / 破损配置保护 / 移除语义)
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { ALLOW_TARGETS, findTarget, allowStatus, addAllow, removeAllow }
  from "../../lib/permissions.mjs";

const BIN = "browser-use";

function tmpHome() {
  return fs.mkdtempSync(path.join(os.tmpdir(), "bu-allow-test-"));
}

// 临时改环境变量并在结束后恢复(CLAUDE_CONFIG_DIR / APPDATA / XDG_CONFIG_HOME / OPENCODE_CONFIG)
function withEnv(vars, fn) {
  const saved = {};
  for (const [k, v] of Object.entries(vars)) { saved[k] = process.env[k]; process.env[k] = v; }
  try { return fn(); } finally {
    for (const [k, v] of Object.entries(saved)) {
      if (v === undefined) delete process.env[k]; else process.env[k] = v;
    }
  }
}

test("ALLOW_TARGETS: key 唯一,五家 skill agent + opencode 齐备,站点字段完整", () => {
  const keys = ALLOW_TARGETS.map((a) => a.key);
  assert.equal(new Set(keys).size, keys.length, "key 不得重复");
  // skill install(skills.mjs AGENTS)五家必须同集;opencode 为放行扩展目标
  for (const k of ["claude-code", "codex", "cursor", "gemini-cli", "windsurf", "opencode"]) {
    assert.ok(keys.includes(k), `${k} 必须在候选中`);
  }
  const validKinds = new Set(["json-array", "json-map", "owned-file"]);
  for (const t of ALLOW_TARGETS) {
    assert.ok(t.sites?.length >= 1, `${t.key} 至少一个站点`);
    for (const s of t.sites) {
      assert.ok(validKinds.has(s.kind), `${t.key} 站点 kind 非法: ${s.kind}`);
      assert.ok(typeof s.dir === "function" && s.file && s.source, `${t.key} 站点缺 dir/file/source`);
      if (s.kind === "json-array") assert.ok(s.arrayPath?.length && s.rules?.length, `${t.key} json-array 站点字段不全`);
      if (s.kind === "json-map") assert.ok(s.mapPath?.length && s.keys?.length && s.value, `${t.key} json-map 站点字段不全`);
      if (s.kind === "owned-file") assert.ok(s.content?.includes(s.marker), `${t.key} owned-file content 须含 marker`);
    }
  }
});

test("findTarget: 未知 agent 报 INVALID_ARG", () => {
  assert.throws(() => findTarget("no-such-agent"), /unknown agent/);
});

test("claude-code(json-array): 状态流转 / 保留既有键 / 幂等 / CLAUDE_CONFIG_DIR", () => {
  const home = tmpHome();
  const file = allowStatus("claude-code", home).sites[0].file;
  assert.equal(file, path.join(home, ".claude", "settings.json"));
  assert.equal(allowStatus("claude-code", home).sites[0].state, "not_allowed");

  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, JSON.stringify(
    { model: "opus", permissions: { allow: ["Bash(git *)"], deny: ["Bash(curl *)"] } }, null, 2));
  const r1 = addAllow("claude-code", home);
  assert.equal(r1.sites[0].changed, true);
  assert.deepEqual(r1.sites[0].added, [`Bash(${BIN}:*)`]);
  const after = JSON.parse(fs.readFileSync(file, "utf8"));
  assert.equal(after.model, "opus");
  assert.deepEqual(after.permissions.allow, ["Bash(git *)", `Bash(${BIN}:*)`]);
  assert.deepEqual(after.permissions.deny, ["Bash(curl *)"]);

  assert.equal(addAllow("claude-code", home).sites[0].changed, false, "幂等");
  assert.equal(allowStatus("claude-code", home).sites[0].state, "allowed");

  // CLAUDE_CONFIG_DIR 重定向时优先
  withEnv({ CLAUDE_CONFIG_DIR: path.join(home, "alt-claude") }, () => {
    assert.equal(allowStatus("claude-code", home).sites[0].file,
      path.join(home, "alt-claude", "settings.json"));
  });

  const rr = removeAllow("claude-code", home);
  assert.equal(rr.sites[0].changed, true);
  assert.deepEqual(JSON.parse(fs.readFileSync(file, "utf8")).permissions.allow, ["Bash(git *)"]);
  assert.equal(removeAllow("claude-code", home).sites[0].changed, false, "移除幂等");

  // 全新家目录 add → remove:剪空后文件整体删除(不留空 allow 容器)
  const home2 = tmpHome();
  addAllow("claude-code", home2);
  const f2 = allowStatus("claude-code", home2).sites[0].file;
  const rr2 = removeAllow("claude-code", home2);
  assert.equal(rr2.sites[0].fileDeleted, true);
  assert.equal(fs.existsSync(f2), false);
});

test("codex(owned-file): 创建 / 幂等 / foreign 拒改 / 精确移除 / 改动过拒绝移除", () => {
  const home = tmpHome();
  const file = allowStatus("codex", home).sites[0].file;
  assert.equal(file, path.join(home, ".codex", "rules", "browser-use.rules"));

  const r1 = addAllow("codex", home);
  assert.equal(r1.sites[0].changed, true);
  assert.equal(r1.sites[0].created, true);
  const content = fs.readFileSync(file, "utf8");
  assert.match(content, /prefix_rule\(/);
  assert.match(content, /decision = "allow"/);
  assert.equal(allowStatus("codex", home).sites[0].state, "allowed");
  assert.equal(addAllow("codex", home).sites[0].changed, false, "幂等");

  // 用户手写同名文件(不含我们的 marker)→ 拒绝改写
  fs.rmSync(file);
  fs.writeFileSync(file, 'prefix_rule(pattern = ["my-own-tool"], decision = "allow")\n');
  const foreign = addAllow("codex", home);
  assert.match(foreign.sites[0].error, /不含本工具规则/);
  assert.equal(allowStatus("codex", home).sites[0].state, "foreign");

  // 精确内容 → 删除;内容被改过(仍含 marker)→ 拒绝删除
  fs.writeFileSync(file, content);
  assert.equal(removeAllow("codex", home).sites[0].changed, true);
  assert.equal(fs.existsSync(file), false);
  fs.writeFileSync(file, content + "# user note\n");
  const rr = removeAllow("codex", home);
  assert.match(rr.sites[0].error, /不一致/);
});

test("cursor(双 json-array): IDE terminalAllowlist 合并 + 覆盖 UI 警告;CLI permissions.allow 合并", () => {
  const home = tmpHome();
  const r = addAllow("cursor", home);
  assert.equal(r.sites.length, 2);
  const ideFile = path.join(home, ".cursor", "permissions.json");
  const cliFile = path.join(home, ".cursor", "cli-config.json");

  // IDE:既有条目保留,warning 存在(文件定义后覆盖设置 UI)
  fs.writeFileSync(ideFile, JSON.stringify({ terminalAllowlist: ["git", "npm"] }, null, 2));
  const r2 = addAllow("cursor", home);
  const ide = JSON.parse(fs.readFileSync(ideFile, "utf8"));
  assert.deepEqual(ide.terminalAllowlist, ["git", "npm", BIN]);
  assert.ok(r2.sites[0].warning, "IDE 站点须带覆盖 UI 警告");

  // CLI:permissions.allow 合并,deny 不动
  fs.writeFileSync(cliFile, JSON.stringify(
    { permissions: { allow: ["Shell(git)"], deny: ["Shell(rm)"] } }, null, 2));
  addAllow("cursor", home);
  const cli = JSON.parse(fs.readFileSync(cliFile, "utf8"));
  assert.deepEqual(cli.permissions.allow, ["Shell(git)", `Shell(${BIN})`]);
  assert.deepEqual(cli.permissions.deny, ["Shell(rm)"]);

  assert.equal(allowStatus("cursor", home).state, "allowed");
  removeAllow("cursor", home);
  assert.deepEqual(JSON.parse(fs.readFileSync(ideFile, "utf8")).terminalAllowlist, ["git", "npm"]);
  assert.deepEqual(JSON.parse(fs.readFileSync(cliFile, "utf8")).permissions.allow, ["Shell(git)"]);

  // 全新家目录 add → remove:permissions.json 剪空删除,恢复设置 UI 的回退控制
  const home2 = tmpHome();
  addAllow("cursor", home2);
  const ide2 = path.join(home2, ".cursor", "permissions.json");
  const rr = removeAllow("cursor", home2);
  assert.equal(rr.sites[0].fileDeleted, true, "IDE 站点剪空后文件删除");
  assert.equal(fs.existsSync(ide2), false);
});

test("gemini-cli(owned-file): policies TOML 创建与移除", () => {
  const home = tmpHome();
  const file = allowStatus("gemini-cli", home).sites[0].file;
  assert.equal(file, path.join(home, ".gemini", "policies", "browser-use.toml"));
  const r = addAllow("gemini-cli", home);
  assert.equal(r.sites[0].changed, true);
  const content = fs.readFileSync(file, "utf8");
  assert.match(content, /\[\[rule\]\]/);
  assert.match(content, /commandPrefix = "browser-use"/);
  assert.match(content, /decision = "allow"/);
  assert.equal(allowStatus("gemini-cli", home).sites[0].state, "allowed");
  assert.equal(removeAllow("gemini-cli", home).sites[0].changed, true);
  assert.equal(fs.existsSync(file), false);
});

test("windsurf: 目录不存在 → not_detected 跳过不落盘;目录存在 → settings.json 顶层键合并", () => {
  const home = tmpHome();
  withEnv(process.platform === "win32" ? { APPDATA: path.join(home, "AppData", "Roaming") }
    : { XDG_CONFIG_HOME: path.join(home, ".config") }, () => {
    const st = allowStatus("windsurf", home);
    assert.equal(st.sites[0].state, "not_detected");
    assert.ok(st.sites[0].hint, "须给手动配置提示");
    const r = addAllow("windsurf", home);
    assert.equal(r.sites[0].skipped, true, "目录不存在时跳过,不创建");
    assert.equal(r.sites[0].error, undefined);

    const settingsDir = path.dirname(st.sites[0].file);
    fs.mkdirSync(settingsDir, { recursive: true });
    fs.writeFileSync(st.sites[0].file, JSON.stringify({ "editor.fontSize": 13 }, null, 2));
    const r2 = addAllow("windsurf", home);
    assert.equal(r2.sites[0].changed, true);
    const after = JSON.parse(fs.readFileSync(st.sites[0].file, "utf8"));
    assert.equal(after["editor.fontSize"], 13);
    assert.deepEqual(after["windsurf.cascadeCommandsAllowList"], [BIN]);
    assert.equal(allowStatus("windsurf", home).sites[0].state, "allowed");
  });
});

test("opencode(json-map): 键追加在尾部(last-match-wins)/ 保留既有键 / 用户改值不移除 / XDG 路径", () => {
  const home = tmpHome();
  withEnv({ XDG_CONFIG_HOME: path.join(home, ".config") }, () => {
    const file = allowStatus("opencode", home).sites[0].file;
    assert.equal(file, path.join(home, ".config", "opencode", "opencode.json"));

    // 既有通配键在前,我们的键追加在尾 → 匹配序最后,压过通配
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, JSON.stringify(
      { permission: { bash: { "*": "ask", "git *": "allow" } } }, null, 2));
    const r = addAllow("opencode", home);
    assert.equal(r.sites[0].changed, true);
    const obj = JSON.parse(fs.readFileSync(file, "utf8"));
    assert.deepEqual(Object.keys(obj.permission.bash), ["*", "git *", BIN, `${BIN} *`]);
    assert.equal(obj.permission.bash[BIN], "allow");
    assert.equal(allowStatus("opencode", home).sites[0].state, "allowed");

    // 用户把我们写的键改成 ask(用户接管)→ remove 不动它
    obj.permission.bash[BIN] = "ask";
    fs.writeFileSync(file, JSON.stringify(obj, null, 2));
    removeAllow("opencode", home);
    const after = JSON.parse(fs.readFileSync(file, "utf8"));
    assert.equal(after.permission.bash[BIN], "ask");
    assert.equal(after.permission.bash[`${BIN} *`], undefined, "未改值的键正常移除");
  });
});

test("破损 JSON:拒绝改写且文件内容不变", () => {
  const home = tmpHome();
  const file = allowStatus("claude-code", home).sites[0].file;
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, "{ broken", "utf8");
  const r = addAllow("claude-code", home);
  assert.match(r.sites[0].error, /不是合法 JSON/);
  assert.equal(fs.readFileSync(file, "utf8"), "{ broken");
  assert.equal(allowStatus("claude-code", home).sites[0].state, "unreadable");
});
