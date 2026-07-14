// Event envelope sent from server -> browser over SSE.
// Mirrors SDK message types but adds a few synthetic events the UI needs
// (permission_request, error, ready).

import type { SDKMessage, PermissionMode } from "@anthropic-ai/claude-agent-sdk";
import type { Tip } from "./tips";

export type PermissionRequestEvent = {
  type: "permission_request";
  requestId: string;
  toolName: string;
  toolUseId: string;
  input: Record<string, unknown>;
  title?: string;
  description?: string;
  displayName?: string;
  /**
   * Set when the permission request originates from a background subagent
   * rather than the main session thread. Added in SDK 0.3.186: background
   * agents now forward prompts to canUseTool (with this id) instead of
   * auto-denying.
   */
  agentId?: string;
};

export type SessionReadyEvent = {
  type: "ready";
  sessionId: string;
  /**
   * Main-thread agent name (SDK Options.agent) this session was started with,
   * if any. Surfaced here because the SDK's system:init message doesn't carry
   * the main agent; the StatusLine reads it to show "running as <agent>".
   */
  agent?: string;
  /**
   * Configured fallback model id (SDK Options.fallbackModel) this session was
   * started with, if any. Surfaced here because the SDK doesn't echo it in
   * any other event and the client needs it for the per-model weekly-limit
   * takeover toast — when `seven_day_opus` / `seven_day_sonnet` rejects, the
   * `RateLimitHitPanel` appends "Now using <fallback>" so the user knows why
   * the next turn comes back on a different model. Mirrors the `agent` field
   * above (same rationale: SDK init doesn't carry it).
   */
  fallbackModel?: string;
};

export type SessionErrorEvent = {
  type: "error";
  message: string;
};

export type ModeChangedEvent = {
  type: "mode_changed";
  mode: PermissionMode;
};

export type ModelChangedEvent = {
  type: "model_changed";
  model?: string;
  /**
   * Where the switch originated. `"picker"` is the default (model dropdown →
   * `setModel` → this broadcast). `"chat_command"` is reserved for a switch
   * driven by the `/model` slash command typed in the chat; the client uses
   * it to decide whether to show the "your pick becomes the default" notice.
   * Optional so older broadcasts (and the SDK-side `/model` path, which the
   * client detects via CLI stdout instead) remain valid.
   */
  source?: "picker" | "chat_command";
};

/**
 * Broadcast when the server auto-disables the advisor because the main-thread
 * model changed to one incompatible with the active advisor tool. Carries the
 * previous advisor id so the client's "Re-enable" button can restore it in a
 * single click without re-reading settings.
 */
export type AdvisorDisabledOnModelChangeEvent = {
  type: "advisor_disabled_on_model_change";
  /** The advisor model id that was cleared (e.g. "claude-opus-4-8"). */
  previousAdvisor: string;
  /** The new main-thread model that triggered the disable. */
  newModel?: string;
};

export type ReplayDoneEvent = {
  type: "replay_done";
  hasMoreAbove: boolean;
};

/**
 * Coarse "is the agent busy?" signal broadcast on every transition of
 * `Session.getStatus()` (turn-in-flight or an interactive prompt open) and
 * re-emitted to every new SSE subscriber. Lets late-attaching tabs paint
 * the StatusLine / tab dot correctly even when no further assistant chunks
 * arrive (long-running Bash, slow tool, etc.) — the buffer replay alone
 * doesn't carry this truth.
 */
export type TurnStatusEvent = {
  type: "turn_status";
  status: "running" | "idle";
};

/**
 * Per-session goal state. Broadcast whenever the goal is set, cleared, or
 * marked achieved (the latter from the in-process `report_goal_achieved` SDK
 * tool the agent calls). Carries the full state so the client can render the
 * GoalBanner from a single event — `goal === null` means "no goal, hide the
 * banner"; `achieved` is sticky until the goal is cleared or replaced.
 *
 * Re-emitted to every new SSE subscriber in `Session.subscribe()` (like
 * `mode_changed` / `cwd_changed`) so a reconnecting tab repaints the banner
 * even when the replay buffer has scrolled past the original transition.
 */
export type GoalChangedEvent = {
  type: "goal_changed";
  goal: string | null;
  achieved: boolean;
  summary?: string | null;
  setAt?: number | null;
  achievedAt?: number | null;
};

export type SessionTitleEvent = {
  type: "session_title";
  title?: string;
};

/**
 * Occasional nudge to ask the user for feedback — Claudius's take on the CLI's
 * session-quality survey. Broadcast from `session.ts` after a turn completes,
 * gated by a low probability (the `feedbackSurveyRate` setting) and an
 * in-process throttle. The browser shows a slim, dismissible banner; on submit
 * the comment is forwarded to Anthropic via `Session.submitFeedback` AND
 * persisted locally (see `lib/server/feedback-store.ts`).
 *
 * Live-only: skipped in the SSE replay loop so a stale nudge doesn't re-pop on
 * reload (same treatment as `permission_request` / `ask_user_question`).
 */
