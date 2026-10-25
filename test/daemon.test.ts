import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";

const entry = path.resolve("src/server/index.ts");
const loader = import.meta.resolve("tsx");
function cli(cwd: string, env: NodeJS.ProcessEnv, args: string[] = []) {
  return new Promise<{ code: number | null; output: string }>((resolve, reject) => {
    const child = spawn(process.execPath, ["--import", loader, entry, ...args], { cwd, env, stdio: ["ignore", "pipe", "pipe"] });
    const timer = setTimeout(() => child.kill("SIGTERM"), 8000);
    let output = "";
    child.stdout.on("data", (data: Buffer) => { output += data; });
    child.stderr.on("data", (data: Buffer) => { output += data; });
    child.once("error", reject);
    child.once("exit", (code) => { clearTimeout(timer); resolve({ code, output }); });
  });
}

test("background CLI returns after ready; restart applies current .env and stop releases service", { timeout: 30_000 }, async (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "bridge-daemon-"));
  const state = path.join(root, "state");
  const env = { ...process.env, HOME: root, CODEX_WEIXIN_STATE_DIR: state, CODEX_WEIXIN_OPEN: "0", CODEX_WEIXIN_PORT: "0" };
  delete env.CODEX_WEIXIN_USERNAME;
  delete env.CODEX_WEIXIN_PASSWORD;
  fs.writeFileSync(path.join(root, ".env"), "CODEX_WEIXIN_USERNAME=before\nCODEX_WEIXIN_PASSWORD=before-secret\n");
  t.after(async () => { await cli(root, env, ["stop"]); fs.rmSync(root, { recursive: true, force: true }); });
  const started = await cli(root, env);
  assert.equal(started.code, 0, started.output);
  const recordFile = path.join(state, "restart-control.json");
  const first = JSON.parse(fs.readFileSync(recordFile, "utf8"));
  assert.equal(fs.existsSync(path.join(state, "logs", "service.log")), true);
  assert.equal((await cli(root, env)).code, 1, "duplicate launch must fail instead of claiming existing process ready");
  fs.writeFileSync(path.join(root, ".env"), "CODEX_WEIXIN_USERNAME=after\nCODEX_WEIXIN_PASSWORD=after-secret\n");
  const restarted = await cli(root, env, ["restart"]);
  assert.equal(restarted.code, 0, restarted.output);
  const next = JSON.parse(fs.readFileSync(recordFile, "utf8"));
  assert.notEqual(next.pid, first.pid);
  const status = await fetch(`http://127.0.0.1:${next.port}/status`, { headers: { Authorization: `Bearer ${next.token}` } }).then((response) => response.json()) as { url: string };
  assert.equal((await fetch(`${status.url}/api/accounts`, { headers: { Authorization: `Basic ${Buffer.from("after:after-secret").toString("base64")}` } })).status, 200);
  assert.equal((await fetch(`${status.url}/api/accounts`, { headers: { Authorization: `Basic ${Buffer.from("before:before-secret").toString("base64")}` } })).status, 401);
  const stopped = await cli(root, env, ["stop"]);
  assert.equal(stopped.code, 0, stopped.output);
  assert.equal(fs.existsSync(recordFile), false);
  assert.equal(fs.existsSync(path.join(state, "service.lock")), false);
  assert.equal((await cli(root, env, ["stop"])).code, 0, "stop is safe when already stopped");
  const startStopped = await cli(root, env, ["restart"]);
  assert.equal(startStopped.code, 0, startStopped.output);
  assert.equal(fs.existsSync(recordFile), true, "restart starts an already stopped service");
});

test("failed background startup exits with useful error and leaves no service lock", { timeout: 15_000 }, async (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "bridge-daemon-fail-"));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const state = path.join(root, "state");
  const result = await cli(root, { ...process.env, HOME: root, CODEX_WEIXIN_STATE_DIR: state, CODEX_WEIXIN_PORT: "invalid", CODEX_WEIXIN_OPEN: "0" });
  assert.equal(result.code, 1);
  assert.match(result.output, /Invalid CODEX_WEIXIN_PORT/);
  assert.equal(fs.existsSync(path.join(state, "service.lock")), false);
});


