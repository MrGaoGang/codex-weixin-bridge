import crypto from "node:crypto";
import fs from "node:fs";
import http from "node:http";
import path from "node:path";

type ControlRecord = { pid: number; port: number; token: string };
export type ServiceStatus = { pid: number; token: string; url: string; startId?: string };
const recordPath = (root: string) => path.join(root, "restart-control.json");

/** Local-only control channel, separate from the public Web listener and login. */
export async function startRestartControl(root: string, restart: () => void, stop?: () => void, url = ""): Promise<{ close: () => Promise<void> }> {
  const token = crypto.randomBytes(32).toString("hex");
  const server = http.createServer((request, response) => {
    response.setHeader("Connection", "close");
    if (request.headers.authorization !== `Bearer ${token}`) {
      response.writeHead(403).end();
      return;
    }
    if (request.method === "GET" && request.url === "/status") {
      response.setHeader("Content-Type", "application/json");
      response.end(JSON.stringify({ pid: process.pid, token, url, startId: process.env.CODEX_WEIXIN_DAEMON_ID }));
      return;
    }
    if (request.method !== "POST" || !["/restart", "/stop"].includes(request.url ?? "") || (request.url === "/stop" && !stop)) {
      response.writeHead(403).end();
      return;
    }
    try {
      response.writeHead(202).end();
      // Acknowledge before shutdown closes this control listener.
      setImmediate(request.url === "/stop" ? stop! : restart);
    } catch {
      response.writeHead(500).end();
    }
  });
  server.requestTimeout = 5000;
  server.headersTimeout = 5000;
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => resolve());
  });
  const port = (server.address() as { port: number }).port;
  const file = recordPath(root);
  try {
    fs.writeFileSync(file, JSON.stringify({ pid: process.pid, port, token }), { mode: 0o600 });
    fs.chmodSync(file, 0o600);
  } catch (error) {
    server.close();
    throw error;
  }
  let closed = false;
  return { async close() {
    if (closed) return;
    closed = true;
    if (readControl(root)?.token === token) fs.rmSync(file, { force: true });
    await new Promise<void>((resolve) => server.close(() => resolve()));
  } };
}

function readControl(root: string): ControlRecord | undefined {
  try {
    const value = JSON.parse(fs.readFileSync(recordPath(root), "utf8")) as ControlRecord;
    if (Number.isInteger(value.pid) && value.pid > 0 && Number.isInteger(value.port) && value.port > 0 && value.port <= 65535
      && typeof value.token === "string" && /^[a-f0-9]{64}$/.test(value.token)) return value;
  } catch { /* Missing or stale control files do not identify a running service. */ }
  return undefined;
}

export async function requestServiceRestart(root: string): Promise<string> {
  const record = readControl(root);
  if (!record) throw new Error(`codex-weixin is not running or does not support restart for ${root}; start the updated service once manually.`);
  let response: Response;
  try {
    response = await fetch(`http://127.0.0.1:${record.port}/restart`, {
      method: "POST", headers: { Authorization: `Bearer ${record.token}` }, signal: AbortSignal.timeout(5000), redirect: "error"
    });
  } catch {
    throw new Error(`Unable to reach codex-weixin for ${root}; the service may not be running.`);
  }
  if (response.status !== 202) throw new Error(`codex-weixin rejected restart (HTTP ${response.status}).`);
  await response.arrayBuffer();
  return record.token;
}

export async function waitForServiceRestart(root: string, previousToken: string, timeoutMs = 20_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const next = readControl(root);
    if (next && next.token !== previousToken) return;
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  throw new Error("Restart was requested, but the service did not become ready in time. Check service logs.");
}


/** Authenticate readiness; a stale file alone cannot claim a service is ready. */
export async function readServiceStatus(root: string): Promise<ServiceStatus | undefined> {
  const record = readControl(root);
  if (!record) return undefined;
  try {
    const response = await fetch(`http://127.0.0.1:${record.port}/status`, {
      headers: { Authorization: `Bearer ${record.token}` }, signal: AbortSignal.timeout(1000), redirect: "error"
    });
    if (!response.ok) return undefined;
    const status = await response.json() as ServiceStatus;
    if (status.pid === record.pid && status.token === record.token && typeof status.url === "string") return status;
  } catch { /* The record may be stale or the service may still be starting. */ }
  return undefined;
}

function lockIsLive(root: string): boolean {
  try {
    const lock = JSON.parse(fs.readFileSync(path.join(root, "service.lock"), "utf8")) as { pid: number };
    if (!Number.isInteger(lock.pid) || lock.pid <= 0) throw new Error("Invalid service lock");
    try { process.kill(lock.pid, 0); return true; }
    catch (error) { return (error as NodeJS.ErrnoException).code !== "ESRCH"; }
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return false;
    // An unreadable lock must never authorize removal or a second service.
    return true;
  }
}

export async function stopService(root: string, timeoutMs = 20_000): Promise<void> {
  const record = readControl(root);
  const status = await readServiceStatus(root);
  if (!status || !record || record.token !== status.token) {
    if (lockIsLive(root)) throw new Error(`Unable to stop codex-weixin for ${root}: running service has no authenticated control channel.`);
    return;
  }
  const response = await fetch(`http://127.0.0.1:${record.port}/stop`, {
    method: "POST", headers: { Authorization: `Bearer ${record.token}` }, signal: AbortSignal.timeout(5000), redirect: "error"
  });
  if (response.status !== 202) throw new Error(`codex-weixin rejected stop (HTTP ${response.status}).`);
  await response.arrayBuffer();
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const next = readControl(root);
    if (!next && !fs.existsSync(path.join(root, "service.lock"))) return;
    if (next && next.token !== record.token) throw new Error("A different codex-weixin process started while stopping; try again.");
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  throw new Error("Service did not stop in time. Check service logs; no process was forcibly terminated.");
}
