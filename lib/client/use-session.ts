"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { usePathname } from "next/navigation";
import type { PermissionMode } from "@anthropic-ai/claude-agent-sdk";
import type {
  AuthFailedNudgeEvent,
  CreateSessionRequest,
  PermissionDecision,
  PermissionRequestEvent,
  AskUserQuestionEvent,
  AskAnswer,
  FeedbackSurveyEvent,
  LongContextCreditsNudgeEvent,
  OpusOverloadNudgeEvent,
  PlanDecision,
  ServerEvent,
  TaskSnapshotEntry,
  TokenExpiringNudgeEvent,
} from "@/lib/shared/events";
import type { Tip } from "@/lib/shared/tips";
import type { ApiRetryState } from "@/lib/client/api-retry";
import { costFromTokens } from "@/lib/shared/cost-pricing";
import { parseInitSystemMessage } from "@/lib/shared/parse-init";
import { ADVISOR_ACTIVE_SENTINEL } from "@/lib/shared/advisor";
import { matchesUsageLimitPrefix } from "@/lib/shared/rate-limit-prefixes";
import {
  isCompactSummaryContent,
  isLocalCommandCaveatContent,
  isSdkInternalEnvelope,
  isSdkSlashUserMessage,
  isSuppressedSystemEvent,
  isSyntheticTaskNotification,
  parseSyntheticCliWrapper,
} from "./sdk-message-filters";
import { splitLeadingSystemReminders, stripGoalReminder } from "@/lib/shared/user-prompt";
import { parseWorkflowMeta } from "@/lib/shared/workflow-meta";
import { parseTaskListResult } from "@/lib/shared/parse-tasklist-result";
import { newTabId } from "@/lib/client/tab-id";
import {
  dropProvisionalForToolUse,
  findToolUseBlock,
  isBackgroundedToolUse,
  reconcileTasksOnToolResult,
  seedTaskStatus,
  shouldRecoverOrphanTask,
  upsertProvisionalTask,
} from "./task-status";
import { applyThinkingTokensEstimate, clearStreaming, sweepToolHistoryDone } from "./idle-reconcile";
import type {
  AgentTodo,
  AttachedImage,
  BackgroundBash,
  ChatActions,
  ChatState,
  DisplayBlock,
  DisplayMessage,
  GoalState,
  PendingPlan,
  PlanRateLimits,
  QueuedMessage,
  RecentEdit,
  ScheduledLoop,
  SessionInfo,
  SessionUsage,
  SystemEntry,
  TaskInfo,
  TaskStatus,
  ToolHistoryEntry,
  ToolProgressInfo,
} from "./types";
import { appendCoalescedSystemEntry } from "./system-entries";

type SDKContentBlock =
  | { type: "text"; text: string }
  | { type: "thinking"; thinking: string }
  | { type: "redacted_thinking"; data?: string }
  | { type: "tool_use"; id: string; name: string; input: Record<string, unknown> }
  | {
      type: "tool_result";
      tool_use_id: string;
      content: string | Array<{ type: string; text?: string }>;
      is_error?: boolean;
    }
  | { type: string; [k: string]: unknown };

// Legacy sessionStorage key prefix from the pre-server-queue era. On mount,
// `bindToSession` drains any leftover entries by POSTing them through the
// normal /input endpoint (which routes them into the new server-side queue),
// then deletes the key. Kept exposed so that one-shot migration can find it.
const LEGACY_QUEUE_STORAGE_PREFIX = "claudius.queue.";

/**
 * One-shot upgrade path: drain any queued messages that the previous
 * (sessionStorage-backed) client wrote for this session into the new
 * server-side queue, then delete the key so we never re-drain it. Runs at
 * most once per session per tab. Best-effort — a malformed JSON or a network
 * failure silently drops the stash (it's salvage, not user-typed-just-now
 * content). New users with no leftover data hit a cheap negative-cache lookup
 * and return immediately.
 */
type LegacyQueuedShape = {
  text?: string;
  images?: Array<{ data: string; mediaType: string; ordinal?: number }>;
  slash?: boolean;
  fromSuggestion?: boolean;
  fromGoal?: boolean;
};

async function migrateLegacySessionStorageQueue(sessionId: string): Promise<void> {
  if (typeof window === "undefined") return;
  const key = `${LEGACY_QUEUE_STORAGE_PREFIX}${sessionId}`;
  let raw: string | null;
  try {
    raw = window.sessionStorage.getItem(key);
  } catch {
    return;
  }
  if (!raw) return;
  // Remove immediately so a concurrent bindToSession (notification jump
  // during a session switch, for example) doesn't re-drain the same items.
  try {
    window.sessionStorage.removeItem(key);
  } catch {
    // ignore — non-fatal
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return;
  }
  if (!Array.isArray(parsed)) return;
  for (const item of parsed as LegacyQueuedShape[]) {
    if (!item || (typeof item.text !== "string" && !Array.isArray(item.images))) {
      continue;
    }
    try {
      await fetch(`/api/sessions/${sessionId}/input`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          text: item.text ?? "",
          ...(item.images && item.images.length ? { images: item.images } : {}),
          ...(item.slash ? { slash: true } : {}),
          ...(item.fromSuggestion ? { fromSuggestion: true } : {}),
          ...(item.fromGoal ? { fromGoal: true } : {}),
          forceQueue: true,
        }),
      });
    } catch {
      // ignore — best-effort migration
    }
  }
}

/**
 * Detect the "hard rate-limit hit" assistant message.
 *
 * The SDK signals a hard limit two different ways depending on path:
 *   • Live  — an `SDKAssistantMessage` with `error: "rate_limit"`.
 *   • Replay — `getSessionMessages` (used to rehydrate a resumed session)
 *     strips both `error` and the preceding `rate_limit_event`s, leaving only
 *     the assistant *text* the CLI rendered — one of the CLI's usage-limit
 *     templates ("You've hit your <label> · resets <time>", "You're out of
 *     usage credits", "Your seat type doesn't include usage", …).
 *
 * So we match the prose as a fallback, via `matchesUsageLimitPrefix`
 * (`lib/shared/rate-limit-prefixes.ts`), which checks against the SDK's
 * canonical `USAGE_LIMIT_ERROR_PREFIXES` list instead of a hand-rolled
 * regex that only covered one of the twelve known templates. Guarded to a
 * pure-text message whose leading clause matches — a normal turn that merely
 * mentions limits in passing won't be a standalone rate-limit-wall bubble.
 */
// Exported for unit testing — false positives on normal prose would wrongly
// badge a message as a rate-limit wall.
export function isRateLimitHitText(blocks: DisplayBlock[]): boolean {
  if (blocks.length === 0) return false;
  if (!blocks.every((b) => b.kind === "text")) return false;
  const first = blocks.find((b) => b.kind === "text");
  return !!first && matchesUsageLimitPrefix(first.text);
}

/**
 * Best-effort map the CLI's prose limit label onto the SDK's `rateLimitType`
 * so the inline hit panel can show a meaningful tier headline on the replay
 * path (where the structured payload is gone). Returns undefined when the
 * label doesn't match a known tier — the panel falls back to a generic
 * "usage limit".
 */
export function rateLimitTypeFromText(
  text: string,
): NonNullable<SystemEntry["rateLimit"]>["rateLimitType"] | undefined {
  const t = text.toLowerCase();
  if (/\bopus\b/.test(t)) return "seven_day_opus";
  if (/\bsonnet\b/.test(t)) return "seven_day_sonnet";
  if (/\b(weekly|week|7[\s-]?day|seven[\s-]?day)\b/.test(t)) return "seven_day";
  if (/\b(session|5[\s-]?hour|five[\s-]?hour)\b/.test(t)) return "five_hour";
  return undefined;
}

/**
 * Detect the Opus-4 high-demand banner the Anthropic backend emits as
 * assistant prose. The CLI strings are
 *   "We are experiencing high demand for Opus 4."
 *   "To continue immediately, use /model to switch to ... and continue coding."
 * — distinct from the generic 529 overload nudge (see feature 10's server-side
 * detector) and from `RATE_LIMIT_HIT_TEXT_RE`. Anchored on the literal
 * "high demand for Opus 4" substring so passing mentions of the same words in
 * normal prose don't trip it. Exported for unit testing.
 */
const OPUS_HIGH_DEMAND_RE = /\bhigh demand for opus 4\b/i;

export function isOpusHighDemandText(blocks: DisplayBlock[]): boolean {
  if (blocks.length === 0) return false;
  if (!blocks.every((b) => b.kind === "text")) return false;
  const first = blocks.find((b) => b.kind === "text");
  return !!first && OPUS_HIGH_DEMAND_RE.test(first.text);
}

/**
 * Copy shown in place of the SDK's `model_not_found` prose when the selected
 * model can't be used (doesn't exist, or isn't enabled for this account /
 * region — e.g. Claude Fable 5 outside its rollout). The bare URL is
 * auto-linked by `remark-gfm` when the bubble renders through `<Markdown>`.
 */
export const MODEL_UNAVAILABLE_MESSAGE =
  "Claude Fable 5 is currently unavailable. Please use Opus 4.8 or another available model. Learn more: https://www.anthropic.com/news/fable-mythos-access";

/**
 * Detect the Claude Code CLI's "selected model can't be used" prose. The
 * bundle emits one of two templates with `error: "model_not_found"`:
 *   "There's an issue with the selected model (<id>). It may not exist or you
 *    may not have access to it."
 *   "The model <id> is not available on your <deployment> deployment."
 * We match the prose so the replacement also fires on the replay/pagination
 * paths, where the structured `error` field is stripped by `/transcript`.
 * Exported for unit testing (the regex is the brittle bit).
 */
