# -*- coding: utf-8 -*-
"""take_snapshot:a11y 树(CDP Accessibility,天然穿透 shadow-root)+ scrollability。

uid 机制(M1):每次快照分配 uid=f"<快照seq>_<序号>",映射到 backendNodeId;
click/fill 等 uid 消费方经 DOM.getContentQuads(backendNodeId) 取坐标后走 CDP Input。
跨域 iframe(OOPIF,独立 CDP target):主 frame 的 AX 树只见占位节点——按 frame 逐个
取树并拼接到宿主 Iframe 节点下(对齐上游 TextSnapshot includeIframes 语义);
uid_map 同步记录 frame 归属(uid_frames),消费方据此路由 CDP session。
滚动状态量(DEC-003):吸收 browser-use 基线(overflow 过滤+rect 差),输出三态 can_scroll。
"""
import time

from .cdp_events import ensure_oopif_attach

# a11y 忽略的角色与无意义文本容器
_SKIP_ROLES = {"none", "generic", "genericContainer", "InlineTextBox", "LineBreak"}


def _frame_map(cdp):
    """frame 归属表:{frameId: {"session": sid|None, "parent": frameId|None}}。
    主 session 的 getFrameTree 给出主 frame + 同进程子 frame(OOPIF 不在其中,
    由各 OOPIF 子 session 的 getFrameTree 补 own frameId,parent 未知记 None)。"""
    frames = {}
    try:
        ft = (cdp.call("Page.getFrameTree", timeout=10) or {}).get("frameTree") or {}
    except Exception:
        return frames

    def walk(node, parent):
        fid = (node.get("frame") or {}).get("id")
        if fid:
            frames[fid] = {"session": None, "parent": parent}
        for c in node.get("childFrames") or []:
            walk(c, fid)

    walk(ft, None)
    for sid in list(cdp.child_sessions):
        try:
            sub = (cdp.call("Page.getFrameTree", timeout=10, session_id=sid)
                   or {}).get("frameTree") or {}
            fid = (sub.get("frame") or {}).get("id")
            if not fid:
                continue
            frames.setdefault(fid, {"session": None, "parent": None})["session"] = sid
        except Exception:
            continue
    return frames


def _splice_frames(cdp, nodes, by_id, children):
    """全部子 frame 取 AX 树拼进宿主 Iframe 节点(对齐上游 TextSnapshot includeIframes)。
    同进程子 frame:主 session 带 frameId 参数直取(实测支持);OOPIF:子 session 取。
    宿主挂点 = DOM.getFrameOwner(frameId) 的 backendNodeId(宿主 frame 的 session 发,
    OOPIF parent 未知时发主 session 亦可解析)。宿主定位在已并入节点的 backendDOMNodeId
    索引中(backendNodeId 浏览器级唯一)。返回 (frame_nodes, host_nodes)。"""
    frame_nodes = {}
    host_nodes = {}
    frames = _frame_map(cdp)
    if not frames:
        return frame_nodes, host_nodes
    main_fid = next((f for f, i in frames.items()
                     if i["parent"] is None and not i["session"]), None)
    # 处理序:同进程 frame 按 frameTree 自顶向下(BFS),OOPIF 按 attach 序追加
    # (浏览器外层 frame 先 attach,嵌套时宿主 OOPIF 先拼入)
    order = []
    queue = [main_fid] if main_fid else []
    while queue:
        fid = queue.pop(0)
        for f, i in frames.items():
            if i["parent"] == fid and not i["session"]:
                order.append(f)
                queue.append(f)
    order += [f for f, i in frames.items() if i["session"]]

    bnn_index = {}
    for n in nodes:
        if n.get("backendDOMNodeId") is not None:
            bnn_index.setdefault(n["backendDOMNodeId"], n["nodeId"])

    merged = 0
    for fid in order:
        info = frames[fid]
        sid = info["session"]
        parent_sid = frames.get(info["parent"], {}).get("session") if info["parent"] else None
        try:
            owner = cdp.call("DOM.getFrameOwner", frameId=fid, timeout=10,
                             session_id=parent_sid)
            if sid:
                sub_tree = cdp.call("Accessibility.getFullAXTree", timeout=10, session_id=sid)
            else:
                sub_tree = cdp.call("Accessibility.getFullAXTree", timeout=10, frameId=fid)
        except Exception:
            continue
        host_nid = bnn_index.get(owner.get("backendNodeId"))
        sub_nodes = sub_tree.get("nodes") or []
        if not host_nid or not sub_nodes:
            continue
        # 子树 nodeId 加前缀防跨 frame 冲突,并入合并结构
        pref = f"s{merged}_"
        for n in sub_nodes:
            n["nodeId"] = pref + str(n["nodeId"])
            n["childIds"] = [pref + str(c) for c in (n.get("childIds") or [])]
        sub_parents = set()
        for n in sub_nodes:
            sub_parents.update(n["childIds"])
        sub_roots = [n["nodeId"] for n in sub_nodes if n["nodeId"] not in sub_parents]
        for n in sub_nodes:  # 先全量入 by_id 再算 children(子节点可能后于父出现)
            by_id[n["nodeId"]] = n
        for n in sub_nodes:
            children[n["nodeId"]] = [c for c in n["childIds"] if c in by_id]
            if sid:
                frame_nodes[n["nodeId"]] = sid
            host_nodes[n["nodeId"]] = owner.get("backendNodeId")
            if n.get("backendDOMNodeId") is not None:
                bnn_index.setdefault(n["backendDOMNodeId"], n["nodeId"])
        children[host_nid] = children.get(host_nid, []) + sub_roots
        merged += 1
    return frame_nodes, host_nodes


