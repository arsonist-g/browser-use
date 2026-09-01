# -*- coding: utf-8 -*-
"""P0 工具面(api-contract.md §5.1):全部走 CDP Input 域 + 拟人层。
红线:不开 Runtime.enable;UA/平台覆盖禁用;console 只收 console.*(Console.enable)。
"""
import base64
import json
import os
import re
import time

from . import humanize
from .cdp_events import ensure_session_cdp
from .session import install_console_hook
from .snapshot import build_snapshot


def _live_url(sess):
    """导航后 tab.url 属性可能滞后;run_js 读真值,上下文丢失则等加载后回退。"""
    try:
        return sess.t.run_js("return location.href") or sess.t.url
    except Exception:
        try:
            sess.t.wait.doc_loaded(10)
        except Exception:
            pass
        return sess.t.url


def _node_channel(sess, uid):
    """uid 节点的 CDP 调用器 fn(method, **params):统一走会话 CdpEvents ws 通道
    (带超时,不经 DP 的弹窗前置检查——弹窗场景 Input 派发行为对齐上游);OOPIF 时
    带 sessionId 路由(backendNodeId 与坐标系均属该 frame)。ws 不可用回退 DP 通道。"""
    sid = getattr(sess, "uid_frames", {}).get(str(uid))
    cdp = _session_cdp_safe(sess)
    if not cdp:
        return lambda m, **kw: sess.t.run_cdp(m, **kw)
    return lambda m, **kw: cdp.call(m, timeout=15, session_id=sid or None, **kw)


def _session_cdp_safe(sess):
    """会话级 CdpEvents(失败返回 None:预检/等待是增强,不该阻断主流程)。"""
    try:
        return ensure_session_cdp(sess)
    except Exception:
        return None


def _check_dialog(sess):
    """blockedByDialog 预检(对齐上游 ToolHandler):弹窗挂起时立即报错引导
    handle_dialog,而非让后续 CDP 调用挂死。挂到交互/执行类工具入口。"""
    cdp = _session_cdp_safe(sess)
    if not cdp:
        return
    cdp.pump()
    if cdp.dialog_state:
        d = cdp.dialog_state
        raise ValueError(f'A dialog is open ({d.get("type")}: {d.get("message")})。'
                         f" Use handle_dialog to accept or dismiss it first.")


def _cdp_eval(cdp, expr, timeout=5.0, session_id=None):
    """单次 Runtime.evaluate(带超时,dialog 挂起时超时报错而非永久阻塞)。"""
    r = cdp.call("Runtime.evaluate", timeout=timeout, session_id=session_id,
                 expression=expr, returnByValue=True)
    return (r.get("result") or {}).get("value")


def _wait_after_action(sess, timeout_s=3.0):
    """对齐上游 waitForEventsAfterAction:动作后 100ms 内检测导航发起 → 等导航完成;
    弹窗挂起 → 跳过(上游 dialogHandled 分支);否则等 DOM 计数稳定(100ms 静默)。
    返回 navigated_to_url | None,由响应附带给 AI(上游 "Page navigated to X." 行)。"""
    t = sess.t
    cdp = _session_cdp_safe(sess)

    def _href(tm=0.5):
        if cdp:
            try:
                return _cdp_eval(cdp, "location.href", timeout=tm)
            except Exception:
                return None
        try:
            return t.run_js("return location.href")
        except Exception:
            return None

    url0 = _href()
    deadline = time.time() + timeout_s
    navigated = None
    probe_until = time.time() + 0.8
    while time.time() < probe_until:
        if cdp:
            cdp.pump()
            if cdp.dialog_state:
                return None
        u = _href(0.3)
        if u and url0 and u != url0:
            navigated = u
            break
        time.sleep(0.08)
    if navigated:
        while time.time() < deadline:
            try:
                if _cdp_eval(cdp, "document.readyState", timeout=0.5) == "complete":
                    break
            except Exception:
                pass
            time.sleep(0.1)
        return navigated
    last = None
    while time.time() < deadline:
        cnt = None
        if cdp:
            try:
                cnt = _cdp_eval(cdp, "document.getElementsByTagName('*').length", timeout=0.5)
            except Exception:
                cnt = None
        if cnt is None:
            break
        if cnt == last:
            return None
        last = cnt
        time.sleep(0.1)
    return None


def _uid_point(sess, uid):
    """uid → 滚动至可见 → 视口中心坐标。视口外元素先 scrollIntoViewIfNeeded(CDP 域)。"""
    node = sess.uid_map.get(uid)
    if not node:
        raise KeyError(f"uid {uid} 已失效,请重新 take_snapshot")
    bnn = node.get("backendDOMNodeId")
    if not bnn:
        raise KeyError(f"uid {uid} 无对应 DOM 节点")
    cdp = _node_channel(sess, uid)
    cdp("DOM.scrollIntoViewIfNeeded", backendNodeId=bnn)
    res = cdp("DOM.getContentQuads", backendNodeId=bnn)
    quads = res.get("quads") or []
    if not quads:
        raise KeyError(f"uid {uid} 无可见几何(可能不在渲染树)")
    q = quads[0]  # [x1,y1,x2,y2,...] 4 角
    xs, ys = q[0::2], q[1::2]
    return (sum(xs) / len(xs), sum(ys) / len(ys), min(xs), min(ys), max(xs), max(ys))


def _uid_quad(sess, uid):
    """兼容入口:取中心坐标(带滚动至可见 + 命中校验)。命中校验按 frame 路由且带超时
    (弹窗挂起 renderer 时 run_js 会永久阻塞,一律走 CdpEvents 短超时)。"""
    cx, cy, *_ = _uid_point(sess, uid)
    sid = getattr(sess, "uid_frames", {}).get(str(uid))
    hit = "unknown"
    if sid:
        try:
            hit = _cdp_eval(ensure_session_cdp(sess),
                            f"(function(){{ const e = document.elementFromPoint({cx}, {cy});"
                            f" return e ? e.tagName : 'null'; }})()", timeout=8, session_id=sid)
        except Exception:
            pass
    else:
        cdp = _session_cdp_safe(sess)
        if cdp:
            try:
                hit = _cdp_eval(cdp, f"(function(){{ const e = document.elementFromPoint({cx}, {cy});"
                                     f" return e ? e.tagName : 'null'; }})()", timeout=8)
            except Exception:
                pass
    if hit == "null":
        raise KeyError(f"uid {uid} 滚动后仍不可点(坐标 {cx:.0f},{cy:.0f} 处无元素命中)")
    return (cx, cy)


def _with_snapshot(sess, include, extra=None):
    if include:
        snap = build_snapshot(sess)
        return {"result": extra or {"done": True}, "snapshot": snap["text"]}
    return {"result": extra or {"done": True}}


# 元素级置值(this=目标元素;ARIA toggle:role=checkbox/radio/switch 的非 input 元素
# 走 true/false 切换,对齐上游 isToggle 分支;错误语义对齐 cdt)
_FILL_JS = """function (v) {
   const el = this;
   if (el.tagName === 'SELECT') {
     const opt = [...el.options].find(o => o.value === v || o.text === v);
     if (!opt) return 'ERR:Could not find option with text "' + v + '"';
     el.value = opt.value;
     el.dispatchEvent(new Event('change', {bubbles: true}));
     return 'select';
   }
   const role = el instanceof HTMLInputElement ? el.type : (el.getAttribute('role') || '');
   if (role === 'checkbox' || role === 'radio' || role === 'switch') {
     if (v !== 'true' && v !== 'false')
       return 'ERR:Checkboxes, radio boxes and toggles require "true" or "false" value, but ' + v + ' was used';
     const want = (v === 'true');
     if (el.checked !== want) el.click();
     return 'checked';
   }
   el.value = v;
   el.dispatchEvent(new Event('input', {bubbles: true}));
   el.dispatchEvent(new Event('change', {bubbles: true}));
   return 'text';
 }"""