const MODEL_NOT_FOUND_RE =
  /there['’]s an issue with the selected model|may not exist or you may not have access|is not available on your .*deployment/i;

export function isModelNotFoundText(blocks: DisplayBlock[]): boolean {
  if (blocks.length === 0) return false;
  if (!blocks.every((b) => b.kind === "text")) return false;
  const first = blocks.find((b) => b.kind === "text");
  return !!first && MODEL_NOT_FOUND_RE.test(first.text);
}

/**
 * When an assistant message IS the SDK's model-unavailable notice *for the
 * Fable model*, swap its prose for `MODEL_UNAVAILABLE_MESSAGE` (with the
 * use-another-model + learn-more pointer). `assistantError === "model_not_found"`
 * is the live signal; the prose match covers replay where the `error` field is
 * gone. Scoped to Fable on purpose — the learn-more link is Fable-specific, so
 * any *other* model that 404s keeps the SDK's own (model-named) prose. Returns
 * the blocks unchanged otherwise so normal turns are untouched.
 */
export function rewriteModelUnavailableBlocks(
  blocks: DisplayBlock[],
  assistantError?: string,
): DisplayBlock[] {
  const isModelNotFound = assistantError === "model_not_found" || isModelNotFoundText(blocks);
  if (!isModelNotFound) return blocks;
  // The SDK prose embeds the offending model id (e.g. "(claude-fable-5)"), so
  // we can tell Fable apart from any other unavailable model right here.
  const first = blocks.find((b) => b.kind === "text");
  if (!first || !/\bfable\b/i.test(first.text)) return blocks;
  return [{ kind: "text", text: MODEL_UNAVAILABLE_MESSAGE }];
}

/**
 * Build the `DisplayMessage.rateLimitHit` payload for a hit message. Tier comes
 * from the preceding warning event when we have it (live), else the prose
 * label. The countdown `resetsAt` is only known live — the prose carries a
 * wall-clock but no date, and the reset time is already printed in the message
 * text, so we don't parse it back out on the replay path.
 */
function rateLimitHitFromBlocks(
  blocks: DisplayBlock[],
  last: SystemEntry["rateLimit"] | null,
  fallbackModel: string | null,
): NonNullable<DisplayMessage["rateLimitHit"]> {
  const text = blocks.find((b) => b.kind === "text")?.text ?? "";
  const rateLimitType = last?.rateLimitType ?? rateLimitTypeFromText(text);
  const hit: NonNullable<DisplayMessage["rateLimitHit"]> = {};
  if (rateLimitType) hit.rateLimitType = rateLimitType;
  if (typeof last?.resetsAt === "number") hit.resetsAt = last.resetsAt;
  // Only attach the fallback when the rejection is per-model — the SDK's
  // automatic fallback only engages for `seven_day_opus` / `seven_day_sonnet`.
  // Account-wide tiers (`seven_day`, `five_hour`, `overage`) don't swap models,
  // so emitting "Now using <fallback>" there would be a lie.
  if (
    fallbackModel &&
    (rateLimitType === "seven_day_opus" || rateLimitType === "seven_day_sonnet")
  ) {
    hit.fallbackModel = fallbackModel;
  }
  // SDK 0.3.181 — forward credits-required signal so RateLimitHitPanel can
  // show the "buy credits" CTA instead of the standard upgrade links.
  if (last?.errorCode) hit.errorCode = last.errorCode;
  if (typeof last?.canUserPurchaseCredits === "boolean")
    hit.canUserPurchaseCredits = last.canUserPurchaseCredits;
  if (typeof last?.hasChargeableSavedPaymentMethod === "boolean")
    hit.hasChargeableSavedPaymentMethod = last.hasChargeableSavedPaymentMethod;
  return hit;
}

/**
 * Coerce a raw `todos` payload (as emitted by the TodoWrite tool or replayed
 * via `session_snapshot`) into the shape the activity rail renders. Tolerant
 * of missing fields — the model occasionally omits `id` or `activeForm` and
 * we want to keep the row instead of dropping it.
 */
function coerceTodos(raw: unknown[]): AgentTodo[] {
  return raw.map((t, i) => {
    const o = (t as Record<string, unknown>) ?? {};
    const content =
      typeof o.content === "string"
        ? o.content
        : typeof o.subject === "string"
          ? (o.subject as string)
          : "";
    return {
      id: typeof o.id === "string" ? o.id : `t${i}`,
      content,
      status: typeof o.status === "string" ? (o.status as string) : "pending",
      activeForm: typeof o.activeForm === "string" ? (o.activeForm as string) : undefined,
    };
  });
}

function blocksFromSDKContent(content: unknown): DisplayBlock[] {
  if (typeof content === "string") return [{ kind: "text", text: content }];
  if (!Array.isArray(content)) return [];
  const out: DisplayBlock[] = [];
  for (const raw of content as SDKContentBlock[]) {
    if (raw.type === "text" && typeof raw.text === "string") out.push({ kind: "text", text: raw.text });
    else if (raw.type === "thinking" && typeof raw.thinking === "string")
      out.push({ kind: "thinking", text: raw.thinking });
    else if (raw.type === "redacted_thinking")
      out.push({ kind: "thinking", text: "", redacted: true });
    else if (raw.type === "tool_use") {
      const tu = raw as Extract<SDKContentBlock, { type: "tool_use" }>;
      // Client-stamped — the SDK carries no start time on tool_use blocks
      // (same known limitation as `TaskInfo.startedAt`). Harmless for a
      // replayed/completed block: its `result` is attached immediately
      // after by the caller, so `startedAt` never drives a visible elapsed
      // reading once `!result` is false.
      out.push({ kind: "tool_use", id: tu.id, name: tu.name, input: tu.input ?? {}, startedAt: Date.now() });
    }
  }
  return out;
}

/**
 * Rebuild a subagent's `DisplayMessage[]` from the raw SDK envelopes captured
 * server-side and replayed via the `task_snapshot` event. Mirrors the live
 * subagent branches of `applyEvent`: assistant messages fold through
 * `upsertAssistantSplit` (so multi-block splits coalesce into one bubble),
 * user messages become a single text bubble, both keyed off the parent Task
 * tool_use id. Streaming is forced off — these are completed, replayed
 * conversations with no further deltas coming.
 *
 * Exported for unit testing.
 */
export function buildSubagentMessages(
  raw: Array<{ at?: number; message: unknown }>,
  parentToolUseId: string,
): DisplayMessage[] {
  let out: DisplayMessage[] = [];
  const seenUserUuids = new Set<string>();
  for (const { at, message } of raw) {
    const m = message as {
      type?: string;
      uuid?: string;
      message?: { id?: string; content?: unknown };
    };
    if (m.type === "assistant") {
      const sdkUuid = m.uuid ?? crypto.randomUUID();
      const messageId =
        typeof m.message?.id === "string" && m.message.id ? m.message.id : sdkUuid;
      const blocks = blocksFromSDKContent(m.message?.content);
      out = upsertAssistantSplit(out, messageId, sdkUuid, blocks, false, parentToolUseId, at);
    } else if (m.type === "user") {
      const uuid = m.uuid ?? crypto.randomUUID();
      if (seenUserUuids.has(uuid)) continue;
      let text = "";
      const content = m.message?.content;
      if (typeof content === "string") text = content;
      else if (Array.isArray(content)) {
        for (const c of content as Array<{ type?: string; text?: string }>) {
          if (c?.type === "text" && c.text) text += c.text;
        }
      }
      if (!text) continue;
      seenUserUuids.add(uuid);
      out = [
        ...out,
        {
          uuid,
          role: "user",
          blocks: [{ kind: "text", text }],
          parentToolUseId,
          ...(typeof at === "number" ? { createdAt: at } : {}),
        },
      ];
    }
  }
  // `upsertAssistantSplit` marks fresh bubbles `streaming: true`, expecting a
  // later `result` event to flip it off. Replayed tasks are already finished,
  // so settle the flag here to avoid a perpetual streaming indicator.
  return out.map((msg) =>
    msg.role === "assistant" && msg.streaming ? { ...msg, streaming: false } : msg,
  );
}

/**
 * Walk a user message's SDK content and rebuild the `(text, images)` pair the
 * UI needs to render thumbnails inline.
 *
 * On the wire we ship images as base64 content blocks interleaved between text
 * blocks (see `Session.sendInput` — the server strips the original `[Image #N]`
 * tokens from text before splitting). So the only thing that survives a page
 * refresh / disk replay is the document order of the blocks. We rehydrate by:
 *
 *   1. Assigning fresh ordinals (1, 2, 3…) to image blocks in document order,
 *   2. Inserting `[Image #N]` tokens back into the concatenated text at each
 *      image's position so `InlineUserText` can inline thumbnails where the
 *      sender originally placed them.
 *
 * Reassigned ordinals can diverge from the sender's original (which were
 * monotonic-without-reuse per composer state) but the link only needs to be
 * internally consistent within this one bubble — `InlineUserText` maps token
 * ordinal → `images[].ordinal`, nothing else.
 *
 * Only base64-sourced image blocks are reconstructed. URL-sourced images
 * (none today) and non-text/non-image blocks are dropped.
 *
 * Exported for unit testing.
 */
export function extractUserContent(content: unknown): {
  text: string;
  images: AttachedImage[];
  /**
   * Bodies of any leading `<system-reminder>` blocks the server prepended
   * to this user record (every-turn `todos-current` nudge, stale-todowrite,
   * plan-mode-reentry, etc. — see `lib/server/system-reminders.ts`). Empty
   * for live broadcasts (the server omits the wrapper from the broadcast
   * echo) and for normal user prompts; populated on disk-replay so the
   * caller can surface each as its own `system_reminder` pill instead of
   * leaving the wrapper inside the user bubble. See
   * `splitLeadingSystemReminders` for the parse contract.
   */
  reminderBodies: string[];
} {
  if (typeof content === "string") {
    const goalStripped = stripGoalReminder(content);
    const { reminders, rest } = splitLeadingSystemReminders(goalStripped);
    return { text: rest, images: [], reminderBodies: reminders };
  }
  if (!Array.isArray(content)) return { text: "", images: [], reminderBodies: [] };
  let text = "";
  const images: AttachedImage[] = [];
  let ord = 0;
  for (const raw of content as Array<Record<string, unknown>>) {
    if (!raw || typeof raw !== "object") continue;
    const type = (raw as { type?: unknown }).type;
    if (type === "text") {
      const t = (raw as { text?: unknown }).text;
      if (typeof t === "string") text += t;
    } else if (type === "image") {
      const src = (raw as { source?: unknown }).source as
        | { type?: unknown; media_type?: unknown; data?: unknown }
        | undefined;
      if (
        src &&
        src.type === "base64" &&
        typeof src.data === "string" &&
        typeof src.media_type === "string"
      ) {
        ord += 1;
        text += `[Image #${ord}]`;
        images.push({
          id: `replay-${ord}`,
          ordinal: ord,
          data: src.data,
          mediaType: src.media_type,
        });
      }
    }
  }
  // Strip the Claude-only goal reminder + any cross-turn `<system-reminder>`
  // blocks the server prepends (both survive in the JSONL, so a
  // resumed-from-disk session would otherwise show them inside the user
  // bubble). The reminder bodies are returned separately so the caller can
  // render each as its own `system_reminder` pill above the user bubble —
  // visible-but-tidy instead of mistakenly shown as user-authored text.
  const goalStripped = stripGoalReminder(text);
  const { reminders, rest } = splitLeadingSystemReminders(goalStripped);
  return { text: rest, images, reminderBodies: reminders };
}

/**
 * SDK 0.3.205 — reads the `SDKMessageOrigin` off a raw user-role SDK
 * message and, when it's `kind: "peer"` (sent by another Claude Code
 * session, e.g. via the `SendMessage` tool), returns the sender's
 * addressable identity + display name + decoded body. Returns `undefined`
 * for `human` / `channel` / any other origin kind, and for a malformed
 * `peer` origin missing `from` (the one required field).
 *
 * `name` and `body` are both optional on the wire (absent on older
 * emitters, or when the turn wasn't exactly one harness-formed envelope) —
 * empty-string / non-string values are treated the same as absent rather
 * than surfaced as a blank badge or bubble.
 *
 * Exported for unit testing.
 */
export function extractPeerOrigin(
  msg: unknown,
): { from: string; name?: string; body?: string } | undefined {
  const origin = (msg as { origin?: { kind?: unknown; from?: unknown; name?: unknown; body?: unknown } } | null)
    ?.origin;
  if (!origin || origin.kind !== "peer") return undefined;
  if (typeof origin.from !== "string" || !origin.from) return undefined;
  const name = typeof origin.name === "string" && origin.name ? origin.name : undefined;
  const body = typeof origin.body === "string" && origin.body ? origin.body : undefined;
  return { from: origin.from, ...(name ? { name } : {}), ...(body ? { body } : {}) };
}

/**
 * TEMP replay-debug instrumentation. Enable in the browser console with
 *   localStorage.setItem("claudius:replay-debug", "1")
 * then reload (or trigger a reconnect by backgrounding the tab / toggling
 * network). Logs every SSE event the client receives — its type, the inner
 * Anthropic message.id, the SDK wrapper uuid, and a content-block summary —
 * so a reconnect-time drop is visible as "this uuid/tool_use never arrived"
 * (server never sent it) vs "arrived but the bubble is empty/red" (reducer
 * dropped it). Remove once the replay/reconnect bug is fixed.
 */
function replayDebugEnabled(): boolean {
  try {
    return (
      typeof window !== "undefined" &&
      window.localStorage?.getItem("claudius:replay-debug") === "1"
    );
  } catch {
    return false;
  }
}

function summarizeEventForDebug(ev: unknown): string {
  const e = ev as { type?: string; at?: number; message?: unknown; hasMoreAbove?: boolean };
  if (e.type !== "sdk") {
    const extra = e.type === "replay_done" ? ` hasMoreAbove=${e.hasMoreAbove}` : "";
    return `[${e.type}]${extra}`;
  }
  const m = e.message as {
    type?: string;
    uuid?: string;
    parent_tool_use_id?: string | null;
    message?: { id?: string; content?: unknown };
    event?: { type?: string; index?: number; message?: { id?: string } };
  };
  const wrap = (m.uuid ?? "").slice(-6);
  const mid = (m.message?.id ?? "").slice(-6);
  const parent = m.parent_tool_use_id ? ` parent=${String(m.parent_tool_use_id).slice(-6)}` : "";
  if (m.type === "stream_event") {
    const et = m.event?.type ?? "?";
    const sid = (m.event?.message?.id ?? "").slice(-6);
    return `[sdk:stream_event ${et} idx=${m.event?.index ?? "-"} msg.id=…${sid || mid} wrap=…${wrap}]${parent}`;
  }
  const blocks: string[] = [];
  const content = m.message?.content;
  if (Array.isArray(content)) {
    for (const b of content as Array<Record<string, unknown>>) {
      if (b.type === "tool_use") blocks.push(`TU:${b.name}:…${String(b.id ?? "").slice(-4)}`);
      else if (b.type === "tool_result") blocks.push(`TR:…${String(b.tool_use_id ?? "").slice(-4)}`);
      else if (b.type === "text") blocks.push(`text(${String((b.text as string) ?? "").length})`);
      else if (b.type === "thinking" || b.type === "redacted_thinking") blocks.push("thinking");
      else blocks.push(String(b.type));
    }
  } else if (typeof content === "string") {
    blocks.push(`str(${content.length})`);
  }
  return `[sdk:${m.type} msg.id=…${mid} wrap=…${wrap} at=${e.at ?? "-"}]${parent} ${blocks.join(" ")}`;
}

function extractToolResult(content: unknown): { tool_use_id: string; text: string; isError?: boolean } | null {
  if (!Array.isArray(content)) return null;
  for (const raw of content as SDKContentBlock[]) {
    if (raw.type === "tool_result") {
      const tr = raw as Extract<SDKContentBlock, { type: "tool_result" }>;
      let text = "";
      if (typeof tr.content === "string") text = tr.content;
      else if (Array.isArray(tr.content))
        text = tr.content
          .map((c) => (typeof c === "object" && c && "text" in c ? c.text ?? "" : ""))
          .join("");
      return { tool_use_id: tr.tool_use_id, text, isError: tr.is_error };
    }
  }
  return null;
}

/**
 * The subset of `BashOutput` (the SDK's structured per-tool result shape,
 * delivered on `SDKUserMessage.tool_use_result` — a sibling of
 * `message.content`, not inside it) that background-bash tracking cares
 * about. `timedOutAfterMs` was added in SDK 0.3.210.
 */
export type BashToolUseResult = {
  backgroundTaskId?: string;
  timedOutAfterMs?: number;
};

/**
 * Fold a Bash tool_result's structured output into the background-bashes
 * map. Handles two cases:
 *  - Already tracked (launched with `run_in_background: true`) — merge in
 *    the SDK-side `bashId` / `timedOutAfterMs`.
 *  - NOT already tracked — the command ran in the foreground but hit its
 *    timeout and the SDK auto-backgrounded it (`timedOutAfterMs` set).
 *    Without this branch such a shell would keep running with zero
 *    visibility in the UI, since nothing at launch time indicated it would
 *    ever go to background.
 * No-ops when the result doesn't indicate a (now-)backgrounded command, so
 * a normal foreground Bash completion never creates a bogus entry.
 */
export function applyBashAutoBackground(
  prev: Record<string, BackgroundBash>,
  args: {
    toolUseId: string;
    command: string;
    toolUseResult: BashToolUseResult | undefined;
    startedAt: number;
  },
): Record<string, BackgroundBash> {
  const { toolUseId, command, toolUseResult, startedAt } = args;
  if (!toolUseResult) return prev;
  const { backgroundTaskId, timedOutAfterMs } = toolUseResult;
  if (!backgroundTaskId && typeof timedOutAfterMs !== "number") return prev;
  const existing = prev[toolUseId];
  const entry: BackgroundBash = {
    toolUseId,
    bashId: backgroundTaskId ?? existing?.bashId,
    command: existing?.command || command,
    startedAt: existing?.startedAt ?? startedAt,
    killed: existing?.killed,
    timedOutAfterMs: timedOutAfterMs ?? existing?.timedOutAfterMs,
  };
  return { ...prev, [toolUseId]: entry };
}

/**
 * Pick a single representative argument from a tool's input, keyed off the
 * tool name. Best-effort — falls back to common keys, then gives up. Used by
 * the activity rail's tool history to put a recognizable subtitle under each
 * tool call without showing the full JSON.
 */
function pickPrimaryArg(name: string, input: Record<string, unknown>): string | undefined {
  if (!input || typeof input !== "object") return undefined;
  const perTool: Record<string, string[]> = {
    Bash: ["command"],
    BashOutput: ["bash_id", "shell_id"],
    KillBash: ["shell_id", "bash_id"],
    Edit: ["file_path"],
    MultiEdit: ["file_path"],
    Write: ["file_path"],
    Read: ["file_path"],
    NotebookEdit: ["notebook_path"],
    Glob: ["pattern"],
    Grep: ["pattern"],
    WebFetch: ["url"],
    WebSearch: ["query"],
    Task: ["description"],
    TodoWrite: [],
    TaskCreate: ["subject"],
    TaskUpdate: ["taskId"],
    TaskGet: ["taskId"],
    TaskList: [],
    ExitPlanMode: [],
    // Surface the cron expression / wake-up delay as the primary arg so the
    // Tools row in the Activity rail shows what was scheduled, not nothing.
    CronCreate: ["cron"],
    CronDelete: ["id"],
    ScheduleWakeup: ["reason"],
  };
  const keys = perTool[name] ?? ["file_path", "command", "pattern", "url", "query", "description", "path"];
  for (const k of keys) {
    const v = (input as Record<string, unknown>)[k];
    if (typeof v === "string" && v) return v;
  }
  return undefined;
}

type DeltaScratch = {
  blocks: Map<
    number,
    {
      kind: "text" | "thinking" | "tool_use";
      text?: string;
      redacted?: boolean;
      toolUseId?: string;
      toolName?: string;
      partialJson?: string;
    }
  >;
};

/**
 * Stable chronological sort with carry-forward for missing `createdAt`. The
 * various `setMessages` call sites all aim to keep the array chronological,
 * but cross-path races (a session_snapshot fallback firing before its
 * paginated turn arrives, a tail-window replay landing alongside a `loadOlder`
 * prepend) have produced non-chronological arrays. Sorting here at the hook
 * boundary makes downstream code (groupTurns, sticky-pin, scroll anchor)
 * independent of how setMessages assembled the array.
 *
 * Carry-forward rule: when a message has no `createdAt`, inherit the most
 * recent prior message's effective createdAt — but operate over *original*
 * array order, since carry-forward over a re-shuffled array would propagate
 * wrong times. In the steady state every assistant has a server-stamped or
 * synthesizeOlder-inherited `createdAt`, so the carry-forward is just a
 * safety net for live transient placeholders.
 *
 * Returns the original array reference when no reordering would happen so
 * React's referential equality checks downstream stay cheap.
 *
 * Exported for unit testing.
 */
export function sortMessagesByChronology(messages: DisplayMessage[]): DisplayMessage[] {
  if (messages.length <= 1) return messages;
  const n = messages.length;
  const effective = new Array<number>(n);
  let lastKnown = -Infinity;
  for (let i = 0; i < n; i++) {
    const at = messages[i]?.createdAt;
    if (typeof at === "number" && Number.isFinite(at)) {
      lastKnown = at;
      effective[i] = at;
    } else {
      effective[i] = lastKnown === -Infinity ? 0 : lastKnown;
    }
  }
  const indices = Array.from({ length: n }, (_, i) => i);
  indices.sort((a, b) => {
    if (effective[a] !== effective[b]) return effective[a] - effective[b];
    return a - b;
  });
  for (let i = 0; i < n; i++) {
    if (indices[i] !== i) return indices.map((j) => messages[j]);
  }
  return messages;
}

export function useSession(opts?: { defaultCwd?: string | null }): ChatState & ChatActions {
  // The cwd to use when creating a *fresh* session (no resume). Workspaces
  // leave this null and let the server resolve cwd from the active-workspace
  // cookie; customizations pass their mirror src dir so a brand-new chat lands
  // in the right place even on a direct deeplink (no cookie dependency). Held
  // in a ref so the create callbacks always read the latest without being
  // re-created on every prop change.
  const defaultCwdRef = useRef<string | null>(opts?.defaultCwd ?? null);
  defaultCwdRef.current = opts?.defaultCwd ?? null;
  const [sessionId, setSessionId] = useState<string | null>(null);
  // Stable per-mount tab identifier. Uses the same lazy-useState trick as
  // `useTabClaim` so it's generated once and never changes across re-renders.
  // Appended to the SSE URL (`?tabId=<id>`) so the server can assign and
  // track the write-lock holder across all browsers/contexts.
  const [myTabId] = useState(newTabId);
  // Track the committed pathname so the URL writer below can suppress
  // its replaceState when the user has navigated away from the chat
  // page. usePathname re-renders this hook on every Next.js commit, so
  // the effect that watches [sessionId, pathname] sees the new value
  // BEFORE we ever consider writing — which is the whole point of
  // moving the URL write out of bindToSession into an effect.
  const pathname = usePathname();
  const [ready, setReady] = useState(false);
  const [pending, setPending] = useState(false);
  // tabId of whichever client currently holds the write lock for this session.
  // Null means no holder is registered (no live subscriber sent a tabId yet).
  // readOnly is derived: holderId !== null && holderId !== myTabId.
  const [holderTabId, setHolderTabId] = useState<string | null>(null);
  const [messages, setMessages] = useState<DisplayMessage[]>([]);
  const [systemEntries, setSystemEntries] = useState<SystemEntry[]>([]);
  const [toolProgress, setToolProgress] = useState<Record<string, ToolProgressInfo>>({});
  const [queue, setQueue] = useState<QueuedMessage[]>([]);
  const [pendingPermission, setPendingPermission] = useState<PermissionRequestEvent | null>(null);
  const [pendingAsk, setPendingAsk] = useState<AskUserQuestionEvent | null>(null);
  const [feedbackSurvey, setFeedbackSurvey] = useState<FeedbackSurveyEvent | null>(null);
  // One-shot "Opus is overloaded — switch to Sonnet" banner, broadcast by the
  // server after a streak of 529s on Opus. Live-only: skipped in the SSE
  // replay buffer, so a stale nudge never re-pops on reload.
  const [opusOverloadNudge, setOpusOverloadNudge] =
    useState<OpusOverloadNudgeEvent | null>(null);
  // Live retry state derived directly from the SDK's `api_retry` system
  // message — no server broadcast needed since `Session.broadcast` already
  // forwards raw SDK messages verbatim. Cleared whenever a real assistant
  // message or a turn's `result` arrives (see below), so it can never
  // outlive the retry it describes.
  const [apiRetry, setApiRetry] = useState<ApiRetryState | null>(null);
  // One-shot "Extra usage is required for long context" banner, broadcast by
  // the server when a 1M-context session hits the SDK's `billing_error`.
  // Live-only: skipped in the SSE replay buffer so a stale event never
  // re-pops on reload.
  const [longContextCreditsNudge, setLongContextCreditsNudge] =
    useState<LongContextCreditsNudgeEvent | null>(null);
  // One-shot "Failed to authenticate" banner, broadcast by the server when
  // an SDK 401 (structured `authentication_failed` tag or synthetic "API
  // Error: 401" body) lands. Live-only: skipped in the SSE replay buffer
  // so a stale event never re-pops on reload.
  const [authFailedNudge, setAuthFailedNudge] =
    useState<AuthFailedNudgeEvent | null>(null);
  // One-shot "your login is about to expire" banner (CC 2.1.203 parity),
  // broadcast by the server when the active account profile's token falls
  // within the warning window. Live-only: skipped in the SSE replay buffer
  // so a stale warning never re-pops on reload.
  const [tokenExpiringNudge, setTokenExpiringNudge] =
    useState<TokenExpiringNudgeEvent | null>(null);
  // Server-driven spinner tips (see `tips` SSE event). Empty until the server
  // emits the catalog on subscribe; the renderer falls back to its built-in
  // defaults in the meantime.
  const [tips, setTips] = useState<Tip[]>([]);
  // "Where were we?" recap banner state. Driven by `session_recap` /
  // `session_recap_error` SSE events; cleared on the next user send.
  // Live-only on the wire: the server skips replay so a stale recap never
  // re-pops on reload — fresh away/return cycles refire if appropriate.
  const [sessionRecap, setSessionRecap] = useState<ChatState["sessionRecap"]>({
    status: "idle",
    text: null,
    at: null,
    origin: null,
    errorReason: null,
  });
  const [errors, setErrors] = useState<string[]>([]);
  const [slashCommands, setSlashCommands] = useState<string[]>([]);
  const [agents, setAgents] = useState<string[]>([]);
  // The main-thread agent this session runs as (SDK Options.agent), or null
  // for the default agent. Carried on the `ready` event (the SDK init message
  // doesn't include it). Drives the StatusLine "running as <agent>" badge.
  const [mainAgent, setMainAgent] = useState<string | null>(null);
  const [skills, setSkills] = useState<string[]>([]);
  const [cwd, setCwd] = useState<string | null>(null);
  // The agent's *effective* working directory, updated live from the SDK's
  // CwdChanged hook. Distinct from `cwd` (the session root): Claude Code now
  // spins up a git worktree for some work, which moves the effective cwd away
  // from the root so the user's "current changed files" don't reflect the
  // agent's edits. The StatusLine paints a "worktree" badge whenever this
  // differs from the root. Stored as the absolute path the SDK reports; when
  // the agent moves back to the root this becomes === cwd and the badge
  // self-clears (so there's no separate "exit" reset to forget).
  const [agentCwd, setAgentCwd] = useState<string | null>(null);
  const [usage, setUsage] = useState<SessionUsage | null>(null);
  const [planUsage, setPlanUsage] = useState<PlanRateLimits | null>(null);
  const [tasks, setTasks] = useState<Record<string, TaskInfo>>({});
  // Authoritative set of live background-task ids from the SDK's
  // `background_tasks_changed` message (0.3.203). REPLACE semantics, ids-only —
  // kept as an INDEPENDENT liveness gate, never merged into `tasks`/`TaskInfo`
  // (the payload has no status/description to merge). Its sole use is letting
  // the Activity rail drop a phantom "running" row that the unreliable terminal
  // `task_notification` never settled. `null` = no snapshot received yet → gate
  // inactive (we never hide a task we have no authoritative word on). The set is
  // per-process and resets to empty on CLI (re)start, so we clear it on
  // `system:init` and session switch. Ordering vs the task_* edge stream is
  // unspecified, so the gate only ever excludes at derivation time and
  // self-corrects on the next snapshot — it must not permanently hide a task.
  const [liveBackgroundTaskIds, setLiveBackgroundTaskIds] = useState<Set<string> | null>(null);
  const [subagentMessages, setSubagentMessages] = useState<Record<string, DisplayMessage[]>>({});
  const [pendingPlan, setPendingPlan] = useState<PendingPlan | null>(null);
  const [fastModeState, setFastModeState] = useState<"off" | "cooldown" | "on" | null>(null);
  // Transient transition toast (entered cooldown / recovered to on). The
  // persistent `⚡ cooldown` chip on the StatusLine already carries the
  // ongoing state — this only marks the edge moment and auto-fades. See
  // FastModeNoticePanel for the scope note on why reason+countdown are
  // omitted (no SDK signal for either).
  const [fastModeNotice, setFastModeNotice] = useState<
    { uuid: string; kind: "cooldown" | "recovered" } | null
  >(null);
  // Transient toast for a rejected `/model` switch — the local analogue of the
  // TUI's "Remote session couldn't switch to <model>" notice. Fires when the
  // POST /api/sessions/<id>/model round-trip returns a non-ok result (SDK
  // rejection); the picker's optimistic state has already flipped, so the
  // toast carries the *attempted* model and the `setModel` callback also
  // reverts to the authoritative value the server returns.
  const [modelSwitchNotice, setModelSwitchNotice] = useState<
    { uuid: string; attempted: string | null; error: string } | null
  >(null);
  /**
   * Transient toast shown when the user switches model via the `/model` slash
   * command in the chat. Carries the new model id so the banner can show
   * "Switched to X · Your pick becomes the default for new sessions" —
   * mirroring the Claude Code TUI's `/model` help text.
   */
  const [chatCommandModelNotice, setChatCommandModelNotice] = useState<{
    uuid: string;
    model: string;
  } | null>(null);
  /**
   * Transient toast shown when the server auto-disabled the advisor because
   * the user switched to an incompatible model. Carries the previous advisor
   * model id so the "Re-enable" button can restore it in one click.
   */
  const [advisorDisabledNotice, setAdvisorDisabledNotice] = useState<{
    uuid: string;
    previousAdvisor: string;
    newModel: string | undefined;
  } | null>(null);
  // Prior fast_mode_state observed on a result event. Used to detect edges
  // without depending on the (stale-in-closure) `fastModeState` state value.
  const prevFastModeStateRef = useRef<"off" | "cooldown" | "on" | null>(null);
  // Mirror of `replaying` for SSE callbacks — `applyEvent` is memoized and
  // doesn't capture `replaying`, but the fast-mode transition detector wants
  // to suppress notices while the replay buffer is folding history.
  const replayingRef = useRef<boolean>(true);
  const [promptSuggestions, setPromptSuggestions] = useState<string[]>([]);
  const [suggestedUuids, setSuggestedUuids] = useState<Set<string>>(() => new Set());
  const [goalUuids, setGoalUuids] = useState<Set<string>>(() => new Set());
  const [replaying, setReplaying] = useState(true);
  const [hasMoreAbove, setHasMoreAbove] = useState(false);
  const [loadingOlder, setLoadingOlder] = useState(false);
  const [latestTodos, setLatestTodos] = useState<AgentTodo[]>([]);
  /**
   * Server-driven staleness flag for the to-do list. True when the model has
   * gone several turns / many mid-turn tool calls with open items but no
   * TodoWrite/Task* touch — the UI dims the banner + shows a "stale" badge so
   * a frozen "0/N" stops reading as live truth. Mirrors the `todosStale`
   * field on `session_snapshot`; reset to false whenever the model re-engages
   * the list (a live TodoWrite/Task* tool_use) or the list is cleared.
   */
  const [todosStale, setTodosStale] = useState(false);
  /**
   * Transient toast state: set when the SERVER auto-closes the to-do
   * snapshot (stale 24h sweep or all-completed turn-end). Re-stamped on
   * every fire (the `id` discriminator is what the UI watches to retrigger
   * the auto-dismiss timer) so back-to-back auto-clears don't get
   * swallowed by an in-flight fade. Cleared by the toast component itself
   * once it finishes its fade.
   *
   * Manual user-driven clears DO NOT set this — the user already knows
   * what they just did, and an "I cleared the list" notification for
   * an action the user just took reads as either dismissive or chatty.
   */
  const [todosAutoCleared, setTodosAutoCleared] = useState<
    | { id: number; reason: "stale" | "completed"; count: number }
    | null
  >(null);
  const [recentEdits, setRecentEdits] = useState<RecentEdit[]>([]);
  const [backgroundBashes, setBackgroundBashes] = useState<Record<string, BackgroundBash>>({});
  /**
   * Active loops/wake-ups armed via the SDK's harness-provided
   * `CronCreate` / `ScheduleWakeup` tools. We populate this from the
   * client-side tool_use + tool_result stream because there's no other
   * Claudius-visible signal that a loop is running — the tools are not
   * Claudius code, the harness owns them.
   *
   * Keyed by stable id (cron id for crons, tool_use_id for wake-ups).
   * For crons, the entry is first written as `pending` on tool_use (keyed
   * by tool_use_id) and re-keyed under the real cron id once the matching
   * tool_result lands with `{ id, humanSchedule, durable, recurring }`.
   */
  const [scheduledLoops, setScheduledLoops] = useState<Record<string, ScheduledLoop>>({});
  const [toolHistory, setToolHistory] = useState<ToolHistoryEntry[]>([]);
  const [sessionTitle, setSessionTitle] = useState<string | null>(null);
  const [goal, setGoalState] = useState<GoalState | null>(null);

  // Reflect the bound session id in the URL so a refresh resumes the
  // same session. Used to be a raw `window.history.replaceState` call
  // inside bindToSession itself; moved here because that synchronous
  // write races with in-flight Next.js Link navigations.
  //
  // Why an effect:
  //   - usePathname() returns the COMMITTED pathname. Next.js commits
  //     a router.push BEFORE re-rendering the consumer tree, so by the
  //     time this effect re-runs after a navigation, pathname is the
  //     destination route — not the original `/`.
  //   - That means a click on a Link to /customize during boot will
  //     have flipped pathname to /customize by the time this effect
  //     considers writing — we skip the write and Next.js's pushState
  //     wins cleanly.
  //   - When the user is on / and bindToSession runs (boot or tab
  //     switch), pathname is "/" and we write `?session=<id>` exactly
  //     as before. The refresh-resume contract is preserved.
  //
  // Seed the auto-suggested badge set from the DB whenever the bound session
  // changes. The SDK JSONL doesn't carry suggestion provenance, so on reload we
  // re-fetch which user-message uuids came from a clicked suggestion chip.
  // `send()`/`flushQueue` add to this set optimistically for the live case, so
  // we merge (not replace) on resolve to avoid clobbering an in-flight click.
  useEffect(() => {
    setSuggestedUuids(new Set());
    if (!sessionId) return;
    let cancelled = false;
    void fetch(`/api/sessions/${sessionId}/suggested-messages`)
      .then((r) => (r.ok ? r.json() : { uuids: [] }))
      .then((data: { uuids?: string[] }) => {
        if (cancelled) return;
        const incoming = Array.isArray(data.uuids) ? data.uuids : [];
        if (incoming.length === 0) return;
        setSuggestedUuids((prev) => {
          const next = new Set(prev);
          for (const u of incoming) next.add(u);
          return next;
        });
      })
      .catch(() => {
        /* badge is best-effort — ignore fetch errors */
      });
    return () => {
      cancelled = true;
    };
  }, [sessionId]);

  // Seed the "Goal" badge set from the DB on session bind — same rationale as
  // the suggested-badge effect above: the SDK JSONL doesn't carry goal
  // provenance, so on reload we re-fetch which user-message uuids were sent as
  // the session goal. `send()`/`flushQueue` add optimistically for the live
  // case, so we merge (not replace) on resolve.
  useEffect(() => {
    setGoalUuids(new Set());
    if (!sessionId) return;
    let cancelled = false;
    void fetch(`/api/sessions/${sessionId}/goal-messages`)
      .then((r) => (r.ok ? r.json() : { uuids: [] }))
      .then((data: { uuids?: string[] }) => {
        if (cancelled) return;
        const incoming = Array.isArray(data.uuids) ? data.uuids : [];
        if (incoming.length === 0) return;
        setGoalUuids((prev) => {
          const next = new Set(prev);
          for (const u of incoming) next.add(u);
          return next;
        });
      })
      .catch(() => {
        /* badge is best-effort — ignore fetch errors */
      });
    return () => {
      cancelled = true;
    };
  }, [sessionId]);

  // The empty-string check on the existing `session` param avoids a
  // pointless replaceState (and the corresponding history-state churn)
  // when bindToSession is invoked with the id that's already in the URL.
  useEffect(() => {
    if (typeof window === "undefined") return;
    // Chat lives at `/` (bare root, which `app/page.tsx` redirects to the
    // active workspace) AND at `/<wks_…>` (the workspace-scoped chat root
    // under `app/[workspaceId]/page.tsx`). Any deeper path (`/<wks>/git`,
    // `/settings`, …) is a different surface and must not get a session
    // query string appended — both because the session id is meaningless
    // there AND because writing it would clobber the route on refresh.
    //
    // The previous guard only allowed `/`, so after the workspace-scoped
    // chat shipped the writer was a no-op on every page load — refreshing
    // chat lost the bound session id, and the boot path then created a
    // brand-new session because `?session=` was absent. Regression
    // reported by the user ("the current chat now doesn't have the
    // session id in the url, I wanted this").
    const isChatRoot =
      pathname === "/" ||
      /^\/wks_[a-f0-9]+\/?$/.test(pathname ?? "") ||
      /^\/customize\/cust_[a-f0-9]+\/chat\/?$/.test(pathname ?? "");
    if (!isChatRoot) return;
    if (!sessionId) return;
    // Defer the write so it lands AFTER any in-flight Next.js navigation
    // has had a chance to commit. usePathname returns the *committed*
    // pathname, and Next.js's commit only happens once the RSC payload
    // arrives — typically 200–400ms after the click on a Link. Without
    // this delay, the boot's createSession can resolve and fire this
    // effect during the racy window where the user has clicked
    // /customize but Next.js hasn't pushState'd yet; we'd write
    // `/?session=X` over Next.js's pending commit and the user would
    // end up stuck on `/`. 500ms is comfortably above the RSC-fetch
    // ceiling we see in dev and well below any waitForURL timeout in
    // the session-resume e2e specs (which use 30s).
    //
    // The late `window.location.pathname !== "/"` check below was the
    // original guard, but on CI under load it isn't enough: Next.js's
    // RSC fetch can outlast 500ms, so the timer fires while pathname
    // is still "/" — we write `?session=X`, and Next.js then bails its
    // pending navigation because the URL shifted underneath. (The CI
    // failure log polls the URL after the click and sees `/?session=X`
    // indefinitely, never `/customize`.)
    //
    // The actual fix is a document-level click listener in *capture*
    // phase: it fires synchronously the instant the user clicks an
    // anchor, *before* React's synthetic handler runs router.push and
    // *before* the RSC fetch begins. Setting `navigated` here gives
    // us a deterministic signal hundreds of ms before the timer fires.
    // The Navigation API's `navigate` event is kept as a secondary
    // signal for programmatic nav (router.push from a button, etc.)
    // that won't trip the click handler. Both are scoped to the wait
    // window and torn down in cleanup.
    //
    // Hash-only anchors (href="#" or "#section") don't navigate away
    // from `/`, so we keep the writer enabled for those.
    let navigated = false;

    const onAnchorClick = (e: MouseEvent) => {
      const t = e.target as HTMLElement | null;
      const a = t?.closest?.("a[href]") as HTMLAnchorElement | null;
      if (!a) return;
      const href = a.getAttribute("href");
      if (!href || href.startsWith("#")) return;
      navigated = true;
    };
    document.addEventListener("click", onAnchorClick, true);

    type NavTarget = {
      addEventListener?: (t: string, h: () => void) => void;
      removeEventListener?: (t: string, h: () => void) => void;
    };
    const nav = (window as unknown as { navigation?: NavTarget }).navigation;
    const onNav = () => {
      navigated = true;
    };
    nav?.addEventListener?.("navigate", onNav);

    const handle = setTimeout(() => {
      if (navigated) return;
      // Re-check committed pathname against the same "is this a chat root?"
      // predicate the effect-level guard used. The 500ms gap can let a
      // pending router navigation finish (committed pathname flips to
      // `/<wks>/git` etc.), in which case appending `?session=` to the new
      // path would clobber it.
      const livePath = window.location.pathname;
      const stillOnChatRoot =
        livePath === "/" ||
        /^\/wks_[a-f0-9]+\/?$/.test(livePath) ||
        /^\/customize\/cust_[a-f0-9]+\/chat\/?$/.test(livePath);
      if (!stillOnChatRoot) return;
      try {
        const url = new URL(window.location.href);
        if (
          url.searchParams.get("session") === sessionId &&
          !url.searchParams.has("at")
        ) {
          return;
        }
        url.searchParams.set("session", sessionId);
        url.searchParams.delete("at");
        window.history.replaceState(null, "", url.toString());
      } catch {
        // ignore — non-fatal
      }
    }, 500);
    return () => {
      clearTimeout(handle);
      document.removeEventListener("click", onAnchorClick, true);
      nav?.removeEventListener?.("navigate", onNav);
    };
  }, [sessionId, pathname]);

  const [permissionMode, setPermissionModeState] = useState<PermissionMode>("default");
  const [model, setModelState] = useState<string | null>(null);
  // Reasoning effort. The SDK doesn't expose the *current* effort on any
  // event we replay — there's no `effort_changed` analogue to
  // `model_changed`. We mirror what we know: "auto" until the user picks an
  // explicit level via the picker, then whatever they picked. A user who
  // types `/effort high` directly into the composer bypasses this mirror and
  // the card will lag — acceptable because the picker is the canonical
  // surface and the value re-syncs on the next picker interaction.
  const [effort, setEffortState] =
    useState<"low" | "medium" | "high" | "xhigh" | "max" | "auto">("auto");
  // "Ultracode" (Dynamic Workflows). Same optimistic-mirror story as
  // `effort` — no SDK event to replay, so we track the last toggle and
  // reset to off on a fresh session.
  const [ultracode, setUltracodeState] = useState<boolean>(false);
  // "Fast mode" user-toggle intent. Same optimistic-mirror story as
  // `ultracode` (no SDK event to replay, resets to off on a fresh session).
  // Distinct from `fastModeState` above (line ~472), which is the SDK-reported
  // runtime status (off/cooldown/on); this is just the last toggle the user
  // made through the picker.
  const [fastMode, setFastEnabled] = useState<boolean>(false);
  // Advisor model the SDK escalates to mid-turn. Same optimistic-mirror
  // pattern as `effort` / `ultracode` / `fastMode`: the SDK doesn't emit a
  // dedicated change event for this either, so the picker's pick is the
  // source of truth until the user reloads (after which it resets to null
  // here — the SDK still honors whatever settings.json holds via the
  // server-side forward at session start). `null` means "no per-session
  // override"; the actual value the SDK sees is whatever the user's
  // settings.json carries, or "no advisor" if absent there too.
  const [advisorModel, setAdvisorModelState] = useState<string | null>(null);
  const [sessions, setSessions] = useState<SessionInfo[]>([]);

  // Mirror `model` into the ref so SSE handlers can compute pricing without
  // re-binding on every model change.
  useEffect(() => {
    modelRef.current = model;
  }, [model]);

  const sessionIdRef = useRef<string | null>(null);
  const eventSourceRef = useRef<EventSource | null>(null);
  const messagesRef = useRef<DisplayMessage[]>([]);
  const scratchRef = useRef<Map<string, DeltaScratch>>(new Map());
  const lastAssistantUuidRef = useRef<string>("");
  const pendingRef = useRef(false);
  // Mirror of the polled sessions list. Used by the safety-net reconcile
  // interval below: a long-lived `useEffect` closes over its dependencies at
  // creation time, so reading `sessions` directly inside the interval would
  // see a frozen snapshot from when the effect was first wired up. The ref
  // is updated by a sibling effect every time `sessions` changes, so the
  // interval body always reads the latest list without retearing.
  const sessionsRef = useRef<SessionInfo[]>([]);
  useEffect(() => {
    sessionsRef.current = sessions;
  }, [sessions]);

  // Defensive chronological sort. The various `setMessages` call sites (live
  // SSE append, snapshot inject, optimistic send, `loadOlder` prepend,
  // `synthesizeOlder` pagination) each maintain order locally but cross-path
  // races have produced non-chronological arrays in the past — a tail-window
  // replay landing alongside a paginated older page, or a `session_snapshot`
  // fallback firing before its turn's user record reached the array. Rather
  // than chase every site, sort here at the hook boundary; see the helper
  // for the carry-forward rule.
  const sortedMessages = useMemo(() => sortMessagesByChronology(messages), [messages]);

  // Mirror SORTED messages into a ref so callbacks (loadOlder cursor, jump
  // resolvers) read the chronologically-oldest head rather than whatever
  // index 0 happened to be in the unsorted backing state.
  useEffect(() => {
    messagesRef.current = sortedMessages;
  }, [sortedMessages]);

  const hasMoreAboveRef = useRef(false);
  useEffect(() => {
    hasMoreAboveRef.current = hasMoreAbove;
  }, [hasMoreAbove]);

  const queueRef = useRef<QueuedMessage[]>([]);
  const pendingPermissionRef = useRef<PermissionRequestEvent | null>(null);
  const pendingPlanRef = useRef<PendingPlan | null>(null);
  // UUIDs of assistant messages whose `usage` has already been folded into
  // the running session totals. Streaming can re-emit the same uuid as
  // partials accumulate, and historical replays re-broadcast every
  // assistant message — we want each one counted exactly once.
  const countedUsageRef = useRef<Set<string>>(new Set());
  // Most-recent structured rate-limit payload (from `rate_limit_event`). The
  // *hard* limit hit doesn't arrive as a `rate_limit_event` — it comes as an
  // assistant message with `error: "rate_limit"` whose only content is the
  // prose "You've hit your session limit · resets …" (no structured
  // resetsAt / tier fields). We stash the last warning event's payload here so
  // the inline `RateLimitHitPanel` on that message can still show a live
  // countdown to the reset instead of bare prose. See `rateLimitHitFromBlocks`
  // and the assistant branch in `applyEvent`.
  const lastRateLimitInfoRef = useRef<SystemEntry["rateLimit"] | null>(null);
  // Session-configured fallback model id (SDK Options.fallbackModel), forwarded
  // from `SessionReadyEvent`. Stashed here so a later per-model weekly-limit
  // rejection can fold it into the `rateLimitHit` panel as the "Now using
  // <fallback>" takeover line — see `rateLimitHitFromBlocks`.
  const fallbackModelRef = useRef<string | null>(null);
  // Mirror of `model` for SSE callbacks. The pricing math needs the active
  // model name but the SSE event handler in `applyEvent` is stable (memoized
  // against state); a ref keeps it current without re-binding the EventSource.
  const modelRef = useRef<string | null>(null);
  // Mid-turn cost estimate accumulator. Per-assistant-message we estimate
  // cost from token counts using `costFromTokens` so the `$` tile updates
  // alongside the IN/OUT/CACHE tiles (the SDK's authoritative `total_cost_usd`
  // only lands on the `result` event at turn-end — until then the tile would
  // sit at $0.00 even with thousands of tokens flowing). At result time we
  // reconcile: subtract this turn's estimate and add the auth value.
  // Reset to 0 on every result event AND on session reset.
  // NOTE: subagent assistant events are intentionally counted here too — the
  // existing token accumulator includes them (see comment near `countedUsageRef`
  // dedupe below) and the SDK's `total_cost_usd` covers subagent cost as well,
  // so reconciliation nets to zero. Don't "fix" that without re-reading both
  // paths.
  const estimatedTurnCostRef = useRef<number>(0);
  // UUIDs of result events whose cost/turn totals have already been folded
  // into session state. EventSource reconnects (network blip, dev HMR,
  // tail-replay window) replay recent events, including the most recent
  // `result` — without dedupe, cost would get added each time and the `$`
  // tile would drift upward on every reconnect. Mirrors `countedUsageRef`'s
  // contract but for the turn-end frame.
  const seenResultUuidsRef = useRef<Set<string>>(new Set());
  // True while a server-dispatched `/compact` slash command — sent while
  // idle — is awaiting its outcome. Set on the `slash_invoked` breadcrumb,
  // cleared either by a successful `compact_boundary` (compaction worked) or,
  // as a fallback, by the very next `result` event. If it's still true when
  // a `result` lands, compaction never produced a boundary — an error
  // subtype means it failed; surfaced below instead of silently reverting
  // the "Compacting…" indicator (CC 2.1.216: "a failed /compact displays as
  // an error").
  //
  // Deliberately narrow: only armed when `!pendingRef.current` at the moment
  // `slash_invoked` arrives, i.e. no other turn was already in flight. A
  // `/compact` queued behind a running turn (`sendQueuedNow` / the `asap`
  // queue-dispatch mode) breaks the "next result belongs to this compact"
  // assumption — the prior turn's result would land first — so tracking is
  // skipped for that path rather than risking a misattributed banner. This
  // matches how Claudius's own Compact affordances already work: both
  // `ChatSurface.tsx`'s `startCompaction` (banner + StatusLine buttons) bail
  // out when `session.pending`, so the tracked path covers every UI-driven
  // compact; only a manually-typed `/compact` sent while mid-turn falls
  // outside it, and silently reverts as before (no regression, just no new
  // signal for that rarer case).
  const pendingCompactRef = useRef(false);
  // Dedupes the `slash_invoked` breadcrumb by uuid so an SSE reconnect's tail
  // replay (which resends recently-seen events, including one whose matching
  // `result` was already processed and dropped by `seenResultUuidsRef`'s
  // dedup) can't re-arm `pendingCompactRef` a second time with no live result
  // ever coming to clear it again.
  const seenCompactSlashUuidsRef = useRef<Set<string>>(new Set());
  // Per-scope (parent_tool_use_id, "" for top-level) → Anthropic message.id
  // currently being streamed. Captured from the inner `message_start` event
  // so subsequent content_block_* partials in the same scope can be anchored
  // on the same identity as the eventual terminal `SDKAssistantMessage`
  // events (which carry `message.id` directly). Cleared on `message_stop`.
  const scopeMessageIdRef = useRef<Map<string, string>>(new Map());
  // Monotonic counter for in-flight session transitions (switch / create).
  // Each call increments and captures it; after the wake POST resolves the
  // call rechecks the counter and bails if a newer transition has started.
  // Without this, two rapid switches (tab-click, then notification-jump,
  // for example) interleave their resetState/bindToSession pairs and the
  // chat ends up with messages from both sessions stacked together. The
  // SSE-close-at-top fix earlier in this file stops the OUT-of-band leak
  // through the EventSource; this counter stops the IN-band leak through
  // setMessages on a stale bindToSession callsite.
  const switchGenRef = useRef(0);

  // ── Local mirror of the server's authoritative queue ─────────────────
  //
  // The queue lives on the server now (lib/server/session.ts +
  // queued_messages SQLite table). The drain is driven by the Session's
  // `flushQueueIfIdle()` on every turn-end / answer / boot, independent of
  // whether this tab — or any tab — is connected.
  //
  // This hook just MIRRORS server state: every `queue:updated` SSE event
  // overwrites the local array. Mutations (enqueue, cancel, reorder) are
  // round-trips to the server; we don't optimistically update the queue
  // because the echo arrives within a few ms anyway and conflict-free
  // server state is more important than snappy local rearrangements.
  const writeQueueLocal = useCallback((next: QueuedMessage[]) => {
    queueRef.current = next;
    setQueue(next);
  }, []);

  const setPendingTracked = useCallback((p: boolean) => {
    pendingRef.current = p;
    setPending(p);
    // No queue drain here — the server's `flushQueueIfIdle` (in
    // `lib/server/session.ts`) fires on every turn-end / answer / boot, so
    // delivery is independent of any tab seeing the pending-edge transition.
  }, []);

  const resetState = useCallback(() => {
    setReady(false);
    setPending(false);
    setHolderTabId(null);
    pendingRef.current = false;
    setMessages([]);
    setSystemEntries([]);
    setToolProgress({});
    // Local queue is just a mirror of server state — clearing it here only
    // wipes the *view* for the outgoing session. The authoritative queue
    // sits in `queued_messages` on the server and stays intact; the
    // incoming session's `queue:updated` SSE echo on subscribe will repaint
    // the QueueIndicator strip with the right contents.
    setQueue([]);
    queueRef.current = [];
    setPendingPermission(null);
    pendingPermissionRef.current = null;
    setPendingAsk(null);
    setFeedbackSurvey(null);
    setOpusOverloadNudge(null);
    setApiRetry(null);
    setTips([]);
    // Reset recap state to idle on session switch — a recap belongs to the
    // session it was generated against, not the next one.
    setSessionRecap({
      status: "idle",
      text: null,
      at: null,
      origin: null,
      errorReason: null,
    });
    setErrors([]);
    setSlashCommands([]);
    setAgents([]);
    setMainAgent(null);
    setSkills([]);
    setCwd(null);
    setAgentCwd(null);
    setUsage(null);
    setPlanUsage(null);
    countedUsageRef.current = new Set();
    lastRateLimitInfoRef.current = null;
    estimatedTurnCostRef.current = 0;
    seenResultUuidsRef.current = new Set();
    setTasks({});
    setLiveBackgroundTaskIds(null);
    setSubagentMessages({});
    setPendingPlan(null);
    pendingPlanRef.current = null;
    setFastModeState(null);
    setFastModeNotice(null);
    prevFastModeStateRef.current = null;
    setPromptSuggestions([]);
    setReplaying(true);
    replayingRef.current = true;
    setHasMoreAbove(false);
    setLoadingOlder(false);
    setLatestTodos([]);
    // Cancel any in-flight auto-clear toast on session switch — it
    // belongs to the session we're leaving, not the one we're entering.
    setTodosAutoCleared(null);
    setRecentEdits([]);
    setBackgroundBashes({});
    setScheduledLoops({});
    setToolHistory([]);
    setSessionTitle(null);
    setGoalState(null);
    setPermissionModeState("default");
    setModelState(null);
    setEffortState("auto");
    setUltracodeState(false);
    setFastEnabled(false);
    setAdvisorModelState(null);
    scratchRef.current.clear();
    scopeMessageIdRef.current = new Map();
    lastAssistantUuidRef.current = "";
  }, []);

  const refreshSessions = useCallback(async () => {
    // Merge two sources so the dropdown shows historical sessions too — not
    // just whatever survives the in-memory reaper:
    //   - /api/sessions       → live sessions held by sessionManager
    //                           (freshest title from SSE, accurate `model`)
    //   - /api/sessions/all   → durable JSONL list with `lastModified` for
    //                           sorting and `customTitle` for renamed sessions
    //
    // Live wins on overlap. We sort by recency and keep the top 20 — the
    // dropdown links to /sessions for the long tail.
    //
    // IMPORTANT (2026-05-12): we deliberately do NOT use `summary` or
    // `firstPrompt` from the disk row as a title fallback. The SDK
    // computes `summary` as `customTitle || aiTitle || lastPrompt ||
    // summaryHint || firstPrompt`, so when the user hasn't renamed the
    // session, both fields collapse to prompt text — and tabs end up
    // labelled with a sentence the user typed instead of a name. Mirrors
    // the server-side `resolveSessionTitle` invariant. When no trusted
    // title exists, leave it null and `tabLabelFor` renders the id prefix.
    try {
      const [liveRes, diskRes] = await Promise.allSettled([
        fetch("/api/sessions"),
        fetch("/api/sessions/all?limit=25"),
      ]);

      let live: SessionInfo[] = [];
      if (liveRes.status === "fulfilled" && liveRes.value.ok) {
        const data = (await liveRes.value.json()) as unknown;
        if (Array.isArray(data)) live = data as SessionInfo[];
      }

      type DiskItem = {
        sessionId: string;
        /** Title persisted in our SQLite index (per-project `.claudius.db`).
         *  Set by `setSessionTitle` on every Claudius-side rename, even
         *  when the SDK's `renameSession` couldn't write the JSONL header
         *  yet. This is the authoritative signal that the user named the
         *  session — see the API route comment for the full rationale. */
        claudiusTitle?: string;
        /** Title persisted by the SDK in the JSONL header. Set by the
         *  TUI's `/rename`, by `renameSession` when it succeeds, and by
         *  the SDK's auto-derived `aiTitle`. Empty for sessions renamed
         *  before their first turn flushed to disk. */
        customTitle?: string;
        summary?: string;
        firstPrompt?: string;
        lastModified?: number;
        cwd?: string;
      };
      let disk: DiskItem[] = [];
      if (diskRes.status === "fulfilled" && diskRes.value.ok) {
        const data = (await diskRes.value.json()) as { sessions?: unknown };
        if (Array.isArray(data.sessions)) disk = data.sessions as DiskItem[];
      }

      const byId = new Map<string, SessionInfo>();
      // Seed with disk first so live entries can override cwd/model/title.
      for (const d of disk) {
        if (!d.sessionId) continue;
        // Trusted sources only — see the IMPORTANT note at the top of
        // this callback. Prefer our DB title (claudiusTitle) over the
        // SDK's customTitle since the DB write survives the JSONL-not-
        // yet-flushed window; never use summary/firstPrompt as a title
        // because those collapse to prompt text.
        const title =
          (d.claudiusTitle && d.claudiusTitle.trim()) ||
          (d.customTitle && d.customTitle.trim()) ||
          null;
        byId.set(d.sessionId, {
          id: d.sessionId,
          cwd: d.cwd,
          title,
          lastModified: d.lastModified,
        });
      }
      for (const l of live) {
        if (!l?.id) continue;
        const prev = byId.get(l.id);
        byId.set(l.id, {
          ...prev,
          ...l,
          // Live `title` is null until the user renames — fall back to
          // the trusted disk title (customTitle only, no prompt text).
          // When everything is null, `tabLabelFor` renders the id prefix.
          title: l.title ?? prev?.title ?? null,
          // Live-only entries (just spawned, no JSONL flush yet) get
          // "right now" so they bubble to the top of the recency sort.
          lastModified: prev?.lastModified ?? Date.now(),
        });
      }

      const sorted = [...byId.values()].sort(
        (a, b) => (b.lastModified ?? 0) - (a.lastModified ?? 0),
      );
      const top = sorted.slice(0, 20);
      // Always keep every live session present so the SessionTabs status
      // dot has a status field to read for tabs whose JSONL `lastModified`
      // is old enough that recency sort pushed them past the cutoff. A live
      // tab paints "running"/"idle"; without this fallback it would silently
      // revert to "background" and confuse the user.
      const liveIds = new Set(live.map((l) => l.id));
      const inTop = new Set(top.map((s) => s.id));
      const extras = sorted.filter((s) => liveIds.has(s.id) && !inTop.has(s.id));
      const merged = extras.length === 0 ? top : [...top, ...extras];

      setSessions(merged);
      // Return the merged list so visibility-change callers can reconcile
      // the active session's `pending` flag without racing on the next
      // render. Sessions state-setter above is the source of truth for
      // every other consumer; the return value is purely for in-flight
      // reads in the same callback.
      return merged;
    } catch {
      // ignore
      return [] as SessionInfo[];
    }
  }, []);

  // Re-pull the sessions list when the tab regains focus. Background tabs
  // may have started or finished turns while this client was asleep — without
  // this poke the SessionTabs status dots would freeze at whatever the
  // server returned on last refresh.
  //
  // Using `visibilitychange` (not `focus`) so a window getting moved between
  // monitors doesn't fire a spurious refresh, and so it actually catches the
  // common case of switching desktops / coming back from a long sleep.
  useEffect(() => {
    function onVis() {
      if (document.hidden) return;
      void (async () => {
        const merged = await refreshSessions();
        // Reconcile the active session's `pending` flag against the
        // server's authoritative status. Symptom this addresses: the user
        // reported "sessions appear running while no work is happening,
        // refresh shows the agent was actually stopped." That's a
        // one-way drift — client believes running, server says idle —
        // typically caused by the EventSource silently dropping a
        // `turn_status: idle` event during a tab-hidden window (laptop
        // sleep, OS throttling, NAT idle timeout on the SSE socket). The
        // refresh above already pulls authoritative status; cheap to
        // also reconcile pending while we're here.
        //
        // We deliberately only flip TRUE → FALSE here. The opposite
        // direction (client idle, server running) would also need to
        // rehydrate any open ask-user / permission prompts and any
        // streaming state — refreshSessions doesn't fetch those, so
        // unilaterally flipping pending to true would leave the
        // StatusLine pulsing with no matching UI elsewhere. A future
        // fix for that direction needs a fuller resubscribe; out of
        // scope here per the reported bug.
        const id = sessionIdRef.current;
        if (!id) return;
        const active = merged.find((s) => s.id === id);
        if (!active) return;
        if (pendingRef.current && active.status !== "running") {
          setPendingTracked(false);
        }
      })();
    }
    document.addEventListener("visibilitychange", onVis);
    return () => document.removeEventListener("visibilitychange", onVis);
  }, [refreshSessions, setPendingTracked]);

  // Safety-net poll for the same `turn_status: idle` drift the
  // visibility-change handler above addresses. That handler only fires
  // when the OS-level tab regains visibility — a user who stays focused on
  // Claudius for tens of minutes while the SSE silently drops an `idle`
  // event (NAT timeout, proxy buffering, an in-flight OS sleep that didn't
  // hide the tab) would otherwise watch the StatusLine and the tab dots
  // stay pinned at "Working" until they happened to switch desktops or
  // reload — the exact symptom the user reported ("sessions that are done
  // with work but keep the state running … if I leave the tab and get back
  // it updates the state or if I refresh also gets the right state").
  //
  // Covers two distinct surfaces, each with its own bias toward drift:
  //
  //   1. ACTIVE session — only source of `pending` is the EventSource at
  //      use-session.ts:~3226. A dropped `turn_status: idle` event leaves
  //      `pendingRef.current === true` and the StatusLine pulsing.
  //
  //   2. BACKGROUND tabs — no SSE of their own. Their dot in SessionTabs
  //      is driven by the polled list (`session.sessions`, written by
  //      `refreshSessions`), which only re-runs on the active session's
  //      `result` event, on visibilitychange, or on switchSession /
  //      createSession / rename. A background session that goes idle in
  //      between those triggers stays "Working" in the strip until one of
  //      them fires — and the active session being already-idle can starve
  //      every one of them indefinitely.
  //
  // The gate fires the poll if EITHER the active session believes it's
  // pending OR any session in the polled list still reads `running`. This
  // is deliberately a low-frequency safety net — a healthy SSE connection
  // delivers `turn_status: idle` within milliseconds and always wins; we
  // only need to catch the drift cases.
  //
  // `sessionsRef.current` is the live mirror of `sessions` (kept in sync
  // by the sibling effect at the ref's declaration site) so the closed-
  // over snapshot in this interval doesn't go stale across re-renders.
  // Gated on `!document.hidden` so the visibility-change handler owns the
  // tab-foregrounded case without us doubling up on setState.
  //
  // Same one-way contract as the visibility handler: TRUE → FALSE only.
  // The FALSE → TRUE direction (server says running, client says idle)
  // would also need to rehydrate any open ask-user / permission prompts
  // and any streaming state — `refreshSessions` doesn't fetch those, so
  // unilaterally flipping the active session to pending would leave the
  // StatusLine pulsing with no matching UI elsewhere. A missed turn
  // *start* signal therefore remains uncovered; the reported bug was a
  // false-positive "Working" badge, and that's what we fix here.
  //
  // 30 s cadence: long enough to be invisible in steady state; short
  // enough that a drift episode self-heals within one tip-rotation window
  // so the user never has to think about it.
  useEffect(() => {
    const timer = setInterval(() => {
      if (document.hidden) return;
      const anyBackgroundRunning = sessionsRef.current.some(
        (s) => s.status === "running",
      );
      if (!pendingRef.current && !anyBackgroundRunning) return;
      void (async () => {
        const merged = await refreshSessions();
        const id = sessionIdRef.current;
        if (!id) return;
        const active = merged.find((s) => s.id === id);
        if (!active) return;
        if (pendingRef.current && active.status !== "running") {
          setPendingTracked(false);
        }
      })();
    }, 30_000);
    return () => clearInterval(timer);
  }, [refreshSessions, setPendingTracked]);

  // Tear down in-flight UI markers when the turn ends. The activity rail and
  // the "Claude streaming…" indicator are driven by per-block "running" flags
  // cleared by their own terminal events (tool_result, message_stop). When a
  // turn ends abnormally — interrupt, aborted stream, or an SDK that skipped
  // the terminal event for a parallel subagent's tool — those never arrive and
  // the rail stays stuck "running" even though the session is idle. Sweep them
  // to idle on the authoritative turn-end signals (`result` / `turn_status:
  // idle`). Background work tracks its own liveness elsewhere (see idle-reconcile).
  const reconcileToIdle = useCallback(() => {
    setMessages((prev) => clearStreaming(prev));
    setToolHistory((prev) => sweepToolHistoryDone(prev, Date.now()));
    setToolProgress((prev) => (Object.keys(prev).length === 0 ? prev : {}));
  }, []);

  // Ref to the "load older pages until all task pills are visible" helper.
  // Populated after `loadOlder` is defined (see the useEffect below); the
  // task_snapshot handler in applyEvent calls it via this ref so it doesn't
  // need to close over `loadOlder` (which would widen the memo dependency
  // array and make applyEvent recreate on every loading-state change).
  // The second argument is the raw snapshot entries used as fallback data
  // when the original parent message was compacted away from the JSONL.
  const loadUntilTasksFoundRef = useRef<
    ((tasks: Array<{ toolUseId: string; entry: TaskSnapshotEntry }>) => Promise<void>) | null
  >(null);

  const applyEvent = useCallback(
    (ev: ServerEvent) => {
      if (replayDebugEnabled()) {

        console.log("[replay-debug] recv", summarizeEventForDebug(ev));
      }
      if (ev.type === "ready") {
        setReady(true);
        setMainAgent(ev.agent ?? null);
        fallbackModelRef.current = ev.fallbackModel ?? null;
        return;
      }
      if (ev.type === "holder_changed") {
        setHolderTabId(ev.holderId);
        return;
      }
      if (ev.type === "error") {
        setErrors((e) => [...e, ev.message]);
        setPendingTracked(false);
        return;
      }
      if (ev.type === "todos_auto_cleared") {
        // Transient toast: server announces a system-initiated clear
        // (stale 24h sweep or all-completed turn-end). The toast
        // component watches `todosAutoCleared.id` to retrigger its
        // auto-dismiss timer on each fire, so a back-to-back clear is
        // not swallowed by an in-flight fade. `Date.now()` + a tiny
        // tie-breaker so the same-millisecond case still strictly
        // increments.
        setTodosAutoCleared((prev) => ({
          id: (prev?.id ?? Date.now()) + 1 > Date.now() ? (prev?.id ?? Date.now()) + 1 : Date.now(),
          reason: ev.reason,
          count: ev.count,
        }));
        return;
      }
      if (ev.type === "permission_request") {
        setPendingPermission(ev);
        pendingPermissionRef.current = ev;
        return;
      }
      if (ev.type === "ask_user_question") {
        setPendingAsk(ev);
        return;
      }
      if (ev.type === "feedback_survey") {
        setFeedbackSurvey(ev);
        return;
      }
      if (ev.type === "opus_overload_nudge") {
        setOpusOverloadNudge(ev);
        return;
      }
      if (ev.type === "long_context_credits_required") {
        setLongContextCreditsNudge(ev);
        return;
      }
      if (ev.type === "auth_failed_required") {
        setAuthFailedNudge(ev);
        return;
      }
      if (ev.type === "token_expiring_required") {
        setTokenExpiringNudge(ev);
        return;
      }
      if (ev.type === "mcp_needs_auth_notice") {
        // CC 2.1.193 — inject a transcript info pill pointing the user at /mcp.
        const count = ev.servers.length;
        const names = ev.servers.join(", ");
        const word = count === 1 ? "server needs" : "servers need";
        setSystemEntries((prev) => [
          ...prev,
          {
            uuid: crypto.randomUUID(),
            afterMessageUuid: lastAssistantUuidRef.current,
            kind: "info" as const,
            label: `MCP ${word} auth: ${names} · open /mcp to connect`,
          },
        ]);
        return;
      }
      if (ev.type === "tips") {
        setTips(ev.tips);
        return;
      }
      if (ev.type === "queue:updated") {
        // Authoritative snapshot of the server-side queue. Replace local
        // state wholesale — we don't try to merge optimistic in-flight
        // edits because the server broadcasts back within milliseconds of
        // every mutation and conflict-free reconciliation matters more
        // than micro-snappy rearrangements.
        const next: QueuedMessage[] = ev.queue.map((q) => ({
          id: q.uuid,
          text: q.text,
          ...(q.hasImages ? { hasImages: true } : {}),
          ...(q.slash ? { slash: true } : {}),
          ...(q.fromSuggestion ? { fromSuggestion: true } : {}),
          ...(q.fromGoal ? { fromGoal: true } : {}),
        }));
        writeQueueLocal(next);
        return;
      }
      if (ev.type === "session_recap") {
        setSessionRecap({
          status: "ready",
          text: ev.text,
          at: ev.at,
          origin: ev.origin,
          errorReason: null,
        });
        return;
      }
      if (ev.type === "session_recap_error") {
        // Only transition out of `loading` — never clobber a successful
        // `ready` from the very same session. Two-tab race example: tab B
        // fast-fails `rate_limited` (instant) while tab A's recap completes
        // and broadcasts a `session_recap` (~seconds). Both events fan out
        // to both tabs; if the error were applied unconditionally it'd
        // overwrite the freshly-rendered recap in whichever tab the events
        // happened to arrive in that order. Failed events are only useful
        // for the tab that issued the request.
        setSessionRecap((cur) => {
          if (cur.status !== "loading") return cur;
          if (ev.reason === "failed") {
            return {
              status: "error",
              text: null,
              at: null,
              origin: cur.origin,
              errorReason: ev.message ?? "failed",
            };
          }
          // For silent expected skips (disabled / no_history / rate_limited)
          // we drop back to idle — no banner, no error noise.
          return {
            status: "idle",
            text: null,
            at: null,
            origin: null,
            errorReason: null,
          };
        });
        return;
      }
      if (ev.type === "plan_usage") {
        setPlanUsage({
          subscriptionType: ev.subscriptionType,
          rateLimitsAvailable: ev.rateLimitsAvailable,
          rateLimits: ev.rateLimits ?? null,
          ...(ev.modelScoped ? { modelScoped: ev.modelScoped } : {}),
          fetchedAt: ev.fetchedAt,
          stale: false,
        });
        return;
      }
      if (ev.type === "plan_usage_unavailable") {
        // A fetch attempt failed — flag whatever plan-usage data we're
        // already showing as stale (last-known, not live). Nothing to flag
        // if we've never had a successful fetch yet.
        setPlanUsage((prev) => (prev ? { ...prev, stale: true } : prev));
        return;
      }
      if (ev.type === "plan_approval_request") {
        const next: PendingPlan = {
          requestId: ev.requestId,
          toolUseId: ev.toolUseId,
          plan: ev.plan,
          ...(ev.raw ? { raw: ev.raw } : {}),
        };
        setPendingPlan(next);
        pendingPlanRef.current = next;
        return;
      }
      if (ev.type === "mode_changed") {
        setPermissionModeState(ev.mode);
        return;
      }
      if (ev.type === "model_changed") {
        setModelState(ev.model ?? null);
        // When the switch came from a `/model` chat command (not the picker),
        // surface the "Your pick becomes the default for new sessions" notice.
        if (ev.source === "chat_command" && ev.model) {
          setChatCommandModelNotice({ uuid: crypto.randomUUID(), model: ev.model });
        }
        return;
      }
      if (ev.type === "advisor_disabled_on_model_change") {
        // Mirror the advisor clear so the SessionCard badge reflects "no
        // advisor" immediately without a round-trip to the GET endpoint.
        setAdvisorModelState(null);
        setAdvisorDisabledNotice({
          uuid: crypto.randomUUID(),
          previousAdvisor: ev.previousAdvisor,
          newModel: ev.newModel,
        });
        return;
      }
      if (ev.type === "agent_changed") {
        setMainAgent(ev.agent);
        return;
      }
      if (ev.type === "session_title") {
        setSessionTitle(ev.title ?? null);
        return;
      }
      if (ev.type === "goal_changed") {
        // Full goal-state snapshot — set, replaced, cleared, or achieved.
        // `goal === null` clears the banner; otherwise mirror the server's
        // achievement + summary so the banner can switch to its done state.
        setGoalState(
          ev.goal
            ? {
                text: ev.goal,
                achieved: Boolean(ev.achieved),
                summary: ev.summary ?? null,
                setAt: ev.setAt ?? null,
                achievedAt: ev.achievedAt ?? null,
              }
            : null,
        );
        return;
      }
      if (ev.type === "session_snapshot") {
        // Server-side derived-state rehydration. Carries derived state
        // that lives upstream of the tail-replay window:
        //   - Latest TodoWrite payload (so the rail repopulates).
        //   - Last real user prompt (so the chat shows "what did I ask?"
        //     even when the prompt is buried under a long tool chain
        //     and the tail window dropped it off the top).
        if (Array.isArray(ev.todos)) setLatestTodos(coerceTodos(ev.todos));
        // Mirror the server's staleness flag. Optional on the wire — absent
        // means "unchanged", so only react when it's an explicit boolean.
        if (typeof ev.todosStale === "boolean") setTodosStale(ev.todosStale);
        const prompt = ev.lastUserPrompt;
        if (prompt && prompt.uuid && prompt.text) {
          // Inject the user message into the transcript if the SSE replay
          // didn't already deliver it. Dedupe by uuid so a later replay-
          // window fix or a history load doesn't double-render it.
          //
          // Insert in CHRONOLOGICAL position by `prompt.at`, not blind-
          // prepend. The previous prepend assumed the snapshot's prompt
          // was older than everything currently in the replay window — but
          // the snapshot is the server's most-recent prompt, and when the
          // SSE replay window happens to include an OLDER prompt while
          // missing the snapshot's, prepending puts a chronologically
          // NEWER bubble at array index 0. The pin walk and turn grouping
          // then disagree about which prompt is "latest" and the wrong
          // one ends up sticky-pinned. Inserting by timestamp keeps the
          // array chronological so downstream consumers (groupTurns,
          // lastUserUuid, the auto-scroll anchor) stay in agreement.
          //
          // Fallback: if `prompt.at` is missing, drop to the legacy
          // prepend — better than appending blindly, since "no timestamp"
          // is correlated with the original tail-truncation case where
          // the prompt really is older than the visible tail.
          setMessages((prev) => {
            if (prev.some((m) => m.uuid === prompt.uuid)) return prev;
            const newBubble: DisplayMessage = {
              uuid: prompt.uuid,
              role: "user",
              blocks: [{ kind: "text", text: prompt.text }],
              ...(typeof prompt.at === "number" ? { createdAt: prompt.at } : {}),
            };
            if (typeof prompt.at !== "number") {
              return [newBubble, ...prev];
            }
            // Find the first existing message that's strictly NEWER than
            // the snapshot — insert before it. Messages without a
            // timestamp are skipped (treated as "unknown position"), so
            // the snapshot doesn't get pushed past them either way.
            let insertAt = prev.length;
            for (let i = 0; i < prev.length; i++) {
              const at = prev[i]?.createdAt;
              if (typeof at === "number" && at > prompt.at) {
                insertAt = i;
                break;
              }
            }
            return [...prev.slice(0, insertAt), newBubble, ...prev.slice(insertAt)];
          });
        }
        return;
      }
      if (ev.type === "task_snapshot") {
        // Rehydrate subagent (Task) metadata + inner conversations persisted
        // server-side. These ride on transient SSE-only events (task_progress
        // / task_notification + parent_tool_use_id messages) that never reach
        // the JSONL, so a session rebuilt from disk loses them. We only fill
        // gaps: anything already restored from the buffer replay (a still-live
        // session) is fresher and wins — so this never clobbers live state and
        // never double-counts usage (the handler deliberately leaves `usage`
        // alone).
        setTasks((prev) => {
          let changed = false;
          const next = { ...prev };
          for (const t of ev.tasks) {
            // A replayed Workflow launch ack (a normal sdk event in the replay
            // window) may have re-seeded a provisional keyed by this task's
            // tool_use_id. The snapshot carries the authoritative real task, so
            // drop the placeholder to avoid a duplicate row (handles the
            // ordering where the ack replays before this snapshot; the reverse
            // order is covered by upsertProvisionalTask's real-task guard).
            if (t.toolUseId && next[t.toolUseId]?.provisional) {
              delete next[t.toolUseId];
              changed = true;
            }
            if (next[t.taskId]) continue;
            next[t.taskId] = {
              taskId: t.taskId,
              toolUseId: t.toolUseId,
              description: t.description ?? "(no description)",
              taskType: t.taskType,
              workflowName: t.workflowName,
              status: (t.status as TaskInfo["status"]) ?? "completed",
              totalTokens: t.totalTokens,
              toolUses: t.toolUses,
              durationMs: t.durationMs,
              summary: t.summary,
              error: t.error,
            };
            changed = true;
          }
          return changed ? next : prev;
        });
        setSubagentMessages((prev) => {
          let changed = false;
          const next = { ...prev };
          for (const t of ev.tasks) {
            if (!t.toolUseId) continue;
            if ((next[t.toolUseId]?.length ?? 0) > 0) continue;
            const built = buildSubagentMessages(t.innerMessages, t.toolUseId);
            if (built.length > 0) {
              next[t.toolUseId] = built;
              changed = true;
            }
          }
          return changed ? next : prev;
        });
        // If any persisted task pills live in a part of the transcript that's
        // beyond the current tail window (or were compacted away), make them
        // visible. Two paths:
        //   1. hasMoreAbove=true  → load older pages until the parent message
        //      arrives in the rendered list (normal "scrolled past tail" case).
        //   2. hasMoreAbove=false → the message no longer exists in history
        //      (SDK automatic compaction removed it). Synthesize a minimal
        //      assistant message carrying the tool_use block so the TaskBlock
        //      still renders with all the SQLite-recovered metadata and the
        //      inner conversation.
        {
          // Only recover GENUINELY orphaned tasks. `shouldRecoverOrphanTask`
          // excludes running tasks: on reattach to a live session the snapshot
          // can land before replay paints the running subagent's tool_use
          // block, and synthesizing a placeholder for it prepends a duplicate
          // pill ABOVE the user's prompt ("agent started before my message").
          // The live stream links the real pill by tool_use_id instead.
          const unlinked = ev.tasks
            .filter((t) => shouldRecoverOrphanTask(t, messagesRef.current))
            .map((t) => ({ toolUseId: t.toolUseId, entry: t }));
          if (unlinked.length > 0) {
            void loadUntilTasksFoundRef.current?.(unlinked);
          }
        }
        return;
      }
      if (ev.type === "turn_status") {
        // Authoritative "is the agent busy?" signal from the server. Fires
        // on transitions of `turnInFlight` / pending-prompt maps, and is
        // re-emitted after `replay_done` so a tab that attached mid-turn
        // (long Bash, slow tool) paints the StatusLine / tab dot correctly
        // even when no further assistant chunks arrive.
        setPendingTracked(ev.status === "running");
        // Idle turn → clear any stuck "running" rail rows / streaming markers
        // (a tab attaching to an already-idle session gets this via the
        // server's turn_status re-emit on subscribe).
        if (ev.status === "idle") reconcileToIdle();
        return;
      }
      if (ev.type === "cwd_changed") {
        // The agent's effective working directory moved (typically into a git
        // worktree). Store the absolute path; StatusLine compares it against
        // the session root to decide whether to show the "worktree" badge. No
        // explicit exit-reset is needed: when the agent returns to the root,
        // this event fires with `cwd === root`, the stored value equals the
        // root, and the badge self-clears.
        setAgentCwd(ev.cwd);
        return;
      }
      if (ev.type === "replay_done") {
        setReplaying(false);
        replayingRef.current = false;
        setHasMoreAbove(ev.hasMoreAbove);
        // The assistant-message handler marks every replayed message as
        // `streaming: true` and flips pending — that's correct for live
        // turns but wrong for historical ones. Reconcile here once the
        // replay window is over.
        setMessages((prev) => prev.map((m) => (m.streaming ? { ...m, streaming: false } : m)));
        setPendingTracked(false);
        // Recovery for in-flight interactive prompts. The server's
        // subscribe() re-emits these on attach, but in dev-mode HMR an
        // existing Session instance can stay bound to a pre-edit
        // prototype — the resolved API route below always picks up edits,
        // so this fetch is the belt to the subscribe()'s suspenders.
        const id = sessionIdRef.current;
        if (id) {
          void fetch(`/api/sessions/${id}/pending-prompts`)
            .then(async (res) => {
              if (!res.ok) return;
              const j = (await res.json().catch(() => ({}))) as {
                asks?: AskUserQuestionEvent[];
                permissions?: PermissionRequestEvent[];
              };
              if (sessionIdRef.current !== id) return; // user switched
              const ask = j.asks?.[0];
              if (ask) {
                setPendingAsk(ask);
              }
              const perm = j.permissions?.[0];
              if (perm) {
                setPendingPermission(perm);
                pendingPermissionRef.current = perm;
              }
            })
            .catch(() => {
              // Best-effort — the subscribe() path is the primary delivery.
            });
        }
        return;
      }
      if (ev.type !== "sdk") return;

      const msg = ev.message;

      if (msg.type === "assistant") {
        // A real assistant message means the request succeeded (with or
        // without prior retries) — clear any in-flight retry indicator so
        // the spinner tip doesn't keep announcing a retry that's over.
        setApiRetry((prev) => (prev ? null : prev));
        const beta = msg.message as {
          id?: string;
          content?: unknown;
          usage?: {
            input_tokens?: number;
            output_tokens?: number;
            cache_read_input_tokens?: number;
            cache_creation_input_tokens?: number;
          };
        };
        const sdkUuid = msg.uuid;
        // Anthropic message id, shared across every SDK split of one API
        // response. The SDK emits one `SDKAssistantMessage` per content block
        // with its own wrapper uuid but the same `message.id` — coalesce on
        // that id so [thinking, tool_use] renders as one bubble rather than
        // two. Fall back to the wrapper uuid when the inner id is missing
        // (defensive: synthetic events, older replays).
        const messageId = typeof beta.id === "string" && beta.id ? beta.id : sdkUuid;
        // For token / cost dedupe, key on `messageId` rather than the wrapper
        // uuid. Each split carries the full turn `usage` payload — keying on
        // wrapper uuid double-counts by the number of splits (a thinking +
        // tool_use response would count usage twice).
        const usageDedupKey = messageId;

        // Accumulate per-API-call token usage so the rail meters update
        // mid-turn (the `result` event only fires when the whole turn ends).
        // Counted before the subagent early-return so sub-agent tokens land
        // in the session total too. Cost is left alone — that needs the
        // pricing math the SDK does in its result event.
        if (beta.usage && !countedUsageRef.current.has(usageDedupKey)) {
          countedUsageRef.current.add(usageDedupKey);
          const u = beta.usage;
          // Estimate per-call cost so the `$` tile updates alongside the
          // token tiles. Reconciled with the SDK's authoritative
          // `total_cost_usd` at result-event time (see below). Falls back to
          // Sonnet pricing when the model is unknown, which is good enough
          // for a mid-turn indicator — the auth value replaces it within a
          // few seconds anyway.
          const turnEstimate = costFromTokens(
            (beta as { model?: string }).model ?? modelRef.current ?? undefined,
            {
              input: u.input_tokens ?? 0,
              output: u.output_tokens ?? 0,
              cacheRead: u.cache_read_input_tokens ?? 0,
              cacheWrite5m: u.cache_creation_input_tokens ?? 0,
              cacheWrite1h: 0,
            },
          );
          estimatedTurnCostRef.current += turnEstimate;
          setUsage((prev) => ({
            totalCostUsd: (prev?.totalCostUsd ?? 0) + turnEstimate,
            numTurns: prev?.numTurns ?? 0,
            durationMs: prev?.durationMs ?? 0,
            durationApiMs: prev?.durationApiMs ?? 0,
            inputTokens: (prev?.inputTokens ?? 0) + (u.input_tokens ?? 0),
            outputTokens: (prev?.outputTokens ?? 0) + (u.output_tokens ?? 0),
            cacheReadInputTokens:
              (prev?.cacheReadInputTokens ?? 0) + (u.cache_read_input_tokens ?? 0),
            cacheCreationInputTokens:
              (prev?.cacheCreationInputTokens ?? 0) + (u.cache_creation_input_tokens ?? 0),
            modelUsage: prev?.modelUsage,
          }));
        }

        const parent = (msg as { parent_tool_use_id?: string | null }).parent_tool_use_id ?? null;
        // SDK 0.3.214 — true when this split was truncated by an
        // interrupt/abort before the stream completed (content may end
        // mid-word). Forwarded to `upsertAssistantSplit` for both the
        // top-level and subagent paths below.
        const aborted = (msg as { aborted?: true }).aborted === true;
        const blocks = blocksFromSDKContent(beta?.content);
        // If we already have a streaming scratch keyed on this messageId, the
        // bubble's blocks are being assembled live from content_block_*
        // deltas — the terminal split's content is already represented there.
        // Append from terminal only when no scratch exists (replay path or
        // SDK builds without partials).
        const hasStreamScratch = (scratchRef.current.get(messageId)?.blocks.size ?? 0) > 0;
        if (parent) {
          // Subagent traffic — keep separate from the main transcript. Note:
          // the rate-limit-hit detection below this early-return is top-level
          // only, so a subagent that hits the wall shows bare prose without the
          // panel. Acceptable for now (the wall is a session-wide condition the
          // top-level turn surfaces too); revisit if subagents need it.
          setSubagentMessages((prev) => ({
            ...prev,
            [parent]: upsertAssistantSplit(
              prev[parent] ?? [],
              messageId,
              sdkUuid,
              blocks,
              hasStreamScratch,
              parent,
              ev.at,
              undefined,
              undefined,
              aborted,
            ),
          }));
          // Don't override the main lastAssistantUuid — deltas anchor to top-level.
          return;
        }
        // Hard rate-limit hit. The SDK reports the *wall* as an assistant
        // message ("You've hit your session limit · resets …") rather than a
        // structured `rate_limit_event`, so the rich `RateLimitPill` never
        // fires on its own and the user is left with bare prose and no next
        // step. Tag the bubble so it renders an inline actionable panel (CLI
        // `/rate-limit-options` parity: countdown + upgrade links). See
        // `AssistantMessage` / `RateLimitHitPanel`.
        //
        // Two detection paths (see `isRateLimitHitText`): the `error` field
        // live, the prose when replaying — `getSessionMessages` and the
        // `/transcript` route both strip `error` and the warning events.
        // Carried on the message (not a system pill) because the bubble is
        // built by three separate paths — this live one, resume replay, and
        // `synthesizeOlder` pagination — and only the message reaches them all.
        const assistantError = (msg as { error?: string }).error;
        const rateLimitHit =
          assistantError === "rate_limit" || isRateLimitHitText(blocks)
            ? rateLimitHitFromBlocks(blocks, lastRateLimitInfoRef.current, fallbackModelRef.current)
            : undefined;
        // Opus-4 high-demand banner: backend emits the CTA as assistant prose
        // (no `error` field, no structured event), so it's prose-only on both
        // live and replay paths. Tagging the bubble lets `AssistantMessage`
        // render the inline `OpusHighDemandPanel` with the /model hint.
        const opusHighDemand = isOpusHighDemandText(blocks) ? true : undefined;
        // Model-unavailable notice: replace the SDK's "issue with the selected
        // model" prose with our actionable copy (use a different model + learn
        // more). The selected model isn't enabled for this account/region.
        const displayBlocks = rewriteModelUnavailableBlocks(blocks, assistantError);
        lastAssistantUuidRef.current = messageId;
        setMessages((prev) =>
          upsertAssistantSplit(
            prev,
            messageId,
            sdkUuid,
            displayBlocks,
            hasStreamScratch,
            undefined,
            ev.at,
            rateLimitHit,
            opusHighDemand,
            aborted,
          ),
        );
        setPendingTracked(true);

        // Activity-rail: surface thinking phases that arrived on the
        // terminal assistant split (i.e. JSONL replay on reload, or a
        // turn whose stream_event partials never reached this tab).
        // The live path adds the same key from `content_block_start` —
        // the dedup-by-id below means we don't double-insert. We mark
        // these "done" because by the time the terminal split lands the
        // thinking block is complete; for the live path the entry is
        // already present and is marked done by `message_stop`.
        for (let i = 0; i < blocks.length; i++) {
          const b = blocks[i];
          if (b.kind !== "thinking") continue;
          const thinkingId = `thinking:${messageId}:${i}`;
          setToolHistory((prev) => {
            if (prev.some((e) => e.toolUseId === thinkingId)) return prev;
            const entry: ToolHistoryEntry = {
              toolUseId: thinkingId,
              toolName: b.redacted ? "Thinking (encrypted)" : "Thinking",
              startedAt: Date.now(),
              done: true,
              endedAt: Date.now(),
              kind: "thinking",
            };
            return [entry, ...prev].slice(0, 100);
          });
        }
        // Activity-rail reducers: per-tool side effects.
        for (const b of blocks) {
          if (b.kind !== "tool_use") continue;

          // Tool history — record every tool_use exactly once, regardless of
          // whether downstream tool_progress events ever fire.
          setToolHistory((prev) => {
            if (prev.some((e) => e.toolUseId === b.id)) return prev;
            const entry: ToolHistoryEntry = {
              toolUseId: b.id,
              toolName: b.name,
              primaryArg: pickPrimaryArg(b.name, b.input),
              startedAt: Date.now(),
              parentToolUseId: parent,
            };
            return [entry, ...prev].slice(0, 100);
          });

          // ExitPlanMode is intercepted server-side in canUseTool — the
          // browser receives a `plan_approval_request` event instead, so the
          // tool_use block doesn't need any special handling here.

          // TodoWrite — capture the latest todos snapshot (legacy; kept for
          // backward compat with sessions predating the Task tools).
          if (b.name === "TodoWrite") {
            const raw = (b.input as { todos?: unknown }).todos;
            if (Array.isArray(raw)) setLatestTodos(coerceTodos(raw));
            // NOTE: do NOT optimistically clear `todosStale` here. A touch is
            // not progress — the runaway failure mode IS the model re-emitting
            // / growing the list without completing anything. The server flips
            // `todosStale` only on real progress (more items done, or pruned)
            // and broadcasts it via `session_snapshot`; we mirror that.
            continue;
          }

          // TaskCreate — add a pending todo keyed by tool_use_id; the real
          // task id arrives in the matching tool_result and will be promoted
          // there. Dedup by id so replayed streams don't create duplicates.
          if (b.name === "TaskCreate") {
            const inp = b.input as {
              subject?: unknown;
              description?: unknown;
              activeForm?: unknown;
            };
            const content = typeof inp.subject === "string" ? inp.subject : "";
            setLatestTodos((prev) => {
              if (prev.some((t) => t.id === b.id)) return prev;
              return [
                ...prev,
                {
                  id: b.id, // temp key; re-keyed on tool_result
                  content,
                  status: "pending",
                  activeForm: typeof inp.activeForm === "string" ? inp.activeForm : undefined,
                },
              ];
            });
            // No optimistic un-stale — adding an item isn't progress; the
            // server owns the `todosStale` flag (see the TodoWrite note above).
            continue;
          }

          // TaskUpdate — apply status/subject changes in-place by taskId.
          // Applied eagerly on tool_use (same pattern as CronDelete).
          if (b.name === "TaskUpdate") {
            const inp = b.input as {
              taskId?: unknown;
              subject?: unknown;
              status?: unknown;
            };
            const taskId = typeof inp.taskId === "string" ? inp.taskId : null;
            if (taskId) {
              setLatestTodos((prev) => {
                const idx = prev.findIndex((t) => t.id === taskId);
                if (idx === -1) return prev;
                const status = typeof inp.status === "string" ? inp.status : null;
                // Deleted tasks are removed from the list entirely.
                if (status === "deleted") return prev.filter((_, i) => i !== idx);
                const updated = { ...prev[idx] };
                if (status) updated.status = status;
                if (typeof inp.subject === "string" && inp.subject) updated.content = inp.subject;
                const copy = prev.slice();
                copy[idx] = updated;
                return copy;
              });
            }
            // The server re-evaluates progress at turn end and broadcasts the
            // authoritative `todosStale` — a completion there un-stales, a
            // status churn does not. We don't second-guess it client-side.
            continue;
          }

          // Edit / MultiEdit / Write — record the path for the Recent Edits widget.
          if (b.name === "Edit" || b.name === "MultiEdit" || b.name === "Write") {
            const fp = (b.input as { file_path?: unknown }).file_path;
            if (typeof fp === "string" && fp) {
              setRecentEdits((prev) => {
                if (prev.some((r) => r.toolUseId === b.id)) return prev;
                return [
                  { toolUseId: b.id, toolName: b.name, filePath: fp, startedAt: Date.now() },
                  ...prev,
                ].slice(0, 20);
              });
            }
            continue;
          }

          // Bash with run_in_background — track as a backgrounded shell.
          if (b.name === "Bash") {
            const inp = b.input as { command?: unknown; run_in_background?: unknown };
            if (inp.run_in_background === true && typeof inp.command === "string") {
              setBackgroundBashes((prev) => {
                if (prev[b.id]) return prev;
                const entry: BackgroundBash = {
                  toolUseId: b.id,
                  command: inp.command as string,
                  // Anchor to when the shell was originally launched. `ev.at` is
                  // the JSONL timestamp on replay (page refresh / tab switch) and
                  // the live broadcast time otherwise — using Date.now() here
                  // would restart the elapsed timer every time the event replays.
                  // Mirrors the scheduled-loops `startedAt` handling below.
                  startedAt: ev.at ?? Date.now(),
                };
                return { ...prev, [b.id]: entry };
              });
            }
            continue;
          }

          // KillBash — mark the matching bash entry as killed.
          if (b.name === "KillBash") {
            const sid = (b.input as { shell_id?: unknown; bash_id?: unknown }).shell_id ??
              (b.input as { bash_id?: unknown }).bash_id;
            if (typeof sid === "string") {
              setBackgroundBashes((prev) => {
                // shell_id may be a SDK-side id (not the tool_use_id) — try
                // both: exact tool_use_id match, else best-effort by command
                // start substring.
                if (prev[sid]) {
                  return { ...prev, [sid]: { ...prev[sid], killed: true } };
                }
                return prev;
              });
            }
            continue;
          }

          // CronCreate — store a *pending* entry keyed by tool_use_id; the
          // matching tool_result carries the real cron id and humanSchedule,
          // and that's where we re-key into the active loops map. We seed the
          // entry here so the rail can show "Arming…" the instant the tool
          // fires (before its result lands).
          if (b.name === "CronCreate") {
            const inp = b.input as {
              cron?: unknown;
              prompt?: unknown;
              recurring?: unknown;
            };
            const cron = typeof inp.cron === "string" ? inp.cron : "";
            const prompt = typeof inp.prompt === "string" ? inp.prompt : "";
            if (cron) {
              setScheduledLoops((prev) => {
                if (prev[b.id]) return prev;
                // Also skip if this same tool_use was already promoted
                // to its real cron id under a *different* map key by an
                // earlier tool_result. Without this scan, a replayed
                // CronCreate would re-create the pending entry beside
                // the promoted one — two chips for one loop.
                for (const v of Object.values(prev)) {
                  if (v.toolUseId === b.id) return prev;
                }
                const entry: ScheduledLoop = {
                  kind: "cron",
                  id: b.id, // re-keyed to real cron id on tool_result
                  toolUseId: b.id,
                  cron,
                  humanSchedule: null,
                  delaySeconds: null,
                  prompt,
                  recurring: inp.recurring === true,
                  durable: false,
                  // Anchor to when the loop was originally armed (the
                  // SSE event's `at` is the JSONL timestamp on replay,
                  // or the live broadcast time otherwise). Using
                  // Date.now() here would reset the countdown on every
                  // page refresh. See `lib/server/session.ts`
                  // `trackScheduledLoops` for the matching server-side
                  // logic — keep these in sync.
                  startedAt: ev.at ?? Date.now(),
                };
                return { ...prev, [b.id]: entry };
              });
            }
            continue;
          }

          // CronDelete — mark the matching loop as cancelled. The agent
          // calls this when the user (or this UI's Cancel button) asks to
          // stop a loop. We don't actually remove the entry — leaving it
          // visible with a "cancelled" tone gives the user closure.
          if (b.name === "CronDelete") {
            const idRaw = (b.input as { id?: unknown }).id;
            const id = typeof idRaw === "string" ? idRaw : null;
            if (id) {
              setScheduledLoops((prev) => {
                if (!prev[id]) return prev;
                return { ...prev, [id]: { ...prev[id], cancelled: true } };
              });
            }
            continue;
          }

          // ScheduleWakeup — one-shot dynamic wake-up. There's no result-side
          // id to bind (the tool returns nothing useful), so we key by the
          // tool_use_id itself. Lives in the rail until either replaced by
          // the next ScheduleWakeup or the session ends.
          if (b.name === "ScheduleWakeup") {
            const inp = b.input as {
              delaySeconds?: unknown;
              reason?: unknown;
              prompt?: unknown;
            };
            const delay = typeof inp.delaySeconds === "number" ? inp.delaySeconds : null;
            const prompt = typeof inp.prompt === "string" ? inp.prompt : "";
            const reason = typeof inp.reason === "string" ? inp.reason : undefined;
            setScheduledLoops((prev) => {
              // Dedup: if we've already tracked this exact tool_use,
              // don't reset its startedAt by re-running the "delete
              // prior wake-ups" step. Replays of the same SSE event
              // (page refresh, tab switch) must be idempotent or the
              // chip's countdown jumps back to the full delay every
              // time. The first observation already captured the real
              // arming time via `ev.at`.
              if (prev[b.id]) return prev;
              // Replace any prior pending wake-up — dynamic-mode loops chain
              // one wake-up per turn, so only the latest is "armed".
              const next: Record<string, ScheduledLoop> = {};
              for (const [k, v] of Object.entries(prev)) {
                if (v.kind === "wakeup" && !v.cancelled) continue;
                next[k] = v;
              }
              const entry: ScheduledLoop = {
                kind: "wakeup",
                id: b.id,
                toolUseId: b.id,
                cron: null,
                humanSchedule: null,
                delaySeconds: delay,
                prompt,
                reason,
                recurring: false,
                durable: false,
                // Original arming time — JSONL timestamp on replay, live
                // broadcast time otherwise. Critical for countdown
                // stability across reloads (see server-side
                // `trackScheduledLoops` for the matching logic).
                startedAt: ev.at ?? Date.now(),
              };
              next[b.id] = entry;
              return next;
            });
            continue;
          }
        }
        return;
      }

      if (msg.type === "stream_event") {
        const sm = msg as {
          uuid: string;
          parent_tool_use_id?: string | null;
          event: {
            type: string;
            index?: number;
            content_block?: SDKContentBlock;
            delta?: { type: string; text?: string; thinking?: string; partial_json?: string };
            message?: { id?: string };
          };
        };
        const evt = sm.event;
        // Anchor partials on the inner Anthropic `message.id`, not on the
        // SDK wrapper uuid — those wrappers are minted PER stream_event and
        // PER terminal split, so they don't match each other and don't match
        // across deltas. Capture the message.id from `message_start` and
        // hold it per-scope until `message_stop`, then key the scratch and
        // bubble lookup on that id. The eventual `SDKAssistantMessage`
        // splits carry the same id directly, so the assistant-handler and
        // this branch land on the same bubble.
        const subagentParent = sm.parent_tool_use_id ?? null;
        const scopeKey = subagentParent ?? "";
        if (evt.type === "message_start" && evt.message?.id) {
          scopeMessageIdRef.current.set(scopeKey, evt.message.id);
          // Initialize a (possibly empty) scratch so subsequent
          // content_block_start events have a slot. No bubble yet — we wait
          // for the first content_block_start so an empty placeholder bubble
          // doesn't flash.
          if (!scratchRef.current.has(evt.message.id)) {
            scratchRef.current.set(evt.message.id, { blocks: new Map() });
          }
          return;
        }
        // Resolve anchor from the per-scope map. Fall back to sm.uuid for
        // defensive coverage — message_start may be missing from a buffer
        // window that started mid-message after a reconnect.
        const anchor = scopeMessageIdRef.current.get(scopeKey) ?? sm.uuid;
        if (!anchor) return;
        let scratch = scratchRef.current.get(anchor);
        if (!scratch) {
          scratch = { blocks: new Map() };
          scratchRef.current.set(anchor, scratch);
        }
        if (evt.type === "content_block_start" && typeof evt.index === "number" && evt.content_block) {
          const cb = evt.content_block;
          if (cb.type === "text")
            scratch.blocks.set(evt.index, { kind: "text", text: typeof cb.text === "string" ? cb.text : "" });
          else if (cb.type === "thinking" || cb.type === "redacted_thinking") {
            const redacted = cb.type === "redacted_thinking";
            scratch.blocks.set(evt.index, {
              kind: "thinking",
              text: cb.type === "thinking" && typeof cb.thinking === "string" ? cb.thinking : "",
              ...(redacted ? { redacted: true } : {}),
            });
            // Surface the thinking phase in the right-pane Tools list as a
            // synthetic spinner row. Keyed on `thinking:<msgId>:<idx>` so a
            // subsequent message_stop / replay can mark this exact entry
            // done without colliding with real tool_use ids. Skipped for
            // subagent turns — those don't push into the top-level tool
            // history today (only the parent Task tool_use is tracked).
            if (!subagentParent) {
              const thinkingId = `thinking:${anchor}:${evt.index}`;
              setToolHistory((prev) => {
                if (prev.some((e) => e.toolUseId === thinkingId)) return prev;
                const entry: ToolHistoryEntry = {
                  toolUseId: thinkingId,
                  toolName: redacted ? "Thinking (encrypted)" : "Thinking",
                  startedAt: Date.now(),
                  kind: "thinking",
                };
                return [entry, ...prev].slice(0, 100);
              });
            }
          } else if (cb.type === "tool_use") {
            const tu = cb as Extract<SDKContentBlock, { type: "tool_use" }>;
            scratch.blocks.set(evt.index, { kind: "tool_use", toolUseId: tu.id, toolName: tu.name, partialJson: "" });
          }
        } else if (evt.type === "content_block_delta" && typeof evt.index === "number" && evt.delta) {
          const slot = scratch.blocks.get(evt.index);
          if (!slot) return;
          if (evt.delta.type === "text_delta" && evt.delta.text) slot.text = (slot.text ?? "") + evt.delta.text;
          else if (evt.delta.type === "thinking_delta" && evt.delta.thinking)
            slot.text = (slot.text ?? "") + evt.delta.thinking;
          else if (evt.delta.type === "input_json_delta" && evt.delta.partial_json)
            slot.partialJson = (slot.partialJson ?? "") + evt.delta.partial_json;
        } else if (evt.type === "content_block_stop" && typeof evt.index === "number" && evt.content_block) {
          // Some SDK builds emit the final block payload here rather than
          // streaming deltas through the whole turn (notably for short
          // thinking blocks). Fold the stop payload into the slot if the
          // deltas didn't fill it.
          const cb = evt.content_block;
          const slot = scratch.blocks.get(evt.index);
          if (
            slot &&
            slot.kind === "thinking" &&
            !slot.text &&
            cb.type === "thinking" &&
            typeof cb.thinking === "string"
          ) {
            // Narrow on the discriminator AND the field — the catch-all arm
            // of `SDKContentBlock` carries an `[k: string]: unknown` index
            // signature that poisons a bare `cb.thinking` access. The typeof
            // guard collapses it back to `string`.
            slot.text = cb.thinking;
          }
        } else if (evt.type === "message_stop") {
          if (subagentParent) {
            setSubagentMessages((prev) => ({
              ...prev,
              [subagentParent]: (prev[subagentParent] ?? []).map((m) =>
                m.uuid === anchor ? { ...m, streaming: false } : m,
              ),
            }));
          } else {
            setMessages((prev) => prev.map((m) => (m.uuid === anchor ? { ...m, streaming: false } : m)));
            // Close out any synthetic thinking rows owned by this message —
            // their id namespace is `thinking:<anchor>:<idx>`. Real tool_use
            // rows resolve via their tool_result; thinking has no result, so
            // we use message_stop as the falling edge.
            setToolHistory((prev) => {
              const prefix = `thinking:${anchor}:`;
              let changed = false;
              const next = prev.map((e) => {
                if (e.kind !== "thinking" || e.done) return e;
                if (!e.toolUseId.startsWith(prefix)) return e;
                changed = true;
                // Clear the live estimate on close — it's approximate and the
                // authoritative billed tokens come from the result's usage.
                return { ...e, done: true, endedAt: Date.now(), estimatedThinkingTokens: undefined };
              });
              return changed ? next : prev;
            });
          }
          // Release the scope so the next message_start in this scope mints
          // a fresh anchor instead of inheriting the just-closed message's.
          if (scopeMessageIdRef.current.get(scopeKey) === anchor) {
            scopeMessageIdRef.current.delete(scopeKey);
          }
          return;
        } else {
          return;
        }
        const buildMerged = (existingBlocks: DisplayBlock[]): DisplayBlock[] => {
          const merged: DisplayBlock[] = [];
          const indices = [...scratch!.blocks.keys()].sort((a, b) => a - b);
          for (const i of indices) {
            const slot = scratch!.blocks.get(i)!;
            if (slot.kind === "text") merged.push({ kind: "text", text: slot.text ?? "" });
            else if (slot.kind === "thinking")
              merged.push({
                kind: "thinking",
                text: slot.text ?? "",
                ...(slot.redacted ? { redacted: true } : {}),
              });
            else if (slot.kind === "tool_use") {
              let parsed: Record<string, unknown> = {};
              try {
                parsed = slot.partialJson ? JSON.parse(slot.partialJson) : {};
              } catch {
                parsed = { __partial: slot.partialJson ?? "" };
              }
              merged.push({
                kind: "tool_use",
                id: slot.toolUseId ?? "",
                name: slot.toolName ?? "",
                input: parsed,
              });
            }
          }
          // Preserve any tool_result already folded onto a tool_use we own —
          // the result lands via a separate `user`/`tool_result` event and
          // would otherwise get wiped on every scratch flush.
          const preservedResults = new Map<string, { content: string; isError?: boolean }>();
          // Same preservation for `startedAt` — the elapsed-time badge needs
          // a stable start, not one that resets every streamed delta.
          const preservedStartedAt = new Map<string, number>();
          for (const b of existingBlocks) {
            if (b.kind === "tool_use" && b.result) preservedResults.set(b.id, b.result);
            if (b.kind === "tool_use" && b.startedAt) preservedStartedAt.set(b.id, b.startedAt);
          }
          for (const b of merged) {
            if (b.kind === "tool_use" && preservedResults.has(b.id)) b.result = preservedResults.get(b.id);
            if (b.kind === "tool_use") b.startedAt = preservedStartedAt.get(b.id) ?? Date.now();
          }
          return merged;
        };
        if (subagentParent) {
          setSubagentMessages((prev) => {
            const list = prev[subagentParent] ?? [];
            const idx = list.findIndex((m) => m.uuid === anchor);
            if (idx === -1) {
              // Partial for a subagent whose terminal `assistant` hasn't
              // landed yet — seed a placeholder at the Anthropic message.id
              // so the eventual terminal splits land on the same bubble.
              const placeholder: DisplayMessage = {
                uuid: anchor,
                role: "assistant",
                blocks: buildMerged([]),
                streaming: true,
                parentToolUseId: subagentParent,
                ...(typeof ev.at === "number" ? { createdAt: ev.at } : {}),
              };
              return { ...prev, [subagentParent]: [...list, placeholder] };
            }
            const next = list.slice();
            next[idx] = { ...next[idx], blocks: buildMerged(next[idx].blocks) };
            return { ...prev, [subagentParent]: next };
          });
        } else {
          setMessages((prev) => {
            const idx = prev.findIndex((m) => m.uuid === anchor);
            if (idx === -1) {
              // Partial whose terminal `assistant` event hasn't landed yet
              // (the common path with includePartialMessages: true) — seed
              // a placeholder keyed on the Anthropic message.id so the
              // eventual terminal splits merge into this same bubble.
              const placeholder: DisplayMessage = {
                uuid: anchor,
                role: "assistant",
                blocks: buildMerged([]),
                streaming: true,
                ...(typeof ev.at === "number" ? { createdAt: ev.at } : {}),
              };
              // Keep the "latest top-level assistant" pointer in sync so
              // system pills (status, rate_limit) anchor under the active
              // bubble rather than the previous turn's.
              lastAssistantUuidRef.current = anchor;
              return [...prev, placeholder];
            }
            const next = prev.slice();
            next[idx] = { ...next[idx], blocks: buildMerged(next[idx].blocks) };
            return next;
          });
        }
        return;
      }

      if (msg.type === "user") {
        const inner = (msg as { message: { content?: unknown } }).message;
        const isSynthetic = (msg as { isSynthetic?: boolean }).isSynthetic === true;
        const parent = (msg as { parent_tool_use_id?: string | null }).parent_tool_use_id ?? null;
        const result = extractToolResult(inner?.content);
        if (result) {
          // Tool results land on whichever tool_use carries that id, in main or subagent.
          setMessages((prev) =>
            prev.map((m) => ({
              ...m,
              blocks: m.blocks.map((b) =>
                b.kind === "tool_use" && b.id === result.tool_use_id
                  ? { ...b, result: { content: result.text, isError: result.isError } }
                  : b,
              ),
            })),
          );
          setSubagentMessages((prev) => {
            const next = { ...prev };
            for (const [pid, list] of Object.entries(prev)) {
              next[pid] = list.map((m) => ({
                ...m,
                blocks: m.blocks.map((b) =>
                  b.kind === "tool_use" && b.id === result.tool_use_id
                    ? { ...b, result: { content: result.text, isError: result.isError } }
                    : b,
                ),
              }));
            }
            return next;
          });
          setToolProgress((prev) => {
            if (!(result.tool_use_id in prev)) return prev;
            const copy = { ...prev };
            delete copy[result.tool_use_id];
            return copy;
          });
          // Mark the tool_history entry done.
          setToolHistory((prev) => {
            const idx = prev.findIndex((e) => e.toolUseId === result.tool_use_id);
            if (idx === -1) return prev;
            const copy = prev.slice();
            copy[idx] = {
              ...copy[idx],
              done: true,
              endedAt: Date.now(),
              isError: result.isError,
            };
            return copy;
          });
          // Mark a tracked recent-edit as done (best-effort — toolUseId match).
          setRecentEdits((prev) => {
            const idx = prev.findIndex((r) => r.toolUseId === result.tool_use_id);
            if (idx === -1) return prev;
            const copy = prev.slice();
            copy[idx] = { ...copy[idx], done: true, isError: result.isError };
            return copy;
          });
          // Reconcile subagent (Task) status off its tool_result. The SDK's
          // terminal `task_notification` isn't reliably delivered for parallel
          // subagents (and can arrive under a mismatched task_id), which left
          // the TaskBlock and the background-tasks rail stuck on "running"
          // after the agent had already finished. The tool_result on the Task
          // tool_use is the authoritative "subagent returned" signal. Skip
          // backgrounded tasks — their first tool_result is just a "started in
          // background" ack; their real completion rides on task_notification.
          // (Nested subagent Tasks live in subagentMessages, not the main
          // transcript, so the input lookup can miss them — `reconcileTasksOnToolResult`
          // also honours each task's own `isBackgrounded` flag as a fallback.)
          const taskToolBlock = findToolUseBlock(result.tool_use_id, messagesRef.current);
          setTasks((prev) =>
            reconcileTasksOnToolResult(
              prev,
              result.tool_use_id,
              result.isError,
              isBackgroundedToolUse(taskToolBlock),
            ),
          );
          // The Workflow tool returns a "started in background, here's the
          // runId" ack in ~0s, but the SDK's `task_started` for the underlying
          // `local_workflow` task can lag until the runtime spins up its first
          // agent — a dead-zone where the workflow is alive but the rail shows
          // nothing. Seed a provisional "running" row off the ack so "Tasks"
          // lights up immediately; `task_started` later replaces it (same
          // tool_use_id) with the real task, carrying the start time forward.
          if (taskToolBlock?.name === "Workflow" && !result.isError) {
            const meta = parseWorkflowMeta(
              (taskToolBlock.input as { script?: unknown }).script as string | undefined,
            );
            const toolUseId = result.tool_use_id;
            setTasks((prev) =>
              upsertProvisionalTask(prev, {
                taskId: toolUseId,
                toolUseId,
                description:
                  meta.description ??
                  (meta.name ? `Workflow ${meta.name}` : "Workflow running in background"),
                taskType: "local_workflow",
                workflowName: meta.name,
                status: "running",
                isBackgrounded: true,
                startedAt: Date.now(),
                provisional: true,
              }),
            );
          }
          // If this tool_result is the launch acknowledgement for a background
          // bash, extract the SDK-side `bash_id` so the viewer can stitch
          // subsequent BashOutput results.
          setBackgroundBashes((prev) => {
            const entry = prev[result.tool_use_id];
            if (!entry || entry.bashId) return prev;
            const m = result.text.match(/bash[_-]?(?:id)?[: ]+([\w-]+)/i);
            const bashId = m?.[1];
            if (!bashId) return prev;
            return { ...prev, [result.tool_use_id]: { ...entry, bashId } };
          });
          // Auto-backgrounded-on-timeout (SDK 0.3.210): the structured
          // `tool_use_result` sibling of `message.content` carries the raw
          // `BashOutput`, including `timedOutAfterMs` when the command hit
          // its timeout and was moved to background — regardless of
          // whether it was launched with `run_in_background`. Reuses
          // `taskToolBlock` resolved above (any tool_use lookup by id).
          if (taskToolBlock?.name === "Bash") {
            const toolUseResult = (msg as { tool_use_result?: unknown }).tool_use_result as
              | BashToolUseResult
              | undefined;
            const command = (taskToolBlock.input as { command?: unknown }).command;
            setBackgroundBashes((prev) =>
              applyBashAutoBackground(prev, {
                toolUseId: result.tool_use_id,
                command: typeof command === "string" ? command : "",
                toolUseResult,
                startedAt: ev.at ?? Date.now(),
              }),
            );
          }
          // CronCreate result — re-key the pending entry under the real cron
          // id and fold in `humanSchedule` / durability flags. The text shape
          // we parse against (recorded from a real session) looks like:
          //
          //   "Scheduled recurring job 1545ddb6 (Every minute). Session-only
          //    (not written to disk, dies when Claude exits). Auto-expires
          //    after 7 days. Use CronDelete to cancel sooner."
          //
          // If parsing fails (text shape changes), we leave the pending
          // entry in place keyed by tool_use_id — visible but with a
          // synthetic id. Better than dropping it on the floor.
          setScheduledLoops((prev) => {
            const pending = prev[result.tool_use_id];
            if (!pending || pending.kind !== "cron") return prev;
            if (result.isError) {
              const copy = { ...prev };
              delete copy[result.tool_use_id];
              return copy;
            }
            const idMatch = result.text.match(/job\s+([a-z0-9]+)\s*\(([^)]+)\)/i);
            const cronId = idMatch?.[1] ?? pending.toolUseId;
            const humanSchedule = idMatch?.[2] ?? null;
            const durable = !/session[- ]only/i.test(result.text);
            const promoted: ScheduledLoop = {
              ...pending,
              id: cronId,
              humanSchedule,
              durable,
            };
            const copy = { ...prev };
            delete copy[result.tool_use_id];
            copy[cronId] = promoted;
            return copy;
          });
          // TaskCreate result — re-key the pending entry (stored under tool_use_id)
          // to the real task id returned in the result payload `{ task: { id } }`.
          // On error, remove the pending entry so a stale placeholder isn't shown.
          setLatestTodos((prev) => {
            const pendingIdx = prev.findIndex((t) => t.id === result.tool_use_id);
            if (pendingIdx === -1) return prev;
            if (result.isError) return prev.filter((_, i) => i !== pendingIdx);
            try {
              const payload = JSON.parse(result.text) as { task?: { id?: string } };
              const realId = payload?.task?.id;
              if (!realId) return prev;
              const copy = prev.slice();
              copy[pendingIdx] = { ...copy[pendingIdx], id: realId };
              return copy;
            } catch {
              // Parsing failed; leave the temp-id entry rather than losing it.
              return prev;
            }
          });
          // TaskList result — rebuild the rail from the SDK's authoritative
          // task list. Self-heal after the rail desyncs (the auto-clear at
          // stop-reason "completed", the staleness auto-clear, or the user
          // hitting the Clear button can null `latestTodos` while the SDK
          // task store still has live items — then every subsequent
          // TaskUpdate is silently dropped by the gated branch above and
          // the rail stays at 0 forever). Any TaskList call refreshes the
          // view from the source of truth. Uses the already-resolved
          // `taskToolBlock` (looked up above for the Task/Workflow rail
          // reconciliation) rather than a second findToolUseBlock pass.
          if (taskToolBlock?.name === "TaskList" && !result.isError) {
            const parsed = parseTaskListResult(result.text);
            if (parsed !== null) setLatestTodos(coerceTodos(parsed));
          }
          return;
        }
        // Subagent user-shaped message (typically the spawning prompt). Route to subagent.
        if (parent && inner) {
          const content = inner.content;
          let text = "";
          if (typeof content === "string") text = content;
          else if (Array.isArray(content)) {
            for (const c of content as Array<{ type?: string; text?: string }>) {
              if (c?.type === "text" && c.text) text += c.text;
            }
          }
          if (text) {
            const uuid = (msg as { uuid?: string }).uuid ?? crypto.randomUUID();
            setSubagentMessages((prev) => {
              const list = prev[parent] ?? [];
              if (list.some((m) => m.uuid === uuid)) return prev;
              return {
                ...prev,
                [parent]: [
                  ...list,
                  {
                    uuid,
                    role: "user",
                    blocks: [{ kind: "text", text }],
                    parentToolUseId: parent,
                    ...(typeof ev.at === "number" ? { createdAt: ev.at } : {}),
                  },
                ],
              };
            });
          }
          return;
        }
        // Surface user messages from a resumed transcript so the chat shows history.
        if (!isSynthetic && inner) {
          const content = inner.content;
          // The SDK synthesizes a "This session is being continued from a
          // previous conversation…" user-shaped record after a manual or
          // automatic compaction. It's flagged `isCompactSummary` on the JSONL
          // envelope (the disk-replay / resync paths see it), but the live
          // `query` iterator strips that flag — so we also match on content
          // shape. Rather than silently drop it like the other plumbing
          // filters below, surface a `compact_boundary` divider in its place:
          // on RESUME the SDK does not re-emit the live `system`/
          // `compact_boundary` event, so without this the user gets NO
          // indication the thread was compacted (and the summary itself used
          // to leak in as a user bubble via the session_snapshot path — see
          // the prompt filter in lib/shared/user-prompt.ts). Dedupe against an
          // existing compact_boundary entry sharing this anchor so a LIVE
          // compaction — which emits the system event AND this summary
          // back-to-back with no assistant message between them — shows a
          // single divider regardless of which arrives first.
          if (
            (msg as { isCompactSummary?: boolean }).isCompactSummary === true ||
            isCompactSummaryContent(content)
          ) {
            const uuid = (msg as { uuid?: string }).uuid ?? crypto.randomUUID();
            const anchor = lastAssistantUuidRef.current;
            // The record content IS the full compaction summary — capture it so
            // the divider can expand it on demand (the CLI's ctrl+o view).
            let summaryText = "";
            if (typeof content === "string") summaryText = content;
            else if (Array.isArray(content)) {
              for (const c of content as Array<{ type?: string; text?: string }>) {
                if (c?.type === "text" && c.text) summaryText += c.text;
              }
            }
            summaryText = summaryText.trim();
            setSystemEntries((prev) =>
              mergeCompactBoundary(
                prev,
                uuid,
                anchor,
                summaryText ? { compactSummary: summaryText } : {},
              ),
            );
            return;
          }
          // Drop the remaining transcript-only plumbing the SDK flags on the
          // envelope — the <local-command-caveat> wrapper around slash runs
          // (isMeta) and any isVisibleInTranscriptOnly record. These were
          // authored by the SDK for the model's eyes only and carry no user
          // prose worth surfacing (the isCompactSummary case is handled above,
          // so it becomes a divider rather than being dropped here).
          if (isSdkInternalEnvelope(msg)) return;
          if (isLocalCommandCaveatContent(content)) return;
          // Drop SDK-injected <task-notification> wrappers — they're context
          // for the model, not user-authored prose, and rendering them as a
          // user bubble surfaces XML the user didn't write. The matching
          // system `task_notification` event still updates the TaskBlock UI.
          if (isSyntheticTaskNotification(content)) return;
          // Same idea for SDK-handled slash commands replayed from disk: a
          // prior `/compact` lives on in the JSONL as a user message, and
          // re-rendering it as user prose would re-introduce the echo bug on
          // reload. Render a small system pill instead — symmetric with the
          // live-send path's `slash_invoked` event.
          const slash = isSdkSlashUserMessage(content);
          if (slash) {
            const uuid = (msg as { uuid?: string }).uuid ?? crypto.randomUUID();
            const anchor = lastAssistantUuidRef.current;
            setSystemEntries((prev) => {
              if (prev.some((e) => e.uuid === uuid)) return prev;
              return [
                ...prev,
                {
                  uuid,
                  afterMessageUuid: anchor,
                  kind: "info",
                  label: `Ran ${slash.command}${slash.args ? ` ${slash.args}` : ""}`,
                },
              ];
            });
            return;
          }
          // CLI plumbing wrappers around a slash command run:
          //   <command-name>/X</command-name><command-message>…</command-message><command-args>…</command-args>
          //   <local-command-stdout>…</local-command-stdout>
          //   <local-command-stderr>…</local-command-stderr>
          // The subprocess sends these as user-role messages so the model can
          // see what command ran and what its output was. Render them as
          // assistant-side system pills so the user doesn't see XML in their
          // own bubble.
          const cli = parseSyntheticCliWrapper(content);
          if (cli) {
            // Drop control-plane confirmation chatter. The SDK echoes
            // `<local-command-stdout>Set model to <model>[<effort>]</local-command-stdout>`
            // whenever `setModel` or `applyFlagSettings({ effortLevel })`
            // fires — including when the change came from our own picker
            // (the SessionCard already mirrors the new model + effort, so
            // the pill is pure redundancy). Worse, on effort changes the
            // stdout says "Set model" even though only the effort moved,
            // which reads as a bug to the user. Suppress those specific
            // stdouts here. Other CLI stdout/stderr still surfaces as a
            // pill so legit slash-command output stays visible.
            //
            // Even though we suppress the pill, we must still sync the
            // model state: when the user types `/model X` directly in
            // the chat the picker never fires, so this stdout is the
            // only signal the client gets that the model changed. For
            // picker-driven changes the optimistic update already ran,
            // so calling setModelState again is a harmless no-op.
            if (
              cli.kind === "stdout" &&
              /^set\s+model\s+to\s+/i.test(cli.text)
            ) {
              // "Set model to <model>[<effort label>]" — capture the first
              // whitespace-delimited token then strip any trailing effort
              // suffix like "[medium effort]" or "[high]".
              const m = /^set\s+model\s+to\s+(\S+)/i.exec(cli.text);
              if (m?.[1]) {
                const rawModel = m[1].replace(/\[.*$/, "");
                if (rawModel) setModelState(rawModel);
              }
              return;
            }
            const uuid = (msg as { uuid?: string }).uuid ?? crypto.randomUUID();
            const anchor = lastAssistantUuidRef.current;
            let label: string;
            if (cli.kind === "command") {
              label = `Ran ${cli.command}${cli.args ? ` ${cli.args}` : ""}`;
            } else if (cli.kind === "stdout") {
              label = cli.text ? `CLI: ${cli.text}` : "CLI ran";
            } else {
              // stderr: surface as plain info with a "CLI error:" prefix; we
              // don't promote to a red ShieldAlert pill (that kind is reserved
              // for blocked tool calls — a slash that writes a warning to
              // stderr shouldn't look like a security alert).
              label = cli.text ? `CLI error: ${cli.text}` : "CLI error";
            }
            setSystemEntries((prev) => {
              if (prev.some((e) => e.uuid === uuid)) return prev;
              return [...prev, { uuid, afterMessageUuid: anchor, kind: "info", label }];
            });
            return;
          }
          // Rebuild text + image attachments together (see extractUserContent
          // for why we reconstruct [Image #N] tokens here). The bail is on
          // BOTH text and images so an image-only paste still produces a
          // bubble on replay — the previous text-only gate dropped it.
          const { text, images, reminderBodies } = extractUserContent(content);
          const uuid = (msg as { uuid?: string }).uuid ?? crypto.randomUUID();
          // Cross-turn `<system-reminder>` blocks the server prepended to this
          // user record (every-turn todos nudge, stale-todowrite, etc. — see
          // `lib/server/system-reminders.ts`). The live broadcast deliberately
          // omits them, but a session resumed cold from disk re-broadcasts the
          // JSONL copy with the wrappers intact. Lift each into its own
          // `system_reminder` pill anchored to the previous assistant message
          // so they render *above* the user bubble (mirrors the slash / compact
          // pill anchoring), instead of leaking the wrapper into the user's
          // own bubble.
          //
          // Derived uuid `${msgUuid}-reminder-${i}` keeps the entry stable
          // across watcher-driven `resyncFromDisk` re-fires: the same user
          // record can rebroadcast many times over a long session and we must
          // not multiply the pill on each one.
          if (reminderBodies.length > 0) {
            const anchor = lastAssistantUuidRef.current;
            setSystemEntries((prev) => {
              const next = prev.slice();
              for (let i = 0; i < reminderBodies.length; i++) {
                const entryUuid = `${uuid}-reminder-${i}`;
                if (next.some((e) => e.uuid === entryUuid)) continue;
                next.push({
                  uuid: entryUuid,
                  afterMessageUuid: anchor,
                  kind: "system_reminder",
                  label: "System reminder",
                  reminderBody: reminderBodies[i],
                });
              }
              return next;
            });
          }
          // SDK 0.3.205 — peer-authored turn (e.g. via the `SendMessage`
          // tool). Prefer the origin's decoded `body` (byte-exact with what
          // the model saw) over the re-parsed `text` when present — the
          // envelope-stripped body is authoritative, `text` is just our own
          // reconstruction of the wrapped content.
          const peerOrigin = extractPeerOrigin(msg);
          const displayText = peerOrigin?.body ?? text;
          if (displayText || images.length) {
            setMessages((prev) => {
              // Optimistic dedup: a fresh send seeded the bubble with the
              // composer's actual ordinals + uuids; don't replace it with our
              // replay-renumbered version when the SDK echo lands.
              if (prev.some((m) => m.uuid === uuid)) return prev;
              return [
                ...prev,
                {
                  uuid,
                  role: "user",
                  blocks: displayText ? [{ kind: "text", text: displayText }] : [],
                  ...(images.length ? { images } : {}),
                  ...(typeof ev.at === "number" ? { createdAt: ev.at } : {}),
                  ...(peerOrigin
                    ? { peer: { from: peerOrigin.from, ...(peerOrigin.name ? { name: peerOrigin.name } : {}) } }
                    : {}),
                },
              ];
            });
          }
        }
        return;
      }

      if (msg.type === "result") {
        setPendingTracked(false);
        // The turn is over (success or terminal error) — an in-flight retry
        // indicator would otherwise survive as a stale "still retrying" line
        // on the next render.
        setApiRetry((prev) => (prev ? null : prev));
        // Tear down in-flight UI markers first (rail tools / thinking rows /
        // "Claude streaming…") — the per-block close events may not all have
        // landed. Runs before the cost/usage processing below.
        reconcileToIdle();
        // The active session just transitioned running → idle. Pull a fresh
        // sessions list so the SessionTabs strip can repaint the non-active
        // tabs' status dots — they get no live signal of their own and would
        // otherwise stay stuck at whatever was true when the dropdown was
        // last opened.
        void refreshSessions();
        const anchor = lastAssistantUuidRef.current;
        if (anchor) setMessages((prev) => prev.map((m) => (m.uuid === anchor ? { ...m, streaming: false } : m)));
        const r = msg as {
          uuid?: string;
          subtype?: string;
          duration_ms?: number;
          duration_api_ms?: number;
          num_turns?: number;
          total_cost_usd?: number;
          usage?: {
            input_tokens?: number;
            output_tokens?: number;
            cache_read_input_tokens?: number;
            cache_creation_input_tokens?: number;
          };
          modelUsage?: Record<string, unknown>;
          fast_mode_state?: "off" | "cooldown" | "on";
        };
        if (r.fast_mode_state) {
          setFastModeState(r.fast_mode_state);
          // Edge-detect fast-mode transitions for the transient toast. The
          // first observation just seeds the ref (no toast), so a session
          // that lands in cooldown via the replay buffer doesn't flash a
          // stale notice. Also gated on `!replayingRef` so a turn that
          // entered+exited cooldown during the replay window doesn't pop
          // mid-rehydrate. See FastModeNoticePanel for the scope note.
          const prev = prevFastModeStateRef.current;
          const next = r.fast_mode_state;
          if (prev !== null && prev !== next && !replayingRef.current) {
            if (next === "cooldown" && prev !== "cooldown") {
              setFastModeNotice({ uuid: crypto.randomUUID(), kind: "cooldown" });
            } else if (next === "on" && prev === "cooldown") {
              setFastModeNotice({ uuid: crypto.randomUUID(), kind: "recovered" });
            }
          }
          prevFastModeStateRef.current = next;
        }

        // Idempotency: every SDK result event carries a uuid (see
        // SDKResultSuccess / SDKResultError). If we've already folded this
        // one into session state, the SSE stream is just replaying it — bail
        // out before double-counting cost/turns. No queue-drain call needed
        // here: the server's `flushQueueIfIdle()` already fired on this same
        // `result` and any pending queued message is on its way.
        if (r.uuid && seenResultUuidsRef.current.has(r.uuid)) {
          return;
        }
        if (r.uuid) seenResultUuidsRef.current.add(r.uuid);

        // Surface the spend-cap stop as a clear banner. When Options.maxBudgetUsd
        // is exceeded the SDK ends the turn with this result subtype instead of
        // continuing; without a message the turn would just stop silently.
        if (r.subtype === "error_max_budget_usd") {
          const spent = typeof r.total_cost_usd === "number" ? ` ($${r.total_cost_usd.toFixed(2)} spent)` : "";
          setErrors((e) => [
            ...e,
            `Session stopped: max budget reached${spent}. Raise the cap in workspace settings to continue.`,
          ]);
        }

        // A tracked /compact that never produced a `compact_boundary` failed
        // (or was a no-op) rather than succeeding. An error subtype means it
        // genuinely failed; surface that explicitly instead of letting the
        // "Compacting…" indicator quietly revert with no explanation (CC
        // 2.1.216 parity). Skip `error_max_budget_usd` — that's already
        // surfaced by its own clearer banner above; a second "Compaction
        // failed: error_max_budget_usd" would just be visual noise for the
        // same underlying stop.
        if (pendingCompactRef.current) {
          pendingCompactRef.current = false;
          if (r.subtype && r.subtype !== "success" && r.subtype !== "error_max_budget_usd") {
            const resultErrors = (msg as { errors?: string[] }).errors;
            const detail = resultErrors && resultErrors.length ? resultErrors[0] : r.subtype;
            setErrors((e) => [...e, `Compaction failed: ${detail}`]);
          }
        }

        // Capture the mid-turn estimate to a local BEFORE the setter so the
        // reducer closes over the value we measured here, not whatever the
        // ref happens to hold by the time React commits. The ref is reset
        // synchronously below so the next turn starts at 0 even if the
        // setter runs later.
        const estimate = estimatedTurnCostRef.current;
        estimatedTurnCostRef.current = 0;

        // Cost reconciliation runs on EVERY result event — including
        // non-success subtypes (`error_max_turns`, `error_during_execution`,
        // cancellations). Errors still cost tokens, and gating on
        // `subtype === "success"` was the second half of the "$0.00 forever"
        // bug. If the SDK supplies an auth value we use it; otherwise we
        // keep the estimate as the best signal we have.
        const authCost = typeof r.total_cost_usd === "number" ? r.total_cost_usd : null;
        setUsage((prev) => ({
          totalCostUsd:
            (prev?.totalCostUsd ?? 0) - estimate + (authCost ?? estimate),
          numTurns: (prev?.numTurns ?? 0) + (r.num_turns ?? 0),
          durationMs: (prev?.durationMs ?? 0) + (r.duration_ms ?? 0),
          durationApiMs: (prev?.durationApiMs ?? 0) + (r.duration_api_ms ?? 0),
          inputTokens: prev?.inputTokens ?? 0,
          outputTokens: prev?.outputTokens ?? 0,
          cacheReadInputTokens: prev?.cacheReadInputTokens ?? 0,
          cacheCreationInputTokens: prev?.cacheCreationInputTokens ?? 0,
          modelUsage: r.modelUsage ?? prev?.modelUsage,
        }));
        // Queue drain is server-driven now (see
        // `Session.flushQueueIfIdle()` in lib/server/session.ts); no client
        // trigger needed on result-event handling.
        return;
      }

      if (msg.type === "tool_progress") {
        const info = toolProgressInfoFromSdkMessage(
          msg as {
            tool_use_id: string;
            tool_name: string;
            elapsed_time_seconds: number;
            parent_tool_use_id: string | null;
            subagent_type?: string;
            subagent_retry?: {
              agent_id: string;
              attempt: number;
              max_retries: number;
              retry_delay_ms: number;
              error_status: number | null;
              error_category: string;
            };
          },
        );
        setToolProgress((prev) => ({ ...prev, [info.toolUseId]: info }));
        return;
      }

      if (msg.type === "system") {
        const sysAny = msg as { subtype?: string; uuid: string; [k: string]: unknown };
        const anchor = lastAssistantUuidRef.current;
        const baseEntry: Omit<SystemEntry, "kind" | "label"> = {
          uuid: sysAny.uuid,
          afterMessageUuid: anchor,
        };
        if (sysAny.subtype === "init") {
          // Normalize via the shared parser so the SDK→state mapping (incl.
          // the subagent `agents` list) is defensively typed and unit-tested
          // in one place rather than inline here. See lib/shared/parse-init.ts.
          const init = parseInitSystemMessage(sysAny);
          // A CLI (re)start resets the SDK's background-task set to empty and
          // emits nothing until the next membership change. Drop our snapshot
          // back to `null` (gate inactive) rather than empty, so any genuinely
          // live task on a resumed session isn't hidden before the first fresh
          // `background_tasks_changed` arrives.
          setLiveBackgroundTaskIds(null);
          if (init.slashCommands.length) setSlashCommands(init.slashCommands);
          if (init.agents.length) setAgents(init.agents);
          if (init.skills.length) setSkills(init.skills);
          if (init.cwd) setCwd(init.cwd);
          if (init.model) setModelState(init.model);
          if (init.permissionMode) setPermissionModeState(init.permissionMode);
          // Belt-and-braces advisor priming: the bind-time `GET /advisor`
          // is the *authoritative* source (returns the literal value the
          // SDK is honoring), but it can come back null on edge cases
          // (stale dev-server build that doesn't have the route, a
          // settings.json read failure, profile-dir divergence with
          // CLAUDE_CONFIG_DIR). The init message's `tools` array carries
          // a strong "advisor is on" signal — the SDK only registers the
          // `advisor` tool when one is configured. We *don't* know the
          // exact model id from init, so seed with `"(active)"` only if
          // our mirror is still null AND the SDK confirms the tool is
          // registered — the badge renders, just with a less specific
          // label, until the GET resolves and overwrites this with the
          // real id. Never *clears* the mirror on `advisorActive: false`;
          // POST-driven optimistic updates set the real value too, and
          // they should win.
          if (init.advisorActive) {
            setAdvisorModelState((prev) => prev ?? ADVISOR_ACTIVE_SENTINEL);
          }
          setSystemEntries((prev) =>
            appendCoalescedSystemEntry(prev, {
              ...baseEntry,
              kind: "init",
              label: `Session ready · ${init.model ?? ""}`,
              detail: `${init.tools.length} tools · ${init.slashCommands.length} commands · ${init.agents.length} agents`,
            }),
          );
          return;
        }
        if (sysAny.subtype === "hook_started") {
          const h = sysAny as { hook_name?: string; hook_event?: string };
          setSystemEntries((prev) => [
            ...prev,
            { ...baseEntry, kind: "hook_started", label: `Hook ${h.hook_name ?? h.hook_event ?? ""}` },
          ]);
          return;
        }
        if (sysAny.subtype === "hook_response") {
          // CC 2.1.199: SessionStart/Setup/SubagentStart hooks that exit 2
          // (a blocking failure) previously had their stderr silently
          // swallowed — the SDK's `hook_response` message has always carried
          // a `stderr` field, but until now it went unread here. Surface it
          // whenever the hook didn't succeed so the failure reason is
          // visible instead of just a bare "→ error" pill.
          const h = sysAny as {
            hook_name?: string;
            exit_code?: number;
            outcome?: string;
            stderr?: string;
          };
          const failed = h.outcome === "error" || h.outcome === "cancelled";
          const stderr = failed && h.stderr?.trim() ? h.stderr.trim() : undefined;
          setSystemEntries((prev) => [
            ...prev,
            {
              ...baseEntry,
              kind: "hook_response",
              label: `Hook ${h.hook_name ?? ""} → ${h.outcome ?? "ok"}`,
              detail: typeof h.exit_code === "number" ? `exit ${h.exit_code}` : undefined,
              hookFailed: failed,
              hookStderr: stderr,
            },
          ]);
          return;
        }
        if (sysAny.subtype === "status") {
          const s = sysAny as { status?: string };
          setSystemEntries((prev) =>
            appendCoalescedSystemEntry(prev, {
              ...baseEntry,
              kind: "status",
              label: `Status: ${s.status ?? ""}`,
            }),
          );
          return;
        }
        if (sysAny.subtype === "compact_boundary") {
          // Merge onto a single divider (deduped by anchor): a live compaction
          // emits this system event AND the synthesized continuation summary
          // (handled in the `user` branch above). This event carries the token
          // deltas / duration; the summary record carries the text. Whichever
          // lands first creates the divider and the other enriches it.
          const stats = normalizeCompactStats(
            (sysAny as { compact_metadata?: unknown; compactMetadata?: unknown }).compact_metadata ??
              (sysAny as { compactMetadata?: unknown }).compactMetadata,
          );
          pendingCompactRef.current = false;
          setSystemEntries((prev) =>
            mergeCompactBoundary(
              prev,
              baseEntry.uuid,
              baseEntry.afterMessageUuid,
              stats ? { compactStats: stats } : {},
            ),
          );
          return;
        }
        if (sysAny.subtype === "slash_invoked") {
          // Server-side breadcrumb for an SDK-handled slash command. We
          // render it as a small "Running /compact…" pill so the chat
          // doesn't go silent while the SDK works — the eventual outcome
          // (compact_boundary, init reload, etc.) lands as its own pill.
          const s = sysAny as { command?: string; args?: string };
          const cmd = (s.command ?? "").trim() || "/?";
          const args = (s.args ?? "").trim();
          if (cmd === "/compact" && !seenCompactSlashUuidsRef.current.has(sysAny.uuid)) {
            seenCompactSlashUuidsRef.current.add(sysAny.uuid);
            // Only track it if no other turn was already running — see
            // `pendingCompactRef`'s doc comment for why a mid-turn-queued
            // compact is intentionally left untracked rather than risking a
            // misattributed banner.
            if (!pendingRef.current) pendingCompactRef.current = true;
          }
          setSystemEntries((prev) => [
            ...prev,
            {
              ...baseEntry,
              kind: "info",
              label: `Running ${cmd}${args ? ` ${args}` : ""}…`,
            },
          ]);
          return;
        }
        if (sysAny.subtype === "task_started") {
          const t = sysAny as unknown as {
            task_id: string;
            tool_use_id?: string;
            description?: string;
            task_type?: string;
            workflow_name?: string;
          };
          // SSE ordering can deliver the Task's tool_result before this
          // task_started; seed the terminal status in that case so the pill
          // doesn't get stuck "running" after the tool_result reconciler has
          // already run and found no matching task.
          const startedBlock = t.tool_use_id
            ? findToolUseBlock(t.tool_use_id, messagesRef.current)
            : null;
          setTasks((prev) => {
            // A provisional row (seeded off a background launch ack) is keyed by
            // its tool_use_id; the real task arrives under a distinct task_id.
            // Drop the placeholder and carry its wall-clock start forward so the
            // ticking elapsed timer doesn't reset to 0 on the handoff.
            const { tasks: cleared, carriedStartedAt } = dropProvisionalForToolUse(
              prev,
              t.tool_use_id,
            );
            return {
              ...cleared,
              [t.task_id]: {
                taskId: t.task_id,
                toolUseId: t.tool_use_id,
                description: t.description ?? "(no description)",
                taskType: t.task_type,
                workflowName: t.workflow_name,
                status: seedTaskStatus(startedBlock),
                startedAt: carriedStartedAt ?? Date.now(),
              },
            };
          });
          return;
        }
        if (sysAny.subtype === "task_updated") {
          const t = sysAny as unknown as {
            task_id: string;
            patch: { status?: TaskStatus; description?: string; error?: string; is_backgrounded?: boolean };
          };
          setTasks((prev) => {
            const existing = prev[t.task_id];
            if (!existing) return prev;
            return {
              ...prev,
              [t.task_id]: {
                ...existing,
                status: t.patch.status ?? existing.status,
                description: t.patch.description ?? existing.description,
                error: t.patch.error ?? existing.error,
                isBackgrounded: t.patch.is_backgrounded ?? existing.isBackgrounded,
              },
            };
          });
          return;
        }
        if (sysAny.subtype === "task_progress") {
          const t = sysAny as unknown as {
            task_id: string;
            description?: string;
            usage?: { total_tokens?: number; tool_uses?: number; duration_ms?: number };
            last_tool_name?: string;
            summary?: string;
          };
          setTasks((prev) => {
            const existing = prev[t.task_id];
            if (!existing) return prev;
            return {
              ...prev,
              [t.task_id]: {
                ...existing,
                description: t.description ?? existing.description,
                totalTokens: t.usage?.total_tokens ?? existing.totalTokens,
                toolUses: t.usage?.tool_uses ?? existing.toolUses,
                durationMs: t.usage?.duration_ms ?? existing.durationMs,
                lastToolName: t.last_tool_name ?? existing.lastToolName,
                summary: t.summary ?? existing.summary,
              },
            };
          });
          return;
        }
        if (sysAny.subtype === "task_notification") {
          const t = sysAny as unknown as {
            task_id: string;
            tool_use_id?: string;
            status: "completed" | "failed" | "stopped";
            summary?: string;
            usage?: { total_tokens?: number; tool_uses?: number; duration_ms?: number };
          };
          setTasks((prev) => {
            // Authoritative cleanup: a notification can arrive WITHOUT a prior
            // task_started (the task-status module exists precisely because
            // these events aren't reliably ordered/delivered). Drop the
            // provisional placeholder keyed by tool_use_id so it can't strand a
            // phantom "running" row forever, then settle the real task.
            const { tasks: cleared } = dropProvisionalForToolUse(prev, t.tool_use_id);
            const existing = cleared[t.task_id];
            const base: TaskInfo = existing ?? {
              taskId: t.task_id,
              toolUseId: t.tool_use_id,
              description: t.summary ?? "(unknown)",
              status: "completed",
            };
            return {
              ...cleared,
              [t.task_id]: {
                ...base,
                status: t.status,
                summary: t.summary ?? base.summary,
                totalTokens: t.usage?.total_tokens ?? base.totalTokens,
                toolUses: t.usage?.tool_uses ?? base.toolUses,
                durationMs: t.usage?.duration_ms ?? base.durationMs,
              },
            };
          });
          return;
        }
        if (sysAny.subtype === "background_tasks_changed") {
          // SDKBackgroundTasksChangedMessage (0.3.203): the authoritative set of
          // every live background task after a membership change. REPLACE
          // semantics — swap our whole liveness set for this payload. Ids only,
          // so this drives the independent `liveBackgroundTaskIds` gate, NOT the
          // `tasks` map. An empty `tasks` array is meaningful ("nothing live")
          // — it settles anything the rail still shows as running.
          const payload = sysAny as unknown as { tasks?: { task_id?: string }[] };
          const ids = new Set(
            (payload.tasks ?? [])
              .map((t) => t.task_id)
              .filter((id): id is string => typeof id === "string" && id.length > 0),
          );
          setLiveBackgroundTaskIds(ids);
          return;
        }
        // SDKThinkingTokensMessage (0.3.153): live token-count estimate emitted
        // during the redacted-thinking phase. Not a persistent chat entry —
        // attach the estimate to the most-recent open thinking row in the
        // Activity rail so users see a live token counter in the spinner.
        // `SDKThinkingTokensMessage` carries no `message_id`, so we target the
        // latest open thinking entry by heuristic (in practice at most one
        // thinking block is in flight at a time).
        if (sysAny.subtype === "thinking_tokens") {
          const tt = sysAny as unknown as { estimated_tokens: number };
          if (typeof tt.estimated_tokens === "number") {
            setToolHistory((prev) => applyThinkingTokensEstimate(prev, tt.estimated_tokens));
          }
          return;
        }
        // Automatic model-fallback announcement (Options.fallbackModel kicked in).
        // The SDK emits one of these for all fallback triggers: `overloaded`,
        // `model_not_found`, `permission_denied`, `server_error`, and
        // `last_resort` (the latter two added in SDK 0.3.174). The spawned
        // `claude` binary builds the human-readable `content` string the CLI
        // prints ("Switched to <new> because <old> is not available…"). Reuse
        // `content` verbatim so the wording tracks the SDK across all triggers.
        if (sysAny.subtype === "model_fallback") {
          const f = sysAny as unknown as {
            trigger?: "overloaded" | "model_not_found" | "permission_denied" | "server_error" | "last_resort";
            original_model?: string;
            fallback_model?: string;
            content?: string;
          };
          const label =
            (typeof f.content === "string" && f.content.trim()) ||
            (f.fallback_model && f.original_model
              ? `Switched to ${f.fallback_model} because ${f.original_model} is not available`
              : "Switched models");
          setSystemEntries((prev) => [
            ...prev,
            {
              ...baseEntry,
              kind: "model_fallback",
              label,
              detail: f.trigger,
            },
          ]);
          return;
        }
        // SDKAPIRetryMessage — emitted when an API request fails with a
        // retryable error (connection drop, 5xx, rate limit, 529 overload)
        // and the SDK is about to retry with backoff. CLI 2.1.198 ("Improved
        // API retry UX") surfaces this in the spinner rather than the
        // transcript; we mirror that with `session.apiRetry`, consumed by
        // `WorkingRow`/`SpinnerTip` (see `describeApiRetry` in
        // `lib/client/api-retry.ts`) — not as a SystemEntry pill, so a
        // resolved turn doesn't leave a stale "still retrying" marker behind
        // in the transcript. Cleared below on the next assistant/result
        // message.
        if (sysAny.subtype === "api_retry") {
          const rt = sysAny as {
            attempt?: number;
            max_retries?: number;
            retry_delay_ms?: number;
            error_status?: number | null;
            error?: string;
          };
          setApiRetry({
            attempt: typeof rt.attempt === "number" ? rt.attempt : 1,
            maxRetries: typeof rt.max_retries === "number" ? rt.max_retries : 0,
            retryDelayMs: typeof rt.retry_delay_ms === "number" ? rt.retry_delay_ms : 0,
            errorStatus: rt.error_status ?? null,
            error: rt.error ?? "unknown",
          });
          return;
        }
        // SDKPermissionDeniedMessage (0.3.178): emitted when a tool call is
        // auto-denied without an interactive permission prompt (auto-mode
        // classifier, dontAsk, headless-agent auto-deny, or a deny rule). The
        // `decision_reason_type` discriminator now reliably carries values like
        // `safetyCheck` and `asyncAgent` so hosts can programmatically match
        // denial causes. The `permission_denied` kind was already defined in
        // SystemEntry and registered in SystemPill.tsx (ShieldAlert, red tone)
        // — this handler wires it up for the first time.
        if (sysAny.subtype === "permission_denied") {
          const p = sysAny as {
            tool_name?: string;
            decision_reason_type?: string;
            decision_reason?: string;
          };
          setSystemEntries((prev) => [
            ...prev,
            {
              ...baseEntry,
              kind: "permission_denied",
              label: `Permission denied: ${p.tool_name ?? "(unknown tool)"}`,
              detail: p.decision_reason_type ?? p.decision_reason,
            },
          ]);
          return;
        }
        // SDKInformationalMessage (0.3.178 fix): generic text banner — non-error
        // status lines, hook feedback (e.g. a UserPromptSubmit hook's block
        // reason), slash-command output. Previously this subtype fell through to
        // the catch-all `system/informational` pill, losing the `content` text.
        // Now renders `content` as the pill label so hook block reasons and other
        // informational messages are visible to users.
        if (sysAny.subtype === "informational") {
          const inf = sysAny as { content?: string; level?: string; prevent_continuation?: boolean };
          const content = typeof inf.content === "string" ? inf.content.trim() : "";
          if (content) {
            setSystemEntries((prev) => [
              ...prev,
              {
                ...baseEntry,
                kind: "info",
                label: content,
                detail: inf.prevent_continuation ? "blocked" : undefined,
              },
            ]);
          }
          return;
        }
        // SDKWorkerShuttingDownMessage (0.3.178): emitted by Remote Control
        // workers on graceful exit so remote clients can show why the session
        // ended instead of waiting for heartbeat timeout. Carries a short
        // snake_case `reason` set by the host CLI (e.g. 'host_exit',
        // 'remote_control_disabled'). Previously fell through to the generic
        // `system/worker_shutting_down` catch-all pill; now renders the reason.
        if (sysAny.subtype === "worker_shutting_down") {
          const w = sysAny as { reason?: string };
          setSystemEntries((prev) => [
            ...prev,
            {
              ...baseEntry,
              kind: "info",
              label: `Session ended: ${w.reason ?? "worker shutting down"}`,
            },
          ]);
          return;
        }
        // SDKCommandsChangedMessage (0.3.195 fix): fire-and-forget push of
        // the full slash-command list after a mid-session change (e.g. skills
        // discovered dynamically as the agent works in a subdirectory). The
        // SDK docs say supportedCommands() is captured once at initialize and
        // never reflects mid-session changes — so replace the cached list
        // outright with the pushed one rather than re-fetching via the API.
        // Note: this is a live-session-only fix; on tab-switch/reload the
        // list rehydrates from the stale system:init snapshot (see run-notes
        // 0.3.195 Risks/follow-ups for the full-fix approach).
        if (sysAny.subtype === "commands_changed") {
          const cc = sysAny as { commands?: Array<{ name: string }> };
          const names = (cc.commands ?? []).map((c: { name: string }) => c.name);
          if (names.length > 0) setSlashCommands(names);
          return;
        }
        // Drop SDK system plumbing that carries no user-facing value instead
        // of rendering it as a cryptic `system/<subtype ?? "?">` pill. The
        // Ralph-loop Stop hook fires a `stop_hook_summary` per iteration whose
        // subtype is stripped to `undefined` before it reaches us — without
        // this guard, a long loop floods the chat with `system/?` rows that
        // aren't even durable across a reload. See isSuppressedSystemEvent.
        if (isSuppressedSystemEvent(sysAny.subtype)) return;
        setSystemEntries((prev) => [
          ...prev,
          { ...baseEntry, kind: "info", label: `system/${sysAny.subtype ?? "?"}` },
        ]);
        return;
      }

      if (msg.type === "rate_limit_event") {
        // Mirror SDKRateLimitInfo (see node_modules/@anthropic-ai/claude-agent-sdk/sdk.d.ts).
        // We carry the full payload through so the pill can render a live
        // countdown + overage status; the legacy `label` is kept as a
        // text fallback for kinds that don't have a custom renderer.
        const r = msg as {
          rate_limit_info?: {
            status?: "allowed" | "allowed_warning" | "rejected";
            rateLimitType?: "five_hour" | "seven_day" | "seven_day_opus" | "seven_day_sonnet" | "seven_day_overage_included" | "overage";
            resetsAt?: number;
            utilization?: number;
            overageStatus?: "allowed" | "allowed_warning" | "rejected";
            overageResetsAt?: number;
            overageDisabledReason?: string;
            isUsingOverage?: boolean;
            surpassedThreshold?: number;
            // SDK 0.3.181 — credits-required rate-limit signal.
            errorCode?: "credits_required";
            canUserPurchaseCredits?: boolean;
            hasChargeableSavedPaymentMethod?: boolean;
          };
          uuid: string;
        };
        const info = r.rate_limit_info;
        // Remember the latest structured payload so a subsequent *hard* limit
        // hit (which arrives as an assistant `error: "rate_limit"` message with
        // no structured fields) can reuse this window's resetsAt / tier for the
        // inline panel's countdown.
        if (info) lastRateLimitInfoRef.current = info;
        const anchor = lastAssistantUuidRef.current;
        const incoming: SystemEntry = {
          uuid: r.uuid,
          afterMessageUuid: anchor,
          kind: "rate_limit",
          label: `Rate limit: ${info?.status ?? "?"} (${info?.rateLimitType ?? ""})`,
          rateLimit: info,
        };
        // De-dupe: a single session can emit many `rate_limit_event`s as
        // utilization climbs (allowed → allowed_warning → rejected). Stacking
        // them spams the transcript and obscures the *current* state, which
        // is what the user actually needs to see. Collapse to one entry per
        // `rateLimitType`, keeping the latest payload but reusing the
        // original anchor so it doesn't jump around the thread.
        const dedupeKey = info?.rateLimitType ?? "__no_type__";
        setSystemEntries((prev) => {
          const idx = prev.findIndex(
            (e) => e.kind === "rate_limit" && (e.rateLimit?.rateLimitType ?? "__no_type__") === dedupeKey,
          );
          if (idx === -1) return [...prev, incoming];
          const next = prev.slice();
          next[idx] = {
            ...incoming,
            // Preserve the original anchor so the pill stays put even
            // after several updates within the same turn.
            afterMessageUuid: prev[idx].afterMessageUuid,
            uuid: prev[idx].uuid,
          };
          return next;
        });
        return;
      }

      if (msg.type === "prompt_suggestion") {
        const s = (msg as { suggestion?: string }).suggestion;
        if (typeof s === "string" && s.trim()) {
          setPromptSuggestions((prev) => (prev.includes(s) ? prev : [...prev, s].slice(-4)));
        }
        return;
      }
    },
    [refreshSessions, setPendingTracked, reconcileToIdle, writeQueueLocal],
  );

  const bindToSession = useCallback(
    (id: string) => {
      eventSourceRef.current?.close();
      sessionIdRef.current = id;
      setSessionId(id);
      // Queue paint comes from the server's `queue:updated` SSE echo on
      // subscribe — see `Session.sendQueueSnapshot()` re-emitted in
      // `Session.subscribe()`. Local state stays empty until that echo
      // lands; no rehydration step.
      //
      // One-shot migration from the previous (sessionStorage) queue: drain
      // any leftover entries for this session id back through the normal
      // `/input` endpoint with `forceQueue: true`, then delete the key.
      // Best-effort — a malformed JSON or a network blip silently drops
      // the stash; the user will have already moved on.
      void migrateLegacySessionStorageQueue(id);
      // Rehydrated items stay visible in the QueueIndicator; the server's
      // `flushQueueIfIdle` drains them at the next idle transition.
      // URL reflection of the bound session id used to live here (a raw
      // window.history.replaceState). It moved out to a useEffect-driven
      // writer (see the `reflect bound session in URL` effect below)
      // because doing the replaceState synchronously inside bindToSession
      // races with any in-flight Next.js Link navigation: the boot's
      // createSession resolves while the user's Link click is mid-RSC-
      // fetch, our replaceState commits `/?session=X` before Next.js
      // pushState commits to the target path, and the new path never
      // wins. Regression that broke the customizations-drawer "Manage
      // all navigates to /customize" e2e once the verbose hook slowed
      // boot enough to widen the race. The effect-based writer reads
      // the committed pathname (via usePathname) which Next.js mutates
      // BEFORE re-rendering — so a navigation away from `/` naturally
      // suppresses the URL write.
      if (typeof window !== "undefined") {
        // Next.js's `useSearchParams` doesn't observe `replaceState`, so the
        // workspace-level NotificationsProvider would stall on the previous
        // session id after an in-app tab switch (and notify on / auto-read
        // the wrong tab). Dispatch a custom event so `useActiveSessionId`
        // can pick up the new binding without waiting for the next router
        // navigation.
        try {
          window.dispatchEvent(
            new CustomEvent("claudius:session-bound", { detail: { sessionId: id } }),
          );
        } catch {
          // ignore — non-fatal
        }
      }
      // Prime the advisor mirror from the server. The SDK's `system:init`
      // message doesn't carry `advisorModel`, so the SessionCard would
      // otherwise render "No advisor" even when settings.json sets one
      // (i.e. the recommended Sonnet-main / Opus-advisor setup). Reads
      // the effective value the server stashed at start; the guard against
      // a late response after the user moved on uses the bound-id check.
      void fetch(`/api/sessions/${id}/advisor`, { method: "GET" })
        .then(async (r) => {
          if (!r.ok) return;
          if (sessionIdRef.current !== id) return;
          const body = (await r.json().catch(() => null)) as
            | { model?: string | null }
            | null;
          if (!body) return;
          setAdvisorModelState(
            typeof body.model === "string" && body.model.length > 0
              ? body.model
              : null,
          );
        })
        .catch(() => {
          // Non-fatal — picker just opens with "No advisor" pre-selected;
          // user can still pick something and it'll persist normally.
        });
      // Capture the bound id in the closure so SSE callbacks can early-out
      // when this tab has moved on. Two race shapes this defends against:
      //   1. `close()` is supposed to stop event delivery synchronously, but
      //      already-queued onmessage tasks can still fire one more time on
      //      some browsers — without a guard those bleed events from the
      //      outgoing session into the freshly-cleared state of the next one
      //      (user reported "messages from other sessions appear").
      //   2. Rapid switches (notification jump fires while a tab click is
      //      still mid-await on the wake POST) can stack two bindToSession
      //      invocations whose closures both hold live EventSources for a
      //      few ms; the guard makes sure only the latest closure wins.
      // `sessionIdRef.current` is the single source of truth for the active
      // binding — bindToSession sets it synchronously above.
      const boundId = id;
      const es = new EventSource(`/api/sessions/${id}/stream?tail=20&tabId=${myTabId}`);
      eventSourceRef.current = es;
      es.onopen = () => {
        if (replayDebugEnabled()) {

          console.log(
            `[replay-debug] === EventSource open/reconnect for ${id} (replay window follows) ===`,
          );
        }
      };
      es.onmessage = (msg) => {
        if (sessionIdRef.current !== boundId) return;
        try {
          const ev = JSON.parse(msg.data) as ServerEvent;
          applyEvent(ev);
        } catch (err) {
          console.error("bad SSE payload", err, msg.data);
        }
      };
      es.onerror = () => {
        if (sessionIdRef.current !== boundId) return;
        // EventSource fires `error` for both transient drops (it will retry
        // automatically) and permanent failures. Distinguish by readyState:
        //   CONNECTING (0) → reconnect in flight, do nothing — when it lands
        //                    the server replays buffered events and the
        //                    `replay_done` handler re-asserts pending state.
        //   CLOSED (2)     → browser has given up (server returned non-2xx,
        //                    or repeated retries failed). No more events
        //                    will arrive on this socket, so a `pending`
        //                    flag set to true earlier is now stuck — clear
        //                    it so the StatusLine stops claiming "Working"
        //                    against a dead stream.
        if (es.readyState === EventSource.CLOSED) {
          setPendingTracked(false);
        }
      };
    },
    [applyEvent, setPendingTracked, myTabId],
  );

  const switchSession = useCallback(
    async (id: string): Promise<void> => {
      if (sessionIdRef.current === id) return;
      // Bump the generation counter FIRST. Any concurrent switchSession
      // / createSession call that's awaiting its wake POST will see the
      // bumped value and bail out before its bindToSession runs — that
      // prevents two transitions from interleaving and bleeding state
      // from one into the other.
      const gen = ++switchGenRef.current;

      // Hard-cut the outgoing session.
      //  - Close the EventSource synchronously per the WHATWG spec, so
      //    the browser stops dispatching its events immediately.
      //  - Null sessionIdRef BEFORE the await: every read site (send,
      //    resolvePermission, …) checks `if (!id) return`,
      //    so any user activity during the ~30–100 ms wake POST window
      //    fail-softs instead of POSTing to the OUTGOING session and
      //    leaving an optimistic bubble that then renders against the
      //    INCOMING session's freshly-replayed state. (The user kept
      //    reporting "my messages went somewhere else / disappeared";
      //    this synchronous in-band leak via setMessages was the path
      //    that survived the earlier SSE-close fix.)
      //  - resetState clears the transcript so the user sees an empty
      //    pane while the new session loads, not a half-stale view.
      eventSourceRef.current?.close();
      eventSourceRef.current = null;
      sessionIdRef.current = null;
      setSessionId(null);
      resetState();
      // AWAIT the wake POST before opening the SSE — this mirrors the
      // boot path exactly (`createSession` does `await fetch(...)` then
      // `bindToSession`). Earlier we used `void fetch(...)` for a tighter
      // perceived latency, but the POST and SSE then raced and the SSE
      // sometimes subscribed to a Session whose `start()` had only
      // half-populated the buffer — the symptom the user reported as
      // "old session is empty until I refresh."
      //
      // POST is idempotent on the server: `sessionManager.create` with a
      // `resume` opt returns the in-memory Session if one exists, and
      // otherwise loads from the JSONL — in BOTH cases awaiting `start()`
      // so by the time POST resolves, the buffer is fully populated and
      // the SSE subscribe immediately replays the whole transcript.
      //
      // Cost: one extra round-trip (~30-100ms typical on localhost). The
      // user sees the same brief "Starting" state they'd see during boot
      // refresh — strictly an improvement over the broken empty-until-
      // reload behaviour.
      try {
        const res = await fetch("/api/sessions", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ resume: id }),
        });
        if (process.env.NEXT_PUBLIC_CLAUDIUS_DEBUG_SESSIONS) {
           
          console.log("[sess-load] switchSession wake POST", {
            id,
            status: res.status,
            ok: res.ok,
          });
        }
        // Body intentionally not parsed — we already have the id, and the
        // server's reply just confirms which one it bound (idempotent).
      } catch (err) {
        if (process.env.NEXT_PUBLIC_CLAUDIUS_DEBUG_SESSIONS) {
           
          console.warn("[sess-load] switchSession wake POST failed", {
            id,
            err: err instanceof Error ? err.message : String(err),
          });
        }
        // Non-fatal: the stream route still does its own getOrResumeSession
        // fallback, so we proceed to bindToSession either way.
      }
      // A newer transition started while we were awaiting? Give up.
      // The newer call has already bumped the generation, closed any ES,
      // and will run its own bindToSession when its await resolves.
      // Continuing here would clobber it.
      if (switchGenRef.current !== gen) return;
      bindToSession(id);
      void refreshSessions();
    },
    [bindToSession, resetState, refreshSessions],
  );

  const createSession = useCallback(
    async (opts: CreateSessionRequest = {}): Promise<string | null> => {
      // Mirror switchSession's discipline. Bump the generation counter so
      // any in-flight switch bails when it next checks. Cut the outgoing
      // session (ES + sessionIdRef) at the top so user activity during
      // the create POST can't leak into the outgoing session. resetState
      // wipes the transcript so the user sees an empty pane while the
      // new session is being born.
      const gen = ++switchGenRef.current;
      eventSourceRef.current?.close();
      eventSourceRef.current = null;
      sessionIdRef.current = null;
      setSessionId(null);
      resetState();
      try {
        const res = await fetch("/api/sessions", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify(opts),
        });
        if (!res.ok) {
          // Read the route's JSON `{ error, name }` (see app/api/sessions/route.ts).
          // Falling back to a bare status code makes the failure unreadable
          // when the toast is the only visible signal — packaged Electron
          // sinks server stderr to /dev/null on Finder launches.
          let detail = `${res.status}`;
          try {
            const body = (await res.json()) as { error?: string; name?: string };
            if (body?.error) detail = body.name ? `${body.name}: ${body.error}` : body.error;
          } catch {
            // Body wasn't JSON — keep the status code.
          }
          throw new Error(`create session failed: ${detail}`);
        }
        const { id, cwd: createdCwd } = (await res.json()) as { id: string; cwd?: string };
        // A newer transition superseded this one — don't bind.
        if (switchGenRef.current !== gen) return null;
        bindToSession(id);
        // Apply the server's authoritative cwd immediately. Without this,
        // `cwd` stays null until the SDK's `init` system message arrives via
        // SSE — but for a brand-new session the SDK doesn't spawn until the
        // first prompt, so init never fires beforehand. That left the page-
        // level auto-add-tab logic (which gates on `cwd === workspaceRoot`)
        // stalled until the user typed something, so the new tab only popped
        // into the strip after the first prompt. The init handler will
        // setCwd again later with the same value — no-op.
        if (typeof createdCwd === "string" && createdCwd.length > 0) {
          setCwd(createdCwd);
        }
        await refreshSessions();
        return id;
      } catch (err) {
        setErrors((e) => [...e, err instanceof Error ? err.message : String(err)]);
        return null;
      }
    },
    [bindToSession, refreshSessions, resetState],
  );

  const createNewSession = useCallback(async () => {
    const cwd = defaultCwdRef.current;
    return await createSession(cwd ? { cwd } : {});
  }, [createSession]);

  const createSessionAt = useCallback(
    async (newCwd: string) => {
      await createSession({ cwd: newCwd });
    },
    [createSession],
  );

  /**
   * Open a fresh session and seed its composer with `draftText` without
   * auto-sending. The text is plumbed through the create POST body
   * (`initialDraftText`) so the server writes the prompt-draft row
   * BEFORE the response returns — the renderer's per-session draft GET
   * then reads our text back authoritatively, with no race against
   * `bindToSession`'s render or any in-memory injection.
   *
   * Caller (currently the Electron context-menu handler) doesn't care
   * about the new session id — `bindToSession` inside `createSession`
   * already wires the URL + SSE, so once this resolves the active tab
   * IS the new session.
   */
  const createNewSessionWithDraft = useCallback(
    async (draftText: string) => {
      const text = typeof draftText === "string" ? draftText : "";
      const cwd = defaultCwdRef.current;
      await createSession({
        ...(text ? { initialDraftText: text } : {}),
        ...(cwd ? { cwd } : {}),
      });
    },
    [createSession],
  );

  // Boot on mount; honor URL ?session=, ?at=, and ?prompt= (seed initial input).
  useEffect(() => {
    const params = new URLSearchParams(window.location.search);
    // ?new=1 forces creating a fresh session, even if ?session= is present
    // and even if a last-active tab is persisted. Used by /clear and any
    // explicit "new chat" entry point.
    const forceNew = params.get("new") === "1";
    let resume: string | undefined = forceNew ? undefined : params.get("session") || undefined;
    const at = forceNew ? undefined : params.get("at") || undefined;
    const seed = params.get("prompt") || undefined;
    if (forceNew && typeof window !== "undefined") {
      try {
        const url = new URL(window.location.href);
        url.searchParams.delete("new");
        url.searchParams.delete("session");
        url.searchParams.delete("at");
        window.history.replaceState(null, "", url.toString());
      } catch {
        // ignore
      }
    }
    (async () => {
      // Fall back to the last-active tab when no explicit session was
      // requested in the URL — otherwise every page load would spawn a
      // brand-new session on top of the persisted strip.
      if (!resume && !forceNew) {
        try {
          const r = await fetch("/api/sessions/open-tabs");
          if (r.ok) {
            const data = (await r.json()) as { activeId?: unknown };
            if (typeof data.activeId === "string" && data.activeId) {
              resume = data.activeId;
            }
          }
        } catch {
          // Best-effort: a network failure just means we create fresh.
        }
      }
      const created = await createSession(
        resume
          ? { resume, resumeSessionAt: at }
          : defaultCwdRef.current
            ? { cwd: defaultCwdRef.current }
            : {},
      );
      if (created && seed) {
        // Wait briefly for the session to be `ready` before sending.
        const start = Date.now();
        while (!sessionIdRef.current && Date.now() - start < 5000) {
          await new Promise((r) => setTimeout(r, 100));
        }
        // Strip ?prompt from URL so refresh doesn't re-fire it.
        try {
          const url = new URL(window.location.href);
          url.searchParams.delete("prompt");
          window.history.replaceState({}, "", url.toString());
        } catch {
          // ignore
        }
        // Push to the input queue once ready.
        const tick = () => {
          if (pendingRef.current === false) {
            const id = sessionIdRef.current;
            if (id) {
              void fetch(`/api/sessions/${id}/input`, {
                method: "POST",
                headers: { "Content-Type": "application/json" },
                body: JSON.stringify({ text: seed }),
              });
            }
          } else {
            setTimeout(tick, 250);
          }
        };
        setTimeout(tick, 600);
      }
    })();
    return () => {
      // Supersede any in-flight boot transition. Without this, a `createSession`
      // POST still awaiting when the page unmounts (e.g. user navigates chat →
      // git/schedule before the session is born) resolves AFTER cleanup, passes
      // its `switchGenRef.current !== gen` guard (the gen was never bumped), and
      // calls `bindToSession` — which opens a fresh EventSource on an unmounted
      // component. Nothing ever closes that socket, so it leaks. Over a long
      // session these orphans accumulate until the browser's 6-connections-per-
      // origin HTTP/1.1 cap is saturated and every navigation queues for seconds.
      // Bumping the generation here makes the late bind bail (returns null).
      // We intentionally read/mutate the LIVE ref at cleanup time (not a value
      // snapshotted at mount) — snapshotting, as the lint rule suggests, would
      // defeat the guard.
      // eslint-disable-next-line react-hooks/exhaustive-deps
      switchGenRef.current++;
      eventSourceRef.current?.close();
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const send = useCallback(
    async (
      text: string,
      images?: Array<{ id?: string; ordinal?: number; data: string; mediaType: string }>,
      opts?: { asSlashCommand?: boolean; fromSuggestion?: boolean; fromGoal?: boolean },
    ) => {
      const id = sessionIdRef.current;
      const trimmedText = text.trim();
      const hasImages = Array.isArray(images) && images.length > 0;
      if (!id || (!trimmedText && !hasImages)) return;
      const isSlash = !!opts?.asSlashCommand;
      const fromSuggestion = !!opts?.fromSuggestion;
      const fromGoal = !!opts?.fromGoal;
      // Clear any standing recap banner — once the user is talking again
      // the "where were we?" hint is by definition stale. The server-side
      // session also aborts any in-flight recap on sendInput, so this is
      // just the visible mirror of that contract.
      setSessionRecap({
        status: "idle",
        text: null,
        at: null,
        origin: null,
        errorReason: null,
      });
      // Normalize image shape (mint a stable client id + ordinal) for the
      // optimistic user bubble we may render below.
      const normalized = hasImages
        ? images!.map((img, i) => ({
            id: img.id ?? crypto.randomUUID(),
            ordinal: typeof img.ordinal === "number" ? img.ordinal : i + 1,
            data: img.data,
            mediaType: img.mediaType,
          }))
        : undefined;
      // Mint the uuid up front so the optimistic bubble and the server POST
      // share the same id — needed for the rollback path below when the
      // server decides this message landed in the queue instead of running.
      const uuid = crypto.randomUUID();
      // Slash commands don't render as user messages — the server emits a
      // `slash_invoked` system pill in their place. Skipping the optimistic
      // add keeps the chat clean even before the SSE pill arrives.
      const showedOptimisticBubble = !isSlash;
      if (showedOptimisticBubble) {
        const sentAt = Date.now();
        setMessages((prev) => [
          ...prev,
          {
            uuid,
            role: "user",
            blocks: [{ kind: "text", text }],
            ...(normalized ? { images: normalized } : {}),
            createdAt: sentAt,
          },
        ]);
      }
      // Badge this bubble as auto-suggested right away (the server persists it
      // server-side so it survives reload). Keyed by the same uuid that lands
      // in the JSONL, so the reload-time DB lookup re-marks the same message.
      if (fromSuggestion) {
        setSuggestedUuids((prev) => new Set(prev).add(uuid));
      }
      if (fromGoal) {
        setGoalUuids((prev) => new Set(prev).add(uuid));
      }
      setPromptSuggestions([]);
      // We DON'T flip `pending` to true here anymore — the server decides
      // whether this message runs now or gets enqueued, and we won't know
      // which until the POST resolves. The SSE `turn_status` echo (and
      // `queue:updated` if it was enqueued) will set the right state.
      setErrors([]);
      const res = await fetch(`/api/sessions/${id}/input`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          text,
          images: normalized,
          uuid,
          ...(isSlash ? { slash: true } : {}),
          ...(fromSuggestion ? { fromSuggestion: true } : {}),
          ...(fromGoal ? { fromGoal: true } : {}),
        }),
      });
      if (!res.ok) {
        setErrors((e) => [...e, `send failed: ${res.status}`]);
        // Roll back any optimistic bubble we added — there's no message in
        // flight, the user should see their composer content lost into the
        // void (not in the transcript as if it had been sent).
        if (showedOptimisticBubble) {
          setMessages((prev) => prev.filter((m) => m.uuid !== uuid));
        }
        return;
      }
      // Parse the server's decision: did the message dispatch now, or get
      // queued? If queued, we need to roll back the optimistic user bubble
      // — it'll reappear in the QueueIndicator strip via the next
      // `queue:updated` SSE echo, and only land in `messages` when the
      // server's drain feeds it through `sendInput` (which broadcasts the
      // bubble back to us via SSE with this same uuid).
      try {
        const body = (await res.json()) as { queued?: boolean };
        if (body?.queued && showedOptimisticBubble) {
          setMessages((prev) => prev.filter((m) => m.uuid !== uuid));
        }
      } catch {
        // best-effort — if the response body is unparseable, assume the
        // optimistic path and let the SSE echo reconcile.
      }
    },
    [],
  );

  const enqueue = useCallback(
    async (text: string, images?: AttachedImage[]) => {
      const id = sessionIdRef.current;
      const trimmed = text.trim();
      if (!id || (!trimmed && (!images || images.length === 0))) return;
      // Explicit "stage this for later" — bypass the server's idle check
      // with `forceQueue: true` so a fresh send doesn't sneak in front of
      // the already-staged item. The `queue:updated` SSE echo will paint
      // the new item into the QueueIndicator strip.
      try {
        await fetch(`/api/sessions/${id}/input`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            text: trimmed,
            ...(images && images.length ? { images } : {}),
            forceQueue: true,
          }),
        });
      } catch {
        // Best-effort; an offline tab silently drops the enqueue, matching
        // the previous client behaviour.
      }
    },
    [],
  );

  const cancelQueued = useCallback(async (qid: string) => {
    const id = sessionIdRef.current;
    if (!id) return;
    try {
      await fetch(`/api/sessions/${id}/queue/${qid}`, { method: "DELETE" });
    } catch {
      // ignore — SSE echo will reflect whatever did/didn't change
    }
  }, []);

  const editQueued = useCallback(
    async (qid: string): Promise<{ text: string; images?: AttachedImage[] } | null> => {
      const id = sessionIdRef.current;
      if (!id) return null;
      // DELETE returns the full row content (text + images) for the
      // composer to pre-fill. Images aren't in the `queue:updated` snapshot
      // (kept slim), so this round-trip is the only way to get the
      // original base64 blobs back.
      let res: Response;
      try {
        res = await fetch(`/api/sessions/${id}/queue/${qid}`, { method: "DELETE" });
      } catch {
        return null;
      }
      if (!res.ok) return null;
      type EditedRow = { text?: string; images?: AttachedImage[] };
      let body: EditedRow | null = null;
      try {
        body = (await res.json()) as EditedRow;
      } catch {
        return null;
      }
      if (!body || typeof body.text !== "string") return null;
      return {
        text: body.text,
        ...(body.images && body.images.length ? { images: body.images } : {}),
      };
    },
    [],
  );

  const reorderQueued = useCallback(async (qid: string, dir: -1 | 1) => {
    const id = sessionIdRef.current;
    if (!id) return;
    const direction = dir === -1 ? "up" : "down";
    try {
      await fetch(`/api/sessions/${id}/queue/${qid}/move`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ direction }),
      });
    } catch {
      // ignore — SSE echo reflects any swap that landed
    }
  }, []);

  const sendQueuedNow = useCallback(async (qid: string) => {
    const id = sessionIdRef.current;
    if (!id) return;
    // Per-message override of the workspace `queueDispatchMode` setting:
    // server atomically pops this row and pushes it into the SDK input
    // pipe so it runs as the very next turn — even when the agent is
    // currently working. A `queue:updated` SSE echoes the removal and
    // the user bubble appears when `sendInput`'s broadcast lands.
    try {
      await fetch(`/api/sessions/${id}/queue/${qid}/send-now`, {
        method: "POST",
      });
    } catch {
      // best-effort — the item stays queued on transient failure
    }
  }, []);

  const resolvePermission = useCallback(async (requestId: string, decision: PermissionDecision) => {
    const id = sessionIdRef.current;
    if (!id) return;
    setPendingPermission(null);
    pendingPermissionRef.current = null;
    await fetch(`/api/sessions/${id}/permission`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ requestId, decision }),
    });
    // Queue drain is server-driven now — `Session.resolvePermission` calls
    // `flushQueueIfIdle()` after a successful resolve. No client trigger.
  }, []);

  const submitAskAnswer = useCallback(
    async (requestId: string, answers: AskAnswer[]) => {
      const id = sessionIdRef.current;
      if (!id) return;
      setPendingAsk(null);
      await fetch(`/api/sessions/${id}/ask-answer`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ requestId, answers }),
      }).catch(() => {});
    },
    [],
  );

  // Forward the feedback nudge to `/api/feedback` (stores locally + forwards to
  // Anthropic). We DON'T clear `feedbackSurvey` here — the banner stays mounted
  // to show the result (and the graceful-fail message) and calls
  // `dismissFeedback` when it's done. The server defaults `surface`, so we only
  // send the session id + the user's rating/comment.
  const submitFeedback = useCallback(
    async (input: { rating?: "up" | "down"; comment: string }) => {
      const id = sessionIdRef.current;
      if (!id) return { ok: false, stored: false, forwarded: false };
      try {
        const res = await fetch(`/api/feedback`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            sessionId: id,
            rating: input.rating,
            comment: input.comment,
          }),
        });
        const j = (await res.json().catch(() => ({}))) as {
          ok?: boolean;
          stored?: boolean;
          forwarded?: boolean;
        };
        if (!res.ok) {
          return { ok: false, stored: j.stored ?? false, forwarded: j.forwarded ?? false };
        }
        return { ok: j.ok ?? true, stored: j.stored ?? true, forwarded: j.forwarded ?? false };
      } catch {
        return { ok: false, stored: false, forwarded: false };
      }
    },
    [],
  );

  const dismissFeedback = useCallback(() => {
    setFeedbackSurvey(null);
  }, []);

  const dismissOpusOverloadNudge = useCallback(() => {
    setOpusOverloadNudge(null);
  }, []);

  const dismissLongContextCreditsNudge = useCallback(() => {
    setLongContextCreditsNudge(null);
  }, []);

  const dismissAuthFailedNudge = useCallback(() => {
    setAuthFailedNudge(null);
  }, []);

  const dismissTokenExpiringNudge = useCallback(() => {
    setTokenExpiringNudge(null);
  }, []);

  const dismissFastModeNotice = useCallback(() => {
    setFastModeNotice(null);
  }, []);

  const dismissChatCommandModelNotice = useCallback(() => {
    setChatCommandModelNotice(null);
  }, []);

  const dismissModelSwitchNotice = useCallback(() => {
    setModelSwitchNotice(null);
  }, []);

  const dismissAdvisorDisabledNotice = useCallback(() => {
    setAdvisorDisabledNotice(null);
  }, []);

  /**
   * Re-enable the advisor after it was auto-disabled on a model change.
   * Calls the same advisor route the picker uses, so both settings.json and
   * the flag-settings layer are updated. Clears the toast on success.
   */
  const reEnableAdvisor = useCallback(
    async (advisorModel: string) => {
      const id = sessionIdRef.current;
      if (!id) return;
      // Optimistic: update the advisor state and clear the toast so the
      // button doesn't sit in a spinner state waiting for the network.
      setAdvisorModelState(advisorModel);
      setAdvisorDisabledNotice(null);
      await fetch(`/api/sessions/${id}/advisor`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ model: advisorModel }),
      }).catch(() => {});
    },
    [],
  );

  const requestRecap = useCallback(async (origin: "away" | "manual" = "manual") => {
    const id = sessionIdRef.current;
    if (!id) return;
    // Flip to "loading" optimistically so the UI can paint a spinner before
    // the SSE event lands. The server's `session_recap` /
    // `session_recap_error` transitions us back out of this state. If the
    // POST itself fails (network / 404), roll back to idle — the banner
    // shouldn't be stuck on a spinner.
    setSessionRecap((cur) => ({
      ...cur,
      status: "loading",
      origin,
    }));
    try {
      const res = await fetch(`/api/sessions/${id}/recap`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ origin }),
      });
      if (!res.ok) {
        setSessionRecap({
          status: "idle",
          text: null,
          at: null,
          origin: null,
          errorReason: null,
        });
      }
    } catch {
      setSessionRecap({
        status: "idle",
        text: null,
        at: null,
        origin: null,
        errorReason: null,
      });
    }
  }, []);

  const dismissRecap = useCallback(() => {
    setSessionRecap({
      status: "idle",
      text: null,
      at: null,
      origin: null,
      errorReason: null,
    });
  }, []);

  const interrupt = useCallback(async () => {
    const id = sessionIdRef.current;
    if (!id) return;
    const res = await fetch(`/api/sessions/${id}/interrupt`, { method: "POST" });
    setPendingTracked(false);
    // SDK 0.3.205 — on a CLI advertising `interrupt_receipt_v1`, the route
    // returns `stillQueued` uuids of async user messages that will still
    // run despite this Stop (queued commands, or a batch already dequeued
    // for the imminent turn). Surface an info pill so the user isn't
    // surprised when queued input keeps executing after they hit Stop.
    // Older CLIs / a rejected interrupt degrade to `[]` server-side, so
    // this is a no-op there.
    try {
      const data = (await res.json()) as { stillQueued?: unknown };
      const stillQueued = Array.isArray(data.stillQueued)
        ? data.stillQueued.filter((v): v is string => typeof v === "string")
        : [];
      if (stillQueued.length > 0) {
        const anchor = lastAssistantUuidRef.current;
        setSystemEntries((prev) => [
          ...prev,
          {
            uuid: crypto.randomUUID(),
            afterMessageUuid: anchor,
            kind: "info" as const,
            label: `Stop: ${stillQueued.length} queued message${stillQueued.length === 1 ? "" : "s"} will still run`,
          },
        ]);
      }
    } catch {
      // Non-JSON / network hiccup on an already-fired Stop — nothing to
      // recover, the interrupt itself already went out above.
    }
  }, [setPendingTracked]);

  /**
   * Forcefully reclaim the write lock for this session. Issues a PATCH to the
   * server; all connected clients receive `holder_changed` over SSE so any
   * tab that was previously the holder renders read-only immediately — even
   * across different browsers or Electron + browser contexts.
   */
  const takeOver = useCallback(async () => {
    const id = sessionIdRef.current;
    if (!id) return;
    await fetch(`/api/sessions/${id}/holder`, {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ tabId: myTabId }),
    });
  }, [myTabId]);

  const setPermissionMode = useCallback(async (mode: PermissionMode) => {
    const id = sessionIdRef.current;
    if (!id) return;
    setPermissionModeState(mode);
    await fetch(`/api/sessions/${id}/mode`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ mode }),
    }).catch(() => {});
  }, []);

  const resolvePlan = useCallback(async (decision: PlanDecision) => {
    const id = sessionIdRef.current;
    if (!id) return;
    // Snapshot the pending request so we can clear local state immediately
    // (closes the modal) while the POST is in flight. If there's nothing
    // pending, treat as a no-op — the prompt was already resolved.
    const pending = pendingPlanRef.current;
    if (!pending) return;
    setPendingPlan(null);
    pendingPlanRef.current = null;
    await fetch(`/api/sessions/${id}/plan`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ requestId: pending.requestId, decision }),
    }).catch(() => {});
  }, []);

  const loadOlder = useCallback(async () => {
    const id = sessionIdRef.current;
    if (!id) return;
    if (!hasMoreAbove) return;
    if (loadingOlder) return;
    setLoadingOlder(true);
    try {
      // The transcript route looks up `before` against the JSONL's raw
      // wrapper uuids — pass an SDK wrapper uuid (the first split folded
      // into the head bubble) instead of the bubble's primary identity
      // (which is the Anthropic `message.id`, not present in JSONL records'
      // top-level `uuid` field). For user-message heads, the primary uuid
      // IS the wrapper uuid, so the fallback works without extra cases.
      const headBubble = messagesRef.current[0];
      const head =
        headBubble?.foldedSdkUuids?.values().next().value ?? headBubble?.uuid;
      const url = head
        ? `/api/sessions/${id}/transcript?before=${encodeURIComponent(head)}&limit=50`
        : `/api/sessions/${id}/transcript?limit=50`;
      const res = await fetch(url);
      if (!res.ok) {
        // A non-OK response — most commonly the 400 "before uuid not found"
        // when the head cursor doesn't resolve against the JSONL's raw
        // wrapper uuids — means we cannot advance the cursor. Clear
        // hasMoreAbove so the top sentinel unmounts and its
        // IntersectionObserver stops re-firing loadOlder in a tight loop
        // (the "Loading older messages…" / "Scroll up" flicker).
        setHasMoreAbove(false);
        return;
      }
      const data = (await res.json()) as {
        messages: Array<Record<string, unknown>>;
        hasMore: boolean;
      };
      const synth = synthesizeOlder(data.messages);
      // Compute fresh prepends against the current list up front so we can
      // tell whether this page actually moved the head cursor. The cursor is
      // always messagesRef.current[0]; if nothing fresh is prepended the head
      // can't change, so a subsequent loadOlder would re-fetch this exact
      // page forever — the second source of the flicker.
      const seen = new Set(messagesRef.current.map((m) => m.uuid));
      const fresh = synth.messages.filter((m) => !seen.has(m.uuid));
      if (fresh.length > 0) {
        setMessages((prev) => {
          // Re-dedupe against the latest list in case the head/tail shifted
          // between snapshot and commit (SSE append, snapshot inject).
          const seenNow = new Set(prev.map((m) => m.uuid));
          const stillFresh = fresh.filter((m) => !seenNow.has(m.uuid));
          return stillFresh.length > 0 ? [...stillFresh, ...prev] : prev;
        });
        setHasMoreAbove(data.hasMore);
      } else {
        // Page resolved but every record dedupes against what's already
        // loaded — no forward progress is possible. Stop paginating.
        setHasMoreAbove(false);
      }
    } finally {
      setLoadingOlder(false);
    }
  }, [hasMoreAbove, loadingOlder]);

  // Stable ref that always points to the latest `loadOlder` closure. Used by
  // `loadUntilTasksFoundRef` below so that function doesn't go stale when
  // hasMoreAbove / loadingOlder flip during a pagination run.
  const loadOlderRef = useRef(loadOlder);
  useEffect(() => {
    loadOlderRef.current = loadOlder;
  }, [loadOlder]);

  // Populate the ref declared before applyEvent. Runs once on mount and
  // thereafter any time loadOlder is recreated, keeping the closure fresh.
  // The function itself reads from stable refs (messagesRef, hasMoreAboveRef,
  // loadOlderRef) and the stable setMessages setter so it never goes stale.
  useEffect(() => {
    loadUntilTasksFoundRef.current = async (
      tasks: Array<{ toolUseId: string; entry: TaskSnapshotEntry }>,
    ) => {
      // Cap at 200 pages — same defensive limit as jumpToUuid.
      for (let i = 0; i < 200; i++) {
        const stillUnlinked = tasks.filter(
          ({ toolUseId }) => !findToolUseBlock(toolUseId, messagesRef.current),
        );
        if (stillUnlinked.length === 0) break;
        if (!hasMoreAboveRef.current) {
          // Reached the beginning of history without finding the parent
          // messages. Most likely cause: the SDK's automatic compaction
          // rewrote the JSONL and the original assistant messages are gone.
          // Synthesize minimal assistant messages so the TaskBlock can still
          // render with the SQLite-recovered metadata and inner conversation.
          const synthetic: DisplayMessage[] = stillUnlinked.map(({ toolUseId, entry }) => {
            // A workflow's aggregate task never captures inner messages — its
            // child agents register their conversations under their own
            // tool_use_ids (each surfaces as a separate `local_agent` task).
            // Routing it through TaskBlock would always render an empty "No
            // subagent messages captured." box. Synthesize a "Workflow" block
            // instead so it routes to WorkflowBlock, which renders the
            // recovered name / status / summary joined from the snapshot task.
            const isWorkflow = entry.taskType === "local_workflow";
            return {
              uuid: `recovered-task-${toolUseId}`,
              role: "assistant" as const,
              blocks: [
                {
                  kind: "tool_use" as const,
                  id: toolUseId,
                  // "Workflow" routes to WorkflowBlock; "Agent" satisfies
                  // isSubagentToolName so AssistantMessage routes to TaskBlock.
                  name: isWorkflow ? "Workflow" : "Agent",
                  input: isWorkflow
                    ? {
                        // WorkflowBlock falls back to `input.name` for the pill
                        // when no script (and thus no parsed meta) is present.
                        name: entry.workflowName ?? "Workflow",
                      }
                    : {
                        // `subagent_type` is what TaskBlock shows as the pill label.
                        subagent_type: entry.taskType ?? "Agent",
                        description: entry.description ?? "",
                        prompt: "",
                      },
                  // Pre-populate the result so the pill shows "completed"
                  // rather than "running" when the status is known.
                  ...(entry.status !== "running"
                    ? {
                        result: {
                          content: entry.summary ?? "",
                          isError: entry.status === "failed",
                        },
                      }
                    : {}),
                },
              ],
            };
          });
          setMessages((prev) => {
            const seenUuids = new Set(prev.map((m) => m.uuid));
            const fresh = synthetic.filter((m) => !seenUuids.has(m.uuid));
            return fresh.length > 0 ? [...fresh, ...prev] : prev;
          });
          break;
        }
        await loadOlderRef.current();
      }
    };
  }, []); // intentionally empty: reads go through stable refs + stable setters (setMessages)

  /**
   * Make sure a given uuid is loaded into `messages` state, paginating older
   * pages as needed. Accepts either a bubble's primary uuid (Anthropic
   * `message.id` for assistants, wrapper uuid for users) OR any SDK wrapper
   * uuid that was folded into a bubble — search hits carry the latter.
   *
   * Returns the bubble's primary uuid on success (use that for highlight /
   * scroll-into-view, which key on `data-message-uuid` set from the primary),
   * or null if the head of the transcript was reached without a match.
   */
  const jumpToUuid = useCallback(
    async (uuid: string): Promise<string | null> => {
      const resolve = (): string | null => {
        for (const m of messagesRef.current) {
          if (m.uuid === uuid) return m.uuid;
          if (m.foldedSdkUuids?.has(uuid)) return m.uuid;
        }
        return null;
      };
      const first = resolve();
      if (first) return first;
      // Cap iterations defensively — transcripts above ~10k messages are
      // pathological enough that we'd rather give up than spin.
      for (let i = 0; i < 200; i++) {
        if (!hasMoreAboveRef.current) break;
        await loadOlder();
        const next = resolve();
        if (next) return next;
      }
      return resolve();
    },
    [loadOlder],
  );

  const setModel = useCallback(
    async (m: string | null, source: "picker" | "chat_command" = "picker") => {
    const id = sessionIdRef.current;
    if (!id) return;
    setModelState(m);
    try {
      const r = await fetch(`/api/sessions/${id}/model`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ model: m, source }),
      });
      if (!r.ok) {
        // SDK rejected the switch (route returns 409 + the authoritative
        // current model). Revert to what the server reports — using the
        // response avoids reading a stale closure of `model` here — and
        // raise the transient toast so the user sees why the picker
        // didn't take.
        const body = (await r.json().catch(() => ({}))) as {
          error?: string;
          model?: string | null;
        };
        setModelState(typeof body.model === "string" ? body.model : null);
        setModelSwitchNotice({
          uuid: crypto.randomUUID(),
          attempted: m,
          error: body.error ?? `HTTP ${r.status}`,
        });
      }
    } catch {
      // Network blip — leave the optimistic state and let the next event /
      // refresh reconcile. We deliberately don't toast here: a transient
      // network error isn't a model rejection.
    }
  }, []);

  /**
   * Effort/reasoning level. Routed through a dedicated `/effort` API route
   * that calls `Query.applyFlagSettings({ effortLevel: <level> })` on the
   * server. The first cut sent `/effort <level>` as a slash command, but
   * the SDK doesn't register that command and answered with
   * "/effort isn't available in this environment." — leaving the picker
   * looking like it worked while the model kept its prior effort.
   *
   * `"auto"` clears the override and restores adaptive thinking. We
   * optimistic-mirror the pick locally so the SessionCard pill reflects
   * the chosen level immediately; the SDK doesn't emit an
   * `effort_changed` event we can subscribe to, so this mirror is the
   * source of truth as long as users only change effort through the
   * picker.
   */
  const setEffort = useCallback(
    async (level: "low" | "medium" | "high" | "xhigh" | "max" | "auto") => {
      const id = sessionIdRef.current;
      if (!id) return;
      setEffortState(level);
      await fetch(`/api/sessions/${id}/effort`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ level }),
      }).catch(() => {});
    },
    [],
  );

  /**
   * Toggle "ultracode" (Dynamic Workflows). Mirrors `setEffort` — POSTs to a
   * dedicated route that calls `applyFlagSettings({ ultracode })` server-
   * side. Enabling ultracode forces `xhigh` effort on the SDK side, so we
   * move the local effort mirror to `xhigh` too; otherwise the effort pill
   * would lag behind reality. Disabling leaves effort untouched (it stays
   * wherever the user last set it — session-scoped on the SDK).
   */
  const setUltracode = useCallback(
    async (enabled: boolean) => {
      const id = sessionIdRef.current;
      if (!id) return;
      setUltracodeState(enabled);
      if (enabled) setEffortState("xhigh");
      await fetch(`/api/sessions/${id}/ultracode`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ enabled }),
      }).catch(() => {});
    },
    [],
  );

  /**
   * Toggle "fast mode". Mirrors `setUltracode` — POSTs to a dedicated route
   * that calls `applyFlagSettings({ fastMode })` server-side. Unlike ultracode
   * there's NO effort side effect: fast mode is orthogonal to effort, so the
   * effort mirror is left wherever the user last set it.
   */
  const setFast = useCallback(async (enabled: boolean) => {
    const id = sessionIdRef.current;
    if (!id) return;
    setFastEnabled(enabled);
    await fetch(`/api/sessions/${id}/fast`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ enabled }),
    }).catch(() => {});
  }, []);

  /**
   * Set the per-session advisor model. Mirrors `setFast` / `setUltracode`:
   * a dedicated route POSTs through to `applyFlagSettings({ advisorModel })`
   * server-side, and we optimistic-mirror locally so the picker reflects
   * the pick before the round-trip completes.
   *
   * `null` clears the per-session override and falls back to whatever
   * settings.json carries (forwarded once at session start). No SDK event
   * exists to confirm the change, so this mirror is the source of truth
   * until the user reloads — matching the effort/ultracode/fast story.
   */
  const setAdvisorModel = useCallback(async (model: string | null) => {
    const id = sessionIdRef.current;
    if (!id) return;
    setAdvisorModelState(model);
    await fetch(`/api/sessions/${id}/advisor`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ model }),
    }).catch(() => {});
  }, []);

  /**
   * Live-switch the main-thread agent via `applyFlagSettings` (SDK 0.3.161+).
   *
   * Optimistic: updates `mainAgent` immediately so the StatusLine badge
   * reflects the new agent before the network round-trip completes. Passes
   * `null` to reset to the default general-purpose agent. The server
   * broadcasts an `agent_changed` SSE event so all tabs stay in sync.
   */
  const setAgent = useCallback(async (name: string | null) => {
    const id = sessionIdRef.current;
    if (!id) return;
    setMainAgent(name);
    await fetch(`/api/sessions/${id}/agent`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ agent: name }),
    }).catch(() => {});
  }, []);

  const renameTitle = useCallback(
    async (title: string): Promise<{ ok: true } | { ok: false; error: string }> => {
      const id = sessionIdRef.current;
      if (!id) return { ok: false, error: "no active session" };
      const trimmed = title.trim();
      if (!trimmed) return { ok: false, error: "title required" };
      // Optimistic local update — the SSE `session_title` event will confirm
      // (or, if the API call fails below, we revert).
      const prev = sessionTitle;
      setSessionTitle(trimmed);
      try {
        const res = await fetch(`/api/sessions/rename`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ sessionId: id, title: trimmed }),
        });
        if (!res.ok) {
          setSessionTitle(prev);
          const body = (await res.json().catch(() => ({}))) as { error?: string };
          return { ok: false, error: body.error ?? `HTTP ${res.status}` };
        }
        // Refresh the indexed sessions list so non-active *tabs* in the same
        // browser tab pick up the new title via tabLabelFor's lookup. The
        // active tab already reflects the rename through `sessionTitle` /
        // the SSE `session_title` event.
        void refreshSessions();
        return { ok: true };
      } catch (err) {
        setSessionTitle(prev);
        return { ok: false, error: err instanceof Error ? err.message : String(err) };
      }
    },
    [sessionTitle, refreshSessions],
  );

  // Durably clear the agent's TodoWrite snapshot. POSTs to
  // `/api/sessions/:id/clear-todos`; the server nulls its in-memory
  // snapshot, persists the clear marker so a future server restart can't
  // resurrect the list from disk JSONL, and broadcasts
  // `session_snapshot { todos: [] }` which the reducer below collapses to
  // an empty `latestTodos`. We don't optimistically clear here — letting
  // the SSE round-trip drive the state update keeps this tab and siblings
  // in lock-step, and the round-trip is sub-frame for local servers.
  //
  // Errors are surfaced to the console (not silently swallowed) so a
  // broken click — most commonly a 503 from a stale dev-HMR Session
  // instance — actually tells the user what to do instead of looking like
  // the button does nothing.
  const clearTodos = useCallback(async (): Promise<void> => {
    const id = sessionIdRef.current;
    if (!id) return;
    try {
      const res = await fetch(`/api/sessions/${id}/clear-todos`, { method: "POST" });
      if (!res.ok) {
        const body = (await res.json().catch(() => ({}))) as { error?: string };

        console.warn(
          `[clearTodos] server returned ${res.status}: ${body.error ?? "no body"}`,
        );
      }
    } catch (err) {

      console.warn("[clearTodos] network error", err);
    }
  }, []);

  // Targeted per-item edit on the agent's TodoWrite snapshot — invoked
  // when the user clicks a status icon (toggle done) or × (delete) on a
  // banner / rail to-do entry. Routes to
  // `POST /api/sessions/:id/todos/:itemId`, which mutates the server's
  // in-memory snapshot, persists a `manualTodoOverrides[itemId]` entry
  // for restart durability, and broadcasts `session_snapshot { todos }`.
  // We let the SSE round-trip drive the state update (no optimistic mutation
  // here) so this tab and siblings stay in lock-step. Errors surface to
  // the console with the server-side reason — the most useful failure
  // modes (422 stale list, 503 dev-HMR stale instance) are diagnosable
  // from the console message.
  // Dismiss the auto-cleared toast — the toast component calls this when
  // its fade-out timer elapses, and the user's manual close button (×)
  // calls it eagerly. No-op if there's nothing showing.
  const dismissTodosAutoClearedCb = useCallback((): void => {
    setTodosAutoCleared(null);
  }, []);

  const updateTodoItem = useCallback(
    async (
      itemId: string,
      action: "complete" | "reopen" | "in_progress" | "delete",
    ): Promise<{ ok: true } | { ok: false; error: string }> => {
      const id = sessionIdRef.current;
      if (!id) return { ok: false, error: "no active session" };
      try {
        const res = await fetch(
          `/api/sessions/${id}/todos/${encodeURIComponent(itemId)}`,
          {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ action }),
          },
        );
        if (!res.ok) {
          const body = (await res.json().catch(() => ({}))) as { error?: string };
          const msg = body.error ?? `HTTP ${res.status}`;

          console.warn(`[updateTodoItem] server returned ${res.status}: ${msg}`);
          return { ok: false, error: msg };
        }
        return { ok: true };
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);

        console.warn("[updateTodoItem] network error", msg);
        return { ok: false, error: msg };
      }
    },
    [],
  );

  const clearGoal = useCallback(
    async (): Promise<{ ok: true } | { ok: false; error: string }> => {
      const id = sessionIdRef.current;
      if (!id) return { ok: false, error: "no active session" };
      const prev = goal;
      // Optimistic — the SSE `goal_changed` event confirms; revert on failure.
      setGoalState(null);
      try {
        const res = await fetch(`/api/sessions/${id}/goal`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ goal: null }),
        });
        if (!res.ok) {
          setGoalState(prev);
          const body = (await res.json().catch(() => ({}))) as { error?: string };
          return { ok: false, error: body.error ?? `HTTP ${res.status}` };
        }
        return { ok: true };
      } catch (err) {
        setGoalState(prev);
        return { ok: false, error: err instanceof Error ? err.message : String(err) };
      }
    },
    [goal],
  );

  const setGoal = useCallback(
    async (text: string): Promise<{ ok: true } | { ok: false; error: string }> => {
      const id = sessionIdRef.current;
      if (!id) return { ok: false, error: "no active session" };
      const trimmed = text.trim();
      if (!trimmed) return clearGoal();
      const prev = goal;
      // Optimistic — replacing a goal resets achievement. The SSE
      // `goal_changed` event confirms; revert on failure.
      setGoalState({
        text: trimmed,
        achieved: false,
        summary: null,
        setAt: Date.now(),
        achievedAt: null,
      });
      try {
        const res = await fetch(`/api/sessions/${id}/goal`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ goal: trimmed }),
        });
        if (!res.ok) {
          setGoalState(prev);
          const body = (await res.json().catch(() => ({}))) as { error?: string };
          return { ok: false, error: body.error ?? `HTTP ${res.status}` };
        }
        return { ok: true };
      } catch (err) {
        setGoalState(prev);
        return { ok: false, error: err instanceof Error ? err.message : String(err) };
      }
    },
    [goal, clearGoal],
  );

  return {
    sessionId,
    ready,
    pending,
    readOnly: holderTabId !== null && holderTabId !== myTabId,
    takeOver,
    messages: sortedMessages,
    systemEntries,
    toolProgress,
    queue,
    pendingPermission,
    pendingAsk,
    feedbackSurvey,
    opusOverloadNudge,
    apiRetry,
    longContextCreditsNudge,
    authFailedNudge,
    tokenExpiringNudge,
    tips,
    sessionRecap,
    errors,
    slashCommands,
    agents,
    mainAgent,
    permissionMode,
    model,
    effort,
    ultracode,
    fastMode,
    advisorModel,
    sessions,
    skills,
    cwd,
    agentCwd,
    usage,
    planUsage,
    tasks,
    liveBackgroundTaskIds,
    subagentMessages,
    pendingPlan,
    fastModeState,
    fastModeNotice,
    modelSwitchNotice,
    chatCommandModelNotice,
    advisorDisabledNotice,
    promptSuggestions,
    suggestedUuids,
    goalUuids,
    replaying,
    hasMoreAbove,
    loadingOlder,
    latestTodos,
    todosStale,
    recentEdits,
    backgroundBashes,
    scheduledLoops,
    toolHistory,
    sessionTitle,
    goal,
    send,
    enqueue,
    cancelQueued,
    editQueued,
    reorderQueued,
    sendQueuedNow,
    resolvePermission,
    submitAskAnswer,
    submitFeedback,
    dismissFeedback,
    dismissOpusOverloadNudge,
    dismissLongContextCreditsNudge,
    dismissAuthFailedNudge,
    dismissTokenExpiringNudge,
    dismissFastModeNotice,
    dismissModelSwitchNotice,
    dismissChatCommandModelNotice,
    dismissAdvisorDisabledNotice,
    reEnableAdvisor,
    requestRecap,
    dismissRecap,
    interrupt,
    setPermissionMode,
    setModel,
    setEffort,
    setUltracode,
    setFast,
    setAdvisorModel,
    setAgent,
    switchSession,
    createNewSession,
    createSessionAt,
    createNewSessionWithDraft,
    refreshSessions,
    resolvePlan,
    loadOlder,
    jumpToUuid,
    renameTitle,
    setGoal,
    clearGoal,
    clearTodos,
    updateTodoItem,
    todosAutoCleared,
    dismissTodosAutoCleared: dismissTodosAutoClearedCb,
  };
}

