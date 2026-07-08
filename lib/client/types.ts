// Display-oriented model derived from the SDK message stream.
import type { PermissionMode } from "@anthropic-ai/claude-agent-sdk";
import type {
  AskAnswer,
  AskUserQuestionEvent,
  AuthFailedNudgeEvent,
  FeedbackSurveyEvent,
  LongContextCreditsNudgeEvent,
  OpusOverloadNudgeEvent,
  PermissionDecision,
  PermissionRequestEvent,
  PlanDecision,
  ServerEvent,
  TokenExpiringNudgeEvent,
} from "@/lib/shared/events";
import type { Tip } from "@/lib/shared/tips";
import type { ApiRetryState } from "@/lib/client/api-retry";

export type DisplayBlock =
  | { kind: "text"; text: string }
  | { kind: "thinking"; text: string; redacted?: boolean }
  | {
      kind: "tool_use";
      id: string;
      name: string;
      input: Record<string, unknown>;
      result?: { content: string; isError?: boolean };
    };

export type DisplayMessage = {
  /**
   * Stable bubble identity. For assistant messages this is the Anthropic
   * `message.id` so all SDK splits of one API response coalesce into one
   * bubble (the SDK emits a separate `SDKAssistantMessage` per content block,
   * each carrying its own wrapper uuid but sharing `message.id`). For user
   * messages — which have no Anthropic id — this is the SDK wrapper uuid.
   */
  uuid: string;
  role: "user" | "assistant";
  blocks: DisplayBlock[];
  /** When true, the message is still being streamed (deltas may keep arriving). */
  streaming?: boolean;
  /** Set when the message belongs to a subagent (Task tool_use_id). */
  parentToolUseId?: string | null;
  /**
   * SDK wrapper uuids whose content has been folded into this bubble. Used to
   * dedupe replays of the same split (same wrapper uuid arriving twice over
   * SSE) and to resolve search hits / jumps that carry a wrapper uuid back to
   * the merged bubble identity above.
   */
  foldedSdkUuids?: Set<string>;
  /**
   * Image attachments referenced by `[Image #N]` tokens in the text blocks.
   * Optimistically captured for user messages so the bubble inlines thumbnails.
   */
  images?: AttachedImage[];
  /**
   * Epoch ms when the message was first observed. Sourced from the server's
   * `sdk` event envelope (`evt.at`) — for live messages this is the receive
   * time at the broadcast funnel; for messages replayed from disk it's the
   * SDK's original `timestamp` parsed from the JSONL record. Absent when the
   * source provided no time (e.g. older assistant entries from `loadOlder`).
   */
  createdAt?: number;
  /**
   * Present when this assistant message IS a hard rate-limit hit — the SDK's
   * "You've hit your <tier> · resets …" wall. Drives the inline
   * `RateLimitHitPanel` (Claude Code CLI `/rate-limit-options` parity:
   * countdown + upgrade links). Set by every transcript builder — live stream,
   * resumed-session replay, paginated scrollback — so the panel renders on all
   * paths. `resetsAt` is epoch **seconds**; absent on replay/pagination (the
   * structured `rate_limit_event` payload doesn't survive those paths), where
   * the reset time already printed in the message text still tells the user
   * when the window reopens.
   */
  rateLimitHit?: {
    rateLimitType?: "five_hour" | "seven_day" | "seven_day_opus" | "seven_day_sonnet" | "seven_day_overage_included" | "overage";
    resetsAt?: number;
    /**
     * Configured `fallbackModel` for the session (SDK Options.fallbackModel),
     * forwarded from `SessionReadyEvent`. Drives the "Now using <fallback>"
     * takeover line on the panel when the rejection is per-model
     * (`seven_day_opus` / `seven_day_sonnet`) — the SDK silently swaps to
     * this model for the next turn and the line tells the user why. Absent
     * on the replay/pagination paths (we don't have the session config there)
     * — same graceful-degradation pattern as `resetsAt` above.
     */
    fallbackModel?: string;
    /**
     * SDK 0.3.181 — forwarded from `SDKRateLimitInfo.errorCode` when the
     * hard-stop is a credits-required block rather than a plan-tier limit.
     * Drives a "Buy credits" CTA in `RateLimitHitPanel` instead of the
     * standard "Upgrade your plan" links.
     */
    errorCode?: "credits_required";
    /** True when the user is eligible to purchase credits to lift the block. */
    canUserPurchaseCredits?: boolean;
    /** True when the user already has a payment method saved. */
    hasChargeableSavedPaymentMethod?: boolean;
  };
  /**
   * Present when this assistant message IS the Anthropic backend's
   * Opus-4 high-demand banner — the literal CLI strings "We are experiencing
   * high demand for Opus 4." / "...use /model to switch to ... and continue
   * coding." Drives the inline `OpusHighDemandPanel` (Claude Code TUI parity).
   * Distinct from the generic 529 overload streak (see
   * `OpusOverloadNudgePanel` in feature 10): this one fires off the
   * backend-emitted prose, no streak counter, no SSE.
   *
   * Prose-only signal — set by every transcript builder (live stream,
   * resumed-session replay, paginated scrollback) so the panel renders on
   * all paths.
   */
  opusHighDemand?: boolean;
  /**
   * Provenance when this user-role turn was authored by another Claude Code
   * session (the `SendMessage` tool, cross-session Remote Control) rather
   * than typed by the human at the keyboard. Sourced from the SDK's
   * `origin` field (`kind: "peer"`) on `SDKUserMessage` — `from` is the
   * addressable session id, `name` is the sender's harness-normalized
   * display name (SDK 0.3.205; absent on older senders/CLIs, in which case
   * the bubble falls back to showing `from`). Renders a "From <name>" badge
   * in `UserMessage` so peer-authored turns read as reported speech instead
   * of blending into the user's own words. Set by every transcript builder
   * (live stream, resumed-session replay, paginated scrollback).
   */
  peer?: { from: string; name?: string };
};

