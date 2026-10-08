// 单元测试:桥的登录态读取 —— cookie 与页内 Web 存储如何到达 daemon。
// 覆盖:normalizeStorage 验形(跨进程输入)、协商 1(旧扩展捎带)与协商 2(存储单独一条消息)、
// 存储不回时不再拖住 cookie(2026-10-08 现场:一个不回话的标签页曾让整次注入超时)。
import { test } from "node:test";
import assert from "node:assert/strict";
import net from "node:net";
import { once } from "node:events";
import { WebSocket } from "ws";
import { BridgeServer, normalizeStorage } from "../../lib/bridge-server.mjs";

function freePort() {
  return new Promise((resolve, reject) => {
    const srv = net.createServer();
    srv.once("error", reject);
    srv.listen(0, "127.0.0.1", () => {
      const port = srv.address().port;
      srv.close(() => resolve(port));
    });
  });
}

/**
 * 起一个桥 + 一个假扩展客户端。hello 是扩展上线时报的协商版本(不给 = 旧扩展);
 * reply(m) 决定这个"扩展"怎么答 getCookies,返回一条或一串消息。
 */
async function withBridge({ hello, reply, fn }) {
  const port = await freePort();
  const server = new BridgeServer({ port, timeoutMs: 3000, log: () => {} });
  const client = new WebSocket(`ws://127.0.0.1:${port}/?proto=1`);
  const seen = [];
  client.on("message", (raw) => {
    const m = JSON.parse(raw.toString());
    if (m.type !== "getCookies") return;
    seen.push(m);
    for (const msg of [].concat(reply(m))) client.send(JSON.stringify(msg));
  });
  await once(client, "open");
  if (hello) {
    client.send(JSON.stringify(hello));
    for (let i = 0; i < 100 && !server.extHello; i++) await new Promise((r) => setTimeout(r, 5));
  }
  try {
    return await fn(server, seen);
  } finally {
    try { client.close(); } catch { /* */ }
    server.close();
  }
}

const storageRecord = [{ origin: "https://a.example", local: { token: "tk" }, session: { sid: "ss" } }];
const storageStats = { tabs: 3, read: 2, origins: 1, bytes: 42, truncated: false,
  timed_out: 0, skipped_stuck: 0, budget_exhausted: false, errors: [] };

test("normalizeStorage:只留形状正确的 http(s) 源,坏项丢弃", () => {
  const out = normalizeStorage([
    { origin: "https://a.example", local: { t: "1" }, session: { s: "2" } },
    { origin: "http://b.example:8443", local: { t: "1" }, session: {} },
    { origin: "file:///c:/x", local: { t: "1" }, session: {} },        // 非 http(s)
    { origin: "https://trail.example/", local: { t: "1" }, session: {} }, // 非规范 origin
    { origin: "https://empty.example", local: {}, session: {} },        // 两个桶都空
    { origin: "https://typed.example", local: { n: 5, ok: "v" }, session: [] },
    { local: { t: "1" }, session: {} },                                 // 无 origin
    null,
  ]);
  assert.deepEqual(out, [
    { origin: "https://a.example", local: { t: "1" }, session: { s: "2" } },
    { origin: "http://b.example:8443", local: { t: "1" }, session: {} },
    { origin: "https://typed.example", local: { ok: "v" }, session: {} },
  ]);
});

test("normalizeStorage:非数组输入归空(不抛)", () => {
  assert.deepEqual(normalizeStorage(undefined), []);
  assert.deepEqual(normalizeStorage(null), []);
  assert.deepEqual(normalizeStorage({ origin: "https://a.example" }), []);
});

test("协商 1(旧扩展捎带):cookie 与存储同一条回复,等存储立即返回", async () => {
  await withBridge({
    reply: (m) => ({
      type: "cookies", reqId: m.reqId, data: [{ name: "sid", value: "v", domain: ".a.example" }],
      storage: storageRecord, storageStats,
    }),
    fn: async (server, seen) => {
      const started = Date.now();
      const cookies = await server.getCookies({ withStorage: true });
      assert.equal(cookies.length, 1, "cookie 照常返回");
      assert.equal(seen[0].wantStorage, true, "请求里必须带 wantStorage");
      const web = await server.waitForWebStorage({ waitMs: 2000 });
      assert.deepEqual(web.origins, storageRecord);
      assert.equal(web.stats.tabs, 3);
      assert.equal(web.arrived, true);
      assert.ok(Date.now() - started < 100, "捎带的那条不需要等预算");
    },
  });
});

