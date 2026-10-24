export const CODEX_EXEC_SANDBOXES = [
  "read-only",
  "workspace-write",
  "danger-full-access"
] as const;

export type CodexExecSandbox = typeof CODEX_EXEC_SANDBOXES[number];

export function parseCodexExecSandbox(value: unknown): CodexExecSandbox | undefined {
  if (value === undefined) {
    return undefined;
  }
  if (typeof value === "string" && CODEX_EXEC_SANDBOXES.includes(value as CodexExecSandbox)) {
    return value as CodexExecSandbox;
  }
  throw new Error(
    `Invalid codexExecSandbox: ${String(value)}. Expected one of: ${CODEX_EXEC_SANDBOXES.join(", ")}`
  );
}

export const CODEX_APPROVAL_POLICIES = ["never", "on-request", "untrusted", "on-failure"] as const;
export type CodexApprovalPolicy = typeof CODEX_APPROVAL_POLICIES[number];

export function parseCodexApprovalPolicy(value: unknown): CodexApprovalPolicy | undefined {
  if (value === undefined) return undefined;
  if (typeof value === "string" && CODEX_APPROVAL_POLICIES.includes(value as CodexApprovalPolicy)) {
    return value as CodexApprovalPolicy;
  }
  throw new Error(`Invalid codexApprovalPolicy: ${String(value)}. Expected one of: ${CODEX_APPROVAL_POLICIES.join(", ")}`);
}
