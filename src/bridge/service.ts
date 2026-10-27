import path from "node:path";
import { AccessController } from "./access.js";
import { parseActionBlocks } from "./actions.js";
import { buildTopicSummary, estimateContextTokens, isTopicCandidate, sanitizeTopicText } from "./automatic-session.js";
import { buildPrompt, buildPromptPreview, chunkText, parsePrompt } from "./format.js";
import { PromptBuffer } from "./prompt-buffer.js";
import type { CodexModelOption, CodexRuntimeInfo } from "../codex/app-server-runner.js";
import { HybridCodexRunner } from "../codex/runner.js";
import { classifyTopicChange } from "../codex/topic-classifier.js";
import { isWorkspaceAllowed, type CodexWeixinConfig } from "../state/config.js";
import { RuntimeStateStore, type ManagedSession, type PendingSessionSplit } from "../state/runtime-state.js";
import { WeixinApiClient, isStaleContextError, type FetchLike } from "../weixin/api.js";
import { downloadInboundAttachments, InboundMediaTooLargeError, sendLocalMediaFile } from "../weixin/media.js";
import type { NormalizedWeixinMessage } from "../weixin/messages.js";
import type { PromptBufferItem } from "./prompt-buffer.js";

const PENDING_SPLIT_TIMEOUT_MS = 10 * 60_000;

export type BridgeServiceOptions = {
  config: CodexWeixinConfig;
  stateStore: RuntimeStateStore;
  weixin: WeixinApiClient;
  runner?: HybridCodexRunner;
  listCodexModels?: () => Promise<CodexModelOption[]>;
  inboundDir?: string;
  mediaFetch?: FetchLike;
  onTurnStatus?: (status: { senderId: string; sessionId: string; active: boolean }) => void;
};

export class BridgeService {
  private readonly access: AccessController;
  private readonly buffers: PromptBuffer;
  private readonly runner: HybridCodexRunner;
  private readonly pendingSplitTimers = new Map<string, NodeJS.Timeout>();
  private readonly pendingSplitRuns = new Map<string, Promise<void>>();
  private closed = false;

  async close(): Promise<void> {
    this.closed = true;
    for (const timer of this.pendingSplitTimers.values()) clearTimeout(timer);
    this.pendingSplitTimers.clear();
    await Promise.allSettled(this.pendingSplitRuns.values());
  }

  constructor(private readonly options: BridgeServiceOptions) {
    this.access = new AccessController({
      allowedSenderIds: options.config.allowedSenderIds,
      pairedSenderIds: options.stateStore.listPairedSenderIds()
    });
    this.buffers = new PromptBuffer({
      maxItems: options.config.maxBufferItems,
      ttlMs: options.config.promptBufferTtlMs
    });
    this.runner = options.runner ?? new HybridCodexRunner({
      backend: options.config.codexBackend,
      codexBin: options.config.codexBin,
      execSandbox: options.config.codexExecSandbox
    });
    for (const pending of options.stateStore.listPendingSessionSplits()) {
      if (!pending.decision) this.schedulePendingSplitExpiry(pending);
    }
  }

  async handleMessage(message: NormalizedWeixinMessage): Promise<void> {
    if (message.contextToken) {
      this.options.stateStore.rememberContextToken(message.senderId, message.contextToken);
    }

    const access = this.access.requireAccess(message.senderId);
    if (!access.allowed) {
      await this.reply(message.senderId, access.message);
      return;
    }
    this.options.stateStore.setPairedSenderIds(this.access.listPairedSenderIds());
    this.options.stateStore.ensureActiveSession(message.senderId, this.options.config.defaultCwd);

    const command = parseCommand(message.text);
    if (command) {
      await this.handleCommand(message, command);
      return;
    }

    const items = await this.promptItemsFromMessageWithNotice(message);
    if (!items) return;

    const pending = this.options.stateStore.getPendingSessionSplit(message.senderId);
    if (pending) {
      if (!pending.decision && pending.expiresAt <= Date.now()) {
        await this.resolvePendingSessionSplit(message.senderId, "reject", true);
        if (!message.attachments?.length && parseSplitConfirmation(message.text)) return;
      } else {
        const decision = message.attachments?.length ? undefined : parseSplitConfirmation(message.text);
        if (decision) {
          await this.resolvePendingSessionSplit(message.senderId, decision);
          return;
        }
        if (pending.items.length + items.length > this.options.config.maxBufferItems) {
          const fallbackSessionId = pending.decision === "accept"
            ? pending.targetSessionId ?? pending.sourceSessionId
            : pending.sourceSessionId;
          if (!pending.decision) await this.resolvePendingSessionSplit(message.senderId, "reject");
          else await this.runPendingSessionSplit(pending);
          await this.runCodexTurn(message, "", items, { sessionId: fallbackSessionId, skipAutomaticManagement: true });
          return;
        }
        pending.items.push(...items);
        this.options.stateStore.setPendingSessionSplit(pending);
        if (pending.decision) {
          await this.runPendingSessionSplit(pending);
          return;
        }
        await this.reply(message.senderId, "这条消息也已暂存。请回复“确认”或“取消”；超时后会在原会话中处理。");
        return;
      }
    }

    if (this.buffers.isActive(message.senderId)) {
      for (const item of items) {
        this.buffers.append(message.senderId, item);
      }
      await this.reply(message.senderId, "Buffered. Send /prompt done when ready.");
      return;
    }

    await this.runCodexTurn(message, "", items);
  }

