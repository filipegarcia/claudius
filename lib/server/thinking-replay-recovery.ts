import type { SessionMessage } from "@anthropic-ai/claude-agent-sdk";
import { extractUserPromptText } from "@/lib/shared/user-prompt";

/**
 * Detection + rewind-point planning for the Anthropic API 400:
 *
 *   "messages.N.content.M: `thinking` or `redacted_thinking` blocks in the
 *    latest assistant message cannot be modified. These blocks must remain
 *    as they were in the original response."
 *
 * Root cause is upstream in `@anthropic-ai/claude-agent-sdk`: it reassembles a
 * streamed assistant turn from its per-block JSONL lines into the replay
 * request, and when that turn mixes adaptive thinking with parallel/server
 * tool calls the reassembled message no longer byte-matches the *signed*
 * thinking blocks, so the server rejects the tool-use continuation. We can't
 * fix the reconstruction from here — but once a turn is poisoned it sits as
 * the conversation tail and EVERY subsequent prompt replays it, permanently
 * wedging the session (observed: the same 400 fired on three consecutive
 * retries minutes apart). This module lets the Session detect that 400 and
 * compute a safe in-place rewind point so the offending turn can be dropped
 * and the prompt re-driven.
 *
 * Pure + dependency-light on purpose — unit-tested in
 * `tests/unit/thinking-replay-recovery.test.ts`.
 */

/**
 * True when `text` is the thinking-block replay 400. Matches on the stable
 * phrasing the API uses, not the volatile `messages.N.content.M` prefix (the
 * indices vary per conversation, so anchoring on them would be brittle).
 */
export function isThinkingReplayErrorText(text: string): boolean {
  const t = text.toLowerCase();
  return (
    t.includes("thinking") &&
    t.includes("cannot be modified") &&
    (t.includes("redacted_thinking") || t.includes("latest assistant message"))
  );
}

/**
 * Pull concatenated text out of an SDK/API message's `content` (string or
 * block array). Returns "" when there's no text. Used to inspect the
 * synthetic assistant message the SDK emits to carry an API error.
 */
export function extractMessageText(message: unknown): string {
  if (!message || typeof message !== "object") return "";
  const content = (message as { content?: unknown }).content;
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return "";
  let out = "";
  for (const block of content) {
    const b = block as { type?: string; text?: string } | null;
    if (b?.type === "text" && typeof b.text === "string") out += b.text;
  }
  return out;
}

/**
 * Inspect one SDK message (a live `consume()` event or an on-disk record) and
 * return its API-error text when it is the thinking-replay 400, else null.
 * Only `assistant`-role records carry the synthetic "API Error: …" body.
 */
export function thinkingReplayErrorFrom(sdkMessage: unknown): string | null {
  const m = sdkMessage as { type?: string; message?: unknown } | null;
  if (!m || m.type !== "assistant") return null;
  const text = extractMessageText(m.message);
  return text && isThinkingReplayErrorText(text) ? text : null;
}

export type ThinkingReplayRecoveryPlan = {
  /**
   * Assistant message uuid to resume at (the SDK's `resumeSessionAt`). The
   * conversation is replayed up to and including this message; everything
   * after — the poisoned turn and its tool traffic — is dropped from the
   * rebuilt branch.
   */
  resumeAt: string;
  /** The user prompt text that kicked off the poisoned turn, to re-send. */
  replayPrompt: string;
  /** uuid of that user prompt (for logging / dedupe). */
  replayPromptUuid: string;
};

/** True when an assistant record carries a thinking/redacted_thinking block. */
function assistantHasThinking(m: SessionMessage): boolean {
  const content = (m.message as { content?: unknown } | null)?.content;
  if (!Array.isArray(content)) return false;
  return content.some((b) => {
    const t = (b as { type?: string } | null)?.type;
    return t === "thinking" || t === "redacted_thinking";
  });
}

/**
 * Given the on-disk transcript (newest last), find the safe rewind point for
 * the thinking-replay 400:
 *
 *   1. Anchor on the poisoned turn — the latest assistant turn carrying a
 *      thinking/redacted_thinking block (the kind whose tool-use continuation
 *      triggers the 400; falls back to the latest assistant turn if none
 *      expose one). Anchoring on the poisoned turn rather than on the last
 *      user prompt is what keeps recovery correct for a session that wedged
 *      earlier and has since received *further* prompts: those later prompts
 *      sit AFTER the poisoned turn and must be rewound past too — anchoring on
 *      "last user prompt" would resume *at* the poison and re-fail.
 *   2. The prompt that started the poisoned turn is the last *real* user prompt
 *      before the anchor — tool_result-only user records, `<task-notification>`
 *      wrappers, and post-compact summaries are not real prompts
 *      (`extractUserPromptText` returns null for them).
 *   3. Resume at the last assistant message *before* that prompt, then re-send
 *      the prompt so the model retries the turn from a clean tail.
 *
 * Returns null when there's no real user prompt, or no assistant boundary
 * before it (e.g. the poisoned turn was the very first turn) — in those cases
 * there is nothing safe to resume at, and the caller should surface the error
 * rather than loop.
 */
export function planThinkingReplayRecovery(
  messages: SessionMessage[],
): ThinkingReplayRecoveryPlan | null {
  // 1. Anchor on the poisoned turn.
  let anchorIdx = -1;
  for (let i = messages.length - 1; i >= 0; i--) {
    if (messages[i].type === "assistant" && assistantHasThinking(messages[i])) {
      anchorIdx = i;
      break;
    }
  }
  if (anchorIdx < 0) {
    for (let i = messages.length - 1; i >= 0; i--) {
      if (messages[i].type === "assistant") {
        anchorIdx = i;
        break;
      }
    }
  }
  if (anchorIdx < 0) return null;

  // 2. Last real user prompt before the anchor.
  let promptIdx = -1;
  let replayPrompt = "";
  for (let i = anchorIdx - 1; i >= 0; i--) {
    const m = messages[i];
    if (m.type !== "user") continue;
    const text = extractUserPromptText(
      (m.message as { content?: unknown } | null)?.content,
    );
    if (text) {
      promptIdx = i;
      replayPrompt = text;
      break;
    }
  }
  if (promptIdx < 0) return null;

  // 3. Last assistant boundary before that prompt.
  for (let i = promptIdx - 1; i >= 0; i--) {
    const m = messages[i];
    if (m.type === "assistant" && m.uuid) {
      return {
        resumeAt: m.uuid,
        replayPrompt,
        replayPromptUuid: messages[promptIdx].uuid,
      };
    }
  }
  return null;
}
