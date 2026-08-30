# -*- coding: utf-8 -*-
"""测试夹具本地服务器:静态页 + cookie 端点(e2e 登录态/注入管道验证用)。

GET /            → index.html
GET /child.html  → 子页
GET /set-cookie  → Set-Cookie: bu_e2e=<ts>; Path=/(会话实例种 cookie 用)
GET /echo-cookie → 响应体 = 请求头里的 Cookie 原文(验证请求真实携带)
其余 /<file>     → test/fixture/ 下静态文件
用法: python server.py [port](默认 18123,仅 127.0.0.1)
"""
import sys
from http.server import BaseHTTPRequestHandler, HTTPServer
from pathlib import Path
from datetime import datetime, timezone

FIXTURE_DIR = Path(__file__).parent
MIME = {".html": "text/html; charset=utf-8", ".js": "text/javascript", ".css": "text/css"}


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
            self._send(200, f"echo-cookie: {cookie}")
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
    server = HTTPServer(("127.0.0.1", port), Handler)
    print(f"fixture server on http://127.0.0.1:{port}", flush=True)
    server.serve_forever()
