# -*- coding: utf-8 -*-
"""P0 工具面(api-contract.md §5.1):全部走 CDP Input 域 + 拟人层。
红线:不开 Runtime.enable;UA/平台覆盖禁用;console 只收 console.*(Console.enable)。
"""
import json
import os
import time

from . import humanize
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


def _uid_quad(sess, uid):
    """uid → backendDOMNodeId → 屏幕四角(中心点即拟人点击落点)。"""
    node = sess.uid_map.get(uid)
    if not node:
        raise KeyError(f"uid {uid} 已失效,请重新 take_snapshot")
    bnn = node.get("backendDOMNodeId")
    if not bnn:
        raise KeyError(f"uid {uid} 无对应 DOM 节点")
    res = sess.t.run_cdp("DOM.getContentQuads", backendNodeId=bnn)
    quads = res.get("quads") or []
    if not quads:
        raise KeyError(f"uid {uid} 无可见几何(可能不在渲染树)")
    q = quads[0]  # [x1,y1,x2,y2,...] 4 角
    xs, ys = q[0::2], q[1::2]
    return (sum(xs) / len(xs), sum(ys) / len(ys), min(xs), min(ys), max(xs), max(ys))


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
        with open(fp, "w", encoding="utf-8") as f:
            f.write(snap["text"])
    return {"text": snap["text"], "uid_count": snap["uid_count"]}


def scroll(sess, args, session_dir):
    t = sess.t
    direction = args.get("direction", "down")
    amount = int(args.get("amount") or 600)
    uid = args.get("uid")
    if uid:
        cx, cy, *_ = _uid_quad(sess, uid)
        humanize.move_mouse(t, cx, cy)
    dx = amount if direction == "right" else -amount if direction == "left" else 0
    dy = amount if direction == "down" else -amount if direction == "up" else 0
    t.run_cdp("Input.dispatchMouseEvent", type="mouseWheel", x=960, y=540,
              deltaX=dx, deltaY=dy)
    humanize.op_delay()
    return _with_snapshot(sess, args.get("includeSnapshot"), {"scrolled": True})


# ---- 输入类(拟人) ----

def click(sess, args, session_dir):
    cx, cy, *_ = _uid_quad(sess, str(args["uid"]))
    humanize.click_xy(sess.t, cx, cy, dbl=bool(args.get("dblClick")))
    humanize.op_delay()
    return _with_snapshot(sess, args.get("includeSnapshot"), {"clicked": True})


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
    cx, cy, *_ = _uid_quad(sess, uid)
    humanize.click_xy(t, cx, cy)  # 聚焦
    # 主世界单次 evaluate(非 Runtime.enable):按元素类型置值
    kind = t.run_js(
        """(v) => {
             const el = document.activeElement;
             if (!el) return 'no-focus';
             if (el.tagName === 'SELECT') {
               let opt = [...el.options].find(o => o.value === v || o.text === v);
               if (opt) el.value = opt.value;
               el.dispatchEvent(new Event('change', {bubbles: true}));
               return 'select';
             }
             if (el.type === 'checkbox' || el.type === 'radio') {
               el.checked = (v === 'true');
               el.dispatchEvent(new Event('change', {bubbles: true}));
               return 'checked';
             }
             return 'text';
           }""", value)
    if kind == "text":
        t.run_cdp("Input.insertText", text=value)
    humanize.op_delay()
    return _with_snapshot(sess, args.get("includeSnapshot"), {"filled": True})


def fill_form(sess, args, session_dir):
    n = 0
    for item in args.get("elements", []):
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
    uid = str(args["uid"])
    node = sess.uid_map.get(uid)
    if not node:
        raise KeyError(f"uid {uid} 已失效,请重新 take_snapshot")
    files = args.get("filePaths") if isinstance(args.get("filePaths"), list) else [args.get("filePaths")]
    sess.t.run_cdp("DOM.setFileInputFiles", files=[os.path.abspath(f) for f in files if f],
                   backendNodeId=node.get("backendDOMNodeId"))
    return {"uploaded": len(files)}


def handle_dialog(sess, args, session_dir):
    action = args.get("action", "accept")
    prompt = args.get("promptText")
    sess.t.handle_alert(action == "accept", send=prompt)
    return {"handled": True}


# ---- 导航/页签 ----

def navigate_page(sess, args, session_dir):
    t = sess.t
    typ = args.get("type", "url")
    if typ == "url":
        t.get(str(args["url"]))
    elif typ == "back":
        t.back()
    elif typ == "forward":
        t.forward()
    elif typ == "reload":
        t.refresh(ignore_cache=bool(args.get("ignoreCache")))
    try:
        t.wait.doc_loaded(15)
    except Exception:
        pass
    return {"url": _live_url(sess), "title": t.title}