export type FeedbackSurveyEvent = {
  type: "feedback_survey";
  sessionId: string;
  /** SDK feedback surface tag forwarded on submit. */
  surface?: string;
};

/**
 * One-shot nudge to ask the user to manually switch from Opus to Sonnet after
 * repeated 529 "Overloaded" errors. Mirrors the Claude Code TUI line "Opus is
 * experiencing high load, please use /model to switch to Sonnet" — distinct
 * from the SDK's automatic `fallbackModel` path, which swaps silently. The
 * server (`lib/server/session.ts` + `opus-overload-detector.ts`) counts
 * consecutive overload signals and fires this event when the threshold trips;
 * a successful turn resets the counter.
 *
 * Live-only: skipped in the SSE replay loop alongside `feedback_survey` /
 * `permission_request` so a stale nudge doesn't re-pop on reload after the
 * overload event has passed.
 */
export type OpusOverloadNudgeEvent = {
  type: "opus_overload_nudge";
  /** The Opus model id active when the nudge fired (informational). */
  model: string;
  /** Consecutive overload count that triggered the nudge (informational). */
  count: number;
};

/**
 * One-shot nudge fired when a session with the 1M-context beta enabled hits
 * the SDK's `billing_error` on an assistant message — the Claude Code TUI
 * surfaces this as "Extra usage is required for long context · run
 * /usage-credits to turn them on, or /model to switch to standard context".
 * We mirror the dual-remediation: open the model picker (mirrors `/model`)
 * and link to claude.ai/settings/usage (mirrors `/usage-credits`). Live-only
 * on the wire (skipped in the SSE replay loop) so a stale event never
 * re-pops on reload; the server's fire-once guard prevents re-emission
 * inside one session lifetime.
 */
export type LongContextCreditsNudgeEvent = {
  type: "long_context_credits_required";
  /** The model id active when the nudge fired (informational). */
  model: string;
};

/**
 * One-shot nudge fired when a session's SDK iterator surfaces an
 * authentication failure (HTTP 401 from Anthropic) — either as the SDK's
 * structured `authentication_failed` tag on an assistant message or as a
 * synthetic "API Error: 401 / Failed to authenticate" body, with the
 * thrown-error path covered too. The Claude Code TUI surfaces this as
 * "Please run /login"; Claudius mirrors that with a dismissible banner
 * linking to the accounts section (`/usage#accounts`) so the user can
 * swap their credential without leaving the chat. Live-only on the wire
 * (skipped in the SSE replay buffer) so a stale event never re-pops on
 * reload; the server's fire-once guard prevents re-emission inside one
 * session lifetime.
 */
export type AuthFailedNudgeEvent = {
  type: "auth_failed_required";
  /** The model id active when the nudge fired (informational). */
  model: string;
};

/**
 * One-shot notice fired when any configured MCP server is in `needs-auth`
 * state at session startup. Emitted from `Session.noteMcpNeedsAuthAtStartup()`
 * on the first live (non-replayed) `system:init`. The client renders it as a
 * `kind: "info"` transcript pill pointing the user at `/mcp` to authenticate.
 * Excluded from the SSE replay buffer so a stale notice never re-pops on
 * reload; the server's fire-once guard prevents re-emission inside one
 * session lifetime.
 */
export type McpNeedsAuthNoticeEvent = {
  type: "mcp_needs_auth_notice";
  /** Names of the MCP servers currently in `needs-auth` state. */
  servers: string[];
};

/**
 * One-shot proactive nudge fired when the active account profile's OAuth
 * token is within `TOKEN_EXPIRY_WARNING_WINDOW_MS` of expiring (CC 2.1.203
 * parity: "Added a warning when your login is about to expire, so you can
 * re-authenticate before background sessions are interrupted"). Emitted from
 * `Session.noteTokenExpiringAtStartup()` on the first live (non-replayed)
 * `system:init`, mirroring `McpNeedsAuthNoticeEvent`'s timing. The client
 * renders a dismissible banner (`TokenExpiringPanel`) linking to
 * `/usage#accounts` so the user can re-authenticate before it lapses.
 * Excluded from the SSE replay buffer so a stale warning never re-pops on
 * reload; the server's fire-once guard prevents re-emission inside one
 * session lifetime.
 */
export type TokenExpiringNudgeEvent = {
  type: "token_expiring_required";
  /** Unix-ms instant the active credential's access token expires. */
  expiresAt: number;
};

