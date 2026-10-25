import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";

// Exercise the detached helper after an update has moved the installer's cwd.
test("restart helper restores launch cwd and retains deployment environment", async (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "bridge-restart-"));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const launchCwd = path.join(root, "launch");
  fs.mkdirSync(launchCwd);
  const output = path.join(root, "result.json");
  const entry = path.join(root, "entry.mjs");
  fs.writeFileSync(entry, 'import fs from "node:fs"; fs.writeFileSync(process.env.RESTART_OUTPUT, JSON.stringify({cwd:process.cwd(),host:process.env.CODEX_WEIXIN_HOST,password:process.env.CODEX_WEIXIN_PASSWORD,hosts:process.env.CODEX_WEIXIN_ALLOWED_HOSTS}));');
  const helper = path.resolve("src/server/restart-helper.ts");
  const child = spawn(process.execPath, ["--import", "tsx", helper, "2147483647", entry, launchCwd], {
    cwd: process.cwd(), env: { ...process.env, RESTART_OUTPUT: output, CODEX_WEIXIN_HOST: "0.0.0.0", CODEX_WEIXIN_PASSWORD: "secret", CODEX_WEIXIN_ALLOWED_HOSTS: "example.com,203.0.113.1" }, stdio: "ignore"
  });
  await new Promise<void>((resolve, reject) => { child.once("error", reject); child.once("exit", () => resolve()); });
  for (let attempt = 0; attempt < 100 && !fs.existsSync(output); attempt++) await new Promise((resolve) => setTimeout(resolve, 20));
  assert.deepEqual(JSON.parse(fs.readFileSync(output, "utf8")), { cwd: fs.realpathSync(launchCwd), host: "0.0.0.0", password: "secret", hosts: "example.com,203.0.113.1" });
});
