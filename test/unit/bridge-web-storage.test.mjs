// 单元测试:桥的 Web 存储通道 —— 扩展上报的 localStorage/sessionStorage 如何到达 daemon
// 覆盖:normalizeStorage 验形(跨进程输入)、wantStorage 往返、旧扩展(不回 storage)的降级。
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

/** 起一个桥 + 一个假扩展客户端;reply 决定这个"扩展"怎么答 getCookies。 */
async function withBridge(reply, fn) {
  const port = await freePort();
  const server = new BridgeServer({ port, timeoutMs: 3000, log: () => {} });
  const client = new WebSocket(`ws://127.0.0.1:${port}/?proto=1`);
  const seen = [];
  client.on("message", (raw) => {
    const m = JSON.parse(raw.toString());
    if (m.type !== "getCookies") return;
    seen.push(m);
    client.send(JSON.stringify(reply(m)));
  });
  await once(client, "open");
  try {
    return await fn(server, seen);
  } finally {
    try { client.close(); } catch { /* */ }
    server.close();
  }
}

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

test("wantStorage:daemon 明确要,扩展回 cookie + storage 两条链路", async () => {
  await withBridge(
    (m) => ({
      type: "cookies",
      reqId: m.reqId,
      data: [{ name: "sid", value: "v", domain: ".a.example" }],
      storage: [{ origin: "https://a.example", local: { token: "tk" }, session: { sid: "ss" } }],
      storageStats: { tabs: 3, read: 2, origins: 1, bytes: 42, truncated: false, errors: [] },
    }),
    async (server, seen) => {
      const cookies = await server.getCookies({ withStorage: true });
      assert.equal(cookies.length, 1, "cookie 照常返回");
      assert.equal(seen[0].wantStorage, true, "请求里必须带 wantStorage");
      const web = server.getWebStorage();
      assert.deepEqual(web.origins, [
        { origin: "https://a.example", local: { token: "tk" }, session: { sid: "ss" } },
      ]);
      assert.equal(web.stats.tabs, 3);
    });
});

test("默认不带 wantStorage:不要存储时不打扰扩展", async () => {
  await withBridge(
    (m) => ({ type: "cookies", reqId: m.reqId, data: [] }),
    async (server, seen) => {
      await server.getCookies();
      assert.equal(seen[0].wantStorage, false);
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
    if (withStorage) reply.storage = [{ origin: "https://a.example", local: { t: "1" }, session: {} }];
    client.send(JSON.stringify(reply));
  });
  await once(client, "open");
  try {
    await server.getCookies({ withStorage: true });
    assert.equal(server.getWebStorage().origins.length, 1);
    withStorage = false;
    await new Promise((r) => setTimeout(r, 2100)); // 越过 2s TTL,强制再走一次真实往返
    await server.getCookies({ withStorage: true });
    assert.deepEqual(server.getWebStorage().origins, []);
    assert.equal(server.getWebStorage().stats, null);
  } finally {
    try { client.close(); } catch { /* */ }
    server.close();
  }
});