type RawSDKMessage = {
  uuid?: string;
  type?: string;
  parent_tool_use_id?: string | null;
  message?: { id?: string; role?: string; content?: unknown };
  /**
   * ISO timestamp set by the SDK on user-message records in the JSONL.
   * Assistant records don't carry one — their `createdAt` stays undefined
   * on the older-pagination path and the UI hides the chip.
   */
  timestamp?: string;
  /**
   * Envelope flags the SDK writes on transcript-only plumbing messages —
   * `isMeta` (local-command-caveat wrappers around slash runs), and the
   * `isCompactSummary` / `isVisibleInTranscriptOnly` pair the SDK stamps on
   * the synthesized "Session continued from a previous conversation"
   * user-shaped record it emits right after a successful /compact. These
   * aren't in the SDK's TypeScript type but are present on the JSONL
   * envelope; `isSdkInternalEnvelope` reads them and the synthesizeOlder
   * loop skips matching records so paginated history doesn't show two
   * bonus user bubbles the user never typed.
   */
  isMeta?: boolean;
  isCompactSummary?: boolean;
  isVisibleInTranscriptOnly?: boolean;
  /**
   * SDK 0.3.205 — provenance of a user-role record (peer session, team
   * lead, channel). Only the `peer` shape is read (via `extractPeerOrigin`)
   * to drive the "From `<name>`" badge on the pagination path; other kinds
   * are ignored here the same as on the live path.
   */
  origin?: { kind?: string; from?: string; name?: string; body?: string };
};

