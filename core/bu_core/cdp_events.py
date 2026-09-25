# -*- coding: utf-8 -*-
"""事件驱动 CDP 客户端(摸底报告结论:DP 公开 API 无事件订阅,自建 ws 客户端)。

复用会话实例的调试端口:GET /json/list 选 page target → ws 直连。
依赖:websocket-client(pip)。仅 Performance/HeapSnapshot/Screencast/WebMCP 使用。
"""
import json
import os
import select
import threading
import time
import urllib.error
import urllib.request

import websocket

from .errors import BrowserUnavailable, CdpError, CoreCallTimeout, PipeUnavailable, StateExpiredError

# 引用失效类 CDP 报错的特征:uid(元素引用)、执行上下文、对象句柄在页面重渲染/重建后
# 都会被浏览器作废,而调用方手里的引用看起来仍然有效(uid_map 里还在)。这类错误对 AI
# 是"手里的引用过期了",必须报 STATE_EXPIRED(刷新状态后可重试);报成 CDP_ERROR
# (不可重试)会让 AI 以为协议/会话坏了而放弃任务。其余 CDP 错误仍归 CDP_ERROR。
_STALE_REFERENCE_MARKERS = (
    "no node found for given backend id",
    "could not find node with given id",
    "invalid node id",
    "node is detached from document",
    "does not belong to the document",
    "could not find object with given id",
    "cannot find context with specified id",
    "execution context was destroyed",
)


def _cdp_error_text(detail):
    """CDP 错误正文:取 message(而非整个 error 对象),AI 读到的才是原因本身。"""
    if isinstance(detail, dict):
        msg = detail.get("message")
        return msg.strip() if isinstance(msg, str) and msg.strip() else json.dumps(detail, ensure_ascii=False)
    text = str(detail)
    # pipe 通道把 error 对象当字符串回传(JSON 文本):能解出 message 就用 message
    if text.strip().startswith("{"):
        try:
            obj = json.loads(text)
        except ValueError:
            obj = None
        if isinstance(obj, dict) and isinstance(obj.get("message"), str) and obj["message"].strip():
            return obj["message"].strip()
    return text


def cdp_failure(method, detail, label="CDP"):
    """CDP 错误 → 失败分类(码即真原因)。detail 为 error 对象或其 JSON 文本。"""
    text = _cdp_error_text(detail)
    low = text.lower()
    if any(m in low for m in _STALE_REFERENCE_MARKERS):
        return StateExpiredError(
            f"{method} 引用的页面状态已失效({text});请重新 take_snapshot / list 后用新 id 重试")
    return CdpError(f"{label} {method}: {text}")


# daemon 侧已经给出的失败码(码表见 lib/error-codes.mjs):它们比"协议层失败"更具体,
# 折叠成 CDP_ERROR 会让 AI 以为会话坏了而放弃(port-only 会话调 PWA 工具即此类)。
_DAEMON_CODE_FAILURES = {
    "PIPE_UNAVAILABLE": PipeUnavailable,
    "BROWSER_NOT_RUNNING": BrowserUnavailable,
    "CORE_TIMEOUT": CoreCallTimeout,
}


def _daemon_failure(method, err):
    """daemon /pipe/cdp 的失败体 → 失败分类:它给的码优先,码表外的仍按协议错误归类。"""
    message = err.get("message", err)
    text = message if isinstance(message, str) else json.dumps(message, ensure_ascii=False)
    cls = _DAEMON_CODE_FAILURES.get(err.get("code"))
    return cls(text) if cls is not None else cdp_failure(method, text, label="pipe CDP")


def pipe_call(session_id, method, timeout=30, **params):
    """经 daemon 的 /pipe/cdp 端点调浏览器级 CDP(daemon 按域名选浏览器级 ws 或 pipe)。
    调用方不关心通道:Target/Extensions 走 ws(port-only 会话同样成立),PWA 走 pipe。"""
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
        raise _daemon_failure(method, err) from None
    if not resp.get("ok"):
        raise _daemon_failure(method, resp.get("error") or {})
    return resp.get("result", {})


