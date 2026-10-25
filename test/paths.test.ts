import assert from "node:assert/strict";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import { accountStatePaths, defaultStateDir, resolveStatePaths } from "../src/state/paths.js";

test("uses ~/.codex-weixin-bridge for service state and resolves its config there", () => {
  assert.equal(defaultStateDir(), path.join(os.homedir(), ".codex-weixin-bridge"));
  assert.equal(resolveStatePaths().configPath, path.join(os.homedir(), ".codex-weixin-bridge", "config.json"));
});

test("isolates runtime state and inbound media by account", () => {
  const paths = resolveStatePaths("/tmp/codex-weixin-test");
  const first = accountStatePaths(paths, "bot/one");
  const second = accountStatePaths(paths, "bot-two");

  assert.notEqual(first.statePath, second.statePath);
  assert.notEqual(first.inboundDir, second.inboundDir);
  assert.match(first.statePath, /runtime[/\\]bot-one[/\\]state\.json$/);
  assert.match(first.inboundDir, /inbound[/\\]bot-one$/);
});

test("expands home-relative state directories instead of resolving a literal tilde under cwd", () => {
  assert.equal(resolveStatePaths("~/.codex-weixin-bridge").root, path.join(os.homedir(), ".codex-weixin-bridge"));
  assert.equal(resolveStatePaths("~").configPath, path.join(os.homedir(), "config.json"));
  assert.equal(resolveStatePaths("~someone/state").root, path.resolve("~someone/state"));
  assert.equal(resolveStatePaths("./state").root, path.resolve("./state"));
});
