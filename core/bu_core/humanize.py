# -*- coding: utf-8 -*-
"""拟人操作层。鼠标轨迹按 camoufox 源码移植(用户点名基线,取代自造 bezier):
- 轨迹算法 = daijro/camoufox additions/camoucfg/MouseTrajectories.hpp 的
  HumanizeMouseTrajectory(HumanCursor 曲线的 camoufox 修改版:连续均匀内部控制点、
  取整的 y 扰动、距离自适应点数、easeOutQuad 索引重采样),Python 直译;
- 派发节奏 = additions/juggler/protocol/PageHandler.js humanize 分支:只有 move 被
  人类化,按下/抬起直接派发;中间点固定 10ms 间隔、跳过首尾点对、视口外点过滤
  (边界用 >= 判界)、终点精确派发、零位移短路;
- 全部走 CDP Input 域合成事件(isTrusted=true),不启用 Runtime.enable(CONSTRAINT-001)。
偏离声明:camoufox 无 press 间隔随机化(juggler 的 renderer 回执链自带自然延迟);
CDP 合成派发无回执,按下→抬起间保留小随机间隔补偿该差距。点数上限取
humanize:maxTime 机制的收紧值(camoufox 默认 150 点≈1.5s,为盾类时序敏感场景压低)。
"""
import math
import random
import time

# ---- MouseTrajectories.hpp 常量(逐项对应,勿改值——改值即偏离基线) ----
_KNOT_MARGIN = 80      # generateCurve:控制点采样区 = 起终点包围盒外扩 px
_KNOT_COUNT = 2        # generateCurve:内部控制点数(4 点 = 三次贝塞尔)
_DISTORT_MEAN = 1.0    # distortPoints:y 扰动正态均值 px
_DISTORT_STD = 1.0     # distortPoints:y 扰动正态标准差
_DISTORT_FREQ = 0.5    # distortPoints:中间点被扰动概率
_LEN_EXP = 0.25        # tweenPoints:弧长→点数的幂标度(保持速度一致)
_LEN_FACTOR = 20       # tweenPoints:点数乘子
_MAX_POINTS = 30       # getMaxTime:点数上限(camoufox 默认 150;humanize:maxTime 收紧值)
_MIN_POINTS = 2        # getMinTime:0(默认)→ 下限 0+2
_STEP_S = 0.010        # PageHandler.js:每中间点固定 10ms(无随机)

# 按下→抬起间隔(见模块头偏离声明)
_PRESS_S = (0.02, 0.06)


def _ease_out_quad(t):
    """hpp easeOutQuad:-t(t-2),只减速不加速的缓出。"""
    return -t * (t - 2)


def trajectory(x0, y0, x1, y1):
    """HumanizeMouseTrajectory.getPoints 直译:返回含首尾的整数点列。
    流程 = 三次贝塞尔采样(长边每 px 一点)→ y 向扰动 → 弧长幂标度定步数 →
    easeOutQuad 索引重采样(末段步距收敛)。"""
    left = min(x0, x1) - _KNOT_MARGIN
    right = max(x0, x1) + _KNOT_MARGIN
    down = min(y0, y1) - _KNOT_MARGIN
    up = max(y0, y1) + _KNOT_MARGIN
    knots = [(random.uniform(left, right), random.uniform(down, up))
             for _ in range(_KNOT_COUNT)]
    p0, p3 = (x0, y0), (x1, y1)
    p1, p2 = knots

    n = int(max(abs(x1 - x0), abs(y1 - y0), 2))  # generatePoints.midPtsCnt
    raw = []
    for i in range(n):
        t = i / (n - 1) if n > 1 else 0.0
        u = 1.0 - t
        raw.append((u * u * u * p0[0] + 3 * u * u * t * p1[0] + 3 * u * t * t * p2[0] + t * t * t * p3[0],
                    u * u * u * p0[1] + 3 * u * u * t * p1[1] + 3 * u * t * t * p2[1] + t * t * t * p3[1]))

    distorted = [raw[0]]  # distortPoints:首尾强制不动
    for pt in raw[1:-1]:
        dy = round(random.gauss(_DISTORT_MEAN, _DISTORT_STD)) \
            if random.random() < _DISTORT_FREQ else 0.0
        distorted.append((pt[0], pt[1] + dy))
    distorted.append(raw[-1])

    total = 0.0  # tweenPoints:折线总弧长
    for a, b in zip(distorted, distorted[1:], strict=False):
        total += math.hypot(b[0] - a[0], b[1] - a[1])
    target = min(_MAX_POINTS, max(_MIN_POINTS, int(total ** _LEN_EXP * _LEN_FACTOR)))
    out = []
    for i in range(target):
        t = i / (target - 1)
        idx = int(_ease_out_quad(t) * (len(distorted) - 1))
        out.append((round(distorted[idx][0]), round(distorted[idx][1])))
    return out


