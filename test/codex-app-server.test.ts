import assert from "node:assert/strict";
import { access, mkdtemp, readFile, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

import { AppServerCodexRunner } from "../src/codex/app-server-runner.js";
import { HybridCodexRunner } from "../src/codex/runner.js";

const fixturesDir = path.join(path.dirname(fileURLToPath(import.meta.url)), "fixtures");

test("uses the Codex V2 initialize, thread, and turn lifecycle", async (t) => {
  const runner = new AppServerCodexRunner({
    codexBin: path.join(fixturesDir, "fake-codex-app-server.mjs"),
    requestTimeoutMs: 2_000
  });
  t.after(() => runner.close());

  const deltas: string[] = [];
  const progress: string[] = [];
  const first = await runner.run({
    prompt: "first",
    cwd: "/tmp/project",
    model: "test-model",
    effort: "high",
    onDelta: async (delta) => {
      deltas.push(delta);
    },
    onProgress: async (message) => {
      progress.push(message);
    }
  });
  assert.equal(first.threadId, "thread-new");
  assert.equal(first.text, "reply:first");
  assert.deepEqual(deltas, ["reply:", "first"]);
  assert.deepEqual(progress, ["working:first"]);
  assert.match(first.raw, /item\/completed/);
  assert.match(first.raw, /turn\/completed/);
  assert.deepEqual(await runner.getRuntimeInfo("/tmp/project", "thread-new"), {
    model: "test-model",
    effort: "high"
  });

  const resumed = await runner.run({
    prompt: "second",
    cwd: "/tmp/project",
    threadId: "thread-existing"
  });
  assert.equal(resumed.threadId, "thread-existing");
  assert.equal(resumed.text, "reply:second");
  assert.deepEqual(await runner.getRuntimeInfo("/tmp/project", "thread-existing"), {
    model: "resumed-model",
    effort: "medium"
  });

  assert.deepEqual(await runner.listSessions(), {
    data: [{ id: "thread-new" }],
    nextCursor: null,
    backwardsCursor: null
  });

  assert.deepEqual(await runner.getHistory("thread-existing"), [
    {
      id: "history-user-1",
      role: "user",
      text: "hello history",
      createdAt: "2023-11-14T22:13:20.000Z"
    },
    {
      id: "history-commentary-1",
      role: "assistant",
      text: "working",
      kind: "progress",
      createdAt: "2023-11-14T22:13:22.000Z"
    },
    {
      id: "history-assistant-1",
      role: "assistant",
      text: "history reply",
      createdAt: "2023-11-14T22:13:22.000Z"
    }
  ]);

  assert.deepEqual(await runner.getRuntimeInfo("/tmp/another-project"), {
    model: "configured-model",
    effort: "high",
    provider: "FixtureProvider"
  });
  assert.deepEqual(await runner.listModels(), [{
    model: "configured-model",
    displayName: "Configured Model",
    description: "Model used by the test fixture.",
    isDefault: true,
    defaultEffort: "medium",
    supportedEfforts: [
      { effort: "medium", description: "Balanced" },
      { effort: "high", description: "Deeper reasoning" }
    ]
  }]);
});

test("interrupts the active V2 turn with both threadId and turnId", async (t) => {
  const runner = new AppServerCodexRunner({
    codexBin: path.join(fixturesDir, "fake-codex-app-server.mjs"),
    requestTimeoutMs: 2_000
  });
  t.after(() => runner.close());

  const run = runner.run({ prompt: "hold", cwd: "/tmp/project", threadId: "thread-stop" });
  const outcome = run.then(
    (value) => ({ value, error: undefined }),
    (error: Error) => ({ value: undefined, error })
  );
  for (let attempt = 0; attempt < 20; attempt += 1) {
    await new Promise((resolve) => setTimeout(resolve, 25));
    await runner.stop("thread-stop");
  }
  const result = await outcome;
  assert.match(result.error?.message ?? "", /interrupted/i);
});

test("auto backend falls back to codex exec for an existing thread", async (t) => {
  const runner = new HybridCodexRunner({
    backend: "auto",
    codexBin: path.join(fixturesDir, "fake-codex-fallback.mjs"),
    timeoutMs: 2_000
  });
  t.after(() => runner.close());

  const result = await runner.run({
    prompt: "continue",
    cwd: fixturesDir,
    threadId: "thread-existing"
  });

  assert.equal(result.threadId, "thread-existing");
  assert.match(result.text, /used codex exec fallback/i);
  assert.match(result.text, /exec-resumed/);
});

test("auto backend waits for app-server exit before exec fallback resumes the thread", async (t) => {
  const cwd = await mkdtemp(path.join(os.tmpdir(), "codex-weixin-app-server-fallback-"));
  const runner = new HybridCodexRunner({
    backend: "auto",
    codexBin: path.join(fixturesDir, "fake-codex-lock-conflict.mjs"),
    timeoutMs: 2_000
  });
  t.after(async () => {
    runner.close();
    await waitForProcessExit(path.join(cwd, "app-server.pid"));
    await rm(cwd, { recursive: true, force: true });
  });

  const fallback = await runner.run({ prompt: "fail-once", cwd, threadId: "thread-lock" });
  assert.equal(fallback.threadId, "thread-lock");
  assert.match(fallback.text, /used codex exec fallback/i);
  assert.match(fallback.text, /exec-resumed/);
  assert.equal(await readFile(path.join(cwd, "exec-started-after-app-server-exit"), "utf8"), "yes");

  const retried = await runner.run({ prompt: "after-fallback", cwd, threadId: "thread-lock" });
  assert.equal(retried.threadId, "thread-lock");
  assert.equal(retried.text, "reply:after-fallback");
});

test("app-server backend does not fall back to exec after an app-server error", async (t) => {
  const cwd = await mkdtemp(path.join(os.tmpdir(), "codex-weixin-app-server-only-"));
  const runner = new HybridCodexRunner({
    backend: "app-server",
    codexBin: path.join(fixturesDir, "fake-codex-lock-conflict.mjs"),
    timeoutMs: 2_000
  });
  t.after(async () => {
    runner.close();
    await waitForProcessExit(path.join(cwd, "app-server.pid"));
    await rm(cwd, { recursive: true, force: true });
  });

  await assert.rejects(
    runner.run({ prompt: "fail-once", cwd, threadId: "thread-lock" }),
    /app-server turn\/start failed/
  );
  await assert.rejects(readFile(path.join(cwd, "exec-was-started"), "utf8"), { code: "ENOENT" });
});

test("a failed turn does not close app-server while another turn is active", async (t) => {
  const cwd = await mkdtemp(path.join(os.tmpdir(), "codex-weixin-app-server-concurrent-fallback-"));
  const runner = new HybridCodexRunner({
    backend: "auto",
    codexBin: path.join(fixturesDir, "fake-codex-lock-conflict.mjs"),
    timeoutMs: 2_000
  });
  t.after(async () => {
    runner.close();
    await waitForProcessExit(path.join(cwd, "app-server.pid"));
    await rm(cwd, { recursive: true, force: true });
  });

  const holdingTurn = runner.run({ prompt: "hold", cwd, threadId: "thread-hold" });
  await waitForFile(path.join(cwd, "hold-turn-started"));

  await assert.rejects(
    runner.run({ prompt: "fail-always", cwd, threadId: "thread-failed" }),
    /simulated app-server turn\/start failed/
  );
  await assert.rejects(readFile(path.join(cwd, "exec-was-started"), "utf8"), { code: "ENOENT" });

  const releaseTurn = await runner.run({ prompt: "release", cwd, threadId: "thread-release" });
  const completedHoldingTurn = await holdingTurn;
  assert.equal(completedHoldingTurn.text, "reply:hold");
  assert.equal(releaseTurn.text, "reply:release");

  const retried = await runner.run({ prompt: "fail-always", cwd, threadId: "thread-failed" });
  assert.equal(retried.threadId, "thread-failed");
  assert.match(retried.text, /exec-resumed/);
});

async function waitForProcessExit(pidFile: string): Promise<void> {
  for (let attempt = 0; attempt < 100; attempt += 1) {
    try {
      const pid = Number(await readFile(pidFile, "utf8"));
      if (!isProcessAlive(pid)) return;
    } catch {
      // The child may not have exited yet.
    }
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  throw new Error(`Timed out waiting for process in ${pidFile} to exit`);
}

async function waitForFile(filePath: string): Promise<void> {
  for (let attempt = 0; attempt < 100; attempt += 1) {
    try {
      await access(filePath);
      return;
    } catch {
      await new Promise((resolve) => setTimeout(resolve, 10));
    }
  }
  throw new Error(`Timed out waiting for ${filePath}`);
}

function isProcessAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ESRCH") return false;
    throw error;
  }
}

