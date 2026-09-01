# -*- coding: utf-8 -*-
"""测试夹具本地服务器:静态页 + cookie 端点(e2e 登录态/注入管道验证用)。

GET /            → index.html
GET /child.html  → 子页
GET /xo-host     → 跨域 iframe 宿主页(iframe 指向 127.0.0.2 同端口,site isolation → OOPIF)
GET /set-cookie  → Set-Cookie: bu_e2e=<ts>; Path=/(会话实例种 cookie 用)
GET /echo-cookie → 响应体 = 请求头里的 Cookie 原文(验证请求真实携带)
其余 /<file>     → test/fixture/ 下静态文件
用法: python server.py [port] [host](默认 18123 @ 127.0.0.1;跨域宿主页需在
      127.0.0.2 上再起一个同端口实例——回环整段本机可达,host 不同 = 跨站)
"""
import sys
from http.server import BaseHTTPRequestHandler, HTTPServer
from pathlib import Path
from datetime import datetime, timezone

FIXTURE_DIR = Path(__file__).parent
BIND_PORT = 18123
MIME = {".html": "text/html; charset=utf-8", ".js": "text/javascript", ".css": "text/css",
        ".webmanifest": "application/manifest+json", ".json": "application/json",
        ".png": "image/png"}


class Handler(BaseHTTPRequestHandler):
    def _send(self, code, body, headers=None):
        data = body.encode("utf-8") if isinstance(body, str) else body
        self.send_response(code)
        self.send_header("Content-Type", "text/plain; charset=utf-8")
        self.send_header("Content-Length", str(len(data)))
        for k, v in (headers or {}).items():
            self.send_header(k, v)
        self.end_headers()
        self.wfile.write(data)

    def do_GET(self):
        path = self.path.split("?")[0]
        if path == "/set-cookie":
            ts = datetime.now(timezone.utc).strftime("%Y%m%d%H%M%S")
            self._send(200, f"cookie set: bu_e2e={ts}",
                       {"Set-Cookie": f"bu_e2e={ts}; Path=/; SameSite=Lax"})
        elif path == "/echo-cookie":
            cookie = self.headers.get("Cookie", "(none)")
            self._send(200, f"echo-cookie: {cookie}", {"Content-Type": "text/html; charset=utf-8"})
        elif path == "/xo-host":
            # 动态注入端口(与第二个 127.0.0.2 实例同端口);不同 host = 跨站 → OOPIF
            html = f"""<!doctype html>
<html lang="zh-CN">
<head><meta charset="utf-8"><title>BU Fixture 跨域 iframe</title></head>
<body>
<h2>跨域 iframe 宿主页</h2>
<iframe id="xo" src="http://127.0.0.2:{BIND_PORT}/child.html" style="width:420px;height:220px;border:1px solid #888"></iframe>
</body>
</html>"""
            self._send(200, html, {"Content-Type": "text/html; charset=utf-8"})
        else:
            fp = FIXTURE_DIR / path.lstrip("/") if path != "/" else FIXTURE_DIR / "index.html"
            if fp.is_file() and FIXTURE_DIR in fp.resolve().parents or fp.parent == FIXTURE_DIR:
                ext = fp.suffix
                self._send(200, fp.read_bytes(),
                           {"Content-Type": MIME.get(ext, "application/octet-stream")})
            else:
                self._send(404, "fixture 404")

    def log_message(self, *a):  # 静默
        pass


if __name__ == "__main__":
    port = int(sys.argv[1]) if len(sys.argv) > 1 else 18123
    host = sys.argv[2] if len(sys.argv) > 2 else "127.0.0.1"
    BIND_PORT = port
    server = HTTPServer((host, port), Handler)
    print(f"fixture server on http://{host}:{port}", flush=True)
    server.serve_forever()