def build_snapshot(sess, verbose=False):
    tab = sess.t
    sess.snapshot_seq += 1
    tag = str(sess.snapshot_seq)
    # OOPIF 拼接:attach 管理失败时降级纯主树(跨域 iframe 内容缺失,工具不崩)
    try:
        cdp = ensure_oopif_attach(sess)
    except Exception:
        cdp = None
    tree = tab.run_cdp("Accessibility.getFullAXTree")
    nodes = tree.get("nodes", [])
    by_id = {n["nodeId"]: n for n in nodes}
    children = {}
    for n in nodes:
        nid = n["nodeId"]
        children[nid] = [c for c in n.get("childIds", []) if c in by_id]
    frame_nodes, host_nodes = _splice_frames(cdp, nodes, by_id, children) if cdp else ({}, {})
    # 根:无父者(拼接后子树根已有宿主父,不会误判为顶层)
    has_parent = set()
    for kids in children.values():
        has_parent.update(kids)
    roots = [n["nodeId"] for n in nodes if n["nodeId"] not in has_parent and not n.get("ignored")]

    lines = []
    uid_map = {}
    uid_frames = {}
    uid_hosts = {}

    def role_of(n):
        return (n.get("role") or {}).get("value", "")

    def name_of(n):
        return (n.get("name") or {}).get("value", "")

    def props_of(n):
        out = {}
        for p in n.get("properties", []):
            k, v = p.get("name"), p.get("value", {}).get("value")
            if k in ("focusable", "focused", "disabled", "checked", "expanded", "editable", "required", "level"):
                if v is True:
                    out[k] = ""
                elif v is not False:
                    out[f"{k}={v}"] = ""
        return " " + " ".join(out) if out else ""

    def walk(nid, depth):
        n = by_id.get(nid)
        if not n or (n.get("ignored") and not verbose):
            for c in children.get(nid, []):
                walk(c, depth)
            return
        role = role_of(n)
        name = name_of(n)
        uid = f"{tag}_{len(uid_map)}"
        uid_map[uid] = n
        if nid in frame_nodes:
            uid_frames[uid] = frame_nodes[nid]
            uid_hosts[uid] = host_nodes.get(nid)
        attrs = props_of(n)
        url = (n.get("value") or {}).get("value") if role in ("link",) else None
        label = f'{role}' + (f' "{name}"' if name else "") + (f' url="{url}"' if url else "") + attrs
        lines.append("  " * depth + f"uid={uid} {label}".rstrip())
        for c in children.get(nid, []):
            walk(c, depth + 1)

    for r in roots:
        walk(r, 0)

    scroll = scrollability(tab)
    try:
        live = tab.run_js("return location.href")
    except Exception:
        live = None
    header = f'doc url="{live or tab.url}"'
    body = "\n".join(lines)
    scroll_lines = []
    hints = []
    for c in scroll:
        arrow = f"↓{c['pages_below']}p ↑{c['pages_above']}p {c['pct']}%"
        can = "unknown" if c.get("can_scroll") == "unknown" else ("down" if c["can_scroll"]["down"] else ("up" if c["can_scroll"]["up"] else "none"))
        scroll_lines.append(f'scroll={c["tag"]}.{c["cls"]} {arrow} can={can}')
        if c["pages_below"] > 0:
            hints.append(f"hint: content below viewport on <{c['tag']} class={c['cls']}> — scroll to reveal")
    text = "\n".join([header] + scroll_lines + ([body] if body else []) + hints)
    sess.uid_map = uid_map
    sess.uid_frames = uid_frames
    sess.uid_hosts = uid_hosts
    return {"text": text, "uid_count": len(uid_map), "scroll": scroll}