# ---- 快照/滚动 ----

def take_snapshot(sess, args, session_dir):
    _check_dialog(sess)
    try:
        sess.t.wait.doc_loaded(10)
    except Exception:
        pass
    snap = build_snapshot(sess, verbose=bool(args.get("verbose")))
    fp = args.get("filePath")
    if fp:
        # cdt 语义:给 filePath 时保存到文件,响应不再附快照全文
        with open(fp, "w", encoding="utf-8") as f:
            f.write(snap["text"])
        return {"path": fp}
    return {"text": snap["text"], "uid_count": snap["uid_count"]}


def scroll(sess, args, session_dir):
    t = sess.t
    direction = args.get("direction", "down")
    amount = int(args.get("amount") or 600)
    uid = args.get("uid")
    frame_sid = getattr(sess, "uid_frames", {}).get(str(uid)) if uid else None
    frame_fid = getattr(sess, "uid_frame_ids", {}).get(str(uid)) if uid else None

    def _eval_in_frame(expr, tm=6):
        """在 uid 所属 frame 的 window 上求值:子 frame 经 Page.createIsolatedWorld
        (隔离世界与主世界共享 DOM,window 即该 frame 的 window,免 Runtime.enable);
        OOPIF 根 frame 走所属 session 直取;主文档直接求值。失败返回 None。"""
        cdp = _session_cdp_safe(sess)
        if cdp and frame_fid:
            try:
                w = cdp.call("Page.createIsolatedWorld", timeout=10,
                             session_id=frame_sid, frameId=frame_fid)
                cid = (w or {}).get("executionContextId")
                if cid is not None:
                    r = cdp.call("Runtime.evaluate", timeout=tm, session_id=frame_sid,
                                 contextId=cid, expression=expr, returnByValue=True)
                    return (r.get("result") or {}).get("value")
            except Exception:
                return None
        if frame_sid:
            try:
                return _cdp_eval(ensure_session_cdp(sess), expr, timeout=tm,
                                 session_id=frame_sid)
            except Exception:
                return None
        try:
            return t.run_js(f"return {expr}")
        except Exception:
            return None

    if uid:
        cx, cy = _uid_quad(sess, uid)
        dispatch = _node_channel(sess, uid)
        humanize.move_mouse(t, cx, cy, dispatch=dispatch)
    else:
        dispatch = None
        # 滚轮落点必须在内:取视口中心(写死坐标会超出小视口)
        vp = t.run_js("return [innerWidth, innerHeight]")
        cx, cy = int(vp[0] / 2), int(vp[1] / 2)
        humanize.move_mouse(t, cx, cy)
    dx = amount if direction == "right" else -amount if direction == "left" else 0
    dy = amount if direction == "down" else -amount if direction == "up" else 0

    before = _eval_in_frame("window.scrollY") or 0
    if dispatch:
        dispatch("Input.dispatchMouseEvent", type="mouseWheel", x=cx, y=cy, deltaX=dx, deltaY=dy)
    else:
        t.run_cdp("Input.dispatchMouseEvent", type="mouseWheel", x=cx, y=cy,
                  deltaX=dx, deltaY=dy)
    time.sleep(0.3)
    after = _eval_in_frame("window.scrollY") or 0
    if after == before and dy:
        # 滚轮未生效(无命中/合成限制)→ JS 兜底 scrollBy(按该 uid 所属 frame)
        _eval_in_frame(f"window.scrollBy(0, {dy})")
        time.sleep(0.2)
        after = _eval_in_frame("window.scrollY") or 0
    humanize.op_delay()
    return _with_snapshot(sess, args.get("includeSnapshot"),
                          {"scrolled": True, "scrollY": after, "wheel_used": after != before})


# ---- 输入类(拟人) ----

def _select_native_option(sess, uid, node):
    """cdt 增强:click 落在 role=option 时改为原生 select 选值(option 展开前无几何,
    坐标点击不可达)。经 DOM.resolveNode→callFunctionOn 在元素上执行(OOPIF 按 frame 路由)。"""
    bnn = node.get("backendDOMNodeId")
    cdp = _node_channel(sess, uid)
    try:
        r = cdp("DOM.resolveNode", backendNodeId=bnn)
    except Exception:
        cdp("DOM.enable")
        r = cdp("DOM.resolveNode", backendNodeId=bnn)
    oid = (r.get("object") or {}).get("objectId")
    if not oid:
        return False
    res = cdp("Runtime.callFunctionOn", objectId=oid, returnByValue=True,
                    functionDeclaration="""function () {
                      const opt = this;
                      const sel = opt.closest && opt.closest('select');
                      if (!sel || sel.multiple || sel.disabled || opt.disabled) return { error: 'no-select' };
                      const name = (opt.textContent || '').trim();
                      const target = [...sel.options].find(o => o.value === name || (o.text || '').trim() === name);
                      if (!target) return { error: 'Could not find option with text "' + name + '"' };
                      sel.value = target.value;
                      sel.dispatchEvent(new Event('change', { bubbles: true }));
                      return { ok: true };
                    }""")
    out = (res.get("result") or {}).get("value") or {}
    if out.get("error") and out["error"] != "no-select":
        raise ValueError(out["error"])
    return bool(out.get("ok"))


def click(sess, args, session_dir):
    uid = str(args["uid"])
    _check_dialog(sess)
    node = sess.uid_map.get(uid)
    if not node:
        raise KeyError(f"uid {uid} 已失效,请重新 take_snapshot")
    # cdt 增强:非双击且节点 role=option → 原生 select 选值
    if not args.get("dblClick") and (node.get("role") or {}).get("value") == "option":
        if _select_native_option(sess, uid, node):
            humanize.op_delay()
            return _with_snapshot(sess, args.get("includeSnapshot"), {"clicked": True})
    cx, cy = _uid_quad(sess, uid)
    # Input 派发统一走 ws 通道(DP 的弹窗前置检查会拒发 mouseReleased,上游无此阻塞)
    dispatch = _node_channel(sess, uid)
    try:
        humanize.click_xy(sess.t, cx, cy, dbl=bool(args.get("dblClick")), dispatch=dispatch)
    except TimeoutError:
        # 点击已发生(alert 等弹窗在按下/抬起间弹出阻塞 renderer,Released 的 ACK 不回)。
        # 对齐上游 dialogHandled 语义:不作工具失败,dialog 交给 AI handle_dialog。
        pass
    humanize.op_delay()
    nav = _wait_after_action(sess)
    return _with_snapshot(sess, args.get("includeSnapshot"),
                          {"clicked": True, "x": round(cx, 1), "y": round(cy, 1),
                           **({"navigated_to_url": nav} if nav else {})})


def hover(sess, args, session_dir):
    _check_dialog(sess)
    uid = str(args["uid"])
    cx, cy, *_ = _uid_quad(sess, uid)
    dispatch = _node_channel(sess, uid)
    humanize.move_mouse(sess.t, cx, cy, dispatch=dispatch)
    nav = _wait_after_action(sess)
    return _with_snapshot(sess, args.get("includeSnapshot"),
                          {"done": True, **({"navigated_to_url": nav} if nav else {})})