  private async handleCommand(message: NormalizedWeixinMessage, command: { name: string; arg: string }): Promise<void> {
    switch (command.name) {
      case "help":
      case "h":
        await this.reply(message.senderId, helpText());
        return;
      case "status":
      case "where":
        await this.reply(message.senderId, await this.statusText(message.senderId));
        return;
      case "bind":
        await this.bindWorkspace(message.senderId, command.arg);
        return;
      case "new":
        await this.resolvePendingSessionSplit(message.senderId, "reject");
        this.options.stateStore.createSession(message.senderId, this.options.stateStore.getWorkspace(message.senderId) ?? this.options.config.defaultCwd);
        await this.reply(message.senderId, "Created a new Codex session for the next message.");
        return;
      case "resume":
        await this.handleResumeCommand(message.senderId, command.arg);
        return;
      case "model":
        await this.handleModelCommand(message.senderId, command.arg);
        return;
      case "effort":
        await this.handleEffortCommand(message.senderId, command.arg);
        return;
      case "stream":
        await this.handleStreamCommand(message.senderId, command.arg);
        return;
      case "prompt":
        await this.handlePromptCommand(message.senderId, command.arg);
        return;
      case "stop":
        await this.runner.stop(this.options.stateStore.getThread(message.senderId));
        await this.reply(message.senderId, "Stop signal sent.");
        return;
      default:
        await this.reply(message.senderId, `Unknown command: /${command.name}. Send /help.`);
    }
  }

  private async bindWorkspace(senderId: string, rawPath: string): Promise<void> {
    if (!rawPath.trim()) {
      await this.reply(senderId, "Usage: /bind <absolute-workspace-path>");
      return;
    }
    const workspace = path.resolve(rawPath.trim());
    if (!isWorkspaceAllowed(workspace, this.options.config.allowedWorkspaces)) {
      await this.reply(senderId, `Workspace is not allowed: ${workspace}`);
      return;
    }
    this.options.stateStore.setWorkspace(senderId, workspace);
    await this.reply(senderId, `Bound to workspace:\n${workspace}`);
  }

  private async handleResumeCommand(senderId: string, arg: string): Promise<void> {
    const sessions = this.options.stateStore.listSessions().filter((session) => session.senderId === senderId);
    const input = arg.trim();
    if (!input) {
      const activeId = this.options.stateStore.getActiveSession(senderId)?.id;
      const previews = await Promise.all(sessions.map((session) => this.sessionPromptPreview(session)));
      const lines = ["历史会话（最近更新优先）："];
      for (const [index, session] of sessions.entries()) {
        lines.push(
          `[R${index + 1}] ${session.id === activeId ? "【当前】" : ""}${session.title}`,
          `   最近内容：${previews[index]}（${formatSessionTime(session.updatedAt)}）`
        );
      }
      lines.push("", "发送 /resume R1 这类切换编号继续会话；R1 是切换编号，“会话 6”等是会话名称。");
      for (const chunk of chunkText(lines.join("\n"))) {
        await this.reply(senderId, chunk);
      }
      return;
    }
    if (/^\d+$/.test(input)) {
      await this.reply(senderId, "请使用列表中 R 开头的切换编号，例如 /resume R1；不要使用会话名称里的数字。");
      return;
    }
    const match = /^r([1-9]\d*)$/i.exec(input);
    if (!match) {
      await this.reply(senderId, "用法：/resume 或 /resume R<编号>，例如 /resume R1。");
      return;
    }
    const selected = sessions[Number(match[1]) - 1];
    if (!selected) {
      await this.reply(senderId, "没有这个切换编号。发送 /resume 查看可用的 R 编号。");
      return;
    }
    const preview = await this.sessionPromptPreview(selected);
    await this.resolvePendingSessionSplit(senderId, "reject");
    this.options.stateStore.activateSession(selected.id);
    await this.reply(senderId, [
      `已通过 ${input.toUpperCase()} 切换到：${selected.title}`,
      `最近内容：${preview}`,
      selected.threadId ? "下一条消息将继续该历史会话。" : "该会话尚无历史内容，下一条消息将创建新上下文。"
    ].join("\n"));
  }

