# -*- coding: utf-8 -*-
"""P0 工具面(api-contract.md §5.1):全部走 CDP Input 域 + 拟人层。
红线:不开 Runtime.enable;UA/平台覆盖禁用;console 只收 console.*(Console.enable)。
"""
import base64
import json
import os
import time

from . import humanize
from .session import install_console_hook
from .snapshot import build_snapshot, scrollability


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


def _run_js_with_value(t, template, value):
    """run_js 的 args 传参在 DP 中不可靠(函数参数为空)——一律 JSON 内插。"""
    literal = json.dumps(value, ensure_ascii=False)
    return t.run_js(template.format(v=literal))


def _uid_point(sess, uid):
    """uid → 滚动至可见 → 视口中心坐标。视口外元素先 scrollIntoViewIfNeeded(CDP 域)。"""
    node = sess.uid_map.get(uid)
    if not node:
        raise KeyError(f"uid {uid} 已失效,请重新 take_snapshot")
    bnn = node.get("backendDOMNodeId")
    if not bnn:
        raise KeyError(f"uid {uid} 无对应 DOM 节点")
    sess.t.run_cdp("DOM.scrollIntoViewIfNeeded", backendNodeId=bnn)
    res = sess.t.run_cdp("DOM.getContentQuads", backendNodeId=bnn)
    quads = res.get("quads") or []
    if not quads:
        raise KeyError(f"uid {uid} 无可见几何(可能不在渲染树)")
    q = quads[0]  # [x1,y1,x2,y2,...] 4 角
    xs, ys = q[0::2], q[1::2]
    return (sum(xs) / len(xs), sum(ys) / len(ys), min(xs), min(ys), max(xs), max(ys))


def _uid_quad(sess, uid):
    """兼容入口:取中心坐标(带滚动至可见 + 命中校验)。"""
    cx, cy, *_ = _uid_point(sess, uid)
    try:
        hit = sess.t.run_js(
            f"return (function(){{ const e = document.elementFromPoint({cx}, {cy});"
            f" return e ? e.tagName : 'null'; }})()")
    except Exception:
        hit = "unknown"
    if hit == "null":
        raise KeyError(f"uid {uid} 滚动后仍不可点(坐标 {cx:.0f},{cy:.0f} 处无元素命中)")
    return (cx, cy)


def _with_snapshot(sess, include, extra=None):
    if include:
        snap = build_snapshot(sess)
        return {"result": extra or {"done": True}, "snapshot": snap["text"]}
    return {"result": extra or {"done": True}}


# ---- 快照/滚动 ----

def take_snapshot(sess, args, session_dir):
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
    if uid:
        cx, cy = _uid_quad(sess, uid)
        humanize.move_mouse(t, cx, cy)
    else:
        # 滚轮落点必须在内:取视口中心(写死坐标会超出小视口)
        vp = t.run_js("return [innerWidth, innerHeight]")
        cx, cy = int(vp[0] / 2), int(vp[1] / 2)
        humanize.move_mouse(t, cx, cy)
    dx = amount if direction == "right" else -amount if direction == "left" else 0
    dy = amount if direction == "down" else -amount if direction == "up" else 0
    before = t.run_js("return scrollY") or 0
    t.run_cdp("Input.dispatchMouseEvent", type="mouseWheel", x=cx, y=cy,
              deltaX=dx, deltaY=dy)
    time.sleep(0.3)
    after = t.run_js("return scrollY") or 0
    if after == before and dy:
        # 滚轮未生效(无命中/合成限制)→ JS 兜底
        t.run_js(f"window.scrollBy(0, {dy})")
        time.sleep(0.2)
        after = t.run_js("return scrollY") or 0
    humanize.op_delay()
    return _with_snapshot(sess, args.get("includeSnapshot"),
                          {"scrolled": True, "scrollY": after, "wheel_used": after != before})


# ---- 输入类(拟人) ----

