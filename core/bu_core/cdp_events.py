# -*- coding: utf-8 -*-
"""事件驱动 CDP 客户端(摸底报告结论:DP 公开 API 无事件订阅,自建 ws 客户端)。

复用会话实例的调试端口:GET /json/list 选 page target → ws 直连。
依赖:websocket-client(pip)。仅 Performance/HeapSnapshot/Screencast/WebMCP 使用。
"""
import json
import time
import urllib.request

import websocket


class CdpEvents:
    def __init__(self, port, timeout=60, recv_granularity=1):
        self.port = port
        self.timeout = timeout          # 命令级超时
        self.recv_granularity = recv_granularity  # 单次 recv 阻塞上限
        self.ws = None
        self._id = 0
        self.events = []          # (method, params) 事件队列
        self.responses = {}       # id -> result/error(命令响应)

    def connect(self):
        targets = json.loads(urllib.request.urlopen(
            f"http://127.0.0.1:{self.port}/json/list", timeout=5).read())
        pages = [t for t in targets if t.get("type") == "page"]
        if not pages:
            raise RuntimeError("no page target on debug port")
        ws_url = pages[0]["webSocketDebuggerUrl"]
        self.ws = websocket.create_connection(ws_url, timeout=self.recv_granularity, suppress_origin=True)
        return self

    def send(self, method, **params):
        """发送命令,不等待响应(响应由 pump 收进 responses)。"""
        self._id += 1
        mid = self._id
        self.ws.send(json.dumps({"id": mid, "method": method, "params": params}))
        return mid

    def call(self, method, timeout=None, **params):
        """发送命令并阻塞等待其响应(路上收到的事件进 events)。"""
        mid = self.send(method, **params)
        deadline = time.time() + (timeout or self.timeout)
        while mid not in self.responses:
            if time.time() > deadline:
                raise TimeoutError(f"CDP {method} timeout")
            self.pump()
        r = self.responses.pop(mid)
        if "error" in r:
            raise RuntimeError(f"CDP {method}: {r['error']}")
        return r.get("result", {})

    def pump(self, deadline=None):
        """非阻塞读一帧:事件入 events,命令响应入 responses。"""
        if not self.ws:
            return
        try:
            raw = self.ws.recv()
        except websocket.WebSocketTimeoutException:
            return
        if not raw:
            return
        msg = json.loads(raw)
        if "id" in msg:
            self.responses[msg["id"]] = msg
        elif "method" in msg:
            self.events.append((msg["method"], msg.get("params", {})))

    def drain_events(self, method_prefix=None):
        """取出(可选前缀过滤的)事件并清空队列。"""
        out, keep = [], []
        for m, p in self.events:
            if method_prefix is None or m.startswith(method_prefix):
                out.append((m, p))
            else:
                keep.append((m, p))
        self.events = keep
        return out

    def close(self):
        try:
            if self.ws:
                self.ws.close()
        except Exception:
            pass