export type TaskStatus = "pending" | "running" | "completed" | "failed" | "killed" | "stopped";

export type TaskInfo = {
  taskId: string;
  toolUseId?: string;
  description: string;
  taskType?: string;
  workflowName?: string;
  status: TaskStatus;
  isBackgrounded?: boolean;
  /**
   * Client-stamped wall-clock start (epoch ms), set when the task first
   * appears (provisional launch ack or `task_started`). Drives the 1Hz
   * ticking "elapsed" timer in the rail — the SDK's `durationMs` is a
   * periodic snapshot, so a live wall-clock counter is what makes a
   * long-running, idle-turn task visibly "alive" (parity with the
   * background-shell box).
   */
  startedAt?: number;
  /**
   * True for a placeholder row created the instant a background launcher
   * (e.g. the Workflow tool) returns its "started, here's the runId" ack,
   * before the SDK's own `task_started` arrives. Keyed by tool_use_id and
   * replaced by the real `task_started` entry. Closes the dead-zone where a
   * backgrounded workflow is alive but has no rail signal yet.
   */
  provisional?: boolean;
  totalTokens?: number;
  toolUses?: number;
  durationMs?: number;
  lastToolName?: string;
  summary?: string;
  error?: string;
};

export type SystemEntry = {
  uuid: string;
  // Anchored after this assistant/user message (or "" for top-of-thread).
  afterMessageUuid: string;
  kind:
    | "init"
    | "hook_started"
    | "hook_response"
    | "status"
    | "compact_boundary"
    | "rate_limit"
    | "api_retry"
    | "permission_denied"
    | "model_fallback"
    | "system_reminder"
    | "info";
  label: string;
  detail?: string;
  ts?: string;
  /**
   * Number of consecutive identical emissions collapsed onto this pill. Only
   * set (and rendered as a `×N` badge) for the transient `init` / `status`
   * kinds, which the SDK re-emits many times in a row during an API-retry /
   * opus-overload storm. Absent (treated as 1) for a normal single emission.
   * See `appendCoalescedSystemEntry` in `lib/client/use-session.ts`.
   */
  count?: number;
  /**
   * Structured rate-limit payload. Only present (and used) when
   * `kind === "rate_limit"` — mirrors the SDK's `SDKRateLimitInfo` so the
   * pill can render a live countdown and surface overage / billing
   * status instead of stringifying it into `label`.
   *
   * Note on units: `resetsAt` and `overageResetsAt` are **epoch seconds**
   * (the Claude Code CLI computes `resetsAt - Date.now()/1000`), not ms.
   */
  rateLimit?: {
    status?: "allowed" | "allowed_warning" | "rejected";
    rateLimitType?: "five_hour" | "seven_day" | "seven_day_opus" | "seven_day_sonnet" | "seven_day_overage_included" | "overage";
    resetsAt?: number;
    utilization?: number;
    overageStatus?: "allowed" | "allowed_warning" | "rejected";
    overageResetsAt?: number;
    overageDisabledReason?: string;
    isUsingOverage?: boolean;
    surpassedThreshold?: number;
    /**
     * SDK 0.3.181 — present when the rejection is specifically because the
     * account lacks purchased credits (distinct from a plan-tier limit or overage cap).
     * Drives a "buy credits" CTA in RateLimitPill instead of the standard upgrade links.
     */
    errorCode?: "credits_required";
    /** True when the user is eligible to purchase credits to lift the block. */
    canUserPurchaseCredits?: boolean;
    /** True when the user already has a payment method saved, enabling a one-click buy. */
    hasChargeableSavedPaymentMethod?: boolean;
  };
  /**
   * Compaction stats + summary, only present on `kind === "compact_boundary"`.
   * Sourced from the SDK's `compact_metadata` (token deltas, duration, trigger)
   * and the synthesized "continued from a previous conversation…" summary
   * record — the same data the CLI shows on a `/compact` (the summary is what
   * its `ctrl+o` expands). The two arrive as separate records and are merged
   * onto one divider entry by anchor.
   */
  compactStats?: {
    preTokens?: number;
    postTokens?: number;
    durationMs?: number;
    trigger?: string;
  };
  compactSummary?: string;
  /**
   * Body text of a cross-turn `<system-reminder>` block the server
   * prepended to the user's SDK input (e.g. the every-turn `todos-current`
   * nudge, stale-todowrite, plan-mode-reentry — see
   * `lib/server/system-reminders.ts`). Only present (and used) when
   * `kind === "system_reminder"`. The pill renders a one-line collapsed
   * "System reminder" with a ▸ expand that reveals this body, so the
   * injection is visible-but-tidy instead of leaking into the user bubble.
   */
  reminderBody?: string;
  /**
   * `kind === "hook_response"` only. True when the hook's `outcome` was
   * `"error"` or `"cancelled"` (e.g. a `SessionStart`/`Setup`/`SubagentStart`
   * hook that exited 2) — used to give the pill an error tone instead of the
   * default informational one.
   */
  hookFailed?: boolean;
  /**
   * `kind === "hook_response"` only, present when `hookFailed` and the SDK's
   * `hook_response` message carried a non-empty `stderr`. CC 2.1.199 stopped
   * silently swallowing this on hooks that exit 2 — we mirror that by
   * surfacing it here instead of dropping the field on the floor.
   */
  hookStderr?: string;
};

export type ToolProgressInfo = {
  toolUseId: string;
  toolName: string;
  elapsedSeconds: number;
  parentToolUseId?: string | null;
};