/**
 * Server-driven spinner tips — the catalog the client rotates through under
 * the "Claude is working…" row. Routed through SSE (rather than hardcoded on
 * the client) so the backend is the single source of truth: new-feature tips
 * can ship, or be gated by what the session actually supports, without a
 * client deploy. Emitted per-subscriber in `Session.subscribe` (like
 * `turn_status` / `mode_changed`), so every reload/tab gets the current list.
 *
 * Ambient + idempotent: each event simply replaces the client's list, so —
 * unlike the one-shot `feedback_survey` nudge — re-delivering it is harmless.
 * It never enters the replay buffer (emitted directly to each subscriber), so
 * it needs no replay-skip handling.
 */
export type TipsEvent = {
  type: "tips";
  tips: Tip[];
};

/**
 * The agent's effective working directory changed mid-session — most often
 * because Claude Code created (or moved into) a git worktree to isolate its
 * edits. Derived from the SDK's `CwdChanged` hook (observational; fires on
 * every cwd transition with `old_cwd`/`new_cwd`).
 *
 * The client compares `cwd` against the session root: when they differ it
 * paints a "worktree" badge in the StatusLine so the user knows the edits
 * aren't landing in their current checkout. When the agent moves back to the
 * root the same event fires with `cwd === root`, which clears the badge — so
 * `cwd` is always the *absolute* new path, never a relative delta.
 */
export type CwdChangedEvent = {
  type: "cwd_changed";
  /** Absolute new working directory (SDK `new_cwd`). */
  cwd: string;
};

/**
 * Per-option choice in an AskUserQuestion form.
 * Mirrors the SDK's AskUserQuestionInput option shape; `preview` is HTML
 * because we set toolConfig.askUserQuestion.previewFormat = 'html'.
 */
export type AskQuestionOption = {
  label: string;
  description: string;
  /** HTML string the model emits to compare options. May be empty/unset. */
  preview?: string;
};

export type AskQuestion = {
  question: string;
  /** Short chip label (≤ 12 chars). */
  header: string;
  options: AskQuestionOption[];
  multiSelect: boolean;
};

/**
 * The agent invoked the built-in AskUserQuestion tool. The browser should
 * render a form, collect the user's choices, and POST them to the
 * `ask-answer` endpoint with the requestId echoed.
 */
export type AskUserQuestionEvent = {
  type: "ask_user_question";
  requestId: string;
  toolUseId: string;
  questions: AskQuestion[];
};

/**
 * Best-effort coercion of the SDK's AskUserQuestion tool input into our
 * server-event shape. Defensive against schema drift — if the SDK changes
 * the field names, we drop unknown shapes rather than throw.
 *
 * Lives in `lib/shared` (not the server) because the client needs the same
 * shape to "resurrect" the modal for a historic AskUserQuestion row whose
 * permission stream got aborted (cf. `resurrectedAsk` in app/page.tsx).
 */
export function parseAskQuestions(input: unknown): AskQuestion[] {
  if (!input || typeof input !== "object") return [];
  const raw = (input as Record<string, unknown>).questions;
  if (!Array.isArray(raw)) return [];
  const out: AskQuestion[] = [];
  for (const q of raw) {
    if (!q || typeof q !== "object") continue;
    const qo = q as Record<string, unknown>;
    const question = typeof qo.question === "string" ? qo.question : "";
    const header = typeof qo.header === "string" ? qo.header : "";
    const multiSelect = qo.multiSelect === true;
    const optsRaw = Array.isArray(qo.options) ? qo.options : [];
    const options: AskQuestionOption[] = [];
    for (const o of optsRaw) {
      if (!o || typeof o !== "object") continue;
      const oo = o as Record<string, unknown>;
      const label = typeof oo.label === "string" ? oo.label : "";
      const description = typeof oo.description === "string" ? oo.description : "";
      const preview = typeof oo.preview === "string" ? oo.preview : undefined;
      if (label) options.push({ label, description, preview });
    }
    if (question && options.length >= 2) {
      out.push({ question, header, options, multiSelect });
    }
  }
  return out;
}

/**
 * The agent invoked ExitPlanMode to surface a plan for the user to approve.
 * Routed through canUseTool, so the browser must POST a decision back to the
 * `plan` endpoint to unblock the SDK — accepting it also flips the session
 * out of plan mode.
 */
export type PlanApprovalRequestEvent = {
  type: "plan_approval_request";
  requestId: string;
  toolUseId: string;
  plan: string;
  raw?: Record<string, unknown>;
};

export type PlanDecision =
  | {
      kind: "accept";
      /**
       * When set, this becomes the plan text fed to the SDK's ExitPlanMode
       * tool via `PermissionResult.updatedInput.plan`. The tool writes this
       * to disk and the model's next turn references the edited version
       * rather than what it originally drafted.
       */
      editedPlan?: string;
    }
  | { kind: "reject"; message?: string };

