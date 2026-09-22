// 错误码单一事实源(AI 消费面契约)。core 侧分类学见 core/bu_core/errors.py。
// 每个码 = 一种真实原因 + 一个下一步动作:
//   exit      CLI 退出码(0 成功;2 调用可修;4 环境不可达/需外部动作;5 执行失败。3 见 doctor/启动类,无码)
//   retryable 值得重试(引用类状态过期也是 true,前提是按 next 先刷新状态)
//   zh / next 面向读者的含义与下一步(供技能文档与契约测试使用,不由 CLI 打印)
export const ERROR_CODES = {
  INVALID_ARG: { exit: 2, retryable: false, zh: "调用参数或命令写错(格式、枚举、JSON 解析、自相矛盾的参数)",
    next: "按正文改正调用后重试,不要原样重试" },
  NOT_FOUND: { exit: 2, retryable: false, zh: "引用的本地产物或对象不存在(快照文件、扩展 id、页面)",
    next: "先创建或列举(如 take_heapsnapshot / list_extensions),再用有效引用重试" },
  UNSUPPORTED: { exit: 2, retryable: false, zh: "本 build 或该浏览器有意不做该操作(不是功能没做)",
    next: "改用正文给出的替代方式,不要重试" },
  PAGE_BLOCKED: { exit: 2, retryable: false, zh: "页面被模态弹窗阻塞,当前调用无法完成",
    next: "先 handle_dialog 处理弹窗,再重试原调用" },
  STATE_EXPIRED: { exit: 5, retryable: true, zh: "引用的页面状态已过期(uid / msgid / reqid / 快照 / 选中页)",
    next: "重新 take_snapshot 或 list,用新 id 重试(页面重渲染后浏览器会作废旧引用,错误正文里的 CDP 原文即该引用已失效)" },
  PAGE_ERROR: { exit: 5, retryable: false, zh: "页面侧脚本或工具执行失败(页面报错原文附在正文)",
    next: "按正文判断改调用还是换目标;不要原样重试" },
  TIMEOUT: { exit: 5, retryable: true, zh: "本次调用的预算用尽(工具自身的等待预算)",
    next: "加大 --timeout 或换更明确的等待条件后重试" },
  CORE_TIMEOUT: { exit: 5, retryable: true, zh: "core 未在预算内返回(工具自身预算已含传输余量,说明 core 卡住了)",
    next: "重试一次;仍出现说明 core 卡在浏览器调用上,加大 --timeout 并报告用户" },
  INTERNAL: { exit: 5, retryable: false, zh: "内部条件不满足或未归因的失败",
    next: "按正文提示处理;不要原样重试,必要时报告用户并附会话日志" },
  BRIDGE_NOT_CONNECTED: { exit: 4, retryable: false, zh: "登录态桥未连接(日常浏览器未开或扩展未连)",
    next: "请用户打开日常浏览器并确认扩展 popup 已连接;或改 session.bare" },
  BRIDGE_TIMEOUT: { exit: 4, retryable: true, zh: "桥等待超时",
    next: "确认日常浏览器与扩展在线后重试" },
  BROWSER_NOT_RUNNING: { exit: 4, retryable: false, zh: "会话浏览器或其调试端口不可达",
    next: "确认会话浏览器仍在;必要时先 new_page 或新建会话" },
  PIPE_UNAVAILABLE: { exit: 4, retryable: false, zh: "pipe 通道不可用(该会话不是 pipe 启动)",
    next: "改用不受该域限制的通道,或用 pipe 形态重开会话" },
  PORT_EXHAUSTED: { exit: 4, retryable: false, zh: "调试端口段已用尽",
    next: "清理孤儿会话(sessions clean)后重试" },
  SESSION_NOT_FOUND: { exit: 4, retryable: false, zh: "会话不存在或未就绪",
    next: "start 新会话,或用 sessions list 核对 id" },
  CORE_DEAD: { exit: 4, retryable: false, zh: "会话 core 进程已退出",
    next: "新建会话;必要时查 ~/.browser-use/daemon.log" },
  CDP_ERROR: { exit: 4, retryable: false, zh: "浏览器调试协议层调用失败",
    next: "确认会话仍存活(select_page 或新会话);不要原样重试" },
};

export function exitCodeFor(code) {
  return ERROR_CODES[code]?.exit ?? ERROR_CODES.INTERNAL.exit;
}
