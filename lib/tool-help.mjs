// 工具参考(单一事实源):browser-use help 与 SKILL.md 的生成区段
// (scripts/gen-tool-reference.mjs)都从这里渲染。全英文输出(控制台兼容)。
// 格式对齐 chrome-devtools-mcp 的 tool-reference.md;参数面与行为以 core 实现为准,
// 与上游的差异(增量捕获语义、禁用的指纹覆盖、lighthouse 仅 navigation 等)如实书写。
// 参数条目: name, pos(位置传参), req(必填), type, enum(取值), def(默认值), desc
export const TOOL_REFERENCE = {
  // ---- Input automation ----
  click: { group: "Input automation", desc: "Clicks on the provided element.", args: [
    { name: "uid", pos: true, req: true, type: "string", desc: "The uid of an element on the page from the page content snapshot" },
    { name: "dblClick", type: "boolean", def: "false", desc: "Set to true for double clicks." },
    { name: "includeSnapshot", type: "boolean", def: "false", desc: "Whether to include a snapshot in the response." },
  ]},
  click_at: { group: "Input automation", desc: "Clicks at the provided coordinates.", args: [
    { name: "x", pos: true, req: true, type: "number", desc: "The x coordinate" },
    { name: "y", pos: true, req: true, type: "number", desc: "The y coordinate" },
    { name: "dblClick", type: "boolean", def: "false", desc: "Set to true for double clicks." },
  ]},
  drag: { group: "Input automation", desc: "Drags an element onto another element.", args: [
    { name: "from_uid", pos: true, req: true, type: "string", desc: "The uid of the element to drag" },
    { name: "to_uid", pos: true, req: true, type: "string", desc: "The uid of the element to drop into" },
    { name: "includeSnapshot", type: "boolean", def: "false", desc: "Whether to include a snapshot in the response." },
  ]},
  fill: { group: "Input automation", desc: "Types text into an input or text area, or selects an option from a <select> element.", args: [
    { name: "uid", pos: true, req: true, type: "string", desc: "The uid of an element on the page from the page content snapshot" },
    { name: "value", pos: true, req: true, type: "string", desc: "The value to fill in. \"true\" or \"false\" for checkboxes and toggles, \"true\" for radio buttons. Select options are matched by value or visible text; a missing option is an error." },
    { name: "includeSnapshot", type: "boolean", def: "false", desc: "Whether to include a snapshot in the response." },
  ]},
  fill_form: { group: "Input automation", desc: "Fills out multiple form elements (inputs, selects, checkboxes, radios) at once. Prefer this tool over multiple individual fill or click calls when interacting with forms.", args: [
    { name: "elements", req: true, type: "array (JSON)", desc: "Elements from the snapshot to fill out, e.g. [{\"uid\":\"1_5\",\"value\":\"user\"},{\"uid\":\"1_6\",\"value\":\"secret\"}]" },
    { name: "includeSnapshot", type: "boolean", def: "false", desc: "Whether to include a snapshot in the response." },
  ]},
  handle_dialog: { group: "Input automation", desc: "Handles a browser dialog (alert, confirm, prompt). A pending dialog blocks page scripts, so handle it before continuing.", args: [
    { name: "action", pos: true, req: true, type: "enum", enum: "\"accept\" | \"dismiss\"", desc: "Whether to dismiss or accept the dialog" },
    { name: "promptText", type: "string", desc: "Optional prompt text to enter into the dialog." },
  ]},
  hover: { group: "Input automation", desc: "Hovers over the provided element.", args: [
    { name: "uid", pos: true, req: true, type: "string", desc: "The uid of an element on the page from the page content snapshot" },
    { name: "includeSnapshot", type: "boolean", def: "false", desc: "Whether to include a snapshot in the response." },
  ]},
  press_key: { group: "Input automation", desc: "Presses a key or key combination. Use this when fill cannot be used (keyboard shortcuts, navigation keys, special combinations).", args: [
    { name: "key", pos: true, req: true, type: "string", desc: "A key or a combination (e.g. \"Enter\", \"Control+A\", \"Control+Shift+R\"). Modifiers: Control, Shift, Alt, Meta" },
    { name: "includeSnapshot", type: "boolean", def: "false", desc: "Whether to include a snapshot in the response." },
  ]},
  type_text: { group: "Input automation", desc: "Types text using the keyboard into a previously focused input.", args: [
    { name: "text", pos: true, req: true, type: "string", desc: "The text to type" },
    { name: "submitKey", type: "string", desc: "Optional key to press after typing. E.g. \"Enter\", \"Tab\", \"Escape\"" },
  ]},
  upload_file: { group: "Input automation", desc: "Uploads a file through a provided element.", args: [
    { name: "uid", pos: true, req: true, type: "string", desc: "The uid of a file input element, or of an element that will open a file chooser" },
    { name: "filePaths", pos: true, req: true, type: "string", desc: "Absolute local path of the file to upload (one path per CLI call)" },
    { name: "includeSnapshot", type: "boolean", def: "false", desc: "Whether to include a snapshot in the response." },
  ]},
  scroll: { group: "Input automation", desc: "Scrolls the page or a scrollable container.", args: [
    { name: "direction", type: "enum", enum: "\"down\" | \"up\" | \"left\" | \"right\"", def: "\"down\"", desc: "Scroll direction" },
    { name: "amount", type: "number", def: "600", desc: "Scroll amount in pixels" },
    { name: "uid", type: "string", desc: "The uid of a scrollable container to scroll; omit to scroll the container under the viewport center" },
    { name: "includeSnapshot", type: "boolean", def: "false", desc: "Whether to include a snapshot in the response." },
  ]},
  // ---- Navigation automation ----
  close_page: { group: "Navigation automation", desc: "Closes the page by its id. The last open page cannot be closed.", args: [
    { name: "page_id", pos: true, req: true, type: "string", desc: "The id of the page to close, from list_pages" },
  ]},
  list_pages: { group: "Navigation automation", desc: "Lists the pages open in the browser (id, title, url).", args: [] },
  navigate_page: { group: "Navigation automation", desc: "Navigates the current page to a URL, or back, forward, or reload.", args: [
    { name: "url", pos: true, type: "string", desc: "Target URL (only type=url)" },
    { name: "type", type: "enum", enum: "\"url\" | \"back\" | \"forward\" | \"reload\"", def: "\"url\"", desc: "Navigate by URL, back or forward in history, or reload" },
    { name: "ignoreCache", type: "boolean", def: "false", desc: "Whether to ignore cache on reload." },
    { name: "timeout", type: "number", enum: "milliseconds", desc: "Maximum wait time for this navigation." },
    { name: "initScript", type: "string", desc: "A JavaScript script to be executed on each new document before any other scripts, for this navigation only." },
    { name: "handleBeforeUnload", type: "enum", enum: "\"accept\" | \"dismiss\"", def: "\"accept\"", desc: "Whether to auto accept or dismiss beforeunload dialogs triggered by this navigation." },
  ]},
  new_page: { group: "Navigation automation", desc: "Opens a new tab and loads a URL. Returns the new page id and the page list.", args: [
    { name: "url", pos: true, req: true, type: "string", desc: "URL to load in a new page" },
    { name: "background", type: "boolean", def: "false", desc: "Whether to open the page in the background without bringing it to the front." },
    { name: "isolatedContext", type: "string", desc: "If specified, the page is created in an isolated browser context with the given name. Pages in different contexts are fully isolated (cookies and storage)." },
    { name: "timeout", type: "number", enum: "milliseconds", desc: "Maximum wait time for the page load." },
  ]},
  select_page: { group: "Navigation automation", desc: "Selects a page as the context for future tool calls.", args: [
    { name: "page_id", pos: true, req: true, type: "string", desc: "The id of the page to select, from list_pages" },
    { name: "bringToFront", type: "boolean", desc: "Whether to focus the page and bring it to the top." },
  ]},
  wait_for: { group: "Navigation automation", desc: "Waits for the specified text to appear on the selected page (main document and all frames).", args: [
    { name: "text", pos: true, req: true, type: "string", desc: "The text to wait for" },
    { name: "timeout", type: "number", enum: "milliseconds", def: "30000", desc: "Maximum wait time." },
  ]},
  // ---- Emulation ----
  resize_page: { group: "Emulation", desc: "Resizes the selected page's window so that the page has the specified dimensions.", args: [
    { name: "width", pos: true, req: true, type: "number", desc: "Page width" },
    { name: "height", pos: true, req: true, type: "number", desc: "Page height" },
  ]},
  emulate: { group: "Emulation", desc: "Emulates network conditions, CPU throttling, geolocation, extra HTTP headers, and color scheme on the selected page. User agent, viewport, platform, and language overrides are not supported (anti-detection red line).", args: [
    { name: "networkConditions", type: "enum", enum: "\"Offline\" | \"Slow 3G\" | \"Fast 3G\" | \"Slow 4G\" | \"Fast 4G\"", desc: "Throttle network. Omit to disable throttling." },
    { name: "cpuThrottlingRate", type: "number", enum: "1-20", def: "1", desc: "CPU slowdown factor. Omit or set to 1 to disable throttling." },
    { name: "geolocation", type: "string", desc: "Geolocation \"<latitude>,<longitude>\". Latitude between -90 and 90, longitude between -180 and 180. Omit to clear the override." },
    { name: "extraHttpHeaders", type: "string (JSON object)", desc: "Extra HTTP headers, e.g. '{\"X-Custom\":\"value\"}'. Included in every request from the page; pass an empty string to clear." },
    { name: "colorScheme", type: "enum", enum: "\"dark\" | \"light\" | \"auto\"", desc: "Emulate dark or light mode. \"auto\" clears the override." },
  ]},
  // ---- Performance ----
  performance_start_trace: { group: "Performance", desc: "Starts a performance trace on the selected page. Use to find frontend performance issues and Core Web Vitals (LCP, INP, CLS). Only one trace can run at a time.", args: [
    { name: "reload", type: "boolean", def: "true", desc: "Whether to reload the page once tracing has started. Navigate to the target URL before starting the trace if reload or autoStop is enabled." },
    { name: "autoStop", type: "boolean", def: "true", desc: "Whether to stop the recording automatically after a few seconds." },
    { name: "filePath", type: "string", desc: "Path to save the raw trace data (.json or .json.gz)." },
  ]},
  performance_stop_trace: { group: "Performance", desc: "Stops the active performance trace. A no-op when no trace is running.", args: [
    { name: "filePath", type: "string", desc: "Path to save the raw trace data (.json or .json.gz)." },
  ]},
  performance_analyze_insight: { group: "Performance", desc: "Returns detailed information on a specific Performance Insight highlighted in the trace results.", args: [
    { name: "insightName", pos: true, req: true, type: "string", desc: "The name of the insight, e.g. \"DocumentLatency\" or \"LCPBreakdown\"" },
    { name: "insightSetId", pos: true, req: true, type: "string", desc: "The insight set id, from the \"Available insight sets\" list in the trace results" },
    { name: "filePath", type: "string", desc: "Path to a trace file; defaults to the most recent trace." },
  ]},
  // ---- Network ----
  list_network_requests: { group: "Network", desc: "Lists network requests captured since the previous call; each request keeps a stable reqid for the session. Pass includePreservedRequests to also return requests kept across navigations.", args: [
    { name: "resourceTypes", type: "string (comma-separated)", desc: "Filter by CDP resource type, e.g. \"Fetch\", \"XHR,Document\", \"Script,Image,WebSocket\". Omit for all requests." },
    { name: "includePreservedRequests", type: "boolean", def: "false", desc: "Also return requests preserved across navigations." },
  ]},
  get_network_request: { group: "Network", desc: "Gets a network request by reqid, including headers and response body.", args: [
    { name: "reqid", pos: true, req: true, type: "string", desc: "The reqid of the request, from list_network_requests" },
    { name: "requestFilePath", type: "string", desc: "Path to a .network-request file to save the request body to. If omitted, the body is returned inline." },
    { name: "responseFilePath", type: "string", desc: "Path to a .network-response file to save the response body to. If omitted, the body is returned inline." },
  ]},
  // ---- Debugging ----
  take_snapshot: { group: "Debugging", desc: "Takes a text snapshot of the selected page based on the a11y tree. Each element carries a unique uid used by the interaction tools. The snapshot also annotates scrollable containers and counts off-screen interactive elements. Always use the latest snapshot; uids go stale after navigation or DOM rebuilds. Prefer a snapshot over a screenshot when the goal is interaction.", args: [
    { name: "filePath", type: "string", desc: "Path to save the snapshot text to (the response still includes the full text)." },
    { name: "verbose", type: "boolean", def: "false", desc: "Include all information available in the full a11y tree." },
  ]},
  take_screenshot: { group: "Debugging", desc: "Takes a screenshot of the page, the full page, or a single element.", args: [
    { name: "filePath", type: "string", desc: "Path to save the screenshot to; defaults to the session artifacts." },
    { name: "format", type: "enum", enum: "\"png\" | \"jpeg\" | \"webp\"", def: "\"png\"", desc: "Image format." },
    { name: "quality", type: "number", enum: "0-100", desc: "Compression quality for jpeg and webp. Ignored for png." },
    { name: "fullPage", type: "boolean", def: "false", desc: "Screenshot of the full page instead of the viewport. Incompatible with uid." },
    { name: "uid", type: "string", desc: "The uid of an element to screenshot. Incompatible with fullPage." },
  ]},
  evaluate_script: { group: "Debugging", desc: "Evaluates a JavaScript function inside the selected page. The return value must be JSON-serializable. Async functions are supported.", args: [
    { name: "function", pos: true, req: true, type: "string", desc: "A function declaration, e.g. '() => document.title' or 'async () => await fetch(\"/api\")'" },
    { name: "args", type: "array (JSON)", desc: "Optional arguments passed to the function." },
    { name: "dialogAction", type: "enum", enum: "\"accept\" | \"dismiss\" | <prompt reply text>", def: "\"accept\"", desc: "How to handle dialogs raised during execution." },
    { name: "filePath", type: "string", desc: "Path to save the output to; omit to return it inline." },
    { name: "waitForStableDom", type: "boolean", desc: "Wait for the DOM to settle before executing." },
  ]},
  list_console_messages: { group: "Debugging", desc: "Lists console messages captured since the previous call; each message keeps a stable msgid for the session. Only console API calls (log, info, warn, error, debug) are captured; uncaught exceptions are not.", args: [
    { name: "types", type: "string (comma-separated)", enum: "\"log\" | \"info\" | \"warn\" | \"error\" | \"debug\"", desc: "Filter by message type. Omit for all messages." },
    { name: "includeStackTraces", type: "boolean", def: "false", desc: "Include the call stack for each message." },
    { name: "includePreservedMessages", type: "boolean", def: "false", desc: "Return the full session buffer instead of only new messages." },
    { name: "pageSize", type: "number", desc: "Maximum number of messages to return." },
    { name: "pageIdx", type: "number", desc: "Page number to return (0-based)." },
  ]},
  get_console_message: { group: "Debugging", desc: "Gets a console message by its msgid, including its stack when available.", args: [
    { name: "msgid", pos: true, req: true, type: "string", desc: "The msgid of the message, from list_console_messages" },
  ]},
  lighthouse_audit: { group: "Debugging", desc: "Runs a Lighthouse audit for accessibility, SEO, best practices, and agentic browsing. For performance, use performance_start_trace. Only navigation mode is supported. The first run pulls the Lighthouse CLI via npx and can be slow; consider --timeout 300000.", args: [
    { name: "mode", type: "enum", enum: "\"navigation\"", def: "\"navigation\"", desc: "Only navigation is supported (loads and audits the page)." },
    { name: "device", type: "enum", enum: "\"desktop\" | \"mobile\"", desc: "Device to emulate during the audit." },
    { name: "onlyCategories", type: "string (comma-separated)", desc: "Restrict the audit to categories, e.g. \"accessibility,seo\"." },
    { name: "outputDirPath", type: "string", desc: "Directory for reports; defaults to the session artifacts." },
  ]},
  screencast_start: { group: "Debugging", desc: "Starts recording the selected page as a sequence of PNG frames.", args: [] },
  screencast_stop: { group: "Debugging", desc: "Stops the active screencast. Returns stopped=false when nothing is recording.", args: [] },
  screencast_collect: { group: "Debugging", desc: "Returns the number of frames captured so far during an active screencast; call it while recording to keep the frame buffer small.", args: [] },
  // ---- Memory ----
  take_heapsnapshot: { group: "Memory", desc: "Captures a heap snapshot of the selected page. Use to analyze the memory distribution of JavaScript objects and debug memory leaks. All other memory tools address snapshots by their .heapsnapshot file path.", args: [
    { name: "filePath", type: "string", desc: "Path to save the .heapsnapshot file to; defaults to the session artifacts." },
  ]},
  close_heapsnapshot: { group: "Memory", desc: "Closes a previously loaded heap snapshot, freeing its memory.", args: [
    { name: "filePath", req: true, type: "string", desc: "Path to the .heapsnapshot file to close." },
  ]},
  compare_heapsnapshots: { group: "Memory", desc: "Compares two heap snapshots and returns the diff. Pass classIndex to drill into individual objects of one class.", args: [
    { name: "baseFilePath", req: true, type: "string", desc: "Path to the base .heapsnapshot file (earlier snapshot)." },
    { name: "currentFilePath", req: true, type: "string", desc: "Path to the current .heapsnapshot file (later snapshot)." },
    { name: "classIndex", type: "number", desc: "0-based index of the class in the summary list; returns object-level diff for that class." },
  ]},
  get_heapsnapshot_summary: { group: "Memory", desc: "Returns summary statistics for a heap snapshot (node/edge counts, total size, type distribution).", args: [
    { name: "filePath", req: true, type: "string", desc: "Path to the .heapsnapshot file to read." },
  ]},
  get_heapsnapshot_details: { group: "Memory", desc: "Returns statistics and the aggregated class list for a heap snapshot, with pagination for the aggregates.", args: [
    { name: "filePath", req: true, type: "string", desc: "Path to the .heapsnapshot file to read." },
    { name: "filterName", type: "enum", enum: "\"objectsRetainedByDetachedDomNodes\" | \"objectsRetainedByConsole\" | \"objectsRetainedByEventHandlers\" | \"objectsRetainedByContexts\"", desc: "Filter aggregates by retention source." },
    { name: "pageSize", type: "number", desc: "Page size for the aggregates." },
    { name: "pageIdx", type: "number", desc: "Page number for the aggregates (0-based)." },
  ]},
  get_heapsnapshot_class_nodes: { group: "Memory", desc: "Returns the instances of a specific class with their ids, sizes, and distances.", args: [
    { name: "filePath", req: true, type: "string", desc: "Path to the .heapsnapshot file to read." },
    { name: "id", req: true, type: "number", desc: "The class index, from get_heapsnapshot_details." },
    { name: "filterName", type: "enum", enum: "same values as get_heapsnapshot_details", desc: "Filter nodes by retention source." },
    { name: "pageSize", type: "number", desc: "Page size." },
    { name: "pageIdx", type: "number", desc: "Page number (0-based)." },
  ]},
  get_heapsnapshot_retainers: { group: "Memory", desc: "Returns the retainers of a specific node: what references it.", args: [
    { name: "filePath", req: true, type: "string", desc: "Path to the .heapsnapshot file to read." },
    { name: "nodeId", req: true, type: "number", desc: "The node id (V8 node ordinal)." },
    { name: "pageSize", type: "number", desc: "Page size." },
    { name: "pageIdx", type: "number", desc: "Page number (0-based)." },
  ]},
  get_heapsnapshot_retaining_paths: { group: "Memory", desc: "Returns retaining paths from a node to the GC roots, showing why it is not collected.", args: [
    { name: "filePath", req: true, type: "string", desc: "Path to the .heapsnapshot file to read." },
    { name: "nodeId", req: true, type: "number", desc: "The node id." },
    { name: "maxDepth", type: "number", def: "10", desc: "Maximum depth to search." },
    { name: "maxNodes", type: "number", def: "20", desc: "Maximum number of nodes to return." },
    { name: "maxSiblings", type: "number", def: "5", desc: "Maximum number of siblings to expand per level." },
  ]},
  get_heapsnapshot_edges: { group: "Memory", desc: "Returns outgoing edges (references) of a specific node.", args: [
    { name: "filePath", req: true, type: "string", desc: "Path to the .heapsnapshot file to read." },
    { name: "nodeId", req: true, type: "number", desc: "The node id." },
    { name: "sortBy", type: "enum", enum: "\"retainedSize\" | \"selfSize\" | \"name\"", def: "\"retainedSize\"", desc: "Sort key." },
    { name: "excludePrimitives", type: "boolean", def: "true", desc: "Exclude edges to primitive values." },
  ]},
  get_heapsnapshot_dominators: { group: "Memory", desc: "Returns the dominator chain of a specific node: the objects keeping it alive.", args: [
    { name: "filePath", req: true, type: "string", desc: "Path to the .heapsnapshot file to read." },
    { name: "nodeId", req: true, type: "number", desc: "The node id." },
  ]},
  get_heapsnapshot_object_details: { group: "Memory", desc: "Returns the properties and incoming edges of a single object.", args: [
    { name: "filePath", req: true, type: "string", desc: "Path to the .heapsnapshot file to read." },
    { name: "nodeId", req: true, type: "number", desc: "The node id." },
  ]},
  get_heapsnapshot_duplicate_strings: { group: "Memory", desc: "Returns duplicate strings grouped by value, with their retained size.", args: [
    { name: "filePath", req: true, type: "string", desc: "Path to the .heapsnapshot file to read." },
    { name: "pageSize", type: "number", desc: "Page size." },
    { name: "pageIdx", type: "number", desc: "Page number (0-based)." },
  ]},
  query_heapsnapshot_objects: { group: "Memory", desc: "Queries objects by class name (regex or text), node type, size ranges, and detached state, with sorting and pagination.", args: [
    { name: "filePath", req: true, type: "string", desc: "Path to the .heapsnapshot file to read." },
    { name: "className", type: "string", desc: "Class name; regex or text match." },
    { name: "nodeType", type: "string", desc: "Node type, e.g. object, string, closure." },
    { name: "selfSize", type: "string", desc: "Self-size range \"min-max\" in bytes, e.g. \"1024-\"." },
    { name: "retainedSize", type: "string", desc: "Retained-size range \"min-max\" in bytes." },
    { name: "isDetached", type: "boolean", desc: "true keeps only detached nodes, false excludes them." },
    { name: "sortBy", type: "enum", enum: "\"retainedSize\" | \"selfSize\" | \"id\"", def: "\"retainedSize\"", desc: "Sort key." },
    { name: "pageSize", type: "number", desc: "Page size." },
    { name: "pageIdx", type: "number", desc: "Page number (0-based)." },
  ]},
  // ---- Third-party ----
  list_3p_developer_tools: { group: "Third-party", desc: "Lists the third-party developer tools exposed by the page.", args: [] },
  execute_3p_developer_tool: { group: "Third-party", desc: "Executes a tool exposed by the page.", args: [
    { name: "toolName", pos: true, req: true, type: "string", desc: "The name of the tool to execute, from list_3p_developer_tools" },
    { name: "params", type: "string (JSON object)", desc: "JSON-stringified parameters to pass to the tool." },
  ]},
  // ---- WebMCP ----
  list_webmcp_tools: { group: "WebMCP", desc: "Lists the WebMCP tools exposed by the page. Requires the WebMCP feature enabled at session start: browser-use start --extra-flags '[\"--enable-features=WebMCP\"]'.", args: [] },
  execute_webmcp_tool: { group: "WebMCP", desc: "Executes a WebMCP tool exposed by the page. Requires the WebMCP feature enabled at session start.", args: [
    { name: "toolName", pos: true, req: true, type: "string", desc: "The name of the tool to execute, from list_webmcp_tools" },
    { name: "input", type: "string (JSON object)", desc: "JSON-stringified parameters to pass to the tool." },
  ]},
  // ---- PWA ----
  get_os_app_state: { group: "PWA", desc: "Returns the manifest state of an installed OS-level app.", args: [
    { name: "manifestId", pos: true, req: true, type: "string", desc: "The manifest id of the app." },
  ]},
  install_pwa: { group: "PWA", desc: "Installs a PWA as an OS-level app.", args: [
    { name: "manifestId", pos: true, req: true, type: "string", desc: "The manifest id." },
    { name: "installUrlOrBundleUrl", pos: true, req: true, type: "string", desc: "The install URL or bundle URL." },
    { name: "displayMode", type: "string", desc: "The display mode." },
  ]},
  launch_pwa: { group: "PWA", desc: "Launches an installed PWA in its own window.", args: [
    { name: "manifestId", pos: true, req: true, type: "string", desc: "The manifest id." },
  ]},
  uninstall_pwa: { group: "PWA", desc: "Uninstalls a PWA.", args: [
    { name: "manifestId", pos: true, req: true, type: "string", desc: "The manifest id." },
  ]},
  // ---- Extensions ----
  list_extensions: { group: "Extensions", desc: "Lists the extensions installed in the session (id, name, version, enabled).", args: [] },
  install_extension: { group: "Extensions", desc: "Installs an unpacked extension into the current session.", args: [
    { name: "path", pos: true, req: true, type: "string", desc: "Absolute path to the unpacked extension folder." },
  ]},
  uninstall_extension: { group: "Extensions", desc: "Uninstalls an extension by id.", args: [
    { name: "id", pos: true, req: true, type: "string", desc: "The extension id, from list_extensions" },
  ]},
  reload_extension: { group: "Extensions", desc: "Reloads an unpacked extension by id.", args: [
    { name: "id", pos: true, req: true, type: "string", desc: "The extension id." },
  ]},
  trigger_extension_action: { group: "Extensions", desc: "Triggers the default action of an extension by id.", args: [
    { name: "id", pos: true, req: true, type: "string", desc: "The extension id." },
  ]},
};

