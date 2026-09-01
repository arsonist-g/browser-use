// 单元测试:skill 安装逻辑(路径拼接 / 复制 / 状态判定 / 覆盖保护)
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import url from "node:url";
import { AGENTS, skillTargetDir, skillStatus, installSkill, uninstallSkill, bundledSkillDir }
  from "../../lib/skills.mjs";

const ROOT = path.dirname(path.dirname(path.dirname(url.fileURLToPath(import.meta.url))));

function tmpHome() {
  return fs.mkdtempSync(path.join(os.tmpdir(), "bu-skill-test-"));
}

test("AGENTS: key 唯一且 dir 为安全的 home 相对路径", () => {
  const keys = AGENTS.map((a) => a.key);
  assert.equal(new Set(keys).size, keys.length, "key 不得重复");
  assert.ok(keys.includes("claude-code"), "claude-code 必须在候选中");
  for (const a of AGENTS) {
    assert.match(a.dir, /^[\w.\-/]+$/, "dir 只允许相对路径字符");
    assert.ok(!path.isAbsolute(a.dir), "dir 必须是相对路径");
  }
});

test("skillTargetDir: home + agent 目录 + skill 名拼接", () => {
  const home = tmpHome();
  const d = skillTargetDir("claude-code", home);
  assert.equal(d, path.join(home, ".claude", "skills", "browser-use"));
  assert.throws(() => skillTargetDir("no-such-agent", home), /unknown agent/);
});

test("install/status/uninstall: 完整生命周期", () => {
  const home = tmpHome();
  const dest = skillTargetDir("claude-code", home);
  const bundled = bundledSkillDir(ROOT);
  assert.ok(fs.existsSync(path.join(bundled, "SKILL.md")), "包内 SKILL.md 必须存在");

  assert.equal(skillStatus(ROOT, dest).state, "not_installed");

  const r = installSkill(ROOT, dest);
  assert.equal(r.ok, true);
  assert.ok(r.files >= 2, "至少 SKILL.md + SKILL-ZH.md 两个文件");
  assert.equal(skillStatus(ROOT, dest).state, "up_to_date");
  assert.ok(fs.existsSync(path.join(dest, "SKILL.md")));

  // 目标被改动 → stale;无 force 拒绝覆盖,force 覆盖
  fs.writeFileSync(path.join(dest, "SKILL.md"), "modified");
  assert.equal(skillStatus(ROOT, dest).state, "stale");
  const refused = installSkill(ROOT, dest);
  assert.equal(refused.ok, false, "stale 且无 force 必须拒绝");
  const forced = installSkill(ROOT, dest, true);
  assert.equal(forced.ok, true);
  assert.equal(skillStatus(ROOT, dest).state, "up_to_date");

  assert.equal(uninstallSkill(dest), true);
  assert.equal(fs.existsSync(dest), false);
  assert.equal(uninstallSkill(dest), false, "重复 uninstall 幂等返回 false");
});