export type QueuedMessage = {
  /**
   * Server-side uuid (or client-minted uuid the server adopted). Stable from
   * the moment a message lands in the queue through to the eventual `sendInput`
   * broadcast — so the JSONL message, the provenance DB rows, and the inbox
   * notifications all use this same id. Field name kept as `id` for back-compat
   * with the `QueueIndicator` component.
   */
  id: string;
  text: string;
  /**
   * True when the queued entry carries one or more image attachments. The raw
   * base64 blobs stay server-side — they're not shipped on every `queue:updated`
   * SSE snapshot (multi-MB blobs × N reorders would crush the wire). The
   * composer's "Edit" action fetches them back via the DELETE-and-return
   * endpoint on demand.
   */
  hasImages?: boolean;
  /**
   * When true, this queued entry is an SDK-handled slash command (e.g.
   * `/compact`). The server's drain forwards it with `slash: true` so the
   * synthetic `slash_invoked` system pill is emitted in place of a user-message
   * echo.
   */
  slash?: boolean;
  /**
   * When true, this queued entry originated from a clicked suggestion chip. The
   * server persisted provenance at enqueue time (keyed by `id`) so the eventual
   * bubble is badged as auto-suggested.
   */
  fromSuggestion?: boolean;
  /**
   * When true, this queued entry was submitted as the session goal. The server
   * persisted provenance at enqueue time so the eventual bubble is badged as a
   * goal.
   */
  fromGoal?: boolean;
};

export type SessionInfo = {
  id: string;
  cwd?: string;
  model?: string;
  /** Custom title set by the user. Null when none. */
  title?: string | null;
  /**
   * Last-modified timestamp (ms since epoch) from the on-disk JSONL. Present
   * for entries sourced from `/api/sessions/all`; absent for live-only
   * sessions that haven't been flushed yet. Used to sort the SessionPicker
   * dropdown by recency.
   */
  lastModified?: number;
  /**
   * Epoch ms when the server-side Session object was constructed. Populated
   * for all in-memory sessions by `/api/sessions`. Used to generate a readable
   * fallback label ("Today at 2:15 PM") in the tab strip for sessions that
   * have no user-set or SDK-derived title yet — computed at display time and
   * never persisted, so it does not clobber the SDK's aiTitle.
   */
  createdAt?: number;
  /**
   * Coarse session state for the tabs strip. Only present for sessions
   * currently held in memory by the server (returned from `/api/sessions`);
   * absent for disk-only entries. Disk-only sessions render as `background`
   * in the tab strip regardless.
   */
  status?: "running" | "idle";
};

export type PendingPlan = {
  /** Server-minted id used to resolve the SDK's canUseTool promise. */
  requestId: string;
  toolUseId: string;
  plan: string;
  /** Pulled from tool_use input if present (some agents pass extra metadata). */
  raw?: Record<string, unknown>;
};

/** A todo line as the agent reports it via the TodoWrite tool. */
export type AgentTodo = {
  /** Stable id from the agent (string or number), or synthesized from content. */
  id: string;
  content: string;
  status: "pending" | "in_progress" | "completed" | string;
  activeForm?: string;
};

/** A recent file edit recorded from Edit / MultiEdit / Write tool_use events. */
export type RecentEdit = {
  toolUseId: string;
  /** "Edit" | "MultiEdit" | "Write" */
  toolName: string;
  filePath: string;
  /** ms since epoch when the tool_use was first observed. */
  startedAt: number;
  /** When set, the tool_result has landed. */
  done?: boolean;
  isError?: boolean;
};

/**
 * One tool_use observed in the session, plus completion status once the
 * matching tool_result lands. Powers the "Tools" section of the activity rail.
 */
export type ToolHistoryEntry = {
  toolUseId: string;
  toolName: string;
  /** Best-effort one-line summary of the tool's input (file path, command, etc.). */
  primaryArg?: string;
  /** ms since epoch when the tool_use was first observed. */
  startedAt: number;
  /** ms since epoch when the matching tool_result landed. */
  endedAt?: number;
  done?: boolean;
  isError?: boolean;
  /** Set when the tool was invoked by a subagent. */
  parentToolUseId?: string | null;
  /**
   * Distinguishes synthetic activity rows from real tool invocations.
   * `"thinking"` rows come from the SDK's `thinking` content blocks
   * (no `tool_use_id` — `toolUseId` is a synthetic `thinking:<msgId>:<idx>`
   * key) and render with a brain icon in BackgroundTasksPanel so the user
   * can see thinking phases that don't open any tool. Defaults to `"tool"`.
   */
  kind?: "tool" | "thinking";
  /**
   * Live thinking-token estimate from `SDKThinkingTokensMessage` events.
   * Set while the thinking block is in-flight (only during the
   * redacted-thinking streaming phase); cleared on `message_stop`.
   * Approximate — not the authoritative billed output_tokens.
   */
  estimatedThinkingTokens?: number;
};

/** A backgrounded bash shell tracked from Bash(run_in_background=true). */
export type BackgroundBash = {
  toolUseId: string;
  /** SDK-side shell id, parsed from the launching Bash tool_result. */
  bashId?: string;
  command: string;
  startedAt: number;
  killed?: boolean;
};

/**
 * A scheduled loop/wake-up created by the agent SDK's harness-provided
 * scheduling tools (`CronCreate` and `ScheduleWakeup`). These crons live
 * inside the Claude session (not in Claudius's own `/schedule` system) and
 * die when the session exits — there's no server-side persistence we can
 * query. We reconstruct visibility by listening to tool_use / tool_result
 * events flowing through the session and surfacing them in the Activity
 * rail so the user can see what's armed without having to scroll back to
 * the inline assistant message.
 */