export type PlanDecisionSubmission = {
  requestId: string;
  decision: PlanDecision;
};

/** One answer per question, in the same order as `questions`. */
export type AskAnswer = {
  /** For single-select: the chosen option label, or null when picking "Other". */
  label?: string | null;
  /** For multi-select: the chosen option labels. */
  selected?: string[];
  /** Free-text "Other" — the form's escape hatch. */
  custom?: string;
};

export type AskAnswerSubmission = {
  requestId: string;
  answers: AskAnswer[];
};

/**
 * Build the `updatedInput` object that is returned to the SDK when resolving
 * an AskUserQuestion permission request. Extracted as a pure function so it
 * can be unit-tested without instantiating a Session.
 *
 * Shape matches `AskUserQuestionOutput` from sdk-tools.d.ts:
 *   { questions, answers, response?, annotations? }
 *
 * `response` (new in SDK 0.3.158) is populated only for single-question
 * forms where the user chose the "Other" path (label === null + custom text).
 * Multi-question forms leave it unset — the field is a single string and the
 * question mapping would be ambiguous.
 */
export function buildAskUpdatedInput(
  questions: AskQuestion[],
  answers: AskAnswer[],
): {
  questions: AskQuestion[];
  answers: Record<string, string>;
  response?: string;
  annotations?: Record<string, { preview?: string; notes?: string }>;
} {
  const answersMap: Record<string, string> = {};
  const annotations: Record<string, { preview?: string; notes?: string }> = {};

  for (let i = 0; i < questions.length; i++) {
    const q = questions[i];
    const a = answers[i] ?? {};
    let value = "";
    if (q.multiSelect) {
      const labels = Array.isArray(a.selected) ? a.selected : [];
      const all = a.custom && a.custom.trim() ? [...labels, a.custom.trim()] : labels;
      value = all.join(", ");
    } else if (a.custom && a.custom.trim()) {
      value = a.custom.trim();
    } else if (typeof a.label === "string" && a.label) {
      value = a.label;
    }
    answersMap[q.question] = value;
    const chosen = q.options.find((o) => o.label === a.label);
    if (chosen?.preview) {
      annotations[q.question] = { preview: chosen.preview };
    }
  }

  // SDK 0.3.158: populate `response` for single-question / "Other" path.
  let response: string | undefined;
  if (questions.length === 1) {
    const a0 = answers[0] ?? {};
    // label === null means no structured option was chosen (the "Other"
    // path set by AskUserQuestionPrompt). custom being non-empty confirms
    // the user actually typed something.
    if (a0.label === null && a0.custom && a0.custom.trim()) {
      response = a0.custom.trim();
    }
  }

  return {
    questions,
    answers: answersMap,
    ...(response !== undefined ? { response } : {}),
    ...(Object.keys(annotations).length > 0 ? { annotations } : {}),
  };
}

/**
 * Server-side derived-state snapshot, replayed to every new SSE subscriber
 * right after the tail-replay window finishes. Lets clients rehydrate
 * state that was set by tool_uses earlier than the replay window — todos
 * being the most painful loss (a long-running TodoWrite can pre-date the
 * tail by many turns and disappear on tab-switch).
 *
 * Single-event-with-many-optional-fields shape is deliberate: keeps the
 * SSE wire flat and lets later fields land without a new event type.
 */
export type SessionSnapshotEvent = {
  type: "session_snapshot";
  /**
   * Raw `todos` payload from the most recent `TodoWrite` tool_use. The
   * server doesn't normalize — it passes through whatever the model
   * emitted — because the client already knows how to coerce that shape
   * (see `latestTodos` in `lib/client/use-session.ts`).
   */
  todos?: unknown[];
  /**
   * Staleness flag for the to-do list. Set true by the server when the
   * model has gone several turns (or many mid-turn tool calls) with open
   * items but no TodoWrite/Task* touch — the list is no longer being kept
   * in sync with reality. The client dims the banner and shows a "stale"
   * badge so a frozen "0/N" stops reading as live truth. Cleared back to
   * false the moment the model re-engages the list or it's cleared. Only
   * meaningful alongside (or after) a `todos` field; absent means
   * "unchanged".
   */
  todosStale?: boolean;
  /**
   * Latest top-level user prompt — the actual one the user typed, not a
   * tool_result wrapper. Replayed so a client that reconnects to a long
   * session (tail window dropped the prompt off the top) still gets the
   * "what was I asking?" anchor pinned at the top of the chat. The
   * client injects this into the message list if the prompt's `uuid`
   * isn't already present from the SSE replay.
   */
  lastUserPrompt?: {
    uuid: string;
    text: string;
    /** Epoch ms when the prompt was captured. */
    at?: number;
  };
};

