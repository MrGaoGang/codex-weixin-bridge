#!/usr/bin/env node

import { access, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import readline from "node:readline";

const args = process.argv.slice(2);
const marker = (cwd, name) => path.join(cwd, name);

if (args[0] === "exec") {
  const cwd = process.cwd();
  await writeFile(marker(cwd, "exec-was-started"), "yes");
  const pid = Number(await readFile(marker(cwd, "app-server.pid"), "utf8"));
  let appServerAlive = true;
  try {
    process.kill(pid, 0);
  } catch (error) {
    if (error?.code !== "ESRCH") throw error;
    appServerAlive = false;
  }
  if (appServerAlive) {
    process.stderr.write("exec started before app-server exited\n");
    process.exit(1);
  }
  await writeFile(marker(cwd, "exec-started-after-app-server-exit"), "yes");
  const resumeIndex = args.indexOf("resume");
  const threadId = resumeIndex >= 0 ? args.at(-2) : "thread-from-exec";
  process.stdout.write(`${JSON.stringify({ type: "thread.started", thread_id: threadId })}\n`);
  process.stdout.write(`${JSON.stringify({ type: "item.completed", item: { type: "agent_message", text: "exec-resumed" } })}\n`);
  process.stdout.write(`${JSON.stringify({ type: "turn.completed" })}\n`);
  process.exit(0);
}

if (args[0] !== "app-server") {
  process.stderr.write(`unexpected command: ${args.join(" ")}\n`);
  process.exit(2);
}

let cwd;
let nextTurn = 1;
const rl = readline.createInterface({ input: process.stdin });
const send = (message) => process.stdout.write(`${JSON.stringify(message)}\n`);
const respond = (id, result) => send({ id, result });
const activeTurns = new Map();

function completeTurn(threadId, turnId, prompt) {
  send({
    method: "item/completed",
    params: { threadId, turnId, item: { type: "agentMessage", id: `item-${turnId}`, text: `reply:${prompt}`, phase: "final_answer" } }
  });
  send({ method: "turn/completed", params: { threadId, turn: { id: turnId, status: "completed" } } });
  activeTurns.delete(threadId);
}

rl.on("line", async (line) => {
  const message = JSON.parse(line);
  if (message.method === "initialize") {
    respond(message.id, { userAgent: "fake-codex" });
    return;
  }
  if (message.method === "initialized") return;
  if (message.method === "thread/resume") {
    cwd = message.params.cwd;
    await writeFile(marker(cwd, "app-server.pid"), String(process.pid));
    respond(message.id, { thread: { id: message.params.threadId } });
    return;
  }
  if (message.method === "turn/start") {
    const prompt = message.params.input[0].text;
    if (prompt === "fail-always") {
      send({ id: message.id, error: { code: -32000, message: "simulated app-server turn/start failed" } });
      return;
    }
    const failureConsumed = await access(marker(cwd, "first-turn-failed"))
      .then(() => true, () => false);
    if (prompt === "fail-once" && !failureConsumed) {
      await writeFile(marker(cwd, "first-turn-failed"), "yes");
      send({ id: message.id, error: { code: -32000, message: "simulated app-server turn/start failed" } });
      return;
    }
    const threadId = message.params.threadId;
    const turnId = `turn-${nextTurn++}`;
    activeTurns.set(threadId, { turnId, prompt });
    respond(message.id, { turn: { id: turnId, status: "inProgress" } });
    if (prompt === "hold") {
      await writeFile(marker(cwd, "hold-turn-started"), "yes");
      return;
    }
    if (prompt === "release") {
      for (const [heldThreadId, heldTurn] of activeTurns) {
        setTimeout(() => completeTurn(heldThreadId, heldTurn.turnId, heldTurn.prompt), 5);
      }
      return;
    }
    setTimeout(() => {
      completeTurn(threadId, turnId, prompt);
    }, 5);
    return;
  }
  send({ id: message.id, error: { code: -32601, message: `unsupported method: ${message.method}` } });
});