def move_mouse(tab, x, y, dispatch=None):
    """从上次落点拟人移动到 (x, y)(PageHandler mousemove 分支语义):
    轨迹起点 = 上次真实落点(初始 (0,0),camoufox _lastTrackedPos 同款);零位移
    短路;中间点逐个派发 + 固定 10ms,视口外(含恰在边界)的点跳过;终点精确
    派发。dispatch:Input 派发通道(主 session ws;坐标已换算主视口系)。"""
    send = dispatch or (lambda m, **kw: tab.run_cdp(m, **kw))
    last = getattr(tab, "_bu_last_mouse", (0.0, 0.0))
    if round(x) == round(last[0]) and round(y) == round(last[1]):
        tab._bu_last_mouse = (x, y)
        return
    vw, vh = _viewport(send)
    for px, py in trajectory(last[0], last[1], x, y)[1:-1]:  # 跳过起点对与终点对
        if 0 <= px < vw and 0 <= py < vh:
            send("Input.dispatchMouseEvent", type="mouseMoved", x=px, y=py)
            time.sleep(_STEP_S)
    send("Input.dispatchMouseEvent", type="mouseMoved", x=x, y=y)
    tab._bu_last_mouse = (x, y)


def _viewport(send):
    """视口尺寸(中间点边界过滤用;PageHandler 用 browser 元素矩形,CDP 侧为
    layout viewport)。查询失败返回大值(不过滤——出界中间点在 CDP 下无害)。"""
    try:
        r = send("Runtime.evaluate", expression="[innerWidth, innerHeight]",
                 returnByValue=True)
        v = (r.get("result") or {}).get("value")
        if isinstance(v, list) and len(v) == 2 and v[0] > 0:
            return (v[0], v[1])
    except Exception:
        pass
    return (10 ** 6, 10 ** 6)


def click_xy(tab, x, y, dbl=False, dispatch=None):
    """move → 按下 → 抬起(camoufox:点击不经轨迹展开,move 段已人类化)。
    按下/抬起间的小随机间隔见模块头偏离声明。"""
    send = dispatch or (lambda m, **kw: tab.run_cdp(m, **kw))
    move_mouse(tab, x, y, dispatch)
    common = dict(x=x, y=y, button="left", clickCount=1)
    send("Input.dispatchMouseEvent", type="mousePressed", **common)
    time.sleep(random.uniform(*_PRESS_S))
    send("Input.dispatchMouseEvent", type="mouseReleased", **common)
    if dbl:
        send("Input.dispatchMouseEvent", type="mousePressed", x=x, y=y, button="left", clickCount=2)
        time.sleep(random.uniform(*_PRESS_S))
        send("Input.dispatchMouseEvent", type="mouseReleased", x=x, y=y, button="left", clickCount=2)


def type_text(tab, text, submit_key=None):
    for ch in text:
        tab.run_cdp("Input.dispatchKeyEvent", type="keyDown", text=ch, unmodifiedText=ch)
        tab.run_cdp("Input.dispatchKeyEvent", type="keyUp", text=ch, unmodifiedText=ch)
        time.sleep(_gauss(0.055, 0.165))
    if submit_key:
        press_key(tab, submit_key)


def _gauss(lo, hi):
    mid = (lo + hi) / 2
    return max(lo, min(hi, random.gauss(mid, (hi - lo) / 6)))


_KEY_MODIFIERS = {"Control", "Alt", "Shift", "Meta"}

