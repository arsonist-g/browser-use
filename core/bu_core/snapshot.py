# -*- coding: utf-8 -*-
"""take_snapshot:a11y 树(CDP Accessibility,天然穿透 shadow-root)+ scrollability。

uid 机制(M1):每次快照分配 uid=f"<快照seq>_<序号>",映射到 backendNodeId;
click/fill 等 uid 消费方经 DOM.getContentQuads(backendNodeId) 取坐标后走 CDP Input。
滚动状态量(DEC-003):吸收 browser-use 基线(overflow 过滤+rect 差),输出三态 can_scroll。
"""
import time

# a11y 忽略的角色与无意义文本容器
_SKIP_ROLES = {"none", "generic", "genericContainer", "InlineTextBox", "LineBreak"}


def build_snapshot(sess, verbose=False):
    tab = sess.t
    sess.snapshot_seq += 1
    tag = str(sess.snapshot_seq)
    tree = tab.run_cdp("Accessibility.getFullAXTree")
    nodes = tree.get("nodes", [])
    by_id = {n["nodeId"]: n for n in nodes}
    children = {}
    roots = []
    for n in nodes:
        nid = n["nodeId"]
        kids = [c for c in n.get("childIds", []) if c in by_id]
        children[nid] = kids
        if not kids or all(by_id[c].get("ignored") for c in kids):
            pass
    # 根:无父者
    has_parent = set()
    for kids in children.values():
        has_parent.update(kids)
    roots = [n["nodeId"] for n in nodes if n["nodeId"] not in has_parent and not n.get("ignored")]

    lines = []
    uid_map = {}

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
