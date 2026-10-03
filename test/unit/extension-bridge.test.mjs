// 单元测试:桥扩展 service worker(extension/background.js)的 cookie + Web 存储采集。
// 扩展跑在浏览器里,node 侧没有 chrome.* —— 这里用假 chrome/WebSocket 把它放进 vm 执行,
// 测的是可测的那部分逻辑(采集范围、合并、上限、消息契约),浏览器是否接受注入由 e2e 覆盖。
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import url from "node:url";
import vm from "node:vm";

const ROOT = path.dirname(path.dirname(path.dirname(url.fileURLToPath(import.meta.url))));
const EXT = path.join(ROOT, "extension");
const SOURCE = fs.readFileSync(path.join(EXT, "background.js"), "utf8");

test("manifest:host_permissions 用 <all_urls>,并声明 scripting", () => {
  const m = JSON.parse(fs.readFileSync(path.join(EXT, "manifest.json"), "utf8"));
  // 实测:写成 ["http://*/*","https://*/*"] 时 chrome.cookies.getAll 返回空
  // (Chromium 的 cookie 权限过滤按 permissions_data()->GetPageAccess 逐条判定,要求 kAllowed);
  // 同仓的 Research Bridge 用 <all_urls> 正常 —— 两桥必须同构,这一条防回归。
  assert.deepEqual(m.host_permissions, ["<all_urls>"]);
  assert.ok(m.permissions.includes("cookies"), "cookie 通道仍需 cookies 权限");
  assert.ok(m.permissions.includes("scripting"), "读页内 Web 存储需要 scripting");
});

/**
 * 在假 chrome 上跑一遍 background.js。
 * tabs: [{id, url}];results: tabId → executeScript 返回值(字符串 "THROW" = 注入失败);
 * cookies: chrome.cookies.getAll 的结果。
 */
function loadBridge({ tabs = [], results = {}, cookies = [] } = {}) {
  const sent = [];
  const errors = [];
  const sockets = [];
  class FakeWebSocket {
    constructor(u) { this.url = u; this.readyState = 1; sockets.push(this); }
    send(d) { sent.push(JSON.parse(d)); }
    close() { this.readyState = 3; }
  }
  FakeWebSocket.CONNECTING = 0;
  FakeWebSocket.OPEN = 1;
  FakeWebSocket.CLOSING = 2;
  FakeWebSocket.CLOSED = 3;

  const chrome = {
    runtime: { onMessage: { addListener: () => {} }, getManifest: () => ({ version: "0.2.0" }) },
    storage: { local: { set: () => {}, get: async () => ({}) } },
    action: { setIcon: () => {}, setBadgeText: () => {}, setBadgeBackgroundColor: () => {}, setTitle: () => {} },
    alarms: { onAlarm: { addListener: () => {} }, create: () => {} },
    cookies: { getAll: async () => cookies },
    tabs: { query: async () => tabs },
    scripting: {
      executeScript: async ({ target }) => {
        const r = results[target.tabId];
        if (r === "THROW") throw new Error(`cannot inject tab ${target.tabId}`);
        return r ?? [];
      },
    },
  };

  const sandbox = {
    chrome, WebSocket: FakeWebSocket, console,
    setTimeout, clearTimeout,
    setInterval: () => 0, // 心跳轮询会把事件循环钉住,测试里不真起
    clearInterval: () => {},
    fetch: async () => { throw new Error("no daemon"); },
    OffscreenCanvas: undefined,
  };
  vm.createContext(sandbox);
  try {
    vm.runInContext(SOURCE, sandbox, { filename: "background.js" });
  } catch (e) {
    errors.push(e);
  }
  const ws = sockets[0];
  const ask = async (msg) => {
    await ws.onmessage({ data: JSON.stringify(msg) });
    return sent.at(-1);
  };
  return { ask, sent, ws, errors };
}

test("wantStorage=false:回复只有 cookie,不打扰标签页", async () => {
  const { ask, errors } = loadBridge({ cookies: [{ name: "sid", value: "v" }], tabs: [{ id: 1, url: "https://a.example/" }] });
  assert.equal(errors.length, 0, "加载 background.js 不应抛");
  const reply = await ask({ type: "getCookies", reqId: "r1" });
  assert.equal(reply.type, "cookies");
  assert.equal(reply.reqId, "r1");
  assert.equal(reply.data.length, 1);
  assert.ok(!("storage" in reply), "没被要求就不带 storage 字段");
});

test("wantStorage=true:按 origin 合并打开的标签页,内建页与注入失败的页只跳过不影响其余", async () => {
  const { ask, errors } = loadBridge({
    cookies: [{ name: "sid", value: "v" }],
    tabs: [
      { id: 1, url: "https://a.example/app" },
      { id: 2, url: "https://a.example/other" },
      { id: 3, url: "https://b.example/" },
      { id: 4, url: "edge://settings" },
      { id: 5, url: "https://boom.example/" },
      { id: 6, url: "https://a.example/app", discarded: true },
    ],
    results: {
      1: [{ result: { origin: "https://a.example", local: { token: "t1" }, session: { sid: "s1" } } }],
      2: [{ result: { origin: "https://a.example", local: { other: "o" }, session: {} } }],
      3: [{ result: { origin: "https://b.example", local: { x: "y" }, session: {} } }],
      5: "THROW",
    },
  });
  assert.equal(errors.length, 0);
  const reply = await ask({ type: "getCookies", reqId: "r2", wantStorage: true });
  assert.equal(reply.data.length, 1, "cookie 与存储互不牵连");
  assert.deepEqual(JSON.parse(JSON.stringify(reply.storage)), [
    { origin: "https://a.example", local: { token: "t1", other: "o" }, session: { sid: "s1" } },
    { origin: "https://b.example", local: { x: "y" }, session: {} },
  ]);
  // 内建页(edge://)不计入;其余 4 个 http(s) 页全部尝试过
  assert.equal(reply.storageStats.tabs, 4);
  assert.equal(reply.storageStats.origins, 2);
  assert.equal(reply.storageStats.truncated, false);
  assert.equal(reply.storageStats.errors.length, 1, "注入失败的页面记进 errors 而非吞掉");
});

test("单源超上限:超出部分丢弃,但 truncated 必须如实置位(不静默)", async () => {
  const { ask } = loadBridge({
    cookies: [],
    tabs: [{ id: 1, url: "https://huge.example/" }],
    results: {
      1: [{ result: { origin: "https://huge.example", local: { big: "x".repeat(1_100_000), small: "keep" }, session: {} } }],
    },
  });
  const reply = await ask({ type: "getCookies", reqId: "r3", wantStorage: true });
  assert.equal(reply.storage.length, 1);
  assert.equal(reply.storageStats.truncated, true);
  assert.deepEqual(Object.keys(reply.storage[0].local), ["small"]);
});