_SCROLL_JS = """
return (() => {
  const out = [];
  const els = [document.scrollingElement, document.documentElement,
               ...document.querySelectorAll('div,main,section,article,aside,nav,iframe')];
  const vh = window.innerHeight || 800;
  for (const el of els) {
    if (!el || el === document) continue;
    const cs = getComputedStyle(el);
    const oy = cs.overflowY, ox = cs.overflowX;
    const scrollableY = ['auto','scroll','overlay'].includes(oy) && el.scrollHeight > el.clientHeight + 1;
    const scrollableX = ['auto','scroll','overlay'].includes(ox) && el.scrollWidth > el.clientWidth + 1;
    if (!scrollableY && !scrollableX) continue;
    const hasScrollableChild = out.some(o => el.contains(o.el));
    if (hasScrollableChild) continue; // 嵌套去重:只显示最外层
    const above = el.scrollTop, below = el.scrollHeight - el.clientHeight - el.scrollTop;
    out.push({
      el, tag: el.tagName.toLowerCase(), cls: (el.className && el.className.baseVal !== undefined ? '' : String(el.className || '')).slice(0, 40),
      pages_above: +(above / vh).toFixed(1), pages_below: +(below / vh).toFixed(1),
      pct: el.scrollHeight > el.clientHeight ? Math.round(el.scrollTop / Math.max(1, el.scrollHeight - el.clientHeight) * 100) : 0,
      scrollHeight: el.scrollHeight, scrollTop: el.scrollTop,
      canX: scrollableX ? (el.scrollWidth - el.clientWidth - el.scrollLeft) : 0,
    });
  }
  return out.map(o => ({tag:o.tag, cls:o.cls, pages_above:o.pages_above, pages_below:o.pages_below,
    pct:o.pct, scrollHeight:o.scrollHeight, scrollTop:o.scrollTop, canX:o.canX}));
})()
"""


def scrollability(tab):
    """主文档可滚动容器(iframe 深扫 M2;can_scroll 三态的 unknown 在消费方按 settle 时间判定)。"""
    try:
        rows = tab.run_js(_SCROLL_JS) or []
    except Exception:
        return []
    out = []
    for r in rows:
        can = {"up": r.get("pages_above", 0) > 0, "down": r.get("pages_below", 0) > 0}
        out.append({**r, "can_scroll": can})
    return out


def settle_check(sess, container_hint=None, wait_s=2.0):
    """懒加载三态:高度 2s 不变 → unknown 转 yes/no。"""
    tab = sess.t
    h1 = tab.run_js("document.scrollingElement ? document.scrollingElement.scrollHeight : document.body.scrollHeight")
    time.sleep(wait_s)
    h2 = tab.run_js("document.scrollingElement ? document.scrollingElement.scrollHeight : document.body.scrollHeight")
    return {"height_stable": h1 == h2, "before": h1, "after": h2}
