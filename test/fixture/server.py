# -*- coding: utf-8 -*-
"""测试夹具本地服务器:静态页 + cookie 端点(e2e 登录态/注入管道验证用)。

GET /            → index.html
GET /child.html  → 子页
GET /xo-offset   → 中部大偏移跨域 iframe 宿主页(iframe → 127.0.0.2 /xo-inner,防歪打正着)
GET /xo-inner    → 中部偏移用例子页(按钮带大内偏移,点击后 inner-clicked)
GET /xo-host     → 跨域 iframe 宿主页(iframe 指向 127.0.0.2 同端口,site isolation → OOPIF)
GET /xo-nested   → 嵌套 iframe 宿主页(iframe → 127.0.0.2 /xo-mid)
GET /xo-mid      → 中层跨站页(同 host 深页 iframe + 127.0.0.3 跨站深页 iframe)
GET /scroll-host → 同 host iframe 滚动页(iframe 内长文档,验证 frame 内滚动量)
GET /net-types   → 网络资源类型采样页(fetch/xhr/ping/preflight)
GET /five-hundred→ 500 响应
GET /slow?ms=N   → 延迟 N 毫秒后 200(导航超时用例)
GET /tick        → 心跳端点 200(chatty 页的请求落点)
GET /chatty      → 持续请求页(每 300ms fetch + console.log;收割/去重回归防线)
GET /huge-dom    → 3 万节点大 DOM 页(heapsnapshot 真实规模)
GET /long-task   → 同步阻塞 400ms 页(performance 长任务)
GET /busy-inputs → 输入元素页 + 300ms 心跳(持续请求下的输入类工具)
GET /download    → 2MB attachment 直链(下载场景网络抓取)
GET /big?kb=N    → N KB 文本响应(默认 64;大响应体内联/落盘)
GET /beforeunload→ 注册 beforeunload 的页(handleBeforeUnload 用例)
GET /spa         → SPA 路由页(pushState + 异步 fetch)
GET /beacon      → sendBeacon 落点
GET /set-cookie  → Set-Cookie: bu_e2e=<ts>; Path=/(会话实例种 cookie 用)
GET /echo-cookie → 响应体 = 请求头里的 Cookie 原文(验证请求真实携带)
其余 /<file>     → test/fixture/ 下静态文件
CORS:带 Origin 头的请求回 Access-Control-Allow-Origin:*,OPTIONS 预检放行
     (preflight 用例需要 127.0.0.1 → 127.0.0.2 跨源)
用法: python server.py [port] [host](默认 18123 @ 127.0.0.1;跨域宿主页需在
      127.0.0.2 / 127.0.0.3 上再起同端口实例——回环整段本机可达,host 不同 = 跨站)
"""
import sys
import time
from http.server import BaseHTTPRequestHandler, HTTPServer
from pathlib import Path
from datetime import datetime, timezone

FIXTURE_DIR = Path(__file__).parent
BIND_PORT = 18123
BIND_HOST = "127.0.0.1"
MIME = {".html": "text/html; charset=utf-8", ".js": "text/javascript", ".css": "text/css",
        ".webmanifest": "application/manifest+json", ".json": "application/json",
        ".png": "image/png"}


