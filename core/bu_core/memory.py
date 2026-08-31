# -*- coding: utf-8 -*-
"""Memory 全套(13 工具):HeapProfiler 快照采集(事件流拼装)+ 纯数据结构查询。

参数面对齐 cdt v1.8.0:查询件以 filePath(.heapsnapshot 文件)为快照句柄、
nodeId 为节点句柄(= DevTools node ordinal,即快照 nodes 数组中的节点序号);
compare 用 baseFilePath/currentFilePath。retained size 由真 dominator tree
(Cooper-Harvey-Kennedy 迭代)计算;detachedness 直接来自快照 node_fields。
已知降级:DevTools 的 native context 归因过滤与 staticData 详情不实现(报告注记)。
"""
import json
import os
import re
import time
from collections import defaultdict, deque


class HeapSnapshot:
    """懒解析的堆快照:nodes/edges 展平数组 → 结构化记录。"""

    def __init__(self, path):
        with open(path, encoding="utf-8") as f:
            data = json.load(f)
        self.meta = data["snapshot"]["meta"]
        self.strings = data["strings"]
        nf = self.meta["node_fields"]
        ef = self.meta["edge_fields"]
        self.n_type_i = nf.index("type")
        self.n_name_i = nf.index("name")
        self.n_id_i = nf.index("id")
        self.n_edge_i = nf.index("edge_count")
        self.n_size_i = nf.index("self_size") if "self_size" in nf else None
        self.n_detach_i = nf.index("detachedness") if "detachedness" in nf else None
        self.e_type_i = ef.index("type")
        self.e_name_i = ef.index("name_or_index")
        self.e_node_i = ef.index("to_node")
        self.node_fields_count = len(nf)
        self.edge_fields_count = len(ef)
        raw_nodes = data["nodes"]
        raw_edges = data["edges"]
        node_types = self.meta["node_types"][0]
        edge_types = self.meta["edge_types"][0]
        self.nodes = []
        off = 0
        edge_off = 0
        while off < len(raw_nodes):
            ntype = node_types[raw_nodes[off + self.n_type_i]]
            name_id = raw_nodes[off + self.n_name_i]
            name = self.strings[name_id] if name_id < len(self.strings) else ""
            node = {
                "type": ntype,
                "name": name,
                "id": raw_nodes[off + self.n_id_i],
                "edge_count": raw_nodes[off + self.n_edge_i],
                "self_size": raw_nodes[off + self.n_size_i] if self.n_size_i is not None else 0,
                "detachedness": raw_nodes[off + self.n_detach_i] if self.n_detach_i is not None else 0,
                "edge_offset": edge_off,
                "index": len(self.nodes),
            }
            self.nodes.append(node)
            edge_off += raw_nodes[off + self.n_edge_i] * self.edge_fields_count
            off += self.node_fields_count
        self.edges = []
        eoff = 0
        while eoff < len(raw_edges):
            etype = edge_types[raw_edges[eoff + self.e_type_i]]
            name_or_index = raw_edges[eoff + self.e_name_i]
            self.edges.append({
                "type": etype,
                "name": self.strings[name_or_index] if name_or_index < len(self.strings) and etype != "element" else name_or_index,
                "to_node_offset": raw_edges[eoff + self.e_node_i],
            })
            eoff += self.edge_fields_count
        self._adj = None
        self._preds = None
        self._idom = None
        self._retained = None
        self._post = None

    # ---- 图结构(懒构建,缓存) ----

    def adjacency(self):
        """出边目标节点序号列表(每节点一列)。"""
        if self._adj is None:
            efc, nfc = self.edge_fields_count, self.node_fields_count
            self._adj = [
                [self.edges[nd["edge_offset"] // efc + i]["to_node_offset"] // nfc
                 for i in range(nd["edge_count"])]
                for nd in self.nodes
            ]
        return self._adj

    def predecessors(self):
        """反向边索引(节点序号 → 入边来源列表)。"""
        if self._preds is None:
            preds = defaultdict(list)
            for u, outs in enumerate(self.adjacency()):
                for v in outs:
                    preds[v].append(u)
            self._preds = preds
        return self._preds

    def _dfs(self):
        """从 Root 节点 DFS:返回(可达集, 后序列)。"""
        adj = self.adjacency()
        roots = [i for i, nd in enumerate(self.nodes) if nd["type"] == "Root"] or [0]
        visited = set(roots)
        post = []
        for r in roots:
            stack = [(r, iter(adj[r]))]
            while stack:
                node, it = stack[-1]
                advanced = False
                for v in it:
                    if v not in visited:
                        visited.add(v)
                        stack.append((v, iter(adj[v])))
                        advanced = True
                        break
                if not advanced:
                    post.append(node)
                    stack.pop()
        return visited, post

    def dominators(self):
        """Cooper-Harvey-Kennedy 迭代 → {节点序号: 直接支配者序号}(根指向自身)。"""
        if self._idom is None:
            visited, post = self._dfs()
            preds = self.predecessors()
            roots = [i for i, nd in enumerate(self.nodes) if nd["type"] == "Root"] or [0]
            idom = {r: r for r in roots}
            postnum = {node: i for i, node in enumerate(post)}

            def intersect(a, b):
                while a != b:
                    while postnum[a] < postnum[b]:
                        a = idom[a]
                    while postnum[b] < postnum[a]:
                        b = idom[b]
                return a

            changed = True
            while changed:
                changed = False
                for u in reversed(post):
                    if u in roots:
                        continue
                    new = None
                    for p in preds.get(u, []):
                        if p in idom:
                            new = p if new is None else intersect(new, p)
                    if new is not None and idom.get(u) != new:
                        idom[u] = new
                        changed = True
            self._idom = idom
            self._post = post
        return self._idom

    def retained_sizes(self):
        """retained size:dominator 树子树 self_size 之和(不可达节点仅自身)。"""
        if self._retained is None:
            idom = self.dominators()
            retained = [nd["self_size"] for nd in self.nodes]
            # 后序中子孙先于祖先出现,逆序累加即可
            for u in self._post:
                p = idom.get(u)
                if p is not None and p != u:
                    retained[p] += retained[u]
            self._retained = retained
        return self._retained

    def edges_of(self, node):
        """节点的出边(展开 to_node 偏移为目标节点)。"""
        out = []
        base = node["edge_offset"]
        for i in range(node["edge_count"]):
            e = self.edges[base // self.edge_fields_count + i]
            to_off = e["to_node_offset"]
            to_idx = to_off // self.node_fields_count
            if 0 <= to_idx < len(self.nodes):
                out.append({"type": e["type"], "name": e["name"], "to": self.nodes[to_idx]})
        return out

    def retainers_of(self, node):
        """节点的保留者(谁直接引用了它)。"""
        preds = self.predecessors()
        return [self.nodes[p] for p in preds.get(node["index"], [])]


# 快照缓存:path → HeapSnapshot(磁盘为单一事实源,close 即清)
_registry = {}


def _load(path):
    path = os.path.abspath(str(path))
    if path not in _registry:
        if not os.path.exists(path):
            raise ValueError(f"heapsnapshot 文件不存在: {path}(先 take_heapsnapshot)")
        _registry[path] = HeapSnapshot(path)
    return _registry[path]


def _page(items, args):
    """cdt 分页(pageIdx/pageSize,默认整表)。"""
    page_idx, page_size = args.get("pageIdx"), args.get("pageSize")
    if page_size is None and page_idx is None:
        return items
    page_size = max(int(page_size or len(items)), 1)
    start = int(page_idx or 0) * page_size
    return items[start:start + page_size]


def _parse_byte_range(s):
    """cdt byteSizeRange:"1MB-2MB" / "-1MB" / "1MB-" / "512KB"。"""
    units = {"KB": 1024, "MB": 1024 ** 2, "GB": 1024 ** 3, "B": 1}

    def one(t):
        t = str(t).strip().upper()
        for u, f in units.items():
            if t.endswith(u):
                return float(t[:-len(u)]) * f
        return float(t)

    s = str(s)
    if "-" in s:
        lo_s, hi_s = s.split("-", 1)
        return (one(lo_s) if lo_s.strip() else None, one(hi_s) if hi_s.strip() else None)
    return one(s), None


def _class_aggregates(hs):
    """类聚合(全量未分页;确定序:self_size 降序 → name)。class_nodes 的 id 即此序。"""
    retained = hs.retained_sizes()
    agg = {}
    for nd in hs.nodes:
        a = agg.setdefault(nd["name"], {"id": len(agg), "name": nd["name"],
                                        "count": 0, "self_size": 0, "retained_size": 0})
        a["count"] += 1
        a["self_size"] += nd["self_size"]
        a["retained_size"] += retained[nd["index"]]
    return sorted(agg.values(), key=lambda x: (-x["self_size"], x["name"]))


def _node_row(hs, nd, retained):
    return {"nodeId": nd["index"], "name": nd["name"], "type": nd["type"],
            "id": nd["id"], "self_size": nd["self_size"], "retained_size": retained[nd["index"]],
            "detachedness": nd["detachedness"]}


def take_heapsnapshot(sess, args, session_dir):
    from .cdp_events import CdpEvents
    if getattr(sess, "_cdp", None) is None:
        from .cdp_events import ensure_session_cdp
        ensure_session_cdp(sess)
    fp = args.get("filePath") or sess.artifact_path(session_dir, "heapsnapshot", "heapsnapshot")
    sess._cdp.call("HeapProfiler.enable")
    sess._cdp.send("HeapProfiler.collectGarbage")
    time.sleep(0.3)
    sess._cdp.send("HeapProfiler.takeHeapSnapshot", reportProgress=False)
    chunks = []
    deadline = time.time() + 25
    done = False
    while time.time() < deadline and not done:
        sess._cdp.pump()
        for m, p in sess._cdp.drain_events("HeapProfiler."):
            if m == "HeapProfiler.addHeapSnapshotChunk":
                chunks.append(p.get("chunk", ""))
            elif m == "HeapProfiler.reportHeapSnapshotProgress":
                if p.get("finished"):
                    done = True
        # 完成判定兜底:拼出的 JSON 可解析即完成(Edge 的 progress.finished 不可靠)
        if chunks and not done:
            try:
                json.loads("".join(chunks))
                done = True
            except Exception:
                pass
    raw = "".join(chunks)
    snap_obj = json.loads(raw)
    fp = os.path.abspath(fp)
    with open(fp, "w", encoding="utf-8") as f:
        json.dump(snap_obj, f)
    _registry[fp] = HeapSnapshot(fp)
    return {"path": fp, "nodes": snap_obj["snapshot"]["node_count"],
            "edges": snap_obj["snapshot"]["edge_count"]}


def close_heapsnapshot(sess, args, session_dir):
    fp = os.path.abspath(str(args.get("filePath")))
    if fp in _registry:
        del _registry[fp]
        return {"closed": fp}
    raise ValueError(f"Failed to close heap snapshot: {fp} was not loaded.")


def get_heapsnapshot_summary(sess, args, session_dir):
    hs = _load(args.get("filePath"))
    by_type = {}
    total_size = 0
    for n in hs.nodes:
        by_type[n["type"]] = by_type.get(n["type"], 0) + 1
        total_size += n["self_size"]
    detached = sum(1 for n in hs.nodes if n["detachedness"] == 2)
    return {"nodes": len(hs.nodes), "edges": len(hs.edges),
            "self_size_total": total_size, "nodes_by_type": by_type,
            "detached_dom_nodes": detached,
            "staticData": {"meta": hs.meta, "strings": len(hs.strings),
                           "nodes_array_length": len(hs.nodes) * hs.node_fields_count,
                           "edges_array_length": len(hs.edges) * hs.edge_fields_count},
            "note": "native context 归因统计为已知降级点(见审查报告)"}


def get_heapsnapshot_details(sess, args, session_dir):
    """cdt 语义:加载快照返回聚合信息(含分页)。native context 过滤为已知降级点。"""
    hs = _load(args.get("filePath"))
    agg = _class_aggregates(hs)
    if args.get("filterName"):
        agg = [a for a in agg if a["name"] == args["filterName"]]
    total = len(agg)
    agg = _page(agg, args)
    return {"total_classes": total, "aggregates": agg}


def get_heapsnapshot_class_nodes(sess, args, session_dir):
    """cdt 语义:id 为 details 聚合列表中的类序号,返回该类实例节点。"""
    hs = _load(args.get("filePath"))
    retained = hs.retained_sizes()
    agg = _class_aggregates(hs)
    cid = int(args["id"])
    if cid < 0 or cid >= len(agg):
        raise ValueError(f"class id {cid} 不在聚合列表 0..{len(agg) - 1}(先 get_heapsnapshot_details)")
    cname = agg[cid]["name"]
    rows = [_node_row(hs, n, retained) for n in hs.nodes if n["name"] == cname]
    return {"class": {"id": cid, "name": cname, "count": agg[cid]["count"]},
            "nodes": _page(rows, args)}


def get_heapsnapshot_retainers(sess, args, session_dir):
    hs = _load(args.get("filePath"))
    retained = hs.retained_sizes()
    nd = hs.nodes[int(args["nodeId"])]
    ret = hs.retainers_of(nd)
    return {"node": _node_row(hs, nd, retained),
            "retainers": _page([_node_row(hs, r, retained) for r in ret], args),
            "retainer_count": len(ret)}


def get_heapsnapshot_retaining_paths(sess, args, session_dir):
    """从目标节点沿 retainers BFS 回 Root(cdt: maxDepth/maxNodes/maxSiblings)。"""
    hs = _load(args.get("filePath"))
    nd = hs.nodes[int(args["nodeId"])]
    max_depth = int(args.get("maxDepth") or 10)
    max_nodes = int(args.get("maxNodes") or 20)
    max_siblings = int(args.get("maxSiblings") or 5)
    preds = hs.predecessors()
    paths = []
    seen = {nd["index"]}
    frontier = [(nd["index"], [])]
    depth = 0
    while frontier and depth < max_depth and len(paths) < max_nodes:
        nxt = []
        for idx, path in frontier:
            for p in preds.get(idx, [])[:max_siblings]:
                if p in seen:
                    continue
                seen.add(p)
                npath = [{"nodeId": p, "name": hs.nodes[p]["name"], "type": hs.nodes[p]["type"]}] + path
                if hs.nodes[p]["type"] in ("Root", "Synthetic"):
                    paths.append({"depth": len(npath), "chain": npath})
                    if len(paths) >= max_nodes:
                        return {"paths": paths}
                nxt.append((p, npath))
        frontier = nxt
        depth += 1
    return {"paths": paths or [{"depth": 0,
                                "chain": [{"nodeId": nd["index"], "name": nd["name"], "type": nd["type"]}]}]}


def get_heapsnapshot_edges(sess, args, session_dir):
    """出边引用(cdt: sortBy 默认 retainedSize,excludePrimitives 默认 true)。"""
    hs = _load(args.get("filePath"))
    retained = hs.retained_sizes()
    nd = hs.nodes[int(args["nodeId"])]
    sort_by = args.get("sortBy") or "retainedSize"
    exclude_primitives = args.get("excludePrimitives", True)
    primitive_types = {"string", "number", "boolean", "null", "undefined", "regexp"}
    rows = []
    for e in hs.edges_of(nd):
        to = e["to"]
        if exclude_primitives and to["type"] in primitive_types:
            continue
        rows.append({"edge_type": e["type"], "name": e["name"], "nodeId": to["index"],
                     "name_target": to["name"], "type": to["type"],
                     "self_size": to["self_size"], "retained_size": retained[to["index"]]})
    key = {"retainedSize": lambda r: -r["retained_size"], "selfSize": lambda r: -r["self_size"],
           "name": lambda r: r["name"]}.get(sort_by)
    if key is None:
        raise ValueError(f"sortBy 必须是 retainedSize/selfSize/name,收到 {sort_by}")
    rows.sort(key=key)
    return {"node": {"nodeId": nd["index"], "name": nd["name"]},
            "edges": _page(rows, args), "edge_count": len(rows)}


def get_heapsnapshot_dominators(sess, args, session_dir):
    """cdt 语义:返回指定节点的支配链(沿直接支配者到 Root)。"""
    hs = _load(args.get("filePath"))
    idom = hs.dominators()
    nd = hs.nodes[int(args["nodeId"])]
    chain = []
    cur = nd["index"]
    for _ in range(4096):  # 防御:病态环不至死循环
        cnd = hs.nodes[cur]
        chain.append(_node_row(hs, cnd, hs.retained_sizes()))
        nxt = idom.get(cur)
        if nxt is None or nxt == cur:
            break
        cur = nxt
    return {"node": _node_row(hs, nd, hs.retained_sizes()), "dominator_chain": chain}


def get_heapsnapshot_object_details(sess, args, session_dir):
    """cdt 语义:nodeId 对象详情(size/type/distance/detachedness + 出边简表)。"""
    hs = _load(args.get("filePath"))
    retained = hs.retained_sizes()
    nd = hs.nodes[int(args["nodeId"])]
    # distance:从 Root 沿出边 BFS 的最短跳数
    visited, _ = hs._dfs()
    adj = hs.adjacency()
    roots = [i for i, n2 in enumerate(hs.nodes) if n2["type"] == "Root"] or [0]
    dist = {r: 0 for r in roots}
    dq = deque(roots)
    while dq:
        u = dq.popleft()
        for v in adj[u]:
            if v not in dist:
                dist[v] = dist[u] + 1
                dq.append(v)
    out_edges = [{"name": e["name"], "to": e["to"]["name"], "type": e["to"]["type"]}
                 for e in hs.edges_of(nd)[:50]]
    return {"node": _node_row(hs, nd, retained),
            "distance": dist.get(nd["index"], -1),
            "reachable_from_root": nd["index"] in visited,
            "out_edges_sample": out_edges}


def get_heapsnapshot_duplicate_strings(sess, args, session_dir):
    hs = _load(args.get("filePath"))
    seen = {}
    for s in hs.strings:
        if len(s) >= 1:
            seen[s] = seen.get(s, 0) + 1
    dups = [(s, c) for s, c in seen.items() if c > 1]
    dups.sort(key=lambda x: -x[1] * len(x[0]))
    rows = [{"string": s[:120], "count": c, "wasted_bytes": c * len(s)} for s, c in dups]
    total = len(rows)
    return {"duplicates": _page(rows, args), "total_duplicate_groups": total}


def query_heapsnapshot_objects(sess, args, session_dir):
    """cdt 语义:className(正则或文本)/nodeType/selfSize/retainedSize/isDetached/
    sortBy/pageIdx/pageSize。"""
    hs = _load(args.get("filePath"))
    retained = hs.retained_sizes()
    class_name = args.get("className")
    matcher = None
    if class_name:
        try:
            rx = re.compile(class_name)
            matcher = lambda name: bool(rx.search(name))  # noqa: E731
        except re.error:
            matcher = lambda name: class_name in name  # noqa: E731
    node_type = args.get("nodeType")
    min_self, max_self = _parse_byte_range(args["selfSize"]) if args.get("selfSize") else (None, None)
    min_ret, max_ret = _parse_byte_range(args["retainedSize"]) if args.get("retainedSize") else (None, None)
    is_detached = args.get("isDetached")
    out = []
    for n in hs.nodes:
        if matcher and not matcher(n["name"]):
            continue
        if node_type and n["type"] != node_type:
            continue
        if min_self is not None and n["self_size"] < min_self:
            continue
        if max_self is not None and n["self_size"] > max_self:
            continue
        r = retained[n["index"]]
        if min_ret is not None and r < min_ret:
            continue
        if max_ret is not None and r > max_ret:
            continue
        if is_detached is not None and (n["detachedness"] == 2) != bool(is_detached):
            continue
        out.append(_node_row(hs, n, retained))
    sort_by = args.get("sortBy") or "retainedSize"
    key = {"retainedSize": lambda r: -r["retained_size"], "selfSize": lambda r: -r["self_size"],
           "id": lambda r: r["nodeId"]}.get(sort_by)
    if key is None:
        raise ValueError(f"sortBy 必须是 retainedSize/selfSize/id,收到 {sort_by}")
    out.sort(key=key)
    total = len(out)
    return {"objects": _page(out, args), "matched": total}


def compare_heapsnapshots(sess, args, session_dir):
    """cdt 语义:baseFilePath/currentFilePath(+可选 classIndex 转对象级 diff)。"""
    base = _load(args.get("baseFilePath"))
    target = _load(args.get("currentFilePath"))
    base_agg, tgt_agg = {}, {}
    for n in base.nodes:
        a = base_agg.setdefault(n["name"], [0, 0])
        a[0] += 1
        a[1] += n["self_size"]
    for n in target.nodes:
        a = tgt_agg.setdefault(n["name"], [0, 0])
        a[0] += 1
        a[1] += n["self_size"]
    delta = []
    for name in set(base_agg) | set(tgt_agg):
        b = base_agg.get(name, [0, 0])
        t = tgt_agg.get(name, [0, 0])
        dc, ds = t[0] - b[0], t[1] - b[1]
        if dc or ds:
            delta.append({"name": name, "count_delta": dc, "size_delta": ds})
    delta.sort(key=lambda x: -abs(x["size_delta"]))
    class_index = args.get("classIndex")
    if class_index is not None:
        # 对象级 diff:取基线聚合列表中的类,逐一匹配两侧行
        base_sorted = sorted(base_agg.items(), key=lambda kv: (-kv[1][1], kv[0]))
        cname = base_sorted[int(class_index)][0]
        base_nodes = [n["index"] for n in base.nodes if n["name"] == cname]
        tgt_nodes = [n["index"] for n in target.nodes if n["name"] == cname]
        return {"class_index": int(class_index), "class": cname,
                "base_count": len(base_nodes), "current_count": len(tgt_nodes),
                "summary_top": _page(delta, args)}
    return {"top": _page(delta, args), "total_changed_classes": len(delta)}