# Windows VK(US 布局);覆盖 cdt/puppeteer KeyInput 常用全集
_NAMED_VK = {
    "Enter": 13, "NumpadEnter": 13, "\r": 13, "\n": 13,
    "Tab": 9, "Escape": 27, "Backspace": 8, "Delete": 46,
    "ArrowUp": 38, "ArrowDown": 40, "ArrowLeft": 37, "ArrowRight": 39,
    "Home": 36, "End": 35, "PageUp": 33, "PageDown": 34, "Space": 32, " ": 32,
    "Insert": 45, "Pause": 19, "CapsLock": 20, "NumLock": 144, "ScrollLock": 145,
    "ContextMenu": 93,
    # 逻辑修饰键名(puppeteer KeyInput;物理名 ShiftLeft 等在下方)
    "Shift": 16, "Control": 17, "Alt": 18, "Meta": 91,
    "ShiftLeft": 160, "ShiftRight": 161, "ControlLeft": 162, "ControlRight": 163,
    "AltLeft": 164, "AltRight": 165, "MetaLeft": 91, "MetaRight": 92,
    "Numpad0": 96, "Numpad1": 97, "Numpad2": 98, "Numpad3": 99, "Numpad4": 100,
    "Numpad5": 101, "Numpad6": 102, "Numpad7": 103, "Numpad8": 104, "Numpad9": 105,
    "NumpadMultiply": 106, "NumpadAdd": 107, "NumpadSubtract": 109,
    "NumpadDecimal": 110, "NumpadDivide": 111,
    "AudioVolumeMute": 173, "AudioVolumeDown": 174, "AudioVolumeUp": 175,
    "MediaTrackNext": 176, "MediaTrackPrevious": 177, "MediaStop": 178,
    "MediaPlayPause": 179,
    "Semicolon": 186, "Equal": 187, "Comma": 188, "Minus": 189, "Period": 190,
    "Slash": 191, "Backquote": 192, "BracketLeft": 219, "Backslash": 220,
    "BracketRight": 221, "Quote": 222,
    "=": 187, "+": 187, "-": 189, ";": 186, ",": 188, ".": 190, "/": 191,
    "`": 192, "[": 219, "\\": 220, "]": 221, "'": 222,
}


def _vk(key):
    named = _NAMED_VK.get(key)
    if named is not None:
        return named
    if key.startswith("F") and key[1:].isdigit():
        n = int(key[1:])
        if 1 <= n <= 24:
            return 111 + n  # VK_F1=112 ... VK_F24=135
    if len(key) == 1 and key.isalpha():
        return ord(key.upper())
    if key.startswith("Key") and len(key) == 4 and key[3].isalpha():
        return ord(key[3].upper())
    if key.startswith("Digit") and len(key) == 6 and key[5].isdigit():
        return ord(key[5])
    if key.isdigit():
        return ord(key)
    return 0


def parse_key(key_input):
    """对齐 cdt parseKey:逐字符扫描,"+" 在缓冲非空时为分隔(支持 "Control++");
    返回 [主键, ...修饰键(原序)];重复键报错。"""
    result = []
    buf = ""
    for ch in str(key_input):
        if ch == "+" and buf:
            result.append(buf)
            buf = ""
        else:
            buf += ch
    if buf:
        result.append(buf)
    if not result:
        raise ValueError(f"Key {key_input} could not be parsed.")
    if len(set(result)) != len(result):
        raise ValueError(f"Key {key_input} contains duplicate keys.")
    invalid = [k for k in result if _vk(k) == 0]
    if invalid:
        raise ValueError(f"Key {key_input} is invalid: {invalid[0]}")
    # cdt 形状:[主键, ...修饰键](主键在末位 → 返回时反转)
    return [result[-1], *result[:-1]]


def press_key(tab, key):
    """Enter/Control+A 形式;修饰键按住→主键→释放。可打印字符走 keyDown(text)
    使其产生实际输入(对齐 puppeteer press 语义,rawKeyDown 不生成字符)。
    中途抛错时 finally 逆序释放已按下的修饰键(上游 #2309),避免修饰键逻辑卡死。"""
    main, *mods = parse_key(key)
    modifiers = 0
    pressed = []
    try:
        for m in mods:
            modifiers |= {"Control": 2, "Alt": 1, "Shift": 8, "Meta": 4}[m]
            tab.run_cdp("Input.dispatchKeyEvent", type="rawKeyDown",
                        key=m, code=f"{m}Left", modifiers=modifiers, windowsVirtualKeyCode=_vk(m))
            pressed.append((m, modifiers))
        time.sleep(_gauss(0.03, 0.09))
        code = _vk(main)
        code_field = f"Key{main}" if len(main) == 1 and main.isalpha() else main
        printable = len(main) == 1 and not mods and main.isprintable()
        main_type = "keyDown" if printable else "rawKeyDown"
        down_kwargs = dict(type=main_type, key=main, code=code_field,
                           windowsVirtualKeyCode=code, modifiers=modifiers)
        if printable:
            down_kwargs["text"] = main
            down_kwargs["unmodifiedText"] = main
        tab.run_cdp("Input.dispatchKeyEvent", **down_kwargs)
        tab.run_cdp("Input.dispatchKeyEvent", type="keyUp", key=main,
                    code=code_field, windowsVirtualKeyCode=code, modifiers=modifiers)
    finally:
        for m, mods_bit in reversed(pressed):
            tab.run_cdp("Input.dispatchKeyEvent", type="keyUp",
                        key=m, code=f"{m}Left", modifiers=mods_bit)
