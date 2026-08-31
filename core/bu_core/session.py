# -*- coding: utf-8 -*-
"""会话内 DP 生命周期与浏览器实例(DEC-001:默认浏览器 exe、有头、默认指纹)。
红线(CONSTRAINT-001):不启用 Runtime.enable;不做 UA/平台/语言覆盖。
"""
import os
from DrissionPage import Chromium, ChromiumOptions

# console.* 捕获 hook:Console 域在新版 Edge/Chrome 不再派发事件(实测 enable 成功但 0 事件),
# 而 Runtime.enable 属红线(CONSTRAINT-001)。改为 addScriptToEvaluateOnNewDocument 注入透传
# hook(仅包 console 五法,原方法照常执行,缓冲留在页内,每文档一个随机 epoch 供去重)。
_CONSOLE_HOOK_JS = """(() => {
  if (window.__buConsole) return;
  const buf = [];
  const epoch = Math.random().toString(36).slice(2, 10);
  const rec = (ty, orig) => function (...args) {
    try {
      if (buf.length < 500) {
        const text = args.map(a => {
          if (typeof a === 'string') return a;
          try { return JSON.stringify(a); } catch (e) { return String(a); }
        }).join(' ');
        // 调用点栈(includeStackTraces 用):栈首行为 Error 标题、次行为 rec 自身,砍掉
        const stack = String(new Error().stack || '').split('\\n').slice(2).join('\\n').slice(0, 2000);
        buf.push({ epoch, seq: buf.length, type: ty, text: text.slice(0, 2000), stack });
      }
    } catch (e) {}
    return orig.apply(console, args);
  };
  for (const ty of ['log', 'info', 'warn', 'error', 'debug']) {
    const orig = console[ty];
    if (typeof orig === 'function') console[ty] = rec(ty, orig);
  }
  try {
    Object.defineProperty(window, '__buConsole', { get: () => buf });
    Object.defineProperty(window, '__buConsoleEpoch', { get: () => epoch });
  } catch (e) {}
})();"""


def install_console_hook(tab):
    """对新 tab 注入 console hook(每个 Page target 独立,需逐 tab 装)。"""
    try:
        tab.run_cdp("Page.addScriptToEvaluateOnNewDocument", source=_CONSOLE_HOOK_JS)
    except Exception:
        pass


class BrowserSession:
    def __init__(self, session_id, port, profile, browser_exe=None, headless=False,
                 attach=False, extra_flags=None):
        self.session_id = session_id
        self.port = port
        self.profile = profile
        self.browser_exe = browser_exe
        self.headless = headless
        # attach:浏览器已由 daemon 以 pipe+port 双通道启动,DP 只接管(不启动)
        self.attach = attach
        self.extra_flags = extra_flags or []
        # WebMCP 需要 flag(运行时特征变更,默认不开 = CONSTRAINT-001 权衡)
        self.webmcp_enabled = "--enable-features=WebMCP" in self.extra_flags
        self.browser = None
        self.tab = None
        # 页内工具共用状态
        self.listen_started = False
        self.console_started = False
        self.uid_map = {}   # uid -> a11y node(backendNodeId 等)
        self.snapshot_seq = 0

    def start(self):
        co = ChromiumOptions(read_file=False)
        if self.browser_exe:
            co.set_browser_path(self.browser_exe)
        co.set_local_port(self.port)
        co.set_user_data_path(self.profile)
        if self.attach:
            # 接管 daemon 启动的实例:启动参数不生效,但 headless 选项必须与实际一致,
            # 否则 DP 判定不匹配会杀掉现有实例重启(丢失 pipe 通道)
            if self.headless:
                co.headless()
        else:
            # 扩展白名单(默认空 = 全禁;白名单机制 Should,实现后此处按白名单传 --disable-extensions-except)
            whitelist = self._whitelist_paths()
            if whitelist:
                co.set_argument("--disable-extensions-except", "|".join(whitelist))
            else:
                co.set_argument("--disable-extensions")
            # Edge 首启/同步/更新提示类弹窗与页面全面禁用(不影响指纹语义)
            co.set_argument("--disable-features",
                            "msFirstRunExperience,msSeamlessWebToBrowserSignIn,msImplicitSignin,"
                            "EdgeWelcomePage,EdgeUpdateToast,msEdgeUpdateToast")
            if self.headless:
                co.headless()
        self.browser = Chromium(co)
        self.tab = self.browser.latest_tab
        self.prune_edge_popups()
        self.tab = self.browser.latest_tab
        # 会话级监听尽早开启(listen/console 只捕开启后的事件)
        try:
            self.tab.listen.start()
            self.listen_started = True
        except Exception:
            pass
        try:
            self.tab.console.start()
            self.console_started = True
        except Exception:
            pass
        # 弹窗不自动处理(对齐 cdt:dialog 挂起阻塞页面 JS,由 handle_dialog 工具
        # 显式 accept/dismiss;自动 accept 会让 handle_dialog 永远无弹窗可处理)
        # console 捕获 hook(每 Page target 注入一次,导航后自动重挂)
        install_console_hook(self.tab)
        bv = ""
        try:
            bv = self.tab.run_cdp("Browser.getVersion").get("product", "")
        except Exception:
            bv = "unknown"
        return {
            "ready": True,
            "dp_version": __import__("DrissionPage").__version__,
            "browser_version": bv,
        }

    @property
    def t(self):
        # 固定主任务 tab:Edge 会中途弹 sync 确认页抢占 latest_tab,不能跟随。
        # 注意:DP 的 get_tabs() 每次返回全新 tab 对象(无 __eq__,身份比较永不匹配),
        # 若据此换对象,tab 级状态(listen 监听等)会每次访问都丢——必须按 tab_id 比对复用。
        tabs = self.browser.get_tabs()
        if not tabs:
            return self.tab
        cur_id = getattr(self.tab, "tab_id", None)
        if cur_id is not None and any(tb.tab_id == cur_id for tb in tabs):
            return self.tab
        self.tab = tabs[0]
        return self.tab

    def _whitelist_paths(self):
        """白名单扩展目录(Should 机制;首版无实现,恒空 = 全禁扩展)。"""
        return []

    def prune_edge_popups(self):
        """关掉一切浏览器内建页(welcome/同步确认/更新提示等)——它们不是任务页。"""
        try:
            for t in self.browser.get_tabs():
                u = (t.url or "").lower()
                if u.startswith(("edge://", "chrome://", "about:", "edge-netinternal://")):
                    tabs = self.browser.get_tabs()
                    if len(tabs) > 1:
                        self.browser.close_tabs(t)
                    else:
                        # 只剩内建页时导航到空白页兜底(不留在欢迎页)
                        t.get("about:blank")
        except Exception:
            pass

    def pages(self):
        return [{"page_id": str(i), "url": t.url, "title": t.title}
                for i, t in enumerate(self.browser.get_tabs())]

    def select_page(self, page_id):
        tabs = self.browser.get_tabs()
        self.tab = tabs[int(page_id)]

    def stop(self):
        try:
            if self.browser:
                self.browser.quit()
        except Exception:
            pass

    def artifact_path(self, session_dir, kind, ext):
        from datetime import datetime
        d = os.path.join(session_dir, "artifacts")
        os.makedirs(d, exist_ok=True)
        name = f"{kind}-{datetime.utcnow().strftime('%H%M%S-%f')}.{ext}"
        return os.path.join(d, name)
