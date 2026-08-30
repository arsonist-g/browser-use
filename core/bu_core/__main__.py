# -*- coding: utf-8 -*-
"""bu_core 入口:argparse → BrowserSession → stdio NDJSON 协议循环。

运行(npm 包内嵌源码,PYTHONPATH 由 daemon 注入):
  python -m bu_core --session-id=<id> --port=<p> --profile=<dir>
                    --session-dir=<dir> [--browser-exe=<exe>] [--headless]
"""
import argparse
import json
import os
import sys
import time
import traceback

from .protocol import read_envelope, write_envelope, result, error, elog
from .session import BrowserSession
from . import tools as T


def main():
    ap = argparse.ArgumentParser(prog="bu_core")
    ap.add_argument("--session-id", required=True)
    ap.add_argument("--port", type=int, required=True)
    ap.add_argument("--profile", required=True)
    ap.add_argument("--session-dir", required=True)
    ap.add_argument("--browser-exe", default=None)
    ap.add_argument("--headless", action="store_true")
    args = ap.parse_args()

    sess = BrowserSession(args.session_id, args.port, args.profile,
                          browser_exe=args.browser_exe, headless=args.headless)

    def log_tool(tool, args_redacted, ok, err=None, dur=0):
        try:
            line = {"ts": __import__("datetime").datetime.utcnow().isoformat() + "Z",
                    "seq": 0, "session_id": args.session_id, "tool": tool,
                    "args_redacted": args_redacted, "ok": ok,
                    "error_code": err, "duration_ms": dur}
            path = os.path.join(args.session_dir, "toollog.jsonl")
            with open(path, "a", encoding="utf-8") as f:
                f.write(json.dumps(line, ensure_ascii=False) + "\n")
        except Exception:
            pass

    def handle(op, payload):
        if op == "core.startup":
            return sess.start()
        if op == "session.ping":
            return {"ok": True}
        if op == "cookie.inject":
            cookies = payload.get("cookies", [])
            sess.browser.set.cookies(cookies)
            return {"injected": len(cookies)}
        if op == "tool.call":
            tool = payload["tool"]
            fn = getattr(T, tool, None)
            if fn is None:
                raise NotImplementedError(f"tool {tool} 尚未实现(M2/M3 占位,机制摸底后补齐)")
            sess.prune_edge_popups()
            t0 = time.monotonic()
            res = fn(sess, payload.get("args") or {}, args.session_dir)
            dur = int((time.monotonic() - t0) * 1000)
            log_tool(tool, _redact(payload.get("args") or {}), True, None, dur)
            return res
        if op == "core.stop":
            sess.stop()
            return {"stopped": True}
        raise KeyError(f"unknown op: {op}")

    while True:
        req = read_envelope()
        if req is None:
            break
        op = req.get("op", "")
        try:
            if op == "__bad__":
                raise ValueError("bad json line")
            result(req, handle(op, req.get("payload") or {}))
        except NotImplementedError as e:
            error(req, "NOT_IMPLEMENTED", str(e))
        except KeyError as e:
            error(req, "INVALID_ARG", str(e))
        except Exception as e:
            elog("core-error", traceback.format_exc(limit=6))
            error(req, "TOOL_ERROR", str(e), retryable=True)
            if op == "tool.call":
                log_tool((req.get("payload") or {}).get("tool", "?"), {}, False, "TOOL_ERROR")


def _redact(args):
    out = {}
    for k, v in (args or {}).items():
        if k in ("value", "text", "filePaths", "filePath"):
            s = str(v)
            out[k] = f"<{type(v).__name__}:{len(s)}>"
        else:
            out[k] = v
    return out


if __name__ == "__main__":
    main()
