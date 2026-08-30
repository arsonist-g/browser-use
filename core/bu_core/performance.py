# -*- coding: utf-8 -*-
"""Performance 三件套:start_trace(Tracing 域采集)/ stop_trace(落盘 JSON)/
analyze_insight(自建最小指标集:LCP/长任务/布局抖动聚合;全量 19 个 DevTools
insight 的对齐为已知风险项,收敛策略见 architecture.md Delta)。
"""
import json
import os
import time

from .cdp_events import CdpEvents


def start_trace(sess, args, session_dir):
    if getattr(sess, "_cdp", None) is None:
        sess._cdp = CdpEvents(sess.port).connect()
    sess._cdp.send("Tracing.start", traceConfig={
        "traceConfig": {"recordMode": "recordUntilFull",
                        "includedCategories": ["devtools.timeline", "v8.execute",
                                               "disabled-by-default-devtools.timeline.frame",
                                               "loading", "paint", "netlog"]}})
    sess._tracing_on = True
    return {"started": True, "note": "autoStop 默认在下次导航/显式 stop 前持续采集"}


def stop_trace(sess, args, session_dir):
    if getattr(sess, "_cdp", None) is None or not getattr(sess, "_tracing_on", False):
        raise RuntimeError("trace 未开启(先 performance_start_trace)")
    events = []
    sess._cdp.send("Tracing.end")
    deadline = time.time() + 30
    done = False
    while time.time() < deadline and not done:
        sess._cdp.pump()
        for m, p in sess._cdp.drain_events("Tracing."):
            if m == "Tracing.dataCollected":
                events.extend(p.get("value", []))
            elif m == "Tracing.tracingComplete":
                done = True
    fp = args.get("filePath") or sess.artifact_path(session_dir, "trace", "json")
    with open(fp, "w", encoding="utf-8") as f:
        json.dump({"traceEvents": events}, f, ensure_ascii=False)
    sess._tracing_on = False
    try:
        sess._cdp.close()
        sess._cdp = None
    except Exception:
        pass
    return {"path": fp, "events": len(events)}


def analyze_insight(sess, args, session_dir):
    """自建最小指标集(真值来自已落盘 trace):长任务(>50ms)、布局抖动计数、
    LCP 候选(largest Image/Paint 事件)、网络请求数。"""
    fp = args.get("filePath")
    if not fp or not os.path.exists(fp):
        raise ValueError("需要 performance_stop_trace 产出的 filePath")
    with open(fp, encoding="utf-8") as f:
        trace = json.load(f)
    ev = trace.get("traceEvents", [])
    long_tasks, layout_shifts, lcp_best = [], [], 0.0
    net_requests = 0
    for e in ev:
        name = e.get("name", "")
        dur = e.get("dur", 0) / 1000.0
        if name in ("RunTask", "ThreadControllerImpl::RunTask") and dur > 50:
            long_tasks.append(round(dur, 1))
        if name == "LayoutShift":
            layout_shifts.append(e)
        if name in ("largestContentfulPaint::Candidate", "LargestContentfulPaint::Candidate"):
            ts = e.get("ts", 0)
            lcp_best = max(lcp_best, ts)
        if name.startswith("Resource") or name == "ResourceSendRequest":
            net_requests += 1
    lcp_ms = None
    if lcp_best and ev:
        t0 = min(e.get("ts", 0) for e in ev)
        lcp_ms = round((lcp_best - t0) / 1000.0, 1)
    return {
        "long_tasks_over_50ms": len(long_tasks),
        "long_tasks_ms_top10": sorted(long_tasks, reverse=True)[:10],
        "layout_shifts": len(layout_shifts),
        "lcp_ms_candidate": lcp_ms,
        "network_requests": net_requests,
        "note": "自建最小指标集;DevTools 19 项 insight 全对齐为后续迭代(风险项已备案)",
    }


# 工具注册名对齐 chrome-devtools-mcp
performance_start_trace = start_trace
performance_stop_trace = stop_trace
performance_analyze_insight = analyze_insight