def _select_native_option(sess, uid, node):
    """cdt 增强:click 落在 role=option 时改为原生 select 选值(option 展开前无几何,
    坐标点击不可达)。经 DOM.resolveNode→callFunctionOn 在元素上执行。"""
    t = sess.t
    bnn = node.get("backendDOMNodeId")
    try:
        r = t.run_cdp("DOM.resolveNode", backendNodeId=bnn)
    except Exception:
        t.run_cdp("DOM.enable")
        r = t.run_cdp("DOM.resolveNode", backendNodeId=bnn)
    oid = (r.get("object") or {}).get("objectId")
    if not oid:
        return False
    res = t.run_cdp("Runtime.callFunctionOn", objectId=oid, returnByValue=True,
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
    node = sess.uid_map.get(uid)
    if not node:
        raise KeyError(f"uid {uid} 已失效,请重新 take_snapshot")
    # cdt 增强:非双击且节点 role=option → 原生 select 选值
    if not args.get("dblClick") and (node.get("role") or {}).get("value") == "option":
        if _select_native_option(sess, uid, node):
            humanize.op_delay()
            return _with_snapshot(sess, args.get("includeSnapshot"), {"clicked": True})
    cx, cy = _uid_quad(sess, uid)
    humanize.click_xy(sess.t, cx, cy, dbl=bool(args.get("dblClick")))
    humanize.op_delay()
    return _with_snapshot(sess, args.get("includeSnapshot"), {"clicked": True, "x": round(cx, 1), "y": round(cy, 1)})


def hover(sess, args, session_dir):
    cx, cy, *_ = _uid_quad(sess, str(args["uid"]))
    humanize.move_mouse(sess.t, cx, cy)
    return _with_snapshot(sess, args.get("includeSnapshot"), {"done": True})


def drag(sess, args, session_dir):
    t = sess.t
    x1, y1, *_ = _uid_quad(sess, str(args["from_uid"]))
    x2, y2, *_ = _uid_quad(sess, str(args["to_uid"]))
    humanize.move_mouse(t, x1, y1)
    t.run_cdp("Input.dispatchMouseEvent", type="mousePressed", x=x1, y=y1, button="left", clickCount=1)
    for px, py in humanize.bezier_path(x1, y1, x2, y2):
        t.run_cdp("Input.dispatchMouseEvent", type="mouseMoved", x=px, y=py, button="left", buttons=1)
        time.sleep(0.012)
    t.run_cdp("Input.dispatchMouseEvent", type="mouseReleased", x=x2, y=y2, button="left", clickCount=1)
    return _with_snapshot(sess, args.get("includeSnapshot"), {"done": True})


def fill(sess, args, session_dir):
    t = sess.t
    uid = str(args["uid"])
    value = str(args["value"])
    node = sess.uid_map.get(uid)
    if not node:
        raise KeyError(f"uid {uid} 已失效,请重新 take_snapshot")
    bnn = node.get("backendDOMNodeId")
    # 可见 → 强聚焦(不依赖点击命中)→ 拟人点击(真实感)→ 按类型置值
    t.run_cdp("DOM.scrollIntoViewIfNeeded", backendNodeId=bnn)
    t.run_cdp("DOM.focus", backendNodeId=bnn)
    try:
        cx, cy = _uid_quad(sess, uid)
        humanize.click_xy(t, cx, cy)
    except Exception:
        pass  # 聚焦已由 DOM.focus 保证;点击仅为拟人(几何异常不阻断)
    # 主世界单次 evaluate(非 Runtime.enable):按元素类型置值(v 经 JSON 内插);
    # 错误语义对齐 cdt:select 找不到选项 / checkbox 非法值 → 抛错不静默
    kind = _run_js_with_value(t, """return (function(v) {{
             const el = document.activeElement;
             if (!el) return 'no-focus';
             if (el.tagName === 'SELECT') {{
               const opt = [...el.options].find(o => o.value === v || o.text === v);
               if (!opt) return 'ERR:Could not find option with text "' + v + '"';
               el.value = opt.value;
               el.dispatchEvent(new Event('change', {{bubbles: true}}));
               return 'select';
             }}
             if (el.type === 'checkbox' || el.type === 'radio') {{
               if (v !== 'true' && v !== 'false')
                 return 'ERR:Checkboxes, radio boxes and toggles require "true" or "false" value, but ' + v + ' was used';
               el.checked = (v === 'true');
               el.dispatchEvent(new Event('change', {{bubbles: true}}));
               return 'checked';
             }}
             el.value = v;
             el.dispatchEvent(new Event('input', {{bubbles: true}}));
             el.dispatchEvent(new Event('change', {{bubbles: true}}));
             return 'text';
           }})({v})""", value)
    if isinstance(kind, str) and kind.startswith("ERR:"):
        raise ValueError(kind[4:])
    humanize.op_delay()
    return _with_snapshot(sess, args.get("includeSnapshot"), {"filled": True, "kind": kind})


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
    humanize.press_key(sess.t, str(args["key"]))
    return _with_snapshot(sess, args.get("includeSnapshot"), {"pressed": True})


def type_text(sess, args, session_dir):
    humanize.type_text(sess.t, str(args["text"]), args.get("submitKey"))
    return {"typed": len(str(args["text"]))}


def upload_file(sess, args, session_dir):
    """cdt 语义:优先 DOM.setFileInputFiles 直传;失败(代理元素等)→ 拦截 file chooser
    + 点击元素 + Page.handleFileChooser accept。"""
    uid = str(args["uid"])
    node = sess.uid_map.get(uid)
    if not node:
        raise KeyError(f"uid {uid} 已失效,请重新 take_snapshot")
    files = args.get("filePaths") if isinstance(args.get("filePaths"), list) else [args.get("filePaths")]
    abs_files = [os.path.abspath(f) for f in files if f]
    bnn = node.get("backendDOMNodeId")
    try:
        sess.t.run_cdp("DOM.setFileInputFiles", files=abs_files, backendNodeId=bnn)
        return {"uploaded": len(abs_files)}
    except Exception:
        pass  # 元素非 file input → 走 file chooser 兜底(cdt 同)
    from .cdp_events import CdpEvents
    if getattr(sess, "_cdp", None) is None:
        from .cdp_events import ensure_session_cdp
        ensure_session_cdp(sess)
    cdp = sess._cdp
    cx, cy = _uid_quad(sess, uid)
    try:
        cdp.call("Page.enable")  # 部分 Chromium 上 fileChooserOpened 派发要求 Page 域已启用
        cdp.call("Page.setInterceptFileChooserDialog", enabled=True)
        humanize.click_xy(sess.t, cx, cy)
        deadline = time.time() + 3
        chooser_bnn = None
        while time.time() < deadline and chooser_bnn is None:
            cdp.pump()
            for m, p in cdp.drain_events("Page.fileChooserOpened"):
                chooser_bnn = p.get("backendNodeId")
                break
            time.sleep(0.05)
        if chooser_bnn is None:
            raise RuntimeError("Failed to upload file. The element could not accept the file "
                               "directly, and clicking it did not trigger a file chooser.")
        # 现代 puppeteer 的 FileChooser.accept = 对 chooser 元素 DOM.setFileInputFiles
        # (Page.handleFileChooser 已从 CDP 移除)
        cdp.call("DOM.setFileInputFiles", files=abs_files, backendNodeId=chooser_bnn)
    finally:
        try:
            cdp.call("Page.setInterceptFileChooserDialog", enabled=False)
        except Exception:
            pass
    return {"uploaded": len(abs_files)}


def handle_dialog(sess, args, session_dir):
    """对齐 cdt:处理当前挂起的 JS 弹窗;无弹窗时立即报错(不等待)。
    直调 Page.handleJavaScriptDialog:无弹窗时 CDP 返回 "No dialog is showing",
    不依赖 DP 事件状态(javascriptDialogOpening 与命令响应存在到达竞态)。"""
    action = args.get("action", "accept")
    prompt = args.get("promptText")
    kwargs = {"accept": action == "accept"}
    if prompt is not None:
        kwargs["promptText"] = prompt
    try:
        sess.t.run_cdp("Page.handleJavaScriptDialog", **kwargs)
    except Exception as e:
        if "No dialog" in str(e):
            raise ValueError("No open dialog found") from None
        raise
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


def _handle_dialog_action(t, action):
    """cdt dialogAction 语义:"accept"/"dismiss",或字符串作为 window.prompt 的回复。"""
    try:
        if action in ("accept", "dismiss"):
            t.run_cdp("Page.handleJavaScriptDialog", accept=(action == "accept"))
        else:
            t.run_cdp("Page.handleJavaScriptDialog", accept=True, promptText=str(action))
    except Exception:
        pass  # 无弹窗(CDP: No dialog is showing)


def _wait_dom_settle(t, rounds=3, interval=0.2):
    """waitForStableDom(cdt 默认 true):DOM 节点数连续稳定即视为 settle。"""
    last = None
    for _ in range(rounds):
        try:
            cnt = t.run_js("return document.getElementsByTagName('*').length")
        except Exception:
            return
        if cnt is not None and cnt == last:
            return
        last = cnt
        time.sleep(interval)


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
    try:
        if typ == "url":
            t.get(str(args["url"]), timeout=timeout_s) if timeout_s else t.get(str(args["url"]))
        elif typ == "back":
            t.back()
        elif typ == "forward":
            t.forward()
        elif typ == "reload":
            t.refresh(ignore_cache=bool(args.get("ignoreCache")))
        try:
            t.wait.doc_loaded(timeout_s or 15)
        except Exception:
            pass
        # handleBeforeUnload(cdt 默认 accept):导航触发的 beforeunload 弹窗按参数处理
        _handle_dialog_action(t, args.get("handleBeforeUnload") or "accept")
        _ensure_listen(sess)  # 导航后重启:捕获后续 fetch/xhr
        return {"url": _live_url(sess), "title": t.title}
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
    return {"pages": sess.pages()}


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
    """对齐 cdt waitForTextOnPage:主文档 + 全部 frame 内匹配(任一命中即返回)。"""
    t = sess.t
    texts = args["text"] if isinstance(args["text"], list) else [args["text"]]
    timeout = float(args.get("timeout") or 30000) / 1000.0  # cdt 语义:毫秒
    deadline = time.time() + timeout

    def _hit(txt):
        # 短超时轮询:DP ele 默认等待 10s,会把 miss 变成长阻塞并拖垮后续命令
        if t.ele(f"text:{txt}", timeout=0.3):
            return True
        for fr in _iter_frames(t):
            try:
                if fr.ele(f"text:{txt}", timeout=0.3):
                    return True
            except Exception:
                continue
        return False

    while time.time() < deadline:
        for txt in texts:
            if _hit(txt):
                return {"found": txt}
        time.sleep(0.3)
    raise TimeoutError(f"文本未出现: {texts} ({timeout}s)")


def _iter_frames(t):
    """遍历当前页全部 iframe 文档(DP ChromiumFrame;失败静默跳过)。"""
    try:
        yield from (t.get_frames() or [])
    except Exception:
        return


# ---- 截图/执行/调试 ----

def take_screenshot(sess, args, session_dir):
    """对齐 cdt:format(png/jpeg/webp)/ quality(jpeg|webp)/ uid(元素截图,
    与 fullPage 互斥)/ fullPage(全页)/ filePath。统一走 Page.captureScreenshot。"""
    t = sess.t
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
        t.run_cdp("DOM.scrollIntoViewIfNeeded", backendNodeId=bnn)
        quads = (t.run_cdp("DOM.getContentQuads", backendNodeId=bnn) or {}).get("quads") or []
        if not quads:
            raise KeyError(f"uid {uid} 无可见几何(可能不在渲染树)")
        q = quads[0]
        xs, ys = q[0::2], q[1::2]
        clip = {"x": min(xs), "y": min(ys), "width": max(xs) - min(xs), "height": max(ys) - min(ys), "scale": 1}
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
    args = 快照 uid 列表 → 解为元素对象逐个传入(cdt 同);dialogAction = 执行期间弹窗
    自动处理;waitForStableDom 默认 true;filePath = 结果落盘只回文件名。"""
    t = sess.t
    fn = str(args["function"]).strip()
    if args.get("waitForStableDom") is None or args.get("waitForStableDom"):
        _wait_dom_settle(t)
    dialog_action = args.get("dialogAction")
    uid_args = args.get("args") or []
    if isinstance(uid_args, str):  # CLI 通道:JSON 数组字符串(或单 uid)
        try:
            uid_args = json.loads(uid_args)
        except json.JSONDecodeError:
            uid_args = [uid_args]
    if uid_args:
        handles = []
        for uid in uid_args:
            node = sess.uid_map.get(str(uid))
            if not node:
                raise KeyError(f"uid {uid} 已失效,请重新 take_snapshot")
            try:
                r = t.run_cdp("DOM.resolveNode", backendNodeId=node.get("backendDOMNodeId"))
            except Exception:
                t.run_cdp("DOM.enable")
                r = t.run_cdp("DOM.resolveNode", backendNodeId=node.get("backendDOMNodeId"))
            oid = (r.get("object") or {}).get("objectId")
            if not oid:
                raise KeyError(f"uid {uid} 无法解析为页面元素")
            handles.append({"objectId": oid})
        res = _eval_fn(t, fn, dialog_action, handles)
    else:
        res = _eval_fn(t, fn, dialog_action, None)
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
    if args.get("filePath"):
        fp = str(args["filePath"])
        with open(fp, "w", encoding="utf-8") as f:
            f.write(json.dumps(val, ensure_ascii=False))
        return {"path": fp}
    return {"value": val}


def _eval_fn(t, fn, dialog_action, handles, attempt=0):
    if handles:
        # 函数对象 → callFunctionOn 以元素句柄为实参调用(cdt 同构)
        f = t.run_cdp("Runtime.evaluate", expression=f"({fn})",
                      returnByValue=False, userGesture=True)
        foid = (f.get("result") or {}).get("objectId")
        if not foid:
            raise ValueError("evaluate_script: 函数声明无法解析为可调用对象")
        try:
            return t.run_cdp("Runtime.callFunctionOn", objectId=foid,
                             functionDeclaration="function (...args) { return this(...args); }",
                             arguments=handles, returnByValue=True, awaitPromise=True,
                             userGesture=True)
        except Exception:
            if attempt == 0 and dialog_action:
                _handle_dialog_action(t, dialog_action)
                return _eval_fn(t, fn, dialog_action, handles, attempt=1)
            raise
    expr = f"(async () => {{ const f = ({fn}); return await (typeof f === 'function' ? f() : f); }})()"
    try:
        return t.run_cdp("Runtime.evaluate", expression=expr,
                         returnByValue=True, awaitPromise=True, userGesture=True)
    except Exception:
        # 弹窗挂起会使 evaluate 挂起:按 dialogAction 处理后重试一次(cdt 默认 accept)
        if attempt == 0 and dialog_action:
            _handle_dialog_action(t, dialog_action)
            return _eval_fn(t, fn, dialog_action, None, attempt=1)
        raise


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


def get_network_request(sess, args, session_dir):
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
    return {"request": {"reqid": str(idx), "method": p.method, "url": p.url,
                        "status": getattr(p.response, "status", None),
                        "statusText": resp_raw.get("statusText"),
                        "resourceType": (getattr(p, "resourceType", None) or "Other").lower(),
                        "requestHeaders": req_info.get("headers", {}),
                        "responseHeaders": resp_raw.get("headers", {}),
                        "mimeType": resp_raw.get("mimeType"),
                        "protocol": resp_raw.get("protocol"),
                        "fromDiskCache": resp_raw.get("fromDiskCache"),
                        "timing": resp_raw.get("timing"),
                        "remoteIPAddress": resp_raw.get("remoteIPAddress")},
            "body": body}


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
    """对齐 cdt(红线内):networkConditions/cpuThrottlingRate/geolocation/colorScheme/
    extraHttpHeaders。UA 覆盖为 CONSTRAINT-001 明确禁用;viewport 含 mobile/touch
    指纹信号,同为红线权衡不实现(故意偏离清单)。"""
    t = sess.t
    nc = args.get("networkConditions")
    if nc is not None:
        if nc == "Offline":
            t.run_cdp("Network.emulateNetworkConditions", offline=True,
                      latency=0, downloadThroughput=-1, uploadThroughput=-1)
        elif nc in _PREDEFINED_NETWORK:
            t.run_cdp("Network.emulateNetworkConditions", offline=False, **_PREDEFINED_NETWORK[nc])
        else:
            raise ValueError(f"networkConditions 必须是 Offline/{' / '.join(_PREDEFINED_NETWORK)},收到 {nc}")
    rate = args.get("cpuThrottlingRate")
    if rate is not None:
        if not (1 <= rate <= 20):
            raise ValueError(f"cpuThrottlingRate 必须在 1-20,收到 {rate}")
        t.run_cdp("Emulation.setCPUThrottlingRate", rate=rate)
    geo = args.get("geolocation")
    if geo is not None:
        try:
            lat_s, lng_s = str(geo).split(",")
            lat, lng = float(lat_s), float(lng_s)
        except ValueError:
            raise ValueError(f'geolocation 需为 "<latitude>,<longitude>" 格式,收到 {geo}') from None
        if not (-90 <= lat <= 90 and -180 <= lng <= 180):
            raise ValueError(f"geolocation 超出范围: {geo}")
        t.run_cdp("Emulation.setGeolocationOverride", latitude=lat, longitude=lng, accuracy=100)
    cs = args.get("colorScheme")
    if cs is not None:
        if cs == "auto":  # 清除 override(cdt: reset to the default)
            t.run_cdp("Emulation.setEmulatedMedia", features=[])
        elif cs in ("dark", "light"):
            t.run_cdp("Emulation.setEmulatedMedia",
                      features=[{"name": "prefers-color-scheme", "value": cs}])
        else:
            raise ValueError(f"colorScheme 必须是 dark/light/auto,收到 {cs}")
    headers = args.get("extraHttpHeaders")
    if headers is not None:
        if str(headers).strip() == "":
            t.run_cdp("Network.setExtraHTTPHeaders", headers={})  # 空串 = 清除
        else:
            try:
                parsed = json.loads(headers)
            except json.JSONDecodeError as e:
                raise ValueError(f"Invalid JSON for headers: {e}") from None
            if not isinstance(parsed, dict):
                raise ValueError("Headers must be a JSON object")
            t.run_cdp("Network.setExtraHTTPHeaders", headers=parsed)
    return {"done": True}


def scroll_unknown_state(sess, args, session_dir):
    from .snapshot import settle_check
    return settle_check(sess)


# ---- M2/M3 挂载(performance/memory/advanced)——57 工具全量注册 ----
from . import performance as _perf  # noqa: E402
from . import memory as _mem  # noqa: E402
from . import advanced as _adv  # noqa: E402

for _mod in (_perf, _mem, _adv):
    for _name in dir(_mod):
        if not _name.startswith("_") and callable(getattr(_mod, _name)):
            globals()[_name] = getattr(_mod, _name)
