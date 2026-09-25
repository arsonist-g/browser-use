// 回归:daemon 必须活过"启动它的那条命令"。
// 用户现场:有些执行环境(agent 的 Bash 工具)在命令结束时回收整棵进程树,旧的普通 detached spawn 起的
// daemon 会被 TerminateProcess 砍掉(日志里连 exit 行都没有,只剩一段空白);而 daemon 一死,带
// --remote-debugging-pipe 的会话浏览器与 core 会立即跟着退出 —— 用户看到的就是"浏览器窗口刚打开就闪退"。
// 修法是让 daemon 由 WMI 创建(父进程是 WmiPrvSE,既不在调用方的 job 里、也不在它的父子链上),并把
// daemon 及其子进程需要的环境写进 launcher(WMI 起的进程不继承调用方环境)。
// 本测试:用隔离 home 起一个 daemon,CLI 退出后断言它仍然活着并能应答。
import { test, after } from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import net from "node:net";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import url from "node:url";

const ROOT = path.dirname(path.dirname(path.dirname(url.fileURLToPath(import.meta.url))));
const CLI = path.join(ROOT, "bin", "browser-use.mjs");
const TMP_HOME = fs.mkdtempSync(path.join(os.tmpdir(), "bu-daemon-life-"));
let daemonPid = null;

after(() => {
  if (daemonPid) { try { process.kill(daemonPid); } catch { /* 已退出 */ } }
  if (TMP_HOME.startsWith(os.tmpdir())) fs.rmSync(TMP_HOME, { recursive: true, force: true, maxRetries: 5 });
});

function freePort() {
  return new Promise((resolve, reject) => {
    const srv = net.createServer();
    srv.once("error", reject);
    srv.listen(0, "127.0.0.1", () => {
      const port = srv.address().port;
      srv.close(() => resolve(port));
    });
  });
}

function runCli(args, env) {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [CLI, ...args], {
      cwd: ROOT, env: { ...process.env, ...env }, windowsHide: true,
      stdio: ["ignore", "pipe", "pipe"],
    });
    let stdout = "";
    let stderr = "";
    const timer = setTimeout(() => {
      child.kill("SIGKILL");
      reject(new Error(`CLI 未在 20s 内结束: ${args.join(" ")}`));
    }, 20000);
    child.stdout.on("data", (d) => { stdout += d; });
    child.stderr.on("data", (d) => { stderr += d; });
    child.on("error", (e) => { clearTimeout(timer); reject(e); });
    child.on("close", (code) => { clearTimeout(timer); resolve({ status: code, stdout, stderr }); });
  });
}

test("daemon 活过启动它的那条命令,并且仍然能应答", async (t) => {
  if (process.platform !== "win32") return t.skip("WMI 拉起 daemon 是 Windows 路径");
  const httpPort = await freePort();
  const wsPort = await freePort();
  // 隔离 home:自己的 config(端口都不撞真实 daemon),自己的 pid/日志文件
  fs.writeFileSync(path.join(TMP_HOME, "config.json"),
    JSON.stringify({ daemon_http_port: httpPort, bridge_ws_port: wsPort }));
  const env = { BU_DAEMON_PORT: String(httpPort), BROWSER_USE_HOME: TMP_HOME };

  const started = await runCli(["status"], env);
  assert.equal(started.status, 0, `status 应成功:stderr=${started.stderr}`);

  // launcher 必须把隔离 home 带进去(WMI 起的进程不继承调用方环境)
  const launcher = path.join(TMP_HOME, "daemon-launch.mjs");
  assert.ok(fs.existsSync(launcher), "应生成 daemon launcher");
  assert.match(fs.readFileSync(launcher, "utf8"), /BROWSER_USE_HOME/,
    "launcher 必须带上 BROWSER_USE_HOME,否则 daemon 会去操作真实 home");

  daemonPid = Number(fs.readFileSync(path.join(TMP_HOME, "daemon.pid"), "utf8").trim());
  assert.ok(daemonPid > 0, "daemon 应写下 pid 文件");

  // 启动它的那条命令已经退出;给"进程树回收"留出窗口,再断言它还在
  await new Promise((r) => setTimeout(r, 2500));
  let alive = true;
  try { process.kill(daemonPid, 0); } catch { alive = false; }
  assert.ok(alive, `daemon(${daemonPid})必须活过启动它的那条命令:它一死,带 --remote-debugging-pipe 的`
    + "会话浏览器与 core 会立即跟着退出(用户看到的就是窗口刚打开就闪退)");

  // 拉起路径必须是 WMI -> `conhost --headless`:WMI 直接起 node 会为它分配一个控制台,Win11 默认终端为
  // Windows Terminal 时那就是用户屏幕上一个可见的 WT 窗口(实测遇到过)。daemon 的父进程是 conhost,
  // 即证明走了"无窗口控制台"这条路径。
  const parentName = await new Promise((resolve) => {
    const ps = `(Get-CimInstance Win32_Process -Filter "ProcessId=${daemonPid}").ParentProcessId | ` +
      "ForEach-Object { (Get-Process -Id $_).ProcessName }";
    const child = spawn("powershell", ["-NoProfile", "-NonInteractive", "-Command", ps], { windowsHide: true });
    let o = "";
    child.stdout.on("data", (d) => { o += d; });
    child.on("error", () => resolve(""));
    child.on("close", () => resolve(o.trim().toLowerCase()));
  });
  assert.equal(parentName, "conhost",
    "daemon 必须由 conhost --headless 承载:少了这一层,WMI 起的 node 会弹出可见的控制台窗口");

  const health = await fetch(`http://127.0.0.1:${httpPort}/health`);
  assert.equal(health.status, 200, "跨命令后 daemon 仍应应答 /health");
});
