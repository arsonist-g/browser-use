# @arsonist-g/browser-use

[English](README.md) | [中文](README-ZH.md)

AI browser automation that stays under anti-bot radar. `browser-use` drives the machine's own Edge (headed, default fingerprint), inherits your daily browser's login cookies into each session, and exposes the full chrome-devtools-mcp v1.8.0 tool surface (57 tools) through a simple CLI. Its DrissionPage core avoids the protocol-level signals that anti-bot systems detect, so it keeps working where ordinary automation trips detection.

## Why

Two kinds of browser automation fail on protected sites:

- Standard CDP automation (Puppeteer / chrome-devtools-mcp style) opens protocol channels (`Runtime.enable` and friends) that anti-bot systems fingerprint from inside the page.
- Headless or fingerprint-spoofer setups answer detection with overrides, which platforms cross-check against TLS and behavior signals and flag as inconsistent.

browser-use takes a different position: **never send the signals, never override the fingerprint**. It drives a real headed Edge through a driver that does not open those channels, keeps UA/platform/language at their true values, and adds a humanized input layer (curved mouse paths, human key cadence). Detection-wise, a session looks like your browser, because it is your browser.

## Install

```sh
npm i -g @arsonist-g/browser-use
browser-use doctor        # checks node >= 20, python 3.10+, DrissionPage core, Edge; --fix installs what is missing
```

One-time setup: load the bridge extension into your daily Edge (`browser-use extension` prints the directory; `edge://extensions` → Developer mode → Load unpacked). While your daily browser is open, the extension feeds login cookies to new sessions automatically: no tokens, no popup dance.

## 30-second start

```sh
browser-use start                          # prints session=<id>; login=injected when cookies arrived
browser-use take_snapshot --session=<id>   # text tree of the page, elements carry uid=...
browser-use click --session=<id> "1_5"     # act by uid
browser-use fill --session=<id> "3_2" "hello"
browser-use stop --session=<id>            # closes Edge, deletes the one-off profile
```

Each session is an isolated Edge instance with a disposable profile; `--session=<id>` routes every command, so concurrent AI windows never share a browser. Cookies are read from your daily browser at `start`, never written back to it.

## Install as an agent skill

Teach your coding agent to drive browser-use by installing the bundled skill:

```sh
browser-use skill list                            # supported agents and install state
browser-use skill install --agent=claude-code     # copies skills/browser-use/ into the agent's skills dir
browser-use skill install --all [--dry-run]       # every supported agent; --dry-run only prints target paths
```

Supported agents and their skill directories (each verified against the vendor's documentation):

| Agent | Directory | Key |
|---|---|---|
| Claude Code | `~/.claude/skills/browser-use/` | `claude-code` |
| Codex CLI | `~/.agents/skills/browser-use/` | `codex` |
| Cursor | `~/.cursor/skills/browser-use/` | `cursor` |
| Gemini CLI | `~/.gemini/skills/browser-use/` | `gemini-cli` |
| Windsurf | `~/.codeium/windsurf/skills/browser-use/` | `windsurf` |

Codex, Cursor, Gemini CLI, and Windsurf also read the cross-vendor `~/.agents/skills/` directory; the installer writes each agent's own directory so every one can be installed and removed independently. Restart the agent after installing so it picks up the skill.

## Skip per-command approval

Agents ask before every shell command, which makes browser-use sessions slow. Pre-approve the `browser-use` command once:

```sh
browser-use allow                     # Claude Code: adds Bash(browser-use:*) to ~/.claude/settings.json
browser-use allow --agent=cursor      # any supported agent key, or --all
browser-use allow --all --dry-run     # preview; --remove undoes
```

Supported agents and what gets written (each mechanism verified against the vendor's docs):

| Agent | Config written |
|---|---|
| Claude Code | `~/.claude/settings.json` → `permissions.allow: ["Bash(browser-use:*)"]` |
| Codex CLI | `~/.codex/rules/browser-use.rules` (prefix_rule allow) |
| Cursor (IDE + CLI) | `~/.cursor/permissions.json` → `terminalAllowlist`; `~/.cursor/cli-config.json` → `permissions.allow` |
| Gemini CLI | `~/.gemini/policies/browser-use.toml` (policy rule allow) |
| Windsurf | Windsurf user `settings.json` → `windsurf.cascadeCommandsAllowList` (only when a Windsurf install is detected) |
| opencode | `~/.config/opencode/opencode.json` → `permission.bash` allow entries |

Merges are idempotent and preserve existing entries; `--remove` deletes only this tool's rules (emptied files/keys are cleaned up). Cursor note: once `permissions.json` defines `terminalAllowlist`, it replaces the in-app allowlist (the command prints a warning).

## Tool surface

Full chrome-devtools-mcp v1.8.0 parity: interaction (click/fill/drag/type/scroll/dialogs), navigation and pages, snapshots and screenshots, `evaluate_script`, console and network with harvest semantics, emulation, performance tracing, 13 heapsnapshot/memory tools, Lighthouse audit, screencast, third-party devtools tools, WebMCP, PWA management, in-session extension management. `browser-use --help` lists session commands; tools run as `browser-use <tool> --session=<id> [args]`.

Machine-readable output for every command: `--output-format=json`.

## Relationship to cdt

browser-use is the successor of [cdt](https://www.npmjs.com/package/@arsonist-g/cdt), which wraps chrome-devtools-mcp over standard CDP. The tool names, argument shapes, and semantics stay compatible, so prompts and muscle memory port over unchanged. What changed is the engine under the CLI: instead of a CDP session over WebSocket, a DrissionPage core drives the browser natively and skips the detectable protocol channels; input is humanized by default; cookie inheritance moved from a copied profile to per-session injection. If a site is fine with plain CDP automation, either tool works; when a site fights back, use this one.

## Constraints and known limitations

Honest list, by design:

- **No fingerprint overrides.** UA, platform, and language emulation are refused. That is the point, not a gap.
- **Console captures `console.*` calls only** (log/info/warn/error/debug), not uncaught exceptions; protocol-level exception capture requires the signals this project refuses to send.
- **Snapshots cover the main frame.** Same-frame iframe content is not stitched in yet.
- **Screencast emits PNG frame sequences** (video encoding is future work).
- **Short-lived login cookies can go stale** mid-day; starting a fresh session re-reads them.
- **A logout or password change inside a session affects your daily browser's account** (same as a human second window). Platforms that rotate refresh tokens may kick one side.
- The daemon, bridge, and sessions bind to `127.0.0.1` only.

## Development

```sh
npm test        # unit tests
npm run e2e     # end-to-end against a local fixture page
npm run all-tools  # full 57-tool matrix against the fixture
```

Python core lives in `core/` (DrissionPage); daemon and CLI in `lib/` and `bin/`; bridge extension in `extension/`; the agent skill in `skills/browser-use/`.

## License

MIT