test("默认不带 wantStorage:不要存储时不打扰扩展", async () => {
  await withBridge({
    reply: (m) => ({ type: "cookies", reqId: m.reqId, data: [] }),
    fn: async (server, seen) => {
      await server.getCookies();
      assert.equal(seen[0].wantStorage, false);
    },
  });
});

test("协商 2:存储走单独一条消息 —— cookie 先结算,存储随后到", async () => {
  await withBridge({
    hello: { type: "hello", proto: 1, extVersion: "0.2.1", storageProto: 2 },
    reply: (m) => [
      { type: "cookies", reqId: m.reqId, data: [{ name: "sid", value: "v" }] },
      { type: "storage", reqId: m.reqId, storage: storageRecord, storageStats },
    ],
    fn: async (server) => {
      assert.equal(server.extStorageProto, 2);
      const cookies = await server.getCookies({ withStorage: true });
      assert.equal(cookies.length, 1);
      const web = await server.waitForWebStorage({ waitMs: 2000 });
      assert.deepEqual(web.origins, storageRecord);
      assert.equal(web.arrived, true);
      assert.equal(web.timed_out, false);
    },
  });
});

test("协商 2 但存储一直不回:cookie 照样到手;等存储到预算即收,且不再重复等", async () => {
  await withBridge({
    hello: { type: "hello", proto: 1, extVersion: "0.2.1", storageProto: 2 },
    reply: (m) => [{ type: "cookies", reqId: m.reqId, data: [{ name: "sid", value: "v" }] }],
    fn: async (server) => {
      const cookies = await server.getCookies({ withStorage: true });
      assert.equal(cookies.length, 1, "存储不回不该牵连 cookie");
      const web = await server.waitForWebStorage({ waitMs: 60 });
      assert.equal(web.timed_out, true);
      assert.equal(web.arrived, false);
      assert.deepEqual(web.origins, []);
      assert.equal(web.stats, null);
      const again = Date.now();
      const second = await server.waitForWebStorage({ waitMs: 60 });
      assert.equal(second.timed_out, true, "同一轮已经放弃过:如实报超时");
      assert.ok(Date.now() - again < 20, "同一轮不再重复等预算");
    },
  });
});

test("旧扩展(回复里没有 storage):cookie 仍成功,存储降级为空且不残留上一轮", async () => {
  // 先来一轮带 storage 的,再来一轮不带的:第二轮必须把上一轮的值清掉,不能拿旧值冒充
  const port = await freePort();
  const server = new BridgeServer({ port, timeoutMs: 3000, log: () => {} });
  const client = new WebSocket(`ws://127.0.0.1:${port}/?proto=1`);
  let withStorage = true;
  client.on("message", (raw) => {
    const m = JSON.parse(raw.toString());
    if (m.type !== "getCookies") return;
    const reply = { type: "cookies", reqId: m.reqId, data: [] };
    if (withStorage) reply.storage = storageRecord;
    client.send(JSON.stringify(reply));
  });
  await once(client, "open");
  try {
    await server.getCookies({ withStorage: true });
    assert.equal((await server.waitForWebStorage({ waitMs: 1000 })).origins.length, 1);
    withStorage = false;
    await new Promise((r) => setTimeout(r, 2100)); // 越过 2s TTL,强制再走一次真实往返
    await server.getCookies({ withStorage: true });
    const web = await server.waitForWebStorage({ waitMs: 1000 });
    assert.deepEqual(web.origins, []);
    assert.equal(web.stats, null);
    assert.equal(web.arrived, false, "旧扩展没回存储这一问 = reported=false,由调用方如实转述");
  } finally {
    try { client.close(); } catch { /* */ }
    server.close();
  }
});
