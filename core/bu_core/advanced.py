# -*- coding: utf-8 -*-
"""Screencast(Page.startScreencast 事件收帧)/ click_at / Third-party / WebMCP /
PWA / extensions / lighthouse_audit(外部 CLI attach)。

PWA 与 Extensions 域仅在 pipe 通道可达(ws 上实测 "wasn't found"/域失效):daemon 以
--remote-debugging-pipe 自托管浏览器进程并经 HTTP /pipe/cdp 转发;core 走该端点。
"""
import base64
import json
import os
import time
import urllib.error
import urllib.request

from .cdp_events import CdpEvents


# ---- pipe 通道(daemon 托管浏览器进程的 pipe CDP;PWA/extensions 专用) ----

def _pipe_call(sess, method, timeout=30, **params):
    """经 daemon 的 /pipe/cdp 端点调 pipe 通道 CDP(浏览器 fd3/4 直连)。"""
    from .cdp_events import pipe_call
    return pipe_call(sess.session_id, method, timeout=timeout, **params)


# ---- screencast(帧序列;ffmpeg 视频编码为可选后续) ----

def _drain_cast_frames(sess):
    """收割 screencast 帧落盘并回 ack;返回本次收割帧数。"""
    n = 0
    sess._cdp.pump()
    for m, p in sess._cdp.drain_events("Page.screencastFrame"):
        data = p.get("data", "")
        if data:
            sess._cast_frames += 1
            n += 1
            with open(os.path.join(sess._cast_dir, f"frame-{sess._cast_frames:06d}.png"), "wb") as f:
                f.write(base64.b64decode(data))
        if p.get("sessionId"):
            try:
                sess._cdp.call("Page.screencastFrameAck", sessionId=p["sessionId"])
            except Exception:
                pass
    return n


def _force_render(sess):
    """resize 一次强制合成帧(headless 静止页无渲染活动不发帧)。"""
    try:
        vp = sess.t.run_js("return [innerWidth, innerHeight]") or [1280, 720]
        w, h = int(vp[0]), int(vp[1])
        sess.t.run_cdp("Emulation.setDeviceMetricsOverride", width=w, height=h + 1,
                       deviceScaleFactor=0, mobile=False)
        time.sleep(0.15)
        sess.t.run_cdp("Emulation.setDeviceMetricsOverride", width=w, height=h,
                       deviceScaleFactor=0, mobile=False)
        time.sleep(0.15)
        sess.t.run_cdp("Emulation.clearDeviceMetricsOverride")
    except Exception:
        pass


def screencast_start(sess, args, session_dir):
    if getattr(sess, "_cdp", None) is None:
        from .cdp_events import ensure_session_cdp
        ensure_session_cdp(sess)
    sess._cast_dir = sess.artifact_path(session_dir, "screencast", "frames")
    os.makedirs(sess._cast_dir, exist_ok=True)
    sess._cast_frames = 0
    sess._casting = True
    sess._cdp.send("Page.startScreencast", format="png", everyNthFrame=1)
    _force_render(sess)
    deadline = time.time() + 2
    while time.time() < deadline and sess._cast_frames == 0:
        _drain_cast_frames(sess)
        time.sleep(0.05)
    return {"started": True, "frames_dir": sess._cast_dir, "frames": sess._cast_frames,
            "note": "落 PNG 帧序列;视频编码(ffmpeg webm/mp4)为可选后续"}


def screencast_stop(sess, args, session_dir):
    if not getattr(sess, "_casting", False):
        # cdt 语义:未开录制为 Error 行(不抛错,工具正常返回)
        return {"stopped": False, "error": "no active screencast recording to stop."}
    deadline = time.time() + 4
    forced = False
    while time.time() < deadline:
        if _drain_cast_frames(sess) > 0:
            break
        if not forced and time.time() > deadline - 2.5:
            _force_render(sess)  # 静止页兜底:再强制一次重绘
            forced = True
        time.sleep(0.1)
    try:
        sess._cdp.send("Page.stopScreencast")
    except Exception:
        pass
    _drain_cast_frames(sess)  # 收尾残帧
    sess._casting = False
    try:
        sess._cdp.close()
        sess._cdp = None
    except Exception:
        pass
    if sess._cast_frames == 0:
        raise RuntimeError("screencast 未捕获到任何帧(渲染管线无活动)")
    return {"stopped": True, "frames": sess._cast_frames, "frames_dir": sess._cast_dir}


