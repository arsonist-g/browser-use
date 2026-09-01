// 单元测试:工具参考完整性(TOOL_REFERENCE 覆盖 core 全部工具)与
// SKILL.md 手写工具表和 help 数据的同步(参数集合/位置/必填标记)。
// 新增 core 工具时:① core 实现参数;② lib/tool-help.mjs 的 TOOL_REFERENCE 登记参数;
// ③ 同步 SKILL.md/SKILL-ZH.md 的 Tool reference 表格;④ 更新本文件 EXPECTED 清单。
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import url from "node:url";
import { TOOL_REFERENCE, toolHelpText } from "../../lib/tool-help.mjs";

const ROOT = path.dirname(path.dirname(path.dirname(url.fileURLToPath(import.meta.url))));

const EXPECTED = new Set([
  // Input automation (11)
  "click", "click_at", "drag", "fill", "fill_form", "handle_dialog", "hover", "press_key",
  "scroll", "type_text", "upload_file",
  // Navigation automation (6)
  "close_page", "list_pages", "navigate_page", "new_page", "select_page", "wait_for",
  // Emulation (2)
  "emulate", "resize_page",
  // Performance (3)
  "performance_analyze_insight", "performance_start_trace", "performance_stop_trace",
  // Network (2)
  "get_network_request", "list_network_requests",
  // Debugging (9)
  "evaluate_script", "get_console_message", "lighthouse_audit", "list_console_messages",
  "screencast_collect", "screencast_start",
  "screencast_stop", "take_screenshot", "take_snapshot",
  // Memory (13)
  "close_heapsnapshot", "compare_heapsnapshots", "get_heapsnapshot_class_nodes", "get_heapsnapshot_details",
  "get_heapsnapshot_dominators", "get_heapsnapshot_duplicate_strings", "get_heapsnapshot_edges",
  "get_heapsnapshot_object_details",
  "get_heapsnapshot_retainers", "get_heapsnapshot_retaining_paths", "get_heapsnapshot_summary",
  "query_heapsnapshot_objects", "take_heapsnapshot",
  // Third-party (2)
  "execute_3p_developer_tool", "list_3p_developer_tools",
  // WebMCP (2)
  "execute_webmcp_tool", "list_webmcp_tools",
  // PWA (4)
  "get_os_app_state", "install_pwa", "launch_pwa", "uninstall_pwa",
  // Extensions (5)
  "install_extension", "list_extensions", "reload_extension", "trigger_extension_action", "uninstall_extension",
]);

test("TOOL_REFERENCE 覆盖全部 59 个 core 工具,无多余条目", () => {
  assert.equal(Object.keys(TOOL_REFERENCE).length, 59);
  const keys = new Set(Object.keys(TOOL_REFERENCE));
  const missing = [...EXPECTED].filter((k) => !keys.has(k));
  assert.deepEqual(missing, [], `缺少参考条目: ${missing.join(", ")}`);
  const extra = [...keys].filter((k) => !EXPECTED.has(k));
  assert.deepEqual(extra, [], `多余条目(同步 EXPECTED 清单): ${extra.join(", ")}`);
});

test("每组分组名合法(与 SKILL.md 速览表/参考节分组一致)", () => {
  const valid = new Set(["Input automation", "Navigation automation", "Emulation", "Performance",
    "Network", "Debugging", "Memory", "Third-party", "WebMCP", "PWA", "Extensions"]);
  for (const [, t] of Object.entries(TOOL_REFERENCE)) {
    assert.ok(valid.has(t.group), `非法分组: ${t.group}`);
  }
});

test("SKILL.md 工具表与 TOOL_REFERENCE 参数集合/位置/必填标记同步", () => {
  const md = fs.readFileSync(path.join(ROOT, "skills", "browser-use", "SKILL.md"), "utf8");
  let section = md.slice(md.indexOf("## Tool reference"));
  section = section.slice(0, section.indexOf("### Session commands")); // 会话命令表不属 TOOL_REFERENCE
  // 解析工具表行:4 列 | `tool` | desc | signature | notes |(Shared parameters 表只有 3 段,自动排除)
  // signature 形态:<uid> = 必填位置,[url] = 可选位置,--flag = 可选 flag,--filePath* = 必填 flag
  const seen = new Map(); // tool -> [{name, pos, req}]
  for (const line of section.split("\n")) {
    if (!line.startsWith("| `")) continue;
    const cells = line.split("|").map((c) => c.trim());
    if (cells.length < 6) continue; // 工具表 4 列 → split 后 6 段
    const tool = cells[1].replaceAll("`", "");
    if (!/^\w+$/.test(tool)) continue;
    const params = [...cells[3].matchAll(/`([^`]+)`/g)].map((p) => p[1])
      .filter((p) => p !== "--session=<id>")
      .map((p) => {
        const isFlag = p.startsWith("--");
        return {
          raw: p,
          name: isFlag ? p.slice(2).replace(/\*$/, "") : p.replaceAll(/[<>\[\]]/g, ""),
          pos: !isFlag,
          req: isFlag ? p.endsWith("*") : p.startsWith("<"),
        };
      });
    seen.set(tool, params);
  }
  assert.equal(seen.size, 59, `工具表应有 59 行,实际 ${seen.size}`);
  for (const [tool, params] of seen) {
    const ref = TOOL_REFERENCE[tool];
    assert.ok(ref, `SKILL.md 有 ${tool} 但 TOOL_REFERENCE 没有`);
    const tableNames = params.map((p) => p.name).sort();
    const refNames = ref.args.map((a) => a.name).sort();
    assert.deepEqual(tableNames, refNames, `${tool} 参数集合不一致`);
    for (const p of params) {
      const a = ref.args.find((x) => x.name === p.name);
      assert.equal(p.pos, !!a.pos, `${tool}.${p.name} 位置标记不一致(表格 ${p.raw})`);
      assert.equal(p.req, !!a.req, `${tool}.${p.name} 必填标记不一致(表格 ${p.raw})`);
    }
    // 位置参数必须按位置顺序出现(必填在前可选在后不强制,但相对顺序要与 usage 一致)
    const refPos = ref.args.filter((a) => a.pos).map((a) => a.name);
    const tablePos = params.filter((p) => p.pos).map((p) => p.name);
    assert.deepEqual(tablePos, refPos, `${tool} 位置参数顺序不一致(表格 ${tablePos} / 参考 ${refPos})`);
  }
});

test("toolHelpText 对必填位置参数渲染 usage 行", () => {
  const h = toolHelpText("fill");
  assert.match(h, /usage: browser-use fill --session=<id> <uid> <value>/);
  assert.match(h, /--includeSnapshot/);
});
