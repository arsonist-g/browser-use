# -*- coding: utf-8 -*-
"""Performance 三件套(对齐 cdt v1.8.0 行为契约):

- start_trace:reload(默认 true,先 about:blank 清态再回原 URL)+ autoStop(默认 true,
  固定 5s 后自动停止);单例(已在录制则报错);类别 = DevTools 默认集(cdt 同源)。
- stop_trace:未在录制时为 no-op(cdt 同);filePath 支持 .json/.gz。
- analyze_insight:自建最小指标集(DevTools TraceEngine 19 项全对齐为备案的已知风险项,
  收敛策略见 architecture.md Delta)——参数保持 insightSetId/insightName 形状上的兼容入口,
  另支持 filePath 直接分析已落盘 trace(私有扩展,报告注明)。
"""
import gzip
import json
import os
import time

# DevTools Tracing 默认类别(cdt: '-*' + TracingDefaultCategories + JsSampling + Screenshot)
_TRACE_CATEGORIES = [
    "-*",
    "blink.console", "blink.user_timing", "devtools.timeline", "loading",
    "disabled-by-default-devtools.screenshot",
    "disabled-by-default-devtools.timeline.frame",
    "disabled-by-default-devtools.timeline.stack",
    "disabled-by-default-v8.cpu_profiler", "disabled-by-default-v8.cpu_profiler.hires",
    "latencyInfo", "v8.execute", "v8",
    "disabled-by-default-lighthouse",
]


def _ensure_cdp(sess):
    from .cdp_events import ensure_session_cdp
    return ensure_session_cdp(sess)


def _start_tracing(cdp):
    """Tracing.start 用 call(等响应):闲置后的半开连接 send 不报错但命令石沉大海,
    等不到响应即重连重发。"""
    try:
        cdp.call("Tracing.start", timeout=5,
                 traceConfig={"recordMode": "recordUntilFull",
                              "includedCategories": _TRACE_CATEGORIES})
    except Exception:
        cdp.reconnect()
        cdp.call("Tracing.start", timeout=5,
                 traceConfig={"recordMode": "recordUntilFull",
                              "includedCategories": _TRACE_CATEGORIES})


def performance_start_trace(sess, args, session_dir):
    from .tools import _live_url  # 局部导入:tools.py 底部反向挂载本模块,顶层导入会循环
    if getattr(sess, "_tracing_on", False):
        raise RuntimeError("a performance trace is already running. Use performance_stop_trace "
                           "to stop it. Only one trace can be running at any given time.")
    sess._tracing_on = True
    cdp = _ensure_cdp(sess)
    t = sess.t
    reload = bool(args.get("reload", True))
    try:
        url_for_tracing = _live_url(sess)
        if reload:
            t.get("about:blank")  # 清态(cdt 同;waitUntil load)
        _start_tracing(cdp)
        if reload:
            t.get(url_for_tracing)
            try:
                t.wait.doc_loaded(20)
            except Exception:
                pass
        if args.get("autoStop", True):
            time.sleep(5)
            return performance_stop_trace(sess, {"filePath": args.get("filePath")}, session_dir)
        return {"started": True, "note": "recording; use performance_stop_trace to stop"}
    except Exception:
        # 出错时复位(cdt 同:避免录制标志卡死)
        try:
            cdp.send("Tracing.end")
        except Exception:
            pass
        sess._tracing_on = False
        raise


def performance_stop_trace(sess, args, session_dir):
    if getattr(sess, "_cdp", None) is None or not getattr(sess, "_tracing_on", False):
        return {"stopped": False}  # cdt:未在录制时静默 no-op
    cdp = sess._cdp
    events = []
    try:
        cdp.call("Tracing.end", timeout=5)  # call 暴露半开连接,失败重连重发
    except Exception:
        try:
            cdp.reconnect()
            cdp.call("Tracing.end", timeout=5)
        except Exception:
            pass
    deadline = time.time() + 30
    done = False
    while time.time() < deadline and not done:
        cdp.pump()
        for m, p in cdp.drain_events("Tracing."):
            if m == "Tracing.dataCollected":
                events.extend(p.get("value", []))
            elif m == "Tracing.tracingComplete":
                done = True
    fp = args.get("filePath") or sess.artifact_path(session_dir, "trace", "json")
    if str(fp).endswith(".gz"):
        with gzip.open(fp, "wb") as f:
            f.write(json.dumps({"traceEvents": events}, ensure_ascii=False).encode("utf-8"))
    else:
        with open(fp, "w", encoding="utf-8") as f:
            json.dump({"traceEvents": events}, f, ensure_ascii=False)
    sess._tracing_on = False
    try:
        cdp.close()
        sess._cdp = None
    except Exception:
        pass
    return {"stopped": True, "path": fp, "events": len(events)}