def screencast_collect(sess, args, session_dir):
    """持续收帧(screencast 期间任意时刻调用收割,防内存堆积)。"""
    if not getattr(sess, "_casting", False):
        return {"frames": 0}
    return {"frames": sess._cast_frames + _drain_cast_frames(sess)}


# ---- click_at(坐标点击,拟人) ----

def click_at(sess, args, session_dir):
    from . import humanize
    x, y = float(args["x"]), float(args["y"])
    humanize.click_xy(sess.t, x, y, dbl=bool(args.get("dblClick")))
    humanize.op_delay()
    return {"clicked": True, "x": x, "y": y}


# ---- Third-party(页面侧 devtoolstooldiscovery 发现协议,对齐 cdt McpPage.getToolGroups) ----

# 发现事件派发 + respondWith 收集 + __dtmcp 工具组/executeTool 定义(照抄 cdt 协议)
_3P_DISCOVERY_EXPR = """(async () => {
  if (window.__dtmcp) window.__dtmcp.toolGroups = [];
  return await new Promise((resolve) => {
    const event = new CustomEvent('devtoolstooldiscovery');
    const groups = [];
    event.respondWith = (toolGroup) => {
      if (typeof toolGroup.name !== 'string' ||
          (toolGroup.description && typeof toolGroup.description !== 'string') ||
          !Array.isArray(toolGroup.tools)) {
        console.error('Invalid toolGroup:', toolGroup);
        return;
      }
      for (const tool of toolGroup.tools) {
        if (typeof tool.name !== 'string' || typeof tool.description !== 'string' ||
            typeof tool.inputSchema !== 'object' || typeof tool.execute !== 'function') {
          console.error('Invalid tool:', tool);
          return;
        }
      }
      if (!window.__dtmcp) window.__dtmcp = {};
      if (!window.__dtmcp.toolGroups) window.__dtmcp.toolGroups = [];
      window.__dtmcp.toolGroups.push(toolGroup);
      if (!window.__dtmcp.executeTool) {
        window.__dtmcp.executeTool = async (toolName, args) => {
          if (!window.__dtmcp?.toolGroups || window.__dtmcp.toolGroups.length === 0)
            throw new Error('No tools found on the page');
          for (const group of window.__dtmcp.toolGroups) {
            const tool = group.tools?.find(t => t.name === toolName);
            if (tool) return await tool.execute(args);
          }
          throw new Error('Tool ' + toolName + ' not found');
        };
      }
      groups.push(toolGroup);
    };
    window.dispatchEvent(event);
    if (groups.length > 0) resolve(groups);
    else setTimeout(() => resolve(groups.slice()), 0);
  });
})()"""

# 执行 + 结果后处理:DOM 元素→stash 占位、循环引用/非 plain object/函数→占位串(cdt 同)
_3P_EXECUTE_TMPL = """(async () => {{
  if (!window.__dtmcp?.executeTool) throw new Error('No tools found on the page');
  const toolResult = await window.__dtmcp.executeTool({name}, {args});
  const stashDOMElement = (el) => {{
    if (!window.__dtmcp) window.__dtmcp = {{}};
    if (window.__dtmcp.stashedElements === undefined) window.__dtmcp.stashedElements = [];
    window.__dtmcp.stashedElements.push(el);
    return {{ stashedId: `stashed-${{window.__dtmcp.stashedElements.length - 1}}` }};
  }};
  const ancestors = [];
  const processToolResult = (data, parentEl) => {{
    if (data instanceof Element) return stashDOMElement(data);
    if (Array.isArray(data)) return data.map((item) => processToolResult(item, parentEl));
    if (data !== null && typeof data === 'object') {{
      while (ancestors.length > 0 && ancestors[ancestors.length - 1] !== parentEl) ancestors.pop();
      if (ancestors.includes(data)) return '<Circular reference>';
      ancestors.push(data);
      if (Object.getPrototypeOf(data) !== Object.prototype) return `<${{data.constructor.name}} instance>`;
      const out = {{}};
      for (const [k, v] of Object.entries(data)) out[k] = processToolResult(v, data);
      return out;
    }}
    if (typeof data === 'function') return '<Function object>';
    return data;
  }};
  return JSON.stringify({{ result: processToolResult(toolResult),
                          stashed: window.__dtmcp?.stashedElements?.length ?? 0 }});
}})()"""


