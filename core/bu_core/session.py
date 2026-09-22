# -*- coding: utf-8 -*-
"""会话内 DP 生命周期与浏览器实例(DEC-001:默认浏览器 exe、有头、默认指纹)。
红线(CONSTRAINT-001):不启用 Runtime.enable;不做 UA/平台/语言覆盖。
"""
import os
import time

from DrissionPage import Chromium, ChromiumOptions

from .cdp_events import BrowserNetworkRecorder
from .errors import InternalFailure, NotFoundError, StateExpiredError

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


# 浏览器内建页(下载中心/欢迎页/设置等)是浏览器 UI,不是任务页:页面级工具(快照/网络/
# 滚动)落在上面只会误导 AI。实测:点击触发的下载会让 Edge 前置 edge://downloads-hub/,
# 且 Target.closeTarget 与 HTTP /json/close 都关不掉它(CHROMIUM 接受请求,页面仍在)。
# 因此"当前页跟随"跳过内建页(显式 select_page 仍可选中),prune 继续尽力关掉。
_BUILTIN_PAGE_PREFIXES = ("edge://", "chrome://", "about:", "edge-netinternal://", "devtools://")


def is_builtin_page(url):
    """该 url 是否指向浏览器内建页(非任务页)。"""
    return str(url or "").lower().startswith(_BUILTIN_PAGE_PREFIXES)


