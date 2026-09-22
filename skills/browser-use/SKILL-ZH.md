---
name: browser-use
description: 通过 browser-use CLI 自动化需要登录态或受反爬检测保护的站点。它驱动本机真实的 Edge(有头),通过会话制注入继承用户日常浏览器的登录 cookie,不做任何指纹覆盖。适用于多步网页工作流(导航、快照、点击、填写)、页面检查(截图、console、network、性能追踪),以及在普通自动化会被检测到的站点上执行交互。
---

<!-- 本文件是英文版译文,供人工校对;同目录的 SKILL.md(英文)是生效版本,两者逐句对应。 -->

# browser-use

`browser-use` 从 shell 操控真实浏览器。它启动本机自己的 Edge(有头、默认指纹),在会话启动时把用户日常浏览器的登录 cookie 注入一个一次性的隔离 profile,并以简单 CLI 命令驱动页面,覆盖交互、导航、检查、console、network、性能、内存等。其内核避开反爬系统能检测的协议级信号,因此在普通自动化会被检测的站点上仍可工作。

## Output boundary

本 skill 只覆盖 `browser-use` CLI 的使用。它不覆盖:

- 信息检索(网页搜索、抓公开页面、查库文档):请改用你的搜索/抓取工具。browser-use 面向已登录浏览器会话中的实时页面交互,不是轻量阅读工具。
- 指纹伪装:不要要求它伪造 user agent、平台或语言。这些覆盖被有意禁用(见 Red lines)。
- 管理用户的日常浏览器:它从不写入日常 Edge 的 profile;只通过桥扩展读取 cookie,不回写。

## How to read this skill

祈使句是你必须遵守的规则。代码块是可原样执行的命令示例(把 `<id>` 换成真实会话 id)。表格和括号注记是参考资料。行为描述("只返回新捕获的消息")陈述的是经过测试的行为;有疑问时,直接运行命令看输出。

## Sessions:一个任务一个会话,每条命令都带 `--session=<id>`

1. **启动**:`browser-use start`。它注入登录 cookie 并启动一个隔离的 Edge(始终有头——无头启动已禁用,见 Red lines),然后打印 `session=<id>`。**记住这个 id**,之后每条命令都带上。你不能自选 id。每个会话是独立的 Edge 实例,并发的 AI 窗口永不共享浏览器。
2. **工作**:对会话执行工具调用(见 AI workflow)。
3. **停止**:任务完成时 `browser-use stop --session=<id>`。它关闭 Edge 并完整删除该会话的数据——一次性 profile、artifacts(截图/trace/快照)与会话记录,一律不留;需要在会话外保留的内容先取走。必须停止你的会话;不要留下后台浏览器。

`browser-use sessions list` 列出存活会话;`browser-use sessions clean` 回收孤儿。`browser-use status` 显示 daemon、桥与会话状态。

## 登录态

- `start` 在会话启动时从用户日常浏览器复制全量 cookie(含 httpOnly)。已登录站点无需输入凭证即可访问。
- 注入成功时 `start` 打印 `login=injected`。日常浏览器未开或桥扩展未连接时,它打印登录提示并照常返回会话;此时你自行裁决:请用户打开日常浏览器,或任务不需要登录时运行 `browser-use session.bare --session=<id>`。
- 多个会话共享同一套 cookie,行为等同人类开多个窗口:大多数平台视为同一设备,不触发强制下线。
- 诚实边界:会话内的登出/改密操作同样作用于日常浏览器的同账号(与人类开第二个窗口一致);旋转 refresh token 的平台可能互踢一方;短时效登录 cookie 会过期,重开一个新会话即可。

## AI workflow

```sh
browser-use start                       # 读到打印的 session=<id>
browser-use take_snapshot --session=<id>        # 页面文本树:元素带 uid=...
browser-use click --session=<id> "1_5"          # 按 uid 操作
browser-use fill --session=<id> "3_2" "hello"   # 输入文本 / 选中 select 选项
browser-use stop --session=<id>
```