def _3p_discover(sess):
    """cdt 发现协议:① DOMDebugger.getEventListeners 探测 window 上
    devtoolstooldiscovery 监听;② 有则派发事件收集工具组。"""
    t = sess.t
    w = t.run_cdp("Runtime.evaluate", expression="window", returnByValue=False)
    oid = (w.get("result") or {}).get("objectId")
    if not oid:
        return []
    try:
        listeners = t.run_cdp("DOMDebugger.getEventListeners", objectId=oid).get("listeners", [])
    except Exception:
        t.run_cdp("DOM.enable")  # 部分版本需先 enable DOM 域
        listeners = t.run_cdp("DOMDebugger.getEventListeners", objectId=oid).get("listeners", [])
    if not any(l.get("type") == "devtoolstooldiscovery" for l in listeners):
        return []
    r = t.run_cdp("Runtime.evaluate", expression=_3P_DISCOVERY_EXPR,
                  returnByValue=True, awaitPromise=True)
    detail = r.get("exceptionDetails")
    if detail:
        raise RuntimeError(f"3p 工具发现失败: {detail.get('text')}")
    return r.get("result", {}).get("value") or []


def list_3p_developer_tools(sess, args, session_dir):
    groups = _3p_discover(sess)
    tools = []
    for g in groups:
        for tool in g.get("tools", []):
            tools.append({"group": g.get("name"), "name": tool.get("name"),
                          "description": tool.get("description"),
                          "inputSchema": tool.get("inputSchema")})
    return {"tools": tools,
            "groups": [{"name": g.get("name"), "description": g.get("description"),
                        "tools": len(g.get("tools", []))} for g in groups]}


def execute_3p_developer_tool(sess, args, session_dir):
    tool_name = str(args["toolName"])
    params = args.get("params")
    if isinstance(params, str) and params.strip():
        try:
            params = json.loads(params)
        except json.JSONDecodeError as e:
            raise ValueError(f"Failed to parse params as JSON: {e}") from None
    if params is None or params == "":
        params = {}
    if not isinstance(params, dict):
        raise ValueError("Parsed params is not an object")
    if any(isinstance(v, dict) and set(v.keys()) == {"uid"} for v in params.values()):
        raise NotImplementedError("params 中的 {uid} 元素引用暂不支持(已知降级,见审查报告)")
    _3p_discover(sess)  # 执行前刷新发现(cdt:getToolGroups → 找 tool)
    expr = _3P_EXECUTE_TMPL.format(name=json.dumps(tool_name), args=json.dumps(params))
    r = sess.t.run_cdp("Runtime.evaluate", expression=expr, returnByValue=True, awaitPromise=True)
    detail = r.get("exceptionDetails")
    if detail:
        text = (detail.get("exception", {}) or {}).get("description") or detail.get("text", "execute failed")
        raise RuntimeError(f"3p 工具执行失败: {text.strip()}")
    out = json.loads(r.get("result", {}).get("value") or "{}")
    return {"result": out.get("result"), "stashed": out.get("stashed", 0)}


# ---- WebMCP(需 --enable-features=WebMCP;默认不开,按需显式开,CONSTRAINT-001 权衡) ----

def _webmcp_cdp(sess):
    if getattr(sess, "_cdp", None) is None:
        from .cdp_events import ensure_session_cdp
        ensure_session_cdp(sess)
    return sess._cdp


def list_webmcp_tools(sess, args, session_dir):
    if not getattr(sess, "webmcp_enabled", False):
        raise RuntimeError(
            "WebMCP 需要 --enable-features=WebMCP 启动 flag(Edge 150+ 默认关闭)。"
            "该 flag 属运行时特征变更,默认不启用(CONSTRAINT-001 权衡);"
            "如需使用:browser-use start --extra-flags '[\"--enable-features=WebMCP\"]' 以带 flag 会话运行。")
    cdp = _webmcp_cdp(sess)
    cdp.call("WebMCP.enable")  # enable 会对已注册工具补发全量 toolsAdded
    tools = getattr(sess, "_webmcp_tools", None)
    if tools is None:
        tools = sess._webmcp_tools = {}
    deadline = time.time() + 3
    while time.time() < deadline and not tools:
        cdp.pump()
        for m, p in cdp.drain_events("WebMCP.toolsAdded"):
            for t in p.get("tools", []):
                tools[t.get("name")] = t
        time.sleep(0.05)
    for m, p in cdp.drain_events("WebMCP.toolsRemoved"):
        for t in p.get("tools", []):
            tools.pop(t.get("name"), None)
    return {"tools": [{"name": t.get("name"), "description": t.get("description"),
                       "inputSchema": t.get("inputSchema")} for t in tools.values()],
            "flag_enabled": True}