export type ScheduledLoop = {
  /** Tool kind that armed this loop. */
  kind: "cron" | "wakeup";
  /**
   * Stable id used for cancellation:
   * - For `cron`: the job id returned by CronCreate (e.g. `"1545ddb6"`).
   * - For `wakeup`: the tool_use_id of the ScheduleWakeup call (no real
   *   handle exists — wake-ups are fire-and-forget).
   */
  id: string;
  /** tool_use_id of the call that created this entry. Used to track results. */
  toolUseId: string;
  /** Cron expression (cron kind) — `null` for wake-ups. */
  cron: string | null;
  /** Human-readable schedule from the tool_result (`humanSchedule`) — e.g. "Every minute". */
  humanSchedule: string | null;
  /** Delay until next fire, seconds (wakeup kind only). */
  delaySeconds: number | null;
  /** Original prompt the agent scheduled. */
  prompt: string;
  /** Wake-up reason (wakeup kind only — explanation the agent gave for the cadence). */
  reason?: string;
  /** Whether the cron repeats. Wake-ups are always one-shot. */
  recurring: boolean;
  /** True when CronCreate marked this durable (survives session exit). */
  durable: boolean;
  /** ms since epoch when the schedule was armed. */
  startedAt: number;
  /** True once the agent has been asked to cancel via CronDelete. */
  cancelled?: boolean;
};

export type SessionUsage = {
  totalCostUsd: number;
  numTurns: number;
  durationMs: number;
  durationApiMs: number;
  inputTokens: number;
  outputTokens: number;
  cacheReadInputTokens: number;
  cacheCreationInputTokens: number;
  /** Per-model breakdown if available. */
  modelUsage?: Record<string, unknown>;
};

/**
 * One utilization window from the claude.ai plan rate-limit response.
 * Fields may be null when the backend cannot determine the value.
 */
export type PlanUsageWindow = {
  utilization: number | null;
  resetsAt: string | null;
};

/**
 * Structured plan-level usage data from
 * `Query.usage_EXPERIMENTAL_MAY_CHANGE_DO_NOT_RELY_ON_THIS_API_YET()`.
 *
 * `subscriptionType` is "pro" | "max" | "team" | "enterprise" | null (null for
 * API-key / Bedrock / Vertex sessions). When `rateLimitsAvailable` is false,
 * `rateLimits` is null (non-claude.ai session).
 *
 * EXPERIMENTAL: the underlying SDK API may change shape in any release.
 */
export type PlanRateLimits = {
  subscriptionType: string | null;
  rateLimitsAvailable: boolean;
  rateLimits: {
    fiveHour?: PlanUsageWindow | null;
    sevenDay?: PlanUsageWindow | null;
    sevenDayOauthApps?: PlanUsageWindow | null;
    sevenDayOpus?: PlanUsageWindow | null;
    sevenDaySonnet?: PlanUsageWindow | null;
  } | null;
  /**
   * Per-model weekly windows from the server limits[] array, filtered by the
   * overage-included-models allowlist. Additive — present only when the server
   * emits them. Each entry carries a server-supplied `displayName` (e.g.
   * "Fable") for labeling the usage bar in CostOverlay.
   */
  modelScoped?: Array<{ displayName: string; utilization: number | null; resetsAt: string | null }>;
};

/**
 * Per-session goal state surfaced in the GoalBanner. Mirrors the server's
 * `goal_changed` event. Null in {@link ChatState.goal} means no goal is set
 * (banner hidden); `achieved` is sticky until the goal is cleared or replaced.
 */
export type GoalState = {
  text: string;
  achieved: boolean;
  summary: string | null;
  setAt: number | null;
  achievedAt: number | null;
};

