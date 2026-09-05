// 命令放行(approval allowlist):把 browser-use 命令写入各 coding agent 的放行配置,
// 使 agent 会话内调用 browser-use 免逐次审批。每个站点(site)的机制、路径、值形态
// 须以官方文档核实后才登记(source 字段留痕);官方未发布的信息(如 Windsurf 的配置
// 文件路径)按产品惯例处理并配护栏(目录存在才写)。
//
// 站点三形态:
//   "json-array"  规则字符串并入 JSON 数组(幂等追加/移除,其余键原样)
//   "json-map"    pattern→action 对象追加键(opencode last-match-wins,追加在尾 = 最高优先)
//   "owned-file"  整文件归我们所有(专属文件);内容不符时拒绝动它,防吞用户手写规则
import fs from "node:fs";
import path from "node:path";

// 放行规则匹配的是 agent 看到的命令字符串;本项目 bin 名固定 browser-use(DEC-009)
const BIN = "browser-use";

// 各站点配置目录解析(home = 用户主目录;env 重定向优先,与各家官方语义一致)
const D = {
  claude: (home) => process.env.CLAUDE_CONFIG_DIR ?? path.join(home, ".claude"),
  codex: (home) => path.join(home, ".codex"),
  cursor: (home) => path.join(home, ".cursor"),
  gemini: (home) => path.join(home, ".gemini"),
  opencode: (home) => {
    if (process.env.OPENCODE_CONFIG) return path.dirname(process.env.OPENCODE_CONFIG);
    return path.join(process.env.XDG_CONFIG_HOME ?? path.join(home, ".config"), "opencode");
  },
  windsurf: (home) => {
    if (process.platform === "win32") {
      return path.join(process.env.APPDATA ?? path.join(home, "AppData", "Roaming"), "Windsurf", "User");
    }
    if (process.platform === "darwin") {
      return path.join(home, "Library", "Application Support", "Windsurf", "User");
    }
    return path.join(process.env.XDG_CONFIG_HOME ?? path.join(home, ".config"), "Windsurf", "User");
  },
};

// Codex rules 引擎(Starlark):pattern 为 argv 前缀,decision 默认即 allow(显式写出)
const CODEX_RULES = `# Managed by browser-use (\`browser-use allow --remove\` deletes this file).
prefix_rule(
    pattern = ["${BIN}"],
    decision = "allow",
    justification = "browser-use browser automation CLI",
)
`;

// Gemini 策略引擎(TOML):commandPrefix 前缀匹配命令串;User tier 覆盖默认策略
const GEMINI_TOML = `# Managed by browser-use (\`browser-use allow --remove\` deletes this file).
[[rule]]
toolName = "run_shell_command"
commandPrefix = "${BIN}"
decision = "allow"
priority = 100
`;

export const ALLOW_TARGETS = [
  { key: "claude-code", label: "Claude Code", sites: [
    // `:*` = 尾部通配(等价 Bash(cmd *)),且匹配裸命令;复合命令逐段独立匹配,不受连带放行
    { kind: "json-array", dir: D.claude, file: "settings.json",
      arrayPath: ["permissions", "allow"], rules: [`Bash(${BIN}:*)`],
      source: "code.claude.com/docs/en/permissions + /settings" },
  ]},
  { key: "codex", label: "Codex CLI", sites: [
    { kind: "owned-file", dir: D.codex, file: path.join("rules", "browser-use.rules"),
      content: CODEX_RULES, marker: `pattern = ["${BIN}"]`,
      source: "developers.openai.com/codex/rules" },
  ]},
  { key: "cursor", label: "Cursor", sites: [
    // IDE:permissions.json 定义 terminalAllowlist 后整体覆盖设置 UI 的同名列表
    { kind: "json-array", dir: D.cursor, file: "permissions.json",
      arrayPath: ["terminalAllowlist"], rules: [BIN],
      warning: "permissions.json 定义 terminalAllowlist 后,Cursor 设置 UI 的终端允许列表被此文件整体取代(UI 编辑器转只读);若 UI 里有自添条目,请先并入本文件。",
      source: "cursor.com/docs/reference/permissions" },
    // CLI(cursor-agent):Shell(commandBase) 按命令首词匹配,allow 规则与审批模式无关
    { kind: "json-array", dir: D.cursor, file: "cli-config.json",
      arrayPath: ["permissions", "allow"], rules: [`Shell(${BIN})`],
      source: "cursor.com/docs/cli/reference/permissions" },
  ]},
  { key: "gemini-cli", label: "Gemini CLI", sites: [
    { kind: "owned-file", dir: D.gemini, file: path.join("policies", "browser-use.toml"),
      content: GEMINI_TOML, marker: `commandPrefix = "${BIN}"`,
      source: "geminicli.com/docs/reference/policy-engine" },
  ]},
  { key: "windsurf", label: "Windsurf", sites: [
    // settings key 官方已核实(前缀语义:git 覆盖 git add -A);文件位置/值形态按 VS Code
    // settings 模型推断 —— 护栏:用户设置目录不存在时报 not_detected,不凭空建目录
    { kind: "json-array", dir: D.windsurf, file: "settings.json",
      arrayPath: ["windsurf.cascadeCommandsAllowList"], rules: [BIN],
      requireExistingDir: true,
      hint: "未检测到 Windsurf 用户设置目录;可手动配置:Settings UI 搜索 windsurf.cascadeCommandsAllowList,添加 browser-use(前缀语义)。",
      source: "docs.windsurf.com/windsurf/terminal(key);文件位置按 VS Code 模型" },
  ]},
  { key: "opencode", label: "opencode", sites: [
    // 对象键序即匹配序(last-match-wins):我们的键追加在尾部,压过既有通配键
    { kind: "json-map", dir: D.opencode,
      file: process.env.OPENCODE_CONFIG ? path.basename(process.env.OPENCODE_CONFIG) : "opencode.json",
      mapPath: ["permission", "bash"], keys: [BIN, `${BIN} *`], value: "allow",
      source: "opencode.ai/docs/permissions + /docs/config" },
  ]},
];