/**
 * Merge compaction metadata / summary onto a single `compact_boundary`
 * divider. The SDK delivers the boundary (token deltas, duration, trigger) and
 * the synthesized summary text as two separate records sharing an anchor;
 * whichever lands first creates the entry and the other enriches it. Idempotent
 * so an SSE replay re-delivering either record never clobbers captured fields.
 */
function mergeCompactBoundary(
  prev: SystemEntry[],
  uuid: string,
  anchor: string,
  patch: { compactStats?: SystemEntry["compactStats"]; compactSummary?: string },
): SystemEntry[] {
  const idx = prev.findIndex(
    (e) => e.kind === "compact_boundary" && (e.uuid === uuid || e.afterMessageUuid === anchor),
  );
  if (idx === -1) {
    return [
      ...prev,
      {
        uuid,
        afterMessageUuid: anchor,
        kind: "compact_boundary",
        label: "Compacted earlier conversation",
        ...(patch.compactStats ? { compactStats: patch.compactStats } : {}),
        ...(patch.compactSummary ? { compactSummary: patch.compactSummary } : {}),
      },
    ];
  }
  const existing = prev[idx];
  const next = prev.slice();
  next[idx] = {
    ...existing,
    ...(patch.compactStats
      ? { compactStats: { ...existing.compactStats, ...patch.compactStats } }
      : {}),
    ...(patch.compactSummary ? { compactSummary: patch.compactSummary } : {}),
  };
  return next;
}