def execute_webmcp_tool(sess, args, session_dir):
    name = str(args["toolName"])
    tools = getattr(sess, "_webmcp_tools", None)
    if tools is None or name not in tools:
        list_webmcp_tools(sess, {}, session_dir)
        tools = getattr(sess, "_webmcp_tools", {})
    t = tools.get(name)
    if not t:
        raise KeyError(f"WebMCP 工具未找到: {name}(list_webmcp_tools 查看可用工具)")
    inp = args.get("input")
    input_obj = json.loads(inp) if isinstance(inp, str) else (inp or {})
    cdp = _webmcp_cdp(sess)
    r = cdp.call("WebMCP.invokeTool", frameId=t.get("frameId"), toolName=name, input=input_obj)
    inv = r.get("invocationId")
    deadline = time.time() + 15
    while time.time() < deadline:
        cdp.pump()
        for m, p in cdp.drain_events("WebMCP.toolResponded"):
            if p.get("invocationId") == inv:
                return {"status": p.get("status"), "output": p.get("output"),
                        "errorText": p.get("errorText")}
        time.sleep(0.05)
    try:
        cdp.call("WebMCP.cancelInvocation", invocationId=inv)
    except Exception:
        pass
    raise TimeoutError(f"WebMCP 工具 {name} 响应超时")


# ---- PWA 四件套(pipe 通道;ws 上 PWA 域不可达已实证) ----

def get_os_app_state(sess, args, session_dir):
    mid = str(args["manifestId"])
    r = _pipe_call(sess, "PWA.getOsAppState", manifestId=mid)
    return {"manifest_id": mid, "badge_count": r.get("badgeCount", 0),
            "file_handlers": r.get("fileHandlers", [])}


def install_pwa(sess, args, session_dir):
    mid = str(args["manifestId"])
    _pipe_call(sess, "PWA.install", manifestId=mid,
               installUrlOrBundleUrl=str(args["installUrlOrBundleUrl"]), timeout=60)
    if args.get("displayMode"):
        _pipe_call(sess, "PWA.changeAppUserSettings", manifestId=mid,
                   displayMode=args["displayMode"])
    return {"installed": True, "manifest_id": mid}


def launch_pwa(sess, args, session_dir):
    mid = str(args["manifestId"])
    before = {getattr(tb, "tab_id", None) for tb in sess.browser.get_tabs()}
    r = _pipe_call(sess, "PWA.launch", manifestId=mid, url=args.get("url"))
    # cdt:等待被启动的应用页出现并返回其 url(fixed sleep 换成有界轮询)
    url = None
    deadline = time.time() + 8
    while time.time() < deadline:
        for tb in sess.browser.get_tabs():
            if getattr(tb, "tab_id", None) not in before:
                try:
                    tb.wait.doc_loaded(5)
                except Exception:
                    pass
                url = tb.url
                break
        if url:
            break
        time.sleep(0.3)
    return {"launched": True, "manifest_id": mid, "target_id": r.get("targetId"), "url": url}


def uninstall_pwa(sess, args, session_dir):
    mid = str(args["manifestId"])
    _pipe_call(sess, "PWA.uninstall", manifestId=mid)
    return {"uninstalled": True, "manifest_id": mid}


# ---- extensions 五件套(pipe 通道 Extensions 域) ----

def list_extensions(sess, args, session_dir):
    r = _pipe_call(sess, "Extensions.getExtensions")
    return {"extensions": r.get("extensions", [])}


def install_extension(sess, args, session_dir):
    p = os.path.abspath(str(args["path"]))
    r = _pipe_call(sess, "Extensions.loadUnpacked", path=p, timeout=60)
    return {"id": r.get("id"), "path": p}


def uninstall_extension(sess, args, session_dir):
    eid = str(args["id"])
    _pipe_call(sess, "Extensions.uninstall", id=eid)
    return {"uninstalled": True, "id": eid}


