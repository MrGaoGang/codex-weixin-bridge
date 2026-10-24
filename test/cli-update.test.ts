import assert from "node:assert/strict";
import test from "node:test";

import { runCliUpdate, type CliUpdateDependencies } from "../src/server/cli-update.js";
import type { UpdateStatus } from "../src/server/update-manager.js";
import type { ServiceStatus } from "../src/server/restart-control.js";

const runningService: ServiceStatus = {
  pid: 1234,
  token: "service-token",
  url: "http://127.0.0.1:8787"
};

const latestAvailable: UpdateStatus = {
  currentVersion: "1.2.3",
  latestVersion: "1.2.4",
  updateAvailable: true,
  checkedAt: "2026-10-24T00:00:00.000Z",
  registry: "official"
};

function makeOptions(
  status: UpdateStatus = latestAvailable,
  install: () => Promise<{ version: string; registry: "official" | "npmmirror" }> = async () => ({
    version: "1.2.4",
    registry: "official"
  }),
  installable = true
) {
  const calls: string[] = [];
  return {
    calls,
    options: {
      root: "/home/tester/.codex-weixin-bridge",
      cwd: "/home/tester",
      env: { CODEX_WEIXIN_OPEN: "0" },
      entryPath: "/usr/lib/node_modules/@agent-dev-net/weixin-bridge/dist/server/index.js",
      installable,
      updater: {
        async check(force?: boolean) {
          calls.push(`check:${force}`);
          return status;
        },
        async installLatest() {
          calls.push("install");
          return install();
        }
      }
    }
  };
}

function dependencies(calls: string[], running: boolean, stop?: () => Promise<void>): CliUpdateDependencies {
  return {
    async readStatus(root) {
      assert.equal(root, "/home/tester/.codex-weixin-bridge");
      calls.push("readStatus");
      return running ? runningService : undefined;
    },
    async stop(root) {
      assert.equal(root, "/home/tester/.codex-weixin-bridge");
      calls.push("stop");
      await stop?.();
    },
    async start(options) {
      assert.equal(options.root, "/home/tester/.codex-weixin-bridge");
      assert.equal(options.cwd, "/home/tester");
      assert.equal(options.entryPath, "/usr/lib/node_modules/@agent-dev-net/weixin-bridge/dist/server/index.js");
      calls.push("start");
      return { ...runningService, logPath: "/home/tester/.codex-weixin-bridge/logs/service.log" };
    },
    log() {}
  };
}

test("rejects source checkout before checking versions or stopping the service", async () => {
  const { calls, options } = makeOptions(latestAvailable, undefined, false);
  await assert.rejects(runCliUpdate(options, dependencies(calls, true)), /source checkout/i);
  assert.deepEqual(calls, []);
});

test("does not stop or install when registry version check fails", async () => {
  const status: UpdateStatus = { ...latestAvailable, updateAvailable: false, error: "registry unavailable" };
  const { calls, options } = makeOptions(status);
  await assert.rejects(runCliUpdate(options, dependencies(calls, true)), /Unable to verify/);
  assert.deepEqual(calls, ["check:true"]);
});

test("stops, installs, and starts after an available update", async () => {
  const { calls, options } = makeOptions();
  await runCliUpdate(options, dependencies(calls, true));
  assert.deepEqual(calls, ["check:true", "readStatus", "stop", "install", "start"]);
});

test("does not reinstall or restart a running service when already current", async () => {
  const status: UpdateStatus = { ...latestAvailable, latestVersion: "1.2.3", updateAvailable: false };
  const { calls, options } = makeOptions(status);
  await runCliUpdate(options, dependencies(calls, true));
  assert.deepEqual(calls, ["check:true", "readStatus"]);
});

test("starts a stopped service when already current", async () => {
  const status: UpdateStatus = { ...latestAvailable, latestVersion: "1.2.3", updateAvailable: false };
  const { calls, options } = makeOptions(status);
  await runCliUpdate(options, dependencies(calls, false));
  assert.deepEqual(calls, ["check:true", "readStatus", "start"]);
});

test("restores a previously running service after installation fails", async () => {
  const { calls, options } = makeOptions(latestAvailable, async () => {
    throw new Error("npm update failed");
  });
  const messages: string[] = [];
  const deps = dependencies(calls, true);
  deps.log = (message) => messages.push(message);
  await assert.rejects(runCliUpdate(options, deps), /npm update failed/);
  assert.deepEqual(calls, ["check:true", "readStatus", "stop", "install", "start"]);
  assert.match(messages[0] ?? "", /restarted the service from the installed package/);
});

test("does not install when the running service cannot be stopped", async () => {
  const { calls, options } = makeOptions();
  const deps = dependencies(calls, true, async () => {
    throw new Error("service stop failed");
  });
  await assert.rejects(runCliUpdate(options, deps), /service stop failed/);
  assert.deepEqual(calls, ["check:true", "readStatus", "stop"]);
});