def drag(sess, args, session_dir):
    _check_dialog(sess)
    t = sess.t
    from_uid, to_uid = str(args["from_uid"]), str(args["to_uid"])
    frames = getattr(sess, "uid_frames", {})
    x1, y1, *_ = _uid_quad(sess, from_uid)
    x2, y2, *_ = _uid_quad(sess, to_uid)
    if bool(frames.get(from_uid)) != bool(frames.get(to_uid)):
        raise ValueError("cross-frame drag is not supported: from_uid and to_uid must be in the same frame")
    dispatch = _node_channel(sess, from_uid) if frames.get(from_uid) else None
    humanize.move_mouse(t, x1, y1, dispatch=dispatch)
    send = dispatch or (lambda m, **kw: t.run_cdp(m, **kw))
    send("Input.dispatchMouseEvent", type="mousePressed", x=x1, y=y1, button="left", clickCount=1)
    for px, py in humanize.bezier_path(x1, y1, x2, y2):
        send("Input.dispatchMouseEvent", type="mouseMoved", x=px, y=py, button="left", buttons=1)
        time.sleep(0.012)
    send("Input.dispatchMouseEvent", type="mouseReleased", x=x2, y=y2, button="left", clickCount=1)
    nav = _wait_after_action(sess)
    return _with_snapshot(sess, args.get("includeSnapshot"),
                          {"done": True, **({"navigated_to_url": nav} if nav else {})})


def fill(sess, args, session_dir):
    t = sess.t
    uid = str(args["uid"])
    value = str(args["value"])
    _check_dialog(sess)
    node = sess.uid_map.get(uid)
    if not node:
        raise KeyError(f"uid {uid} 已失效,请重新 take_snapshot")
    bnn = node.get("backendDOMNodeId")
    sid = getattr(sess, "uid_frames", {}).get(str(uid))
    dispatch = _node_channel(sess, uid)  # Input 派发统一走 ws(DP 弹窗检查会拒发)
    cdp = _session_cdp_safe(sess)
    # 可见 → 强聚焦(不依赖点击命中)→ 拟人点击(真实感)→ 元素级置值
    cdp.call("DOM.scrollIntoViewIfNeeded", timeout=10,
             session_id=sid or None, backendNodeId=bnn)
    cdp.call("DOM.focus", timeout=10, session_id=sid or None, backendNodeId=bnn)
    try:
        cx, cy = _uid_quad(sess, uid)
        humanize.click_xy(t, cx, cy, dispatch=dispatch)
    except Exception:
        pass  # 聚焦已由 DOM.focus 保证;点击仅为拟人(几何异常不阻断)
    # 置值经 DOM.resolveNode→callFunctionOn 在目标元素上执行(this=元素,iframe 内
    # 元素的 document 主世界不可见);调用带超时——弹窗挂起 renderer 时不返回也不抛,
    # 超时后检测弹窗:dialogAction(上游默认 accept)处理并重试一次,不挂死会话。
    action = args.get("dialogAction") or "accept"

    def _resolve_and_call():
        for attempt in (0, 1):
            try:
                r = cdp.call("DOM.resolveNode", timeout=10,
                             session_id=sid or None, backendNodeId=bnn)
                oid = (r.get("object") or {}).get("objectId")
                if not oid:
                    raise KeyError(f"uid {uid} 无法解析为页面元素")
                return cdp.call("Runtime.callFunctionOn", timeout=15,
                                session_id=sid or None, objectId=oid, returnByValue=True,
                                arguments=[{"value": value}],
                                functionDeclaration=_FILL_JS)
            except TimeoutError:
                if attempt == 0:
                    cdp.pump()
                    if cdp.dialog_state:
                        _handle_dialog_action(sess, action)
                        continue
                raise
        raise TimeoutError("fill timed out")

    res = _resolve_and_call()
    kind = (res.get("result") or {}).get("value")
    if isinstance(kind, str) and kind.startswith("ERR:"):
        # 错误层级对齐 cdt handleActionError:主信息 = 交互失败包装行(uid 级),
        # 具体原因附后(上游原因仅入日志;CLI 单通道场景内联保留可诊断性)
        raise ValueError(f"Failed to interact with the element with uid {uid}. "
                         f"The element did not become interactive within the configured "
                         f"timeout. ({kind[4:]})")
    humanize.op_delay()
    nav = _wait_after_action(sess)
    return _with_snapshot(sess, args.get("includeSnapshot"),
                          {"filled": True, "kind": kind,
                           **({"navigated_to_url": nav} if nav else {})})


def fill_form(sess, args, session_dir):
    elements = args.get("elements", [])
    if isinstance(elements, str):  # CLI 通道:JSON 数组字符串
        elements = json.loads(elements)
    n = 0
    for item in elements:
        fill(sess, {"uid": item["uid"], "value": item["value"]}, session_dir)
        n += 1
    return {"filled": n}


def press_key(sess, args, session_dir):
    _check_dialog(sess)
    humanize.press_key(sess.t, str(args["key"]))
    nav = _wait_after_action(sess)
    return _with_snapshot(sess, args.get("includeSnapshot"),
                          {"pressed": True, **({"navigated_to_url": nav} if nav else {})})


def type_text(sess, args, session_dir):
    _check_dialog(sess)
    humanize.type_text(sess.t, str(args["text"]), args.get("submitKey"))
    nav = _wait_after_action(sess)
    return {"typed": len(str(args["text"])),
            **({"navigated_to_url": nav} if nav else {})}


def upload_file(sess, args, session_dir):
    """cdt 语义:优先 DOM.setFileInputFiles 直传(按 frame 路由);失败(代理元素等)
    → 拦截 file chooser + 点击元素 + setFileInputFiles accept。OOPIF 不走 chooser 兜底
    (上游对 iframe file input 同样只有 setFileInputFiles 一条路)。"""
    uid = str(args["uid"])
    _check_dialog(sess)
    node = sess.uid_map.get(uid)
    if not node:
        raise KeyError(f"uid {uid} 已失效,请重新 take_snapshot")
    files = args.get("filePaths") if isinstance(args.get("filePaths"), list) else [args.get("filePaths")]
    abs_files = [os.path.abspath(f) for f in files if f]
    bnn = node.get("backendDOMNodeId")
    cdp = _node_channel(sess, uid)
    try:
        cdp("DOM.setFileInputFiles", files=abs_files, backendNodeId=bnn)
        return {"uploaded": len(abs_files)}
    except Exception:
        pass  # 元素非 file input → 走 file chooser 兜底(cdt 同;仅主 frame)
    if getattr(sess, "uid_frames", {}).get(str(uid)):
        raise ValueError("Failed to upload file: the element is not a file input (cross-frame chooser fallback is not supported)")
    if getattr(sess, "_cdp", None) is None:
        from .cdp_events import ensure_session_cdp
        ensure_session_cdp(sess)
    cdp_ev = sess._cdp
    cx, cy = _uid_quad(sess, uid)
    try:
        cdp_ev.call("Page.enable")  # 部分 Chromium 上 fileChooserOpened 派发要求 Page 域已启用
        cdp_ev.call("Page.setInterceptFileChooserDialog", enabled=True)
        humanize.click_xy(sess.t, cx, cy)
        deadline = time.time() + 3
        chooser_bnn = None
        while time.time() < deadline and chooser_bnn is None:
            cdp_ev.pump()
            for _m, p in cdp_ev.drain_events("Page.fileChooserOpened"):
                chooser_bnn = p.get("backendNodeId")
                break
            time.sleep(0.05)
        if chooser_bnn is None:
            raise RuntimeError("Failed to upload file. The element could not accept the file "
                               "directly, and clicking it did not trigger a file chooser.")
        # 现代 puppeteer 的 FileChooser.accept = 对 chooser 元素 DOM.setFileInputFiles
        # (Page.handleFileChooser 已从 CDP 移除)
        cdp_ev.call("DOM.setFileInputFiles", files=abs_files, backendNodeId=chooser_bnn)
    finally:
        try:
            cdp_ev.call("Page.setInterceptFileChooserDialog", enabled=False)
        except Exception:
            pass
    return {"uploaded": len(abs_files)}


