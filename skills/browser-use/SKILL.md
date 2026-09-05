---
name: browser-use
description: Automate login-required or anti-bot-protected sites from the shell via the browser-use CLI. It drives a real headed Edge on this machine, inheriting the user's daily-browser login cookies through session-scoped injection, with no fingerprint overrides. Use it for multi-step web workflows (navigate, snapshot, click, fill), page inspection (screenshots, console, network, performance traces), and interaction on sites where ordinary automation gets detected.
---

# browser-use

`browser-use` automates a real browser from the shell. It launches the machine's own Edge (headed, default fingerprint), injects the login cookies of the user's daily browser into an isolated one-off profile at session start, and drives the page through simple CLI commands covering interaction, navigation, inspection, console, network, performance, memory, and more. Its core avoids the protocol-level signals that anti-bot systems detect, so it keeps working on sites where ordinary automation trips detection.

## Output boundary

This skill covers driving the `browser-use` CLI only. It does not cover:

- Information retrieval (web search, fetching public pages, library docs): use your search/fetch tooling instead. browser-use is for interaction with live pages in a logged-in browser session, not for lightweight reading.
- Fingerprint spoofing: do not ask it to fake a user agent, platform, or language. Those overrides are intentionally disabled (see Red lines).
- Managing the user's daily browser: it never touches the daily Edge profile; it reads cookies from it through a bridge extension and writes nothing back.

## How to read this skill

Imperative sentences are rules you must follow. Code blocks are command examples you can run as written (substitute a real session id for `<id>`). Tables and parenthetical notes are reference. Behavior claims ("returns the new messages only") describe tested behavior; when in doubt, run the command and read its output.

## Sessions: one session per task, `--session=<id>` on every command

1. **Start**: `browser-use start` (add `--headless` for background work). It injects login cookies and launches an isolated Edge, then prints `session=<id>`. **Read that id** and pass it on every later command. You cannot choose it. Each session is a separate Edge instance, so concurrent AI windows never share a browser.
2. **Work**: run tools against the session (see AI workflow).
3. **Stop**: when done, `browser-use stop --session=<id>`. It closes the Edge and deletes the session's data entirely — the one-off profile, artifacts (screenshots, traces, snapshots), and the session record. Nothing is kept after stop; save anything you need out of the session before stopping. Always stop your sessions; do not leave browsers running behind you.

`browser-use sessions list` shows live sessions; `browser-use sessions clean` reaps orphans. `browser-use status` shows daemon, bridge, and session state.

## Login state

- `start` copies the full cookie jar (including httpOnly) from the user's daily browser at session start. Logged-in sites work with no credential entry.
- If injection succeeds, `start` prints `login=injected`. If the daily browser is closed or the bridge extension is not connected, it prints a login hint instead and still returns a session; decide then: ask the user to open the daily browser, or run `browser-use session.bare --session=<id>` if the task needs no login.
- Multiple sessions share the same cookies, which behaves like a human opening several windows: most platforms treat this as one device, no forced logout.
- Honest limits: a logout or password change inside a session also affects the daily browser's account (same as a human second window); platforms that rotate refresh tokens may kick one side; short-lived login cookies can go stale, in which case start a fresh session.

## AI workflow

```sh
browser-use start                       # read the printed session=<id>
browser-use take_snapshot --session=<id>        # text tree of the page: elements with uid=...
browser-use click --session=<id> "1_5"          # act by uid
browser-use fill --session=<id> "3_2" "hello"   # type text / pick select option
browser-use stop --session=<id>
```

