#!/usr/bin/env node
import fs from "node:fs";
import { fileURLToPath } from "node:url";

import open from "open";

import { defaultConfig, loadConfig } from "../state/config.js";
import { resolveStatePaths } from "../state/paths.js";
import { AccountManager } from "./account-manager.js";
import { parseServerCommand, serverHelpText } from "./arguments.js";
import { loadEnvironmentFile, parseAllowedHosts } from "./environment.js";
import { startLocalHttpServer } from "./http-server.js";
import { acquireServiceProcessLock } from "./process-lock.js";
import { launchRestartHelper } from "./restart.js";

async function main(): Promise<void> {
  const launchCwd = process.cwd();
  loadEnvironmentFile(launchCwd);
  const launchEnv = { ...process.env };
  const stateDir = process.env.CODEX_WEIXIN_STATE_DIR;
  const port = parsePort(process.env.CODEX_WEIXIN_PORT);
  const paths = resolveStatePaths(stateDir);
  const configuredWorkspace = loadConfig(paths).defaultCwd;
  if (configuredWorkspace === defaultConfig().defaultCwd) {
    fs.mkdirSync(configuredWorkspace, { recursive: true });
  }
  const processLock = acquireServiceProcessLock(paths.root);
  const accountManager = new AccountManager({ paths });
  let server: Awaited<ReturnType<typeof startLocalHttpServer>> | undefined;
  let shuttingDown = false;
  let restartScheduled = false;
  const shutdown = async () => {
    if (shuttingDown) return;
    shuttingDown = true;
    try {
      await accountManager.stopAll();
      await server?.close();
    } finally {
      processLock.release();
    }
  };
  const scheduleRestart = (version: string) => {
    if (restartScheduled) return;
    restartScheduled = true;
    const timer = setTimeout(() => {
      try {
        launchRestartHelper({
          parentPid: process.pid,
          entryPath: fileURLToPath(import.meta.url),
          stateDir: paths.root,
          port,
          cwd: launchCwd,
          env: launchEnv
        });
      } catch (error) {
        restartScheduled = false;
        console.error(`[codex-weixin] unable to restart after update: ${error instanceof Error ? error.message : String(error)}`);
        return;
      }
      console.log(`[codex-weixin] updated to ${version}; restarting`);
      void shutdown().finally(() => process.exit(0));
    }, 500);
    timer.unref();
  };
  try {
    server = await startLocalHttpServer({
      paths,
      accountManager,
      port,
      username: process.env.CODEX_WEIXIN_USERNAME,
      password: process.env.CODEX_WEIXIN_PASSWORD,
      host: process.env.CODEX_WEIXIN_HOST || "127.0.0.1",
      allowedHosts: parseAllowedHosts(process.env.CODEX_WEIXIN_ALLOWED_HOSTS),
      onUpdateInstalled: scheduleRestart
    });
    await accountManager.startAll();
  } catch (error) {
    await accountManager.stopAll();
    await server?.close();
    processLock.release();
    throw error;
  }

  console.log(`codex-weixin is running at ${server.url}`);
  console.log(`State directory: ${paths.root}`);
  if (process.env.CODEX_WEIXIN_OPEN !== "0") {
    void open(server.url).catch((error: unknown) => {
      console.warn(`Unable to open the browser automatically: ${error instanceof Error ? error.message : String(error)}`);
    });
  }

  process.once("SIGINT", () => void shutdown().finally(() => process.exit(0)));
  process.once("SIGTERM", () => void shutdown().finally(() => process.exit(0)));
}

function parsePort(value: string | undefined): number {
  if (!value) return 8787;
  const port = Number(value);
  if (!Number.isInteger(port) || port < 0 || port > 65535) {
    throw new Error(`Invalid CODEX_WEIXIN_PORT: ${value}`);
  }
  return port;
}

async function run(): Promise<void> {
  const command = parseServerCommand(process.argv.slice(2));
  if (command === "help") {
    console.log(serverHelpText());
    return;
  }
  await main();
}

run().catch((error) => {
  console.error(error instanceof Error ? error.message : String(error));
  process.exitCode = 1;
});
