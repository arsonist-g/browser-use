# -*- coding: utf-8 -*-
"""拟人操作层(Must;基准:camoufox humanize/Cursor Movement,M1 简化移植)。

- 鼠标:三次贝塞尔曲线点列 + 逐点 Input.dispatchMouseEvent(mouseMoved),步进 8~16ms
- 打字:逐字符 dispatchKeyEvent(rawKeyDown/char/keyUp),间隔高斯 55~165ms
- 点击按下/抬起间隔 60~130ms;操作间随机延迟窗 120~420ms
全部走 CDP Input 域合成事件(isTrusted=true),不启用 Runtime.enable(CONSTRAINT-001)。
"""
import math
import random


def _gauss(lo, hi):
    mid = (lo + hi) / 2
    return max(lo, min(hi, random.gauss(mid, (hi - lo) / 6)))


def bezier_path(x0, y0, x1, y1, steps=None):
    """带轻微弧度的鼠标轨迹(控制点随机偏移),端点准、中段抖。"""
    if steps is None:
        dist = math.hypot(x1 - x0, y1 - y0)
        steps = max(8, min(48, int(dist / 18)))
    # 控制点:垂直于连线方向随机偏移
    mx, my = (x0 + x1) / 2, (y0 + y1) / 2
    dx, dy = x1 - x0, y1 - y0
    norm = math.hypot(dx, dy) or 1
    off = random.uniform(-dist * 0.12, dist * 0.12) if (dist := math.hypot(dx, dy)) else 0
    cx, cy = mx - dy / norm * off, my + dx / norm * off
    pts = []
    for i in range(1, steps + 1):
        t = i / steps
        # 二次贝塞尔 + 微抖
        x = (1 - t) ** 2 * x0 + 2 * (1 - t) * t * cx + t ** 2 * x1
        y = (1 - t) ** 2 * y0 + 2 * (1 - t) * t * cy + t ** 2 * y1
        pts.append((x + random.uniform(-0.6, 0.6), y + random.uniform(-0.6, 0.6)))
    return pts


def move_mouse(tab, x, y, dispatch=None):
    """从当前(last)位置拟人移动到 (x, y)。M1 以 (0,0) 起点可接受——后续保存上一坐标。
    dispatch:Input 域发送通道,默认 tab.run_cdp;OOPIF 元素传其子 session 调用器
    (坐标系为该 frame 自身视口,与 DOM.getContentQuads 一致)。"""
    send = dispatch or (lambda m, **kw: tab.run_cdp(m, **kw))
    last = getattr(tab, "_bu_last_mouse", (x, y))
    for px, py in bezier_path(last[0], last[1], x, y):
        send("Input.dispatchMouseEvent", type="mouseMoved", x=px, y=py)
        import time
        time.sleep(random.uniform(0.008, 0.016))
    tab._bu_last_mouse = (x, y)


def click_xy(tab, x, y, dbl=False, dispatch=None):
    import time
    send = dispatch or (lambda m, **kw: tab.run_cdp(m, **kw))
    move_mouse(tab, x, y, dispatch)
    time.sleep(_gauss(0.06, 0.13))
    common = dict(x=x, y=y, button="left", clickCount=1)
    send("Input.dispatchMouseEvent", type="mousePressed", **common)
    time.sleep(_gauss(0.06, 0.13))
    send("Input.dispatchMouseEvent", type="mouseReleased", **common)
    if dbl:
        send("Input.dispatchMouseEvent", type="mousePressed", x=x, y=y, button="left", clickCount=2)
        send("Input.dispatchMouseEvent", type="mouseReleased", x=x, y=y, button="left", clickCount=2)


def type_text(tab, text, submit_key=None):
    import time
    for ch in text:
        tab.run_cdp("Input.dispatchKeyEvent", type="keyDown", text=ch, unmodifiedText=ch)
        tab.run_cdp("Input.dispatchKeyEvent", type="keyUp", text=ch, unmodifiedText=ch)
        time.sleep(_gauss(0.055, 0.165))
    if submit_key:
        press_key(tab, submit_key)


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
    import time
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


def op_delay():
    """操作间随机延迟窗。"""
    import time
    time.sleep(_gauss(0.12, 0.42))
