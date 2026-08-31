// Config 单例文档读写(DEC-010):默认值 + 未知字段保留(前向兼容)
import fs from "node:fs";
import { CONFIG_PATH, ensureHome } from "./paths.mjs";

export const DEFAULTS = {
  browser_exe: null,            // null = 自动探测 Edge → Chrome
  headless_default: false,
  port_range: [18000, 18100],
  daemon_http_port: 17981,
  bridge_ws_port: 17990,
  self_heal_timeout_ms: 30000,
  bridge_req_timeout_ms: 10000,
  tool_default_timeout_ms: 30000,
  log_max_bytes: 52428800,      // 50MB,oldest-first 滚动
  whitelist_extensions: [],
  extra_flags: [],              // 逐会话追加启动 flag(如 --enable-features=WebMCP;默认不开 = CONSTRAINT-001 权衡)
  disable_extensions: false,    // true 加 --disable-extensions(实测会令 CDP Extensions 域失效)
};

let cached = null;

export function loadConfig(force = false) {
  if (cached && !force) return cached;
  ensureHome();
  let file = {};
  try {
    file = JSON.parse(fs.readFileSync(CONFIG_PATH, "utf8"));
  } catch { /* 首次无文件 */ }
  cached = { ...structuredClone(DEFAULTS), ...file };
  return cached;
}

export function saveConfig(cfg) {
  ensureHome();
  fs.writeFileSync(CONFIG_PATH, JSON.stringify(cfg, null, 2) + "\n");
  cached = cfg;
}

export function setConfigKey(key, value) {
  const cfg = loadConfig();
  if (!(key in DEFAULTS)) throw new Error(`unknown config key: ${key}`);
  const dv = DEFAULTS[key];
  if (Array.isArray(dv)) value = JSON.parse(value);
  else if (typeof dv === "number") value = Number(value);
  else if (typeof dv === "boolean") value = value === "true";
  cfg[key] = value;
  saveConfig(cfg);
  return cfg;
}

export function resetConfigKey(key) {
  const cfg = loadConfig();
  if (key && !(key in DEFAULTS)) throw new Error(`unknown config key: ${key}`);
  if (key) cfg[key] = structuredClone(DEFAULTS[key]);
  else Object.assign(cfg, structuredClone(DEFAULTS));
  saveConfig(cfg);
  return cfg;
}
