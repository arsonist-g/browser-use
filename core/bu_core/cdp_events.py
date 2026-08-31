# -*- coding: utf-8 -*-
"""事件驱动 CDP 客户端(摸底报告结论:DP 公开 API 无事件订阅,自建 ws 客户端)。

复用会话实例的调试端口:GET /json/list 选 page target → ws 直连。
依赖:websocket-client(pip)。仅 Performance/HeapSnapshot/Screencast/WebMCP 使用。
"""
import json
import os
import time
import urllib.error
import urllib.request

import websocket


def pipe_call(session_id, method, timeout=30, **params):
    """经 daemon 的 /pipe/cdp 端点调浏览器级(pipe 通道)CDP。
    Target.createBrowserContext 等 browser 端点命令只有这条通道可达。"""
    daemon_port = os.environ.get("BU_DAEMON_PORT", "17981")
    params = {k: v for k, v in params.items() if v is not None}  # null 参数会被 CDP 拒收
    body = json.dumps({"session_id": session_id, "method": method,
                       "params": params, "timeout_ms": int(timeout * 1000)}).encode("utf-8")
    req = urllib.request.Request(f"http://127.0.0.1:{daemon_port}/pipe/cdp", data=body,
                                 headers={"Content-Type": "application/json"})
    try:
        with urllib.request.urlopen(req, timeout=timeout + 5) as r:
            resp = json.loads(r.read())
    except urllib.error.HTTPError as e:
        try:
            err = json.loads(e.read()).get("error", {})
        except Exception:
            err = {"message": f"HTTP {e.code}"}
        raise RuntimeError(f"pipe CDP {method}: {err.get('message', err)}") from None
    if not resp.get("ok"):
        raise RuntimeError(f"pipe CDP {method}: {resp.get('error', {}).get('message', resp)}")
    return resp.get("result", {})


class CdpEvents:
    def __init__(self, port, timeout=60, recv_granularity=1):
        self.port = port
        self.timeout = timeout          # 命令级超时
        self.recv_granularity = recv_granularity  # 单次 recv 阻塞上限
        self.ws = None
        self.target_id = None           # 绑定的 page target(tab 创建/关闭后 /json/list 顺序会变)
        self._id = 0
        self.events = []          # (method, params) 事件队列
        self.responses = {}       # id -> result/error(命令响应)

    def connect(self, target_id=None):
        """连接调试端口上的 page target;优先绑定指定 target(tab 侧一致性),
        否则退回 pages[0]。"""
        targets = json.loads(urllib.request.urlopen(
            f"http://127.0.0.1:{self.port}/json/list", timeout=5).read())
        pages = [t for t in targets if t.get("type") == "page"]
        pick = next((t for t in pages if t.get("id") == target_id), None) \
            or (pages[0] if pages else None)
        if not pick:
            raise RuntimeError("no page target on debug port")
        self.target_id = pick.get("id")
        self.ws = websocket.create_connection(pick["webSocketDebuggerUrl"],
                                              timeout=self.recv_granularity, suppress_origin=True)
        return self

    def reconnect(self):
        """断线自愈:关旧 ws,重连原 target(target 已关则退回 pages[0]);事件/待决队列作废。"""
        self.close()
        self.events.clear()
        self.responses.clear()
        return self.connect(self.target_id)

    def send(self, method, **params):
        """发送命令,不等待响应(响应由 pump 收进 responses)。断线时重连重发一次。"""
        self._id += 1
        mid = self._id
        msg = json.dumps({"id": mid, "method": method, "params": params})
        try:
            self.ws.send(msg)
        except Exception:
            self.reconnect()
            self.ws.send(msg)
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
        """非阻塞读一帧:事件入 events,命令响应入 responses。
        连接被浏览器侧断开时置空 ws(置灰),下次 send 触发重连。"""
        if not self.ws:
            return
        try:
            raw = self.ws.recv()
        except websocket.WebSocketTimeoutException:
            return
        except Exception:
            try:
                self.ws.close()
            except Exception:
                pass
            self.ws = None
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


def ensure_session_cdp(sess):
    """会话级 CdpEvents 单例:绑定当前 tab 的 target(供 performance/memory/screencast/
    WebMCP/upload 兜底共用)。"""
    if getattr(sess, "_cdp", None) is None:
        sess._cdp = CdpEvents(sess.port).connect(getattr(sess.t, "_target_id", None))
    return sess._cdp