  private async sessionPromptPreview(session: ManagedSession): Promise<string> {
    if (session.lastPromptPreview) return session.lastPromptPreview;
    if (!session.threadId) return "尚未开始对话";
    try {
      const history = await this.runner.getHistory(session.threadId);
      const lastUserMessage = [...history].reverse().find((message) => message.role === "user");
      if (!lastUserMessage) return "暂无内容摘要";
      const parsed = parsePrompt(lastUserMessage.text);
      const preview = buildPromptPreview(parsed.text, parsed.attachments);
      if (!preview) return "暂无内容摘要";
      this.options.stateStore.setSessionPromptPreview(session.id, preview);
      return preview;
    } catch (error) {
      console.warn(`Unable to read Codex history for session ${session.id}: ${error instanceof Error ? error.message : String(error)}`);
      return "历史摘要暂不可用";
    }
  }

  private async handlePromptCommand(senderId: string, arg: string): Promise<void> {
    const sub = arg.trim().toLowerCase();
    if (sub === "start") {
      const result = this.buffers.start(senderId);
      await this.reply(senderId, result.status === "started" ? "Prompt buffer started." : "Prompt buffer is already active.");
      return;
    }
    if (sub === "done") {
      const flushed = this.buffers.done(senderId);
      if (flushed.status === "empty") {
        await this.reply(senderId, "Prompt buffer is empty.");
        return;
      }
      await this.runCodexTurn({ id: "buffer", senderId, text: "", attachments: [], raw: {} }, "", flushed.items);
      return;
    }
    await this.reply(senderId, "Usage: /prompt start or /prompt done");
  }

  private async handleModelCommand(senderId: string, arg: string): Promise<void> {
    const models = await this.listCodexModels();
    const input = arg.trim();
    if (!input) {
      const runtime = await this.effectiveRuntime(senderId);
      const session = this.options.stateStore.getActiveSession(senderId);
      const lines = [
        `当前模型：${runtime.model ?? "Codex 默认"}${session?.model ? "（本会话）" : "（继承 Web/Codex 设置）"}`
      ];
      if (models.length) {
        lines.push("", "可用模型：", ...models.map((model, index) => `${index + 1}. ${model.displayName}（${model.model}）`));
        lines.push("", "发送 /model <序号或模型 ID> 切换；/model default 恢复继承设置。");
      } else {
        lines.push("", "暂时无法读取模型列表。仍可发送 /model <完整模型 ID> 切换。", "/model default 恢复继承设置。");
      }
      await this.reply(senderId, lines.join("\n"));
      return;
    }
    if (input.toLowerCase() === "default") {
      this.options.stateStore.setModelOverride(senderId);
      const runtime = await this.effectiveRuntime(senderId);
      await this.reply(senderId, `已恢复继承 Web/Codex 模型设置。\n当前模型：${runtime.model ?? "Codex 默认"}`);
      return;
    }

    const selected = selectModel(models, input);
    if (!selected && (models.length || !isPlausibleModelId(input))) {
      await this.reply(senderId, "模型不存在。发送 /model 查看可用模型，或使用 /model default 恢复继承设置。");
      return;
    }
    const currentRuntime = await this.effectiveRuntime(senderId);
    const model = selected?.model ?? input;
    this.options.stateStore.setModelOverride(senderId, model);
    let adjustedEffort: string | undefined;
    if (currentRuntime.effort && selected?.supportedEfforts.length && !selected.supportedEfforts.some((option) => option.effort === currentRuntime.effort)) {
      adjustedEffort = selected.supportedEfforts.some((option) => option.effort === selected.defaultEffort)
        ? selected.defaultEffort
        : selected.supportedEfforts[0]?.effort;
      this.options.stateStore.setEffortOverride(senderId, adjustedEffort);
    }
    await this.reply(senderId, [
      `本会话模型已切换为：${selected?.displayName ?? model}（${model}）`,
      ...(adjustedEffort ? [`原来的推理强度不受该模型支持，已自动调整为：${formatEffort(adjustedEffort)}`] : []),
      "下一条消息开始生效。"
    ].join("\n"));
  }

