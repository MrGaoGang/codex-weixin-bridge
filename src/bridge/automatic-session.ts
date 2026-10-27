/**
 * 微信会话自动切分：本文件提供本地估算、候选筛选和摘要整理函数。
 * 真正的消息路由、模型调用和确认状态由 BridgeService（service.ts）协调。
 *
 * 完整流程（从收到消息到执行任务）：
 * 1. BridgeService 接收微信消息；若已有待确认的切分，先处理确认／取消，
 *    其他普通消息继续加入暂存批次；没有待确认切分时，进入正常任务入口。
 * 2. runCodexTurn 在执行任务前调用 proposeAutomaticSessionSplit。
 *    自动管理关闭、没有 thread 或无法读取历史时，直接沿用原会话。
 * 3. 按上下文长度：estimateContextTokens 将可读历史与本次输入一起估算，
 *    达到配置阈值才建议切分；同会话同阈值已被取消的建议不重复提示。
 * 4. 按话题：先在 service.ts 统计用户历史消息，加上本次输入这一轮；
 *    不足 5 条直接跳过。达到 5 条后用 isTopicCandidate 做本地粗筛。
 *    通过粗筛才用 buildTopicSummary 整理历史、sanitizeTopicText 清理新输入，
 *    交给 topic-classifier.ts，使用当前会话模型进行隔离判断。
 *    摘要整理本身不调用模型；只有判断为 new 才建议切分，same、uncertain
 *    或判断失败都继续原会话。隔离判断不会续写用户原来的 thread。
 * 5. 建议切分时，将本次文本和附件暂存到 RuntimeStateStore，并询问用户；
 *    此时不执行原任务，也不创建新会话。等待期间的普通消息追加到暂存批次。
 * 6. 确认后创建新会话，继承工作目录、模型、推理强度和过程进度设置；
 *    取消或 10 分钟超时则使用原会话。随后执行暂存批次并清理待确认状态。
 *    已完成部分会记录处理进度，避免仅因回复发送失败就重复执行任务。
 * 7. 有暂存批次时，手动 /new 或成功的 /resume 切换会先在原会话处理批次。
 *    旧会话保留，可通过 /resume 找回。此自动切分流程仅用于微信入站消息。
 */
import type { CodexHistoryMessage } from "../codex/app-server-runner.js";
import type { PromptBufferItem } from "./prompt-buffer.js";
import { parsePrompt } from "./format.js";

const MAX_ESTIMATED_TOKENS = Number.MAX_SAFE_INTEGER;
// 附件不在这里读取内容，使用固定估算值；这不是模型实际消耗的 token 数。
const MEDIA_TOKEN_ESTIMATE: Record<"file" | "image" | "video" | "audio", number> = {
  file: 512,
  image: 1_024,
  video: 2_048,
  audio: 1_024
};

/**
 * 合计可读历史文本和本次输入；本次输入可能包含多段文本或附件。
 * 无法计入隐藏工具上下文，也不了解 Codex 自动压缩后的真实占用，结果仅供阈值判断。
 */
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

/**
 * 轻量文本估算：连续 ASCII 字母／数字约每 4 个字符算 1 token，向上取整；
 * 非空白 ASCII 标点及每个非 ASCII 字符各算 1 token，ASCII 空白不计。
 * 这是本地启发式算法，不使用特定模型的 tokenizer，也不调用模型。
 */
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

/**
 * 只决定“是否值得让模型进一步判断”，返回 true 不等于已经换题。
 * 用户消息数量门槛由调用方 service.ts 检查，本函数只负责内容粗筛。
 */
export function isTopicCandidate(history: CodexHistoryMessage[], message: string): boolean {
  const normalized = message.trim().toLowerCase();
  if (!normalized) return false;
  // 明确的换题措辞优先进入模型判断；其余过短消息通常是确认或追问，跳过。
  if (/(换个话题|换个问题|另外|顺便问|新问题|无关的话题|另一个问题)/u.test(normalized)) return true;
  if (Array.from(normalized).length < 6) return false;

  // 只与最近 4 条用户消息比较，避免助手的长回复稀释用户话题。
  const previousUsers = history.filter((item) => item.role === "user").slice(-4);
  if (!previousUsers.length) return false;
  const previousTerms = tokenize(previousUsers.map((item) => parsePrompt(item.text).text).join(" "));
  const messageTerms = tokenize(normalized);
  if (!messageTerms.size || !previousTerms.size) return false;
  let overlap = 0;
  for (const term of messageTerms) if (previousTerms.has(term)) overlap += 1;
  // 新输入词项与旧话题的重合率低于 15% 时视为候选；此粗筛可能误判。
  return overlap / messageTerms.size < 0.15;
}

/**
 * 直接截取最近历史作为紧凑摘要，不做模型总结：排除过程进度，最多取 8 条，
 * 去掉用户 prompt 中的桥接包装并清理路径；超长时保留末尾，优先保留近期内容。
 */
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

// 中文按单字、英文和数字按至少 3 位的连续片段取词；用 Set 去重后比较话题重合率。
function tokenize(value: string): Set<string> {
  return new Set(value.toLowerCase().match(/[\p{Script=Han}]|[a-z0-9]{3,}/gu) ?? []);
}

/**
 * 将匹配到的 Unix／Windows 本地路径替换为占位符，再合并空白，减少路径噪声。
 * 这里只做文本清理，并不读取附件内容，也不是完整的敏感信息脱敏器。
 */
export function sanitizeTopicText(value: string): string {
  return value
    .replace(/(?<![A-Za-z0-9:/])(?:[A-Za-z]:\\|\/)(?:[^\s,;()[\]]+[\\/])*[^\s,;()[\]]+/g, "[本地路径]")
    .replace(/\s+/g, " ")
    .trim();
}

// 累加结果封顶在 JS 最大安全整数，避免极大输入导致计数精度继续下降。
function addSaturated(left: number, right: number): number {
  return Math.min(MAX_ESTIMATED_TOKENS, left + right);
}