test("exec backend uses app-server when true streaming is requested", async (t) => {
  const runner = new HybridCodexRunner({
    backend: "exec",
    codexBin: path.join(fixturesDir, "fake-codex-app-server.mjs"),
    timeoutMs: 2_000
  });
  t.after(() => runner.close());
  const deltas: string[] = [];

  const result = await runner.run({
    prompt: "stream",
    cwd: fixturesDir,
    onDelta: (delta) => {
      deltas.push(delta);
    }
  });

  assert.deepEqual(deltas, ["reply:", "stream"]);
  assert.equal(result.text, "reply:stream");
});

test("streaming fallback to exec sends only the final answer", async (t) => {
  const runner = new HybridCodexRunner({
    backend: "exec",
    codexBin: path.join(fixturesDir, "fake-codex-fallback.mjs"),
    timeoutMs: 2_000
  });
  t.after(() => runner.close());
  const deltas: string[] = [];

  const result = await runner.run({
    prompt: "stream",
    cwd: fixturesDir,
    onDelta: (delta) => {
      deltas.push(delta);
    }
  });

  assert.deepEqual(deltas, []);
  assert.match(result.text, /used codex exec fallback/i);
  assert.match(result.text, /exec-new/);
});


test("applies sandbox and approval policy to startup, new threads and resumed turns", async (t) => {
  for (const sandbox of ["read-only", "workspace-write", "danger-full-access"] as const) {
    for (const approvalPolicy of ["never", "on-request", "untrusted", "on-failure"] as const) {
      const runner = new HybridCodexRunner({ backend: "app-server", execSandbox: sandbox, approvalPolicy,
        codexBin: path.join(fixturesDir, "fake-codex-app-server.mjs"), timeoutMs: 2000 });
      t.after(() => runner.close());
      for (const threadId of [undefined, "existing"]) {
        const result = await runner.run({ cwd: "/tmp/project", prompt: "permissions", threadId });
        const received = JSON.parse(result.text.slice("reply:".length));
        assert.equal(received.thread.sandbox, sandbox);
        assert.equal(received.thread.approvalPolicy, approvalPolicy);
        assert.equal(received.turn.approvalPolicy, approvalPolicy);
        assert.equal(received.turn.sandboxPolicy.type, {
          "read-only": "readOnly", "workspace-write": "workspaceWrite", "danger-full-access": "dangerFullAccess"
        }[sandbox]);
        assert.ok(received.args.includes(`sandbox_mode=${JSON.stringify(sandbox)}`));
        assert.ok(received.args.includes(`approval_policy=${JSON.stringify(approvalPolicy)}`));
      }
      runner.close();
    }
  }
});