/**
 * One persisted subagent (Task) row, replayed inside `task_snapshot`. Mirrors
 * the client's `TaskInfo` plus the captured inner conversation. Carries
 * everything the live `task_started` / `task_progress` / `task_notification`
 * system events would have populated — those are transient SSE-only events
 * absent from the on-disk JSONL, so they vanish once a session is rebuilt
 * from disk. See `lib/server/db-migrations/007_session_tasks.sql`.
 */
export type TaskSnapshotEntry = {
  taskId: string;
  /** Parent Task tool_use block id — the client's JOIN key. */
  toolUseId?: string;
  subagentType?: string;
  description?: string;
  taskType?: string;
  workflowName?: string;
  status: string;
  /**
   * True if the parent launched this Task with `run_in_background: true`.
   * Backgrounded tasks legitimately outlive a parent turn (their real
   * completion rides on a later `task_notification`), so the session's
   * "is busy?" check must exclude them — otherwise one fire-and-forget
   * Task would pin the session at `running` forever. Populated from
   * `task_updated.patch.is_backgrounded`.
   */
  isBackgrounded?: boolean;
  totalTokens?: number;
  toolUses?: number;
  durationMs?: number;
  summary?: string;
  error?: string;
  /**
   * Raw subagent SDK messages (those tagged with `parent_tool_use_id`),
   * in arrival order. `at` is the server-stamped epoch ms for ordering.
   * `message` is the untouched SDK envelope so the client can rebuild
   * `DisplayMessage`s through the same path the live stream uses.
   */
  innerMessages: Array<{ at?: number; message: unknown }>;
};

/**
 * Replayed to every new SSE subscriber after `replay_done`, alongside
 * `session_snapshot`. Rehydrates subagent (Task) metadata and inner
 * conversations that only ever existed in the live SSE buffer. The client
 * fills these in idempotently — it skips any task/subagent already restored
 * from the buffer replay (a still-live session), so this only "wins" for
 * sessions rebuilt from disk where the transient data was lost.
 */
export type TaskSnapshotEvent = {
  type: "task_snapshot";
  tasks: TaskSnapshotEntry[];
};

/**
 * One-line "where were we?" summary, fired when the user returns to a session
 * after stepping away. Generated server-side via an ephemeral, no-tools query
 * over the last few transcript turns (see `lib/server/session-recap.ts`). The
 * client renders this as a slim banner above the composer with a
 * "(disable recaps in /config)" hint — mirrors the Claude Code TUI's away-summary
 * feature, which Claudius cannot inherit from the SDK directly (the SDK only
 * ships the on/off flag; recap rendering is TUI-side).
 *
 * Live-only on the wire: skipped in the SSE replay loop so a stale recap
 * doesn't re-pop on tab switch. The client also clears the banner the moment
 * the next user prompt fires, so a recap never sits stale against an active
 * conversation.
 *
 * Server-side multi-tab guard: `Session.requestRecap()` rate-limits firings
 * per-session so two tabs returning to focus simultaneously don't double-fire.
 */
export type SessionRecapEvent = {
  type: "session_recap";
  /** Model-generated recap text (≤ ~40 words, plain prose). */
  text: string;
  /** Server-stamped epoch ms when the recap was produced. */
  at: number;
  /**
   * How this recap fired. `away` = automatic on return-from-blur;
   * `manual` = explicit user request (e.g. `/recap` button). Clients can use
   * this for analytics or to tweak banner phrasing, but the default render is
   * identical for both.
   */
  origin: "away" | "manual";
};

/**
 * Recap generation was attempted but skipped or failed. Lets the client clear
 * any "loading" indicator and (for manual triggers) surface a one-line reason.
 * `disabled` / `running` / `draft` / `no_history` are intentional skips — these
 * mirror the TUI's `[awaySummary] skipped: …` debug paths. `rate_limited`
 * fires when another tab beat this one to it within the dedupe window.
 */
export type SessionRecapErrorEvent = {
  type: "session_recap_error";
  reason:
    | "disabled"
    | "running"
    | "draft"
    | "no_history"
    | "rate_limited"
    | "failed";
  /** Optional human-readable detail (only `failed` populates this today). */
  message?: string;
};

/**
 * Emitted once when the account-switcher's "auto-rotate on rate limit"
 * fires for this session — i.e. the active account hit its limit and
 * the global active-profile pointer was rotated to the next configured
 * account. Surfaces as an inline banner in chat so the user knows why
 * subsequent sessions start under a different credential. Does NOT
 * affect the current (rate-limited) session — the SDK reads env at
 * query() construction, so the rotation only takes effect on the next
 * new session.
 */