- **先检查,再操作,再复查。** 元素 uid 来自 `take_snapshot`;uid 在页面导航或 SPA DOM 重建后失效,所以 `click`/`fill` 报错时,重新 `take_snapshot` 并使用新 uid。
- **快照滚动标注**:快照为每个可滚动容器标注(`scroll=... ↓2.3p` 表示视口下方还有 2.3 页)并统计视口外可交互元素(`hint:` 行)。先滚动呈现,再重新快照。
- **增量捕获**:`list_console_messages` 和 `list_network_requests` 返回自上次调用以来**新捕获**的消息/请求,各带稳定的 `msgid`/`reqid`;用 `get_console_message` / `get_network_request` 取详情。需要按步骤捕获时,在关键动作之后调用 list 工具,而不要拖到长会话的最后一次性调用。
- **浏览器内建页**:浏览器有时会自己打开 UI 页(`edge://…`,例如下载后的下载中心)。它们会出现在 `list_pages` 里,但不会自动成为当前页 —— 工具调用仍在你的任务页上工作,并有一行一次性 `notice: Browser-internal page opened …` 说明浏览器打开了什么。忽略即可。

## Command usage

```sh
browser-use <tool> --session=<id> [必需位置参数] [--可选flags]
```

- 工具必需参数走**位置传参**(不带 flag 名);可选参数用 `--flag value`。例:`browser-use fill --session=<id> <uid> <value>`。
- **不要猜参数**:用 `browser-use help <tool>`(或 `browser-use <tool> --help`)查看该工具的说明、位置参数与全部可选 flags;`browser-use help` 按用途分组列出所有工具。
- `--session=<id>` 由 CLI 自身消费,不会转发给工具。
- 全局 flags:`--output-format=json`(每条命令的机器可读输出;默认是人读/markdown 文本)和 `--timeout <ms>`(单次工具调用超时)。
- 会话不是由 `browser-use start` 启动时,工具命令会被拒绝。

## Tool surface

| 分组 | 工具 |
|---|---|
| Input automation | click, click_at, drag, fill, fill_form, handle_dialog, hover, press_key, scroll, type_text, upload_file |
| Navigation automation | close_page, list_pages, navigate_page, new_page, select_page, wait_for |
| Emulation | emulate, resize_page |
| Performance | performance_analyze_insight, performance_start_trace, performance_stop_trace |
| Network | get_network_request, list_network_requests |
| Debugging | evaluate_script, get_console_message, lighthouse_audit, list_console_messages, screencast_collect, screencast_start, screencast_stop, take_screenshot, take_snapshot |
| Memory | close_heapsnapshot, compare_heapsnapshots, get_heapsnapshot_class_nodes, get_heapsnapshot_details, get_heapsnapshot_dominators, get_heapsnapshot_duplicate_strings, get_heapsnapshot_edges, get_heapsnapshot_object_details, get_heapsnapshot_retainers, get_heapsnapshot_retaining_paths, get_heapsnapshot_summary, query_heapsnapshot_objects, take_heapsnapshot |
| Third-party | execute_3p_developer_tool, list_3p_developer_tools |
| WebMCP | execute_webmcp_tool, list_webmcp_tools |
| PWA | get_os_app_state, install_pwa, launch_pwa, uninstall_pwa |
| Extensions | install_extension, list_extensions, reload_extension, trigger_extension_action, uninstall_extension |

另有会话命令:`start`、`stop`、`sessions list|clean`、`session.bare`、`status`、`config`、`extension`、`doctor`。

文末的 **Tool reference** 参考节列出每个工具的参数与命令级备注;运行时用 `browser-use help <tool>` 查看逐参数完整参考(类型、取值、默认值)。

## Errors and retry

每条失败都在 stderr 打 `error[CODE]: message`;`--output-format=json` 时以 `{error:{code,message,retryable}}` 走 stdout。码指向真原因,正文给出下一步动作。