/** Normalize the SDK's compact metadata (snake_case live, camelCase on disk). */
function normalizeCompactStats(meta: unknown): SystemEntry["compactStats"] | undefined {
  if (!meta || typeof meta !== "object") return undefined;
  const m = meta as Record<string, unknown>;
  const num = (...keys: string[]): number | undefined => {
    for (const k of keys) {
      const v = m[k];
      if (typeof v === "number" && Number.isFinite(v)) return v;
    }
    return undefined;
  };
  const trigger = typeof m.trigger === "string" ? m.trigger : undefined;
  const preTokens = num("pre_tokens", "preTokens");
  const postTokens = num("post_tokens", "postTokens");
  const durationMs = num("duration_ms", "durationMs");
  if (preTokens == null && postTokens == null && durationMs == null && !trigger) return undefined;
  return {
    ...(preTokens != null ? { preTokens } : {}),
    ...(postTokens != null ? { postTokens } : {}),
    ...(durationMs != null ? { durationMs } : {}),
    ...(trigger ? { trigger } : {}),
  };
}

/**
 * Convert a page of raw SDK messages (JSONL records) into DisplayMessages,
 * folding tool_results onto the matching tool_use blocks of prior assistant
 * messages. Subagent traffic (parent_tool_use_id) is dropped here — the older
 * pagination view shows top-level turns only, mirroring the live tail behavior.
 *
 * Multi-content-block model responses arrive as N consecutive JSONL records
 * (one per content block) sharing a `message.id` but differing in wrapper
 * uuid. We merge them into a single bubble keyed by `message.id`, matching
 * the live-stream identity so search hits and pagination heads round-trip
 * cleanly.
 */
