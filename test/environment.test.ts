import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { loadEnvironmentFile, parseAllowedHosts } from "../src/server/environment.js";

test("loads cwd .env while preserving exported values including empty strings", (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "bridge-env-"));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const env = { CODEX_WEIXIN_HOST: "127.0.0.1", EMPTY: "" };
  fs.writeFileSync(path.join(root, ".env"), 'CODEX_WEIXIN_HOST=0.0.0.0\nCODEX_WEIXIN_PASSWORD="secret # value"\nEMPTY=replaced\n');
  loadEnvironmentFile(root, env);
  assert.deepEqual(env, { CODEX_WEIXIN_HOST: "127.0.0.1", EMPTY: "", CODEX_WEIXIN_PASSWORD: "secret # value" });
  fs.unlinkSync(path.join(root, ".env"));
  assert.doesNotThrow(() => loadEnvironmentFile(root, env));
});

test("accepts multiple IP and domain entries separated by commas, whitespace or semicolons", () => {
  assert.deepEqual(parseAllowedHosts('203.0.113.1, bridge.example;\n[2001:db8::1] proxy.example:443'),
    ["203.0.113.1", "bridge.example", "[2001:db8::1]", "proxy.example:443"]);
});

test("fresh startup creates its default workspace before serving requests", async (t) => {
  const { spawn } = await import("node:child_process");
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "bridge-fresh-"));
  const workspace = path.join(root, ".codex-weixin-bridge");
  const child = spawn(process.execPath, ["--import", "tsx", "src/server/index.ts"], {
    env: { ...process.env, HOME: root, CODEX_WEIXIN_STATE_DIR: path.join(root, "state"), CODEX_WEIXIN_PORT: "0", CODEX_WEIXIN_OPEN: "0" }, stdio: ["ignore", "pipe", "pipe"]
  });
  t.after(async () => {
    child.kill("SIGTERM");
    await new Promise<void>((resolve) => { if (child.exitCode !== null || child.signalCode !== null) resolve(); else child.once("exit", () => resolve()); });
    fs.rmSync(root, { recursive: true, force: true });
  });
  await new Promise<void>((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error("Service startup timed out")), 5000);
    child.stdout.on("data", (data: Buffer) => { if (data.toString().includes("is running at")) { clearTimeout(timer); resolve(); } });
    child.once("error", reject);
    child.once("exit", () => { clearTimeout(timer); reject(new Error("Service exited before ready")); });
  });
  assert.equal(fs.existsSync(workspace), true);
});