export type AccountAutoRotatedEvent = {
  type: "account_auto_rotated";
  fromLabel: string;
  toLabel: string;
};

/**
 * The main-thread agent for this session changed mid-session via
 * `applyFlagSettings({ agent })`. Broadcast optimistically from
 * `Session.setAgent()` — the SDK emits no dedicated event for this, so
 * we mirror the same pattern used for `model_changed` / `mode_changed`.
 *
 * `agent === null` means the session was reset to the default general-
 * purpose agent (same as not specifying `agent` at all in Options). The
 * StatusLine agent badge clears on null.
 *
 * Persisted: `Session.agent` is mutable (unlike `effort`/`ultracode`
 * which are session-scoped), so a reap→resume will start with the
 * switched agent rather than resetting to the workspace default.
 */
export type AgentChangedEvent = {
  type: "agent_changed";
  /** New main-thread agent name, or null to reset to the default agent. */
  agent: string | null;
};

/**
 * Metadata view of one queued user message. Broadcast inside `QueueUpdatedEvent`
 * so every connected tab can render the QueueIndicator strip without holding
 * its own copy of the queue. Crucially does NOT include the base64 `images`
 * blobs that may also be queued — those can be multi-MB and we'd be shipping
 * them on every reorder/edit. The composer only needs to know `hasImages` to
 * render the paperclip badge; the actual bytes never leave the server until
 * the message is drained into `sendInput()`.
 */
export type QueuedMessageMeta = {
  uuid: string;
  text: string;
  slash?: boolean;
  fromSuggestion?: boolean;
  fromGoal?: boolean;
  hasImages?: boolean;
  createdAtMs: number;
};

/**
 * Server-authoritative snapshot of this session's pending-message queue.
 * Emitted whenever the queue changes (enqueue / pop / remove / edit / reorder),
 * and re-emitted fresh on subscribe so a late-joining tab sees current state
 * without dependency on the replay buffer. Excluded from the replay buffer
 * itself — it's a snapshot, not an event log.
 */
export type QueueUpdatedEvent = {
  type: "queue:updated";
  sessionId: string;
  queue: QueuedMessageMeta[];
};

/**
 * One utilization window from the claude.ai plan rate-limit response.
 * `utilization` is 0-100 (percentage used), `resetsAt` is an ISO 8601 string.
 * Either field may be null when the backend cannot determine the value.
 */
export type PlanUsageWindow = {
  utilization: number | null;
  resetsAt: string | null;
};

/**
 * Structured plan-level usage data fetched after each successful turn via
 * `Query.usage_EXPERIMENTAL_MAY_CHANGE_DO_NOT_RELY_ON_THIS_API_YET()`.
 *
 * `subscriptionType` is "pro" | "max" | "team" | "enterprise" | null (null
 * for API-key / Bedrock / Vertex sessions). `rateLimitsAvailable` is false
 * (and `rateLimits` null) for non-claude.ai sessions.
 *
 * EXPERIMENTAL: the underlying SDK API may change shape in any release.
 */
export type PlanUsageEvent = {
  type: "plan_usage";
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
   * overage-included-models allowlist (SDK 0.3.190). Additive — present only
   * when the server emits them. Each entry carries the server-supplied
   * `displayName` (e.g. "Fable") for labeling the usage bar in CostOverlay.
   */
  modelScoped?: Array<{ displayName: string; utilization: number | null; resetsAt: string | null }>;
  /**
   * Epoch ms when this event's data was fetched (CC parity 2.1.208 — mirrors
   * the CLI's `/usage` "as of <time>" note shown when the usage endpoint is
   * rate-limited). Stamped server-side only on a *successful*
   * `usage_EXPERIMENTAL_MAY_CHANGE_DO_NOT_RELY_ON_THIS_API_YET()` call; a
   * failing/rate-limited call broadcasts nothing at all, so the client keeps
   * whatever `fetchedAt` it last received. CostOverlay uses the growing age
   * of this timestamp to decide when to surface a staleness note over the
   * last-known bars, without needing an explicit "this fetch failed" signal.
   */
  fetchedAt: number;
};

/**
 * Broadcast whenever session holder changes — identifies which tab (by its
 * random `tabId`) currently holds the write lock. All connected clients
 * compare this against their own `tabId`; mismatches render read-only. Set to
 * `null` when no holder is registered (e.g. all tabs disconnected). Excluded
 * from the SSE replay buffer — the current holder is echoed fresh in
 * `Session.subscribe()` so every connecting client gets the live value.
 */
export type HolderChangedEvent = {
  type: "holder_changed";
  holderId: string | null;
};