def handle_dialog(sess, args, session_dir):
    """对齐 cdt getDialog() 语义:事件状态无弹窗 → "No open dialog found";状态有弹窗
    但 CDP 报无弹窗(已被外部处理/closed 事件滞后)→ 报成功(上游 accept 失败仅 log)。
    动作直调 Page.handleJavaScriptDialog,不依赖 DP 事件状态(DEC-015)。"""
    action = args.get("action", "accept")
    prompt = args.get("promptText")
    cdp = _session_cdp_safe(sess)
    kwargs = {"accept": action == "accept"}
    if prompt is not None:
        kwargs["promptText"] = prompt
    if cdp:
        cdp.pump()
        if not cdp.dialog_state:
            raise ValueError("No open dialog found")  # 文案对齐 cdt(事件状态无弹窗)
    try:
        if cdp:
            cdp.call("Page.handleJavaScriptDialog", timeout=10, **kwargs)
        else:
            sess.t.run_cdp("Page.handleJavaScriptDialog", **kwargs)
    except Exception as e:
        if cdp and cdp.dialog_state and "No dialog" in str(e):
            pass  # 状态有但实际已消失(外部处理):对齐 cdt 仅 log 并报成功
        elif "No dialog" in str(e):
            raise ValueError("No open dialog found") from None
        else:
            raise
    # 命令成功 = 弹窗已关闭;ws 的 closed 事件可能滞后,主动清预检状态
    if cdp:
        cdp.dialog_state = None
    return {"handled": True}


# ---- 导航/页签 ----

def _ensure_listen(sess):
    """幂等开启请求监听(仅在未监听时启动;监听随固定 tab 对象存活,缓冲跨调用累积)。"""
    t = sess.t
    if not getattr(t.listen, "listening", False):
        try:
            t.listen.start()
        except Exception:
            pass
    sess.listen_started = True


def _handle_dialog_action(sess, action):
    """cdt dialogAction 语义:"accept"/"dismiss",或字符串作为 window.prompt 的回复。"""
    t = sess.t
    try:
        if action in ("accept", "dismiss"):
            t.run_cdp("Page.handleJavaScriptDialog", accept=(action == "accept"))
        else:
            t.run_cdp("Page.handleJavaScriptDialog", accept=True, promptText=str(action))
        # 命令成功 = 弹窗已关闭;ws 的 closed 事件可能滞后,主动清预检状态
        cdp = getattr(sess, "_cdp", None)
        if cdp:
            cdp.dialog_state = None
    except Exception:
        pass  # 无弹窗(CDP: No dialog is showing)


def _wait_dom_settle(sess, rounds=3, interval=0.2):
    """waitForStableDom(cdt 默认 true):DOM 节点数连续稳定即视为 settle。
    走 CdpEvents 短超时(弹窗挂起 renderer 时 run_js 会永久阻塞)。"""
    cdp = _session_cdp_safe(sess)
    last = None
    for _ in range(rounds):
        cnt = None
        if cdp:
            try:
                cnt = _cdp_eval(cdp, "document.getElementsByTagName('*').length", timeout=2)
            except Exception:
                return
        else:
            try:
                cnt = sess.t.run_js("return document.getElementsByTagName('*').length")
            except Exception:
                return
        if cnt is not None and cnt == last:
            return
        last = cnt
        time.sleep(interval)


def _nav_reason(e, timeout_s=None, url=None):
    """失败原因对齐上游 error.message 形态:超时 → "Navigation timeout of N ms exceeded";
    网络错误 → 取 CDP errorText(net::ERR_*),附 " at <url>"(puppeteer 同款)。"""
    if isinstance(e, TimeoutError):
        ms = int(timeout_s * 1000) if timeout_s else 30000
        return f"Navigation timeout of {ms} ms exceeded"
    m = re.search(r"net::ERR_[A-Z0-9_]+", str(e))
    if m:
        return f"{m.group(0)} at {url}" if url else m.group(0)
    return str(e).strip()[:200]


def navigate_page(sess, args, session_dir):
    t = sess.t
    _ensure_listen(sess)  # 导航前开启:捕获本次页面加载的请求
    typ = args.get("type", "url")
    timeout_ms = args.get("timeout")
    timeout_s = float(timeout_ms) / 1000.0 if timeout_ms else None
    init_script_id = None
    if args.get("initScript"):
        # cdt:本次导航前注入的一次性新文档脚本(navigate 结束即移除)
        init_script_id = (t.run_cdp("Page.addScriptToEvaluateOnNewDocument",
                                    source=str(args["initScript"])) or {}).get("identifier")
    # DP 失败形态(probe_nav_failures.py 实证):get() 默认吞错返回 False;show_errmsg=True
    # 才抛 ConnectionError(net::ERR_*)/TimeoutError,但重试路径会 print 污染 stdio 协议
    # → 必须配 retry=0(单次尝试,失败即抛且无 stdout 输出)。4xx/5xx 加载错误页 = 成功
    # (上游 goto 同语义,不判失败)。back/forward/reload 无失败信号,静默 = 成功(上游同)。
    # 失败不抛,响应附 "Unable to navigate ..." 提示行(上游 pages.ts 同款,AI 明确知道失败)。
    url = str(args.get("url") or "")
    line = None
    try:
        if typ == "url":
            try:
                (t.get(url, show_errmsg=True, retry=0, timeout=timeout_s) if timeout_s
                 else t.get(url, show_errmsg=True, retry=0))
                line = f"Successfully navigated to {url}."
            except Exception as e:
                line = f"Unable to navigate in the selected page: {_nav_reason(e, timeout_s, url)}."
        elif typ == "back":
            try:
                t.back()
                line = f"Successfully navigated back to {_live_url(sess)}."
            except Exception as e:
                line = f"Unable to navigate back in the selected page: {_nav_reason(e)}."
        elif typ == "forward":
            try:
                t.forward()
                line = f"Successfully navigated forward to {_live_url(sess)}."
            except Exception as e:
                line = f"Unable to navigate forward in the selected page: {_nav_reason(e)}."
        elif typ == "reload":
            try:
                t.refresh(ignore_cache=bool(args.get("ignoreCache")))
                line = "Successfully reloaded the page."
            except Exception as e:
                line = f"Unable to reload the selected page: {_nav_reason(e)}."
        try:
            t.wait.doc_loaded(timeout_s or 15)
        except Exception:
            pass
        # handleBeforeUnload(cdt 默认 accept):导航触发的 beforeunload 弹窗按参数处理
        _handle_dialog_action(sess, args.get("handleBeforeUnload") or "accept")
        _ensure_listen(sess)  # 导航后重启:捕获后续 fetch/xhr
        return {"url": _live_url(sess), "title": t.title, "message": line}
    finally:
        if init_script_id:
            try:
                t.run_cdp("Page.removeScriptToEvaluateOnNewDocument", identifier=init_script_id)
            except Exception:
                pass