def reload_extension(sess, args, session_dir):
    eid = str(args["id"])
    exts = _pipe_call(sess, "Extensions.getExtensions").get("extensions", [])
    ext = next((e for e in exts if e.get("id") == eid), None)
    if not ext:
        raise KeyError(f"Extension with ID {eid} not found.")  # 文案对齐 cdt
    path = ext.get("path")
    if not path:
        raise ValueError(f"Extension with ID {eid} has no local path (not unpacked; cannot reload).")
    _pipe_call(sess, "Extensions.loadUnpacked", path=path, timeout=60)
    time.sleep(0.8)  # 旧 service worker 摘除/新 SW 注册的窗口期
    r = _pipe_call(sess, "Target.getTargets")
    sw = {t.get("targetId") for t in r.get("targetInfos", [])
          if t.get("type") == "service_worker" and eid in (t.get("url") or "")}
    return {"reloaded": True, "id": eid, "service_workers": sorted(sw)}


def trigger_extension_action(sess, args, session_dir):
    eid = str(args["id"])
    target_id = sess.t._target_id
    _pipe_call(sess, "Extensions.triggerAction", id=eid, targetId=target_id)
    return {"triggered": True, "id": eid}


# ---- lighthouse_audit(Lighthouse CLI attach 已运行调试端口实例,源码级证实) ----

def lighthouse_audit(sess, args, session_dir):
    """参数面对齐 cdt(mode/device/outputDirPath + 私有扩展 onlyCategories)。
    类别默认含 agentic-browsing(cdt 同)。mode=snapshot 需编程式 API,
    CLI attach 模式不支持(明确报错,已知限制)。"""
    import subprocess
    mode = args.get("mode") or "navigation"
    device = args.get("device") or "desktop"
    if mode != "navigation":
        raise ValueError("mode=snapshot 需要 lighthouse 编程式 API,CLI attach 模式仅支持 navigation")
    if device not in ("desktop", "mobile"):
        raise ValueError(f"device 必须是 desktop/mobile,收到 {device}")
    port = sess.port
    url = sess.t.run_js("return location.href")
    if not url or url.startswith(("edge://", "chrome://", "about:", "file://")):
        raise ValueError("lighthouse 需要一个 http(s) 页面(先 navigate)")
    only = args.get("onlyCategories") or "accessibility,seo,best-practices,agentic-browsing"
    out_dir = args.get("outputDirPath") or sess.artifact_path(session_dir, "lighthouse", "dir")
    os.makedirs(out_dir, exist_ok=True)
    out_prefix = os.path.join(out_dir, "report").replace("\\", "/")
    cmd = ["npx", "--yes", "lighthouse", url,
           "--port", str(port),
           "--output", "json", "--output", "html",
           "--output-path", out_prefix,
           "--form-factor", device,
           "--only-categories", only]
    # screenEmulation 对齐 cdt(desktop 1350x940@1 / mobile 412x823@1.75);
    # CLI 的 form-factor 必须与 screenEmulation.mobile 一致,否则 lighthouse 报错
    if device == "desktop":
        cmd += ["--screenEmulation.mobile=false", "--screenEmulation.width=1350",
                "--screenEmulation.height=940", "--screenEmulation.deviceScaleFactor=1"]
    else:
        cmd += ["--screenEmulation.mobile=true", "--screenEmulation.width=412",
                "--screenEmulation.height=823", "--screenEmulation.deviceScaleFactor=1.75"]
    cmd += ["--max-wait-for-load", "30000", "--quiet"]
    proc = subprocess.run(cmd, capture_output=True, text=True, timeout=300,
                          shell=(os.name == "nt"))
    json_path = f"{out_prefix}.report.json"
    if proc.returncode != 0 or not os.path.exists(json_path):
        raise RuntimeError(f"lighthouse 执行失败: {(proc.stderr or proc.stdout)[-300:]}")
    with open(json_path, encoding="utf-8") as f:
        report = json.load(f)
    scores = [{"id": c.get("id"), "title": c.get("title"), "score": c.get("score")}
              for c in report.get("categories", {}).values()]
    audits = [a.get("score") for a in report.get("audits", {}).values() if a.get("score") is not None]
    html_path = f"{out_prefix}.report.html"
    return {
        "summary": {"mode": mode, "device": device, "url": report.get("mainDocumentUrl", url),
                    "scores": scores,
                    "audits": {"passed": sum(1 for s in audits if s == 1),
                               "failed": sum(1 for s in audits if s < 1)},
                    "timing_total_ms": report.get("timing", {}).get("total")},
        "reports": [p for p in (json_path, html_path) if os.path.exists(p)],
    }