export type ServerEvent =
  | {
      type: "sdk";
      message: SDKMessage;
      /**
       * Epoch ms when this SDK message was first observed. Stamped at the
       * server broadcast funnel so it survives the SSE replay buffer — every
       * subscriber (live, reload, tab-switch) sees the same value. Defaults to
       * `Date.now()` for live SDK iterator output and user-input echoes; the
       * disk-replay path (session resume) parses the SDK's native ISO
       * `timestamp` field when available so historical messages keep their
       * original time.
       */
      at?: number;
    }
  | PermissionRequestEvent
  | SessionReadyEvent
  | SessionErrorEvent
  | ModeChangedEvent
  | ModelChangedEvent
  | AdvisorDisabledOnModelChangeEvent
  | AgentChangedEvent
  | ReplayDoneEvent
  | TurnStatusEvent
  | SessionTitleEvent
  | GoalChangedEvent
  | FeedbackSurveyEvent
  | OpusOverloadNudgeEvent
  | LongContextCreditsNudgeEvent
  | AuthFailedNudgeEvent
  | McpNeedsAuthNoticeEvent
  | TokenExpiringNudgeEvent
  | TipsEvent
  | CwdChangedEvent
  | AskUserQuestionEvent
  | PlanApprovalRequestEvent
  | SessionSnapshotEvent
  | TaskSnapshotEvent
  | TodosAutoClearedEvent
  | AccountAutoRotatedEvent
  | SessionRecapEvent
  | SessionRecapErrorEvent
  | QueueUpdatedEvent
  | PlanUsageEvent
  | HolderChangedEvent;

/**
 * One-shot notification that the SERVER auto-cleared the to-do snapshot —
 * either because every item finished (`reason: "completed"`) or because
 * the list went idle past the staleness threshold (`reason: "stale"`).
 *
 * NOT emitted for manual user-driven clears: when the user clicks Clear
 * they already know what they just did, so a toast would be noise. Manual
 * clears emit only the empty `session_snapshot` and rely on the banner
 * disappearing for feedback.
 *
 * The client renders a transient toast / inline banner that fades out
 * after a few seconds. State is not persisted across the SSE replay
 * buffer trim — late tabs that connect after the toast lifetime would
 * just paint the empty list (the snapshot is authoritative), so missing
 * this event is at worst "the user doesn't see the disappearance was
 * automatic," which is identical to today's behavior.
 *
 * `count` is the number of items dropped at clear time. Useful for the
 * UI string ("Cleared 6 completed todos" vs "Cleared 1 stale todo").
 */
export type TodosAutoClearedEvent = {
  type: "todos_auto_cleared";
  reason: "stale" | "completed";
  count: number;
};

export type PermissionDecision =
  | { kind: "allow_once" }
  | { kind: "allow_always_session" }
  | { kind: "allow_always_save"; destination: "userSettings" | "projectSettings" | "localSettings" }
  | { kind: "deny"; message?: string };

export type CreateSessionRequest = {
  cwd?: string;
  model?: string;
  /**
   * Main-thread agent name (SDK Options.agent / `--agent`). Applies the named
   * agent's system prompt, tools, and model to the main conversation. The
   * agent must be defined (a file under .claude/agents or ~/.claude/agents).
   */
  agent?: string;
  /**
   * Hard spend cap (USD) for this session — SDK Options.maxBudgetUsd. The
   * query stops with an `error_max_budget_usd` result once exceeded.
   */
  maxBudgetUsd?: number;
  /** Soft token budget the model paces against — SDK Options.taskBudget.total. */
  taskBudgetTokens?: number;
  /** Hard cap on agentic turns — SDK Options.maxTurns. */
  maxTurns?: number;
  /** Fallback model id for this session — SDK Options.fallbackModel. */
  fallbackModel?: string;
  /** Run shell commands in a sandbox — SDK Options.sandbox.enabled. */
  sandboxEnabled?: boolean;
  /** Enable the 1M-token context beta — SDK Options.betas (Sonnet 4/4.5). */
  enable1mContext?: boolean;
  /** Persist this session to disk — SDK Options.persistSession (false = ephemeral). */
  persistSession?: boolean;
  /** Extra absolute dirs the agent may access — SDK Options.additionalDirectories. */
  additionalDirectories?: string[];
  /** Extra text appended to the default system prompt — SDK Options.systemPrompt.append. */
  systemPromptAppend?: string;
  /** Custom plan-mode workflow body — SDK Options.planModeInstructions. */
  planModeInstructions?: string;
  permissionMode?: PermissionMode;
  /** If set, resume an existing session by id. */
  resume?: string;
  /** When resuming, only replay messages up to and including this message uuid. */
  resumeSessionAt?: string;
  /**
   * Seed the composer textarea with this text. Written to the per-session
   * prompt-draft row as part of session creation so the renderer's draft
   * GET reads it back authoritatively — no race against any in-memory
   * injection. Does NOT auto-send.
   *
   * Used by the Electron right-click "Start New Chat With Selection"
   * entry (electron/ipc/context-menu.ts). Trimmed to a defensive ceiling
   * by the server.
   */
  initialDraftText?: string;
};

