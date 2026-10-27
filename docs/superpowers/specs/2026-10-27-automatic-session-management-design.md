# Automatic session management design

## Intent

Let a user optionally enable automatic session management for a WeChat contact. The feature should help keep unrelated topics and long conversations separate while making every automatic switch visible and user-confirmed.

## User-visible behavior

- The WebUI setting has three choices: **Off** (default), **Split by topic**, and **Split by context length**.
- Off preserves current behavior and disables topic/context-length splitting. `/new` remains available for manual session creation; the existing app-server-to-exec fallback behavior is unchanged.
- Split by topic skips extra model calls while the current session has fewer than five user messages, including the incoming message. Once eligible, it checks an incoming message against a compact summary of the active session. It uses the currently configured Codex model only for messages that pass inexpensive candidate checks. An uncertain result continues in the active session.
- Split by context length has an editable token threshold, defaulting to `500000` for GPT-6.1 Sol in Codex. The estimate counts available conversation history and the incoming message; it is approximate and may differ from Codex's actual context usage.
- When either mode detects a split, the bridge asks the user to confirm. It retains the triggering message and attachments while awaiting the answer. On confirmation, it creates a new managed session and sends the retained message there. On rejection or timeout, it sends the retained message to the current session. The previous session remains available via `/resume`.
- Additional ordinary messages received while confirmation is pending are appended to the retained batch; confirmation applies to the whole batch.
- Existing `/new` stays immediate when there is no pending split and is not gated by automatic-management settings. If a batch is pending, the bridge processes that batch in its source session before creating the manually requested session.

## WebUI guidance

Explain each choice inline:

- **Off:** Automatic topic/context-length splitting is disabled. `/new` remains available; app-server fallback behavior is unchanged.
- **Split by topic:** The configured Codex model may be called to judge likely topic changes. Judgments can be wrong; the bridge asks before switching.
- **Split by context length:** The editable token count is an estimate based on available history, not an exact report of Codex's internal context usage. The bridge asks before switching.

Show the threshold input only for context-length mode. Label it in tokens and initialize it to `500000`.

## Goals

- Keep existing sessions and default behavior unchanged unless the user opts in.
- Avoid silently changing the destination session of a message.
- Avoid losing the message that triggered a proposed split.
- Make the cost and uncertainty of topic classification clear before enabling it.

## Non-goals

- Automatically splitting without user confirmation.
- Changing session behavior in Web chat in this iteration; the setting governs inbound WeChat messages.
- Guaranteeing exact token accounting across model providers, tools, images, and hidden Codex context.
- Replacing `/new`, `/resume`, or manual session management.

## Approaches considered

1. **Classify every message with the model.** Simple to reason about, but adds a model call and latency to every message. Rejected because the user specifically wants to limit extra judgment calls.
2. **Cheap candidate checks followed by model classification.** Use lightweight signals to skip obvious continuations, then ask the configured model only for candidates; uncertain cases continue in the current session. Recommended for topic mode because it limits extra calls while preserving semantic judgment.
3. **Rules or text similarity only.** Low cost, but brittle for short messages, implicit topic changes, and related words used in different contexts. Rejected as the sole topic detector.

Context mode is a separate deterministic threshold policy based on an estimate of available history length.

## Constraints and implementation notes

- Settings are global configuration persisted in the existing config file and exposed by the existing `/api/config` endpoint.
- Active session selection, thread history, and session creation are managed by `RuntimeStateStore` and `BridgeService`.
- Topic classification must not add classifier prompts to the user's active thread or create unmanaged user-visible Codex sessions. The implementation must provide an isolated classification path using the configured model; if the current Codex runner cannot do that safely, topic mode must not be exposed until that path is available.
- Pending confirmation must be scoped to the sender, bounded in size and lifetime, and resolved before `/new` or a successful WeChat `/resume Rn` switch.
- Confirmation handling should require an unambiguous affirmative or negative response while a pending split exists. Other messages must not silently discard the retained prompt.
- Context estimates should use the history the bridge can read and explicitly remain estimates. Attachments and hidden/tool context may not be represented exactly.
- Update `CHANGELOG.md` in the same change set as implementation, per repository instructions.

## Resolved implementation details

- Confirmation accepts exact `确认` / `是` / `yes` / `y` / `同意`; rejection accepts exact `取消` / `否` / `no` / `n` / `留在原会话`.
- The pending batch expires after 10 minutes. Expired messages are processed in the source session.
- `/new` resolves any pending batch in the source session before creating the manually requested session. A successful WeChat `/resume Rn` does the same before switching.
- Dismissing a context-length split suppresses further prompts for that session at the same threshold; resetting the session, changing the threshold, or starting a new session allows prompts again.
- Automatic management uses readable text only. Image, video, file, and audio attachments and their prompt descriptions are excluded from context estimates and topic checks. Attachment-only messages do not count toward the five-user-message gate; mixed messages retain their text. Hidden Codex tool context is not counted.
- Classifier calls use `codex exec --ephemeral` with a read-only sandbox, so they do not persist a thread or access the user's workspace.
