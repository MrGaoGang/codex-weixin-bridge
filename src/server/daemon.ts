import { spawn } from "node:child_process";
import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";

import { readServiceStatus, type ServiceStatus } from "./restart-control.js";

/** The launcher only owns this ChildProcess; it never signals a PID from disk. */
export async function startBackgroundService(options: {
  root: string;
  entryPath: string;
  cwd?: string;
  env?: NodeJS.ProcessEnv;
  timeoutMs?: number;
}): Promise<ServiceStatus & { logPath: string }> {
  const logPath = path.join(options.root, "logs", "service.log");
  fs.mkdirSync(path.dirname(logPath), { recursive: true });
  const log = fs.openSync(logPath, "a", 0o600);
  fs.chmodSync(logPath, 0o600);
  const startId = crypto.randomUUID();
  let child;
  try {
    child = spawn(process.execPath, [...process.execArgv, options.entryPath, "--foreground"], {
      cwd: options.cwd ?? process.cwd(),
      env: { ...(options.env ?? process.env), CODEX_WEIXIN_STATE_DIR: options.root, CODEX_WEIXIN_DAEMON_ID: startId },
      detached: true,
      stdio: ["ignore", log, log],
      windowsHide: true
    });
  } finally {
    fs.closeSync(log);
  }
  let failure: Error | undefined;
  let exited = false;
  const exit = new Promise<void>((resolve) => {
    child.once("exit", () => { exited = true; resolve(); });
    child.once("error", (error) => { failure = error; exited = true; resolve(); });
  });
  const deadline = Date.now() + (options.timeoutMs ?? 20_000);
  try {
    while (!exited && Date.now() < deadline) {
      const status = await readServiceStatus(options.root);
      if (!exited && status && status.pid === child.pid && status.startId === startId) {
        child.unref();
        return { ...status, logPath };
      }
      await new Promise((resolve) => setTimeout(resolve, 100));
    }
    if (!exited) throw new Error("Background service startup timed out");
    throw failure ?? new Error("Background service exited before becoming ready");
  } catch (error) {
    if (!exited) {
      child.kill("SIGTERM");
      let graceTimer: ReturnType<typeof setTimeout> | undefined;
      await Promise.race([exit, new Promise((resolve) => { graceTimer = setTimeout(resolve, 2000); })]);
      clearTimeout(graceTimer);
      if (!exited) { child.kill("SIGKILL"); await exit; }
    }
    const descriptor = fs.openSync(logPath, "r");
    let tail: string;
    try {
      const size = fs.fstatSync(descriptor).size;
      const buffer = Buffer.alloc(Math.min(size, 3000));
      fs.readSync(descriptor, buffer, 0, buffer.length, Math.max(0, size - buffer.length));
      tail = buffer.toString("utf8").trim();
    } finally { fs.closeSync(descriptor); }
    throw new Error(`${error instanceof Error ? error.message : String(error)}. Logs: ${logPath}${tail ? `\n${tail}` : ""}`);
  }
}