export type AttachedImage = {
  /** base64 (no data: prefix). */
  data: string;
  /** e.g. "image/png" */
  mediaType: string;
  /**
   * Per-prompt ordinal that matches the `[Image #N]` token in the text. Required
   * for the server to interleave the right image at the right token position.
   */
  ordinal?: number;
};

export type SendInputRequest = {
  text: string;
  images?: AttachedImage[];
  /**
   * Client-minted uuid for this user message. Pinning it from the client lets
   * us:
   *   1. Broadcast the message into the session's SSE buffer with a stable id
   *      so other tabs (and reload-of-this-tab) see user history alongside
   *      assistant replies. The SDK doesn't echo user inputs back through its
   *      iterator, so without this the buffer would only ever contain
   *      assistant/result events.
   *   2. Forward the same id into the SDK's inputQueue, so the JSONL on disk
   *      uses it too — keeping `loadOlder`'s `?before=<uuid>` cursor in sync
   *      with the in-memory buffer.
   *   3. Dedupe against the optimistic local add (which already mints a uuid
   *      via crypto.randomUUID()) when the broadcast echoes back over SSE.
   */
  uuid?: string;
  /**
   * When true, `text` is a slash command meant for the SDK to interpret
   * (e.g. `/compact`, `/init`, `/recap`). The server still pushes it to
   * the SDK inputQueue verbatim, but skips the synthetic user-message
   * broadcast that would otherwise echo `/compact` into the chat as if
   * the user had said it. A small `slash_invoked` system event takes its
   * place so the chat doesn't go silent while the SDK runs the command.
   */
  slash?: boolean;
  /**
   * When true, this message originated from a clicked "Suggested follow-up"
   * chip (PromptSuggestions) rather than the user typing it. The server records
   * (session_id, uuid, text) in the `suggested_messages` table so the chat can
   * badge the bubble as auto-suggested — including after a reload, where the
   * message is replayed from the SDK JSONL with no in-memory provenance.
   */
  fromSuggestion?: boolean;
  /**
   * When true, this message was submitted as the session goal (the header goal
   * input or `/goal <text>`): it's sent as a normal prompt AND tracked as the
   * goal. The server records (session_id, uuid, text) in the `goal_messages`
   * table so the chat can badge the bubble as a goal — surviving reloads, where
   * the message is replayed from the SDK JSONL with no in-memory provenance.
   */
  fromGoal?: boolean;
  /**
   * When true, always enqueue this message instead of running it immediately,
   * even if the session is idle. Preserves the explicit `enqueue()` semantics
   * from the previous client-side queue (stage a message to send after the
   * current train of thought, without interrupting). When omitted/false the
   * server decides: idle + empty queue → run now; otherwise enqueue.
   */
  forceQueue?: boolean;
};

/**
 * Response shape for `POST /api/sessions/[id]/input`. The server decides
 * whether the message ran immediately or got enqueued; the client uses
 * `queued` to reconcile any optimistic local state (e.g. roll back the
 * optimistic user bubble when the message actually landed in the queue
 * instead of starting a turn). `uuid` echoes the id used for the action —
 * either the client-supplied uuid or one the server minted.
 */
export type SendInputResponse = {
  ok: true;
  queued: boolean;
  uuid: string;
};

/**
 * Request shape for `POST /api/sessions/[id]/bash` — the `!` input-box bash
 * mode (Claude Code parity). The command runs on the session's persistent
 * bash (anchored at `session.cwd`) without invoking the model. The result
 * is echoed into the chat as a synthetic user-turn for the UI AND queued
 * onto the bash-block pending channel so the model sees it as committed
 * conversation context on the NEXT real user turn.
 *
 * `sudoPassword` is one-shot: it's piped to `sudo -S` via stdin and is
 * never logged, broadcast, persisted to the JSONL, or included in the
 * `<bash-input>` block the model receives. The route handler is the
 * trust boundary.
 */
export type SendBashRequest = {
  /** Raw shell command (no leading `!`). */
  command: string;
  /** Sent only when the command starts with `sudo`; never persisted. */
  sudoPassword?: string;
  /**
   * Client-minted uuid for the synthetic user-turn echo, mirroring the
   * SendInput pattern so reloads dedupe cleanly.
   */
  uuid?: string;
};

export type SendBashResponse = {
  ok: true;
  uuid: string;
  stdout: string;
  stderr: string;
  exitCode: number;
  truncated: boolean;
  timedOut: boolean;
};
