// Display-oriented model derived from the SDK message stream.
import type { PermissionMode } from "@anthropic-ai/claude-agent-sdk";
import type {
  AskAnswer,
  AskUserQuestionEvent,
  FeedbackSurveyEvent,
  PermissionDecision,
  PermissionRequestEvent,
  PlanDecision,
  ServerEvent,
} from "@/lib/shared/events";
import type { Tip } from "@/lib/shared/tips";

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
    rateLimitType?: "five_hour" | "seven_day" | "seven_day_opus" | "seven_day_sonnet" | "overage";
    resetsAt?: number;
  };
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
    | "info";
  label: string;
  detail?: string;
  ts?: string;
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
    rateLimitType?: "five_hour" | "seven_day" | "seven_day_opus" | "seven_day_sonnet" | "overage";
    resetsAt?: number;
    utilization?: number;
    overageStatus?: "allowed" | "allowed_warning" | "rejected";
    overageResetsAt?: number;
    overageDisabledReason?: string;
    isUsingOverage?: boolean;
    surpassedThreshold?: number;
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
};

export type ToolProgressInfo = {
  toolUseId: string;
  toolName: string;
  elapsedSeconds: number;
  parentToolUseId?: string | null;
};

export type QueuedMessage = {
  id: string;
  text: string;
  /** Image attachments referenced by `[Image #ordinal]` markers in `text`. */
  images?: AttachedImage[];
  /**
   * When true, this queued entry is an SDK-handled slash command (e.g.
   * `/compact`). The flush path forwards it with `slash: true` so the server
   * skips the user-message echo and emits a `slash_invoked` system pill
   * instead.
   */
  slash?: boolean;
  /**
   * When true, this queued entry came from a clicked suggestion chip. The flush
   * path forwards `fromSuggestion: true` so the server records its provenance
   * and the bubble is badged as auto-suggested (see `suggestedUuids`).
   */
  fromSuggestion?: boolean;
  /**
   * When true, this queued entry was submitted as the session goal. The flush
   * path forwards `fromGoal: true` so the server records its provenance and the
   * bubble is badged as a goal (see `goalUuids`).
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
  /** All tasks ever started in this session, keyed by task_id. */
  tasks: Record<string, TaskInfo>;
  /** Subagent messages keyed by their parent_tool_use_id. */
  subagentMessages: Record<string, DisplayMessage[]>;
  pendingPlan: PendingPlan | null;
  fastModeState: "off" | "cooldown" | "on" | null;
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
   * Server-driven spinner tips (the `tips` SSE event). The catalog the chat
   * rotates through under the working spinner; empty until the server emits it,
   * at which point the renderer prefers it over its built-in defaults.
   */
  tips: Tip[];
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
  enqueue(text: string, images?: AttachedImage[]): void;
  cancelQueued(id: string): void;
  /** Pull a queued item back into the input; returns its text and removes it. */
  editQueued(id: string): { text: string; images?: AttachedImage[] } | null;
  /** Move a queued item up (-1) or down (+1) in the queue. */
  reorderQueued(id: string, dir: -1 | 1): void;
  resolvePermission(requestId: string, decision: PermissionDecision): Promise<void>;
  interrupt(): Promise<void>;
  setPermissionMode(mode: PermissionMode): Promise<void>;
  setModel(model: string | null): Promise<void>;
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
   * Bind to a different session id. Awaits a wake POST so a reaped session
   * has its buffer rehydrated before the SSE subscribes; fire-and-forget
   * callers (every UI tab-click in this codebase) just drop the returned
   * promise.
   */
  switchSession(id: string): Promise<void>;
  createNewSession(): Promise<void>;
  /** Open a fresh session in a specific working directory (e.g. a git worktree). */
  createSessionAt(cwd: string): Promise<void>;
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
};

export type ServerEventEnvelope = ServerEvent;