export type ChatState = {
  sessionId: string | null;
  ready: boolean;
  pending: boolean;
  /**
   * True when another browser/tab holds the write lock for this session.
   * The input is disabled and a banner is shown. The user can call
   * `takeOver()` to reclaim the lock from whatever tab currently holds it.
   */
  readOnly: boolean;
  messages: DisplayMessage[];
  systemEntries: SystemEntry[];
  toolProgress: Record<string, ToolProgressInfo>;
  queue: QueuedMessage[];
  pendingPermission: PermissionRequestEvent | null;
  errors: string[];
  slashCommands: string[];
  agents: string[];
  /**
   * Main-thread agent name this session runs as (SDK Options.agent), or null
   * for the default agent. From the `ready` event. Shown in the StatusLine.
   */
  mainAgent: string | null;
  permissionMode: PermissionMode;
  model: string | null;
  /**
   * Currently selected reasoning effort. Optimistic — the SDK doesn't emit
   * a `effort_changed` event analogous to `model_changed`, so this mirrors
   * the last value the user picked through the model picker. Defaults to
   * `"auto"` (adaptive thinking) on fresh sessions.
   */
  effort: "low" | "medium" | "high" | "xhigh" | "max" | "auto";
  /**
   * Whether "ultracode" (Dynamic Workflows) is enabled for the session —
   * Opus 4.8's xhigh-effort + parallel-subagent orchestration mode.
   * Optimistic, same as `effort`: the SDK emits no event for it, so this
   * mirrors the last toggle and resets to `false` on a fresh session.
   */
  ultracode: boolean;
  /**
   * User-selected fast-mode intent — the last toggle the user made through the
   * picker. Optimistic, same as `ultracode`/`effort`: the SDK emits no event
   * for the toggle, so this mirrors the last pick and resets to `false` on a
   * fresh session. Distinct from `fastModeState` below, which is the
   * SDK-reported runtime status (`off`/`cooldown`/`on`).
   */
  fastMode: boolean;
  /**
   * Per-session "Advisor" pick — the SDK escalates here for stronger judgment
   * mid-turn (`Settings.advisorModel`). Optimistic, same as `ultracode`/`effort`:
   * the SDK emits no event for this either, so we mirror the last pick and
   * reset to `null` on a fresh session. `null` here only means "no per-session
   * override"; the actual value the SDK uses still falls back to whatever
   * `settings.json` carries (forwarded once at session start in
   * `lib/server/session.ts`).
   */
  advisorModel: string | null;
  sessions: SessionInfo[];
  skills: string[];
  cwd: string | null;
  /**
   * The agent's *effective* working directory, tracked live from the SDK's
   * CwdChanged hook. Differs from `cwd` (the session root) when Claude Code
   * moves into a git worktree to isolate work; the StatusLine paints a
   * "worktree" badge whenever `agentCwd && agentCwd !== cwd`. Becomes === cwd
   * again (badge self-clears) when the agent returns to the root.
   */
  agentCwd: string | null;
  usage: SessionUsage | null;
  /**
   * Plan-level rate-limit utilization from
   * `Query.usage_EXPERIMENTAL_MAY_CHANGE_DO_NOT_RELY_ON_THIS_API_YET()`.
   * Updated at each successful turn end. Null until the first successful turn
   * or when the SDK call fails / is unavailable (non-fatal — cost data from
   * `usage` is unaffected). Shows subscription type and per-window utilization
   * in the "Session cost & usage" overlay.
   */
  planUsage: PlanRateLimits | null;
  /** All tasks ever started in this session, keyed by task_id. */
  tasks: Record<string, TaskInfo>;
  /**
   * Authoritative set of live background-task ids from the SDK's
   * `background_tasks_changed` message (0.3.203), or `null` when no snapshot has
   * been received (gate inactive). REPLACE semantics; ids only. Consumed as a
   * liveness gate to drop stranded "running" rows — never merged into `tasks`.
   */
  liveBackgroundTaskIds: Set<string> | null;
  /** Subagent messages keyed by their parent_tool_use_id. */
  subagentMessages: Record<string, DisplayMessage[]>;
  pendingPlan: PendingPlan | null;
  fastModeState: "off" | "cooldown" | "on" | null;
  /**
   * Transient transition toast for fast-mode edges (entered cooldown /
   * recovered to on). Mirrors the Claude Code TUI's "Fast mode … is
   * temporarily unavailable" + "Fast limit reset" toasts. Reason
   * differentiation ("overloaded" vs "limit reached") and the live "resets
   * in <time>" countdown are intentionally omitted — the SDK exposes neither
   * a fast-mode reason nor a fast-mode reset timestamp.
   */
  fastModeNotice: { uuid: string; kind: "cooldown" | "recovered" } | null;
  /**
   * Transient toast for a rejected `/model` switch. Mirrors the Claude Code
   * TUI's "Remote session couldn't switch to <model>" notice (PARTIAL — no
   * remote/teleport concept exists in Claudius; this is the local analogue
   * surfacing an SDK `setModel` rejection that `lib/server/session.ts`
   * previously swallowed). `attempted` carries the model the user picked,
   * not the one currently active.
   */
  modelSwitchNotice: {
    uuid: string;
    attempted: string | null;
    error: string;
  } | null;
  /**
   * Transient toast shown when the user switches model via the `/model` slash
   * command typed in the chat. Mirrors the Claude Code TUI's help text:
   * "Your pick becomes the default for new sessions."
   */
  chatCommandModelNotice: {
    /** Stable across re-renders of the same notice; bumped per switch. */
    uuid: string;
    /** Full model id emitted by the SDK (e.g. "claude-fable-5"). */
    model: string;
  } | null;
  /**
   * Transient toast shown when the server automatically disabled the advisor
   * because the user switched to a model incompatible with the active advisor
   * tool. Carries the previous advisor id so the "Re-enable" button can
   * restore it in one click without another round-trip to read settings.
   */
  advisorDisabledNotice: {
    uuid: string;
    /** The advisor model id that was cleared (e.g. "claude-opus-4-8"). */
    previousAdvisor: string;
    /** The new main-thread model that triggered the disable. */
    newModel: string | undefined;
  } | null;
  promptSuggestions: string[];
  /**
   * Uuids of user messages that originated from a clicked suggestion chip.
   * Seeded from the DB on session bind and added to optimistically on send;
   * the chat overlays an auto-suggested badge on matching bubbles.
   */
  suggestedUuids: Set<string>;
  /**
   * Uuids of user messages submitted as the session goal. Seeded from the DB
   * on session bind and added to optimistically on send; the chat overlays a
   * "Goal" badge on matching bubbles.
   */
  goalUuids: Set<string>;
  /** True until the SSE replay window finishes (initial render only). */
  replaying: boolean;
  /** True if older history exists above what's currently loaded. */
  hasMoreAbove: boolean;
  /** True while a loadOlder() request is in flight. */
  loadingOlder: boolean;
  /** Latest payload from a TodoWrite tool_use — the agent's current task list. */
  latestTodos: AgentTodo[];
  /**
   * Server-derived staleness flag for `latestTodos`: true when the model has
   * open items but hasn't touched the list for several turns / many mid-turn
   * tool calls. The UI dims the banner + shows a "stale" badge so a frozen
   * "0/N" stops reading as live truth. Reset on model re-engagement or clear.
   */
  todosStale: boolean;
  /**
   * Transient toast payload set when the server auto-clears the to-do
   * snapshot (stale 24h sweep or all-completed turn-end). `null` when no
   * toast should be showing. `id` is a stable counter that retriggers
   * the toast component's fade-out timer on back-to-back fires.
   *
   * NOT set for manual user clears — the user already knows what they
   * just did, so a toast would be noise.
   */
  todosAutoCleared:
    | { id: number; reason: "stale" | "completed"; count: number }
    | null;
  /** Capped log of recent edits (Edit/MultiEdit/Write). Newest first; max 20. */
  recentEdits: RecentEdit[];
  /** Active background bash shells, keyed by tool_use_id. */
  backgroundBashes: Record<string, BackgroundBash>;
  /**
   * Scheduled loops the agent has armed in this session (CronCreate +
   * ScheduleWakeup). Keyed by the loop's stable id (cron id for crons,
   * tool_use_id for one-shot wake-ups). Lives in client state only — these
   * are session-scoped to the agent runtime and die when the session ends.
   */
  scheduledLoops: Record<string, ScheduledLoop>;
  /** Capped log of tool_use events (newest first; max 100). Includes running and finished tools. */
  toolHistory: ToolHistoryEntry[];
  /** Persisted human-readable session title. Null until set by the user. */
  sessionTitle: string | null;
  /**
   * Active session goal (see `/goal`, GoalBanner), or null when none is set.
   * Driven by the server's `goal_changed` event — set on `/goal`, replaced on
   * a new goal, and flipped to `achieved` when the agent calls the in-process
   * `report_goal_achieved` tool.
   */
  goal: GoalState | null;
  /**
   * In-flight AskUserQuestion form from the agent. The browser shows a modal;
   * resolving is `submitAskAnswer(requestId, answers)`.
   */
  pendingAsk: AskUserQuestionEvent | null;
  /**
   * Active CLI-style feedback nudge, set when the server broadcasts a
   * `feedback_survey` after a turn. The browser shows a slim dismissible
   * banner; submitting calls `submitFeedback`, closing calls `dismissFeedback`.
   * Null when no nudge is pending.
   */
  feedbackSurvey: FeedbackSurveyEvent | null;
  /**
   * Active "Opus is experiencing high load — switch to Sonnet" nudge, set
   * when the server broadcasts an `opus_overload_nudge` after a streak of
   * 529 Overloaded errors on Opus. Distinct from the SDK's automatic
   * `fallbackModel` path (which swaps silently). The browser shows a slim
   * dismissible banner; click-through opens the model picker on Sonnet.
   * Null when no nudge is pending.
   */
  opusOverloadNudge: OpusOverloadNudgeEvent | null;
  /**
   * Live retry state derived from the SDK's `api_retry` system message
   * (emitted while a retryable API error — overload, rate limit, server
   * error, connection drop — is being retried with backoff). Drives the
   * "Claude is working…" row's spinner-tip swap (see `describeApiRetry` in
   * `lib/client/api-retry.ts`). Cleared on the next assistant/result message
   * so a resolved turn never leaves a stale "retrying" line behind. Null
   * when no retry is in flight.
   */
  apiRetry: ApiRetryState | null;
  /**
   * Active "Extra usage is required for long context" nudge, set when the
   * server broadcasts a `long_context_credits_required` event after the SDK
   * tags an assistant message with `billing_error` on a 1M-context session.
   * Mirrors the Claude Code TUI's dual-remediation hint: a link to the usage
   * settings page and a one-click switch to the model picker. Null when no
   * nudge is pending.
   */
  longContextCreditsNudge: LongContextCreditsNudgeEvent | null;
  /**
   * Active "Failed to authenticate" nudge, set when the server broadcasts an
   * `auth_failed_required` event after an SDK 401 (structured tag or
   * synthetic "API Error: 401" body, or a thrown auth failure caught in the
   * session consume loop). Mirrors the Claude Code TUI's "Please run /login"
   * hint — the banner links to the accounts section (`/usage#accounts`) so
   * the user can swap their credential without leaving the chat. Null when
   * no nudge is pending.
   */
  authFailedNudge: AuthFailedNudgeEvent | null;
  /**
   * Proactive "your login is about to expire" nudge (CC 2.1.203 parity) —
   * set from the server's `token_expiring_required` event, fired once per
   * session when the active account profile's OAuth token falls within
   * `TOKEN_EXPIRY_WARNING_WINDOW_MS` of expiring. The banner links to
   * `/usage#accounts` so the user can re-authenticate before a background
   * session gets interrupted. Null when no nudge is pending.
   */
  tokenExpiringNudge: TokenExpiringNudgeEvent | null;
  /**
   * Server-driven spinner tips (the `tips` SSE event). The catalog the chat
   * rotates through under the working spinner; empty until the server emits it,
   * at which point the renderer prefers it over its built-in defaults.
   */
  tips: Tip[];
  /**
   * Active "where were we?" recap banner state. Set when the server
   * broadcasts a `session_recap` event after a long blur or a manual /recap
   * invocation; cleared the moment the user sends the next prompt or
   * explicitly dismisses the banner. `status` tracks the request lifecycle so
   * the banner can show a spinner before the text lands and surface a one-
   * liner reason on the sad path.
   */
  sessionRecap: {
    status: "idle" | "loading" | "ready" | "error";
    text: string | null;
    /** Server-stamped epoch ms (only populated when status === "ready"). */
    at: number | null;
    /** How the recap fired — informational, not styled differently today. */
    origin: "away" | "manual" | null;
    /** Reason from a `session_recap_error` event (only on status === "error"). */
    errorReason: string | null;
  };
};