class BrowserNetworkRecorder:
    """浏览器级 Network 采集器:新 page target 暂停→Network.enable→放行。

    浏览器级 auto-attach 先于渲染进程执行,配合 Network.enable 可捕获新标签页
    导航首包;Runtime.runIfWaitingForDebugger 只负责放行暂停 target,不启用 Runtime 域。
    事件按 target 分桶,主线程按当前 tab 取用;DP listen 仍是主体,采集器用于补齐
    DP 对象尚未挂载的早期请求。
    """

    _BODY_TYPES = {"document", "xhr", "fetch"}
    _MAX_BODY_BYTES = 5 * 1024 * 1024

    def __init__(self, port):
        self.port = port
        self.ws = None
        self.error = None
        self._id = 0
        self._stop = threading.Event()
        self._ready = threading.Event()
        self._thread = None
        self._lock = threading.Lock()
        self._sessions = {}       # CDP sessionId -> targetId
        self._requests = {}       # (targetId, requestId) -> record
        self._order = []          # request keys in arrival order
        self._body_wait = {}      # command id -> request key
        self._send_lock = threading.Lock()

    def start(self):
        self._thread = threading.Thread(target=self._run, name="bu-net-recorder", daemon=True)
        self._thread.start()
        self._ready.wait(8)
        return self

    def close(self):
        self._stop.set()
        try:
            if self.ws:
                self.ws.close()
        except Exception:
            pass
        if self._thread and self._thread.is_alive():
            self._thread.join(timeout=1.5)

    def records_for_target(self, target_id):
        with self._lock:
            return [dict(self._requests[k]) for k in self._order
                    if k[0] == target_id and k in self._requests]

    def _send(self, method, session_id=None, **params):
        with self._send_lock:
            self._id += 1
            mid = self._id
            msg = {"id": mid, "method": method, "params": params}
            if session_id:
                msg["sessionId"] = session_id
            self.ws.send(json.dumps(msg))
            return mid

    def _run(self):
        try:
            version = json.loads(urllib.request.urlopen(
                f"http://127.0.0.1:{self.port}/json/version", timeout=5).read())
            ws_url = version.get("webSocketDebuggerUrl")
            if not ws_url:
                raise BrowserUnavailable("browser websocket unavailable")
            self.ws = websocket.create_connection(
                ws_url, timeout=0.25, suppress_origin=True)
            self._send("Target.setAutoAttach", autoAttach=True,
                       waitForDebuggerOnStart=True, flatten=True,
                       filter=[{"type": "page", "exclude": False}])
            self._ready.set()
            while not self._stop.is_set():
                try:
                    raw = self.ws.recv()
                except websocket.WebSocketTimeoutException:
                    continue
                except Exception:
                    if self._stop.is_set():
                        break
                    raise
                if raw:
                    self._on_message(json.loads(raw))
        except Exception as e:
            self.error = f"{type(e).__name__}: {e}"
            self._ready.set()

    def _on_message(self, msg):
        if "id" in msg:
            key = self._body_wait.pop(msg["id"], None)
            if key is not None and "result" in msg:
                with self._lock:
                    rec = self._requests.get(key)
                    if rec is not None:
                        rec["body"] = msg["result"].get("body")
                        rec["base64_encoded"] = bool(msg["result"].get("base64Encoded"))
            return
        method = msg.get("method")
        params = msg.get("params") or {}
        sid = msg.get("sessionId")
        if method == "Target.attachedToTarget":
            ti = params.get("targetInfo") or {}
            child_sid = params.get("sessionId")
            if ti.get("type") == "page" and ti.get("targetId") and child_sid:
                with self._lock:
                    self._sessions[child_sid] = ti["targetId"]
                self._send("Network.enable", session_id=child_sid)
                if params.get("waitingForDebugger"):
                    self._send("Runtime.runIfWaitingForDebugger", session_id=child_sid)
            return
        if method == "Target.detachedFromTarget":
            child_sid = params.get("sessionId")
            with self._lock:
                self._sessions.pop(child_sid, None)
            return
        if not method or not method.startswith("Network."):
            return
        target_id = self._sessions.get(sid)
        if not target_id:
            return
        request_id = params.get("requestId")
        if not request_id:
            return
        key = (target_id, request_id)
        with self._lock:
            if method == "Network.requestWillBeSent":
                req = params.get("request") or {}
                rec = {
                    "requestId": request_id,
                    "target_id": target_id,
                    "session_id": sid,
                    "method": req.get("method"),
                    "url": req.get("url"),
                    "requestHeaders": req.get("headers") or {},
                    "postData": req.get("postData"),
                    "resourceType": params.get("type") or "Other",
                    "status": None,
                    "statusText": None,
                    "responseHeaders": {},
                    "mimeType": None,
                    "protocol": None,
                    "body": None,
                    "base64_encoded": False,
                    "finished": False,
                    "failed": False,
                    "errorText": None,
                    "encodedDataLength": None,
                }
                self._requests[key] = rec
                self._order.append(key)
            rec = self._requests.get(key)
            if rec is None:
                return
            if method == "Network.responseReceived":
                resp = params.get("response") or {}
                rec["status"] = resp.get("status")
                rec["statusText"] = resp.get("statusText")
                rec["responseHeaders"] = resp.get("headers") or {}
                rec["mimeType"] = resp.get("mimeType")
                rec["protocol"] = resp.get("protocol")
            elif method == "Network.loadingFinished":
                rec["finished"] = True
                rec["encodedDataLength"] = params.get("encodedDataLength")
                if (rec.get("resourceType") in self._BODY_TYPES
                        and (rec.get("encodedDataLength") or 0) <= self._MAX_BODY_BYTES):
                    mid = self._send("Network.getResponseBody",
                                     session_id=rec["session_id"], requestId=request_id)
                    self._body_wait[mid] = key
            elif method == "Network.loadingFailed":
                rec["failed"] = True
                rec["errorText"] = params.get("errorText")