  private async handleEffortCommand(senderId: string, arg: string): Promise<void> {
    const models = await this.listCodexModels();
    const runtime = await this.effectiveRuntime(senderId);
    const model = models.find((option) => option.model === runtime.model);
    const efforts = availableEfforts(model, models);
    const input = arg.trim();
    if (!input) {
      const session = this.options.stateStore.getActiveSession(senderId);
      await this.reply(senderId, [
        `当前推理强度：${formatEffort(runtime.effort)}${session?.effort ? "（本会话）" : "（继承 Web/Codex 设置）"}`,
        `当前模型：${runtime.model ?? "Codex 默认"}`,
        "",
        "可用推理强度：",
        ...efforts.map((effort, index) => `${index + 1}. ${formatEffort(effort)}`),
        "",
        "发送 /effort <序号或英文值> 切换；/effort default 恢复继承设置。"
      ].join("\n"));
      return;
    }
    if (input.toLowerCase() === "default") {
      this.options.stateStore.setEffortOverride(senderId);
      const nextRuntime = await this.effectiveRuntime(senderId);
      await this.reply(senderId, `已恢复继承 Web/Codex 推理强度设置。\n当前推理强度：${formatEffort(nextRuntime.effort)}`);
      return;
    }
    const effort = selectEffort(efforts, input);
    if (!effort) {
      await this.reply(senderId, "该模型不支持这个推理强度。发送 /effort 查看可用选项。");
      return;
    }
    this.options.stateStore.setEffortOverride(senderId, effort);
    await this.reply(senderId, `本会话推理强度已切换为：${formatEffort(effort)}\n下一条消息开始生效。`);
  }

  private async handleStreamCommand(senderId: string, arg: string): Promise<void> {
    const input = arg.trim().toLowerCase();
    const session = this.options.stateStore.getActiveSession(senderId);
    const inherited = this.options.config.streamReplies;
    if (!input) {
      const effective = session?.streamReplies ?? inherited;
      const source = typeof session?.streamReplies === "boolean" ? "本会话设置" : "继承全局";
      await this.reply(senderId, `当前过程进度：${effective ? "开启" : "关闭"}（${source}）\n发送 /stream on、/stream off 或 /stream default 切换。`);
      return;
    }
    if (input === "default") {
      this.options.stateStore.setStreamRepliesOverride(senderId);
      await this.reply(senderId, `已恢复继承全局设置。当前过程进度：${inherited ? "开启" : "关闭"}。`);
      return;
    }
    if (input !== "on" && input !== "off") {
      await this.reply(senderId, "用法：/stream on、/stream off 或 /stream default");
      return;
    }
    const enabled = input === "on";
    this.options.stateStore.setStreamRepliesOverride(senderId, enabled);
    await this.reply(senderId, `本会话过程进度已${enabled ? "开启" : "关闭"}。`);
  }

  private async promptItemsFromMessage(message: NormalizedWeixinMessage): Promise<PromptBufferItem[]> {
    const items: PromptBufferItem[] = [];
    if (message.text.trim()) {
      items.push({ kind: "text", text: message.text });
    }
    const attachments = message.attachments ?? [];
    if (!attachments.length) {
      return items;
    }
    try {
      const downloaded = await downloadInboundAttachments({
        rootDir: this.options.inboundDir ?? path.join(this.options.config.defaultCwd, ".codex-weixin-inbound"),
        senderId: message.senderId,
        messageId: message.id,
        attachments,
        maxBytes: this.options.config.maxInboundBytes,
        fetch: this.options.mediaFetch
      });
      for (const attachment of downloaded) {
        items.push({
          kind: attachment.kind,
          path: attachment.path,
          label: attachment.label
        });
      }
    } catch (error) {
      if (error instanceof InboundMediaTooLargeError) throw error;
      items.push({
        kind: "text",
        text: `[WeChat attachment download failed: ${error instanceof Error ? error.message : String(error)}]`
      });
    }
    return items;
  }

  private async promptItemsFromMessageWithNotice(message: NormalizedWeixinMessage): Promise<PromptBufferItem[] | undefined> {
    try {
      return await this.promptItemsFromMessage(message);
    } catch (error) {
      if (!(error instanceof InboundMediaTooLargeError)) throw error;
      const maxMiB = Math.floor(error.maxBytes / (1024 * 1024));
      await this.reply(message.senderId, `附件超过 ${maxMiB} MiB 上限，请压缩或裁剪后重新发送。`);
      return undefined;
    }
  }