def new_page(sess, args, session_dir):
    url = str(args["url"])
    background = bool(args.get("background"))
    isolated = args.get("isolatedContext")
    timeout_ms = args.get("timeout")
    if isolated:
        tab = _new_tab_in_context(sess, str(isolated), url, background)
    else:
        tab = sess.browser.new_tab(url, new_context=False, background=background)
    sess.tab = tab
    _ensure_listen(sess)  # 新 tab 的监听与 console hook 独立
    install_console_hook(tab)
    try:
        tab.wait.doc_loaded((float(timeout_ms) / 1000.0) if timeout_ms else 10)
    except Exception:
        pass
    # cdt 语义:响应附页面列表并指向新页(pageId 按创建序号,与 list_pages 一致)
    tabs = sess.browser.get_tabs()
    idx = next((i for i, tb in enumerate(tabs)
                if getattr(tb, "tab_id", None) == getattr(tab, "tab_id", None)), 0)
    return {"page_id": str(idx), "url": tab.url, "title": tab.title, "pages": sess.pages()}


def _new_tab_in_context(sess, name, url, background):
    """命名隔离上下文:同名复用同一 browser context(cdt 语义),跨 context 完全隔离。
    Target.createBrowserContext/createTarget 为 browser 端点命令,经 daemon pipe 通道。"""
    from .cdp_events import pipe_call
    ctx_map = getattr(sess, "_isolated_contexts", None)
    if ctx_map is None:
        ctx_map = sess._isolated_contexts = {}
    ctx_id = ctx_map.get(name)
    if not ctx_id:
        ctx_id = pipe_call(sess.session_id, "Target.createBrowserContext")["browserContextId"]
        ctx_map[name] = ctx_id
    tid = pipe_call(sess.session_id, "Target.createTarget",
                    url=url, browserContextId=ctx_id)["targetId"]
    deadline = time.time() + 10
    while time.time() < deadline:
        for tb in sess.browser.get_tabs():
            if getattr(tb, "_target_id", None) == tid or getattr(tb, "tab_id", None) == tid:
                return tb
        time.sleep(0.2)
    raise RuntimeError(f"isolated context 页创建未就绪: {tid}")


def list_pages(sess, args, session_dir):
    note = sess.recover_page_selection()
    return {"pages": sess.pages(), **({"note": note} if note else {})}


def select_page(sess, args, session_dir):
    sess.select_page(args["page_id"])
    if args.get("bringToFront"):
        sess.tab.set.activate()
    return {"page_id": str(args["page_id"])}


def close_page(sess, args, session_dir):
    tabs = sess.browser.get_tabs()
    idx = int(args["page_id"])
    if len(tabs) <= 1:
        raise ValueError("The last open page cannot be closed. It is fine to keep it open.")  # 文案对齐 cdt
    sess.browser.close_tabs(tabs[idx])
    return {"closed": str(args["page_id"])}


def wait_for(sess, args, session_dir):
    """对齐 cdt waitForTextOnPage:主文档 + 全部 frame 内匹配(任一命中即返回),
    文本与 aria-label/alt(可访问名)双通道;成功后附快照(cdt 同,AI 直接拿 uid)。"""
    t = sess.t
    _check_dialog(sess)
    texts = args["text"] if isinstance(args["text"], list) else [args["text"]]
    timeout = float(args.get("timeout") or 30000) / 1000.0  # cdt 语义:毫秒
    deadline = time.time() + timeout
    cdp = _session_cdp_safe(sess)

    def _aria_hit(txt):
        # accessible name 通道:aria-label/title/alt(上游 aria/ locator 的近似覆盖)
        esc = txt.replace("\\", "\\\\").replace('"', '\\"')
        js = (f'(function(){{ const esc = "{esc}";'
              f' if (document.querySelector(\'[aria-label="\'+esc+\'"], [title="\'+esc+\'"]\')) return true;'
              f' return [...document.images].some(i => (i.alt || "") === esc); }})()')
        if cdp:
            try:
                if _cdp_eval(cdp, js, timeout=2):
                    return True
            except Exception:
                pass
        return False

    def _hit(txt):
        # 短超时轮询:DP ele 默认等待 10s,会把 miss 变成长阻塞并拖垮后续命令
        try:
            if t.ele(f"text:{txt}", timeout=0.3):
                return True
        except Exception:
            pass
        for fr in _iter_frames(t):
            try:
                if fr.ele(f"text:{txt}", timeout=0.3):
                    return True
            except Exception:
                continue
        return _aria_hit(txt)

    while time.time() < deadline:
        for txt in texts:
            if _hit(txt):
                snap = build_snapshot(sess)
                return {"found": txt, "snapshot": snap["text"], "uid_count": snap["uid_count"]}
        time.sleep(0.3)
    raise TimeoutError(f"文本未出现: {texts} ({timeout}s)")


def _iter_frames(t):
    """遍历当前页全部 iframe 文档(DP ChromiumFrame;失败静默跳过)。"""
    try:
        yield from (t.get_frames() or [])
    except Exception:
        return


# ---- 截图/执行/调试 ----

def _iframe_viewport_origin(sess, host_bnn, host_sid=None):
    """OOPIF 子视口原点在主视口中的位置:宿主 iframe 元素 border-box 左上 + border + padding。
    Page.captureScreenshot 是 page 级(主视口系),frame 内 getContentQuads 需此换算。
    宿主元素可能嵌在 OOPIF(嵌套 iframe)内:按候选 session 解析(已知宿主 session
    优先,再主 session,再其余子 session)。"""
    if not host_bnn:
        return (0.0, 0.0)
    cdp = _session_cdp_safe(sess)
    candidates = ([host_sid] if host_sid else []) + [None]
    if cdp:
        candidates += [s for s in list(cdp.child_sessions) if s not in candidates]
    def _chan_for(sid):
        """候选 session 的调用器(默认参绑定 sid,免闭包迟到陷阱)。"""
        if cdp:
            return lambda m, timeout=10, session_id=sid, **kw: cdp.call(
                m, timeout=timeout, session_id=session_id, **kw)
        return lambda m, timeout=10, session_id=None, **kw: sess.t.run_cdp(m, **kw)

    for sid in candidates:
        chan = _chan_for(sid)
        try:
            r = chan("DOM.resolveNode", backendNodeId=host_bnn)
            oid = (r.get("object") or {}).get("objectId")
            if not oid:
                continue
            res = chan("Runtime.callFunctionOn", objectId=oid, returnByValue=True,
                       functionDeclaration="""function () {
                         const b = this.getBoundingClientRect();
                         const cs = getComputedStyle(this);
                         return {x: b.left + this.clientLeft + parseFloat(cs.paddingLeft || '0'),
                                 y: b.top + this.clientTop + parseFloat(cs.paddingTop || '0')};
                       }""")
            v = (res.get("result") or {}).get("value") or {}
            return (float(v.get("x", 0)), float(v.get("y", 0)))
        except Exception:
            continue
    return (0.0, 0.0)