- **Inspect, then act, then re-inspect.** Get element uids from `take_snapshot`; uids go stale after navigation or SPA DOM rebuilds, so when `click`/`fill` errors, re-run `take_snapshot` and use fresh uids.
- **Snapshot scrolling hints**: the snapshot annotates each scrollable container (`scroll=... ↓2.3p` = pages below viewport) and counts off-screen interactive elements (`hint:` lines). Scroll to reveal, then re-snapshot.
- **Incremental capture**: `list_console_messages` and `list_network_requests` return the messages/requests captured **since the previous call** (incremental), each with a stable `msgid`/`reqid`; fetch details with `get_console_message` / `get_network_request`. Call the list tool after the action you care about, not once at the end of a long session, if you need per-step capture.
- **Downloads**: downloaded files land in the session's `downloads/` directory (they are deleted by `stop` — move files you need out before stopping). To grab a download URL: navigating to the direct link (or clicking a download button) triggers the download; the request shows up in `list_network_requests` when entered via a **direct-link navigation** (its body is `null` — the download stream is not a page response). Requests fired by a **click on a download button** bypass the page's Network events entirely (browser-level download channel) — verify success by the file appearing on disk, not by the request list.

## Command usage

```sh
browser-use <tool> --session=<id> [required positionals] [--optional-flags]
```

- Required tool args are **positional** (no flag name); optional args use `--flag value`. Example: `browser-use fill --session=<id> <uid> <value>`.
- **Look up a tool's full parameters before guessing**: `browser-use help <tool>` (or `browser-use <tool> --help`) prints that tool's description, positional args, and every optional flag. `browser-use help` lists all tools grouped by purpose.
- `--session=<id>` is consumed by the CLI itself, never forwarded to the tool.
- Global flags: `--output-format=json` (machine-readable output for every command; default is human/markdown text) and `--timeout <ms>` (per-call tool timeout).
- Tool commands are rejected unless the session was started by `browser-use start`.

## Tool surface

| Group | Tools |
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

Plus session commands: `start`, `stop`, `sessions list|clean`, `session.bare`, `status`, `config`, `extension`, `allow`, `doctor`.

The **Tool reference** section at the end of this file maps every tool to its parameters and command-specific notes; `browser-use help <tool>` prints the full per-parameter reference (types, accepted values, defaults) at runtime.

## Errors and retry

- **Exit codes**: 0 success; 2 usage error (missing `--session`, unknown tool); 3 environment error (`doctor`); 4 bridge/precondition unreachable; 5 tool execution failure. Errors also print an `error[CODE]: message` line on stderr; with `--output-format=json` the error arrives as JSON on stdout.
- **Argument errors, unknown flags, wrong arg order**: do not guess. Run `browser-use help <tool>` for that tool's exact signature, fix the command, retry.
- **uid stale** (`click`/`fill` misses after navigation or SPA re-render): re-run `take_snapshot`, act on fresh uids.
- **`BRIDGE_NOT_CONNECTED` / `BRIDGE_TIMEOUT`** (at start, or a tool needs login state): the daily browser may be closed or the bridge extension disconnected. Ask the user to open the daily browser and check the extension popup shows connected, then retry; or run `browser-use session.bare --session=<id>` when the task needs no login.
- **`No open dialog found`** from `handle_dialog`: nothing is blocking; dialogs block page scripts until handled, so handle them promptly when a page freezes.
- **`Request not found for selected page`**: the `msgid`/`reqid` is unknown or from before this session; list again and use a fresh id.
- **`NOT_IMPLEMENTED`**: the tool exists in the surface but this install lacks its runtime (for example lighthouse needs the Lighthouse CLI via npx). Do not retry.
- `browser-use doctor [--fix]` checks node, python, the DrissionPage core, and Edge, and auto-installs what it can.

## Red lines

- **No fingerprint overrides.** User agent, platform, and language overrides are deliberately disabled; `emulate` refuses them. Anti-bot systems cross-check these against TLS and behavioral signals, and a mismatch is itself a detection signal. Do not work around this.
- **Stay on the machine's real Edge.** Do not point `--browser-exe` at another browser and expect the same anti-detection behavior.
- **One task, one session.** Start, work, `stop`. Sessions hold a full copy of the user's cookies: do not hand session ids between tasks, and stop them as soon as the task ends.


<!-- Tool reference: hand-maintained; kept in sync with browser-use help <tool> by test/unit/tool-help.test.mjs. -->

## Tool reference