  private async runCodexTurn(
    message: NormalizedWeixinMessage,
    text: string,
    attachments: PromptBufferItem[] = [],
    options: { sessionId?: string; skipAutomaticManagement?: boolean; onRunCompleted?: () => void } = {}
  ): Promise<void> {
    const session = options.sessionId
      ? this.options.stateStore.getSession(options.sessionId)
      : this.options.stateStore.ensureActiveSession(message.senderId, this.options.config.defaultCwd);
    if (!session || session.senderId !== message.senderId) {
      throw new Error(`Managed session not found for sender: ${message.senderId}`);
    }
    if (!options.skipAutomaticManagement && await this.proposeAutomaticSessionSplit(message, session, attachments)) return;
    const promptPreview = buildPromptPreview(text, attachments);
    if (promptPreview) {
      this.options.stateStore.setSessionPromptPreview(session.id, promptPreview);
    }
    const workspace = session.workspace;
    const threadId = session.threadId;
    const progressEnabled = session.streamReplies ?? this.options.config.streamReplies;
    const sentProgress = new Set<string>();
    this.options.onTurnStatus?.({ senderId: message.senderId, sessionId: session.id, active: true });
    try {
      await this.withTyping(message.senderId, async () => {
        console.log(`[codex-weixin] starting Codex turn for ${message.senderId} in ${workspace}`);
        const result = await this.runner.run({
          prompt: buildPrompt(text, attachments),
          cwd: workspace,
          threadId,
          model: session.model ?? this.options.config.model,
          effort: session.effort ?? this.options.config.effort,
          ...(progressEnabled ? {
            onProgress: async (progress: string) => {
              const progressText = progress.trim();
              if (!progressText || sentProgress.has(progressText)) return;
              sentProgress.add(progressText);
              await this.reply(message.senderId, progressText);
            }
          } : {})
        });
        console.log(`[codex-weixin] Codex turn completed for ${message.senderId}; text=${result.text.length} chars`);
        if (result.threadId) {
          this.options.stateStore.setSessionThread(session.id, result.threadId);
        }
        options.onRunCompleted?.();
        const parsed = parseActionBlocks(result.text);
        const remaining = chunkText(parsed.visibleText);
        if (remaining.length) {
          for (const chunk of remaining) {
            await this.reply(message.senderId, chunk);
          }
        }
        for (const action of parsed.actions.send) {
          await this.sendLocalMedia(message.senderId, action);
        }
        if (result.usedExecFallback) {
          const nextSession = this.options.stateStore.createSession(
            message.senderId,
            session.workspace,
            "自动新会话"
          );
          if (session.model) this.options.stateStore.setModelOverride(message.senderId, session.model);
          if (session.effort) this.options.stateStore.setEffortOverride(message.senderId, session.effort);
          if (typeof session.streamReplies === "boolean") {
            this.options.stateStore.setStreamRepliesOverride(message.senderId, session.streamReplies);
          }
          console.log(`[codex-weixin] created new managed session ${nextSession.id} after exec fallback for ${message.senderId}`);
          await this.reply(
            message.senderId,
            "检测到 Codex app-server 不可用，已用 exec 完成本次回复。为避免当前会话内容继续累积，已自动创建新会话；下一条消息会在新会话中处理。原会话仍可用 /resume 切回。"
          );
        }
      });
    } finally {
      this.options.onTurnStatus?.({ senderId: message.senderId, sessionId: session.id, active: false });
    }
  }