| 码 | 含义 | 下一步 | 可重试 | 退出码 |
| --- | --- | --- | --- | --- |
| `INVALID_ARG` | 调用本身写错:取值不合法、未知 flag、JSON 解析失败、工具名不存在 | 改正调用;`browser-use help <tool>` 给准确签名 | 否 | 2 |
| `NOT_FOUND` | 引用的本地产物/对象不存在(快照文件、扩展 id、页面) | 先创建或列举,再用有效引用重试 | 否 | 2 |
| `UNSUPPORTED` | 本 build 或该浏览器有意不做该操作 | 改用正文给出的替代方式 | 否 | 2 |
| `PAGE_BLOCKED` | 模态弹窗阻塞页面 | 先 `handle_dialog`,再重试原调用 | 否 | 2 |
| `STATE_EXPIRED` | 引用的状态已过期:uid、msgid、reqid、快照、选中页(页面重渲染后浏览器作废旧引用,正文里的协议原文即该引用已失效) | 重新 `take_snapshot` / `list_network_requests` / `select_page`,用新 id 操作 | 是(先刷新) | 5 |
| `PAGE_ERROR` | 页面侧脚本或工具抛错(页面报错原文附在正文) | 读正文:改调用或换目标 | 否 | 5 |
| `TIMEOUT` | 本次调用自身预算用尽 | 加大 `--timeout`,或等更明确的条件 | 是 | 5 |
| `CORE_TIMEOUT` | core 未在预算内返回(工具自身预算已含传输余量,说明 core 卡住了) | 重试一次;仍出现则说明 core 卡在浏览器调用上,加大 `--timeout` 并告知用户 | 是 | 5 |
| `INTERNAL` | 内部条件不满足或未归因 | 按正文处理;不要原样重试,反复出现则报告用户并附会话日志 | 否 | 5 |
| `CDP_ERROR` | 浏览器调试协议层调用失败 | 确认会话仍存活(`select_page` 或新会话) | 否 | 4 |
| `BROWSER_NOT_RUNNING` | 会话浏览器或其调试端口不可达 | 确认浏览器仍在;`new_page` 或新建会话 | 否 | 4 |
| `PIPE_UNAVAILABLE` | 该会话的 pipe 通道不可用 | 改用该域允许的通道,或用 pipe 形态重开会话 | 否 | 4 |
| `PORT_EXHAUSTED` | 调试端口段用尽 | `sessions clean` 后重试 | 否 | 4 |
| `SESSION_NOT_FOUND` | 会话不存在或未就绪 | `start` 新会话,或 `sessions list` 核对 | 否 | 4 |
| `CORE_DEAD` | 会话 core 进程已退出 | 新建会话;反复出现查 `~/.browser-use/daemon.log` | 否 | 4 |
| `BRIDGE_NOT_CONNECTED` | 登录态桥未连接(日常浏览器未开或扩展未连) | 请用户打开日常浏览器并确认扩展 popup 已连接;或 `session.bare` | 否 | 4 |
| `BRIDGE_TIMEOUT` | 桥未及时应答 | 确认日常浏览器与扩展在线后重试 | 是 | 4 |

退出码:`0` 成功;`2` 调用可修;`4` 环境不可达或需外部动作;`5` 执行失败。`3` 保留给环境自检(`doctor`)与 daemon 启动类,这类正文不带码。

- **参数错误、未知 flags、参数顺序不对**:不要猜。运行 `browser-use help <tool>` 核对该工具的准确签名,修正命令后重试。
- **工具名不存在**(退出码 2,`error[INVALID_ARG]: 未知工具: <name>`):名字不在文档化的工具清单里。拼写错误在本地就被拦下(不会转发到 core),并随后列出最接近的工具名。`browser-use help` 列出全部工具名;不要用同一个拼法重试。
- **`No open dialog found`**(`handle_dialog` 返回,码为 `INVALID_ARG`):当前没有弹窗;弹窗会阻塞页面脚本直至被处理,页面卡住时及时处理。
- `browser-use doctor [--fix]` 检查 node、python、DrissionPage 内核与 Edge,能自动装的就地补齐。

## Red lines

- **不做指纹覆盖。** user agent、平台、语言覆盖被有意禁用;`emulate` 会拒绝这些参数。反爬系统会将它们与 TLS 及行为信号交叉验证,不一致本身就是检测信号。不要绕过。
- **留在本机真实 Edge 上。** 不要用 `--browser-exe` 指向别的浏览器并期待同样的反检测行为。
- **只允许有头启动。** 不要寻找让浏览器无头运行的办法:`--headless` 参数已移除,CLI 会直接拒绝。无头形态从未做过反爬验证,而无头反爬难度远高于有头,因此无头会话不受支持,也不是更省事的选项。
- **一个任务一个会话。** start、工作、`stop`。会话持有用户 cookie 的完整副本:不要跨任务传递会话 id,任务结束立即停止。


