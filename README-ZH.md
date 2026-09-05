# @arsonist-g/browser-use

[English](README.md) | [中文](README-ZH.md)

不被反爬雷达发现的 AI 浏览器自动化。`browser-use` 驱动本机自己的 Edge(有头、默认指纹),把日常浏览器的登录 cookie 继承进每个会话,并以简单 CLI 暴露 chrome-devtools-mcp v1.8.0 的完整工具面(57 工具)。其 DrissionPage 内核避开反爬系统能检测的协议级信号,因此在普通自动化会被检测的站点上仍可工作。

## 为什么做这个

两类浏览器自动化在受保护站点上都会失败:

- 标准 CDP 自动化(Puppeteer / chrome-devtools-mcp 一系)会打开协议通道(`Runtime.enable` 等),反爬系统从页面内部就能采到这些特征。
- 无头或指纹伪装路线用"覆盖"应对检测,而平台会把覆盖值与 TLS、行为信号交叉验证,不一致反而被标记。

browser-use 的立场不同:**不发信号,不覆盖指纹**。它通过一个不打开这些通道的驱动层操控真实有头 Edge,UA/平台/语言保持真实值,输入层默认拟人(曲线鼠标轨迹、人类化按键节奏)。从检测视角看,一个会话就像你的浏览器,因为它本来就是你的浏览器。

## 安装

```sh
npm i -g @arsonist-g/browser-use
browser-use doctor        # 检查 node >= 20、python 3.10+、DrissionPage 内核、Edge;--fix 自动补齐
```

一次性配置:把桥扩展装入日常 Edge(`browser-use extension` 打印目录;`edge://extensions` → 开发者模式 → 加载解压缩的扩展)。日常浏览器处于打开状态时,扩展自动向新会话供给登录 cookie:无需 token,无需反复点 popup。

## 30 秒上手

```sh
browser-use start                          # 打印 session=<id>;cookie 注入成功显示 login=injected
browser-use take_snapshot --session=<id>   # 页面文本树,元素带 uid=...
browser-use click --session=<id> "1_5"     # 按 uid 操作
browser-use fill --session=<id> "3_2" "hello"
browser-use stop --session=<id>            # 关闭 Edge,删除一次性 profile
```

每个会话是带一次性 profile 的独立 Edge 实例;`--session=<id>` 路由每条命令,并发的 AI 窗口永不共享浏览器。cookie 在 `start` 时从日常浏览器读取,永不回写。

## 安装为 agent skill

把随包的 skill 装进你的 code agent,让它学会驱动 browser-use:

```sh
browser-use skill list                            # 支持的 agent 与安装状态
browser-use skill install --agent=claude-code     # 把 skills/browser-use/ 复制进 agent 的 skills 目录
browser-use skill install --all [--dry-run]       # 全部支持的 agent;--dry-run 只打印目标路径
```

支持的 agent 与各自 skill 目录(每项均经官方文档核实):

| Agent | 目录 | key |
|---|---|---|
| Claude Code | `~/.claude/skills/browser-use/` | `claude-code` |
| Codex CLI | `~/.agents/skills/browser-use/` | `codex` |
| Cursor | `~/.cursor/skills/browser-use/` | `cursor` |
| Gemini CLI | `~/.gemini/skills/browser-use/` | `gemini-cli` |
| Windsurf | `~/.codeium/windsurf/skills/browser-use/` | `windsurf` |

Codex、Cursor、Gemini CLI、Windsurf 同时也读取跨厂商目录 `~/.agents/skills/`;安装器按各家专属目录写入,使每个 agent 可独立安装与卸载。安装后重启 agent 使 skill 生效。

## 免逐次审批(命令放行)

agent 对每条 shell 命令逐次询问,会让 browser-use 会话很慢。放行一次,后续调用不再询问:

```sh
browser-use allow                     # Claude Code:向 ~/.claude/settings.json 追加 Bash(browser-use:*)
browser-use allow --agent=cursor      # 指定 agent key,或 --all 全部
browser-use allow --all --dry-run     # 预览;--remove 撤销
```

支持的 agent 与写入内容(每项机制均经官方文档核实):

| Agent | 写入位置 |
|---|---|
| Claude Code | `~/.claude/settings.json` → `permissions.allow: ["Bash(browser-use:*)"]` |
| Codex CLI | `~/.codex/rules/browser-use.rules`(prefix_rule allow) |
| Cursor(IDE + CLI) | `~/.cursor/permissions.json` → `terminalAllowlist`;`~/.cursor/cli-config.json` → `permissions.allow` |
| Gemini CLI | `~/.gemini/policies/browser-use.toml`(策略规则 allow) |
| Windsurf | Windsurf 用户 `settings.json` → `windsurf.cascadeCommandsAllowList`(仅当检测到已安装的 Windsurf) |
| opencode | `~/.config/opencode/opencode.json` → `permission.bash` 放行键 |

写入幂等、保留既有条目;`--remove` 只删本工具的规则(剪空后文件/键一并清理)。Cursor 注意:一旦 `permissions.json` 定义 `terminalAllowlist`,设置 UI 里的终端允许列表被该文件整体取代(命令会打印警告)。

## 工具面

与 chrome-devtools-mcp v1.8.0 完全对齐:交互(click/fill/drag/type/scroll/对话框)、导航与页面、快照与截图、`evaluate_script`、收割语义的 console 与 network、仿真、性能追踪、13 件 heapsnapshot/内存工具、Lighthouse 审计、录屏、三方 devtools 工具、WebMCP、PWA 管理、会话内扩展管理。`browser-use --help` 列出会话命令;工具以 `browser-use <tool> --session=<id> [args]` 调用。

每条命令都支持机器可读输出:`--output-format=json`。

## 与 cdt 的关系

browser-use 是 [cdt](https://www.npmjs.com/package/@arsonist-g/cdt) 的后继。cdt 在标准 CDP 上封装 chrome-devtools-mcp;两者工具名、参数形态、语义保持兼容,prompt 与使用习惯原样迁移。变的是 CLI 之下的引擎:不再是 WebSocket 上的 CDP 会话,而是 DrissionPage 内核原生驱动浏览器,跳过可检测的协议通道;输入默认拟人;cookie 继承从"拷贝 profile"改为"逐会话注入"。站点对普通 CDP 自动化无感时,两者皆可;站点反击时,用这个。

## 约束与已知限制

如实列出,皆为设计取舍:

- **不做指纹覆盖。** UA、平台、语言仿真一律拒绝。这是立场,不是缺口。
- **console 只捕获 `console.*` 调用**(log/info/warn/error/debug),不捕获未捕获异常;协议级异常捕获需要本项目拒绝发送的信号。
- **快照覆盖主 frame。** 同级 iframe 内容尚未拼接。
- **录屏输出 PNG 帧序列**(视频编码是后续工作)。
- **短时效登录 cookie 会过期**;重开一个会话即重新读取。
- **会话内的登出/改密会作用于日常浏览器的同账号**(与人类开第二个窗口一致)。旋转 refresh token 的平台可能互踢一方。
- daemon、桥、会话仅绑定 `127.0.0.1`。

## 开发与测试

```sh
npm test        # 单元测试
npm run e2e     # 对本地 fixture 页的端到端回归
npm run all-tools  # 对 fixture 的 57 工具全矩阵
```

Python 内核在 `core/`(DrissionPage);daemon 与 CLI 在 `lib/` 与 `bin/`;桥扩展在 `extension/`;agent skill 在 `skills/browser-use/`。

## License

MIT