class CdpEvents:
    def __init__(self, port, timeout=60, recv_granularity=0.25):
        self.port = port
        self.timeout = timeout          # 命令级超时
        self.recv_granularity = recv_granularity  # 单次 recv 阻塞上限
        self.ws = None
        self.target_id = None           # 绑定的 page target(tab 创建/关闭后 /json/list 顺序会变)
        self._id = 0
        self.events = []          # (method, params) 事件队列
        self.responses = {}       # id -> result/error(命令响应)
        self._abandoned = set()   # 超时放弃的命令 id(pump 收到迟到响应即弃)
        self.child_sessions = {}  # OOPIF 子 sessionId -> targetInfo(flatten auto-attach 登记)
        self.dialog_state = None  # 挂起的 JS 弹窗 {"type","message"};None=无(javascriptDialogOpening/Closed 登记)

    def connect(self, target_id=None):
        """连接调试端口上的 page target;优先绑定指定 target(tab 侧一致性),
        否则退回 pages[0]。Page.enable 用于弹窗状态跟踪(fileChooser 拦截也依赖)。"""
        targets = json.loads(urllib.request.urlopen(
            f"http://127.0.0.1:{self.port}/json/list", timeout=5).read())
        pages = [t for t in targets if t.get("type") == "page"]
        pick = next((t for t in pages if t.get("id") == target_id), None) \
            or (pages[0] if pages else None)
        if not pick:
            raise BrowserUnavailable("no page target on debug port(先 new_page 或新建会话)")
        self.target_id = pick.get("id")
        self.ws = websocket.create_connection(pick["webSocketDebuggerUrl"],
                                              timeout=self.recv_granularity, suppress_origin=True)
        self.child_sessions.clear()  # 重连后 auto-attach 层级失效,由 ensure_oopif_attach 重建
        try:
            self.send("Page.enable")
        except Exception:
            pass
        return self

    def reconnect(self):
        """断线自愈:关旧 ws,重连原 target(target 已关则退回 pages[0]);事件/待决队列作废。"""
        self.close()
        self.events.clear()
        self.responses.clear()
        return self.connect(self.target_id)

    def fire(self, method, session_id=None, **params):
        """发送命令且不等 ACK(响应到达即丢):只用于"顺序即语义"的批量派发
        (鼠标轨迹点、按下/抬起、逐字按键)。同一 ws 上 CDP 按序处理,后续阻塞调用的
        返回即代表此前全部派发已入队并被执行——不必为每个点等一次渲染主线程回执,
        那是把主线程的忙时段乘成整条命令的耗时。断线重连语义同 send。"""
        mid = self.send(method, session_id=session_id, **params)
        self._abandoned.add(mid)
        return mid

    def send(self, method, session_id=None, **params):
        """发送命令,不等待响应(响应由 pump 收进 responses)。断线时重连重发一次。
        session_id:flatten 子 session(OOPIF)时作为消息顶层 sessionId 路由。"""
        self._id += 1
        mid = self._id
        msg = {"id": mid, "method": method, "params": params}
        if session_id:
            msg["sessionId"] = session_id
        raw = json.dumps(msg)
        try:
            self.ws.send(raw)
        except Exception:
            self.reconnect()
            self.ws.send(raw)
        return mid

    def call(self, method, timeout=None, session_id=None, **params):
        """发送命令并阻塞等待其响应(路上收到的事件进 events)。超时弃单:
        迟到响应由 pump 按 _abandoned 丢弃,不复用不积累。"""
        mid = self.send(method, session_id=session_id, **params)
        deadline = time.time() + (timeout or self.timeout)
        while mid not in self.responses:
            if time.time() > deadline:
                self._abandoned.add(mid)
                raise TimeoutError(f"CDP {method} timeout")
            self.pump()
        r = self.responses.pop(mid)
        if "error" in r:
            raise cdp_failure(method, r["error"])
        return r.get("result", {})

    _POLL_S = 0.02   # 空转等待粒度:无帧可读时一次 pump 白等的上界(旧写法=socket 超时 ~250ms)

    def drain(self, budget=0.0):
        """把已到达的帧读空(最多等 budget 秒,0 = 纯非阻塞)。预检类调用
        (_check_dialog)用它:只关心"此刻有没有已到达的弹窗事件",不该为一次预检
        白等一个 recv 粒度。返回读到的帧数。"""
        got = 0
        end = time.monotonic() + budget
        while True:
            before = len(self.responses) + len(self.events)
            self.pump(timeout=max(0.0, end - time.monotonic()))
            if len(self.responses) + len(self.events) == before or not self.ws:
                return got
            got += 1

    def pump(self, deadline=None, timeout=None):
        """读一帧:事件入 events,命令响应入 responses。
        连接被浏览器侧断开时置空 ws(置灰),下次 send 触发重连。
        Target.attached/detachedFromTarget 在此登记/注销 OOPIF 子 session;
        javascriptDialogOpening/Closed 在此登记弹窗状态;
        Page 域其余事件(生命周期类,无人消费)丢弃防队列膨胀。

        先用 select 按 timeout(缺省 _POLL_S)等可读、再交给 recv。旧写法直接
        recv:有帧时它立即返回,但没有帧时会一直阻塞到 socket 超时——实测空闲一次
        recv 等满 264ms,而弹窗预检与动作后探测的每一次 pump 都要付这笔空转。
        改 select 20ms 粒度后,空转等待降到 ~30ms。recv 的 socket 超时只留给
        "半帧已到、等剩余字节"(过小会撕裂帧)。timeout=0 为纯非阻塞。"""
        if not self.ws:
            return
        try:
            budget = self._POLL_S if timeout is None else max(0.0, timeout)
            if not select.select([self.ws.sock], [], [], budget)[0]:
                return
        except Exception:
            pass  # 取不到底层 socket 时退回原语义(直接 recv)
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
            if msg["id"] in self._abandoned:
                self._abandoned.discard(msg["id"])
            else:
                self.responses[msg["id"]] = msg
        elif msg.get("method") == "Target.attachedToTarget":
            ti = (msg.get("params") or {}).get("targetInfo") or {}
            sid = (msg.get("params") or {}).get("sessionId")
            if sid and ti.get("type") == "iframe":
                self.child_sessions[sid] = ti
        elif msg.get("method") == "Target.detachedFromTarget":
            sid = (msg.get("params") or {}).get("sessionId")
            self.child_sessions.pop(sid, None)
        elif msg.get("method") == "Page.javascriptDialogOpening":
            p = msg.get("params") or {}
            self.dialog_state = {"type": p.get("type"), "message": p.get("message")}
        elif msg.get("method") == "Page.javascriptDialogClosed":
            self.dialog_state = None
        elif "method" in msg:
            m = msg["method"]
            # Page 域生命周期事件(frameNavigated 等)无消费者,丢弃防膨胀;
            # screencastFrame / fileChooserOpened 有消费者,保留
            if m.startswith("Page.") and m not in ("Page.fileChooserOpened", "Page.screencastFrame"):
                return
            self.events.append((m, msg.get("params", {})))

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


def ensure_oopif_attach(sess):
    """page 级 flatten auto-attach OOPIF(跨域 iframe),返回 CdpEvents 单例。
    每次重设 setAutoAttach(ws 重连后 auto-attach 状态与 child_sessions 一并丢失,
    重设会对现存 OOPIF 重发 attachedToTarget)并 pump 收集增量;失败抛异常由调用方降级。
    递归武装:每个新登记的子 session 也设 setAutoAttach——OOPIF 内再嵌跨站孙 frame
    (宿主也是 OOPIF)只有宿主 session 武装后才会继续 attach(puppeteer 同款)。"""
    cdp = ensure_session_cdp(sess)
    cdp.call("Target.setAutoAttach", autoAttach=True, waitForDebuggerOnStart=False,
             flatten=True, timeout=10)
    seen = set()
    deadline = time.time() + 2.0
    while time.time() < deadline:
        cdp.pump()
        new = [s for s in cdp.child_sessions if s not in seen]
        if not new:
            break
        for s in new:
            seen.add(s)
            try:
                cdp.call("Target.setAutoAttach", autoAttach=True, waitForDebuggerOnStart=False,
                         flatten=True, timeout=10, session_id=s)
            except Exception:
                pass
            cdp.pump()
    return cdp
