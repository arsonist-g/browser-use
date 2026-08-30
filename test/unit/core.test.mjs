// 单元测试:纯逻辑(toDpCookie 字段映射 / session_id 格式 / config)
import { test } from "node:test";
import assert from "node:assert/strict";
import { toDpCookie } from "../../lib/bridge-server.mjs";
import { newSessionId } from "../../lib/sessions.mjs";
import { DEFAULTS, setConfigKey, resetConfigKey, loadConfig } from "../../lib/config.mjs";

test("toDpCookie: chrome.cookies → DP 格式字段映射", () => {
  const out = toDpCookie({
    name: "sid", value: "abc", domain: ".example.com", path: "/p",
    expirationDate: 1788000000, httpOnly: true, secure: true,
    sameSite: "no_restriction",
  });
  assert.equal(out.name, "sid");
  assert.equal(out.expires, 1788000000, "expirationDate → expires");
  assert.equal(out.sameSite, "None", "no_restriction → None");
  assert.equal(out.httpOnly, true);
  assert.equal(out.path, "/p");
});

test("toDpCookie: 会话 cookie 无 expires;unspecified sameSite 省略", () => {
  const out = toDpCookie({ name: "s", value: "v", domain: "x.com", sameSite: "unspecified" });
  assert.ok(!("expires" in out), "无 expirationDate 时不应有 expires");
  assert.ok(!("sameSite" in out), "unspecified 映射为 null → 省略字段");
  assert.equal(out.path, "/");
});

test("newSessionId: s-时间戳-4hex 格式且递增可排序", () => {
  const id = newSessionId();
  assert.match(id, /^s-\d{8}-\d{6}-[0-9a-f]{4}$/);
});

test("config: set/set 类型转换/reset 单键恢复默认", () => {
  try {
    setConfigKey("tool_default_timeout_ms", "45000");
    assert.equal(loadConfig(true).tool_default_timeout_ms, 45000, "字符串数字 → number");
    setConfigKey("headless_default", "true");
    assert.equal(loadConfig(true).headless_default, true, "字符串 → bool");
    assert.throws(() => setConfigKey("not_a_key", "1"), /unknown config key/);
  } finally {
    resetConfigKey("tool_default_timeout_ms");
    resetConfigKey("headless_default");
  }
  const cfg = loadConfig(true);
  assert.equal(cfg.tool_default_timeout_ms, DEFAULTS.tool_default_timeout_ms);
  assert.equal(cfg.headless_default, DEFAULTS.headless_default);
});