test("startup timeout terminates only the child it launched", { timeout: 10_000 }, async (t) => {
  const { startBackgroundService } = await import("../src/server/daemon.js");
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "bridge-timeout-"));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const fakeEntry = path.join(root, "not-ready.mjs");
  const pidFile = path.join(root, "pid");
  fs.writeFileSync(fakeEntry, `import fs from "node:fs"; fs.writeFileSync(${JSON.stringify(pidFile)}, String(process.pid)); setInterval(() => {}, 1000);`);
  await assert.rejects(startBackgroundService({ root, entryPath: fakeEntry, timeoutMs: 1500 }), /startup timed out/);
  const pid = Number(fs.readFileSync(pidFile, "utf8"));
  assert.throws(() => process.kill(pid, 0), { code: "ESRCH" });
});

test("occupied port startup reports bind failure and releases acquired lock", { timeout: 15_000 }, async (t) => {
  const http = await import("node:http");
  const listener = http.createServer();
  await new Promise<void>((resolve) => listener.listen(0, "127.0.0.1", resolve));
  t.after(() => new Promise<void>((resolve) => listener.close(() => resolve())));
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "bridge-bind-fail-"));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const state = path.join(root, "state");
  const port = (listener.address() as { port: number }).port;
  const result = await cli(root, { ...process.env, HOME: root, CODEX_WEIXIN_STATE_DIR: state, CODEX_WEIXIN_HOST: "127.0.0.1", CODEX_WEIXIN_PORT: String(port), CODEX_WEIXIN_OPEN: "0" });
  assert.equal(result.code, 1);
  assert.match(result.output, /EADDRINUSE|address already in use/);
  assert.equal(fs.existsSync(path.join(state, "service.lock")), false);
});

test("overlapping stop and SIGTERM wait for the same graceful shutdown", { timeout: 10_000 }, async (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "bridge-shutdown-race-"));
  const state = path.join(root, "state");
  const started = path.join(root, "cleanup-started");
  const completed = path.join(root, "cleanup-completed");
  const fixture = path.join(root, "delayed-service.mjs");
  const managerUrl = new URL("../src/server/account-manager.ts", import.meta.url).href;
  const indexUrl = new URL("../src/server/index.ts", import.meta.url).href;
  fs.writeFileSync(fixture, `
    import fs from "node:fs";
    import { AccountManager } from ${JSON.stringify(managerUrl)};
    const originalStop = AccountManager.prototype.stopAll;
    AccountManager.prototype.stopAll = async function () {
      fs.writeFileSync(${JSON.stringify(started)}, "started");
      await new Promise(resolve => setTimeout(resolve, 300));
      await originalStop.call(this);
      fs.writeFileSync(${JSON.stringify(completed)}, "completed");
    };
    await import(${JSON.stringify(indexUrl)});
  `);
  const child = spawn(process.execPath, ["--import", loader, fixture, "--foreground"], {
    cwd: root, env: { ...process.env, HOME: root, CODEX_WEIXIN_STATE_DIR: state, CODEX_WEIXIN_PORT: "0", CODEX_WEIXIN_OPEN: "0" }, stdio: ["ignore", "pipe", "pipe"]
  });
  const exit = new Promise<void>((resolve) => child.once("exit", () => resolve()));
  t.after(async () => { if (child.exitCode === null && child.signalCode === null) child.kill("SIGTERM"); await exit; fs.rmSync(root, { recursive: true, force: true }); });
  await new Promise<void>((resolve, reject) => {
    child.stdout.on("data", (data: Buffer) => { if (data.toString().includes("is running at")) resolve(); });
    child.once("error", reject);
    child.once("exit", () => reject(new Error("Fixture exited before ready")));
  });
  const record = JSON.parse(fs.readFileSync(path.join(state, "restart-control.json"), "utf8"));
  const response = await fetch(`http://127.0.0.1:${record.port}/stop`, { method: "POST", headers: { Authorization: `Bearer ${record.token}` } });
  await response.arrayBuffer();
  assert.equal(response.status, 202);
  for (let attempt = 0; attempt < 100 && !fs.existsSync(started); attempt++) await new Promise(resolve => setTimeout(resolve, 10));
  assert.equal(fs.existsSync(started), true);
  child.kill("SIGTERM");
  await exit;
  assert.equal(fs.existsSync(completed), true, "second shutdown caller must not exit while first cleanup is pending");
  assert.equal(fs.existsSync(path.join(state, "service.lock")), false);
  assert.equal(fs.existsSync(path.join(state, "restart-control.json")), false);
});