<!-- 本参考节为英文,与英文版逐字一致(工具名/参数为技术标识);由 test/unit/tool-help.test.mjs 与 browser-use help <tool> 保持同步。 -->

## Tool reference

Every tool command requires `--session=<id>` (the id printed by `start`). Required parameters are passed **positionally**, in the order shown, marked with `*`; optional parameters use `--name value`. Every tool also accepts `--output-format=json` (machine-readable output) and `--timeout <ms>` (call timeout). The tables below list parameter names and command-specific notes only; run `browser-use help <tool>` for the full per-parameter reference at runtime.

### Shared parameters

| Parameter | Meaning |
|---|---|
| `--session=<id>` | Session id printed by `start`; required on every tool command |
| `uid` | Element id from the latest `take_snapshot`; goes stale after navigation or DOM rebuilds |
| `--includeSnapshot` | Include a fresh snapshot in the response (default false) |
| `--dblClick` | Double click (default false) |
| `--timeout` | Maximum wait time in ms |
| `--filePath` | File path: save output (screenshot/snapshot/trace), or the `.heapsnapshot` to load (memory tools) |
| `--pageSize` / `--pageIdx` | Pagination, 0-based |
| `--sortBy` | Sort key, values shown per tool |
| `nodeId` | Heap node id (V8 ordinal), from class_nodes or query results |
| `--filterName` | Retention-source filter: `objectsRetainedByDetachedDomNodes`, `objectsRetainedByConsole`, `objectsRetainedByEventHandlers`, `objectsRetainedByContexts` |
| `value` | Fill value; checkboxes and toggles take `"true"`/`"false"`, radio takes `"true"` |
| `text` | The text to wait for or to type |
| `key` | Key or combination, e.g. `"Enter"`, `"Control+A"`; modifiers Control, Shift, Alt, Meta |
| `action` | `"accept"` or `"dismiss"` |
| `direction` | `"down"`, `"up"`, `"left"`, `"right"` (default `"down"`) |
| `url` | Target URL |
| `page_id` | Page id from `list_pages` |
| `toolName` | Page-exposed tool name, from the matching `list_*` tool |
| `manifestId` | PWA manifest id |
| `id` | Extension id (extension tools) or class index from details (class_nodes) |
| `path` | Absolute path to an unpacked extension folder |
| `reqid` | Network request id from `list_network_requests` |
| `msgid` | Console message id from `list_console_messages` |
| `baseFilePath` / `currentFilePath` | Earlier / later `.heapsnapshot` for comparison |
| `classIndex` | 0-based class index in the comparison summary |
| `--className` | Class name; regex or text match |
| `--nodeType` | Heap node type, e.g. object, string, closure |
| `--selfSize` / `--retainedSize` | Size range `"min-max"` in bytes, e.g. `"1024-"` |
| `--isDetached` | true keeps only detached nodes, false excludes them |

### Input automation (11 tools)

| Tool | Description | Parameters | Notes |
|---|---|---|---|
| `click` | Clicks on the provided element. | `uid*` `--dblClick` `--includeSnapshot` | |
| `click_at` | Clicks at page coordinates. | `x*` `y*` `--dblClick` | |
| `drag` | Drags one element onto another. | `from_uid*` `to_uid*` `--includeSnapshot` | |
| `fill` | Types text into an input, or selects an option. | `uid*` `value*` `--includeSnapshot` | Missing select options are an error, not a silent no-op. |
| `fill_form` | Fills multiple form elements at once. | `--elements*` `--includeSnapshot` | `elements`: JSON array of `{"uid":"1_5","value":"a"}` |
| `handle_dialog` | Handles a browser dialog. | `action*` `--promptText` | A pending dialog blocks page scripts; no pending dialog errors. |
| `hover` | Hovers over an element. | `uid*` `--includeSnapshot` | |
| `press_key` | Presses a key or key combination. | `key*` `--includeSnapshot` | |
| `scroll` | Scrolls the page or a container. | `--direction` `--amount` `--uid` `--includeSnapshot` | Defaults: down 600px. |
| `type_text` | Types into the focused input. | `text*` `--submitKey` | |
| `upload_file` | Uploads a file through an element. | `uid*` `filePaths*` `--includeSnapshot` | One absolute path per call. |

### Navigation automation (6 tools)

