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
  | ReplayDoneEvent
  | TurnStatusEvent
  | SessionTitleEvent
  | GoalChangedEvent
  | FeedbackSurveyEvent
  | OpusOverloadNudgeEvent
  | TipsEvent
  | CwdChangedEvent
  | AskUserQuestionEvent
  | PlanApprovalRequestEvent
  | SessionSnapshotEvent
  | TaskSnapshotEvent;

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
};