  private async proposeAutomaticSessionSplit(
    message: NormalizedWeixinMessage,
    session: ManagedSession,
    items: PromptBufferItem[]
  ): Promise<boolean> {
    const mode = this.options.config.automaticSessionMode;
    if (mode === "off" || !session.threadId || this.options.stateStore.getPendingSessionSplit(message.senderId)) return false;
    let history;
    try {
      history = await this.runner.getHistory(session.threadId);
    } catch (error) {
      console.warn(`Unable to read history for automatic session management: ${error instanceof Error ? error.message : String(error)}`);
      return false;
    }
    if (!history.length) return false;

    let reason: "topic" | "context-length" | undefined;
    if (mode === "context-length") {
      if (this.options.stateStore.getDismissedContextThreshold(session.id) === this.options.config.automaticSessionContextTokens) {
        return false;
      }
      const estimate = estimateContextTokens(history, items);
      if (estimate >= this.options.config.automaticSessionContextTokens) reason = "context-length";
    } else {
      // Include this incoming user turn; assistant replies do not count.
      if (history.filter((item) => item.role === "user").length + 1 < 5) return false;
      const incomingText = items.filter((item): item is Extract<PromptBufferItem, { kind: "text" }> => item.kind === "text")
        .map((item) => item.text)
        .join("\n")
        .trim();
      if (incomingText && isTopicCandidate(history, incomingText)) {
        const decision = await classifyTopicChange({
          summary: buildTopicSummary(history),
          message: sanitizeTopicText(incomingText),
          model: session.model ?? this.options.config.model,
          effort: session.effort ?? this.options.config.effort
        }, (input) => this.runner.runIsolated(input));
        if (decision === "new") reason = "topic";
      }
    }
    if (!reason) return false;

    const pending: PendingSessionSplit = {
      senderId: message.senderId,
      sourceSessionId: session.id,
      reason,
      items: structuredClone(items),
      expiresAt: Date.now() + PENDING_SPLIT_TIMEOUT_MS
    };
    this.options.stateStore.setPendingSessionSplit(pending);
    this.schedulePendingSplitExpiry(pending);
    const reasonText = reason === "topic" ? "这条消息可能开启了新话题" : "会话上下文估算已达到设置阈值";
    await this.reply(message.senderId, `${reasonText}。这条消息已暂存，回复“确认”在新会话中开始，回复“取消”留在原会话；10 分钟未回复时会在原会话处理。`);
    return true;
  }

  private schedulePendingSplitExpiry(pending: PendingSessionSplit): void {
    if (this.closed) return;
    const previous = this.pendingSplitTimers.get(pending.senderId);
    if (previous) clearTimeout(previous);
    const timeout = setTimeout(() => {
      void this.resolvePendingSessionSplit(pending.senderId, "reject", true).catch((error) => {
        console.warn(`Unable to route expired session split for ${pending.senderId}: ${error instanceof Error ? error.message : String(error)}`);
      });
    }, Math.max(0, pending.expiresAt - Date.now()));
    timeout.unref?.();
    this.pendingSplitTimers.set(pending.senderId, timeout);
  }

  private async resolvePendingSessionSplit(
    senderId: string,
    decision: "accept" | "reject",
    expired = false
  ): Promise<void> {
    if (this.closed || !this.access.requireAccess(senderId).allowed) return;
    const pending = this.options.stateStore.getPendingSessionSplit(senderId);
    if (!pending) return;
    if (!pending.decision) {
      pending.decision = decision;
      this.options.stateStore.setPendingSessionSplit(pending);
      const timer = this.pendingSplitTimers.get(senderId);
      if (timer) clearTimeout(timer);
      this.pendingSplitTimers.delete(senderId);
    }
    await this.runPendingSessionSplit(pending);
    if (this.closed) return;
    if (expired) {
      await this.reply(senderId, "确认已超时，暂存消息已在原会话中处理。");
    } else if (pending.decision === "accept") {
      await this.reply(senderId, "已在新会话中继续这条消息。");
    } else {
      await this.reply(senderId, "已在原会话中继续这条消息。");
    }
  }

  private async runPendingSessionSplit(pending: PendingSessionSplit): Promise<void> {
    const existing = this.pendingSplitRuns.get(pending.senderId);
    if (existing) return existing;
    const run = this.executePendingSessionSplit(pending.senderId).finally(() => {
      if (this.pendingSplitRuns.get(pending.senderId) === run) this.pendingSplitRuns.delete(pending.senderId);
    });
    this.pendingSplitRuns.set(pending.senderId, run);
    return run;
  }