| Tool | Description | Parameters | Notes |
|---|---|---|---|
| `close_page` | Closes a page. | `page_id*` | The last open page cannot be closed. |
| `list_pages` | Lists open pages. | | |
| `navigate_page` | Navigates: URL, back, forward, reload. | `url` `--type` `--ignoreCache` `--timeout` `--initScript` `--handleBeforeUnload` | `url` applies only to `--type url` (the default). |
| `new_page` | Opens a new tab. | `url*` `--background` `--isolatedContext` `--timeout` | Returns the new page id. `--isolatedContext` 在 port-only 会话下同样可用(该请求走浏览器级通道)。 |
| `select_page` | Selects the page, brings it to the browser foreground, and routes future tool calls there; a later active-tab change takes precedence. | `page_id*` `--bringToFront` | |
| `wait_for` | Waits for text to appear. | `text*` `--timeout` | Searches the main document and all frames. |

### Emulation (2 tools)

| Tool | Description | Parameters | Notes |
|---|---|---|---|
| `emulate` | Emulates network, CPU, geolocation, headers, color scheme. | `--networkConditions` `--cpuThrottlingRate` `--geolocation` `--extraHttpHeaders` `--colorScheme` | User agent, viewport, platform, and language overrides are unsupported (red line). |
| `resize_page` | Resizes the window. | `width*` `height*` | |

### Performance (3 tools)

| Tool | Description | Parameters | Notes |
|---|---|---|---|
| `performance_start_trace` | Starts a performance trace. | `--reload` `--autoStop` `--filePath` | One trace at a time; defaults: reload true, autoStop true. |
| `performance_stop_trace` | Stops the trace. | `--filePath` | No-op when not recording. |
| `performance_analyze_insight` | Explains one Performance Insight. | `insightName*` `insightSetId*` `--filePath` | |

### Network (2 tools)

| Tool | Description | Parameters | Notes |
|---|---|---|---|
| `get_network_request` | Gets one request with body. | `reqid*` | |
| `list_network_requests` | Lists network requests. | `--resourceTypes` `--includePreservedRequests` | Returns requests since the previous call. |

### Debugging (9 tools)

| Tool | Description | Parameters | Notes |
|---|---|---|---|
| `evaluate_script` | Evaluates a JS function in the page. | `function*` `--args` `--dialogAction` `--filePath` `--waitForStableDom` | Return value must be JSON-serializable; async functions supported. |
| `get_console_message` | Gets one console message. | `msgid*` | |
| `lighthouse_audit` | Runs a Lighthouse audit. | `--mode` `--device` `--onlyCategories` `--outputDirPath` | Navigation mode only; the first run pulls the CLI via npx and is slow. |
| `list_console_messages` | Lists console messages. | `--types` `--includeStackTraces` `--includePreservedMessages` `--pageSize` `--pageIdx` | Returns messages since the previous call; console API calls only, uncaught exceptions are not captured. |
| `screencast_collect` | Counts captured frames. | | While recording. |
| `screencast_start` | Starts recording frames. | | Outputs PNG frames, not video. |
| `screencast_stop` | Stops recording. | | Returns stopped=false when not recording. |
| `take_screenshot` | Takes a screenshot. | `--filePath` `--format` `--quality` `--fullPage` `--uid` | `fullPage` and `--uid` are mutually exclusive. |
| `take_snapshot` | Takes a text snapshot with uids. | `--filePath` `--verbose` | Always use the latest snapshot; also annotates scrollable containers. |

### Memory (13 tools)

All memory tools address snapshots by their `.heapsnapshot` file path.

