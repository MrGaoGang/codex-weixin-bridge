# CLI update and cwb Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans task-by-task.

**Goal:** Add a CLI `update` command and make `cwb` an alias of `codex-weixin`.

**Architecture:** Reuse `UpdateManager` for current-runtime validation, latest stable version checks, and package installation. A testable CLI update orchestrator will preserve the selected behavior: stop before an actual install, then ensure the service is running; if install fails, best-effort restart a service that was running before and report recovery results. npm may have partially changed package files, so this is not a guaranteed package rollback. Both npm bins point to the existing CLI entry.

**Tech Stack:** TypeScript, Node.js, npm package `bin`, `node:test`.

**Spec:** `docs/superpowers/specs/2026-10-24-cli-update-and-cwb-design.md`

## Global Constraints

- Update `@agent-dev-net/weixin-bridge` to the latest stable npm version; do not update all transitive dependencies or Git source checkouts.
- Stop a running service before package replacement; after a successful update ensure the service is running.
- If already current, do not reinstall or restart a running service; start the service if it was stopped.
- `codex-weixin` and `cwb` must share the same entry point and command behavior.
- Check source-checkout support before stopping any running service.

## Review Focus

- Source checkout: `update` must fail before stopping a running service. Test: unsupported-runtime path calls neither stop nor start.
- Already-current runtime: do not unnecessarily reinstall or restart; start only if stopped. Test: both ready and stopped service cases.
- npm install failure: best-effort restart if the service was previously running, preserve the install error, and report a restart failure. Test: install rejects, then start runs and the original install error remains visible.
- Running but not ready service: authenticated stop failure must prevent package installation. Test: stop rejection leaves install and start uncalled.
- Alias packaging: both commands resolve to the same entry. Test: `package.json` bin map and help output mention both commands.

---

### Task 1: Implement and test CLI update lifecycle

**Files:**
- Create: `src/server/cli-update.ts`
- Modify: `src/server/update-manager.ts`
- Modify: `src/server/index.ts`
- Modify: `src/server/arguments.ts`
- Test: `test/cli-update.test.ts`
- Test: `test/server-arguments.test.ts`

**Interfaces:**
- `isCurrentRuntimeInstallable(): boolean` in `src/server/update-manager.ts` reports whether `CURRENT_PACKAGE_ROOT` resolves to an npm install target.
- Export `readProductVersion(): string` from `src/server/http-server.ts` so CLI and Web use the same package version reader.
- `runCliUpdate(options: CliUpdateOptions, dependencies?: Partial<CliUpdateDependencies>): Promise<void>` in `src/server/cli-update.ts`.
- `CliUpdateOptions` contains `root: string`, `cwd: string`, `env: NodeJS.ProcessEnv`, `entryPath: string`, `installable: boolean`, and `updater: Pick<UpdateService, "check" | "installLatest">`.
- `CliUpdateDependencies` contains `readStatus(root: string): Promise<ServiceStatus | undefined>`, `stop(root: string): Promise<void>`, `start(options: { root: string; entryPath: string; cwd: string; env: NodeJS.ProcessEnv }): Promise<ServiceStatus & { logPath: string }>`, and `log(message: string): void`. Defaults use `readServiceStatus`, `stopService`, `startBackgroundService`, and `console.log`.
- `ServerCommand` adds `"update"`.

- [x] **Step 1: Write failing orchestration tests**

Add tests for source checkout (no stop/install/start), registry check failure (no stop/install/start), update available (check → stop → install → start), already current with a running service (no restart), already current with a stopped service (start), install failure restoring a previously running service, and stop failure preventing install.

- [x] **Step 2: Run the tests and verify expected failures**

Run: `node --test --import tsx test/cli-update.test.ts test/server-arguments.test.ts`

Expected: fail because the update orchestrator and `update` command do not exist.

- [x] **Step 3: Implement the updateability check and `runCliUpdate`**

Before service changes, reject source checkouts and failed version checks. On an available update, stop safely, call `installLatest`, then start with the supplied launch directory and environment. If installation fails and status showed a running service, attempt a restart and preserve the installation failure in the reported error.

- [x] **Step 4: Wire `update` into CLI dispatch and help**

In `src/server/index.ts`, load the launch-directory `.env`, capture `process.cwd()` and `process.env`, then call `runCliUpdate` with the configured state root, current entry path, package version, and `UpdateManager`. The command path does not start another background service before update handling.

- [x] **Step 5: Run the focused tests**

Run: `node --test --import tsx test/cli-update.test.ts test/server-arguments.test.ts`

Expected: all lifecycle and argument tests pass.

### Task 2: Publish both CLI command names and document them

**Files:**
- Modify: `package.json`
- Modify: `README.md`
- Modify: `README.en.md`
- Test: `test/server-arguments.test.ts`

**Interfaces:**
- `package.json` exposes `codex-weixin` and `cwb`, both targeting `dist/server/index.js`.

- [x] **Step 1: Add failing alias/help assertions**

Assert that `serverHelpText()` documents `codex-weixin update` and `cwb update`; inspect the bin map in a test to assert both keys point to the same entry.

- [x] **Step 2: Run the focused test and verify it fails**

Run: `node --test --import tsx test/server-arguments.test.ts`

Expected: fail because `cwb` and the update help text are absent.

- [x] **Step 3: Add the alias, help text, and README instructions**

Document `codex-weixin update` / `cwb update`, latest stable bridge-package behavior, and the post-update service startup behavior in Chinese and English.

- [x] **Step 4: Verify tests and types**

Run: `node --test --import tsx test/server-arguments.test.ts` and `npm run typecheck`.

Expected: focused tests pass and TypeScript exits 0.

### Final verification

- [x] Run `npm test` and `npm run typecheck`.
- [x] Run `npm run build` to confirm the published CLI entry builds with both npm bin names.