  private async executePendingSessionSplit(senderId: string): Promise<void> {
    while (true) {
      if (this.closed || !this.access.requireAccess(senderId).allowed) return;
      const pending = this.options.stateStore.getPendingSessionSplit(senderId);
      if (!pending?.decision) return;
      const source = this.options.stateStore.getSession(pending.sourceSessionId)
        ?? this.options.stateStore.getActiveSession(senderId)
        ?? this.options.stateStore.ensureActiveSession(senderId, this.options.config.defaultCwd);
      let sessionId = source.id;
      if (pending.decision === "accept") {
        const existingTarget = pending.targetSessionId
          ? this.options.stateStore.getSession(pending.targetSessionId)
          : undefined;
        if (existingTarget?.senderId === senderId) {
          sessionId = existingTarget.id;
        } else {
          const target = this.options.stateStore.createSession(
            senderId,
            source.workspace,
            pending.reason === "topic" ? "新话题" : "新上下文"
          );
          this.options.stateStore.updateSessionRuntime(target.id, {
            model: source.model ?? null,
            effort: source.effort ?? null,
            streamReplies: source.streamReplies ?? null
          });
          pending.targetSessionId = target.id;
          this.options.stateStore.setPendingSessionSplit(pending);
          sessionId = target.id;
        }
      }
      const session = this.options.stateStore.getSession(sessionId);
      if (!session) throw new Error("The target session for this pending split no longer exists");
      const from = Math.min(pending.processedItemCount ?? 0, pending.items.length);
      const batch = pending.items.slice(from);
      if (!batch.length) {
        const timer = this.pendingSplitTimers.get(senderId);
        if (timer) clearTimeout(timer);
        this.pendingSplitTimers.delete(senderId);
        this.options.stateStore.clearPendingSessionSplit(senderId);
        return;
      }
      await this.runCodexTurn({ id: `pending:${sessionId}`, senderId, text: "", attachments: [], raw: {} }, "", batch, {
        sessionId,
        skipAutomaticManagement: true,
        onRunCompleted: () => {
          const latest = this.options.stateStore.getPendingSessionSplit(senderId);
          if (!latest) return;
          if (latest.decision === "reject" && latest.reason === "context-length") {
            this.options.stateStore.setDismissedContextThreshold(sessionId, this.options.config.automaticSessionContextTokens);
          }
          latest.processedItemCount = Math.min(latest.items.length, from + batch.length);
          this.options.stateStore.setPendingSessionSplit(latest);
        }
      });
    }
  }

  private async sendLocalMedia(senderId: string, action: { type: "image" | "file" | "video"; path: string }): Promise<void> {
    try {
      await sendLocalMediaFile({
        client: this.options.weixin,
        toUserId: senderId,
        contextToken: this.options.stateStore.getContextToken(senderId),
        filePath: action.path,
        kind: action.type
      });
    } catch (error) {
      await this.reply(senderId, action.type === "image"
        ? "图片发送失败，已自动重试 3 次，请稍后再试"
        : `[codex-weixin] Failed to send ${action.type}: ${error instanceof Error ? error.message : String(error)}`);
    }
  }

  private async withTyping(senderId: string, run: () => Promise<void>): Promise<void> {
    const sendTyping = async (typing: boolean) => {
      try {
        await this.options.weixin.sendTyping({
          toUserId: senderId,
          contextToken: this.options.stateStore.getContextToken(senderId),
          typing
        });
      } catch (error) {
        console.warn(`WeChat typing indicator failed for ${senderId}: ${error instanceof Error ? error.message : String(error)}`);
      }
    };

    await sendTyping(true);
    const timer = setInterval(() => {
      void sendTyping(true);
    }, 5_000);
    try {
      await run();
    } finally {
      clearInterval(timer);
      await sendTyping(false);
    }
  }

  private async statusText(senderId: string): Promise<string> {
    const session = this.options.stateStore.getActiveSession(senderId);
    const workspace = session?.workspace ?? this.options.config.defaultCwd;
    const runtime = await this.effectiveRuntime(senderId);
    return [
      "codex-weixin status",
      `sender: ${senderId}`,
      `session: ${session?.title ?? "(new)"}`,
      `workspace: ${workspace}`,
      `thread: ${session?.threadId || "(new)"}`,
      `backend: ${this.options.config.codexBackend}`,
      `exec sandbox: ${this.options.config.codexExecSandbox ?? "(Codex default)"}`,
      `model: ${runtime.model ?? "(Codex default)"}`,
      `effort: ${runtime.effort ?? "(Codex default)"}`,
      `stream replies: ${(session?.streamReplies ?? this.options.config.streamReplies) ? "on" : "off"}${typeof session?.streamReplies === "boolean" ? " (session)" : " (global)"}`
    ].join("\n");
  }

  private async listCodexModels(): Promise<CodexModelOption[]> {
    try {
      return await (this.options.listCodexModels?.() ?? this.runner.listModels());
    } catch (error) {
      console.warn(`Codex model list unavailable: ${error instanceof Error ? error.message : String(error)}`);
      return [];
    }
  }