Every tool command requires `--session=<id>` (the id printed by `start`). The signature column shows how each parameter is passed, in order: `<uid>` = required **positional** argument, `[url]` = optional positional, `--flag` = optional flag, `--filePath*` = required flag. Every tool also accepts `--output-format=json` (machine-readable output) and `--timeout <ms>` (call timeout). The tables below list parameter names and command-specific notes only; run `browser-use help <tool>` for the full per-parameter reference at runtime.

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

| Tool | Description | Signature | Notes |
|---|---|---|---|
| `click` | Clicks on the provided element. | `<uid>` `--dblClick` `--includeSnapshot` | |
| `click_at` | Clicks at page coordinates. | `<x>` `<y>` `--dblClick` | |
| `drag` | Drags one element onto another. | `<from_uid>` `<to_uid>` `--includeSnapshot` | |
| `fill` | Types text into an input, or selects an option. | `<uid>` `<value>` `--includeSnapshot` | Missing select options are an error, not a silent no-op. |
| `fill_form` | Fills multiple form elements at once. | `--elements*` `--includeSnapshot` | `elements`: JSON array of `{"uid":"1_5","value":"a"}` |
| `handle_dialog` | Handles a browser dialog. | `<action>` `--promptText` | A pending dialog blocks page scripts; no pending dialog errors. |
| `hover` | Hovers over an element. | `<uid>` `--includeSnapshot` | |
| `press_key` | Presses a key or key combination. | `<key>` `--includeSnapshot` | |
| `scroll` | Scrolls the page or a container. | `--direction` `--amount` `--uid` `--includeSnapshot` | Defaults: down 600px. |
| `type_text` | Types into the focused input. | `<text>` `--submitKey` | |
| `upload_file` | Uploads a file through an element. | `<uid>` `<filePaths>` `--includeSnapshot` | One absolute path per call. |

### Navigation automation (6 tools)

| Tool | Description | Signature | Notes |
|---|---|---|---|
| `close_page` | Closes a page. | `<page_id>` | The last open page cannot be closed. |
| `list_pages` | Lists open pages. | | |
| `navigate_page` | Navigates: URL, back, forward, reload. | `[url]` `--type` `--ignoreCache` `--timeout` `--initScript` `--handleBeforeUnload` | `url` applies only to `--type url` (the default). Default URL budget is 20 s (`--timeout` overrides); slow pages return an "Unable to navigate" message rather than hanging. |
| `new_page` | Opens a new tab. | `<url>` `--background` `--isolatedContext` `--timeout` | Returns the new page id. |
| `select_page` | Selects the page for future tool calls. | `<page_id>` `--bringToFront` | |
| `wait_for` | Waits for text to appear. | `<text>` `--timeout` | Searches the main document and all frames. |

### Emulation (2 tools)

| Tool | Description | Signature | Notes |
|---|---|---|---|
| `emulate` | Emulates network, CPU, geolocation, headers, color scheme. | `--networkConditions` `--cpuThrottlingRate` `--geolocation` `--extraHttpHeaders` `--colorScheme` | User agent, viewport, platform, and language overrides are unsupported (red line). |
| `resize_page` | Resizes the window. | `<width>` `<height>` | |

### Performance (3 tools)

| Tool | Description | Signature | Notes |
|---|---|---|---|
| `performance_start_trace` | Starts a performance trace. | `--reload` `--autoStop` `--filePath` | One trace at a time; defaults: reload true, autoStop true. |
| `performance_stop_trace` | Stops the trace. | `--filePath` | No-op when not recording. |
| `performance_analyze_insight` | Explains one Performance Insight. | `<insightName>` `<insightSetId>` `--filePath` | |

### Network (2 tools)

| Tool | Description | Signature | Notes |
|---|---|---|---|
| `get_network_request` | Gets one request with body. | `<reqid>` `--requestFilePath` `--responseFilePath` | Optional file paths save the request/response body to disk instead of returning it inline. |
| `list_network_requests` | Lists network requests. | `--resourceTypes` `--includePreservedRequests` | Returns requests since the previous call. |

### Debugging (9 tools)