class Handler(BaseHTTPRequestHandler):
    def _send(self, code, body, headers=None, ctype="text/plain; charset=utf-8"):
        data = body.encode("utf-8") if isinstance(body, str) else body
        self.send_response(code)
        self.send_header("Content-Type", ctype)
        self.send_header("Content-Length", str(len(data)))
        for k, v in (headers or {}).items():
            self.send_header(k, v)
        self.end_headers()
        self.wfile.write(data)

    def _cors(self):
        # 跨源 preflight 用例:同端口不同 host 即跨源;放行任意来源与自定义头
        if self.headers.get("Origin"):
            return {"Access-Control-Allow-Origin": self.headers["Origin"],
                    "Access-Control-Allow-Headers": "*",
                    "Access-Control-Max-Age": "600"}
        return {}

    def do_OPTIONS(self):
        self._send(200, "", {"Access-Control-Allow-Methods": "GET, POST, OPTIONS", **self._cors()})

    def do_GET(self):
        path = self.path.split("?")[0]
        cors = self._cors()
        if path == "/set-cookie":
            ts = datetime.now(timezone.utc).strftime("%Y%m%d%H%M%S")
            self._send(200, f"cookie set: bu_e2e={ts}",
                       {"Set-Cookie": f"bu_e2e={ts}; Path=/; SameSite=Lax", **cors})
        elif path == "/echo-cookie":
            cookie = self.headers.get("Cookie", "(none)")
            self._send(200, f"echo-cookie: {cookie}",
                       {"Content-Type": "text/html; charset=utf-8", **cors})
        elif path == "/beacon":
            self._send(200, "beacon ok", cors)
        elif path == "/five-hundred":
            self._send(500, "fixture 500", cors)
        elif path == "/slow":
            ms = int(self.path.split("ms=")[-1] or 0)
            time.sleep(ms / 1000.0)
            self._send(200, f"slow done {ms}", cors)
        elif path == "/tick":
            # chatty 页的心跳端点(真实场景:统计/心跳类持续请求)
            self._send(200, "t", cors)
        elif path == "/chatty":
            # 持续请求页(每 300ms 一次 fetch + console 输出)——真实网站常态;
            # list_network_requests 收割无总预算时在此类页面挂死(回归防线);
            # console 流供收割 epoch 去重/增量语义验证
            self._send(200, """<!doctype html>
<html lang="zh-CN">
<head><meta charset="utf-8"><title>BU Fixture 持续请求页</title></head>
<body>
<h2>chatty</h2>
<script>
let n = 0;
setInterval(() => {
  n += 1;
  fetch('/tick?t=' + Date.now(), {cache:'no-store'});
  console.log('chatty-tick-' + n);
}, 300);
</script>
</body>
</html>""", {"Content-Type": "text/html; charset=utf-8", **cors})
        elif path == "/huge-dom":
            # 3 万节点大 DOM 页(heapsnapshot 真实规模用例:简单页的 nodes 断言
            # 无法暴露"大页快照超预算/截断"类问题)
            rows = "".join(f"<div class='r{i % 50}' data-i='{i}'>row-{i}</div>" for i in range(30000))
            self._send(200, f"""<!doctype html>
<html lang="zh-CN">
<head><meta charset="utf-8"><title>BU Fixture huge-dom</title></head>
<body>
<h2>huge-dom</h2>
<div id="rows">{rows}</div>
</body>
</html>""", {"Content-Type": "text/html; charset=utf-8", **cors})
        elif path == "/long-task":
            # 同步阻塞 400ms 页(performance trace 的长任务用例)
            self._send(200, """<!doctype html>
<html lang="zh-CN">
<head><meta charset="utf-8"><title>BU Fixture long-task</title></head>
<body>
<h2 id="lt-done">(计算中)</h2>
<script>
(() => {
  const t0 = performance.now();
  let x = 0;
  while (performance.now() - t0 < 400) { x += Math.sqrt(x + 1); }
  document.getElementById('lt-done').textContent = 'done-' + Math.round(x);
})();
</script>
</body>
</html>""", {"Content-Type": "text/html; charset=utf-8", **cors})
        elif path == "/busy-inputs":
            # 输入元素页 + 300ms 心跳(输入类工具在持续请求/持续 console 页的行为:
            # uid 消费、坐标换算不受网络活动干扰)
            self._send(200, """<!doctype html>
<html lang="zh-CN">
<head><meta charset="utf-8"><title>BU Fixture busy-inputs</title></head>
<body>
<input id="typer" placeholder="输入框" value="">
<div id="hover-zone" style="width:120px;height:60px;background:#ddd">hover 区</div>
<div id="drop-zone" style="width:120px;height:60px;background:#eee;margin-top:8px">drop 区</div>
<div id="drag-src" style="width:60px;height:30px;background:#ccc;margin-top:8px">拖我</div>
<div id="busy-log"></div>
<script>
let n = 0;
setInterval(() => { n += 1; fetch('/tick?t=' + Date.now(), {cache: 'no-store'}); }, 300);
document.getElementById('hover-zone').addEventListener('mouseenter', () => {
  document.getElementById('busy-log').textContent = 'hover-entered-' + n;
});
document.getElementById('drag-src').addEventListener('mouseup', () => {
  document.getElementById('busy-log').textContent = 'drag-release-' + n;
});
document.getElementById('drop-zone').addEventListener('mouseup', () => {
  document.getElementById('busy-log').textContent = 'drop-released-' + n;
});
</script>
</body>
</html>""", {"Content-Type": "text/html; charset=utf-8", **cors})
        elif path == "/download":
            # attachment 直链(2MB):Content-Disposition 触发下载管理器接管,
            # 页面导航以 ERR_ABORTED 收场——下载场景网络抓取的 fixture。
            # ?src=click 输出独立文件名,防直链场景(RW3)同名文件污染点击场景(RW10)
            # 的"新文件出现"断言(Chromium 对同名下载去重加 (1) 后缀)。
            fname = "bu-fixture-click.bin" if "src=click" in self.path else "bu-fixture.bin"
            buf = bytes(2 * 1024 * 1024)
            self._send(200, buf, {"Content-Type": "application/octet-stream",
                                  "Content-Disposition": f'attachment; filename="{fname}"', **cors})
        elif path == "/big":
            # 可调大小文本响应(?kb=N,默认 64):大响应体内联/落盘用例
            kb = int(self.path.split("kb=")[-1] or 64) if "kb=" in self.path else 64
            self._send(200, ("x" * 1024 + "\n") * kb, cors)
        elif path == "/beforeunload":
            # beforeunload 弹窗页:navigate 离开时触发,handleBeforeUnload 参数的用例;
            # 链接供 click 触发弹窗的用例(验证 beforeunload 自动 accept 放行)
            self._send(200, """<!doctype html>
<html lang="zh-CN">
<head><meta charset="utf-8"><title>BU Fixture beforeunload</title></head>
<body>
<h2>beforeunload 页</h2>
<a id="leave" href="/static">离开链接</a>
<script>window.addEventListener('beforeunload', (e) => { e.preventDefault(); e.returnValue = ''; });</script>
</body>
</html>""", {"Content-Type": "text/html; charset=utf-8", **cors})
        elif path == "/dl-page":
            # 下载触发页:点击按钮经 a[download] 触发 /download?src=click(独立文件名,
            # 与直链场景产物区分;点击触发下载的用例)
            self._send(200, """<!doctype html>
<html lang="zh-CN">
<head><meta charset="utf-8"><title>BU Fixture 下载触发页</title></head>
<body>
<a id="dl-link" href="/download?src=click" download>下载文件</a>
</body>
</html>""", {"Content-Type": "text/html; charset=utf-8", **cors})
        elif path == "/spa":
            # SPA 路由页:点击按钮 pushState + 异步 fetch(真实 SPA 行为)
            self._send(200, """<!doctype html>
<html lang="zh-CN">
<head><meta charset="utf-8"><title>BU Fixture SPA</title></head>
<body>
<h2>SPA 页</h2>
<button id="nav-btn" onclick="go()">SPA 跳转</button>
<div id="route">(未跳转)</div>
<script>
async function go() {
  history.pushState({}, '', '/spa?route=2');
  const r = await fetch('/tick?spa=' + Date.now(), {cache: 'no-store'});
  document.getElementById('route').textContent = 'route-2-loaded(' + r.status + ')';
}
</script>
</body>
</html>""", {"Content-Type": "text/html; charset=utf-8", **cors})
        elif path == "/xo-inner":
            # 中部偏移用例的子页:按钮带大内偏移(iframe 内 spacer),使"子 frame 内
            # 坐标小 + 宿主偏移大"同时成立——换算缺失时落点必在主视口左上角
            html = """<!doctype html>
<html lang="zh-CN">
<head><meta charset="utf-8"><title>BU Fixture 偏移子页</title></head>
<body style="margin:0">
<div style="height:130px;background:#f4f4f4">inner spacer 130px</div>
<button id="inner-btn" onclick="document.getElementById('inner-log').textContent='inner-clicked'">偏移子页按钮</button>
<div id="inner-log">(inner 未点击)</div>
</body>
</html>"""
            self._send(200, html, {"Content-Type": "text/html; charset=utf-8", **cors})
        elif path == "/xo-offset":
            # 中部大偏移跨域 iframe 宿主页:iframe 前有大块占位,使其远离视口原点——
            # 防"顶部 iframe 偏移小、坐标错误歪打正着"的退化;iframe 内按钮可点击
            html = f"""<!doctype html>
<html lang="zh-CN">
<head><meta charset="utf-8"><title>BU Fixture 中部偏移 iframe</title></head>
<body style="margin:0">
<div style="height:420px;background:#eee">spacer 420px — iframe 必须远离视口原点</div>
<iframe id="xo" src="http://127.0.0.2:{BIND_PORT}/xo-inner" style="width:460px;height:260px;border:2px solid #888;margin-left:37px"></iframe>
</body>
</html>"""
            self._send(200, html, {"Content-Type": "text/html; charset=utf-8", **cors})
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
            self._send(200, html, {"Content-Type": "text/html; charset=utf-8", **cors})
        elif path == "/xo-nested":
            # 嵌套 iframe 宿主页(127.0.0.1):中层 B = 127.0.0.2 /xo-mid(OOPIF)
            html = f"""<!doctype html>
<html lang="zh-CN">
<head><meta charset="utf-8"><title>BU Fixture 嵌套 iframe</title></head>
<body>
<h2>嵌套 iframe 宿主页</h2>
<iframe id="mid" src="http://127.0.0.2:{BIND_PORT}/xo-mid" style="width:560px;height:420px;border:1px solid #888"></iframe>
</body>
</html>"""
            self._send(200, html, {"Content-Type": "text/html; charset=utf-8", **cors})
        elif path == "/xo-mid":
            # 中层页(127.0.0.2,OOPIF):内嵌同 host 深页(B 的同进程子 frame)
            # 与 127.0.0.3 深页(B 的跨站 OOPIF 孙 frame)——两种嵌套形态
            html = f"""<!doctype html>
<html lang="zh-CN">
<head><meta charset="utf-8"><title>BU Fixture 中层页</title></head>
<body>
<h3>中层页(B)</h3>
<iframe id="deep-same" src="http://127.0.0.2:{BIND_PORT}/deep.html?k=same" style="width:250px;height:150px"></iframe>
<iframe id="deep-xo" src="http://127.0.0.3:{BIND_PORT}/deep.html?k=xo" style="width:250px;height:150px"></iframe>
</body>
</html>"""
            self._send(200, html, {"Content-Type": "text/html; charset=utf-8", **cors})
        elif path == "/scroll-host":
            # 同 host iframe(同进程子 frame)滚动页:iframe 内长文档,底部有按钮
            html = f"""<!doctype html>
<html lang="zh-CN">
<head><meta charset="utf-8"><title>BU Fixture iframe 滚动</title></head>
<body style="margin:0">
<h2>iframe 滚动宿主页</h2>
<iframe id="scroller" src="/deep-tall.html" style="width:420px;height:240px;border:1px solid #888"></iframe>
</body>
</html>"""
            self._send(200, html, {"Content-Type": "text/html; charset=utf-8", **cors})
        elif path == "/net-types":
            # 网络资源类型采样:fetch / xhr / sendBeacon(ping)/ 跨源自定义头(触发 preflight)
            html = f"""<!doctype html>
<html lang="zh-CN">
<head><meta charset="utf-8"><title>BU Fixture 网络类型</title></head>
<body>
<h2>网络资源类型采样页</h2>
<script>
  fetch('/echo-cookie', {{cache: 'no-store'}});                       // Fetch
  const x = new XMLHttpRequest(); x.open('GET', '/beacon'); x.send();  // XHR
  navigator.sendBeacon('/beacon');                                     // Ping
  fetch('http://127.0.0.2:{BIND_PORT}/echo-cookie',
        {{headers: {{'X-BU-Probe': 'preflight'}}, cache: 'no-store'}})  // Preflight + Fetch(跨源)
    .catch(() => {{}});
</script>
</body>
</html>"""
            self._send(200, html, {"Content-Type": "text/html; charset=utf-8", **cors})
        else:
            fp = FIXTURE_DIR / path.lstrip("/") if path != "/" else FIXTURE_DIR / "index.html"
            # 仅服务 fixture 目录内的真实文件;其余一律 404(此前条件对根下未知路径恒真,
            # read_bytes 抛 FileNotFoundError 会崩掉 handler → 浏览器侧 ERR_EMPTY_RESPONSE)
            if fp.is_file() and str(fp.resolve()).startswith(str(FIXTURE_DIR.resolve())):
                ext = fp.suffix
                self._send(200, fp.read_bytes(),
                           {"Content-Type": MIME.get(ext, "application/octet-stream"), **cors})
            else:
                self._send(404, "fixture 404", cors)

    def log_message(self, *a):  # 静默
        pass


if __name__ == "__main__":
    port = int(sys.argv[1]) if len(sys.argv) > 1 else 18123
    host = sys.argv[2] if len(sys.argv) > 2 else "127.0.0.1"
    BIND_PORT = port
    BIND_HOST = host
    server = HTTPServer((host, port), Handler)
    print(f"fixture server on http://{host}:{port}", flush=True)
    server.serve_forever()