def new_page(sess, args, session_dir):
    tab = sess.browser.new_tab(str(args["url"]), new_context=False)
    sess.tab = tab
    return {"url": tab.url, "title": tab.title}


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
        raise ValueError("最后一页不可关")
    sess.browser.close_tabs(tabs[idx])
    return {"closed": str(args["page_id"])}


def wait_for(sess, args, session_dir):
    t = sess.t
    texts = args["text"] if isinstance(args["text"], list) else [args["text"]]
    timeout = float(args.get("timeout") or 20)
    deadline = time.time() + timeout
    while time.time() < deadline:
        for txt in texts:
            if t.ele(f"text:{txt}"):
                return {"found": txt}
        time.sleep(0.3)
    raise TimeoutError(f"文本未出现: {texts} ({timeout}s)")


# ---- 截图/执行/调试 ----

def take_screenshot(sess, args, session_dir):
    t = sess.t
    full = bool(args.get("fullPage"))
    fmt = args.get("format", "png")
    raw = t.get_screenshot(full_page=full, as_bytes=fmt)
    fp = args.get("filePath") or sess.artifact_path(session_dir, "screenshot", fmt or "png")
    mode = "wb" if isinstance(raw, bytes) else "w"
    with open(fp, mode) as f:
        f.write(raw)
    return {"path": fp}


def evaluate_script(sess, args, session_dir):
    fn = str(args["function"])
    # 兼容 "() => expr" 箭头形式:直接交 DP run_js
    val = sess.t.run_js(fn)
    return {"value": _jsonable(val)}


def _jsonable(v):
    try:
        json.dumps(v)
        return v
    except Exception:
        return str(v)


def list_console_messages(sess, args, session_dir):
    """收割模式:返回上次调用以来新产生的 console 消息(带超时,永不阻塞)。"""
    types = args.get("types")
    out = []
    for m in sess.t.console.steps(timeout=0.5):
        out.append({"type": getattr(m, "type", ""), "text": str(m)[:500]})
    if types:
        out = [m for m in out if m["type"] in types]
    return {"messages": out, "note": "收割模式:每次调用返回自上次以来新捕获的消息"}


def get_console_message(sess, args, session_dir):
    raise ValueError("console 单条详情 M1 依赖列表内数据;请用 list_console_messages")


def list_network_requests(sess, args, session_dir):
    """收割模式:返回自上次调用以来新捕获的请求(listen 于会话启动即开启)。"""
    t = sess.t
    packets = []
    for p in t.listen.steps(timeout=0.5):
        packets.append(p)
    types = args.get("resourceTypes")
    out = [{"reqid": str(i), "method": p.method, "url": p.url,
            "status": getattr(p.response, "status", None)} for i, p in enumerate(packets)]
    if types:
        out = [r for r in out if any(ty.lower() in r["url"].lower() for ty in types)]
    return {"requests": out, "note": "收割模式:每次调用返回自上次以来新捕获的请求"}


def get_network_request(sess, args, session_dir):
    t = sess.t
    idx = int(args["reqid"])
    packets = list(t.listen.steps(count=None, timeout=0.2))
    p = packets[idx]
    body = None
    try:
        body = p.response.body
    except Exception:
        pass
    return {"request": {"method": p.method, "url": p.url,
                        "status": getattr(p.response, "status", None)}, "body": body}


def resize_page(sess, args, session_dir):
    sess.t.run_cdp("Emulation.setDeviceMetricsOverride",
                   width=int(args["width"]), height=int(args["height"]),
                   deviceScaleFactor=0, mobile=False)
    return {"done": True}


def emulate(sess, args, session_dir):
    # 红线:UA/平台/语言覆盖禁用(CONSTRAINT-001);支持 colorScheme/网络/cpu/geo
    t = sess.t
    if args.get("colorScheme"):
        t.run_cdp("Emulation.setEmulatedMedia", features=[{"name": "prefers-color-scheme", "value": args["colorScheme"]}])
    if args.get("cpuThrottlingRate"):
        t.run_cdp("Emulation.setCPUThrottlingRate", rate=args["cpuThrottlingRate"])
    if args.get("networkConditions"):
        conds = {"Offline": {"offline": True}, "Slow 3G": {"offline": False, "latency": 400,
                 "downloadThroughput": 0.4 * 125000, "uploadThroughput": 0.4 * 125000},
                 "Fast 3G": {"offline": False, "latency": 150,
                  "downloadThroughput": 1.6 * 125000, "uploadThroughput": 0.75 * 125000}}
        t.run_cdp("Network.emulateNetworkConditions", **conds.get(args["networkConditions"], {"offline": False}))
    return {"done": True}


def scroll_unknown_state(sess, args, session_dir):
    from .snapshot import settle_check
    return settle_check(sess)
