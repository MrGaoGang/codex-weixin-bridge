import type { CodexHistoryMessage } from "../codex/app-server-runner.js";
import type { PromptBufferItem } from "./prompt-buffer.js";
import { parsePrompt } from "./format.js";

const MAX_ESTIMATED_TOKENS = Number.MAX_SAFE_INTEGER;
const MEDIA_TOKEN_ESTIMATE: Record<"file" | "image" | "video" | "audio", number> = {
  file: 512,
  image: 1_024,
  video: 2_048,
  audio: 1_024
};

export function estimateContextTokens(history: CodexHistoryMessage[], incoming: PromptBufferItem[]): number {
  let total = 0;
  for (const message of history) total = addSaturated(total, estimateTextTokens(message.text));
  for (const item of incoming) {
    total = addSaturated(total, item.kind === "text"
      ? estimateTextTokens(item.text)
      : MEDIA_TOKEN_ESTIMATE[item.kind]);
  }
  return total;
}

export function estimateTextTokens(text: string): number {
  let total = 0;
  let latinRun = 0;
  const flushLatin = () => {
    if (!latinRun) return;
    total = addSaturated(total, Math.ceil(latinRun / 4));
    latinRun = 0;
  };
  for (const character of text) {
    if (/^[\x00-\x7f]$/.test(character)) {
      if (/[A-Za-z0-9]/.test(character)) latinRun += 1;
      else {
        flushLatin();
        if (!/\s/.test(character)) total = addSaturated(total, 1);
      }
    } else {
      flushLatin();
      total = addSaturated(total, 1);
    }
  }
  flushLatin();
  return total;
}

export function isTopicCandidate(history: CodexHistoryMessage[], message: string): boolean {
  const normalized = message.trim().toLowerCase();
  if (!normalized) return false;
  if (/(换个话题|换个问题|另外|顺便问|新问题|无关的话题|另一个问题)/u.test(normalized)) return true;
  if (Array.from(normalized).length < 6) return false;

  const previousUsers = history.filter((item) => item.role === "user").slice(-4);
  if (!previousUsers.length) return false;
  const previousTerms = tokenize(previousUsers.map((item) => parsePrompt(item.text).text).join(" "));
  const messageTerms = tokenize(normalized);
  if (!messageTerms.size || !previousTerms.size) return false;
  let overlap = 0;
  for (const term of messageTerms) if (previousTerms.has(term)) overlap += 1;
  return overlap / messageTerms.size < 0.15;
}

export function buildTopicSummary(history: CodexHistoryMessage[], maxCharacters = 1_200): string {
  const lines = history
    .filter((item) => item.kind !== "progress")
    .slice(-8)
    .map((item) => `${item.role === "user" ? "用户" : "Codex"}：${sanitizeTopicText(item.role === "user" ? parsePrompt(item.text).text : item.text)}`)
    .filter((line) => line.length > 3);
  let summary = lines.join("\n");
  if (summary.length > maxCharacters) summary = `…${summary.slice(-(maxCharacters - 1))}`;
  return summary;
}

function tokenize(value: string): Set<string> {
  return new Set(value.toLowerCase().match(/[\p{Script=Han}]|[a-z0-9]{3,}/gu) ?? []);
}

export function sanitizeTopicText(value: string): string {
  return value
    .replace(/(?<![A-Za-z0-9:/])(?:[A-Za-z]:\\|\/)(?:[^\s,;()[\]]+[\\/])*[^\s,;()[\]]+/g, "[本地路径]")
    .replace(/\s+/g, " ")
    .trim();
}

function addSaturated(left: number, right: number): number {
  return Math.min(MAX_ESTIMATED_TOKENS, left + right);
}
