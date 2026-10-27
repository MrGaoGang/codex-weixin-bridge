# Automatic Session Management Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Add optional WeChat session management with topic and estimated-context split modes, both requiring user confirmation.

**Architecture:** Persist global mode and token threshold in the existing config. Keep a bounded pending split per sender in bridge runtime state, classify before routing normal WeChat turns, and create/switch sessions only after confirmation. Reuse existing Web settings and account/session APIs; preserve `/new` behavior.

**Tech Stack:** TypeScript, Node.js, existing Codex app-server/exec runner, JSON config/state, vanilla JavaScript WebUI.

**Spec:** `docs/superpowers/specs/2026-10-27-automatic-session-management-design.md`

## Global Constraints

- Automatic session management is off by default.
- Modes are off, split by topic, and split by context length.
- Context threshold is an editable token number with default `500000`.
- Ask for confirmation before creating a new session.
- On confirmation, route the retained triggering message to the new session; on rejection or timeout, route it to the original session.
- The previous session remains available via `/resume`.
- Topic judgment uses the configured Codex model only for candidate messages and must not pollute the active thread or create unmanaged user-visible sessions.
- Context length is an estimate based on readable history and must be described as such in WebUI.
- Keep `/new` immediate when no split is pending; if one is pending, process its held batch in the source session before making the manual session.
- Keep the pre-existing app-server-to-exec fallback session behavior unchanged; off means no topic/context-length split.
- Confirmation replies are exact `确认` / `是` / `yes` / `y` / `同意` or `取消` / `否` / `no` / `n` / `留在原会话`.
- Pending confirmation expires after 10 minutes; other ordinary messages join the retained batch.
- Dismissing a context split suppresses repeat prompts for that same session and threshold.
- Update `CHANGELOG.md` in the same change set.
- No new runtime dependencies. Focused behavior tests verify confirmation routing, persistence, isolation, and failure handling.

## Review Focus

- A sender's confirmation must never activate another sender's pending split; verify sender-keyed lookup and cleanup in Task 3.
- An affirmative/negative response without a pending split must not create or switch sessions; verify command dispatch in Task 4.
- A pending split expiring or being cleared by `/new` or `/resume` must not lose or misroute its retained prompt; verify state lifecycle in Task 3 and routing in Task 4.
- Very long input and history must not overflow token estimation or prompt bounds; verify clamping and threshold comparisons in Task 2.
- Topic classifier failure or uncertainty must continue through the current session without creating a classifier thread in user-visible session state; verify fallback in Task 2.

---

### Task 1: Add automatic-management config and WebUI controls

**Files:**
- Modify: `src/state/config.ts`
- Modify: `src/server/http-server.ts`
- Modify: `src/web/index.html`
- Modify: `src/web/app.js`
- Modify: `CHANGELOG.md`

**Interfaces:**
- Config fields: `automaticSessionMode: "off" | "topic" | "context-length"` and `automaticSessionContextTokens: number`.
- Default config: mode `"off"`, threshold `500000`.

- [x] Add config defaults and validation; accept only the three modes and a positive bounded integer token count.
- [x] Add a select with the three choices and a numeric threshold input shown only for context-length mode.
- [x] Add inline Chinese explanations for candidate model calls, imperfect topic judgment, estimated context usage, and confirmation before switching.
- [x] Load and save both fields through the existing config UI path; keep old config files compatible by supplying defaults.
- [x] Add an Unreleased changelog entry for the user-visible setting.
- [ ] Manually inspect the settings form in desktop and mobile widths; ensure the threshold control is hidden for other modes and defaults to `500000`.

### Task 2: Add context estimation and isolated topic classification

**Files:**
- Create: `src/bridge/automatic-session.ts`
- Create: `src/codex/topic-classifier.ts` (only after confirming an isolated invocation path)
- Modify: `src/codex/runner.ts` or add a focused Codex runner method if needed

