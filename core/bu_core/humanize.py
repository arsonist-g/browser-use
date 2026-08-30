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


def move_mouse(tab, x, y):
    """从当前(last)位置拟人移动到 (x, y)。M1 以 (0,0) 起点可接受——后续保存上一坐标。"""
    last = getattr(tab, "_bu_last_mouse", (x, y))
    for px, py in bezier_path(last[0], last[1], x, y):
        tab.run_cdp("Input.dispatchMouseEvent", type="mouseMoved", x=px, y=py)
        import time
        time.sleep(random.uniform(0.008, 0.016))
    tab._bu_last_mouse = (x, y)


def click_xy(tab, x, y, dbl=False):
    import time
    move_mouse(tab, x, y)
    time.sleep(_gauss(0.06, 0.13))
    common = dict(x=x, y=y, button="left", clickCount=1)
    tab.run_cdp("Input.dispatchMouseEvent", type="mousePressed", **common)
    time.sleep(_gauss(0.06, 0.13))
    tab.run_cdp("Input.dispatchMouseEvent", type="mouseReleased", **common)
    if dbl:
        tab.run_cdp("Input.dispatchMouseEvent", type="mousePressed", x=x, y=y, button="left", clickCount=2)
        tab.run_cdp("Input.dispatchMouseEvent", type="mouseReleased", x=x, y=y, button="left", clickCount=2)


def type_text(tab, text, submit_key=None):
    import time
    for ch in text:
        tab.run_cdp("Input.dispatchKeyEvent", type="keyDown", text=ch, unmodifiedText=ch)
        tab.run_cdp("Input.dispatchKeyEvent", type="keyUp", text=ch, unmodifiedText=ch)
        time.sleep(_gauss(0.055, 0.165))
    if submit_key:
        press_key(tab, submit_key)


_KEY_MODIFIERS = {"Control", "Alt", "Shift", "Meta"}


def press_key(tab, key):
    """Enter/Control+A 形式;修饰键按住→主键→释放。"""
    import time
    parts = key.split("+")
    mods = [p for p in parts if p in _KEY_MODIFIERS]
    main = parts[-1]
    modifiers = 0
    for m in mods:
        modifiers |= {"Control": 2, "Alt": 1, "Shift": 8, "Meta": 4}[m]
        tab.run_cdp("Input.dispatchKeyEvent", type="rawKeyDown",
                    key=m, code=f"{m}Left", modifiers=modifiers, windowsVirtualKeyCode=_vk(m))
    time.sleep(_gauss(0.03, 0.09))
    code = _vk(main)
    tab.run_cdp("Input.dispatchKeyEvent", type="rawKeyDown", key=main,
                code=f"Key{main}" if len(main) == 1 and main.isalpha() else main,
                windowsVirtualKeyCode=code, modifiers=modifiers)
    tab.run_cdp("Input.dispatchKeyEvent", type="keyUp", key=main,
                code=f"Key{main}" if len(main) == 1 and main.isalpha() else main,
                windowsVirtualKeyCode=code, modifiers=modifiers)
    for m in reversed(mods):
        modifiers -= {"Control": 2, "Alt": 1, "Shift": 8, "Meta": 4}[m]
        tab.run_cdp("Input.dispatchKeyEvent", type="keyUp",
                    key=m, code=f"{m}Left", modifiers=modifiers)


def _vk(key):
    named = {"Enter": 13, "Tab": 9, "Escape": 27, "Backspace": 8, "Delete": 46,
             "ArrowUp": 38, "ArrowDown": 40, "ArrowLeft": 37, "ArrowRight": 39,
             "Home": 36, "End": 35, "PageUp": 33, "PageDown": 34, "Space": 32}
    if key in named:
        return named[key]
    if len(key) == 1 and key.isalpha():
        return ord(key.upper())
    if key.isdigit():
        return ord(key)
    return 0


def op_delay():
    """操作间随机延迟窗。"""
    import time
    time.sleep(_gauss(0.12, 0.42))
