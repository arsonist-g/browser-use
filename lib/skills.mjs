// skill 安装:把包内 skills/browser-use/ 复制到各 code agent 的 skills 目录。
// 各 agent 的注入路径以官方文档核实为准(来源见表内 source;README 同步)。
import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";

const SKILL_NAME = "browser-use";
const BUNDLED_SUBDIR = "skills/browser-use";

// dir 为用户主目录的相对路径(跨平台 path.join 拼接)。路径均经各官方文档核实(2026-08-31,
// 来源见 source;公开版同步写进 README):
// - claude-code: code.claude.com/docs/en/skills(~/.claude/skills/<name>/)
// - codex:       developers.openai.com/codex/skills(USER 级 $HOME/.agents/skills;旧 ~/.codex/skills 已迁移,不作目标)
// - cursor:      cursor.com/docs/skills(~/.cursor/skills/)
// - gemini-cli:  geminicli.com/docs/cli/skills + github.com/google-gemini/gemini-cli(~/.gemini/skills/)
// - windsurf:    docs.windsurf.com/windsurf/cascade/skills(~/.codeium/windsurf/skills/)
// 四家(Codex/Cursor/Gemini/Windsurf)也共同读取跨厂商目录 ~/.agents/skills;此处仍按各家
// 专属目录写入,使每个 agent 可独立 install/uninstall,互不耦合。
export const AGENTS = [
  { key: "claude-code", label: "Claude Code", dir: ".claude/skills",
    source: "code.claude.com/docs/en/skills" },
  { key: "codex", label: "Codex CLI", dir: ".agents/skills",
    source: "developers.openai.com/codex/skills" },
  { key: "cursor", label: "Cursor", dir: ".cursor/skills",
    source: "cursor.com/docs/skills" },
  { key: "gemini-cli", label: "Gemini CLI", dir: ".gemini/skills",
    source: "geminicli.com/docs/cli/skills" },
  { key: "windsurf", label: "Windsurf", dir: ".codeium/windsurf/skills",
    source: "docs.windsurf.com/windsurf/cascade/skills" },
];

export function bundledSkillDir(pkgRoot) {
  return path.join(pkgRoot, ...BUNDLED_SUBDIR.split("/"));
}

export function skillTargetDir(agentKey, home) {
  const agent = AGENTS.find((a) => a.key === agentKey);
  if (!agent) throw Object.assign(new Error(`unknown agent: ${agentKey}(valid: ${AGENTS.map((a) => a.key).join(", ")})`),
    { code: "INVALID_ARG" });
  return path.join(home, ...agent.dir.split("/"), SKILL_NAME);
}

function sha256(file) {
  return crypto.createHash("sha256").update(fs.readFileSync(file)).digest("hex");
}

// 已安装且与包内 SKILL.md 一致 → up_to_date;已装但不一致 → stale;未装 → not_installed
export function skillStatus(pkgRoot, destDir) {
  const destMain = path.join(destDir, "SKILL.md");
  const srcMain = path.join(bundledSkillDir(pkgRoot), "SKILL.md");
  if (!fs.existsSync(destMain)) return { state: "not_installed", destDir };
  if (fs.existsSync(srcMain) && sha256(srcMain) === sha256(destMain)) {
    return { state: "up_to_date", destDir };
  }
  return { state: "stale", destDir };
}

export function copySkill(pkgRoot, destDir) {
  const src = bundledSkillDir(pkgRoot);
  fs.mkdirSync(destDir, { recursive: true });
  let n = 0;
  for (const entry of fs.readdirSync(src, { withFileTypes: true })) {
    const from = path.join(src, entry.name);
    const to = path.join(destDir, entry.name);
    if (entry.isDirectory()) fs.cpSync(from, to, { recursive: true });
    else fs.copyFileSync(from, to);
    n++;
  }
  return n;
}

// 已存在且内容不同 → 拒绝并要求 --force(返回 false);一致或不存在 → 执行
export function installSkill(pkgRoot, destDir, force = false) {
  const st = skillStatus(pkgRoot, destDir);
  if (st.state === "stale" && !force) return { ok: false, reason: "stale" };
  const n = copySkill(pkgRoot, destDir);
  return { ok: true, files: n };
}

export function uninstallSkill(destDir) {
  if (!fs.existsSync(destDir)) return false;
  fs.rmSync(destDir, { recursive: true, force: true });
  return true;
}
