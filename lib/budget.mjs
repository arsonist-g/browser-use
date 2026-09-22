// 超时预算阶梯:工具级预算 < daemon→core 传输预算 < CLI→daemon 传输预算(单一事实源)。
// 三级必须严格递增。任何一级先到点,core 给出的真原因(TIMEOUT / STATE_EXPIRED ...)都会被
// 传输层抢走,AI 拿到"传输超时,重试"——指向错原因且重试无效(实测:wait_for 默认 30s 预算,
// 传输层同为 30s,两者竞速由传输层赢下,报 CORE_TIMEOUT,而真原因是文本没等到)。
export const TRANSPORT_SLACK_MS = 5000;
export const MAX_TOOL_BUDGET_MS = 600000;

/** 工具级预算:调用方给值(--timeout)优先,缺省用 config.tool_default_timeout_ms;封顶 10 分钟。 */
export function toolBudgetMs(requested, fallbackMs) {
  const n = Number(requested);
  const budget = Number.isFinite(n) && n > 0 ? n : fallbackMs;
  return Math.min(budget, MAX_TOOL_BUDGET_MS);
}

/** daemon→core 传输预算:必须晚于工具自己的预算到点,工具才有机会报出自己的失败原因。 */
export const coreCallTimeoutMs = (budgetMs) => budgetMs + TRANSPORT_SLACK_MS;

/** CLI→daemon 传输预算:再晚一层(daemon 拿到 core 结果后再经 HTTP 回)。 */
export const cliRpcTimeoutMs = (budgetMs) => budgetMs + 2 * TRANSPORT_SLACK_MS;
