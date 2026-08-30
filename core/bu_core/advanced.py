# -*- coding: utf-8 -*-
"""Screencast(Page.startScreencast 事件收帧)/ click_at / Third-party / WebMCP /
PWA / extensions / lighthouse_audit(外部 CLI attach)。
"""
import base64
import json
import os
import time

from .cdp_events import CdpEvents


# ---- screencast(帧序列 M1;ffmpeg 视频编码为可选后续) ----

def screencast_start(sess, args, session_dir):
    if getattr(sess, "_cdp", None) is None:
        sess._cdp = CdpEvents(sess.port).connect()
    sess._cast_dir = sess.artifact_path(session_dir, "screencast", "frames")
    os.makedirs(sess._cast_dir, exist_ok=True)
    sess._cast_frames = 0
    sess._casting = True
    sess._cdp.send("Page.startScreencast", format="png", everyNthFrame=1)
    return {"started": True, "frames_dir": sess._cast_dir,
            "note": "M1 落帧序列(PNG);视频编码(ffmpeg webm/mp4)为可选后续"}


def screencast_stop(sess, args, session_dir):
    if not getattr(sess, "_casting", False):
        raise RuntimeError("screencast 未开启")
    deadline = time.time() + 5
    while time.time() < deadline:
        sess._cdp.pump()
        for m, p in sess._cdp.drain_events("Page.screencastFrame"):
            data = p.get("data", "")
            if data:
                sess._cast_frames += 1
                with open(os.path.join(sess._cast_dir, f"frame-{sess._cast_frames:06d}.png"), "wb") as f:
                    f.write(base64.b64decode(data))
            if p.get("sessionId"):
                try:
                    sess._cdp.call("Page.screencastFrameAck", sessionId=p["sessionId"])
                except Exception:
                    pass
        sess._cdp.send("Page.stopScreencast")
        sess._casting = False
        try:
            sess._cdp.close()
            sess._cdp = None
        except Exception:
            pass
        return {"frames": sess._cast_frames, "frames_dir": sess._cast_dir}
    return {"frames": sess._cast_frames, "frames_dir": sess._cast_dir}


def screencast_collect(sess, args, session_dir):
    """持续收帧(screencast 期间任意时刻调用收割,防内存堆积)。"""
    if not getattr(sess, "_casting", False):
        return {"frames": 0}
    deadline = time.time() + 0.5
    while time.time() < deadline:
        sess._cdp.pump()
        for m, p in sess._cdp.drain_events("Page.screencastFrame"):
            data = p.get("data", "")
            if data:
                sess._cast_frames += 1
                with open(os.path.join(sess._cast_dir, f"frame-{sess._cast_frames:06d}.png"), "wb") as f:
                    f.write(base64.b64decode(data))
            if p.get("sessionId"):
                try:
                    sess._cdp.call("Page.screencastFrameAck", sessionId=p["sessionId"])
                except Exception:
                    pass
    return {"frames": sess._cast_frames}


# ---- click_at(坐标点击,拟人) ----

def click_at(sess, args, session_dir):
    from . import humanize
    x, y = float(args["x"]), float(args["y"])
    humanize.click_xy(sess.t, x, y, dbl=bool(args.get("dblClick")))
    humanize.op_delay()
    return {"clicked": True, "x": x, "y": y}


# ---- Third-party(页面侧 devtoolstooldiscovery 协议 + window.__dtmcp) ----

def list_3p_developer_tools(sess, args, session_dir):
    """探测页面暴露的第三方 DevTools 工具(window.__dtmcp)。多数页面为空集。"""
    try:
        r = sess.t.run_js(
            "return (function(){ if (typeof window.__dtmcp === 'undefined') return []; "
            "try { return Object.keys(window.__dtmcp.tools || {}); } catch(e) { return []; } })()")
        return {"tools": [{"name": n} for n in (r or [])], "page_supports": bool(r)}
    except Exception as e:
        return {"tools": [], "page_supports": False, "error": str(e)}


def execute_3p_developer_tool(sess, args, session_dir):
    """执行第三方工具:CustomEvent 派发 + respondWith 回执(M1 尽力语义)。"""
    tool = args["tool"]
    params = args.get("params") or {}
    payload = json.dumps({"tool": tool, "params": params}, ensure_ascii=False)
    r = sess.t.run_js(
        """(payload) => {
             if (typeof window.__dtmcp === 'undefined') return 'unsupported';
             try {
               const req = { tool: JSON.parse(payload).tool, params: JSON.parse(payload).params,
                             respondWith: (r) => { window.__bu_3p_last = r; } };
               window.dispatchEvent(new CustomEvent('devtoolstoolboxexecute', { detail: req }));
               return 'dispatched';
             } catch (e) { return 'error: ' + e.message; }
           }""", payload)
    time.sleep(0.5)
    resp = sess.t.run_js("return window.__bu_3p_last ? JSON.stringify(window.__bu_3p_last) : null")
    return {"dispatch": r, "response": resp}