def performance_analyze_insight(sess, args, session_dir):
    """自建最小指标集(真值来自已落盘 trace):长任务(>50ms)、布局抖动计数、
    LCP 候选、网络请求数。insightSetId/insightName 为 cdt 参数形状的兼容入口
    (接受但影响返回的自选 insight 子集);filePath 为本实现的 trace 来源。"""
    fp = args.get("filePath")
    if not fp or not os.path.exists(fp):
        raise ValueError("需要 performance_stop_trace 产出的 filePath")
    with open(fp, encoding="utf-8") as f:
        trace = json.load(f)
    ev = trace.get("traceEvents", [])
    layout_shifts, lcp_best = [], 0.0
    net_requests = 0
    # 长任务:>50ms 的顶层任务。一次主线程阻塞会产生嵌套事件链
    # (RunTask > FunctionCall/EvaluateScript > v8.run/ParseHTML,实测 Edge 152 无 RunTask
    # 时 EvaluateScript/v8.run/ParseHTML 直接顶层),按 dur 降序挑最外层、跳过区间被
    # 已选事件包含的嵌套项,避免同一次阻塞被数多次
    long_ev = [e for e in ev if e.get("dur", 0) / 1000.0 > 50]
    long_ev.sort(key=lambda e: -e.get("dur", 0))
    picked = []
    for e in long_ev:
        s, d = e.get("ts", 0), e.get("dur", 0)
        if any(s >= ps and s + d <= ps + pd for ps, pd in picked):
            continue
        picked.append((s, d))
    long_tasks = [round(pd / 1000.0, 1) for _, pd in picked]
    for e in ev:
        name = e.get("name", "")
        if name == "LayoutShift":
            layout_shifts.append(e)
        if name in ("largestContentfulPaint::Candidate", "LargestContentfulPaint::Candidate"):
            ts = e.get("ts", 0)
            lcp_best = max(lcp_best, ts)
        if name.startswith("Resource") or name == "ResourceSendRequest":
            net_requests += 1
    lcp_ms = None
    if lcp_best and ev:
        # 无 ts 的 metadata 事件(默认 0)会把基准拉到 0 → LCP 变成绝对时间戳;排除之
        ts_all = [e.get("ts", 0) for e in ev if e.get("ts", 0) > 0]
        if ts_all:
            lcp_ms = round((lcp_best - min(ts_all)) / 1000.0, 1)
    insights = {
        "long_tasks_over_50ms": len(long_tasks),
        "long_tasks_ms_top10": sorted(long_tasks, reverse=True)[:10],
        "layout_shifts": len(layout_shifts),
        "lcp_ms_candidate": lcp_ms,
        "network_requests": net_requests,
    }
    insight_name = args.get("insightName")
    if insight_name:
        # cdt 形状:按 insightName 取子项;自建指标集与 DevTools 19 项不同名,给映射提示
        return {"insightSetId": args.get("insightSetId", "NAVIGATION_0"),
                "insightName": insight_name,
                "available_insights": sorted(insights.keys()),
                "data": insights.get(insight_name.lower().replace("breakdown", "").replace("culprits", ""),
                                     None) or insights,
                "note": "自建最小指标集;DevTools 19 项 insight 全对齐为后续迭代(风险项已备案)"}
    return {**insights,
            "note": "自建最小指标集;DevTools 19 项 insight 全对齐为后续迭代(风险项已备案)"}
