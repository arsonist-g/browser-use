// 单元测试:桥扩展 service worker(extension/background.js)的 cookie + Web 存储采集。
// 扩展跑在浏览器里,node 侧没有 chrome.* —— 这里用假 chrome/WebSocket 把它放进 vm 执行,
// 测的是可测的那部分逻辑(采集范围、合并、上限、采集预算与超时、消息契约),
// 浏览器是否接受注入由 e2e 覆盖。
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
 * tabs: [{id, url}];results: tabId → executeScript 返回值(字符串 "THROW" = 注入失败,
 * "HANG" = 那个标签页永远不回话);cookies: chrome.cookies.getAll 的结果;
 * budgets: 把采集预算压到毫秒级({tab, total};不传用扩展里的默认值)。
 */
function loadBridge({ tabs = [], results = {}, cookies = [], budgets = {} } = {}) {
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
    runtime: { onMessage: { addListener: () => {} }, getManifest: () => ({ version: "0.2.1" }) },
    storage: { local: { set: () => {}, get: async () => ({}) } },
    action: { setIcon: () => {}, setBadgeText: () => {}, setBadgeBackgroundColor: () => {}, setTitle: () => {} },
    alarms: { onAlarm: { addListener: () => {} }, create: () => {} },
    cookies: { getAll: async () => cookies },
    tabs: { query: async () => tabs },
    scripting: {
      executeScript: async ({ target }) => {
        const r = results[target.tabId];
        if (r === "THROW") throw new Error(`cannot inject tab ${target.tabId}`);
        if (r === "HANG") return new Promise(() => {}); // 崩掉/被冻结/挂着对话框的页:注入永不返回
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
    __BU_STORAGE_TAB_TIMEOUT_MS: budgets.tab,
    __BU_STORAGE_TOTAL_BUDGET_MS: budgets.total,
  };
  vm.createContext(sandbox);
  try {
    vm.runInContext(SOURCE, sandbox, { filename: "background.js" });
  } catch (e) {
    errors.push(e);
  }
  const ws = sockets[0];
  /** 发一条请求并等它整段跑完,返回这一轮的回复(cookie 一条,要了存储就再加一条)。 */
  const askAll = async (msg) => {
    await ws.onmessage({ data: JSON.stringify(msg) });
    return sent.filter((m) => m.reqId === msg.reqId);
  };
  const ask = async (msg) => (await askAll(msg)).at(-1);
  /** 只发不等:用来观察采集还没跑完时的中间态(cookie 应该已经发出去了)。 */
  const fire = (msg) => ws.onmessage({ data: JSON.stringify(msg) });
  const repliesOf = (reqId, type) => sent.filter((m) => m.reqId === reqId && (!type || m.type === type));
  return { ask, askAll, fire, repliesOf, sent, errors };
}

const flush = () => new Promise((r) => setTimeout(r, 5));

test("wantStorage=false:回复只有 cookie,不打扰标签页", async () => {
  const { ask, sent, errors } = loadBridge({ cookies: [{ name: "sid", value: "v" }], tabs: [{ id: 1, url: "https://a.example/" }] });
  assert.equal(errors.length, 0, "加载 background.js 不应抛");
  const reply = await ask({ type: "getCookies", reqId: "r1" });
  assert.equal(reply.type, "cookies");
  assert.equal(reply.reqId, "r1");
  assert.equal(reply.data.length, 1);
  assert.equal(sent.length, 1, "没被要求存储就只发一条消息");
});

test("wantStorage=true:按 origin 合并打开的标签页,内建页与注入失败的页只跳过不影响其余", async () => {
  const { askAll, errors } = loadBridge({
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
  const msgs = await askAll({ type: "getCookies", reqId: "r2", wantStorage: true });
  assert.deepEqual(msgs.map((m) => m.type), ["cookies", "storage"], "cookie 一条、存储一条,顺序固定");
  assert.equal(msgs[0].data.length, 1, "cookie 与存储互不牵连");
  assert.deepEqual(JSON.parse(JSON.stringify(msgs[1].storage)), [
    { origin: "https://a.example", local: { token: "t1", other: "o" }, session: { sid: "s1" } },
    { origin: "https://b.example", local: { x: "y" }, session: {} },
  ]);
  // 内建页(edge://)不计入;其余 4 个 http(s) 页全部尝试过
  const stats = msgs[1].storageStats;
  assert.equal(stats.tabs, 4);
  assert.equal(stats.origins, 2);
  assert.equal(stats.truncated, false);
  assert.equal(stats.timed_out, 0);
  assert.equal(stats.errors.length, 1, "注入失败的页面记进 errors 而非吞掉");
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

test("标签页不回话:cookie 照常先回,该页记 timed_out 且后续轮不再试它", async () => {
  const { fire, askAll, repliesOf } = loadBridge({
    cookies: [{ name: "sid", value: "v" }],
    tabs: [{ id: 1, url: "https://ok.example/" }, { id: 2, url: "https://stuck.example/" }],
    results: { 1: [{ result: { origin: "https://ok.example", local: { a: "1" }, session: {} } }], 2: "HANG" },
    budgets: { tab: 40, total: 1000 },
  });
  const running = fire({ type: "getCookies", reqId: "r4", wantStorage: true });
  await flush();
  // 关键性质:cookie 不等采集。曾经两者同一条回复,一个卡住的标签页让整次注入超时(login=empty)
  assert.deepEqual(repliesOf("r4").map((m) => m.type), ["cookies"], "采集没跑完,cookie 已发出");
  await running;
  const stats = repliesOf("r4", "storage")[0].storageStats;
  assert.equal(stats.timed_out, 1);
  assert.equal(stats.skipped_stuck, 0, "本轮是第一次遇到它,记在 timed_out 上");
  assert.equal(repliesOf("r4", "storage")[0].storage.length, 1, "其余标签页照常采到");

  const started = Date.now();
  const second = await askAll({ type: "getCookies", reqId: "r5", wantStorage: true });
  const s2 = second[1].storageStats;
  assert.equal(s2.skipped_stuck, 1, "上一轮没回话的页这一轮直接跳过");
  assert.equal(s2.timed_out, 0, "不再为它等预算");
  assert.equal(second[1].storage.length, 1);
  assert.ok(Date.now() - started < 40, `跳过卡住的页后这一轮应当很快,实测 ${Date.now() - started}ms`);
});

test("整轮预算用尽:带着已采到的部分收工,budget_exhausted 如实置位", async () => {
  const { askAll } = loadBridge({
    cookies: [],
    tabs: [
      { id: 1, url: "https://stuck1.example/" },
      { id: 2, url: "https://stuck2.example/" },
      { id: 3, url: "https://never-reached.example/" },
    ],
    results: { 1: "HANG", 2: "HANG", 3: [{ result: { origin: "https://never-reached.example", local: { a: "1" }, session: {} } }] },
    budgets: { tab: 40, total: 60 },
  });
  const msgs = await askAll({ type: "getCookies", reqId: "r6", wantStorage: true });
  const stats = msgs[1].storageStats;
  assert.equal(stats.budget_exhausted, true);
  assert.equal(stats.timed_out, 2);
  assert.equal(stats.tabs, 2, "预算用尽后不再开始新的标签页");
  assert.deepEqual(msgs[1].storage, [], "没采到东西也不编:storage 为空");
});