export type AttachedImage = {
  /** Stable per-prompt id (UUID). */
  id: string;
  /** Monotonic ordinal printed in the `[Image #N]` token. Never decrements within a prompt. */
  ordinal: number;
  data: string;
  mediaType: string;
};

/**
 * Loose wire shape for image attachments — the hook fills in id/ordinal when
 * callers (e.g. legacy suggestion chips) don't supply them.
 */
export type SendableImage = Partial<Pick<AttachedImage, "id" | "ordinal">> &
  Pick<AttachedImage, "data" | "mediaType">;

export type ChatActions = {
  /**
   * Forcefully take over the write lock for this session from whichever tab
   * currently holds it. Issues a PATCH to the server so all connected clients
   * — across any browser or context — receive a `holder_changed` SSE event
   * and the caller becomes the new holder.
   */
  takeOver(): Promise<void>;
  send(
    text: string,
    images?: SendableImage[],
    opts?: {
      /**
       * When true, `text` is a registered SDK-handled slash command
       * (e.g. `/compact`). The send path will:
       *   - skip the optimistic user-message render (so the chat doesn't
       *     show `/compact` as if the user typed it),
       *   - post `slash: true` to `/api/sessions/[id]/input` so the server
       *     skips the user-message broadcast and emits a `slash_invoked`
       *     system pill instead.
       * The SDK still receives the text on its input queue and interprets
       * the slash; its eventual response (compact_boundary, init reload,
       * etc.) lands as its own SSE event.
       */
      asSlashCommand?: boolean;
      /**
       * When true, this message came from a clicked "Suggested follow-up"
       * chip. The send path badges the bubble as auto-suggested and posts
       * `fromSuggestion: true` so the server persists its provenance.
       */
      fromSuggestion?: boolean;
      /**
       * When true, this message was submitted as the session goal. The send
       * path badges the bubble as a goal and posts `fromGoal: true` so the
       * server persists its provenance.
       */
      fromGoal?: boolean;
    },
  ): Promise<void>;
  /**
   * Explicitly stage a message in the server-side queue, even if the session
   * is idle. Round-trips to `POST /api/sessions/[id]/input` with
   * `forceQueue: true`; the local `QueueIndicator` paints from the
   * `queue:updated` SSE echo that follows.
   */
  enqueue(text: string, images?: AttachedImage[]): Promise<void>;
  /** Cancel a queued message. Round-trip; the SSE echo reflects the removal. */
  cancelQueued(id: string): Promise<void>;
  /**
   * Pull a queued item back into the composer: round-trips a DELETE that
   * returns the full row (text + images) so the composer can re-edit. Images
   * aren't in the `queue:updated` snapshot — this is the only path that
   * recovers their base64 bytes.
   */
  editQueued(id: string): Promise<{ text: string; images?: AttachedImage[] } | null>;
  /** Move a queued item up (-1) or down (+1) in the queue. Server-side swap. */
  reorderQueued(id: string, dir: -1 | 1): Promise<void>;
  /**
   * Per-message override of the workspace `queueDispatchMode` setting:
   * atomically pop this queued item and push it to the agent immediately,
   * jumping ahead of the other staged items. The SDK runs it as the very
   * next turn, even while the current turn is still in flight.
   */
  sendQueuedNow(id: string): Promise<void>;
  resolvePermission(requestId: string, decision: PermissionDecision): Promise<void>;
  interrupt(): Promise<void>;
  setPermissionMode(mode: PermissionMode): Promise<void>;
  /**
   * Switch the main-thread model. `source` distinguishes the model picker
   * (default) from the `/model` slash command typed in chat — the latter
   * triggers the "your pick becomes the default" notice via the
   * `model_changed` broadcast's `source` field.
   */
  setModel(
    model: string | null,
    source?: "picker" | "chat_command",
  ): Promise<void>;
  /**
   * Set the reasoning/effort level. Routed through the SDK's `/effort`
   * slash command so the change matches the CLI exactly. `auto` re-enables
   * adaptive thinking; the numeric levels lock to a specific budget.
   */
  setEffort(level: "low" | "medium" | "high" | "xhigh" | "max" | "auto"): Promise<void>;
  /**
   * Toggle "ultracode" (Dynamic Workflows) — Opus 4.8's xhigh + parallel-
   * subagent orchestration. Routed through `applyFlagSettings({ ultracode })`
   * server-side. Enabling it also moves the effort mirror to `xhigh`.
   */
  setUltracode(enabled: boolean): Promise<void>;
  /**
   * Toggle "fast mode" — accelerated decoding on supported models (Opus 4.8).
   * Routed through `applyFlagSettings({ fastMode })` server-side. Orthogonal to
   * effort: unlike `setUltracode` it does NOT move the effort mirror.
   */
  setFast(enabled: boolean): Promise<void>;
  /**
   * Set the per-session "Advisor" model — the SDK escalates to this model
   * for stronger judgment mid-turn. Routed through
   * `applyFlagSettings({ advisorModel })` server-side via
   * `POST /api/sessions/[id]/advisor`. Pass `null` to clear the per-session
   * override (the SDK then falls back to whatever `settings.json` carries).
   * Values are constrained to the three product-blessed options listed in
   * `lib/shared/advisor.ts`.
   */
  setAdvisorModel(model: string | null): Promise<void>;
  /**
   * Live-switch the main-thread agent for subsequent turns (SDK 0.3.161+).
   *
   * Calls `POST /api/sessions/[id]/agent` which in turn calls
   * `applyFlagSettings({ agent })` on the SDK Query. Pass `null` to reset
   * to the default general-purpose agent. The `mainAgent` field in
   * `ChatState` is updated optimistically before the network round-trip.
   */
  setAgent(name: string | null): Promise<void>;
  /**
   * Bind to a different session id. Awaits a wake POST so a reaped session
   * has its buffer rehydrated before the SSE subscribes; fire-and-forget
   * callers (every UI tab-click in this codebase) just drop the returned
   * promise.
   */
  switchSession(id: string): Promise<void>;
  createNewSession(): Promise<string | null>;
  /** Open a fresh session in a specific working directory (e.g. a git worktree). */
  createSessionAt(cwd: string): Promise<void>;
  /**
   * Open a fresh session and prefill its composer with `draftText` — does
   * NOT auto-send. Used by the Electron right-click "Start New Chat With
   * Selection" entry (electron/ipc/context-menu.ts) and any future
   * caller that wants to seed the textarea without committing to send.
   *
   * The draft is written to `/api/sessions/${id}/prompt-draft` before the
   * promise resolves, so the composer's per-session draft load picks it
   * up authoritatively — no flicker, no race against the user typing.
   */
  createNewSessionWithDraft(draftText: string): Promise<void>;
  /**
   * Re-pull the merged sessions list from `/api/sessions` +
   * `/api/sessions/all`. Returns the merged list so callers that need to
   * act on the result inline (e.g. the visibility-change handler
   * reconciling the active session's `pending` flag against the server's
   * authoritative status) don't have to race on the next render of the
   * public `sessions` state. Most callers ignore the return value.
   */
  refreshSessions(): Promise<SessionInfo[]>;
  /**
   * Resolve the pending ExitPlanMode prompt. Accept flips the session out of
   * plan mode; reject sends feedback so the model can iterate. Closing the
   * overlay should call this with `{ kind: "reject" }` — without a decision
   * the SDK is left waiting on canUseTool and the agent hangs.
   */
  resolvePlan(decision: PlanDecision): Promise<void>;
  /** Fetch the page of messages older than the current head and prepend them. */
  loadOlder(): Promise<void>;
  /**
   * Paginate older pages until the given uuid is loaded. The argument may be
   * either a bubble's primary uuid (the Anthropic `message.id` for assistants,
   * or wrapper uuid for users) or any SDK wrapper uuid that was folded into a
   * bubble. Returns the bubble's primary uuid on success (use this for
   * highlight/scroll), or null if not found.
   */
  jumpToUuid(uuid: string): Promise<string | null>;
  /** Rename the current session (persists via SDK and broadcasts to the rail). */
  renameTitle(title: string): Promise<{ ok: true } | { ok: false; error: string }>;
  /**
   * Set or replace the session goal. Persists server-side and broadcasts a
   * `goal_changed` event to every open tab. Replacing a goal resets any prior
   * achievement. Returns ok/error so the banner can flash on failure.
   */
  setGoal(text: string): Promise<{ ok: true } | { ok: false; error: string }>;
  /** Clear the session goal (and any achievement). */
  clearGoal(): Promise<{ ok: true } | { ok: false; error: string }>;
  /**
   * Clear the session todos durably. POSTs to
   * `/api/sessions/:id/clear-todos`; the server nulls its snapshot,
   * persists the clear marker, and broadcasts `session_snapshot { todos: [] }`
   * which `applyEvent` collapses to an empty `latestTodos`. Used by the
   * chat-level TodosBanner's "Clear" affordance.
   */
  clearTodos(): Promise<void>;
  /**
   * Mutate a single to-do item — status flip or delete — without going
   * through the model. POSTs to `/api/sessions/:id/todos/:itemId`; the
   * server mutates `latestTodosSnapshot` in place, persists a
   * `manualTodoOverrides[itemId]` entry for restart durability, and
   * broadcasts `session_snapshot { todos }` which `applyEvent` folds into
   * `latestTodos`. Wired to the clickable status icon (toggle done ↔
   * pending) and × delete button on TodosBanner / TodoList rows.
   *
   * Resolves with `{ok: false, error}` for diagnosable failures (stale
   * list, item id not in current snapshot, network) rather than throwing
   * so the UI can surface the reason; success is `{ok: true}`.
   */
  updateTodoItem(
    itemId: string,
    action: "complete" | "reopen" | "in_progress" | "delete",
  ): Promise<{ ok: true } | { ok: false; error: string }>;
  /** Dismiss the transient auto-clear toast (manual × or fade-out timer). */
  dismissTodosAutoCleared(): void;
  /** Resolve a pending AskUserQuestion form. */
  submitAskAnswer(requestId: string, answers: AskAnswer[]): Promise<void>;
  /**
   * Submit the feedback nudge. Forwards to Anthropic AND persists locally via
   * `POST /api/feedback`; clears the nudge. The result tells the UI whether the
   * Anthropic forward landed (`forwarded`) so it can suggest an alternate share
   * channel when only the local copy was kept (`stored`).
   */
  submitFeedback(input: {
    rating?: "up" | "down";
    comment: string;
  }): Promise<{ ok: boolean; stored: boolean; forwarded: boolean }>;
  /** Dismiss the feedback nudge without submitting. */
  dismissFeedback(): void;
  /** Dismiss the Opus overload nudge banner. Client-side only. */
  dismissOpusOverloadNudge(): void;
  /** Dismiss the long-context credits-required nudge banner. Client-side only. */
  dismissLongContextCreditsNudge(): void;
  /** Dismiss the authentication-failed nudge banner. Client-side only. */
  dismissAuthFailedNudge(): void;
  /** Dismiss the token-expiring-soon nudge banner. Client-side only. */
  dismissTokenExpiringNudge(): void;
  /** Dismiss the transient fast-mode transition toast. Client-side only. */
  dismissFastModeNotice(): void;
  /** Dismiss the transient model-switch-rejected toast. Client-side only. */
  dismissModelSwitchNotice(): void;
  /** Dismiss the transient /model chat-command notice. Client-side only. */
  dismissChatCommandModelNotice(): void;
  /** Dismiss the advisor-auto-disabled notice. Client-side only. */
  dismissAdvisorDisabledNotice(): void;
  /**
   * Re-enable the advisor after it was auto-disabled on a model change.
   * Writes the given model id back to settings.json and applies it at the
   * flag-settings layer for this session. Clears the notice optimistically.
   */
  reEnableAdvisor(advisorModel: string): Promise<void>;
  /**
   * Request a "where were we?" recap for the current session. The actual
   * recap text arrives asynchronously via a `session_recap` SSE event;
   * errors land as `session_recap_error`. `origin` lets the auto-trigger and
   * a manual button distinguish themselves on the wire — defaults to
   * `"manual"` so a hand-built caller doesn't accidentally pose as the
   * automatic path.
   */
  requestRecap(origin?: "away" | "manual"): Promise<void>;
  /** Dismiss the recap banner without erasing the underlying text. Client-side only. */
  dismissRecap(): void;
};

export type ServerEventEnvelope = ServerEvent;