function synthesizeOlder(raw: Array<Record<string, unknown>>): {
  messages: DisplayMessage[];
} {
  const out: DisplayMessage[] = [];
  // Carry-forward timestamp: JSONL only stamps user records, so paginated
  // assistants would otherwise land with `createdAt: undefined` and any
  // downstream chronological sort would have to bunch them at one end. Track
  // the most recent known epoch ms (from a user record's parsed timestamp,
  // bumped by 1ms per intervening assistant so successive splits stay in
  // emit order) and inherit it onto each assistant bubble we create.
  let carriedAt: number | undefined;
  for (const r of raw as RawSDKMessage[]) {
    if (!r || (r.type !== "assistant" && r.type !== "user")) continue;
    if (r.parent_tool_use_id) continue;
    const uuid = typeof r.uuid === "string" ? r.uuid : "";
    if (!uuid) continue;
    // Drop SDK transcript-only plumbing (isMeta caveats, isCompactSummary
    // continuations). Mirrors the live `applyEvent` branch — without this,
    // scrolling past a /compact in the paginated history showed the
    // "Session continued from a previous conversation…" summary AND the
    // <local-command-caveat> wrapper as user-typed bubbles.
    if (isSdkInternalEnvelope(r)) continue;
    const content = r.message?.content;

    if (r.type === "assistant") {
      const msgId = typeof r.message?.id === "string" && r.message.id ? r.message.id : uuid;
      const newBlocks = blocksFromSDKContent(content);
      // Merge into the most recent assistant bubble if it shares this
      // message.id. Intervening tool_results don't push new entries into
      // `out` (they patch in place), so consecutive same-message-id splits
      // remain adjacent even when their tool_results sit between them in
      // the JSONL.
      const last = out[out.length - 1];
      if (last && last.role === "assistant" && last.uuid === msgId) {
        const folded = new Set(last.foldedSdkUuids ?? []);
        if (!folded.has(uuid)) {
          folded.add(uuid);
          const existingToolIds = new Set<string>();
          for (const b of last.blocks) if (b.kind === "tool_use") existingToolIds.add(b.id);
          const toAppend = newBlocks.filter(
            (b) => !(b.kind === "tool_use" && existingToolIds.has(b.id)),
          );
          out[out.length - 1] = {
            ...last,
            blocks: [...last.blocks, ...toAppend],
            foldedSdkUuids: folded,
          };
        }
      } else {
        const at = typeof carriedAt === "number" ? carriedAt : undefined;
        if (typeof carriedAt === "number") carriedAt = carriedAt + 1;
        // Tag a hard rate-limit hit so the bubble renders the inline panel on
        // the pagination path too. `error` doesn't survive the `/transcript`
        // route, so detection is prose-only here; `null` for `last` means no
        // countdown (the reset time is already in the message text).
        // Pagination path: no `last` warning payload or session config in
        // scope, so `resetsAt` / `fallbackModel` aren't available here — the
        // panel falls back to the reset time already printed in the message
        // text and omits the "Now using <fallback>" takeover line.
        const rateLimitHit = isRateLimitHitText(newBlocks)
          ? rateLimitHitFromBlocks(newBlocks, null, null)
          : undefined;
        // Opus-4 high-demand banner — same prose-only signal on the
        // pagination path. See the live applyEvent branch for the parity
        // rationale.
        const opusHighDemand = isOpusHighDemandText(newBlocks) ? true : undefined;
        // Model-unavailable notice on the replay/pagination path. `error` is
        // stripped by `/transcript`, so detection is prose-only here (see the
        // live applyEvent branch for the structured signal).
        const replayBlocks = rewriteModelUnavailableBlocks(newBlocks);
        out.push({
          uuid: msgId,
          role: "assistant",
          blocks: replayBlocks,
          streaming: false,
          foldedSdkUuids: new Set([uuid]),
          ...(typeof at === "number" ? { createdAt: at } : {}),
          ...(rateLimitHit ? { rateLimitHit } : {}),
          ...(opusHighDemand ? { opusHighDemand } : {}),
        });
      }
      continue;
    }

    // user — could be plain text input, or a tool_result envelope.
    const tr = extractToolResult(content);
    if (tr) {
      // Walk back through `out` and patch the matching tool_use block.
      for (let i = out.length - 1; i >= 0; i--) {
        const m = out[i];
        if (m.role !== "assistant") continue;
        const idx = m.blocks.findIndex((b) => b.kind === "tool_use" && b.id === tr.tool_use_id);
        if (idx === -1) continue;
        const blk = m.blocks[idx];
        if (blk.kind !== "tool_use") break;
        const patched = { ...blk, result: { content: tr.text, isError: tr.isError } };
        const blocks = m.blocks.slice();
        blocks[idx] = patched;
        out[i] = { ...m, blocks };
        break;
      }
      continue;
    }

    // Skip SDK-injected <task-notification> wrappers on the replay path too —
    // see the live `if (msg.type === "user")` branch for the rationale.
    if (isSyntheticTaskNotification(content)) continue;

    // Content-shape fallback that mirrors the live `applyEvent` branch.
    // On the pagination/disk-replay path the envelope check above already
    // handles these via `isMeta` / `isCompactSummary`, but keeping the same
    // content-shape filters here means a future SDK change that drops the
    // flags on disk too (or a malformed JSONL line) still won't surface
    // these synthesized messages as user bubbles.
    if (isCompactSummaryContent(content)) continue;
    if (isLocalCommandCaveatContent(content)) continue;

    // Mirror the live path's slash-command filters: a `/compact` user-shape
    // message OR the synthetic `<command-name>/compact</command-name>` /
    // `<local-command-stdout>` plumbing the CLI wraps around a slash run
    // would otherwise render as user bubbles when the user scrolls past
    // them in paginated history. The live path lifts each to a small
    // `Ran /X` system pill — synthesizeOlder doesn't produce SystemEntries
    // (its only output channel is DisplayMessage[]), so we drop them
    // silently here. The `compact_boundary` divider already marks the
    // transition for the user; recreating per-record pills on the
    // pagination path would also double-count after a subsequent
    // resyncFromDisk.
    if (isSdkSlashUserMessage(content)) continue;
    if (parseSyntheticCliWrapper(content)) continue;

    // Plain user message — text or array content. The SDK stamps user
    // records in the JSONL with an ISO `timestamp`; parse it so paginated
    // history shows the original send time rather than nothing, and seed
    // the carry-forward so subsequent assistants in this turn inherit it.
    const parsedTs = typeof r.timestamp === "string" ? Date.parse(r.timestamp) : NaN;
    if (Number.isFinite(parsedTs)) carriedAt = parsedTs;
    // Rehydrate image attachments alongside the text so paginated history
    // still renders thumbnail chips (and `[Image #N]` tokens) for older
    // user messages that the SSE replay buffer no longer covers.
    //
    // `reminderBodies` (cross-turn <system-reminder> blocks the server
    // prepended to this user record) is intentionally discarded here:
    // `synthesizeOlder`'s only output channel is `DisplayMessage[]`, so we
    // can't lift them into SystemEntries the way the live applyEvent path
    // does. The reminder text is still stripped from `text` so the user
    // bubble doesn't surface the wrapper — exactly the goal — and a
    // follow-up `resyncFromDisk` will mint the system-reminder pills via
    // the live path if the same record shows up in the active replay
    // window.
    const { text, images } = extractUserContent(content);
    // SDK 0.3.205 — same peer-origin preference as the live applyEvent
    // path: the decoded `body` is byte-exact with what the model saw, so
    // prefer it over our own re-parsed `text` when present.
    const peerOrigin = extractPeerOrigin(r);
    const displayText = peerOrigin?.body ?? text;
    out.push({
      uuid,
      role: "user",
      blocks: displayText ? [{ kind: "text", text: displayText }] : [],
      ...(images.length ? { images } : {}),
      ...(Number.isFinite(parsedTs) ? { createdAt: parsedTs } : {}),
      ...(peerOrigin
        ? { peer: { from: peerOrigin.from, ...(peerOrigin.name ? { name: peerOrigin.name } : {}) } }
        : {}),
    });
  }
  return { messages: out };
}