  private async effectiveRuntime(senderId: string): Promise<CodexRuntimeInfo> {
    const session = this.options.stateStore.getActiveSession(senderId);
    const workspace = session?.workspace ?? this.options.config.defaultCwd;
    let runtime: CodexRuntimeInfo = {};
    try {
      runtime = await this.runner.getRuntimeInfo(workspace, session?.threadId);
    } catch (error) {
      console.warn(`Codex runtime info unavailable: ${error instanceof Error ? error.message : String(error)}`);
    }
    return {
      model: session?.model ?? this.options.config.model ?? runtime.model,
      effort: session?.effort ?? this.options.config.effort ?? runtime.effort,
      provider: runtime.provider
    };
  }

  private async reply(senderId: string, text: string): Promise<void> {
    const contextToken = this.options.stateStore.getContextToken(senderId);
    try {
      console.log(`[codex-weixin] sending reply to ${senderId}; text=${text.length} chars`);
      await this.options.weixin.sendText({ toUserId: senderId, text, contextToken });
      console.log(`[codex-weixin] sent reply to ${senderId}`);
    } catch (error) {
      if (isStaleContextError(error)) {
        console.warn(`WeChat context token is stale for ${senderId}; ask user to send a fresh message.`);
        return;
      }
      throw error;
    }
  }

  allowSender(senderId: string): void {
    this.access.allow(senderId);
    this.options.stateStore.setPairedSenderIds(this.access.listPairedSenderIds());
  }

  removeSender(senderId: string): void {
    this.access.remove(senderId);
    this.options.stateStore.setPairedSenderIds(this.access.listPairedSenderIds());
  }

  listAllowedSenders(): string[] {
    return this.access.listPairedSenderIds();
  }
}

function parseCommand(text: string): { name: string; arg: string } | undefined {
  const trimmed = text.trim();
  if (!trimmed.startsWith("/")) {
    return undefined;
  }
  const [name, ...rest] = trimmed.slice(1).split(/\s+/);
  return { name: name.toLowerCase(), arg: rest.join(" ") };
}

function parseSplitConfirmation(text: string): "accept" | "reject" | undefined {
  const normalized = text.trim().toLowerCase();
  if (["确认", "是", "yes", "y", "同意"].includes(normalized)) return "accept";
  if (["取消", "否", "no", "n", "留在原会话"].includes(normalized)) return "reject";
  return undefined;
}

function helpText(): string {
  return [
    "codex-weixin commands:",
    "/help - show commands",
    "/status - show current binding",
    "/bind <absolute-path> - bind this chat to a workspace",
    "/new - create a new managed Codex session",
    "/resume [R-number] - list or switch historical sessions",
    "/model [number|model-id|default] - view or switch this session's model",
    "/effort [number|level|default] - view or switch reasoning effort",
    "/stream [on|off|default] - view or switch streaming replies",
    "/prompt start - buffer multiple WeChat messages",
    "/prompt done - submit buffered prompt",
    "/stop - interrupt the current Codex task"
  ].join("\n");
}

function formatSessionTime(value: string): string {
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return "时间未知";
  const pad = (part: number) => String(part).padStart(2, "0");
  return `${pad(date.getMonth() + 1)}-${pad(date.getDate())} ${pad(date.getHours())}:${pad(date.getMinutes())}`;
}

const fallbackEfforts = ["minimal", "low", "medium", "high", "xhigh", "max", "ultra"];

function selectModel(models: CodexModelOption[], input: string): CodexModelOption | undefined {
  if (/^\d+$/.test(input)) {
    return models[Number(input) - 1];
  }
  const normalized = input.toLowerCase();
  return models.find((model) => model.model.toLowerCase() === normalized);
}

function isPlausibleModelId(input: string): boolean {
  return /^[a-zA-Z0-9][a-zA-Z0-9._:/-]*$/.test(input);
}

function availableEfforts(model: CodexModelOption | undefined, models: CodexModelOption[]): string[] {
  const advertised = model?.supportedEfforts.length
    ? model.supportedEfforts.map((option) => option.effort)
    : models.flatMap((option) => option.supportedEfforts.map((effort) => effort.effort));
  return advertised.length ? [...new Set(advertised)] : fallbackEfforts;
}

function selectEffort(efforts: string[], input: string): string | undefined {
  if (/^\d+$/.test(input)) {
    return efforts[Number(input) - 1];
  }
  const normalized = input.toLowerCase();
  return efforts.find((effort) => effort.toLowerCase() === normalized);
}

function formatEffort(effort?: string): string {
  if (!effort) return "Codex 默认";
  const labels: Record<string, string> = {
    minimal: "最小",
    low: "低",
    medium: "中",
    high: "高",
    xhigh: "超高",
    max: "最大",
    ultra: "极高"
  };
  return labels[effort] ? `${labels[effort]}（${effort}）` : effort;
}
