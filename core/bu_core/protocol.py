# -*- coding: utf-8 -*-
"""stdio NDJSON 协议(DEC-008):stdin 收请求,stdout 出响应,stderr 出日志。

请求 {v,id,op,payload} → 响应 {v,id,ok,result|error}
op 集见 backend-design/api-contract.md §4。
"""
import json
import sys


def read_envelope():
    """从 stdin 读一行信封;EOF 返回 None。"""
    line = sys.stdin.readline()
    if not line:
        return None
    line = line.strip()
    if not line:
        return read_envelope.__wrapped__() if hasattr(read_envelope, "__wrapped__") else None
    try:
        return json.loads(line)
    except json.JSONDecodeError:
        return {"v": 1, "id": "bad", "op": "__bad__", "payload": {"raw": line[:200]}}


def write_envelope(obj):
    sys.stdout.write(json.dumps(obj, ensure_ascii=False) + "\n")
    sys.stdout.flush()


def result(req, payload):
    write_envelope({"v": 1, "id": req["id"], "ok": True, "result": payload})


def error(req, code, message, retryable=False):
    write_envelope({"v": 1, "id": req.get("id"), "ok": False,
                    "error": {"code": code, "message": message, "retryable": retryable}})


def elog(tag, msg):
    """stderr 日志(daemon 转写 daemon.log;不可写入 stdout 协议流)。"""
    sys.stderr.write(json.dumps({"tag": tag, "msg": str(msg)}, ensure_ascii=False) + "\n")
    sys.stderr.flush()
