import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import { defaultConfig, loadConfig, MAX_INBOUND_BYTES, saveConfig } from "../src/state/config.js";
import { resolveStatePaths } from "../src/state/paths.js";

test("uses ~/.codex-weixin-bridge as the default Codex workspace", () => {
  assert.equal(defaultConfig().defaultCwd, path.join(os.homedir(), ".codex-weixin-bridge"));
  assert.deepEqual(defaultConfig().allowedWorkspaces, [path.join(os.homedir(), ".codex-weixin-bridge")]);
  assert.equal(defaultConfig().streamReplies, true);
  assert.equal(defaultConfig().maxInboundBytes, 100 * 1024 * 1024);
});

test("migrates the legacy inbound limit and never exceeds 100 MiB", (t) => {
  const stateDir = fs.mkdtempSync(path.join(os.tmpdir(), "codex-weixin-config-media-"));
  t.after(() => fs.rmSync(stateDir, { recursive: true, force: true }));
  const paths = resolveStatePaths(stateDir);

  fs.writeFileSync(paths.configPath, JSON.stringify({ maxInboundBytes: 50 * 1024 * 1024 }));
  assert.equal(loadConfig(paths, "/tmp/project").maxInboundBytes, MAX_INBOUND_BYTES);

  fs.writeFileSync(paths.configPath, JSON.stringify({ maxInboundBytes: 200 * 1024 * 1024 }));
  assert.equal(loadConfig(paths, "/tmp/project").maxInboundBytes, MAX_INBOUND_BYTES);

  saveConfig(paths, { ...defaultConfig("/tmp/project"), maxInboundBytes: 200 * 1024 * 1024 });
  assert.equal(JSON.parse(fs.readFileSync(paths.configPath, "utf8")).maxInboundBytes, MAX_INBOUND_BYTES);

  fs.writeFileSync(paths.configPath, JSON.stringify({ maxInboundBytes: 25 * 1024 * 1024 }));
  assert.equal(loadConfig(paths, "/tmp/project").maxInboundBytes, 25 * 1024 * 1024);
});

test("enables process progress by default while preserving an explicit opt-out", (t) => {
  const stateDir = fs.mkdtempSync(path.join(os.tmpdir(), "codex-weixin-config-progress-"));
  t.after(() => fs.rmSync(stateDir, { recursive: true, force: true }));
  const paths = resolveStatePaths(stateDir);

  assert.equal(loadConfig(paths, "/tmp/project").streamReplies, true);
  fs.writeFileSync(paths.configPath, JSON.stringify({ streamReplies: false }));
  assert.equal(loadConfig(paths, "/tmp/project").streamReplies, false);
});

test("loads an explicit codex exec sandbox", (t) => {
  const stateDir = fs.mkdtempSync(path.join(os.tmpdir(), "codex-weixin-config-"));
  t.after(() => fs.rmSync(stateDir, { recursive: true, force: true }));
  const paths = resolveStatePaths(stateDir);
  fs.writeFileSync(paths.configPath, JSON.stringify({ codexExecSandbox: "danger-full-access" }));

  assert.equal(loadConfig(paths, "/tmp/project").codexExecSandbox, "danger-full-access");
});

test("rejects an invalid codex exec sandbox", (t) => {
  const stateDir = fs.mkdtempSync(path.join(os.tmpdir(), "codex-weixin-config-"));
  t.after(() => fs.rmSync(stateDir, { recursive: true, force: true }));
  const paths = resolveStatePaths(stateDir);
  fs.writeFileSync(paths.configPath, JSON.stringify({ codexExecSandbox: "unrestricted" }));

  assert.throws(
    () => loadConfig(paths, "/tmp/project"),
    /Invalid codexExecSandbox/
  );
});

test("round trips approval policy and rejects invalid values", (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "codex-policy-"));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const paths = resolveStatePaths(root);
  for (const policy of ["never", "on-request", "untrusted", "on-failure"] as const) {
    saveConfig(paths, { ...defaultConfig(root), codexApprovalPolicy: policy });
    assert.equal(loadConfig(paths).codexApprovalPolicy, policy);
  }
  fs.writeFileSync(paths.configPath, JSON.stringify({ codexApprovalPolicy: "always" }));
  assert.throws(() => loadConfig(paths), /Invalid codexApprovalPolicy/);
});

test("task timeout defaults for old config and persists valid values", (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "codex-timeout-config-"));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const paths = resolveStatePaths(root);
  assert.equal(defaultConfig(root).codexTimeoutMs, 600_000);
  fs.writeFileSync(paths.configPath, "{}");
  assert.equal(loadConfig(paths).codexTimeoutMs, 600_000);
  for (const codexTimeoutMs of [60_000, 1_800_000, 86_400_000]) {
    saveConfig(paths, { ...defaultConfig(root), codexTimeoutMs });
    assert.equal(loadConfig(paths).codexTimeoutMs, codexTimeoutMs);
  }
});

test("rejects invalid task timeouts in configuration files", (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "codex-timeout-invalid-"));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const paths = resolveStatePaths(root);
  for (const codexTimeoutMs of [null, 0, -1, 59_999, 86_400_001, 60_000.5, "600000"]) {
    fs.writeFileSync(paths.configPath, JSON.stringify({ codexTimeoutMs }));
    assert.throws(() => loadConfig(paths), /Invalid codexTimeoutMs/);
  }
});
