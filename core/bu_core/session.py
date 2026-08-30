# -*- coding: utf-8 -*-
"""会话内 DP 生命周期与浏览器实例(DEC-001:默认浏览器 exe、有头、默认指纹)。
红线(CONSTRAINT-001):不启用 Runtime.enable;不做 UA/平台/语言覆盖。
"""
import os
from DrissionPage import Chromium, ChromiumOptions


class BrowserSession:
    def __init__(self, session_id, port, profile, browser_exe=None, headless=False):
        self.session_id = session_id
        self.port = port
        self.profile = profile
        self.browser_exe = browser_exe
        self.headless = headless
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
        # Edge 首启/同步类弹窗会抢占标签页甚至模态阻塞 CDP,全面禁用(不影响指纹语义)
        co.set_argument("--disable-features",
                        "msFirstRunExperience,msSeamlessWebToBrowserSignIn,msImplicitSignin")
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
        # 固定主任务 tab:Edge 会中途弹 sync 确认页抢占 latest_tab,不能跟随
        tabs = self.browser.get_tabs()
        if not tabs:
            return self.tab
        if self.tab not in tabs:
            self.tab = tabs[0]
        return self.tab

    def prune_edge_popups(self):
        """关掉 Edge 自动的同步确认/首启类弹窗页(它们不是任务页)。"""
        try:
            for t in self.browser.get_tabs():
                u = t.url or ""
                if u.startswith("edge://sync-confirmation") or u.startswith("edge://first-run") \
                   or u.startswith("chrome://sync-confirmation") or u.startswith("edge://post-setup"):
                    self.browser.close_tabs(t)
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