export function findTarget(agentKey) {
  const t = ALLOW_TARGETS.find((a) => a.key === agentKey);
  if (!t) throw Object.assign(
    new Error(`unknown agent: ${agentKey}(valid: ${ALLOW_TARGETS.map((a) => a.key).join(", ")}, all)`),
    { code: "INVALID_ARG" });
  return t;
}

function siteFile(site, home) {
  return path.join(site.dir(home), site.file);
}

// ---- JSON 读写与路径定位 ----

// 非法 JSON → 抛错且绝不改写用户配置
function readJson(file) {
  if (!fs.existsSync(file)) return {};
  const raw = fs.readFileSync(file, "utf8");
  if (!raw.trim()) return {};
  try {
    return JSON.parse(raw);
  } catch (e) {
    throw Object.assign(
      new Error(`${file} 不是合法 JSON,已放弃修改(${e.message});请手工修复后再试`),
      { code: "INVALID_ARG" });
  }
}

// 定位 path 指向的容器(数组或对象);create 时逐级创建(中间层为对象),类型不符抛错
function containerAt(obj, nodePath, create, wantArray) {
  let node = obj;
  for (let i = 0; i < nodePath.length - 1; i++) {
    const k = nodePath[i];
    if (node[k] == null) {
      if (!create) return null;
      node[k] = {};
    } else if (typeof node[k] !== "object" || Array.isArray(node[k])) {
      throw Object.assign(new Error(`配置路径 ${nodePath.slice(0, i + 1).join(".")} 不是对象,无法写入放行规则`),
        { code: "INVALID_ARG" });
    }
    node = node[k];
  }
  const leaf = nodePath[nodePath.length - 1];
  if (node[leaf] == null) {
    if (!create) return null;
    node[leaf] = wantArray ? [] : {};
  }
  const ok = wantArray ? Array.isArray(node[leaf]) : (typeof node[leaf] === "object" && !Array.isArray(node[leaf]));
  if (!ok) {
    throw Object.assign(new Error(`配置路径 ${nodePath.join(".")} 应为${wantArray ? "数组" : "对象"},无法写入放行规则`),
      { code: "INVALID_ARG" });
  }
  return node[leaf];
}

function writeJson(file, obj) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, JSON.stringify(obj, null, 2) + "\n", "utf8");
}

// 沿 nodePath 自底向上剪空:叶子空 → 从父级删键;上层对象因此为空 → 递归删;根空 → 删文件。
// 只动我们这条路径上的键(Cursor 语义:空 terminalAllowlist 仍覆盖 UI 且不回退,必须剪掉)
function pruneEmptyAndWrite(file, obj, nodePath) {
  for (let depth = nodePath.length; depth > 0; depth--) {
    const parent = depth === 1 ? obj : containerAt(obj, nodePath.slice(0, depth - 1), false, false);
    if (!parent) break;
    const leaf = parent[nodePath[depth - 1]];
    if (leaf == null || typeof leaf !== "object" || Object.keys(leaf).length > 0) break;
    delete parent[nodePath[depth - 1]];
  }
  if (Object.keys(obj).length === 0) {
    fs.rmSync(file);
    return true;   // 文件已删
  }
  writeJson(file, obj);
  return false;
}

// ---- 单站点三形态的状态/添加/移除 ----