# ---- WebMCP(需 --enable-features=WebMCP;默认不开 = 明确报错,CONSTRAINT 权衡) ----

def _webmcp_cdp(sess):
    if not getattr(sess, "_webmcp_flag", False):
        raise RuntimeError(
            "WebMCP 需要 --enable-features=WebMCP 启动 flag(Edge 150+ 默认关闭)。"
            "该 flag 属运行时特征变更,默认不启用(CONSTRAINT-001 权衡);"
            "如需使用:config 确认后以带 flag 会话运行。")
    if getattr(sess, "_cdp", None) is None:
        sess._cdp = CdpEvents(sess.port).connect()
    return sess._cdp


def list_webmcp_tools(sess, args, session_dir):
    cdp = _webmcp_cdp(sess)
    cdp.call("WebMCP.enable")
    cdp.send("WebMCP.getPageTools") if False else None
    r = cdp.call("WebMCP.getPageTools")
    return {"tools": r.get("tools", [])}


def execute_webmcp_tool(sess, args, session_dir):
    cdp = _webmcp_cdp(sess)
    cdp.call("WebMCP.enable")
    r = cdp.call("WebMCP.invokeTool", origin=args.get("origin", ""),
                 toolName=args["tool"], params=args.get("params") or {})
    return r


# ---- PWA 四件套(pipe 通道依赖;ws 上 PWA 域不可达已实证) ----

def _pipe_required():
    raise RuntimeError(
        "PWA 域仅在 pipe 通道(自托管浏览器进程)可达——ws 上实测 'wasn't found'。"
        "pipe 变体(Windows stdio[3]/[4])为 M3 实现(architecture.md Delta);当前会话为 port 通道。")


def get_os_app_state(sess, args, session_dir):
    _pipe_required()


def install_pwa(sess, args, session_dir):
    _pipe_required()


def launch_pwa(sess, args, session_dir):
    _pipe_required()


def uninstall_pwa(sess, args, session_dir):
    _pipe_required()


# ---- extensions 五件套(CDP Extensions 域;ws 尝试,pipe 依赖同 PWA 组时明确报错) ----

def list_extensions(sess, args, session_dir):
    try:
        if getattr(sess, "_cdp", None) is None:
            sess._cdp = CdpEvents(sess.port).connect()
        cdp = sess._cdp
        try:
            r = cdp.call("Extensions.getExtensions", timeout=5)
            return {"extensions": r.get("extensions", [])}
        except Exception as e:
            return {"extensions": [], "note": f"Extensions 域不可达(可能需要 pipe 通道): {e}"}
    except Exception as e:
        return {"extensions": [], "error": str(e)}


def install_extension(sess, args, session_dir):
    raise RuntimeError(
        "install_extension 需要 CDP Extensions.loadUnpacked(pipe 通道)。"
        "替代路径:把扩展目录加入白名单(config whitelist_extensions)+ 会话启动时自动装载(M2)。")


def uninstall_extension(sess, args, session_dir):
    raise RuntimeError("同 install_extension:需要 pipe 通道的 Extensions 域。")


def reload_extension(sess, args, session_dir):
    raise RuntimeError("同 install_extension:需要 pipe 通道的 Extensions 域。")


def trigger_extension_action(sess, args, session_dir):
    raise RuntimeError("同 install_extension:需要 pipe 通道的 Extensions 域。")


# ---- lighthouse_audit(Lighthouse CLI attach 已运行调试端口实例,源码级证实) ----

def lighthouse_audit(sess, args, session_dir):
    """spawn lighthouse CLI attach 本会话调试端口(npx --yes 自动拉取,实测通过)。"""
    import subprocess
    port = sess.port
    url = sess.t.run_js("return location.href")
    if not url or url.startswith(("edge://", "chrome://", "about:", "file://")):
        raise ValueError("lighthouse 需要一个 http(s) 页面(先 navigate)")
    only = args.get("onlyCategories") or "accessibility,seo,best-practices"
    out_path = sess.artifact_path(session_dir, "lighthouse", "json").replace("\\", "/")
    cmd = ["npx", "--yes", "lighthouse", url,
           "--port", str(port),
           "--output", "json",
           "--only-categories", only,
           "--output-path", out_path]
    proc = subprocess.run(cmd, capture_output=True, text=True, timeout=300,
                          shell=(os.name == "nt"))
    if proc.returncode != 0 or not os.path.exists(out_path):
        raise RuntimeError(f"lighthouse 执行失败: {(proc.stderr or proc.stdout)[-300:]}")
    with open(out_path, encoding="utf-8") as f:
        report = json.load(f)
    scores = {k: v.get("score") for k, v in report.get("categories", {}).items()}
    return {"scores": scores, "path": out_path, "url": url}