/**
 * Map a raw SDK `tool_progress` message (snake_case wire shape) to the
 * client's `ToolProgressInfo` (camelCase state shape). Pulled out as a pure
 * function — separate from the `applyEvent` switch it's called from — so
 * the SDK 0.3.214 `subagent_type` / `subagent_retry` field mapping has a
 * unit-testable seam (see `tests/unit/tool-progress-subagent-retry.test.ts`).
 */
export function toolProgressInfoFromSdkMessage(tp: {
  tool_use_id: string;
  tool_name: string;
  elapsed_time_seconds: number;
  parent_tool_use_id: string | null;
  subagent_type?: string;
  subagent_retry?: {
    agent_id: string;
    attempt: number;
    max_retries: number;
    retry_delay_ms: number;
    error_status: number | null;
    error_category: string;
  };
}): ToolProgressInfo {
  return {
    toolUseId: tp.tool_use_id,
    toolName: tp.tool_name,
    elapsedSeconds: tp.elapsed_time_seconds,
    parentToolUseId: tp.parent_tool_use_id,
    subagentType: tp.subagent_type,
    // SDK 0.3.214 — waiting-out-a-retry state for this subagent's tool
    // call. Self-clearing: a later frame without `subagent_retry` naturally
    // drops the badge.
    subagentRetry: tp.subagent_retry
      ? {
          agentId: tp.subagent_retry.agent_id,
          attempt: tp.subagent_retry.attempt,
          maxRetries: tp.subagent_retry.max_retries,
          retryDelayMs: tp.subagent_retry.retry_delay_ms,
          errorStatus: tp.subagent_retry.error_status,
          errorCategory: tp.subagent_retry.error_category,
        }
      : undefined,
  };
}