class BrowserSession:
    def __init__(self, session_id, port, profile, browser_exe=None, headless=False,
                 attach=False, extra_flags=None, session_dir=None):
        self.session_id = session_id
        self.port = port
        self.profile = profile
        self.browser_exe = browser_exe
        self.headless = headless
        # attach:浏览器已由 daemon 以 pipe+port 双通道启动,DP 只接管(不启动)
        self.attach = attach
        self.extra_flags = extra_flags or []
        self.session_dir = session_dir
        # WebMCP 需要 flag(运行时特征变更,默认不开 = CONSTRAINT-001 权衡)
        self.webmcp_enabled = "--enable-features=WebMCP" in self.extra_flags
        self.browser = None
        self.tab = None
        self.net_recorder = None
        self._last_active_tab_id = None
        self._tab_cache = {}
        self._known_tab_ids = set()
        self._tab_urls = {}
        self._pending_page_notices = []
        # 页内工具共用状态
        self.listen_started = False
        self.console_started = False
        self.uid_map = {}   # uid -> a11y node(backendNodeId 等)
        self.uid_frames = {}  # uid -> OOPIF 子 sessionId(空 = 主 frame)
        self.uid_frame_ids = {}  # uid -> 所属子 frameId(滚动/求值/坐标换算定位用)
        self.frame_tree = {}     # frameId -> {session, parent, root}(快照时全量 frame 树)
        self.frame_owners = {}   # frameId -> [宿主 backendNodeId, 宿主所在 frame 的 session](宿主链换算)
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
            # 浏览器原生 UI 弹窗治理(与 daemon pipe-browser 的种子同套;此处走 DP
            # set_pref 写入):翻译/密码/填充/通知。气泡是浏览器 UI,点击工具不可达
            co.set_argument("--deny-permission-prompts")
            co.set_pref("translate.enabled", False)
            co.set_pref("credentials_enable_service", False)
            co.set_pref("credentials_enable_autosignin", False)
            co.set_pref("autofill.profile_enabled", False)
            co.set_pref("autofill.credit_card_enabled", False)
            co.set_pref("profile.default_content_setting_values.notifications", 2)
            if self.headless:
                co.headless()
        self.browser = Chromium(co)
        try:
            self.net_recorder = BrowserNetworkRecorder(self.port).start()
        except Exception:
            self.net_recorder = None
        self.tab = self.browser.latest_tab
        self.prune_edge_popups()
        self.tab = self.browser.latest_tab
        self._register_tab(self.tab)
        self._known_tab_ids = {self._raw_tab_id(self.tab)}
        self._tab_urls = {self._raw_tab_id(self.tab): self._tab_url(self.tab)}
        self._last_active_tab_id = self._raw_tab_id(self.tab)
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
        # 下载行为对齐上游(puppeteer/CDT 启动即 allow):headless 新版默认 deny 下载,
        # 点击 a[download] 会静默丢弃(无网络请求);落会话 downloads 目录(stop 全删口径)
        if self.session_dir:
            try:
                dl_dir = os.path.join(self.session_dir, "downloads")
                os.makedirs(dl_dir, exist_ok=True)
                # Chromium 对象只有内部 _run_cdp(public run_cdp 在 tab 上),发 browser 级命令
                self.browser._run_cdp("Browser.setDownloadBehavior",
                                      behavior="allow", downloadPath=dl_dir)
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

    def _raw_tab_id(self, tab):
        return getattr(tab, "tab_id", None) or getattr(tab, "_target_id", None)

    def _tab_url(self, tab):
        try:
            return str(tab.url or "")
        except Exception:
            return ""

    def _register_tab(self, tab):
        """按 tab_id 复用固定 tab 对象,保留 listen/console 的 tab 级状态。"""
        tid = self._raw_tab_id(tab)
        if tid is None:
            return tab
        cached = self._tab_cache.get(tid)
        if cached is not None:
            return cached
        self._tab_cache[tid] = tab
        if self.listen_started:
            try:
                if not getattr(tab.listen, "listening", False):
                    tab.listen.start()
            except Exception:
                pass
        install_console_hook(tab)
        return tab

    def _tab_index(self, tabs, tid):
        for i, tab in enumerate(tabs):
            if self._raw_tab_id(tab) == tid:
                return i
        return None

    def _pick_active(self, ids, urls, previous_active_id):
        """当前页归属:浏览器活动页(列表首位)优先,但内建页永不自动成为当前页。

        内建页被前置时保持原当前页(它是 AI 的任务上下文);原页已关则退到第一个任务页。
        """
        if not is_builtin_page(urls[0]):
            return ids[0]
        if previous_active_id in ids:
            return previous_active_id
        for i, u in enumerate(urls):
            if not is_builtin_page(u):
                return ids[i]
        return ids[0]

    def observe_page_changes(self, announce=True):
        """观察浏览器活动页/新页/URL 变化,并在下一次快照前累积提醒。"""
        try:
            raw_tabs = self.browser.get_tabs()
        except Exception:
            return
        if not raw_tabs:
            return
        tabs = [self._register_tab(tb) for tb in raw_tabs]
        ids = [self._raw_tab_id(tb) for tb in tabs]
        urls = [self._tab_url(tb) for tb in tabs]
        if not any(ids):
            return
        previous_active_id = self._last_active_tab_id
        active_id = self._pick_active(ids, urls, previous_active_id)
        new_ids = [tid for tid in ids if tid not in self._known_tab_ids]
        active_changed = active_id != previous_active_id
        if announce:
            for tid in new_ids:
                idx = self._tab_index(tabs, tid)
                if idx is None:
                    continue
                if is_builtin_page(urls[idx]):
                    # 内建页本就可被浏览器前置:明说它不是任务页,当前页不因此漂移
                    self._pending_page_notices.append(
                        f"notice: Browser-internal page opened: page_id={idx}, url={urls[idx]} "
                        f"(browser UI, not a task page; the selected page is unchanged)")
                elif tid == active_id:
                    self._pending_page_notices.append(
                        f"notice: New page opened and became active: page_id={idx}, url={urls[idx]}")
                else:
                    self._pending_page_notices.append(
                        f"notice: New page opened in background: page_id={idx}, url={urls[idx]}")
            if active_changed and active_id not in new_ids and previous_active_id is not None:
                idx = self._tab_index(tabs, active_id)
                if idx is not None:
                    self._pending_page_notices.append(
                        f"notice: Active page changed to page_id={idx}, url={urls[idx]}")
            if active_changed and previous_active_id in ids:
                prev_idx = self._tab_index(tabs, previous_active_id)
                if prev_idx is not None:
                    self._pending_page_notices.append(
                        f"notice: Previous page page_id={prev_idx} remains available; "
                        f"use select_page {prev_idx} then list_network_requests to inspect its requests")
            for idx, tid in enumerate(ids):
                old = self._tab_urls.get(tid)
                if old is not None and old != urls[idx] and tid not in new_ids:
                    self._pending_page_notices.append(
                        f"notice: Page page_id={idx} navigated to {urls[idx]}")
        if active_changed or self.tab is None or self._raw_tab_id(self.tab) not in ids:
            idx = self._tab_index(tabs, active_id)
            self.tab = tabs[idx] if idx is not None else tabs[0]
        self._known_tab_ids = set(ids)
        self._tab_urls = dict(zip(ids, urls, strict=True))
        self._last_active_tab_id = active_id

    def consume_page_notices(self):
        notices = list(self._pending_page_notices)
        self._pending_page_notices.clear()
        return notices

    @property
    def t(self):
        self.observe_page_changes()
        if self.tab is None:
            raw = self.browser.get_tabs()
            if raw:
                self.tab = self._register_tab(raw[0])
        return self.tab

    def _active_tab_id(self):
        try:
            tabs = self.browser.get_tabs()
        except Exception:
            return None
        return self._raw_tab_id(tabs[0]) if tabs else None

    def _activate_tab(self, tab):
        """显式选页的硬语义:浏览器活动页必须与驱动当前页一致。"""
        tid = self._raw_tab_id(tab)
        if not tid:
            raise StateExpiredError("selected page has no target id")
        if self._active_tab_id() == tid:
            self.tab = tab
            return
        try:
            self.browser.activate_tab(tid)
        except Exception:
            pass
        try:
            tab.run_cdp("Page.bringToFront")
        except Exception:
            pass
        deadline = time.time() + 1.0
        while time.time() < deadline:
            if self._active_tab_id() == tid:
                self.tab = tab
                return
            time.sleep(0.05)
        # 后台窗口/未聚焦窗口的兜底:最小化再恢复后重试一次。
        try:
            win = self.browser._run_cdp("Browser.getWindowForTarget", targetId=tid)
            wid = win.get("windowId")
            if wid is not None:
                self.browser._run_cdp("Browser.setWindowBounds", windowId=wid,
                                      bounds={"windowState": "minimized"})
                time.sleep(0.1)
                self.browser._run_cdp("Browser.setWindowBounds", windowId=wid,
                                      bounds={"windowState": "normal"})
        except Exception:
            pass
        try:
            self.browser.activate_tab(tid)
        except Exception:
            pass
        try:
            tab.run_cdp("Page.bringToFront")
        except Exception:
            pass
        deadline = time.time() + 1.5
        while time.time() < deadline:
            if self._active_tab_id() == tid:
                self.tab = tab
                return
            time.sleep(0.05)
        raise InternalFailure("Failed to bring selected page to the browser foreground"
                              "(页面仍可操作,但前台顺序不保证)")

    def _whitelist_paths(self):
        """白名单扩展目录(Should 机制;首版无实现,恒空 = 全禁扩展)。"""
        return []

    def prune_edge_popups(self):
        """关掉一切浏览器内建页(welcome/同步确认/更新提示等)——它们不是任务页。
        不走 DP 的 browser.close_tabs:其内部 `while tab.driver.is_running and ...`
        依赖 targetDestroyed 事件清理 driver 注册表,事件丢失时无限等待(实测挂死)。"""
        try:
            for t in self.browser.get_tabs():
                if is_builtin_page(t.url):
                    tabs = self.browser.get_tabs()
                    if len(tabs) > 1:
                        tab_id = t.tab_id
                        self.browser.run_cdp("Target.closeTarget", targetId=tab_id)
                        for _ in range(40):  # 有界等待 target 消失(≤2s)
                            if tab_id not in {tb.tab_id for tb in self.browser.get_tabs()}:
                                break
                            time.sleep(0.05)
                    else:
                        # 只剩内建页时导航到空白页兜底(不留在欢迎页)
                        t.get("about:blank")
        except Exception:
            pass

    def pages(self):
        tabs = [self._register_tab(tb) for tb in self.browser.get_tabs()]
        return [{"page_id": str(i), "url": t.url, "title": t.title}
                for i, t in enumerate(tabs)]

    def recover_page_selection(self):
        """上游 createPagesSnapshot 语义:选中页已关时自动回退 pages[0] 并留痕。
        返回提示行(无回退发生时 None);由 list_pages 附进响应。"""
        tabs = self.browser.get_tabs()
        if not tabs:
            return None
        cur_id = getattr(self.tab, "tab_id", None)
        if cur_id is not None and any(tb.tab_id == cur_id for tb in tabs):
            return None
        if self.tab is None:
            return None
        # 回退目标同样跳过内建页:回退到浏览器 UI 上,页面级工具就又在对着非任务页工作
        ids = [self._raw_tab_id(tb) for tb in tabs]
        urls = [self._tab_url(tb) for tb in tabs]
        idx = self._tab_index(tabs, self._pick_active(ids, urls, None))
        self.tab = self._register_tab(tabs[0 if idx is None else idx])
        self._last_active_tab_id = self._raw_tab_id(self.tab)
        return f"Note: the previously selected page was closed. Page {0 if idx is None else idx} is now selected."

    def select_page(self, page_id):
        tabs = self.browser.get_tabs()
        idx = int(page_id)
        if idx < 0 or idx >= len(tabs):
            raise NotFoundError("No page found")  # 文案对齐 cdt getPageById
        target = self._register_tab(tabs[idx])
        self._activate_tab(target)
        self.tab = target
        # 显式选页本身不产生"意外页面变化"提醒,但同步活动页基线。
        self.observe_page_changes(announce=False)

    def stop(self):
        try:
            if self.net_recorder:
                self.net_recorder.close()
        except Exception:
            pass
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