| Tool | Description | Signature | Notes |
|---|---|---|---|
| `evaluate_script` | Evaluates a JS function in the page. | `<function>` `--args` `--dialogAction` `--filePath` `--waitForStableDom` | Return value must be JSON-serializable; async functions supported. |
| `get_console_message` | Gets one console message. | `<msgid>` | |
| `lighthouse_audit` | Runs a Lighthouse audit. | `--mode` `--device` `--onlyCategories` `--outputDirPath` | Navigation mode only; the first run pulls the CLI via npx and is slow. |
| `list_console_messages` | Lists console messages. | `--types` `--includeStackTraces` `--includePreservedMessages` `--pageSize` `--pageIdx` | Returns messages since the previous call; console API calls only, uncaught exceptions are not captured. |
| `screencast_collect` | Counts captured frames. | | While recording. |
| `screencast_start` | Starts recording frames. | | Outputs PNG frames, not video. |
| `screencast_stop` | Stops recording. | | Returns stopped=false when not recording. |
| `take_screenshot` | Takes a screenshot. | `--filePath` `--format` `--quality` `--fullPage` `--uid` | `fullPage` and `--uid` are mutually exclusive. |
| `take_snapshot` | Takes a text snapshot with uids. | `--filePath` `--verbose` | Always use the latest snapshot; also annotates scrollable containers. |

### Memory (13 tools)

All memory tools address snapshots by their `.heapsnapshot` file path.

| Tool | Description | Signature | Notes |
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

| Tool | Description | Signature | Notes |
|---|---|---|---|
| `execute_3p_developer_tool` | Executes a page-exposed tool. | `<toolName>` `--params` | |
| `list_3p_developer_tools` | Lists page-exposed tools. | | |

### WebMCP (2 tools)

| Tool | Description | Signature | Notes |
|---|---|---|---|
| `execute_webmcp_tool` | Executes a page-exposed WebMCP tool. | `<toolName>` `--input` | Session must start with `--extra-flags '["--enable-features=WebMCP"]'`. |
| `list_webmcp_tools` | Lists page-exposed WebMCP tools. | | Same session requirement. |

### PWA (4 tools)

| Tool | Description | Signature | Notes |
|---|---|---|---|
| `get_os_app_state` | Reads an installed app's manifest state. | `<manifestId>` | |
| `install_pwa` | Installs a PWA as an OS app. | `<manifestId>` `<installUrlOrBundleUrl>` `--displayMode` | |
| `launch_pwa` | Launches an installed PWA. | `<manifestId>` | |
| `uninstall_pwa` | Uninstalls a PWA. | `<manifestId>` | |

### Extensions (5 tools)

| Tool | Description | Signature | Notes |
|---|---|---|---|
| `install_extension` | Installs an unpacked extension. | `<path>` | Session-scoped; the daily browser is untouched. |
| `list_extensions` | Lists session extensions. | | |
| `reload_extension` | Reloads an extension. | `<id>` | |
| `trigger_extension_action` | Triggers the extension's default action. | `<id>` | |
| `uninstall_extension` | Uninstalls an extension. | `<id>` | |

### Session commands

| Command | Parameters | Notes |
|---|---|---|
| `start` | `--headless` `--browser-exe` `--extra-flags` | The only command without `--session`; prints `session=<id>`. |
| `stop` | `--session=<id>` | Closes the browser and deletes the session directory entirely (profile, artifacts, logs). |
| `sessions list` / `sessions clean` | `[--state=<s>]` | `clean` reaps non-live sessions and deletes their data entirely. |
| `session.bare` | `--session=<id>` | Skips login-state injection. |
| `status` | | Daemon, bridge, and session state. |
| `config get/set/list/reset` | | |
| `extension` | | Prints the bridge extension directory. |
| `skill list/install/uninstall` | `--agent=<key>` `--all` `--force` `--dry-run` | Installs this skill into coding agents. |
| `allow` | `--agent=<key>` `--all` `--remove` `--dry-run` | Pre-approves `browser-use` commands in coding agents (approval allowlists), so agent sessions stop asking per command. Default agent `claude-code`; agents whose config isn't detected (e.g. no Windsurf install) are skipped with a hint. |
| `doctor` | `[--fix]` | Checks node, python, core, and Edge. |
