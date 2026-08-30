# -*- coding: utf-8 -*-
"""Memory 全套(13 工具):HeapProfiler 快照采集(事件流拼装)+ 纯数据结构查询。

快照文件格式(v8 heapsnapshot JSON):snapshot.meta(nodes/edges 字段表)+
nodes(Uint32 数组:每节点 node_fields_count 个字段,首字段 type,含 name_id/id)
+ edges + strings[]。解析成节点表后,13 个查询全部是对节点/边的遍历与聚合。
已知体量:27k nodes / 106k edges(实测),纯 Python 解析 < 5s,常驻内存上限受
log_max_bytes 约束的产物目录管理。
"""
import json
import os
import time


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
        """节点的保留者(谁引用了它):反向扫描 edges 的 to 偏移。"""
        target_off = node["edge_offset"]
        out = []
        for i, e in enumerate(self.edges):
            if e["to_node_offset"] == target_off:
                from_idx = (i // self.edge_fields_count)
                out.append(self.nodes[from_idx])
        return out


_registry = {}  # snapshot_id -> (HeapSnapshot, path)


def _load(sess, snapshot_id):
    if snapshot_id not in _registry:
        raise ValueError(f"未知 snapshot_id: {snapshot_id}(先 take_heapsnapshot)")
    return _registry[snapshot_id][0]


def take_heapsnapshot(sess, args, session_dir):
    from .cdp_events import CdpEvents
    if getattr(sess, "_cdp", None) is None:
        sess._cdp = CdpEvents(sess.port).connect()
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
    sid = f"hs-{len(_registry) + 1}"
    fp = sess.artifact_path(session_dir, "heapsnapshot", "heapsnapshot")
    with open(fp, "w", encoding="utf-8") as f:
        json.dump(snap_obj, f)
    _registry[sid] = (HeapSnapshot(fp), fp)
    meta = snap_obj["snapshot"]["meta"]
    return {"snapshot_id": sid, "path": fp, "nodes": snap_obj["snapshot"]["node_count"],
            "edges": snap_obj["snapshot"]["edge_count"], "fields": len(meta["node_fields"])}


def close_heapsnapshot(sess, args, session_dir):
    sid = args.get("snapshot_id")
    if sid in _registry:
        del _registry[sid]
        return {"closed": sid}
    raise ValueError(f"未知 snapshot_id: {sid}")


def _match_type(want):
    return None if not want else want


def get_heapsnapshot_summary(sess, args, session_dir):
    hs = _load(sess, args.get("snapshot_id"))
    by_type = {}
    total_size = 0
    for n in hs.nodes:
        by_type[n["type"]] = by_type.get(n["type"], 0) + 1
        total_size += n["self_size"]
    return {"nodes": len(hs.nodes), "edges": len(hs.edges),
            "self_size_total": total_size, "nodes_by_type": by_type}


def get_heapsnapshot_class_nodes(sess, args, session_dir):
    hs = _load(sess, args.get("snapshot_id"))
    want = _match_type(args.get("type"))
    limit = int(args.get("limit") or 50)
    agg = {}
    for n in hs.nodes:
        if want and n["type"] != want:
            continue
        key = n["name"] or "(anonymous)"
        a = agg.setdefault(key, {"name": key, "count": 0, "self_size": 0})
        a["count"] += 1
        a["self_size"] += n["self_size"]
    top = sorted(agg.values(), key=lambda x: -x["self_size"])[:limit]
    return {"classes": top, "total": len(agg)}


def get_heapsnapshot_details(sess, args, session_dir):
    hs = _load(sess, args.get("snapshot_id"))
    name = args.get("name")
    if not name:
        raise ValueError("需要 name(类名/节点名)")
    out = [n for n in hs.nodes if n["name"] == name][:int(args.get("limit") or 100)]
    return {"name": name, "count": len(out),
            "nodes": [{"index": n["index"], "type": n["type"], "id": n["id"], "self_size": n["self_size"]} for n in out]}


def get_heapsnapshot_duplicate_strings(sess, args, session_dir):
    hs = _load(sess, args.get("snapshot_id"))
    min_len = int(args.get("min_length") or 10)
    seen = {}
    for s in hs.strings:
        if len(s) >= min_len:
            seen[s] = seen.get(s, 0) + 1
    dups = [(s, c) for s, c in seen.items() if c > 1]
    dups.sort(key=lambda x: -x[1] * len(x[0]))
    return {"duplicates": [{"string": s[:120], "count": c, "wasted_bytes": c * len(s)} for s, c in dups[:int(args.get("limit") or 50)]],
            "total_duplicate_groups": len(dups)}


def get_heapsnapshot_edges(sess, args, session_dir):
    hs = _load(sess, args.get("snapshot_id"))
    idx = int(args.get("node_index"))
    node = hs.nodes[idx]
    return {"node": {"name": node["name"], "type": node["type"]},
            "edges": [{"type": e["type"], "name": e["name"], "to": e["to"]["name"], "to_type": e["to"]["type"]} for e in hs.edges_of(node)[:int(args.get("limit") or 100)]]}


def get_heapsnapshot_retainers(sess, args, session_dir):
    hs = _load(sess, args.get("snapshot_id"))
    idx = int(args.get("node_index"))
    node = hs.nodes[idx]
    ret = hs.retainers_of(node)
    return {"node": {"name": node["name"], "type": node["type"], "self_size": node["self_size"]},
            "retainers": [{"name": r["name"], "type": r["type"], "self_size": r["self_size"]} for r in ret[:int(args.get("limit") or 100)]],
            "retainer_count": len(ret)}


def get_heapsnapshot_retaining_paths(sess, args, session_dir):
    """简版保留路径:从目标节点出发,沿 retainers BFS 回到 GC 根(截断深度 10)。"""
    hs = _load(sess, args.get("snapshot_id"))
    idx = int(args.get("node_index"))
    node = hs.nodes[idx]
    # 反向边索引(一次性构建,160k 边 <2s)
    rev = {}
    for i, e in enumerate(hs.edges):
        rev.setdefault(e["to_node_offset"], []).append(i)
    paths = []
    seen = {node["edge_offset"]}
    frontier = [(node, [])]
    depth = 0
    while frontier and depth < 10 and len(paths) < int(args.get("limit") or 5):
        nxt = []
        for n, path in frontier:
            for ei in rev.get(n["edge_offset"], []):
                e = hs.edges[ei]
                from_idx = ei // hs.edge_fields_count
                frm = hs.nodes[from_idx]
                if frm["edge_offset"] in seen:
                    continue
                seen.add(frm["edge_offset"])
                p = [{"name": frm["name"], "type": frm["type"]}] + path
                if frm["type"] in ("Root", "Synthetic"):
                    paths.append(p)
                    if len(paths) >= int(args.get("limit") or 5):
                        return {"paths": [{"depth": len(p), "chain": p} for p in paths]}
                nxt.append((frm, p))
        frontier = nxt
        depth += 1
    return {"paths": [{"depth": len(p), "chain": p} for p in paths] or
            [{"depth": 0, "chain": [{"name": node["name"], "type": node["type"]}]}]}


def get_heapsnapshot_dominators(sess, args, session_dir):
    """M1 近似:按 self_size+聚合引用权重排序的 top 节点(完整 dominator 树为后续迭代)。"""
    hs = _load(sess, args.get("snapshot_id"))
    limit = int(args.get("limit") or 50)
    weight = {}
    for e in hs.edges:
        weight[e["to_node_offset"]] = weight.get(e["to_node_offset"], 0) + 1
    top = sorted(hs.nodes, key=lambda n: -(n["self_size"] + weight.get(n["edge_offset"], 0) * 8))[:limit]
    return {"approx_top_by_weight": [{"name": n["name"], "type": n["type"], "self_size": n["self_size"],
                                      "in_edges": weight.get(n["edge_offset"], 0)} for n in top],
            "note": "近似权重排序;完整 dominator 树算法为后续迭代"}


def get_heapsnapshot_object_details(sess, args, session_dir):
    hs = _load(sess, args.get("snapshot_id"))
    idx = int(args.get("node_index"))
    node = hs.nodes[idx]
    return {"node": {"name": node["name"], "type": node["type"], "id": node["id"], "self_size": node["self_size"]},
            "out_edges": hs.edges_of(node)[:int(args.get("limit") or 50)]}


def query_heapsnapshot_objects(sess, args, session_dir):
    """v1.8.0 新增:按类名/类型查询对象列表。"""
    hs = _load(sess, args.get("snapshot_id"))
    name = args.get("name")
    want = _match_type(args.get("type"))
    limit = int(args.get("limit") or 100)
    out = []
    for n in hs.nodes:
        if name and n["name"] != name:
            continue
        if want and n["type"] != want:
            continue
        out.append({"index": n["index"], "name": n["name"], "type": n["type"],
                    "id": n["id"], "self_size": n["self_size"]})
        if len(out) >= limit:
            break
    return {"objects": out, "matched": len(out)}


def compare_heapsnapshots(sess, args, session_dir):
    base = _load(sess, args.get("base_snapshot_id"))
    target = _load(sess, args.get("target_snapshot_id"))
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
    return {"added": len(delta), "top": delta[:int(args.get("limit") or 50)]}