const SESSION_COMMANDS = `Session commands:
  browser-use start [--headless] [--browser-exe <path>] [--extra-flags '<json array>']
  browser-use stop --session=<id>
  browser-use sessions list [--state=<s>] | sessions clean
  browser-use session.bare --session=<id>      skip login-state injection
  browser-use status
  browser-use config get [k] | set <k> <v> | list | reset [k]
  browser-use extension
  browser-use skill list | install --agent=<key>|--all [--force] [--dry-run] | uninstall --agent=<key>
  browser-use allow [--agent=<key>|--all] [--remove] [--dry-run]   # pre-approve browser-use commands in coding agents
  browser-use doctor [--fix]`;

function cliUsage(tool, args) {
  const pos = args.filter((a) => a.pos).map((a) => a.req ? ` <${a.name}>` : ` [${a.name}]`);
  const flags = args.filter((a) => !a.pos);
  const flagPart = flags.length ? " " + flags.map((a) => `[--${a.name}${a.req ? " <value>" : ""}]`).join(" ") : "";
  return `browser-use ${tool} --session=<id>${pos.join("")}${flagPart}`;
}

// help 命令用:紧凑参数行
export function toolHelpText(tool) {
  const t = TOOL_REFERENCE[tool];
  if (!t) return null;
  const lines = [`${tool}: ${t.desc}`, `usage: ${cliUsage(tool, t.args)}`];
  for (const a of t.args) {
    const req = a.req ? "required" : "optional";
    const extra = [a.enum ? `values: ${a.enum}` : "", a.def ? `default ${a.def}` : ""].filter(Boolean).join("; ");
    lines.push(`  ${a.pos ? a.name + " (positional)" : "--" + a.name} (${req}, ${a.type}${extra ? "; " + extra : ""}): ${a.desc}`);
  }
  lines.push(`  global: --output-format=json for machine-readable output; --timeout <ms> for the call timeout`);
  return lines.join("\n");
}

export function helpOverviewText() {
  const groups = [];
  for (const [tool, t] of Object.entries(TOOL_REFERENCE)) {
    let g = groups.find(([name]) => name === t.group);
    if (!g) { g = [t.group, []]; groups.push(g); }
    g[1].push(tool);
  }
  return `${SESSION_COMMANDS}\n\nTools (details: browser-use help <tool>):\n` +
    groups.map(([g, ts]) => `  ${g} (${ts.length}): ${ts.join(", ")}`).join("\n");
}
