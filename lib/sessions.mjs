// 会话状态机与 session.json 读写(daemon 持写权)
// 状态:starting → ready → in_use → stopping → cleaned;分支 crashed/failed
// login_state:injected | empty | bare | none
import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";
import { SESSIONS_DIR, sessionDir, ensureHome } from "./paths.mjs";

export function newSessionId() {
  const d = new Date();
  const p = (n, w = 2) => String(n).padStart(w, "0");
  const stamp = `${d.getFullYear()}${p(d.getMonth() + 1)}${p(d.getDate())}-${p(d.getHours())}${p(d.getMinutes())}${p(d.getSeconds())}`;
  return `s-${stamp}-${crypto.randomBytes(2).toString("hex")}`;
}

export function createSessionDoc({ port, profileDir, browserExe, headless }) {
  ensureHome();
  const id = newSessionId();
  const doc = {
    session_id: id,
    state: "starting",
    login_state: "none",
    created_at: new Date().toISOString(),
    ended_at: null,
    port,
    profile_dir: profileDir,
    browser_exe: browserExe,
    headless,
    core_pid: null,
    edge_pid_root: null,
    snapshots: [],
    artifacts: [],
    last_error: null,
  };
  fs.mkdirSync(sessionDir(id), { recursive: true });
  fs.mkdirSync(path.join(sessionDir(id), "artifacts"), { recursive: true });
  saveSession(doc);
  return doc;
}

export function sessionPath(sessionId) {
  return path.join(sessionDir(sessionId), "session.json");
}

export function loadSession(sessionId) {
  return JSON.parse(fs.readFileSync(sessionPath(sessionId), "utf8"));
}

export function saveSession(doc) {
  fs.writeFileSync(sessionPath(doc.session_id), JSON.stringify(doc, null, 2) + "\n");
}

export function updateSession(sessionId, patch) {
  const doc = loadSession(sessionId);
  Object.assign(doc, patch);
  saveSession(doc);
  return doc;
}

export function listSessions(stateFilter) {
  ensureHome();
  const out = [];
  for (const name of fs.readdirSync(SESSIONS_DIR).sort().reverse()) {
    try {
      const doc = JSON.parse(fs.readFileSync(path.join(SESSIONS_DIR, name, "session.json"), "utf8"));
      if (!stateFilter || doc.state === stateFilter) out.push(doc);
    } catch { /* 半写文件跳过 */ }
  }
  return out;
}

/** 终态并记录错误(幂等:已是终态则原样返回) */
const TERMINAL = new Set(["cleaned", "failed"]);
export function terminateSession(sessionId, state, lastError = null) {
  const doc = loadSession(sessionId);
  if (TERMINAL.has(doc.state)) return doc;
  doc.state = state;
  doc.ended_at = new Date().toISOString();
  doc.last_error = lastError;
  doc.core_pid = null;
  doc.edge_pid_root = null;
  saveSession(doc);
  return doc;
}
