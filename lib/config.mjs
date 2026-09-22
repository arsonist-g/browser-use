// Config 单例文档读写(DEC-010):默认值 + 未知字段保留(前向兼容)
import fs from "node:fs";
import { CONFIG_PATH, ensureHome } from "./paths.mjs";

export const DEFAULTS = {
  browser_exe: null,            // null = 自动探测 Edge → Chrome
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

// 键/值写错一律 INVALID_ARG(见 lib/error-codes.mjs):调用方可自行改正,不是内部故障
function invalidArg(message) {
  return Object.assign(new Error(message), { code: "INVALID_ARG" });
}

function assertKnownKey(key) {
  if (!(key in DEFAULTS)) {
    throw invalidArg(`未知配置键: ${key}(可选键: ${Object.keys(DEFAULTS).join(", ")})`);
  }
}

function coerceConfigValue(key, dv, value) {
  if (Array.isArray(dv)) {
    let parsed;
    try {
      parsed = JSON.parse(value);
    } catch {
      throw invalidArg(`配置键 ${key} 需要 JSON 数组(例: '[]' 或 '["a","b"]'),收到 ${value}`);
    }
    if (!Array.isArray(parsed)) throw invalidArg(`配置键 ${key} 需要 JSON 数组,收到 ${value}`);
    return parsed;
  }
  if (typeof dv === "number") {
    const n = Number(value);
    if (!Number.isFinite(n)) throw invalidArg(`配置键 ${key} 需要数字,收到 ${value}`);
    return n;
  }
  if (typeof dv === "boolean") {
    if (value !== "true" && value !== "false") {
      throw invalidArg(`配置键 ${key} 需要 true 或 false,收到 ${value}`);
    }
    return value === "true";
  }
  return value;
}

export function setConfigKey(key, value) {
  const cfg = loadConfig();
  assertKnownKey(key);
  cfg[key] = coerceConfigValue(key, DEFAULTS[key], value);
  saveConfig(cfg);
  return cfg;
}

export function resetConfigKey(key) {
  const cfg = loadConfig();
  if (key) assertKnownKey(key);
  if (key) cfg[key] = structuredClone(DEFAULTS[key]);
  else Object.assign(cfg, structuredClone(DEFAULTS));
  saveConfig(cfg);
  return cfg;
}