| Tool | Description | Parameters | Notes |
|---|---|---|---|
| `close_heapsnapshot` | Frees a loaded snapshot. | `--filePath*` | |
| `compare_heapsnapshots` | Diffs two snapshots. | `--baseFilePath*` `--currentFilePath*` `--classIndex` | |
| `get_heapsnapshot_class_nodes` | Lists instances of a class. | `--filePath*` `--id*` `--filterName` `--pageSize` `--pageIdx` | |
| `get_heapsnapshot_details` | Returns class aggregates and stats. | `--filePath*` `--filterName` `--pageSize` `--pageIdx` | |
| `get_heapsnapshot_dominators` | Returns a node's dominator chain. | `--filePath*` `--nodeId*` | |
| `get_heapsnapshot_duplicate_strings` | Groups duplicate strings. | `--filePath*` `--pageSize` `--pageIdx` | |
| `get_heapsnapshot_edges` | Returns a node's outgoing references. | `--filePath*` `--nodeId*` `--sortBy` `--excludePrimitives` | |
| `get_heapsnapshot_object_details` | Returns one object's properties and in-edges. | `--filePath*` `--nodeId*` | |
| `get_heapsnapshot_retainers` | Returns what references a node. | `--filePath*` `--nodeId*` `--pageSize` `--pageIdx` | |
| `get_heapsnapshot_retaining_paths` | Returns paths from a node to GC roots. | `--filePath*` `--nodeId*` `--maxDepth` `--maxNodes` `--maxSiblings` | |
| `get_heapsnapshot_summary` | Returns snapshot summary statistics. | `--filePath*` | |
| `query_heapsnapshot_objects` | Queries objects by filters. | `--filePath*` `--className` `--nodeType` `--selfSize` `--retainedSize` `--isDetached` `--sortBy` `--pageSize` `--pageIdx` | |
| `take_heapsnapshot` | Captures a heap snapshot. | `--filePath` | |

### Third-party (2 tools)

| Tool | Description | Parameters | Notes |
|---|---|---|---|
| `execute_3p_developer_tool` | Executes a page-exposed tool. | `toolName*` `--params` | |
| `list_3p_developer_tools` | Lists page-exposed tools. | | |

### WebMCP (2 tools)

| Tool | Description | Parameters | Notes |
|---|---|---|---|
| `execute_webmcp_tool` | Executes a page-exposed WebMCP tool. | `toolName*` `--input` | Session must start with `--extra-flags '["--enable-features=WebMCP"]'`. |
| `list_webmcp_tools` | Lists page-exposed WebMCP tools. | | Same session requirement. |

### PWA (4 tools)

只有这四个工具需要调试 pipe。port-only 会话下它们报 `PIPE_UNAVAILABLE`(退出码 4),其余一切照常:Extensions 工具、`new_page --isolatedContext` 与所有页面级工具都可用。

| Tool | Description | Parameters | Notes |
|---|---|---|---|
| `get_os_app_state` | Reads an installed app's manifest state. | `manifestId*` | |
| `install_pwa` | Installs a PWA as an OS app. | `manifestId*` `installUrlOrBundleUrl*` `--displayMode` | |
| `launch_pwa` | Launches an installed PWA. | `manifestId*` | |
| `uninstall_pwa` | Uninstalls a PWA. | `manifestId*` | |

### Extensions (5 tools)

| Tool | Description | Parameters | Notes |
|---|---|---|---|
| `install_extension` | Installs an unpacked extension. | `path*` | Session-scoped; the daily browser is untouched. |
| `list_extensions` | Lists session extensions. | | |
| `reload_extension` | Reloads an extension. | `id*` | |
| `trigger_extension_action` | Triggers the extension's default action. | `id*` | |
| `uninstall_extension` | Uninstalls an extension. | `id*` | |

### Session commands

| Command | Parameters | Notes |
|---|---|---|
| `start` | `--browser-exe` `--extra-flags` | The only command without `--session`; prints `session=<id>`. Always headed: `--headless` was removed and is rejected. |
| `stop` | `--session=<id>` | Closes the browser and deletes the session directory entirely (profile, artifacts, logs). |
| `sessions list` / `sessions clean` | `[--state=<s>]` | `clean` reaps orphaned sessions. |
| `session.bare` | `--session=<id>` | Skips login-state injection. |
| `status` | | Daemon, bridge, and session state. |
| `config get/set/list/reset` | | |
| `extension` | | Prints the bridge extension directory. |
| `skill list/install/uninstall` | `--agent=<key>` `--all` `--force` `--dry-run` | Installs this skill into coding agents. |
| `allow` | `--agent=<key>` `--all` `--remove` `--dry-run` | Pre-approves `browser-use` commands in coding agents (approval allowlists), so agent sessions stop asking per command. Default agent `claude-code`; agents whose config isn't detected (e.g. no Windsurf install) are skipped with a hint. |
| `doctor` | `[--fix]` | Checks node, python, core, and Edge. |