/**
 * Fold one SDK split (a single `SDKAssistantMessage`, carrying one content
 * block) into the bubble identified by `messageId`. See the comment on
 * `DisplayMessage.uuid` for why we coalesce by `message.id`.
 *
 * `hasStreamScratch` indicates that `stream_event` partials are driving block
 * assembly for this `message.id`. We used to early-return in that case on the
 * theory that the terminal's content was already represented in scratch — but
 * that assumption breaks when an Anthropic message contains a `server_tool_use`
 * (e.g. the advisor / web_search server tool). The SDK can resume the message
 * after the server tool with content blocks that arrive ONLY as terminal
 * `SDKAssistantMessage` splits — no `content_block_*` partials — so scratch
 * never sees them. The previous early-return then silently dropped every
 * post-server-tool block on the live wire; only a page refresh (which paints
 * from the replay buffer instead) surfaced them.
 *
 * Fix: always run a dedupe-and-append pass. Match `tool_use` by id (as the
 * pre-existing replay path did) and `text` / `thinking` by exact content
 * equality against existing same-kind blocks. Blocks scratch already
 * produced (via `buildMerged`) will match and be skipped; blocks scratch
 * never saw will append.
 */
export function upsertAssistantSplit(
  prev: DisplayMessage[],
  messageId: string,
  sdkUuid: string,
  newBlocks: DisplayBlock[],
  hasStreamScratch: boolean,
  parentToolUseId?: string | null,
  /** Server-stamped epoch ms for this SDK envelope (cf. `ServerEvent.sdk.at`). */
  at?: number,
  /**
   * Set when this split is a hard rate-limit hit, so the bubble renders the
   * inline `RateLimitHitPanel`. Sticky across splits — once any split marks the
   * bubble, a later (un-tagged) terminal split won't clear it.
   */
  rateLimitHit?: DisplayMessage["rateLimitHit"],
  /**
   * Set when this split is the Opus-4 high-demand banner, so the bubble
   * renders the inline `OpusHighDemandPanel`. Sticky like `rateLimitHit`.
   */
  opusHighDemand?: boolean,
  /**
   * SDK 0.3.214 — set when this split's `SDKAssistantMessage.aborted` is
   * true (interrupt truncated the stream mid-turn). Sticky like
   * `opusHighDemand` — once any split of a message is tagged aborted, the
   * merged bubble stays tagged even if a later split (e.g. a replayed
   * terminal event) omits it.
   */
  aborted?: boolean,
): DisplayMessage[] {
  const idx = prev.findIndex((m) => m.uuid === messageId);
  if (idx === -1) {
    return [
      ...prev,
      {
        uuid: messageId,
        role: "assistant",
        blocks: hasStreamScratch ? [] : newBlocks,
        streaming: true,
        foldedSdkUuids: new Set([sdkUuid]),
        ...(parentToolUseId ? { parentToolUseId } : {}),
        ...(typeof at === "number" ? { createdAt: at } : {}),
        ...(rateLimitHit ? { rateLimitHit } : {}),
        ...(opusHighDemand ? { opusHighDemand } : {}),
        ...(aborted ? { aborted } : {}),
      },
    ];
  }
  const existing = prev[idx];
  const folded = existing.foldedSdkUuids ?? new Set<string>();
  if (folded.has(sdkUuid)) {
    // Replay of a split we've already folded — preserve blocks but make sure
    // the streaming flag reflects "still in flight" (SDK reconnect replays
    // the terminal events). The `result` event flips it back to false.
    if (existing.streaming === true) return prev;
    const copy = prev.slice();
    copy[idx] = { ...existing, streaming: true };
    return copy;
  }
  const nextFolded = new Set(folded);
  nextFolded.add(sdkUuid);
  // Dedupe-and-append. See the function-level comment above for why this runs
  // unconditionally (including when scratch is active) — `server_tool_use`
  // can leave scratch blind to post-advisor blocks that arrive only as
  // terminal splits.
  const existingToolIds = new Set<string>();
  const existingTextContents = new Set<string>();
  const existingThinkingContents = new Set<string>();
  for (const b of existing.blocks) {
    if (b.kind === "tool_use") existingToolIds.add(b.id);
    else if (b.kind === "text") existingTextContents.add(b.text);
    else if (b.kind === "thinking") existingThinkingContents.add(b.text);
  }
  const blocksToAppend: DisplayBlock[] = [];
  for (const b of newBlocks) {
    if (b.kind === "tool_use") {
      if (existingToolIds.has(b.id)) continue;
    } else if (b.kind === "text") {
      // Skip empties — scratch may have an empty placeholder slot whose
      // delta hasn't filled yet, and we don't want to duplicate that as
      // an empty bubble appendix. The next buildMerged will paint the
      // real text into the scratch-owned slot anyway.
      if (b.text === "" || existingTextContents.has(b.text)) continue;
    } else if (b.kind === "thinking") {
      // Dedupe by exact text match only. The earlier "skip on empty text"
      // early-out was inherited from the `text` branch, but it had a
      // different consequence here: it silently dropped thinking blocks
      // from terminal splits whenever the SDK didn't deliver readable
      // body text (adaptive thinking that summarised away to nothing, or
      // a turn where the model entered thinking mode but produced no
      // visible trace). The result was a chat with no thinking envelopes
      // even at verbose, while the right rail still showed the synthetic
      // "Thinking" entries from `content_block_start`. Keep the envelope
      // — `existingThinkingContents.has("")` still dedupes correctly when
      // the scratch path already produced an empty placeholder, so we
      // don't end up with multiple empty pills.
      if (existingThinkingContents.has(b.text)) continue;
    }
    blocksToAppend.push(b);
  }
  // Sticky: keep an earlier split's tag; only adopt this split's if the bubble
  // isn't marked yet, so a late untagged terminal split can't clear it.
  const stickyHit = existing.rateLimitHit ?? rateLimitHit;
  const stickyOpus = existing.opusHighDemand || opusHighDemand;
  const stickyAborted = existing.aborted || aborted;
  const copy = prev.slice();
  copy[idx] = {
    ...existing,
    blocks:
      blocksToAppend.length === 0 ? existing.blocks : [...existing.blocks, ...blocksToAppend],
    foldedSdkUuids: nextFolded,
    streaming: true,
    ...(stickyHit ? { rateLimitHit: stickyHit } : {}),
    ...(stickyOpus ? { opusHighDemand: true } : {}),
    ...(stickyAborted ? { aborted: true } : {}),
  };
  return copy;
}
