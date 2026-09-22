// 单元测试:当前页跟随必须跳过浏览器内建页(edge://downloads-hub/ 等浏览器 UI)。
// 实测缺陷:点击触发的下载会让 Edge 前置 edge://downloads-hub/,它按"最近活动页优先"
// 成为当前页,页面级工具(快照/网络/滚动)于是静默作用在这个非任务页上——AI 拿到的
// 快照与请求列表都是浏览器 UI 的,且没有任何提示。
import { test } from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import path from "node:path";
import url from "node:url";

const ROOT = path.dirname(path.dirname(path.dirname(url.fileURLToPath(import.meta.url))));

function runPython(script) {
  return new Promise((resolve) => {
    const p = spawn("python", ["-c", script], {
      cwd: ROOT, windowsHide: true,
      env: { ...process.env, PYTHONIOENCODING: "utf-8" },
    });
    let stdout = "", stderr = "";
    p.stdout.on("data", (d) => (stdout += d));
    p.stderr.on("data", (d) => (stderr += d));
    p.on("close", (status) => resolve({ status, stdout, stderr }));
  });
}

test("当前页跟随跳过内建页,任务页跟随语义不变", async (t) => {
  const script = [
    "import json, sys, tempfile",
    `sys.path.insert(0, ${JSON.stringify(path.join(ROOT, "core"))})`,
    "from bu_core.session import BrowserSession, is_builtin_page",
    "",
    "class FakeTab:",
    "    def __init__(self, tab_id, url):",
    "        self.tab_id = tab_id",
    "        self._target_id = tab_id",
    "        self.url = url",
    "    def run_cdp(self, *a, **k):",
    "        return {}",
    "",
    "class FakeBrowser:",
    "    def __init__(self, tabs):",
    "        self.tabs = tabs",
    "    def get_tabs(self):",
    "        return list(self.tabs)",
    "",
    "def mk(tabs, current_id, known):",
    "    s = BrowserSession('s1', 1, 'p', session_dir=tempfile.mkdtemp())",
    "    s.browser = FakeBrowser(tabs)",
    "    s.tab = next(t for t in tabs if t.tab_id == current_id)",
    "    s._last_active_tab_id = current_id",
    "    s._known_tab_ids = set(known)",
    "    return s",
    "",
    "out = {}",
    "out['builtin'] = [is_builtin_page(u) for u in",
    "    ['edge://downloads-hub/', 'chrome://settings/', 'about:blank', 'devtools://x',",
    "     'http://127.0.0.1:1/p', 'https://example.com/']]",
    "",
    "# 场景 1:内建页被浏览器前置(列表首位 = 最近活动),当前页不得漂移",
    "s1 = mk([FakeTab('builtin', 'edge://downloads-hub/'), FakeTab('task', 'http://task/')],",
    "        'task', ['task'])",
    "s1.observe_page_changes()",
    "out['preempted'] = {'current': s1.tab.tab_id, 'notices': s1.consume_page_notices()}",
    "",
    "# 场景 2:两个任务页之间正常跟随(最近活动的任务页成为当前页)",
    "s2 = mk([FakeTab('b', 'http://b/'), FakeTab('a', 'http://a/')], 'a', ['a'])",
    "s2.observe_page_changes()",
    "out['normal'] = {'current': s2.tab.tab_id, 'notices': s2.consume_page_notices()}",
    "",
    "# 场景 3:原当前页已关 + 内建页在首位 → 退到任务页,不落到内建页",
    "s3 = mk([FakeTab('builtin', 'edge://downloads-hub/'), FakeTab('task', 'http://task/')],",
    "        'builtin', ['builtin', 'task'])",
    "s3._last_active_tab_id = 'gone'",
    "s3.observe_page_changes()",
    "out['closed'] = {'current': s3.tab.tab_id, 'notices': s3.consume_page_notices()}",
    "",
    "# 场景 4:选中页被关后的回退同样不落到内建页",
    "s4 = mk([FakeTab('builtin', 'edge://downloads-hub/'), FakeTab('task', 'http://task/')],",
    "        'builtin', ['builtin', 'task'])",
    "s4.tab = FakeTab('gone', 'http://gone/')",
    "note4 = s4.recover_page_selection()",
    "out['recover'] = {'current': s4.tab.tab_id, 'note': note4}",
    "print(json.dumps(out, ensure_ascii=False))",
  ].join("\n");
  const r = await runPython(script);
  if (/ModuleNotFoundError|ImportError/.test(r.stderr ?? "")) return t.skip("core 依赖未安装");
  assert.equal(r.status, 0, `调用失败: ${r.stderr}`);
  const got = JSON.parse(r.stdout);

  assert.deepEqual(got.builtin, [true, true, true, true, false, false],
    "内建页判定:edge/chrome/about/devtools 是内建页,http(s) 不是");

  assert.equal(got.preempted.current, "task",
    "内建页被前置时当前页不得漂移(漂移即页面级工具静默作用于浏览器 UI)");
  const preemptedNotices = got.preempted.notices.join("\n");
  assert.match(preemptedNotices, /Browser-internal page/,
    "内建页出现必须有一次说明,否则 AI 不知道浏览器开了什么");
  assert.doesNotMatch(preemptedNotices, /became active|Active page changed/,
    "不得声称当前页变化:当前页没变");

  assert.equal(got.normal.current, "b", "任务页之间仍按最近活动页跟随");
  assert.match(got.normal.notices.join("\n"), /became active/, "任务页成为当前页仍要有提醒");

  assert.equal(got.closed.current, "task", "原页已关时退到任务页");
  assert.equal(got.recover.current, "task", "选中页被关后的回退不得落到内建页");
  assert.match(got.recover.note ?? "", /Page 1 is now selected/,
    "回退提示必须说明实际落到第几页");
});