def take_screenshot(sess, args, session_dir):
    """对齐 cdt:format(png/jpeg/webp)/ quality(jpeg|webp)/ uid(元素截图,
    与 fullPage 互斥)/ fullPage(全页)/ filePath。统一走 Page.captureScreenshot。
    OOPIF 元素:quads 按 frame session 取(子视口系),经宿主几何换算主视口 clip。"""
    t = sess.t
    _check_dialog(sess)
    fmt = args.get("format") or "png"
    if fmt not in ("png", "jpeg", "webp"):
        raise ValueError(f"format 必须是 png/jpeg/webp,收到 {fmt}")
    uid, full = args.get("uid"), bool(args.get("fullPage"))
    if uid and full:
        raise ValueError('Providing both "uid" and "fullPage" is not allowed.')
    quality = args.get("quality") if fmt in ("jpeg", "webp") else None
    clip = None
    if uid:
        node = sess.uid_map.get(str(uid))
        if not node:
            raise KeyError(f"uid {uid} 已失效,请重新 take_snapshot")
        bnn = node.get("backendDOMNodeId")
        frame_sid = getattr(sess, "uid_frames", {}).get(str(uid))
        cdp = _node_channel(sess, str(uid))
        cdp("DOM.scrollIntoViewIfNeeded", backendNodeId=bnn)
        quads = (cdp("DOM.getContentQuads", backendNodeId=bnn) or {}).get("quads") or []
        if not quads:
            raise KeyError(f"uid {uid} 无可见几何(可能不在渲染树)")
        q = quads[0]
        xs, ys = q[0::2], q[1::2]
        ox, oy = (0.0, 0.0)
        if frame_sid:
            ox, oy = _iframe_viewport_origin(
                sess, getattr(sess, "uid_hosts", {}).get(str(uid)),
                getattr(sess, "uid_host_sids", {}).get(str(uid)))
        clip = {"x": min(xs) + ox, "y": min(ys) + oy,
                "width": max(xs) - min(xs), "height": max(ys) - min(ys), "scale": 1}
    elif full:
        dims = t.run_js(
            "return [Math.max(document.documentElement.scrollWidth, document.body ? document.body.scrollWidth : 0),"
            " Math.max(document.documentElement.scrollHeight, document.body ? document.body.scrollHeight : 0)]") or []
        if len(dims) == 2 and dims[0] > 0 and dims[1] > 0:
            clip = {"x": 0, "y": 0, "width": dims[0], "height": dims[1], "scale": 1}
    kwargs = {"format": fmt, "captureBeyondViewport": clip is not None}
    if quality is not None:
        kwargs["quality"] = int(quality)
    if clip:
        kwargs["clip"] = clip
    raw = base64.b64decode(t.run_cdp("Page.captureScreenshot", **kwargs)["data"])
    fp = args.get("filePath") or sess.artifact_path(session_dir, "screenshot", "jpeg" if fmt == "jpeg" else fmt)
    with open(fp, "wb") as f:
        f.write(raw)
    return {"path": fp}


def evaluate_script(sess, args, session_dir):
    """对齐 cdt:入参是函数声明(如 "() => document.title" 或 async 函数),调用之并
    JSON 序列化结果。async 经裸 Runtime.evaluate(awaitPromise)支持——单独调用该命令
    不触发 Runtime.enable(CONSTRAINT-001 禁的是 enable 与其事件流)。
    args = 快照 uid 列表 → 解为元素对象逐个传入(cdt 同);dialogAction = 执行期间
    弹窗的处理(上游默认 accept:超时检测到弹窗即处理后重试,evaluate 不挂死);
    waitForStableDom 默认 true;filePath = 结果落盘只回文件名。"""
    _check_dialog(sess)
    fn = str(args["function"]).strip()
    if args.get("waitForStableDom") is None or args.get("waitForStableDom"):
        _wait_dom_settle(sess)
    dialog_action = args.get("dialogAction") or "accept"
    uid_args = args.get("args") or []
    if isinstance(uid_args, str):  # CLI 通道:JSON 数组字符串(或单 uid)
        try:
            uid_args = json.loads(uid_args)
        except json.JSONDecodeError:
            uid_args = [uid_args]
    if uid_args:
        sids = {getattr(sess, "uid_frames", {}).get(str(u)) for u in uid_args}
        if len(sids) > 1:
            raise ValueError("evaluate_script: args must be in the same frame "
                             "(object handles are not transferable across frames)")
        frame_sid = sids.pop()
        handles = []
        for uid in uid_args:
            node = sess.uid_map.get(str(uid))
            if not node:
                raise KeyError(f"uid {uid} 已失效,请重新 take_snapshot")
            ch = _node_channel(sess, str(uid))
            try:
                r = ch("DOM.resolveNode", backendNodeId=node.get("backendDOMNodeId"))
            except Exception:
                ch("DOM.enable")
                r = ch("DOM.resolveNode", backendNodeId=node.get("backendDOMNodeId"))
            oid = (r.get("object") or {}).get("objectId")
            if not oid:
                raise KeyError(f"uid {uid} 无法解析为页面元素")
            handles.append({"objectId": oid})
        res = _eval_fn(sess, frame_sid, fn, dialog_action, handles)
    else:
        res = _eval_fn(sess, None, fn, dialog_action, None)
    detail = res.get("exceptionDetails")
    if detail:
        text = (detail.get("exception", {}) or {}).get("description") or detail.get("text", "evaluate failed")
        raise ValueError(f"evaluate_script 执行失败: {text.strip()}")
    val = res.get("result", {}).get("value")
    if isinstance(val, str):
        try:
            val = json.loads(val)
        except json.JSONDecodeError:
            pass
    nav = _wait_after_action(sess)
    if args.get("filePath"):
        fp = str(args["filePath"])
        with open(fp, "w", encoding="utf-8") as f:
            f.write(json.dumps(val, ensure_ascii=False))
        return {"path": fp, **({"navigated_to_url": nav} if nav else {})}
    return {"value": val, **({"navigated_to_url": nav} if nav else {})}


def _eval_fn(sess, frame_sid, fn, dialog_action, handles, attempt=0):
    """函数求值:handles 非空走"函数对象 + callFunctionOn 以元素句柄实参调用"(cdt 同构);
    否则 async 包装直调。整条链走 CdpEvents 带超时——弹窗挂起 renderer 时不返回也不抛,
    超时检测到弹窗按 dialogAction 处理后重试一次(上游默认 accept 的等价实现)。"""
    cdp = ensure_session_cdp(sess)

    def send(m, timeout=20, **kw):
        return cdp.call(m, timeout=timeout, session_id=frame_sid or None, **kw)

    if handles:
        # 函数对象 → callFunctionOn 以元素句柄为实参调用(cdt 同构)
        f = send("Runtime.evaluate", expression=f"({fn})",
                 returnByValue=False, userGesture=True)
        foid = (f.get("result") or {}).get("objectId")
        if not foid:
            raise ValueError("evaluate_script: 函数声明无法解析为可调用对象")
        try:
            return send("Runtime.callFunctionOn", objectId=foid,
                        functionDeclaration="function (...args) { return this(...args); }",
                        arguments=handles, returnByValue=True, awaitPromise=True,
                        userGesture=True)
        except TimeoutError:
            if attempt == 0 and _dialog_retry(cdp, sess, dialog_action):
                return _eval_fn(sess, frame_sid, fn, dialog_action, handles, attempt=1)
            raise
    # 语义对齐上游(DEC-021):统一按函数调用,传非函数表达式(如 "1+1")由 JS 抛
    # TypeError 经 exceptionDetails 上报——上游同样报错,不静默返回表达式值。
    expr = f"(async () => {{ const f = ({fn}); return await f(); }})()"
    try:
        return send("Runtime.evaluate", expression=expr,
                    returnByValue=True, awaitPromise=True, userGesture=True)
    except TimeoutError:
        if attempt == 0 and _dialog_retry(cdp, sess, dialog_action):
            return _eval_fn(sess, frame_sid, fn, dialog_action, None, attempt=1)
        raise


def _dialog_retry(cdp, sess, dialog_action):
    """超时后检查弹窗:挂起则按 action 处理并返回 True。"""
    cdp.pump()
    if cdp.dialog_state:
        _handle_dialog_action(sess, dialog_action)
        return True
    return False