**Interfaces:**
- `estimateContextTokens(history: CodexHistoryMessage[], incoming: PromptBufferItem[]): number`
- `classifyTopicChange(input: { summary: string; message: string; model?: string; effort?: string }): Promise<"same" | "new" | "uncertain">`
- Topic classification must use a non-persistent/isolated Codex invocation; if unavailable, do not expose an unsafe fallback that creates a normal thread.

- [x] Inspect local Codex CLI/app-server capabilities to select an isolated one-shot path that honors the configured model and effort.
- [x] Implement a conservative character-based token estimate over readable history and incoming text/attachment descriptions; clamp intermediate arithmetic safely.
- [x] Build a compact current-topic summary from available history without copying full history into the classifier call.
- [x] Implement a strict structured classifier result; malformed output, runner errors, or uncertain decisions return `"uncertain"` and continue in the current session.
- [x] If no safe isolated path is available, leave topic mode disabled at config validation/UI with a clear explanation rather than creating a classifier thread.
- [x] Manually inspect representative classification prompt and verify it excludes attachment local paths and other private/internal metadata.

### Task 3: Persist and manage pending split confirmations

**Files:**
- Modify: `src/state/runtime-state.ts`
- Modify: `src/bridge/service.ts`
- Modify: `CHANGELOG.md`

**Interfaces:**
- Add `PendingSessionSplit` containing sender ID, source session ID, reason, retained prompt items, and expiry timestamp.
- Store at most one pending split per sender; choose a 10-minute timeout.
- Exact replies while pending: `是` / `确认` / `yes` to accept; `否` / `取消` / `no` to reject.

- [x] Add state-store operations to create, get, and clear a pending split keyed by sender; normalize old runtime state without pending data.
- [x] Bound retained text/attachment count and enforce expiry when reading pending state.
- [x] On expiry, route retained items to the source session and clear pending state; if delivery cannot be completed, preserve retryable state rather than dropping it.
- [x] Resolve pending messages in their source session before `/new` or a successful `/resume` switch; do not drop pending input.
- [x] Keep pending state isolated by sender and include only the split reason in the confirmation prompt.

### Task 4: Integrate split detection and confirmed message routing

**Files:**
- Modify: `src/bridge/service.ts`
- Modify: `src/state/runtime-state.ts` if transition helpers are needed
- Modify: `CHANGELOG.md`

**Interfaces:**
- Split detection runs only for ordinary inbound messages when mode is not off and the current session already has a thread.
- Confirmation activates a new session preserving workspace, model, effort, and stream overrides, then submits the retained message there.
- Rejection submits the retained message to the original session.

- [x] Route supported confirmation replies before normal command/message handling.
- [x] Implement `/new` and `/resume` pending-state clearing as specified by Task 3.
- [x] In topic mode, use inexpensive candidate checks first; only candidates call the isolated classifier, and only `"new"` asks for confirmation.
- [x] In context mode, compare estimated usage against configured threshold and ask for confirmation when reached.
- [x] Ensure threshold detection does not ask repeatedly while a confirmation is pending.
- [x] Preserve the originating session ID while sending a rejected/expired prompt so a later active-session change cannot misroute it.
- [x] Exercise focused behavior tests for default off, confirmation, rejection, expiry, classifier uncertainty/failure, sender isolation, persistence, and send failure without duplicate task execution. Existing tests cover manual commands and attachments.

### Task 5: Update user documentation

**Files:**
- Modify: `README.md`
- Modify: `README.en.md`
- Modify: `CHANGELOG.md`

- [x] Document the three modes, default-off behavior, confirmation replies, timeout behavior, model-call cost, and estimated context count in Chinese and English.
- [x] Clarify that `/new` remains an immediate manual command and `/resume` still switches to retained sessions.
- [x] Review all user-facing copy for consistent distinction between a proposed split and a created session.

## Verification record

- `npm run build`: passed.
- `node --check src/web/app.js`: passed.
- Full existing/new regression suite: passed (one pre-existing skip).
- `test/automatic-session.test.ts`: 10 focused behavior tests passed.
- Browser rendering and a live paid-model classifier call were not exercised.
- Changes remain in the main working tree; the running service was not restarted.