function siteStatus(site, home) {
  const file = siteFile(site, home);
  const base = { file };
  if (site.requireExistingDir && !fs.existsSync(path.dirname(file))) {
    return { ...base, state: "not_detected", hint: site.hint };
  }
  try {
    if (site.kind === "owned-file") {
      if (!fs.existsSync(file)) return { ...base, state: "not_allowed" };
      const raw = fs.readFileSync(file, "utf8");
      return raw.includes(site.marker) ? { ...base, state: "allowed" }
        : { ...base, state: "foreign", reason: "专属文件已存在但不含本工具规则(疑似用户手写),拒绝自动处理" };
    }
    const obj = readJson(file);
    if (site.kind === "json-array") {
      const arr = containerAt(obj, site.arrayPath, false, true);
      const missing = site.rules.filter((r) => !arr?.includes(r));
      return { ...base, state: missing.length ? "not_allowed" : "allowed" };
    }
    const map = containerAt(obj, site.mapPath, false, false);
    const missing = site.keys.filter((k) => map?.[k] !== site.value);
    return { ...base, state: missing.length ? "not_allowed" : "allowed" };
  } catch (e) {
    return { ...base, state: "unreadable", reason: e.message };
  }
}

function siteAdd(site, home) {
  const file = siteFile(site, home);
  if (site.requireExistingDir && !fs.existsSync(path.dirname(file))) {
    return { file, skipped: true, hint: site.hint };
  }
  if (site.kind === "owned-file") {
    if (fs.existsSync(file)) {
      const raw = fs.readFileSync(file, "utf8");
      if (raw.includes(site.marker)) return { file, changed: false };
      throw Object.assign(new Error(`${file} 已存在但不含本工具规则(疑似用户手写);请手工合并,不动该文件`),
        { code: "INVALID_ARG" });
    }
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, site.content, "utf8");
    return { file, changed: true, created: true };
  }
  const obj = readJson(file);
  if (site.kind === "json-array") {
    const arr = containerAt(obj, site.arrayPath, true, true);
    const added = site.rules.filter((r) => !arr.includes(r));
    if (added.length) {
      arr.push(...added);
      writeJson(file, obj);
    }
    return { file, changed: added.length > 0, added };
  }
  const map = containerAt(obj, site.mapPath, true, false);
  const added = site.keys.filter((k) => map[k] !== site.value);
  for (const k of added) map[k] = site.value;   // 追加在尾部 = 匹配序最后(last-match-wins)
  if (added.length) writeJson(file, obj);
  return { file, changed: added.length > 0, added };
}

function siteRemove(site, home) {
  const file = siteFile(site, home);
  if (site.requireExistingDir && !fs.existsSync(path.dirname(file))) {
    return { file, skipped: true, hint: site.hint };
  }
  if (site.kind === "owned-file") {
    if (!fs.existsSync(file)) return { file, changed: false };
    const raw = fs.readFileSync(file, "utf8");
    if (raw === site.content) {
      fs.rmSync(file);
      return { file, changed: true, removed: true };
    }
    if (raw.includes(site.marker)) {
      throw Object.assign(new Error(`${file} 内容与本工具写入时不一致(可能被手工改过);请手工删除`),
        { code: "INVALID_ARG" });
    }
    return { file, changed: false };   // foreign 文件:不含我们的规则,无须处理
  }
  const obj = readJson(file);
  if (site.kind === "json-array") {
    const arr = containerAt(obj, site.arrayPath, false, true);
    const removed = site.rules.filter((r) => arr?.includes(r));
    if (removed.length) {
      for (const r of removed) arr.splice(arr.indexOf(r), 1);
      return { file, changed: true, removed, fileDeleted: pruneEmptyAndWrite(file, obj, site.arrayPath) };
    }
    return { file, changed: false, removed };
  }
  const map = containerAt(obj, site.mapPath, false, false);
  const removed = site.keys.filter((k) => map && map[k] === site.value);
  for (const k of removed) delete map[k];   // 用户改过值的键不动
  if (removed.length) {
    return { file, changed: true, removed, fileDeleted: pruneEmptyAndWrite(file, obj, site.mapPath) };
  }
  return { file, changed: false, removed };
}

// ---- 面向 CLI 的聚合面 ----

export function allowStatus(agentKey, home) {
  const t = findTarget(agentKey);
  const sites = t.sites.map((s) => siteStatus(s, home));
  return { agent: t.key, state: sites.every((s) => s.state === "allowed") ? "allowed" : "partial",
    sites };
}

export function addAllow(agentKey, home) {
  const t = findTarget(agentKey);
  return { agent: t.key, sites: t.sites.map((s) => {
    try {
      const r = siteAdd(s, home);
      return { ...r, warning: s.warning };
    } catch (e) {
      return { file: siteFile(s, home), error: e.message };
    }
  }) };
}

export function removeAllow(agentKey, home) {
  const t = findTarget(agentKey);
  return { agent: t.key, sites: t.sites.map((s) => {
    try {
      return siteRemove(s, home);
    } catch (e) {
      return { file: siteFile(s, home), error: e.message };
    }
  }) };
}
