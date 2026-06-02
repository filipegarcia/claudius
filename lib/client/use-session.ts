"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { usePathname } from "next/navigation";
import type { PermissionMode } from "@anthropic-ai/claude-agent-sdk";
import type {
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
} from "@/lib/shared/events";
import type { Tip } from "@/lib/shared/tips";
import { costFromTokens } from "@/lib/shared/cost-pricing";
import { parseInitSystemMessage } from "@/lib/shared/parse-init";
import {
  isCompactSummaryContent,
  isLocalCommandCaveatContent,
  isSdkInternalEnvelope,
  isSdkSlashUserMessage,
  isSuppressedSystemEvent,
  isSyntheticTaskNotification,
  parseSyntheticCliWrapper,
} from "./sdk-message-filters";
import { stripGoalReminder } from "@/lib/shared/user-prompt";
import { parseWorkflowMeta } from "@/lib/shared/workflow-meta";
import {
  dropProvisionalForToolUse,
  findToolUseBlock,
  isBackgroundedToolUse,
  reconcileTasksOnToolResult,
  seedTaskStatus,
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

// sessionStorage tops out around 5–10 MB per origin in most browsers.
// Cap our serialized queue payload at 5 MB to leave room for everything else.
// Hoisted to module scope so `useCallback` deps can omit it without tripping
// exhaustive-deps.
const QUEUE_MAX_BYTES = 5 * 1024 * 1024;

/**
 * Detect the "hard rate-limit hit" assistant message.
 *
 * The SDK signals a hard limit two different ways depending on path:
 *   • Live  — an `SDKAssistantMessage` with `error: "rate_limit"`.
 *   • Replay — `getSessionMessages` (used to rehydrate a resumed session)
 *     strips both `error` and the preceding `rate_limit_event`s, leaving only
 *     the assistant *text* the CLI rendered: `You've hit your <label> · resets
 *     <time>` (template `You've hit your ${H}` in the CLI bundle).
 *
 * So we match the prose as a fallback. Guarded to a pure-text message whose
 * leading clause is the CLI template — a normal turn that merely mentions
 * limits in passing won't be a standalone "You've hit your … limit" bubble.
 */
const RATE_LIMIT_HIT_TEXT_RE = /^you['’]ve hit your [\w .'-]*\blimit\b/i;

// Exported for unit testing — the regex is the brittle bit (false positives on
// normal prose would wrongly badge a message as a rate-limit wall).
export function isRateLimitHitText(blocks: DisplayBlock[]): boolean {
  if (blocks.length === 0) return false;
  if (!blocks.every((b) => b.kind === "text")) return false;
  const first = blocks.find((b) => b.kind === "text");
  return !!first && RATE_LIMIT_HIT_TEXT_RE.test(first.text.trim());
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
      out.push({ kind: "tool_use", id: tu.id, name: tu.name, input: tu.input ?? {} });
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
} {
  if (typeof content === "string") return { text: stripGoalReminder(content), images: [] };
  if (!Array.isArray(content)) return { text: "", images: [] };
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
  // Strip the Claude-only goal reminder the server prepends (survives in the
  // JSONL, so a resumed-from-disk session would otherwise show it). No-op when
  // absent.
  return { text: stripGoalReminder(text), images };
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

export function useSession(): ChatState & ChatActions {
  const [sessionId, setSessionId] = useState<string | null>(null);
  // Track the committed pathname so the URL writer below can suppress
  // its replaceState when the user has navigated away from the chat
  // page. usePathname re-renders this hook on every Next.js commit, so
  // the effect that watches [sessionId, pathname] sees the new value
  // BEFORE we ever consider writing — which is the whole point of
  // moving the URL write out of bindToSession into an effect.
  const pathname = usePathname();
  const [ready, setReady] = useState(false);
  const [pending, setPending] = useState(false);
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
  // One-shot "Extra usage is required for long context" banner, broadcast by
  // the server when a 1M-context session hits the SDK's `billing_error`.
  // Live-only: skipped in the SSE replay buffer so a stale event never
  // re-pops on reload.
  const [longContextCreditsNudge, setLongContextCreditsNudge] =
    useState<LongContextCreditsNudgeEvent | null>(null);
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
  const [tasks, setTasks] = useState<Record<string, TaskInfo>>({});
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
      pathname === "/" || /^\/wks_[a-f0-9]+\/?$/.test(pathname ?? "");
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
        livePath === "/" || /^\/wks_[a-f0-9]+\/?$/.test(livePath);
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
  // Per-scope (parent_tool_use_id, "" for top-level) → Anthropic message.id
  // currently being streamed. Captured from the inner `message_start` event
  // so subsequent content_block_* partials in the same scope can be anchored
  // on the same identity as the eventual terminal `SDKAssistantMessage`
  // events (which carry `message.id` directly). Cleared on `message_stop`.
  const scopeMessageIdRef = useRef<Map<string, string>>(new Map());
  const flushQueueRef = useRef<() => void>(() => {});
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

  // ── sessionStorage persistence ────────────────────────────────────────
  // Queue lives only for the duration of this tab — explicitly NOT
  // localStorage, because a tab close should drop it.
  const queueKey = (sid: string | null) => (sid ? `claudius.queue.${sid}` : null);

  /**
   * Persist a specific session's queue into sessionStorage. Keyed by the
   * explicit `sid` parameter — NOT `sessionIdRef.current` — because the
   * drain loop in `flushQueue` may write back to the originating session's
   * queue (e.g. restoring a failed send) AFTER the user has switched to a
   * different tab. Using the captured id keeps storage correctly partitioned
   * per session. React state is only updated when `sid` matches the active
   * binding; otherwise we touch only persistent storage so the queue is
   * intact for when the user returns to that session.
   *
   * Trims oldest items when the serialized payload would exceed the
   * QUEUE_MAX_BYTES cap. Surfaces a one-shot "queue too large" error in that
   * case so the user knows we dropped something.
   */
  const persistQueueForSession = useCallback((sid: string, items: QueuedMessage[]) => {
    if (typeof window === "undefined") return;
    const k = queueKey(sid);
    if (!k) return;
    let trimmedDueToSize = false;
    let toWrite = items;
    let serialized = JSON.stringify(toWrite);
    if (serialized.length > QUEUE_MAX_BYTES) {
      const trimmed = items.slice();
      while (trimmed.length > 1 && JSON.stringify(trimmed).length > QUEUE_MAX_BYTES) {
        trimmed.shift();
      }
      if (trimmed.length === 1 && JSON.stringify(trimmed).length > QUEUE_MAX_BYTES) {
        trimmed.length = 0;
      }
      toWrite = trimmed;
      serialized = JSON.stringify(toWrite);
      trimmedDueToSize = true;
      // Only mirror the trim into React state if this is the currently
      // bound session. Otherwise the user is on a different tab; we'd be
      // silently mutating their visible queue.
      if (sid === sessionIdRef.current) {
        queueRef.current = toWrite;
        setQueue([...toWrite]);
      }
    }
    try {
      window.sessionStorage.setItem(k, serialized);
    } catch {
      // Most likely QuotaExceededError — surface as the same kind of warning.
      trimmedDueToSize = true;
    }
    if (trimmedDueToSize) {
      setErrors((e) => {
        const msg = "Queue too large; oldest items removed";
        return e[e.length - 1] === msg ? e : [...e, msg];
      });
    }
  }, []);

  /**
   * Back-compat wrapper that persists the *current* session's queue.
   * Reads `sessionIdRef.current` at call time. Safe for user-driven
   * actions (enqueue, cancel, edit, reorder) because those are synchronous
   * with the active binding.
   */
  const persistQueue = useCallback((sid: string | null) => {
    if (!sid) return;
    persistQueueForSession(sid, queueRef.current);
  }, [persistQueueForSession]);

  const rehydrateQueue = useCallback((sid: string) => {
    if (typeof window === "undefined") return;
    const k = queueKey(sid);
    if (!k) return;
    try {
      const raw = window.sessionStorage.getItem(k);
      if (!raw) {
        queueRef.current = [];
        setQueue([]);
        return;
      }
      const parsed = JSON.parse(raw) as QueuedMessage[];
      if (!Array.isArray(parsed)) return;
      queueRef.current = parsed;
      setQueue([...parsed]);
    } catch {
      // ignore
    }
  }, []);


  const writeQueue = useCallback(
    (next: QueuedMessage[]) => {
      queueRef.current = next;
      setQueue([...next]);
      persistQueue(sessionIdRef.current);
    },
    [persistQueue],
  );

  /**
   * Like `writeQueue`, but parameterised on the target session id. Used by
   * the drain loop in `flushQueue` so reads/writes during a long-running
   * drain always land in the queue that *started* the drain, even if the
   * user switches to a different session mid-flight. React state is only
   * updated when `sid` is the currently bound session, so an in-flight
   * drain that races with a tab switch never bleeds queue items into the
   * incoming session's UI.
   */
  const writeQueueForSession = useCallback(
    (sid: string, next: QueuedMessage[]) => {
      if (sid === sessionIdRef.current) {
        queueRef.current = next;
        setQueue([...next]);
      }
      persistQueueForSession(sid, next);
    },
    [persistQueueForSession],
  );

  /**
   * Read a specific session's queue from sessionStorage WITHOUT touching
   * React state. Used by `flushQueue`'s error-restore path so we can
   * prepend a failed message back to its originating session's queue even
   * when the user has navigated away. Returns null when no entry exists or
   * the JSON is malformed.
   */
  const readQueueFromStorage = useCallback((sid: string): QueuedMessage[] | null => {
    if (typeof window === "undefined") return null;
    const k = queueKey(sid);
    if (!k) return null;
    try {
      const raw = window.sessionStorage.getItem(k);
      if (!raw) return [];
      const parsed = JSON.parse(raw) as QueuedMessage[];
      return Array.isArray(parsed) ? parsed : null;
    } catch {
      return null;
    }
  }, []);

  const setPendingTracked = useCallback((p: boolean) => {
    const wasPending = pendingRef.current;
    pendingRef.current = p;
    setPending(p);
    // Any transition out of pending is a chance to drain the queue.
    if (wasPending && !p) flushQueueRef.current();
  }, []);

  const resetState = useCallback(() => {
    setReady(false);
    setPending(false);
    pendingRef.current = false;
    setMessages([]);
    setSystemEntries([]);
    setToolProgress({});
    // DON'T wipe sessionStorage[claudius.queue.<sessionIdRef.current>]
    // here. resetState runs at the top of switchSession / createSession —
    // i.e. while `sessionIdRef.current` still points at the session the
    // user is *leaving*. Wiping its queue dropped any unsent messages the
    // user had staged there (user-visible bug: "I queued three follow-ups,
    // switched away to check something, came back, and they're gone").
    // The queue is intentionally scoped per-session-id in storage and
    // rehydrated by bindToSession's `rehydrateQueue(newId)`; leaving the
    // outgoing entry alone is exactly the right behavior. React state of
    // the queue still gets cleared below so the outgoing UI doesn't bleed
    // into the incoming view.
    setQueue([]);
    queueRef.current = [];
    setPendingPermission(null);
    pendingPermissionRef.current = null;
    setPendingAsk(null);
    setFeedbackSurvey(null);
    setOpusOverloadNudge(null);
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
    countedUsageRef.current = new Set();
    lastRateLimitInfoRef.current = null;
    estimatedTurnCostRef.current = 0;
    seenResultUuidsRef.current = new Set();
    setTasks({});
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

  /**
   * Single-pass flush: pop the head of the active session's queue, send it
   * to the SDK, and STOP — waiting for the SDK's `result` event to flip
   * pending back to false before the next call (which fires from
   * `setPendingTracked`'s edge logic). This keeps the queue UI behaving
   * like a staging area: while the agent is busy, follow-ups sit visible
   * in the queue strip; each turn's completion peels off exactly one
   * queued message and starts the next turn.
   *
   * Bails when:
   *   - No active session id.
   *   - The SDK is busy (`pendingRef.current`) — the next pending-edge
   *     transition will retrigger us.
   *   - A permission card is open (`pendingPermissionRef.current`) — the
   *     SDK is parked on `canUseTool`; `resolvePermission` retriggers us.
   *   - Queue is empty.
   *
   * Persistence: captures `id` at entry and routes every storage write
   * through `writeQueueForSession(id, …)`. So if the user switches session
   * during the POST and the send then fails, the failed item is restored
   * into the *originating* session's queue, not the incoming one. (The
   * pre-fix flushQueue persisted under `sessionIdRef.current`, which moved
   * during the await.)
   */
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

  const flushQueue = useCallback(async () => {
    const id = sessionIdRef.current;
    if (!id) return;
    if (pendingRef.current) return;
    if (pendingPermissionRef.current) return;
    if (queueRef.current.length === 0) return;

    const next = queueRef.current[0];
    const rest = queueRef.current.slice(1);
    writeQueueForSession(id, rest);
    const uuid = crypto.randomUUID();
    // A queued suggestion keeps its provenance: badge it optimistically and
    // tell the server to persist it. The flush mints its own uuid (above), so
    // this is the id that lands in the JSONL for this message.
    if (next.fromSuggestion) {
      setSuggestedUuids((prev) => new Set(prev).add(uuid));
    }
    if (next.fromGoal) {
      setGoalUuids((prev) => new Set(prev).add(uuid));
    }
    // Same slash-command rule as `send()`: skip the optimistic user-message
    // render so `/compact` doesn't show up as if the user typed it — the
    // server emits a `slash_invoked` system pill instead.
    if (!next.slash) {
      const sentAt = Date.now();
      setMessages((prev) => [
        ...prev,
        {
          uuid,
          role: "user",
          blocks: [{ kind: "text", text: next.text }],
          ...(next.images && next.images.length ? { images: next.images } : {}),
          createdAt: sentAt,
        },
      ]);
    }
    setPendingTracked(true);
    let res: Response;
    try {
      res = await fetch(`/api/sessions/${id}/input`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          text: next.text,
          images: next.images,
          uuid,
          ...(next.slash ? { slash: true } : {}),
          ...(next.fromSuggestion ? { fromSuggestion: true } : {}),
          ...(next.fromGoal ? { fromGoal: true } : {}),
        }),
      });
    } catch (err) {
      // POST failed — restore THIS message into the originating session's
      // queue (prepended). Read storage fresh in case more items landed
      // while the POST was in flight. React state only mirrors the restore
      // when we're still on `id`.
      const currentForId = readQueueFromStorage(id) ?? rest;
      writeQueueForSession(id, [next, ...currentForId]);
      setErrors((e) => [
        ...e,
        `send failed: ${err instanceof Error ? err.message : String(err)}`,
      ]);
      if (sessionIdRef.current === id) setPendingTracked(false);
      return;
    }
    if (!res.ok) {
      const currentForId = readQueueFromStorage(id) ?? rest;
      writeQueueForSession(id, [next, ...currentForId]);
      setErrors((e) => [...e, `send failed: ${res.status}`]);
      if (sessionIdRef.current === id) setPendingTracked(false);
    }
  }, [setPendingTracked, writeQueueForSession, readQueueFromStorage]);
  flushQueueRef.current = () => {
    void flushQueue();
  };

  const applyEvent = useCallback(
    (ev: ServerEvent) => {
      if (ev.type === "ready") {
        setReady(true);
        setMainAgent(ev.agent ?? null);
        fallbackModelRef.current = ev.fallbackModel ?? null;
        return;
      }
      if (ev.type === "error") {
        setErrors((e) => [...e, ev.message]);
        setPendingTracked(false);
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
      if (ev.type === "tips") {
        setTips(ev.tips);
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
        lastAssistantUuidRef.current = messageId;
        setMessages((prev) =>
          upsertAssistantSplit(
            prev,
            messageId,
            sdkUuid,
            blocks,
            hasStreamScratch,
            undefined,
            ev.at,
            rateLimitHit,
            opusHighDemand,
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
          for (const b of existingBlocks) {
            if (b.kind === "tool_use" && b.result) preservedResults.set(b.id, b.result);
          }
          for (const b of merged) {
            if (b.kind === "tool_use" && preservedResults.has(b.id)) b.result = preservedResults.get(b.id);
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
            if (
              cli.kind === "stdout" &&
              /^set\s+model\s+to\s+/i.test(cli.text)
            ) {
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
          const { text, images } = extractUserContent(content);
          if (text || images.length) {
            const uuid = (msg as { uuid?: string }).uuid ?? crypto.randomUUID();
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
                  blocks: text ? [{ kind: "text", text }] : [],
                  ...(images.length ? { images } : {}),
                  ...(typeof ev.at === "number" ? { createdAt: ev.at } : {}),
                },
              ];
            });
          }
        }
        return;
      }

      if (msg.type === "result") {
        setPendingTracked(false);
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
        // out before double-counting cost/turns. Still call flushQueue so
        // the queued-input side-effects fire normally.
        if (r.uuid && seenResultUuidsRef.current.has(r.uuid)) {
          void flushQueue();
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
        void flushQueue();
        return;
      }

      if (msg.type === "tool_progress") {
        const tp = msg as {
          tool_use_id: string;
          tool_name: string;
          elapsed_time_seconds: number;
          parent_tool_use_id: string | null;
        };
        setToolProgress((prev) => ({
          ...prev,
          [tp.tool_use_id]: {
            toolUseId: tp.tool_use_id,
            toolName: tp.tool_name,
            elapsedSeconds: tp.elapsed_time_seconds,
            parentToolUseId: tp.parent_tool_use_id,
          },
        }));
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
          if (init.slashCommands.length) setSlashCommands(init.slashCommands);
          if (init.agents.length) setAgents(init.agents);
          if (init.skills.length) setSkills(init.skills);
          if (init.cwd) setCwd(init.cwd);
          if (init.model) setModelState(init.model);
          if (init.permissionMode) setPermissionModeState(init.permissionMode);
          setSystemEntries((prev) => [
            ...prev,
            {
              ...baseEntry,
              kind: "init",
              label: `Session ready · ${init.model ?? ""}`,
              detail: `${init.tools.length} tools · ${init.slashCommands.length} commands · ${init.agents.length} agents`,
            },
          ]);
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
          const h = sysAny as { hook_name?: string; exit_code?: number; outcome?: string };
          setSystemEntries((prev) => [
            ...prev,
            {
              ...baseEntry,
              kind: "hook_response",
              label: `Hook ${h.hook_name ?? ""} → ${h.outcome ?? "ok"}`,
              detail: typeof h.exit_code === "number" ? `exit ${h.exit_code}` : undefined,
            },
          ]);
          return;
        }
        if (sysAny.subtype === "status") {
          const s = sysAny as { status?: string };
          setSystemEntries((prev) => [
            ...prev,
            { ...baseEntry, kind: "status", label: `Status: ${s.status ?? ""}` },
          ]);
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
        // The SDK emits one of these when the primary model is overloaded or
        // returns model_not_found — the spawned `claude` binary builds the same
        // "Switched to <new> because <old> is not available [due to high demand
        // for <old>]" string the CLI prints. Reuse `content` verbatim so the
        // wording tracks the SDK (it varies by `trigger`: `overloaded` adds the
        // high-demand suffix, `model_not_found` doesn't).
        if (sysAny.subtype === "model_fallback") {
          const f = sysAny as unknown as {
            trigger?: "overloaded" | "model_not_found";
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
            rateLimitType?: "five_hour" | "seven_day" | "seven_day_opus" | "seven_day_sonnet" | "overage";
            resetsAt?: number;
            utilization?: number;
            overageStatus?: "allowed" | "allowed_warning" | "rejected";
            overageResetsAt?: number;
            overageDisabledReason?: string;
            isUsingOverage?: boolean;
            surpassedThreshold?: number;
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
    [flushQueue, refreshSessions, setPendingTracked, reconcileToIdle],
  );

  const bindToSession = useCallback(
    (id: string) => {
      eventSourceRef.current?.close();
      sessionIdRef.current = id;
      setSessionId(id);
      rehydrateQueue(id);
      // No flush trigger here. Rehydrated items stay visible in the
      // QueueIndicator; the normal pending-edge cadence (turn ends →
      // setPendingTracked false → flushQueue) drains them when the SDK
      // returns to idle. If the SDK is *already* idle when the user
      // returns to this session, the items wait for a manual user action
      // — matching the staging-area UX the user reported preferring.
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
      const es = new EventSource(`/api/sessions/${id}/stream?tail=20`);
      eventSourceRef.current = es;
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
    [applyEvent, rehydrateQueue, setPendingTracked],
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
      //    flushQueue, resolvePermission, …) checks `if (!id) return`,
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
        if (!res.ok) throw new Error(`create session failed: ${res.status}`);
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
    await createSession({});
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
      await createSession(text ? { initialDraftText: text } : {});
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
      const created = await createSession(resume ? { resume, resumeSessionAt: at } : {});
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
      // Normalize to AttachedImage shape for client/queue persistence.
      const normalized = hasImages
        ? images!.map((img, i) => ({
            id: img.id ?? crypto.randomUUID(),
            ordinal: typeof img.ordinal === "number" ? img.ordinal : i + 1,
            data: img.data,
            mediaType: img.mediaType,
          }))
        : undefined;
      if (pendingRef.current || pendingPermissionRef.current) {
        const q: QueuedMessage = {
          id: crypto.randomUUID(),
          text,
          ...(normalized ? { images: normalized } : {}),
          ...(isSlash ? { slash: true } : {}),
          ...(fromSuggestion ? { fromSuggestion: true } : {}),
          ...(fromGoal ? { fromGoal: true } : {}),
        };
        writeQueue([...queueRef.current, q]);
        // No flush trigger here — that's intentional. The queue is a
        // staging area: items stay visible in the QueueIndicator strip
        // until the current turn finishes, then `setPendingTracked`'s
        // true→false edge peels off exactly one item and starts the next
        // turn. This is the original "single-pass" cadence; an earlier
        // pipeline-drain version that auto-flushed here turned the queue
        // into "type 3 messages, all 3 land as user bubbles immediately"
        // which lost the staging UX.
        return;
      }
      const uuid = crypto.randomUUID();
      // Slash commands shouldn't render as user messages — the server emits a
      // `slash_invoked` system pill in their place. Skipping the optimistic
      // add here keeps the chat clean even before the SSE pill arrives.
      if (!isSlash) {
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
      // below so it survives reload). Keyed by the same uuid that lands in the
      // JSONL, so the reload-time DB lookup re-marks the same message.
      if (fromSuggestion) {
        setSuggestedUuids((prev) => new Set(prev).add(uuid));
      }
      if (fromGoal) {
        setGoalUuids((prev) => new Set(prev).add(uuid));
      }
      setPromptSuggestions([]);
      setPendingTracked(true);
      setErrors([]);
      const res = await fetch(`/api/sessions/${id}/input`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        // Pass the optimistic uuid so the server's broadcast echoes it back
        // with the same id; applyEvent dedups by uuid so this tab doesn't
        // double-render, while other subscribers pick it up for the first
        // time on SSE replay. For slash commands the server doesn't echo a
        // user message at all — the uuid still rides along as the SDK input
        // id so the JSONL stays consistent.
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
        setPendingTracked(false);
      }
    },
    [setPendingTracked, writeQueue],
  );

  const enqueue = useCallback(
    (text: string, images?: AttachedImage[]) => {
      const trimmed = text.trim();
      if (!trimmed && (!images || images.length === 0)) return;
      const q: QueuedMessage = {
        id: crypto.randomUUID(),
        text: trimmed,
        ...(images && images.length ? { images } : {}),
      };
      writeQueue([...queueRef.current, q]);
      // Intentionally no flush trigger — see comment in `send()`. Items
      // sit in the queue until the next pending-edge transition drains
      // the head.
    },
    [writeQueue],
  );

  const cancelQueued = useCallback(
    (qid: string) => {
      writeQueue(queueRef.current.filter((q) => q.id !== qid));
    },
    [writeQueue],
  );

  const editQueued = useCallback(
    (qid: string): { text: string; images?: AttachedImage[] } | null => {
      const item = queueRef.current.find((q) => q.id === qid);
      if (!item) return null;
      writeQueue(queueRef.current.filter((q) => q.id !== qid));
      return {
        text: item.text,
        ...(item.images && item.images.length ? { images: item.images } : {}),
      };
    },
    [writeQueue],
  );

  const reorderQueued = useCallback(
    (qid: string, dir: -1 | 1) => {
      const idx = queueRef.current.findIndex((q) => q.id === qid);
      if (idx === -1) return;
      const swap = idx + dir;
      if (swap < 0 || swap >= queueRef.current.length) return;
      const next = [...queueRef.current];
      [next[idx], next[swap]] = [next[swap], next[idx]];
      writeQueue(next);
    },
    [writeQueue],
  );

  const resolvePermission = useCallback(async (requestId: string, decision: PermissionDecision) => {
    const id = sessionIdRef.current;
    if (!id) return;
    setPendingPermission(null);
    pendingPermissionRef.current = null;
    const res = await fetch(`/api/sessions/${id}/permission`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ requestId, decision }),
    });
    if (res.ok) flushQueueRef.current();
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

  const dismissFastModeNotice = useCallback(() => {
    setFastModeNotice(null);
  }, []);

  const dismissModelSwitchNotice = useCallback(() => {
    setModelSwitchNotice(null);
  }, []);

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
    await fetch(`/api/sessions/${id}/interrupt`, { method: "POST" });
    setPendingTracked(false);
  }, [setPendingTracked]);

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
      if (!res.ok) return;
      const data = (await res.json()) as {
        messages: Array<Record<string, unknown>>;
        hasMore: boolean;
      };
      const synth = synthesizeOlder(data.messages);
      if (synth.messages.length > 0) {
        setMessages((prev) => {
          const seen = new Set(prev.map((m) => m.uuid));
          const fresh = synth.messages.filter((m) => !seen.has(m.uuid));
          return [...fresh, ...prev];
        });
      }
      setHasMoreAbove(data.hasMore);
    } finally {
      setLoadingOlder(false);
    }
  }, [hasMoreAbove, loadingOlder]);

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

  const setModel = useCallback(async (m: string | null) => {
    const id = sessionIdRef.current;
    if (!id) return;
    setModelState(m);
    try {
      const r = await fetch(`/api/sessions/${id}/model`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ model: m }),
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
    messages: sortedMessages,
    systemEntries,
    toolProgress,
    queue,
    pendingPermission,
    pendingAsk,
    feedbackSurvey,
    opusOverloadNudge,
    longContextCreditsNudge,
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
    sessions,
    skills,
    cwd,
    agentCwd,
    usage,
    tasks,
    subagentMessages,
    pendingPlan,
    fastModeState,
    fastModeNotice,
    modelSwitchNotice,
    promptSuggestions,
    suggestedUuids,
    goalUuids,
    replaying,
    hasMoreAbove,
    loadingOlder,
    latestTodos,
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
    resolvePermission,
    submitAskAnswer,
    submitFeedback,
    dismissFeedback,
    dismissOpusOverloadNudge,
    dismissLongContextCreditsNudge,
    dismissFastModeNotice,
    dismissModelSwitchNotice,
    requestRecap,
    dismissRecap,
    interrupt,
    setPermissionMode,
    setModel,
    setEffort,
    setUltracode,
    setFast,
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
        out.push({
          uuid: msgId,
          role: "assistant",
          blocks: newBlocks,
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
    const { text, images } = extractUserContent(content);
    out.push({
      uuid,
      role: "user",
      blocks: text ? [{ kind: "text", text }] : [],
      ...(images.length ? { images } : {}),
      ...(Number.isFinite(parsedTs) ? { createdAt: parsedTs } : {}),
    });
  }
  return { messages: out };
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
  const copy = prev.slice();
  copy[idx] = {
    ...existing,
    blocks:
      blocksToAppend.length === 0 ? existing.blocks : [...existing.blocks, ...blocksToAppend],
    foldedSdkUuids: nextFolded,
    streaming: true,
    ...(stickyHit ? { rateLimitHit: stickyHit } : {}),
    ...(stickyOpus ? { opusHighDemand: true } : {}),
  };
  return copy;
}
