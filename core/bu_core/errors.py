# -*- coding: utf-8 -*-
"""工具失败分类学:每个类 = 一种真实原因,code 即对外错误码。

设计约束(对 AI 消费面负责):
- code 必须指向真原因,不得用 Python 异常类型反推(如把"状态过期"报成"参数错")。
- 正文必须自带下一步动作;不写"见某文档"这类取不到的引用。
- retryable = 值得重试;引用类状态过期也是 True,但前提是按正文刷新状态。

JS 侧码表(含 daemon/桥专有码)见 lib/error-codes.mjs;两侧由契约测试对齐。
"""


class ToolFailure(Exception):
    """工具失败基类:未归类异常的兜底为 INTERNAL。"""

    code = "INTERNAL"
    retryable = False


class UsageError(ToolFailure):
    """调用参数/命令写错(格式、枚举、JSON 解析、同一次调用内自相矛盾的参数)。

    下一步:按正文改正调用后重试;不要原样重试。
    """

    code = "INVALID_ARG"


class UnknownTool(UsageError):
    """工具名不在本 build 的注册表里(通常是拼写错误)。"""


class StateExpiredError(ToolFailure):
    """引用的页面状态已过期:uid / msgid / reqid / 快照 / 选中页都属此类。

    下一步:重新 take_snapshot 或重新 list 后,用新 id 重试。
    """

    code = "STATE_EXPIRED"
    retryable = True


class BlockedError(ToolFailure):
    """页面被模态弹窗阻塞,当前调用无法完成。

    下一步:先 handle_dialog 处理弹窗,再重试原调用。
    """

    code = "PAGE_BLOCKED"


class NotFoundError(ToolFailure):
    """引用的本地产物或对象不存在(快照文件、扩展 id、页面)。

    下一步:先创建或列举(如 take_heapsnapshot / list_extensions),再用有效引用重试。
    """

    code = "NOT_FOUND"


class UnsupportedError(ToolFailure):
    """本 build 或该浏览器有意不做该操作(不是"功能还没做")。

    下一步:改用正文给出的替代方式;不要重试。
    """

    code = "UNSUPPORTED"


class PageError(ToolFailure):
    """页面侧脚本/工具执行失败,原因见正文中被带回的页面报错。

    下一步:按正文判断是改调用还是换目标;不要原样重试。
    """

    code = "PAGE_ERROR"


class TimeoutExceeded(ToolFailure):
    """本次调用的预算用尽(工具自身的等待/轮询预算,不是传输层)。

    下一步:加大预算或换更明确的等待条件后重试。
    """

    code = "TIMEOUT"
    retryable = True


class CdpError(ToolFailure):
    """浏览器调试协议层调用失败(pipe 通道命令报错)。

    下一步:确认会话仍存活(select_page / 新会话);不要原样重试。
    """

    code = "CDP_ERROR"


class BrowserUnavailable(ToolFailure):
    """会话浏览器实例或其调试端口不可达(ws 建不上、调试端口上没有页面)。

    下一步:确认该会话的浏览器仍在(必要时新建会话或先 new_page);不要原样重试。
    """

    code = "BROWSER_NOT_RUNNING"


class PipeUnavailable(ToolFailure):
    """该会话没有 pipe 通道(浏览器未接受 fd 3/4,会话降级为 port-only)。

    只影响 PWA 四个工具:Target/Extensions 域走浏览器级 ws,降级态下仍可用。
    下一步:改用不受该域限制的工具;确需 PWA 时新建会话,并确认启动未降级。
    """

    code = "PIPE_UNAVAILABLE"


class CoreCallTimeout(ToolFailure):
    """浏览器级 CDP 调用未在预算内返回(daemon 等待浏览器回话超时)。

    下一步:加大该工具预算(--timeout)重试一次;仍出现说明浏览器卡在这次调用上,
    按会话日志排查,并报告用户。
    """

    code = "CORE_TIMEOUT"
    retryable = True


class InternalFailure(ToolFailure):
    """内部条件不满足或未归因的失败(不是调用方写错参数)。

    下一步:按正文提示处理;同一调用不要原样重试,必要时报告用户并附会话日志。
    """

    code = "INTERNAL"


def message_of(exc):
    """取异常正文:KeyError 的 str() 会把正文包一层引号,这里剥掉。"""
    if isinstance(exc, KeyError) and len(exc.args) == 1:
        return str(exc.args[0])
    return str(exc)