def list_console_messages(sess, args, session_dir):
    """收割模式:返回上次调用以来新产生的 console 消息。
    来源 = 页内注入 hook 缓冲(按 epoch+seq 去重),msgid 会话级稳定。
    对齐 cdt:pageSize/pageIdx 分页;includePreservedMessages=true 返回会话级全缓冲
    (我们的缓冲天然跨导航,语义超集);includeStackTraces=true 附调用点栈;
    serviceWorkerId 不支持(hook 方案不覆盖 SW,结构性限制)。"""
    types = args.get("types")
    include_stacks = bool(args.get("includeStackTraces"))
    preserved = bool(args.get("includePreservedMessages"))
    _drain_console(sess)
    buf = getattr(sess, "_console_buffer", [])
    cursor = getattr(sess, "_console_cursor", 0)
    out = list(buf) if preserved else buf[cursor:]
    sess._console_cursor = len(buf)
    if types:
        if isinstance(types, str):
            types = [types]
        out = [m for m in out if m["type"] in types]
    msgs = [{"msgid": m["msgid"], "type": m["type"], "text": m["text"],
             **({"stack": m.get("stack")} if include_stacks and m.get("stack") else {})}
            for m in out]
    msgs = _paginate(msgs, args)
    return {"messages": msgs, "buffered": len(buf),
            "note": "收割模式:每次调用返回新捕获消息;msgid 稳定,get_console_message 按 msgid 查详情"
                    + (";serviceWorkerId 不支持(console hook 不覆盖 SW)" if args.get("serviceWorkerId") else "")}


def _paginate(items, args):
    """cdt 分页语义:pageSize/pageIdx(默认整表)。"""
    page_size, page_idx = args.get("pageSize"), args.get("pageIdx")
    if page_size is None and page_idx is None:
        return items
    page_size = max(int(page_size or len(items)), 1)
    start = int(page_idx or 0) * page_size
    return items[start:start + page_size]


def _drain_console(sess):
    """读当前页 hook 缓冲,去重后写入会话级 console 缓冲。"""
    try:
        raw = sess.t.run_js(
            "return JSON.stringify({e: window.__buConsoleEpoch, a: (window.__buConsole || [])})")
        data = json.loads(raw) if raw else {}
    except Exception:
        return
    epoch = str(data.get("e", ""))
    seen = getattr(sess, "_console_seen", None)
    if seen is None:
        seen = sess._console_seen = set()
    buf = getattr(sess, "_console_buffer", None)
    if buf is None:
        buf = sess._console_buffer = []
    for item in data.get("a", []):
        key = (epoch, str(item.get("seq")))
        if key in seen:
            continue
        seen.add(key)
        buf.append({"msgid": str(len(buf)), "type": str(item.get("type", "")),
                    "text": str(item.get("text", "")), "epoch": epoch, "seq": item.get("seq"),
                    "stack": item.get("stack")})


def get_console_message(sess, args, session_dir):
    _drain_console(sess)
    buf = getattr(sess, "_console_buffer", None)
    idx = int(args["msgid"])
    if not buf or idx < 0 or idx >= len(buf):
        raise ValueError("Request not found for selected page")  # 文案对齐 cdt PageCollector.getById
    return {"message": buf[idx]}


def list_network_requests(sess, args, session_dir):
    """收割模式:返回自上次调用以来新捕获的请求(DP 导航会自动停监听,导航前后惰性重启)。
    请求包按 reqid 存入会话级累积缓冲,get_network_request 按 reqid 查详情。
    对齐 cdt:resourceTypes 按 CDP ResourceType 过滤;pageSize/pageIdx 分页;
    includePreservedRequests=true 返回会话级全缓冲(跨导航,语义超集)。"""
    _ensure_listen(sess)
    packets = []
    for p in sess.t.listen.steps(timeout=0.5):
        packets.append(p)
    buf = getattr(sess, "_net_buffer", None)
    if buf is None:
        buf = sess._net_buffer = []
    start = len(buf)
    buf.extend(packets)
    listed = list(buf) if args.get("includePreservedRequests") else packets
    base = 0 if args.get("includePreservedRequests") else start
    types = args.get("resourceTypes")
    out = [{"reqid": str(base + i), "method": p.method, "url": p.url,
            "status": getattr(p.response, "status", None),
            "resourceType": (getattr(p, "resourceType", None) or "Other").lower()}
           for i, p in enumerate(listed)]
    if types:
        if isinstance(types, str):  # CLI 通道:单值字符串
            types = [types]
        want = {str(ty).lower() for ty in types}
        out = [r for r in out if r["resourceType"] in want]
    out = _paginate(out, args)
    return {"requests": out, "buffered": len(buf),
            "note": "收割模式:每次调用返回新捕获请求;reqid 稳定,get_network_request 按 reqid 查详情"}


def _force_ext(path, ext):
    """cdt saveFile/ensureExtension 语义:给定路径的扩展名替换为规范扩展名
    (.network-request / .network-response)。"""
    root, _ = os.path.splitext(str(path))
    return root + ext


def _request_post_data(p):
    """请求体原文:DP 已按需拉过 Network.getRequestPostData(_raw_post_data);
    body 内联在事件里时取 _raw_request.request.postData。无 = None。"""
    raw = getattr(p, "_raw_post_data", None)
    if raw:
        return raw
    req = getattr(p, "_raw_request", None)
    if isinstance(req, dict):
        return (req.get("request") or {}).get("postData")
    return None


def _write_body_file(fp, data):
    """body 落盘:bytes 直写;str UTF-8;dict/list(页面 JSON 被解析)序列化回写。
    统一二进制写——Windows 文本模式会把 \\n 翻译成 \\r\\n,破坏与内联 body 的一致性。"""
    if isinstance(data, bytes):
        raw = data
    elif isinstance(data, str):
        raw = data.encode("utf-8")
    else:
        raw = json.dumps(data, ensure_ascii=False).encode("utf-8")
    with open(fp, "wb") as f:
        f.write(raw)


def get_network_request(sess, args, session_dir):
    _check_dialog(sess)  # 上游 get_network_request blockedByDialog=true
    buf = getattr(sess, "_net_buffer", None)
    idx = int(args["reqid"])
    if not buf or idx < 0 or idx >= len(buf):
        raise ValueError("Request not found for selected page")  # 文案对齐 cdt PageCollector.getById
    p = buf[idx]
    body = None
    try:
        body = p.response.body
    except Exception:
        pass  # 无响应体(未完成/二进制/已失效)→ 返回 null
    # 详情字段:从 DP 保存的原始 CDP 事件参数提取(requestWillBeSent/responseReceived)
    req_raw = getattr(p, "_raw_request", None) or {}
    resp_raw = getattr(p, "_raw_response", None) or {}
    req_info = req_raw.get("request", {}) if isinstance(req_raw, dict) else {}
    out = {"request": {"reqid": str(idx), "method": p.method, "url": p.url,
                       "status": getattr(p.response, "status", None),
                       "statusText": resp_raw.get("statusText"),
                       "resourceType": (getattr(p, "resourceType", None) or "Other").lower(),
                       "requestHeaders": req_info.get("headers", {}),
                       "responseHeaders": resp_raw.get("headers", {}),
                       "mimeType": resp_raw.get("mimeType"),
                       "protocol": resp_raw.get("protocol"),
                       "fromDiskCache": resp_raw.get("fromDiskCache"),
                       "timing": resp_raw.get("timing"),
                       "remoteIPAddress": resp_raw.get("remoteIPAddress")}}
    # 落盘参数(cdt 同名参):给 filePath 时该侧 body 不再内联(上游 one-of 语义,
    # 字段 = requestBodyFilePath/responseBodyFilePath);取不到 body 报占位文案
    req_fp, resp_fp = args.get("requestFilePath"), args.get("responseFilePath")
    if req_fp:
        post = _request_post_data(p)
        if post:
            fp = _force_ext(req_fp, ".network-request")
            _write_body_file(fp, post)
            out["request_body_file_path"] = fp
        else:
            out["request_body"] = "<Request body not available anymore>"
    if resp_fp:
        if body is not None:
            fp = _force_ext(resp_fp, ".network-response")
            _write_body_file(fp, body)
            out["response_body_file_path"] = fp
            body = None  # 已落盘,不再内联(上游同)
        else:
            out["response_body"] = "<Response body not available anymore>"
    if body is not None or not resp_fp:
        out["body"] = body
    return out


