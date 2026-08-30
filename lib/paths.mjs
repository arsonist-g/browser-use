// ~/.browser-use 路径与进程内单例加载
import fs from "node:fs";
import path from "node:path";
import os from "node:os";

export const BU_HOME = process.env.BROWSER_USE_HOME
  ?? path.join(os.homedir(), ".browser-use");

export const CONFIG_PATH = path.join(BU_HOME, "config.json");
export const DAEMON_PID_PATH = path.join(BU_HOME, "daemon.pid");
export const DAEMON_LOG_PATH = path.join(BU_HOME, "daemon.log");
export const SESSIONS_DIR = path.join(BU_HOME, "sessions");
export const PROFILES_DIR = path.join(BU_HOME, "profiles");
export const EXTENSION_DIR_REL = "extension";

export function ensureHome() {
  fs.mkdirSync(BU_HOME, { recursive: true });
  fs.mkdirSync(SESSIONS_DIR, { recursive: true });
  fs.mkdirSync(PROFILES_DIR, { recursive: true });
}

export function sessionDir(sessionId) {
  return path.join(SESSIONS_DIR, sessionId);
}
