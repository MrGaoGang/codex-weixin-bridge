import os from "node:os";
import path from "node:path";

import { parseCodexApprovalPolicy, type CodexApprovalPolicy, parseCodexExecSandbox, type CodexExecSandbox } from "../codex/sandbox.js";
import { readJsonFile, writeJsonFile } from "./json-store.js";
import type { StatePaths } from "./paths.js";

export const MAX_INBOUND_BYTES = 100 * 1024 * 1024;
const LEGACY_DEFAULT_INBOUND_BYTES = 50 * 1024 * 1024;

export type CodexWeixinConfig = {
  defaultCwd: string;
  allowedSenderIds: string[];
  allowedWorkspaces: string[];
  codexBin: string;
  codexBackend: "auto" | "app-server" | "exec";
  codexExecSandbox?: CodexExecSandbox;
  codexApprovalPolicy?: CodexApprovalPolicy;
  model?: string;
  effort?: string;
  streamReplies: boolean;
  automaticSessionMode: "off" | "topic" | "context-length";
  automaticSessionContextTokens: number;
  maxBufferItems: number;
  promptBufferTtlMs: number;
  maxInboundBytes: number;
};

export function defaultConfig(cwd = path.join(os.homedir(), ".codex-weixin-bridge")): CodexWeixinConfig {
  return {
    defaultCwd: path.resolve(cwd),
    allowedSenderIds: [],
    allowedWorkspaces: [path.resolve(cwd)],
    codexBin: "codex",
    codexBackend: "auto",
    streamReplies: true,
    automaticSessionMode: "off",
    automaticSessionContextTokens: 500_000,
    maxBufferItems: 50,
    promptBufferTtlMs: 10 * 60_000,
    maxInboundBytes: MAX_INBOUND_BYTES
  };
}

export function loadConfig(paths: StatePaths, cwd?: string): CodexWeixinConfig {
  const base = cwd ? defaultConfig(cwd) : defaultConfig();
  const loaded = readJsonFile<Partial<CodexWeixinConfig>>(paths.configPath, {});
  const codexExecSandbox = parseCodexExecSandbox(loaded.codexExecSandbox);
  return {
    ...base,
    ...loaded,
    codexExecSandbox,
    codexApprovalPolicy: parseCodexApprovalPolicy(loaded.codexApprovalPolicy),
    streamReplies: typeof loaded.streamReplies === "boolean" ? loaded.streamReplies : base.streamReplies,
    automaticSessionMode: isAutomaticSessionMode(loaded.automaticSessionMode)
      ? loaded.automaticSessionMode
      : base.automaticSessionMode,
    automaticSessionContextTokens: normalizeAutomaticSessionContextTokens(
      loaded.automaticSessionContextTokens,
      base.automaticSessionContextTokens
    ),
    maxInboundBytes: normalizeInboundBytes(loaded.maxInboundBytes, base.maxInboundBytes),
    allowedSenderIds: loaded.allowedSenderIds ?? base.allowedSenderIds,
    allowedWorkspaces: (loaded.allowedWorkspaces?.length ? loaded.allowedWorkspaces : base.allowedWorkspaces)
      .map((workspace) => path.resolve(workspace))
  };
}

export function isAutomaticSessionMode(value: unknown): value is CodexWeixinConfig["automaticSessionMode"] {
  return value === "off" || value === "topic" || value === "context-length";
}

export function normalizeAutomaticSessionContextTokens(value: unknown, fallback = 500_000): number {
  if (typeof value !== "number" || !Number.isFinite(value)) return fallback;
  return Math.min(10_000_000, Math.max(1, Math.floor(value)));
}

export function saveConfig(paths: StatePaths, config: CodexWeixinConfig): void {
  writeJsonFile(paths.configPath, {
    ...config,
    maxInboundBytes: normalizeInboundBytes(config.maxInboundBytes, MAX_INBOUND_BYTES)
  });
}

function normalizeInboundBytes(value: unknown, fallback: number): number {
  if (typeof value !== "number" || !Number.isFinite(value) || value <= 0) return fallback;
  const bytes = Math.floor(value);
  if (bytes === LEGACY_DEFAULT_INBOUND_BYTES) return MAX_INBOUND_BYTES;
  return Math.min(bytes, MAX_INBOUND_BYTES);
}

export function isWorkspaceAllowed(workspace: string, allowedWorkspaces: string[]): boolean {
  const resolved = path.resolve(workspace);
  return allowedWorkspaces.some((allowed) => {
    const root = path.resolve(allowed);
    const relative = path.relative(root, resolved);
    return relative === "" || (!relative.startsWith("..") && !path.isAbsolute(relative));
  });
}