def resize_page(sess, args, session_dir):
    """对齐 cdt:窗口内容区 resize(Browser.getWindowForTarget + setContentsSize)。
    不用 Emulation.setDeviceMetricsOverride——那是模拟态残留(影响 devicePixelRatio、
    screencast 帧,且不真正改变窗口),行为与 cdt 的窗口 resize 可观察地不同。"""
    t = sess.t
    wid = int(t.run_cdp("Browser.getWindowForTarget").get("windowId"))
    try:
        bounds = t.run_cdp("Browser.getWindowBounds", windowId=wid)
        state = bounds.get("windowState")
        if state and state != "normal":
            t.run_cdp("Browser.setWindowBounds", windowId=wid, bounds={"windowState": "normal"})
    except Exception:
        pass  # 窗口 API 非全平台可用(cdt 同样容忍)
    try:
        t.run_cdp("Browser.setContentsSize", windowId=wid,
                  width=int(args["width"]), height=int(args["height"]))
    except Exception as e:
        raise RuntimeError(f"resize_page 失败(浏览器不支持 Browser.setContentsSize): {e}") from None
    return {"done": True}


# puppeteer PredefinedNetworkConditions(cdt 枚举的数值基准,单位:bps / ms)
_PREDEFINED_NETWORK = {
    "Slow 3G": {"latency": 400 * 5, "downloadThroughput": ((500 * 1000) / 8) * 0.8,
                "uploadThroughput": ((500 * 1000) / 8) * 0.8},
    "Fast 3G": {"latency": 150 * 3.75, "downloadThroughput": ((1.6 * 1000 * 1000) / 8) * 0.9,
                "uploadThroughput": ((750 * 1000) / 8) * 0.9},
    "Slow 4G": {"latency": 150 * 3.75, "downloadThroughput": ((1.6 * 1000 * 1000) / 8) * 0.9,
                "uploadThroughput": ((750 * 1000) / 8) * 0.9},
    "Fast 4G": {"latency": 60 * 2.75, "downloadThroughput": ((9 * 1000 * 1000) / 8) * 0.9,
                "uploadThroughput": ((1.5 * 1000 * 1000) / 8) * 0.9},
}


def emulate(sess, args, session_dir):
    """对齐 cdt McpPage.emulate 的**全量重置**语义:每次调用把未提及的维度重置到默认
    (清节流 / cpu=1 / geolocation 归 0,0(上游"清除"= 归零,非移除 override)/
    清 colorScheme);extraHttpHeaders 例外——上游仅显式传参时改动,跨调用持久。
    校验先于应用(上游 zod schema 先行,非法参数不做任何重置)。
    UA/viewport 为 CONSTRAINT-001 红线权衡,不实现也不在重置面。"""
    t = sess.t
    _check_dialog(sess)  # 上游 emulate blockedByDialog=true
    nc = args.get("networkConditions")
    if nc is not None and nc != "Offline" and nc not in _PREDEFINED_NETWORK:
        raise ValueError(f"networkConditions 必须是 Offline/{' / '.join(_PREDEFINED_NETWORK)},收到 {nc}")
    rate = args.get("cpuThrottlingRate")
    if rate is not None and not (1 <= rate <= 20):
        raise ValueError(f"cpuThrottlingRate 必须在 1-20,收到 {rate}")
    geo = args.get("geolocation")
    lat = lng = 0.0
    if geo is not None:
        try:
            lat_s, lng_s = str(geo).split(",")
            lat, lng = float(lat_s), float(lng_s)
        except ValueError:
            raise ValueError(f'geolocation 需为 "<latitude>,<longitude>" 格式,收到 {geo}') from None
        if not (-90 <= lat <= 90 and -180 <= lng <= 180):
            raise ValueError(f"geolocation 超出范围: {geo}")
    cs = args.get("colorScheme")
    if cs is not None and cs not in ("dark", "light", "auto"):
        raise ValueError(f"colorScheme 必须是 dark/light/auto,收到 {cs}")
    headers = args.get("extraHttpHeaders")
    parsed_headers = None
    if headers is not None:
        if str(headers).strip() == "":
            parsed_headers = {}
        else:
            try:
                parsed_headers = json.loads(headers)
            except json.JSONDecodeError as e:
                raise ValueError(f"Invalid JSON for headers: {e}") from None
            if not isinstance(parsed_headers, dict):
                raise ValueError("Headers must be a JSON object")

    # ---- 校验完毕,应用(未提及维度全量重置)----
    if nc is None:
        # 上游 emulateNetworkConditions(null):清除节流(吞吐 -1 = 不限速)
        t.run_cdp("Network.emulateNetworkConditions", offline=False, latency=0,
                  downloadThroughput=-1, uploadThroughput=-1)
    elif nc == "Offline":
        t.run_cdp("Network.emulateNetworkConditions", offline=True,
                  latency=0, downloadThroughput=-1, uploadThroughput=-1)
    else:
        t.run_cdp("Network.emulateNetworkConditions", offline=False, **_PREDEFINED_NETWORK[nc])
    if rate is None:
        t.run_cdp("Emulation.setCPUThrottlingRate", rate=1)
    else:
        t.run_cdp("Emulation.setCPUThrottlingRate", rate=rate)
    if geo is None:
        # 上游"清除" geolocation = setGeolocation({latitude: 0, longitude: 0}):
        # 归零而非移除 override——geolocation API 之后读到 0,0 而非真实位置
        t.run_cdp("Emulation.setGeolocationOverride", latitude=0, longitude=0, accuracy=0)
    else:
        t.run_cdp("Emulation.setGeolocationOverride", latitude=lat, longitude=lng, accuracy=100)
    if cs is None or cs == "auto":
        # 上游清 colorScheme = features 置空值(保留 feature 名,value 清空)
        t.run_cdp("Emulation.setEmulatedMedia",
                  features=[{"name": "prefers-color-scheme", "value": ""}])
    else:
        t.run_cdp("Emulation.setEmulatedMedia",
                  features=[{"name": "prefers-color-scheme", "value": cs}])
    if parsed_headers is not None:
        t.run_cdp("Network.setExtraHTTPHeaders", headers=parsed_headers)
    return {"done": True}


def scroll_unknown_state(sess, args, session_dir):
    from .snapshot import settle_check
    return settle_check(sess)


# ---- M2/M3 挂载(performance/memory/advanced)——57 工具全量注册 ----
from . import advanced as _adv  # noqa: E402
from . import memory as _mem  # noqa: E402
from . import performance as _perf  # noqa: E402

for _mod in (_perf, _mem, _adv):
    for _name in dir(_mod):
        if not _name.startswith("_") and callable(getattr(_mod, _name)):
            globals()[_name] = getattr(_mod, _name)
