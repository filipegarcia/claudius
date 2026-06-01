import { createHash, randomUUID } from "node:crypto";
import { watch as watchFs, readFileSync, type FSWatcher, promises as fsp } from "node:fs";
import {
  createSdkMcpServer,
  getSessionInfo,
  getSessionMessages,
  query,
  renameSession,
  tool,
  type CanUseTool,
  type CwdChangedHookInput,
  type EffortLevel,
  type McpSdkServerConfigWithInstance,
  type McpServerConfig,
  type Options,
  type PermissionMode,
  type PermissionResult,
  type PostToolUseHookInput,
  type PreToolUseHookInput,
  type Query,
  type SDKMessage,
  type SDKUserMessage,
} from "@anthropic-ai/claude-agent-sdk";
import { z } from "zod";
import { projectRoot } from "./db";
import { AsyncQueue } from "./async-queue";
import { notificationBus } from "./notification-bus";
import { queueReminder, takePendingReminders } from "./system-reminders";
import {
  isOpusModelId,
  isOverloadErrorText,
  isOverloadSignal,
} from "./opus-overload-detector";
import { isBillingErrorSignal } from "./long-context-credits-detector";
import {
  clearSessionGoal,
  getSessionGoal,
  getSessionState,
  getSessionTitle,
  mergeSessionState,
  setGoalAchieved,
  setSessionGoal,
  setSessionTitle,
  touchSession,
  upsertSession,
  type SessionGoal,
} from "./sessions-db";
import {
  buildAskUpdatedInput,
  parseAskQuestions,
  type AskAnswer,
  type AskQuestion,
  type GoalChangedEvent,
  type PermissionDecision,
  type PermissionRequestEvent,
  type PlanDecision,
  type ServerEvent,
  type TaskSnapshotEntry,
} from "@/lib/shared/events";
import { listSessionTasks, saveSessionTask } from "./session-tasks-db";
import { extractUserPromptText, isRealUserPrompt } from "@/lib/shared/user-prompt";
import {
  planThinkingReplayRecovery,
  thinkingReplayErrorFrom,
} from "./thinking-replay-recovery";
import { extractReadPaths } from "@/lib/shared/read-tool-paths";
import { joinSystemPromptAppends } from "@/lib/shared/system-prompt-append";
import { loadDbAgentsForOptions } from "@/lib/server/db-agents";
import { selectTips } from "@/lib/shared/tips";
import type { SessionLoop } from "@/lib/shared/session-loops";
import { readSettings, type ClaudeSettings } from "./settings";
import {
  coerceSurveyRate,
  getLastSurveyShownAt,
  noteSurveyShown,
  shouldOfferSurvey,
  SURVEY_MIN_INTERVAL_MS,
} from "./feedback-survey";

/**
 * If `filePath` lands inside a `.claude/worktrees/<name>/` tree, return the
 * absolute worktree root; otherwise null.
 *
 * This backs the PreToolUse fallback for the worktree badge. Harness-level
 * `EnterWorktree` moves the session into a git worktree WITHOUT firing the
 * SDK's `CwdChanged` (or, in some builds, `WorktreeCreate`) hook — so the
 * badge's normal signal never arrives. But any edit it makes carries an
 * absolute path under `<root>/.claude/worktrees/<name>/`, which we can sniff.
 */
export function worktreeRootFromPath(filePath: string): string | null {
  const m = /^(.*\/\.claude\/worktrees\/[^/]+)(?:\/|$)/.exec(filePath);
  return m ? m[1] : null;
}

/**
 * The Claude Code TUI scans each outgoing prose prompt for the bare word
 * `ultrathink` (case-insensitive, on word boundaries) and, when present,
 * injects a transient `<system-reminder>` that lifts the reasoning budget for
 * just that turn — distinct from `/effort max`, which is a sticky config
 * change. Grounded in the `\bultrathink\b` regex and `ultrathink-active`
 * identifier embedded in the CLI binary.
 *
 * Returns the reminder body (without the wrapper tag) for prompts that match,
 * or `null` otherwise. Caller queues it through `queueReminder` so the same
 * drain that prepends `takeGoalReminder` picks it up — which means the nudge
 * rides the SAME turn the user typed the word on (not the next one), because
 * `queueReminder` and `takePendingReminders` execute back-to-back in
 * `sendInput`. The "next user turn" wording in `system-reminders.ts` is the
 * general channel contract; this caller uses synchronous in-call ordering to
 * land on the current turn instead.
 *
 * Exported for unit testing — the regex boundary behavior (`ultrathinking`
 * must NOT match, `Ultrathink.` must) is the contract worth pinning.
 */
export function ultrathinkReminderBody(text: string): string | null {
  if (!/\bultrathink\b/i.test(text)) return null;
  return (
    'The user included the keyword "ultrathink", requesting deeper reasoning ' +
    "on this turn. Reason as thoroughly as the task warrants."
  );
}

/**
 * Local-calendar key (YYYY-MM-DD) built from `Date.getFullYear/Month/Date` —
 * NOT `toISOString().slice(0,10)`, which rolls at UTC midnight and would
 * fire the date-change reminder a fixed number of hours off the user's
 * actual wall clock. Used as the equality comparison for the date-change
 * detector below; exported so the unit test can pin a deterministic key
 * for any synthetic `Date`.
 */
export function localDateKey(d: Date): string {
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, "0");
  const day = String(d.getDate()).padStart(2, "0");
  return `${y}-${m}-${day}`;
}

/**
 * Claude Code TUI parity (28-date-change-silent-reminder): when the local
 * calendar date rolls over mid-session, the harness silently injects an
 * ambient `<system-reminder>` updating the model's notion of "today" — and
 * tells it NOT to surface the rollover, on the assumption the user already
 * knows. The literal-string contract (matched here verbatim) is:
 *
 *   The date has changed. Today's date is now <date>. DO NOT mention this
 *   to the user explicitly because they are already aware.
 *
 * Returns the reminder body (without the wrapper tag) when `prevKey` differs
 * from the local-date key of `now`, or `null` when same-day (no rollover).
 *
 * Why prose `<date>` instead of just the key: a human-readable date matches
 * the CLI rendering and is what the model treats as "today" downstream.
 *
 * Pure helper — no Session lifecycle involved — exported so the unit test
 * can exercise same-day, next-day, and year-boundary cases without
 * constructing a Session.
 */
export function dateChangeReminderBody(prevKey: string, now: Date): string | null {
  const todayKey = localDateKey(now);
  if (todayKey === prevKey) return null;
  // Match the CLI's date rendering shape — full weekday + month + day + year
  // in the user's local time zone. `toDateString()` gives the same fields
  // the SDK's system prompt builder uses, keeping the model's two date
  // sources (start-of-session prompt + this nudge) phrased consistently.
  const today = now.toDateString();
  return (
    `The date has changed. Today's date is now ${today}. ` +
    "DO NOT mention this to the user explicitly because they are already aware."
  );
}

/**
 * Claude Code TUI parity (29-linter-modified-file-reminder): when a formatter
 * or linter rewrites a file Claude just wrote, the next turn carries an
 * ambient `<system-reminder>` telling Claude the post-write change was
 * intentional and not to revert it. The literal CLI prose (matched here
 * verbatim apart from the file-name interpolation) is:
 *
 *   <path> was modified, either by the user or by a linter. This change
 *   was intentional, so make sure to take it into account as you proceed
 *   (ie. don't revert it unless the user asks you to). Don't tell the
 *   user this, since they are already aware.
 *
 * One reminder per modified path, joined into a single block — the agent
 * sees the full list in one go without N separate wrappers (each of which
 * would be re-introduced + re-suppressed by `cleanReminders`). When no
 * paths changed, returns null and the caller skips queueing.
 *
 * Pure helper — no Session lifecycle — so the unit test can pin the
 * literal text without constructing a Session.
 */
export function linterModifiedReminderBody(paths: readonly string[]): string | null {
  if (paths.length === 0) return null;
  return paths
    .map(
      (p) =>
        `${p} was modified, either by the user or by a linter. ` +
        "This change was intentional, so make sure to take it into account " +
        "as you proceed (ie. don't revert it unless the user asks you to). " +
        "Don't tell the user this, since they are already aware.",
    )
    .join("\n\n");
}

/**
 * Claude Code TUI parity (31-stale-todowrite-gentle-nudge): when several user
 * turns pass without Claude invoking TodoWrite, the harness drops an ambient
 * `<system-reminder>` suggesting the model either start tracking or prune a
 * stale list — and dumps the current todos inline so the model can see what's
 * there to clean up. Phrased as low-pressure, opt-out advice (the CLI's exact
 * wording, reproduced verbatim below).
 *
 *   The TodoWrite tool hasn't been used recently. If you're working on tasks
 *   that would benefit from tracking progress, consider using the TodoWrite
 *   tool to track progress. Also consider cleaning up the todo list if has
 *   become stale and no longer matches what you are working on. Only use it
 *   if it's relevant to the current work. This is just a gentle reminder -
 *   ignore if not applicable.
 *
 * When the latest snapshot has any todos, append a JSON dump so the model
 * can reason about pruning specific items. When it doesn't, the body still
 * fires unchanged — the prose's "if you're working on tasks…" clause covers
 * the no-todos case on its own.
 *
 * Pure helper — no Session lifecycle — so the unit test can pin the literal
 * prose contract without constructing a Session.
 */
export function staleTodoReminderBody(todos: readonly unknown[]): string {
  const base =
    "The TodoWrite tool hasn't been used recently. If you're working on " +
    "tasks that would benefit from tracking progress, consider using the " +
    "TodoWrite tool to track progress. Also consider cleaning up the todo " +
    "list if has become stale and no longer matches what you are working " +
    "on. Only use it if it's relevant to the current work. This is just a " +
    "gentle reminder - ignore if not applicable.";
  if (todos.length === 0) return base;
  // Dump the current list so the model can prune specific entries. JSON
  // keeps the shape stable for the agent and avoids guessing at a prose
  // rendering that would diverge from what TodoWrite's own input schema
  // expects on a follow-up call.
  return `${base}\n\nCurrent todos:\n${JSON.stringify(todos, null, 2)}`;
}

/**
 * Claude Code TUI parity (33-plan-mode-reentry-reminder): when the user
 * flips back into plan mode after a prior planning round in this session,
 * inject a `## Re-entering Plan Mode` reminder pointing at the previously
 * resolved plan so the model treats this as a fresh planning session rather
 * than assuming the old plan still applies. The CLI's verbatim header is:
 *
 *   ## Re-entering Plan Mode
 *   You are returning to plan mode after having previously exited it. A plan
 *   file exists at ${H.planFilePath} from your previous planning session.
 *
 * Claudius has no on-disk plan file — `ExitPlanMode` is reviewed in
 * `PlanOverlay` and the resolved text is otherwise discarded. We close the
 * gap by persisting the resolved plan text in the per-session JSON state
 * bag (`mergeSessionState`, key `priorPlan`) at `resolvePlan` time and
 * inlining it in the body here. The opening sentence matches the CLI; the
 * second sentence drops the `planFilePath` reference and points at the
 * inlined plan instead.
 *
 * Pure helper — no Session lifecycle — so the unit test can pin the prose
 * without constructing a Session.
 */
export function planModeReentryReminderBody(priorPlan: string): string {
  const head =
    "## Re-entering Plan Mode\n" +
    "You are returning to plan mode after having previously exited it. " +
    "A plan from your previous planning session is reproduced below — " +
    "treat this as a fresh planning round rather than assuming the prior " +
    "plan still applies.";
  return `${head}\n\nPrevious plan:\n${priorPlan}`;
}

/**
 * Claude Code TUI parity (34-auto-mode-exit-reminder): when the user
 * Shift+Tabs out of auto-accept mode, the CLI injects a `## Exited Auto
 * Mode` reminder so the model loosens its assumption-making and starts
 * asking clarifying questions again. Prose is verbatim from the CLI's
 * handler — re-wording it would diverge from the parity surface.
 *
 * Stateless (no args, no per-session lookup), so unlike
 * `planModeReentryReminderBody` we can return a frozen constant — but we
 * keep the function shape for symmetry with the rest of the reminder
 * helpers and so the unit test can pin the literal prose without
 * importing a string export.
 */
export function autoModeExitReminderBody(): string {
  return (
    "## Exited Auto Mode\n" +
    "You have exited auto mode. The user may now want to interact more " +
    "directly. You should ask clarifying questions when the approach is " +
    "ambiguous rather than making assumptions."
  );
}

/**
 * Claude Code TUI parity (39-verify-plan-reminder): after the agent finishes
 * executing an accepted plan, fire a one-shot reminder that nudges it to
 * verify the plan items inline — in the same context that holds the plan's
 * state, tool history, and edited files — rather than handing verification
 * off to a sub-agent that would lose that grounding.
 *
 * Adaptation note: the CLI's binary string reads
 *   `You have completed implementing the plan. Please call the "" tool
 *    directly (NOT the \n tool or an agent) to verify…`
 * where `""` and `\n` are decompiler artifacts marking interpolation slots
 * for a verification-tool name and the literal word `Task`. Claudius has
 * no first-class "verify" tool, so we drop the slot and keep the two
 * load-bearing instructions verbatim ("You have completed implementing
 * the plan." / "verify that all plan items were completed correctly"),
 * plus the inline-not-delegated directive mapped to Claudius's real
 * surface ("NOT via the Task tool or a subagent"). Same shape as the
 * feature-33 adaptation that dropped the CLI's on-disk `planFilePath`.
 *
 * Stateless helper (no Session lifecycle) so the unit test can pin the
 * literal prose without constructing a Session.
 */
export function verifyPlanReminderBody(): string {
  return (
    "You have completed implementing the plan. Verify that all plan " +
    "items were completed correctly by checking the work directly in " +
    "this session, NOT via the Task tool or a subagent — the parent " +
    "context already holds the plan's state, tool history, and edited " +
    "files that a fresh sub-agent would lose."
  );
}

/**
 * Claude Code TUI parity (37-midturn-message-inject-reminders): when the user
 * sends a follow-up message while a turn is still in flight, the CLI wraps
 * the inject with a forceful "MUST address" directive plus an explicit
 * "this is an automated reminder, not user acknowledgement" marker. The
 * goal is to keep the model from treating the late message as a fresh
 * acknowledgement of completed work — it's a new task the user wants
 * addressed once the current one wraps.
 *
 * Deviation from the CLI prose: the CLI says "address the user's message
 * **above**" because its inject lands after the user's text. Claudius
 * prepends the `<system-reminder>` (see `takePendingReminders` drain in
 * `sendInput`), so the user's text falls BELOW the wrapper — we phrase
 * accordingly. We also omit the peer/coordinator-only "NOT a message
 * from the user" framing: the message genuinely IS from the user; only
 * the directive to address it is automated. Mislabeling would be a
 * correctness error, not a wording quibble. The peer/coordinator variants
 * have no analogue in Claudius today (no multi-session coordination
 * wiring) so they are intentionally not modelled here.
 *
 * Stateless (no args, frozen constant) so unlike `planModeReentryReminderBody`
 * we can return a literal — same shape as `autoModeExitReminderBody`.
 */
export function midturnInjectReminderBody(): string {
  return (
    "The user sent the message that follows while you were still working on " +
    "the previous turn. After completing your current task, you MUST " +
    "address that message. Do not ignore it. This is an automated " +
    "reminder — the user has NOT acknowledged that the prior task is done."
  );
}

/**
 * Structured delta of MCP server transitions feeding `mcpDeltaReminderBody`.
 *
 * Each list is a set of server names — `added` for newly available servers
 * (just connected, just enabled, or just reconnect-requested), `removed` for
 * servers that fully disappear from the session (e.g. dropped via
 * `setMcpServers`), `disabled` for servers the user toggled off (kept in
 * config but no longer offering tools), `reconnecting` for servers whose
 * connection was just kicked but may still be `pending` (status race — see
 * `Session.reconnectMcp`). Callers populate only the fields that apply to
 * the user-initiated mutation that drove the transition; everything else
 * stays undefined and the body skips that clause.
 */
export type McpDelta = {
  added?: readonly string[];
  removed?: readonly string[];
  disabled?: readonly string[];
  reconnecting?: readonly string[];
};

/**
 * Claude Code TUI parity (35-mcp-agent-deferred-delta-reminders): when MCP
 * servers come online, drop off, get toggled, or are kicked for reconnect
 * mid-session, the CLI prepends an ambient `<system-reminder>` to the next
 * turn so the agent self-heals — its mental model of which tools are
 * available updates without the user having to spell it out. The CLI's
 * canonical guidance, reproduced here in spirit (Claudius has no deferred-
 * tool / ToolSearch indirection so we name the servers directly rather
 * than copying `select:<name>`):
 *
 *   The following MCP servers are now available: ...
 *   The following MCP servers are no longer available: ...
 *   Wait for connecting servers and search their tools once available.
 *   Do not report a capability as unavailable without first searching.
 *
 * Returns the reminder body (without the wrapper tag) when at least one
 * delta clause has content, or `null` when the delta is entirely empty
 * (no-op mutation — caller must not queue).
 *
 * Pure helper — no Session lifecycle — so the unit test can pin the
 * literal prose contract without constructing a Session.
 *
 * Scope note: this covers user-initiated MCP changes routed through
 * `Session.reconnectMcp` / `toggleMcp` / `setMcpServers`. Spontaneous
 * disconnects (e.g. server crash) and agent-type availability shifts
 * have no event signal in the SDK we wrap today, so they are not
 * detected — calling them out explicitly so the gap is intentional and
 * not a regression to chase.
 */
export function mcpDeltaReminderBody(delta: McpDelta): string | null {
  const added = (delta.added ?? []).filter((s) => s.length > 0);
  const removed = (delta.removed ?? []).filter((s) => s.length > 0);
  const disabled = (delta.disabled ?? []).filter((s) => s.length > 0);
  const reconnecting = (delta.reconnecting ?? []).filter((s) => s.length > 0);
  if (
    added.length === 0 &&
    removed.length === 0 &&
    disabled.length === 0 &&
    reconnecting.length === 0
  ) {
    return null;
  }
  const lines: string[] = [];
  if (added.length > 0) {
    lines.push(`The following MCP servers are now available: ${added.join(", ")}.`);
  }
  if (reconnecting.length > 0) {
    lines.push(
      "The following MCP servers were just reconnected and may still be " +
        `connecting: ${reconnecting.join(", ")}.`,
    );
  }
  if (disabled.length > 0) {
    lines.push(
      "The following MCP servers are no longer available (disabled by the " +
        `user): ${disabled.join(", ")}.`,
    );
  }
  if (removed.length > 0) {
    lines.push(
      "The following MCP servers are no longer available (removed from " +
        `this session): ${removed.join(", ")}.`,
    );
  }
  // CLI's wait-and-search guidance — load-bearing because it turns the
  // pending-status race in `reconnectMcp` into correct behavior: the
  // agent waits rather than declaring tools unavailable on a stale view.
  lines.push(
    "Wait for connecting servers and search their tools once available. " +
      "Do not report a capability as unavailable without first searching.",
  );
  return lines.join("\n");
}

/**
 * Per-file memory-directory write that drove the reminder. `op` mirrors the
 * three CRUD verbs the auto-memory route exposes; `path` is the absolute
 * on-disk path of the affected file (matched against the session's
 * `recentReadPaths` to compute `inContextPaths`).
 */
export type MemoryUpdate = { op: "created" | "updated" | "deleted"; path: string };

/**
 * Claude Code TUI parity (36-memory-update-staleness-reminder): when the
 * auto-memory directory is mutated mid-session, the CLI injects a
 * `memory_update` reminder so the agent knows its in-context copy of any
 * affected file is now stale and should be re-Read. The CLI's handler
 * surfaces three things — the source of the change, the list of paths
 * touched, and a conditional "your loaded copy of X is stale" clause that
 * only fires when at least one of the changed paths intersects what the
 * model has already Read this session.
 *
 * Claudius has a single write path (the `/api/memory/auto` route, driven by
 * the browser UI), so `source` is always "The user" rather than the CLI's
 * background-writer enum — fabricating extra source labels would diverge
 * from what actually happens. `inContextPaths` is best-effort: if the
 * intersection misses because of path normalization (symlinked homedir,
 * etc.) we still fire the reminder with the changed-files list, mirroring
 * the CLI's `if(H.inContextPaths.length>0)` gate on the staleness clause.
 *
 * Returns the body (without the `<system-reminder>` wrapper) when at least
 * one update is supplied, or `null` for an empty-updates call so callers
 * don't queue a no-op reminder.
 */
export function memoryUpdateReminderBody(
  updates: readonly MemoryUpdate[],
  inContextPaths: readonly string[],
): string | null {
  const valid = updates.filter((u) => u.path.length > 0);
  if (valid.length === 0) return null;
  const summary = valid
    .map((u) => `${u.op} ${u.path.split("/").pop() ?? u.path}`)
    .join(", ");
  const lines: string[] = [];
  lines.push(`The user updated your memory directory: ${summary}.`);
  lines.push(`Files changed: ${valid.map((u) => u.path).join(", ")}.`);
  const stale = inContextPaths.filter((p) => p.length > 0);
  if (stale.length > 0) {
    lines.push(
      `Your loaded copy of ${stale.join(", ")} is now stale relative to ` +
        "disk — Read it again if you need current contents.",
    );
  }
  return lines.join("\n");
}

type Subscriber = (event: ServerEvent) => void;

/**
 * Consecutive 529 "Overloaded" signals from Opus that trip the manual
 * `opus_overload_nudge` banner. Two in a row is enough — one-off retries are
 * normal during transient Anthropic capacity events, but two back-to-back
 * indicates the SDK's fallback retries aren't clearing the queue and the
 * user is going to keep waiting unless they switch models themselves. The
 * counter resets on any successful turn, so a single isolated overload
 * never burns a session against the cap.
 */
const OPUS_OVERLOAD_NUDGE_THRESHOLD = 2;

/**
 * Real user turns without a TodoWrite tool_use before `sendInput` queues a
 * `stale-todowrite` reminder. The CLI's exact threshold isn't documented, so
 * this number is a defensible approximation — high enough that a short
 * conversation never trips the nudge, low enough that a multi-turn refactor
 * gets a periodic poke. After firing, the counter rearms at 0 (the spec calls
 * this an "every N todo-silent turns" rhythm, not a once-per-session shot).
 */
const STALE_TODO_TURN_THRESHOLD = 15;

type PendingPermission = {
  requestId: string;
  resolve: (result: PermissionResult) => void;
  meta: PermissionRequestEvent;
};

type PendingAskQuestion = {
  requestId: string;
  toolUseId: string;
  questions: AskQuestion[];
  resolve: (result: PermissionResult) => void;
};

type PendingPlan = {
  requestId: string;
  toolUseId: string;
  plan: string;
  raw?: Record<string, unknown>;
  resolve: (result: PermissionResult) => void;
};

/**
 * Decide which slice of an event buffer to replay on attach.
 *
 * The naive "keep the last N top-level turns" sliding window has a known
 * failure mode in Claude Code sessions: a single user prompt can be
 * followed by 30+ assistant turns (one per tool round-trip), so `tail=20`
 * ends up showing only the bottom of an assistant chain with no visible
 * context for what was asked. After picking the naive start by turn count
 * we extend the window upward (smaller index) to always include the most
 * recent top-level USER turn. The 1000-event buffer cap upstream bounds
 * the worst-case replay size; in practice this adds at most a few dozen
 * events for the long-tool-chain case.
 *
 * Exported for unit testing — the slicing is pure and worth pinning down
 * separately from the Session lifecycle.
 *
 * @param buffer  Session events in chronological order.
 * @param tail    Conversation-turn budget (counts only top-level,
 *                non-subagent user/assistant SDK messages). `undefined`
 *                or `<= 0` means "replay everything".
 * @returns       `{ startIdx, hasMoreAbove }` — caller slices
 *                `buffer.slice(startIdx)` and forwards `hasMoreAbove` on
 *                the trailing `replay_done` so the client knows whether
 *                to show the "load older" affordance.
 */
export function computeReplayWindow(
  buffer: ReadonlyArray<ServerEvent>,
  tail: number | undefined,
): { startIdx: number; hasMoreAbove: boolean } {
  if (typeof tail !== "number" || tail <= 0) {
    return { startIdx: 0, hasMoreAbove: false };
  }
  const turnIdx: number[] = [];
  let latestUserTurnIdx = -1;
  let latestUserTurnSortKey: { at: number; idx: number } | null = null;
  for (let i = 0; i < buffer.length; i++) {
    const ev = buffer[i];
    if (ev.type !== "sdk") continue;
    const m = ev.message as {
      type?: string;
      parent_tool_use_id?: string | null;
      message?: { content?: unknown };
    };
    if (m.type !== "assistant" && m.type !== "user") continue;
    if (m.parent_tool_use_id) continue;
    turnIdx.push(i);
    // Only count REAL user prompts as user-turn anchors. Tool round-trips
    // in Claude Code emit a `user`-role SDK message whose content is a
    // `tool_result` block — those are bookkeeping, not user input, and
    // there are typically dozens of them between real prompts. If we
    // anchored on those we'd pin on the most recent tool result (already
    // inside the default tail) and the actual prompt would still get
    // dropped off the top — exactly the bug we're fixing here.
    if (m.type === "user" && isRealUserPrompt(m.message?.content)) {
      const at =
        typeof ev.at === "number" && Number.isFinite(ev.at)
          ? ev.at
          : -Infinity;
      if (
        !latestUserTurnSortKey ||
        at > latestUserTurnSortKey.at ||
        (at === latestUserTurnSortKey.at && i > latestUserTurnSortKey.idx)
      ) {
        latestUserTurnIdx = i;
        latestUserTurnSortKey = { at, idx: i };
      }
    }
  }
  const skip = Math.max(0, turnIdx.length - tail);
  if (skip === 0) {
    return { startIdx: 0, hasMoreAbove: false };
  }
  let startIdx = turnIdx[skip];
  // Anchor on the most recent user turn even when it sits before the
  // naive tail window — refresh/reattach on long sessions should land
  // with what was asked still in view, not at the bottom of a tool spew.
  if (latestUserTurnIdx >= 0 && latestUserTurnIdx < startIdx) {
    startIdx = latestUserTurnIdx;
  }
  return { startIdx, hasMoreAbove: startIdx > 0 };
}

/**
 * Reorder `sdk` events in a replay slice into chronological order by their
 * `at` epoch ms. Non-sdk events (ready, session_title, mode_changed, etc.)
 * stay anchored at their original buffer index so control-plane ordering
 * isn't perturbed. Stable on tied `at` values — original index breaks ties
 * so multiple splits of one assistant message keep their emission order.
 * Events with no `at` are treated as 0 (so they fall to the start), which
 * is fine because every disk-replay and live broadcast path stamps `at`.
 *
 * Returns the same reference when no reordering would happen so subscribers
 * that read from the buffer don't pay needlessly.
 *
 * Exported for unit testing.
 */
export function orderSdkEventsChronologically(
  events: ReadonlyArray<ServerEvent>,
): ServerEvent[] {
  if (events.length <= 1) return events.slice();
  const sdkPositions: number[] = [];
  for (let i = 0; i < events.length; i++) {
    if (events[i].type === "sdk") sdkPositions.push(i);
  }
  if (sdkPositions.length <= 1) return events.slice();
  const sdkSorted = sdkPositions.slice().sort((a, b) => {
    const at_a = (events[a] as { at?: number }).at ?? 0;
    const at_b = (events[b] as { at?: number }).at ?? 0;
    if (at_a !== at_b) return at_a - at_b;
    return a - b;
  });
  let changed = false;
  for (let i = 0; i < sdkPositions.length; i++) {
    if (sdkSorted[i] !== sdkPositions[i]) {
      changed = true;
      break;
    }
  }
  if (!changed) return events.slice();
  const out = events.slice();
  for (let i = 0; i < sdkPositions.length; i++) {
    out[sdkPositions[i]] = events[sdkSorted[i]];
  }
  return out;
}

/**
 * Gate for the noisy `[sess-load]` logs around session start / subscribe /
 * resync. Enabled via `CLAUDIUS_DEBUG_SESSIONS=1` so we can ask a user
 * who's hitting the "old session is empty until I refresh" bug to set
 * the env var, repro, and send the server stdout. Hot-path-safe — a
 * single env-var read on the boolean coercion.
 */
function sessLoadDebug(): boolean {
  return !!process.env.CLAUDIUS_DEBUG_SESSIONS;
}

/**
 * Resolve the freshest session title from the *trusted* sources only.
 *
 * Precedence:
 *   1. `local`      — our DB row, set explicitly via `setSessionTitle`.
 *                     The user typed it in Claudius and we own this storage.
 *   2. `info.customTitle` — the SDK's persisted title (TUI `/rename`, or
 *                     the SDK's auto-derived `aiTitle` — it folds aiTitle
 *                     into the returned `customTitle` field).
 *   3. `null`       — caller leaves `this.title` empty and the UI falls
 *                     back to the id-prefix label (`tabLabelFor`).
 *
 * We deliberately do NOT fall back to `info.summary`. The SDK computes
 * that field as `customTitle || aiTitle || lastPrompt || summaryHint ||
 * firstPrompt`, so whenever neither customTitle nor aiTitle is set, the
 * "title" we'd surface is the user's latest (or first) prompt text. The
 * user reported this multiple times — they don't want a prompt sentence
 * masquerading as a session name. If the user wants a label they use
 * /rename, otherwise the id-prefix is the correct affordance.
 *
 * Exported for unit testing.
 *
 * @param local  Title from the per-project SQLite index, or null.
 * @param info   SDK session info (`customTitle`), or null. The `summary`
 *               field is accepted on the input type for forward-compat
 *               but intentionally not read.
 * @returns      The title to surface, or null when there's no trusted
 *               source. Caller treats null as "leave `this.title` alone
 *               and let the UI render the id prefix".
 */
export function resolveSessionTitle(opts: {
  local: string | null | undefined;
  info: { customTitle?: string | null; summary?: string | null } | null | undefined;
}): string | null {
  const localTrim = opts.local?.trim();
  if (localTrim) return localTrim;
  const customTrim = opts.info?.customTitle?.trim();
  if (customTrim) return customTrim;
  return null;
}

export class Session {
  readonly id: string;
  readonly cwd: string;
  /**
   * Active model id. Mutable — `setModel` flips it mid-session and the
   * picker UI relies on this being the source-of-truth so the next
   * `start()` (e.g. on resume) uses the latest pick.
   */
  model?: string;
  /**
   * Main-thread agent name (SDK Options.agent). When set, the SDK applies the
   * agent's system prompt, tool restrictions, and model to the main
   * conversation. Set at construction from the session-create request /
   * workspace default; the agent must exist (file under .claude/agents).
   */
  readonly agent?: string;
  /**
   * Hard spend cap (USD) for this session — SDK Options.maxBudgetUsd. The SDK
   * stops the turn with an `error_max_budget_usd` result once exceeded. Set at
   * construction from the create request / workspace default; undefined = no cap.
   */
  readonly maxBudgetUsd?: number;
  /**
   * Soft token budget the model paces against (Options.taskBudget.total).
   * Advisory — the model is told its remaining budget but isn't force-stopped.
   * Undefined/0 ⇒ no hint.
   */
  readonly taskBudgetTokens?: number;
  /**
   * Hard cap on agentic turns (Options.maxTurns). The query stops at the cap.
   * Undefined/0 ⇒ no turn cap.
   */
  readonly maxTurns?: number;
  /**
   * Fallback model id — SDK Options.fallbackModel. The SDK switches to this
   * when the primary model is unavailable / errors. Undefined = no fallback.
   */
  readonly fallbackModel?: string;
  /**
   * Run shell commands in a sandbox — when true, the Options.sandbox config
   * forwarded to the SDK enables sandboxing with autoAllowBashIfSandboxed and
   * failIfUnavailable: false (graceful macOS degradation).
   */
  readonly sandboxEnabled?: boolean;
  /**
   * Enable the 1M-token context window beta — when true the Options.betas
   * array carries `context-1m-2025-08-07`. Sonnet 4/4.5 only; off by default.
   */
  readonly enable1mContext?: boolean;
  /**
   * Persist this session to disk (Options.persistSession). Undefined/true ⇒
   * persisted (SDK default). Only `false` is forwarded, making the session
   * ephemeral (not saved, not resumable).
   */
  readonly persistSession?: boolean;
  /**
   * Additional absolute directories the agent may access beyond cwd
   * (Options.additionalDirectories). Empty/undefined ⇒ cwd only.
   */
  readonly additionalDirectories?: string[];
  /**
   * Extra instructions appended to the default Claude Code system prompt
   * (Options.systemPrompt preset + append). Undefined/empty ⇒ unmodified preset.
   */
  readonly systemPromptAppend?: string;
  /**
   * Custom plan-mode workflow body (Options.planModeInstructions). Applies when
   * the session is in plan mode. Undefined/empty ⇒ the default plan workflow.
   */
  readonly planModeInstructions?: string;
  readonly resumeFrom?: string;
  readonly resumeAt?: string;
  /**
   * Human-readable display title. Resolved by `resolveSessionTitle`:
   *   1. Our DB row (set via `setSessionTitle` on user rename)
   *   2. The SDK's `customTitle` (TUI rename / auto-derived `aiTitle`)
   *   3. As a *first-time-only* fallback when the title is still empty,
   *      the SDK's `summary` field — never used to overwrite an existing
   *      title, because `summary` falls back to the last user prompt.
   */
  title?: string;
  private permissionMode: PermissionMode;

  private inputQueue = new AsyncQueue<SDKUserMessage>();
  private query: Query | null = null;
  private abortController = new AbortController();

  private buffer: ServerEvent[] = [];
  private bufferTrimmed = false;
  private subscribers = new Set<Subscriber>();
  private subscriberCountListeners = new Set<(count: number) => void>();
  private pendingPermissions = new Map<string, PendingPermission>();
  private pendingAskQuestions = new Map<string, PendingAskQuestion>();
  private pendingPlans = new Map<string, PendingPlan>();
  private done = false;
  // True once a real user prompt has been pushed in THIS process. Gates the
  // feedback-survey nudge so we never survey scheduled-loop / resumed /
  // automated sessions where the human never typed (mirrors the bus's
  // `lastUserInputAt` gate for idle notifications).
  private sawUserInput = false;
  // True between the user pushing input and the SDK emitting the matching
  // `result` event. Surfaced via `getStatus()` so the SessionTabs strip can
  // paint a "running" dot on non-active tabs whose live SSE isn't bound to
  // this client — without it the inactive tabs are forever "background".
  private turnInFlight = false;
  // Last `turn_status` value broadcast over SSE. `broadcastTurnStatusIfChanged`
  // compares `getStatus()` against this and emits only on transitions so we
  // don't flood the wire with redundant events (every pending-map mutation
  // calls into the helper).
  private lastBroadcastStatus: "running" | "idle" | null = null;
  // Watches `~/.claude/projects/<encoded-cwd>/` for changes to this
  // session's JSONL so external writers (`claude --resume <id>` in the
  // terminal) trigger a live resync instead of waiting for a refresh.
  private jsonlWatcher: FSWatcher | null = null;
  private jsonlResyncTimer: ReturnType<typeof setTimeout> | null = null;
  /**
   * Paths the model has Read this session. After every `compact_boundary`
   * message we replay them through `query.seedReadState(path, mtime)` so the
   * CLI's readFileState cache (which compaction strips) is repopulated and a
   * subsequent Edit doesn't fail "file not read yet" (B2.3).
   *
   * Accumulated across the session lifetime; seedReadState is idempotent for
   * the same path+mtime so reposting earlier reads after later compactions is
   * safe. We never remove entries — a file the model already touched stays in
   * the set even if it's later deleted on disk, because the re-seed pass
   * skips paths whose stat fails.
   */
  private recentReadPaths: Set<string> = new Set();
  // Set to true while resyncFromDisk is in flight, so a watch event that
  // arrives during the sync doesn't stack up redundant work.
  private jsonlResyncBusy = false;
  /**
   * Loops / wake-ups the agent has armed via the harness-provided
   * `CronCreate` and `ScheduleWakeup` tools. Mirrored from the SDK message
   * stream in `consume()` and exposed via `getScheduledLoops()` so the
   * `/schedule` page can show them across every open session (not just the
   * one the user is looking at).
   *
   * Map keyed by **stable loop id** — the cron id from CronCreate's result
   * (or, for wake-ups, the tool_use_id of the call). A separate pending
   * map keyed by tool_use_id lets us promote a CronCreate to the real id
   * once the result lands.
   *
   * Lives only as long as this Session object — when SessionManager
   * evicts us, the whole instance is GC'd and the loops vanish (which is
   * correct: the agent runtime dies with the session, so the crons it
   * armed die with it). No persistence layer.
   */
  private scheduledLoops = new Map<string, SessionLoop>();
  private pendingScheduledLoops = new Map<string, SessionLoop>();

  /**
   * Set once `consume()` has seen the thinking-block replay 400 for this
   * query lifetime and scheduled an auto-recovery, so a single poisoned turn
   * (which the SDK may surface more than once) triggers at most one rebuild.
   * See `runThinkingReplayRecovery` and `thinking-replay-recovery.ts`.
   */
  private thinkingReplayRecoveryScheduled = false;

  /**
   * Count of consecutive 529 "Overloaded" signals observed from Opus during
   * `consume()` (synthetic assistant API-error messages, error_during_execution
   * result rows, or thrown errors in the catch block). Reset to 0 on any
   * `result` of `subtype: "success"`. When the counter trips the threshold
   * below we fire a one-shot `opus_overload_nudge` SSE event prompting the
   * user to switch to Sonnet via the model picker — distinct from the SDK's
   * automatic `fallbackModel` path which swaps silently. See
   * `opus-overload-detector.ts` for the signal definition.
   */
  private opusOverloadStreak = 0;
  /** True once the threshold has fired this session — fire-once per session. */
  private opusOverloadNudgeFired = false;
  /**
   * Per-turn dedupe for the overload counter. A single failed overload turn
   * can emit BOTH a synthetic assistant "API Error: 529" message AND an
   * `error_during_execution` result row — counting both would trip the
   * threshold on the first hard overload instead of after repeated ones.
   * Flipped true on the first matching signal of a turn; cleared on the
   * next `result` message (which marks the turn boundary regardless of subtype).
   */
  private opusOverloadCountedThisTurn = false;

  /**
   * Fire-once gate for the long-context credits-required nudge (Claude Code
   * TUI parity). Trips when this session is running with the 1M-context beta
   * enabled and the SDK emits an assistant message tagged `billing_error` —
   * the dual-remediation banner ("/usage-credits" + "/model") then renders
   * client-side. Resets on session lifetime only: re-emission inside one
   * session would just re-pop a dismissed banner.
   */
  private longContextCreditsNudgeFired = false;

  /**
   * Per-session goal (see `/goal`, GoalBanner). Loaded from the per-project
   * DB on `start()` so it survives reload + resume. `null` goal means none is
   * set. Achievement is sticky until the user clears or replaces the goal.
   */
  private goal: SessionGoal = {
    goal: null,
    achieved: false,
    summary: null,
    setAt: null,
    achievedAt: null,
  };
  /**
   * Whether the agent has been told about the *current* goal. The SDK query
   * is created once with a fixed system prompt (line ~`start()`), so a goal
   * set mid-session can't ride the system-prompt append — instead the next
   * real user turn carries a one-shot `<session-goal>` reminder. A goal that
   * existed at `start()` (resumed session) rides the system prompt, so it's
   * marked announced and skips the turn injection.
   */
  private goalAnnounced = false;

  /**
   * Local-calendar date the agent last saw, in `YYYY-MM-DD` LOCAL form
   * (see `localDateKey`). Initialized lazily on the first real user turn
   * — so the very first prompt of a session never fires the rollover
   * reminder (the SDK system prompt already carries today's date) — and
   * compared on every subsequent turn. When it differs from today's local
   * key, `sendInput` queues a `date-change` reminder mirroring the CLI's
   * ambient nudge and updates the field to today's key.
   *
   * Intentionally NOT persisted via `mergeSessionState`: every `start()`
   * (including resume) rebuilds the system prompt with today's date, so a
   * persisted yesterday key would fire a spurious rollover on every
   * next-day resume. In-memory only means the worst case is a missed
   * fire when a session is restarted across midnight — which is harmless
   * because the fresh system prompt already covered the change.
   */
  private lastSeenLocalDate: string | null = null;

  /**
   * Post-Edit/Write file-content hashes, keyed by absolute path. Populated by
   * the programmatic `PostToolUse` hook (last write wins per path) and
   * consumed at the next user turn's `takePendingReminders` drain site:
   * any path whose current on-disk SHA-256 differs from the stored hash
   * has been rewritten between turns — almost always a formatter or linter
   * that ran in a user's `PostToolUse` command-hook, or a manual user edit.
   * Either way the CLI parity behavior is the same: queue a
   * `linter-modified-file` reminder telling the model the post-write
   * change was intentional.
   *
   * In-memory (not persisted via `mergeSessionState`): the lifetime is
   * "between this Edit and the next user turn", and persisting hashes
   * across a server restart would either fire stale reminders against
   * files the user has since touched on their own or DB-write on every
   * Edit. WeakMap-style scope to `this` matches the system-reminders
   * queue and the `latestTodosSnapshot` field.
   */
  private postWriteSnapshots = new Map<string, string>();

  /**
   * Real-user-turn counter since the model last invoked TodoWrite. Incremented
   * in `sendInput` (after the slash-command early-return so e.g. `/compact`
   * doesn't burn a turn) and reset to 0 in `captureSnapshotState` whenever a
   * TodoWrite tool_use lands. When it crosses `STALE_TODO_TURN_THRESHOLD`,
   * `sendInput` queues a `stale-todowrite` reminder and resets the counter
   * back to 0 so a long todo-silent stretch produces a periodic nudge rather
   * than every-turn spam.
   *
   * Intentionally NOT persisted via `mergeSessionState`: the lifecycle is
   * "current run only" (same reasoning as `lastSeenLocalDate` above —
   * persisting risks spurious fires on resume, and would cost a DB write
   * per turn). The TaskCreate / TaskUpdate flow is a *separate* parity
   * feature ("stale-task-tools", already in the `ReminderKind` union), so
   * those tools deliberately do NOT reset this counter.
   */
  private turnsSinceTodoWrite = 0;

  /**
   * One-shot flag for the post-plan-execution verify reminder (Claude Code TUI
   * parity, feature 39). Set true in `resolvePlan`'s accept branch and cleared
   * when the next `result` event lands in `consume()`, where we queue the
   * `verify-plan` reminder to ride the *following* user turn. Gating on the
   * turn boundary (not at accept time) means a mid-execution mid-turn inject
   * can't carry the reminder prematurely — the soonest it can fire is the
   * turn after execution actually completed.
   *
   * In-memory only (not persisted via `mergeSessionState`): "you just executed
   * the plan you accepted in this run" is a current-run concept, distinct from
   * the persistent `priorPlan` we keep for plan-mode re-entry. Worst case on a
   * server restart between accept and result is a missed nudge — strictly
   * better than a spurious one against a freshly resumed session.
   *
   * Accepted limitation: if plan execution genuinely spans multiple
   * assistant/user turns (rare — usually the agent runs the whole plan inline
   * and the user just watches), this fires after the *first* turn boundary
   * rather than at true plan-end. There is no decidable "plan fully done"
   * signal on the SDK side, so first-boundary is the honest approximation.
   */
  private planAwaitingVerify = false;

  /**
   * User-scope `settings.json` config for the spinner-tip rotation (CLI parity:
   * `spinnerTipsEnabled` / `spinnerTipsOverride`). Cached at `start()` because
   * the per-subscriber `subscribe()` path emits the `tips` SSE event on every
   * reconnect — re-reading settings there would mean a disk read per attach.
   * Settings changes take effect on the next session start, matching how the
   * other settings-backed Options (promptSuggestionEnabled, includeCoAuthoredBy)
   * already behave.
   */
  private spinnerTipsConfig: {
    enabled?: boolean;
    override?: { excludeDefault?: boolean; tips?: readonly string[] };
  } = {};

  constructor(opts: {
    id?: string;
    cwd?: string;
    model?: string;
    agent?: string;
    maxBudgetUsd?: number;
    taskBudgetTokens?: number;
    maxTurns?: number;
    fallbackModel?: string;
    sandboxEnabled?: boolean;
    enable1mContext?: boolean;
    persistSession?: boolean;
    additionalDirectories?: string[];
    systemPromptAppend?: string;
    planModeInstructions?: string;
    permissionMode?: PermissionMode;
    resume?: string;
    resumeSessionAt?: string;
  }) {
    // When resuming, the server-side Session.id MUST equal the SDK's session
    // id (the resumed conversation's id) — otherwise user messages we push
    // through the input queue carry a `session_id` that the SDK doesn't
    // recognize, and it errors with "No conversation found with session ID".
    const requestedId = opts.id ?? opts.resume ?? randomUUID();
    // Session ids flow into the JSONL filename (`<id>.jsonl`) and into the
    // per-session DB rows, so reject anything that could escape the
    // projects dir or contain path separators. Real SDK ids are UUIDs;
    // accept the broader `[\w-]+` to keep tests/fixtures working.
    if (!/^[\w-]+$/.test(requestedId)) {
      throw new Error("invalid session id");
    }
    this.id = requestedId;
    this.cwd = opts.cwd ?? process.cwd();
    this.model = opts.model;
    this.agent = opts.agent;
    this.maxBudgetUsd = opts.maxBudgetUsd;
    this.taskBudgetTokens = opts.taskBudgetTokens;
    this.maxTurns = opts.maxTurns;
    this.fallbackModel = opts.fallbackModel;
    this.sandboxEnabled = opts.sandboxEnabled;
    this.enable1mContext = opts.enable1mContext;
    this.persistSession = opts.persistSession;
    this.additionalDirectories = opts.additionalDirectories;
    this.systemPromptAppend = opts.systemPromptAppend;
    this.planModeInstructions = opts.planModeInstructions;
    this.permissionMode = opts.permissionMode ?? "default";
    this.resumeFrom = opts.resume;
    this.resumeAt = opts.resumeSessionAt;
  }

  async start(): Promise<void> {
    if (this.query) return;

    // The SDK's `resume` option loads the conversation into the model's
    // context but does NOT re-emit historical events to our consumer
    // iterable. Read them from disk via `getSessionMessages` and broadcast
    // each into our buffer so SSE subscribers replay the full transcript.
    if (this.resumeFrom) {
      try {
        const loaded = await getSessionMessages(this.resumeFrom, {
          dir: this.cwd,
          includeSystemMessages: true,
        });
        // When resuming at a specific message (auto-recovery rewind — see
        // `thinking-replay-recovery.ts`), the SDK query is truncated to
        // `resumeAt` via Options.resumeSessionAt, but getSessionMessages has
        // no by-uuid cutoff, so the raw load still carries the dropped tail
        // (including the poisoned turn). Slice the replay to match so the chat
        // buffer reflects what the model actually sees. `resumeAt` is unset for
        // ordinary resumes, so this is a no-op there. If the uuid isn't found,
        // fall back to the full load rather than blank the history.
        let historical = loaded;
        if (this.resumeAt) {
          const cut = loaded.findIndex(
            (m) => (m as { uuid?: string }).uuid === this.resumeAt,
          );
          if (cut >= 0) historical = loaded.slice(0, cut + 1);
        }
        if (sessLoadDebug()) {
           
          console.log("[sess-load] start.resume loaded historical", {
            id: this.id,
            resumeFrom: this.resumeFrom,
            cwd: this.cwd,
            count: historical.length,
          });
        }
        // Carry-forward timestamp for assistants. JSONL only stamps user
        // records, so without this every historical assistant would fall
        // through to broadcast()'s `Date.now()` default — clustering every
        // resumed assistant at the time of resume and breaking any
        // downstream chronological sort. Inherit the most-recent preceding
        // user timestamp + 1ms-per-step so successive assistants in a turn
        // stay in their original order.
        let carriedAt: number | undefined;
        for (const m of historical) {
          const ts = (m as { timestamp?: string }).timestamp;
          const parsed = typeof ts === "string" ? Date.parse(ts) : NaN;
          let at: number | undefined;
          if (Number.isFinite(parsed)) {
            at = parsed;
            carriedAt = parsed;
          } else if (typeof carriedAt === "number") {
            carriedAt = carriedAt + 1;
            at = carriedAt;
          }
          const sdk = m as unknown as SDKMessage;
          this.broadcast({ type: "sdk", message: sdk, at });
          // Replay disk-resident tool_use / tool_result blocks through the
          // loop tracker too — without this, a session resumed from JSONL
          // would have a populated client rail (which observes the rebroadcast
          // SSE events) but an empty server-side store, breaking
          // `/api/schedule/session-loops` for any pre-existing loops.
          // Pass `at` so the entry's `startedAt` is the original arming
          // time from the JSONL timestamp, not the moment of replay.
          this.trackScheduledLoops(sdk, at);
        }
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        if (sessLoadDebug()) {

          console.warn("[sess-load] start.resume loadHistorical FAILED", {
            id: this.id,
            resumeFrom: this.resumeFrom,
            cwd: this.cwd,
            err: message,
          });
        }
        this.broadcast({ type: "error", message: `Failed to load session history: ${message}` });
      }
      // Pull the persisted title. Our index is authoritative because it
      // works even for sessions that haven't completed a turn yet (the
      // SDK's customTitle requires a JSONL on disk). Fall back to the SDK's
      // metadata if we have nothing locally — this picks up titles authored
      // in another client (e.g. the TUI's `/rename`). See
      // `resolveSessionTitle` for the precedence — we never derive a title
      // from prompt text.
      try {
        const local = await getSessionTitle(this.cwd, this.resumeFrom);
        const info = local ? null : await getSessionInfo(this.resumeFrom, { dir: this.cwd });
        const next = resolveSessionTitle({ local, info });
        if (next) this.title = next;
      } catch {
        // non-fatal — header just shows the prefix fallback
      }
    } else {
      // Even for fresh (non-resume) sessions, check our index in case
      // the user renamed this session id in a previous boot of Claudius.
      try {
        const local = await getSessionTitle(this.cwd, this.id);
        if (local) this.title = local;
      } catch {
        // ignore
      }
    }

    // Upsert into the per-project sessions index so the row exists from
    // the moment the session is bound, regardless of whether the SDK has
    // written a JSONL yet.
    try {
      await upsertSession({
        id: this.id,
        cwd: this.cwd,
        model: this.model,
        title: this.title,
      });
    } catch {
      // non-fatal — index is for listing; the session still works without it
    }

    // Pull the persisted goal so it survives reload + resume. A goal present
    // at start rides the system-prompt append built below, so mark it
    // announced — the one-shot turn reminder is only for goals set mid-session.
    try {
      this.goal = await getSessionGoal(this.cwd, this.id);
      this.goalAnnounced = this.goal.goal !== null;
    } catch {
      // non-fatal — session works without a goal
    }

    // Resolve user-scope settings that map onto SDK Options. Best-effort:
    // a missing/invalid file yields `{}` so we fall back to defaults. Mirrors
    // the `feedbackSurveyRate` read in `maybeOfferFeedbackSurvey`.
    const userSettings = await readSettings("user", this.cwd).catch(
      () => ({}) as ClaudeSettings,
    );
    // Cache the spinner-tips knobs so the per-subscriber `subscribe()` path
    // can compose them into `selectTips()` without a disk read on every
    // attach. See the `spinnerTipsConfig` field for the rationale.
    this.spinnerTipsConfig = {
      enabled:
        typeof userSettings.spinnerTipsEnabled === "boolean"
          ? userSettings.spinnerTipsEnabled
          : undefined,
      override:
        userSettings.spinnerTipsOverride &&
        typeof userSettings.spinnerTipsOverride === "object" &&
        !Array.isArray(userSettings.spinnerTipsOverride)
          ? {
              excludeDefault:
                userSettings.spinnerTipsOverride.excludeDefault === true,
              tips: Array.isArray(userSettings.spinnerTipsOverride.tips)
                ? userSettings.spinnerTipsOverride.tips.filter(
                    (t): t is string => typeof t === "string",
                  )
                : undefined,
            }
          : undefined,
    };

    // Unify everything that appends to the Claude Code system-prompt preset
    // into ONE `systemPrompt.append`. Two sources can contribute: the session
    // goal (authoritative objective) and the workspace `systemPromptAppend`
    // (house-style steering). They must merge — emitting `systemPrompt` twice
    // in the Options literal would make the later key silently clobber the
    // earlier (object-literal duplicate-key semantics), dropping one of them.
    const combinedSystemPromptAppend = joinSystemPromptAppends([
      this.goal.goal ? this.goalSystemPromptAppend() : "",
      this.systemPromptAppend,
    ]);

    // DB-backed programmatic subagents for this workspace (A-P3.8). Fed to the
    // SDK via Options.agents; undefined when none, so the file-based agents
    // path is untouched. Best-effort — a DB read failure just yields no
    // programmatic agents rather than blocking session start.
    const dbAgents = await loadDbAgentsForOptions(this.cwd).catch(() => undefined);

    const options: Options = {
      cwd: this.cwd,
      model: this.model,
      // In-process MCP server exposing a single tool the agent calls to
      // report that the session goal is done (see `/goal`, GoalBanner). The
      // tool runs in this process, so its handler can broadcast straight to
      // SSE subscribers. Registered unconditionally — harmless when no goal is
      // set (the agent is only told to use it when a goal exists).
      mcpServers: { claudius_goal: this.buildGoalMcpServer() },
      // Single system-prompt spread combining the session goal + workspace
      // systemPromptAppend (see `combinedSystemPromptAppend` above). Omitted
      // entirely when neither is set, so the no-extras path stays byte-identical
      // to the SDK default.
      ...(combinedSystemPromptAppend
        ? {
            systemPrompt: {
              type: "preset" as const,
              preset: "claude_code" as const,
              append: combinedSystemPromptAppend,
            },
          }
        : {}),
      // DB-backed programmatic subagents (A-P3.8). Merged into the agent set
      // the model can invoke via the Agent tool; programmatic agents take
      // precedence over same-named file-based ones. Omitted when there are
      // none so the file-only path is byte-identical to before.
      ...(dbAgents ? { agents: dbAgents } : {}),
      // Main-thread agent (SDK `--agent`). When set, the agent's system
      // prompt, tools, and model apply to the main conversation — note the
      // agent's own model takes precedence over `model` above. Omitted when
      // unset so the default agent is used.
      ...(this.agent ? { agent: this.agent } : {}),
      // Hard spend cap. When set, the SDK stops the turn and returns an
      // `error_max_budget_usd` result once cumulative cost exceeds it. Only
      // forwarded when a positive number so 0/undefined means "no cap".
      ...(typeof this.maxBudgetUsd === "number" && this.maxBudgetUsd > 0
        ? { maxBudgetUsd: this.maxBudgetUsd }
        : {}),
      // Soft token budget the model paces against (advisory; doesn't force-stop
      // the turn the way maxBudgetUsd does). Only forwarded when positive.
      ...(typeof this.taskBudgetTokens === "number" && this.taskBudgetTokens > 0
        ? { taskBudget: { total: this.taskBudgetTokens } }
        : {}),
      // Hard cap on agentic turns — the query stops at the limit. Only
      // forwarded when positive so 0/undefined means "no turn cap".
      ...(typeof this.maxTurns === "number" && this.maxTurns > 0
        ? { maxTurns: this.maxTurns }
        : {}),
      // Fallback model — the SDK switches to this if the primary model is
      // unavailable or errors (overload, model_not_found). Omitted when unset.
      ...(this.fallbackModel ? { fallbackModel: this.fallbackModel } : {}),
      // Sandbox shell commands. autoAllowBashIfSandboxed avoids permission
      // hammering once the sandbox is on; failIfUnavailable:false lets it
      // degrade gracefully on macOS (no bubblewrap) rather than failing the
      // whole query. The SDK leaves the actual access policy to the existing
      // Bash/WebFetch permission rules.
      ...(this.sandboxEnabled
        ? {
            sandbox: {
              enabled: true,
              autoAllowBashIfSandboxed: true,
              failIfUnavailable: false,
            },
          }
        : {}),
      // 1M-token context window beta (Sonnet 4/4.5). Omitted unless explicitly
      // enabled — it raises cost substantially. The SDK ignores the beta on
      // models that don't support it, so gating is advisory (the WorkspaceForm
      // notes the Sonnet requirement).
      ...(this.enable1mContext ? { betas: ["context-1m-2025-08-07" as const] } : {}),
      // Ephemeral sessions: only forward persistSession when explicitly false
      // so the SDK's default (persist) is untouched otherwise.
      ...(this.persistSession === false ? { persistSession: false } : {}),
      // Extra directories the agent may read/write beyond cwd. Only forwarded
      // when non-empty so the default (cwd-only) is preserved otherwise.
      ...(this.additionalDirectories && this.additionalDirectories.length > 0
        ? { additionalDirectories: this.additionalDirectories }
        : {}),
      // (workspace systemPromptAppend is merged into the unified `systemPrompt`
      // spread above, alongside any session goal — see combinedSystemPromptAppend.)
      // Custom plan-mode workflow body. The SDK only consults this in plan
      // mode; harmless to pass otherwise. Omitted when empty so the default
      // plan workflow applies. Trimmed to treat whitespace-only as unset.
      ...(this.planModeInstructions && this.planModeInstructions.trim()
        ? { planModeInstructions: this.planModeInstructions }
        : {}),
      permissionMode: this.permissionMode,
      abortController: this.abortController,
      canUseTool: this.canUseTool,
      includePartialMessages: true,
      // Forward subagent text and thinking blocks as assistant/user
      // messages with `parent_tool_use_id` set. Without this, SDK 0.3.152+
      // only emits subagent `tool_use` / `tool_result` blocks (enough for a
      // heartbeat counter) — the TaskBlock would then never have any
      // inner-message content to expand into, leaving the user staring at
      // the "Subagent working…" placeholder for the full run. With this
      // flag the SDK forwards the full subagent conversation so the
      // expanded TaskBlock renders the nested transcript the same way the
      // top-level chat renders the parent.
      forwardSubagentText: true,
      // Ask the SDK to emit periodic AI-generated progress summaries for
      // running subagents (foreground + background). Every ~30s the SDK
      // forks the subagent to produce a short present-tense status (e.g.
      // "Analyzing authentication module"), delivered on `task_progress`
      // via the `summary` field — which the client threads onto TaskInfo
      // and the BackgroundTasksPanel renders. The fork reuses the
      // subagent's model + prompt cache, so cost is typically minimal.
      agentProgressSummaries: true,
      // Ask the SDK to emit a predicted next-user-prompt (`prompt_suggestion`
      // message) after each turn's result. The client already threads these
      // into `promptSuggestions` state and renders them as clickable chips
      // (PromptSuggestions). Suggestions ride the parent's prompt cache so
      // they're nearly free, and the SDK self-suppresses on the first turn,
      // after API errors, and in plan mode. On by default; users turn them off
      // via the SDK's `promptSuggestionEnabled` user setting (Settings → Chat,
      // or the env gate CLAUDE_CODE_ENABLE_PROMPT_SUGGESTION=false). The
      // `promptSuggestions` fallback honors files written before the rename.
      promptSuggestions:
        (userSettings.promptSuggestionEnabled ?? userSettings.promptSuggestions) !== false,
      // Honor the "Include Co-Authored-By" Git setting (Settings → Git).
      // It's a Settings-level flag, not a direct Option, so we forward it
      // through the inline `settings` object — the SDK doesn't auto-load
      // settings.json into this session. Absent → SDK default (trailer on).
      ...(typeof userSettings.includeCoAuthoredBy === "boolean"
        ? { settings: { includeCoAuthoredBy: userSettings.includeCoAuthoredBy } }
        : {}),
      // Track file edits so the user can rewind the working tree to its
      // state at any prior user message via Query.rewindFiles() (see the
      // `rewindFiles` method + POST /api/sessions/[id]/rewind). The SDK
      // snapshots files before each modification; cleanup follows the
      // `cleanupPeriodDays` setting (default 30d).
      enableFileCheckpointing: true,
      // Opt into adaptive extended thinking explicitly so the agent
      // emits the full reasoning text in `thinking` blocks. Without
      // this, recent SDK builds default to a `display: 'omitted'`
      // shape on short turns and the chat surface renders empty
      // Thinking blocks. Leaving `display` unset means "full text"
      // (the alternatives — 'summarized' / 'omitted' — both hide it).
      //
      // The chat verbosity selector (see `lib/shared/verbose.ts`) gates
      // whether `thinking` blocks render in the middle pane — but the SDK
      // setting stays at adaptive/full because the blocks still need to
      // arrive over the wire to be available for the "verbose" level and
      // the right-rail's Tools/thinking row. Hiding thinking is purely a
      // client-side filter.
      thinking: { type: "adaptive" },
      // Tell the model to emit HTML (not markdown) in option `preview` fields,
      // so the AskUserQuestion modal can render rich previews (mockups, code
      // snippets, configuration examples) directly in the browser. Default
      // is markdown, which the CLI shows in a monospace box.
      toolConfig: {
        askUserQuestion: { previewFormat: "html" },
      },
      // Observe the agent's working-directory transitions and surface a
      // "worktree" badge when it leaves the session root — otherwise the
      // user's "current changed files" won't reflect what the agent touched.
      //
      // Two signals feed `broadcastCwd` (deduped):
      //   1. `CwdChanged` — the SDK's own cwd move (fires when Claude Code
      //      spins up a worktree as part of normal operation).
      //   2. PreToolUse path heuristic — a mutating file tool whose target
      //      path lives under `<root>/.claude/worktrees/<name>/` means edits
      //      aren't landing in the user's checkout, so we flag the worktree.
      //      This is what catches harness-level `EnterWorktree`, which does
      //      NOT emit `CwdChanged`.
      //
      // DO NOT register a `WorktreeCreate`/`WorktreeRemove` hook to drive this.
      // Those are creation *extension points*, not observers: the SDK delegates
      // worktree creation to the hook and REQUIRES it to return
      // `hookSpecificOutput.worktreePath`. A passive `{ continue: true }`
      // handler makes `EnterWorktree` fail outright ("hook succeeded but
      // returned no worktree path"). Verified the hard way.
      //
      // Hooks return `{ continue: true }` so we never block the agent, and
      // programmatic hooks merge with any user settings.json hooks.
      hooks: {
        PreToolUse: [
          {
            hooks: [
              async (input) => {
                const pre = input as PreToolUseHookInput;
                // Worktree detection (signal #2 above).
                const ti = (pre.tool_input ?? {}) as {
                  file_path?: string;
                  notebook_path?: string;
                };
                const target = ti.file_path ?? ti.notebook_path;
                if (
                  typeof target === "string" &&
                  ["Edit", "Write", "MultiEdit", "NotebookEdit"].includes(
                    pre.tool_name ?? "",
                  )
                ) {
                  const wt = worktreeRootFromPath(target);
                  if (wt) this.broadcastCwd(wt);
                }
                return { continue: true };
              },
            ],
          },
        ],
        // Snapshot the on-disk content right after Claude finishes an
        // Edit/Write/MultiEdit/NotebookEdit so the next-turn drain in
        // `sendInput` can detect post-write rewrites by a formatter, linter,
        // or a manual user edit (CLI parity, feature 29-linter-modified-file).
        // We hash whatever is on disk now — for Edit/MultiEdit the SDK's
        // `tool_input` only carries `old_string→new_string` pairs, so a
        // disk read is the only way to capture "what Claude actually left".
        // Best-effort IO: missing/unreadable/binary files are silently
        // skipped (no entry stored ⇒ no reminder fires next turn).
        PostToolUse: [
          {
            hooks: [
              async (input) => {
                const post = input as PostToolUseHookInput;
                if (
                  !["Edit", "Write", "MultiEdit", "NotebookEdit"].includes(
                    post.tool_name ?? "",
                  )
                ) {
                  return { continue: true };
                }
                const ti = (post.tool_input ?? {}) as {
                  file_path?: string;
                  notebook_path?: string;
                };
                const target =
                  typeof ti.file_path === "string"
                    ? ti.file_path
                    : typeof ti.notebook_path === "string"
                    ? ti.notebook_path
                    : null;
                if (!target) return { continue: true };
                try {
                  const buf = await fsp.readFile(target);
                  const hex = createHash("sha256").update(buf).digest("hex");
                  // Last write wins per path: a subsequent edit in the same
                  // turn replaces the prior hash so the diff at next-turn
                  // drain reflects "post-last-write vs now".
                  this.postWriteSnapshots.set(target, hex);
                } catch {
                  // File gone, unreadable, or binary-special — leaving the
                  // map untouched means no false reminder fires next turn.
                }
                return { continue: true };
              },
            ],
          },
        ],
        CwdChanged: [
          {
            hooks: [
              async (input) => {
                const cwd = (input as CwdChangedHookInput).new_cwd;
                if (typeof cwd === "string" && cwd.length > 0) {
                  this.broadcastCwd(cwd);
                }
                return { continue: true };
              },
            ],
          },
        ],
      },
      // Pin the session id so the SDK names its on-disk JSONL with our id.
      // This makes Claudius web ids match the TUI: `claude --resume <id>`
      // resolves the same conversation. The SDK forbids `sessionId` together
      // with `resume` (it'd be ambiguous), so only set it for new sessions.
      ...(this.resumeFrom ? { resume: this.resumeFrom } : { sessionId: this.id }),
      ...(this.resumeAt ? { resumeSessionAt: this.resumeAt } : {}),
    };
    this.query = query({ prompt: this.inputQueue, options });
    this.broadcast({
      type: "ready",
      sessionId: this.id,
      ...(this.agent ? { agent: this.agent } : {}),
      ...(this.fallbackModel ? { fallbackModel: this.fallbackModel } : {}),
    });
    if (this.title) this.broadcast({ type: "session_title", title: this.title });
    if (this.goal.goal) this.broadcastGoal();
    if (sessLoadDebug()) {
       
      console.log("[sess-load] start.complete", {
        id: this.id,
        resumeFrom: this.resumeFrom ?? null,
        bufferLen: this.buffer.length,
        title: this.title ?? null,
      });
    }
    void this.consume();
    // Start watching the on-disk JSONL so external writers (CLI `claude
    // --resume <id>`) trigger a resync that broadcasts new turns to all
    // open browser tabs without a manual refresh.
    this.startJsonlWatcher();
  }

  private startJsonlWatcher(): void {
    if (this.jsonlWatcher) return;
    const dir = projectRoot(this.cwd);
    const target = `${this.id}.jsonl`;
    try {
      // Watch the parent directory rather than the file directly: the file
      // may not exist yet for a brand-new session, and atomic-rename writes
      // (some editors do this) replace the inode, breaking a file-level
      // watch. Filtering by filename in the listener gives us a reliable
      // signal regardless.
      this.jsonlWatcher = watchFs(dir, { persistent: false }, (_event, filename) => {
        if (filename !== target) return;
        this.scheduleJsonlResync();
      });
      this.jsonlWatcher.on("error", () => {
        // Best-effort — losing the watcher just means we're back to
        // refresh-driven resync. Don't crash the session.
        this.stopJsonlWatcher();
      });
    } catch {
      // Directory might not exist on first-ever boot; the SDK creates it
      // when it writes the session JSONL. The next subscribe() call still
      // does a best-effort resyncFromDisk, so we're not stuck.
    }
  }

  private stopJsonlWatcher(): void {
    if (this.jsonlResyncTimer) {
      clearTimeout(this.jsonlResyncTimer);
      this.jsonlResyncTimer = null;
    }
    if (this.jsonlWatcher) {
      try {
        this.jsonlWatcher.close();
      } catch {
        // ignore
      }
      this.jsonlWatcher = null;
    }
  }

  private scheduleJsonlResync(): void {
    // Coalesce bursty filesystem events. The SDK writes one JSONL line per
    // SDK message; a single user prompt produces several events back to
    // back. 200ms is comfortably below human-noticeable latency and well
    // above the OS event burst window.
    if (this.jsonlResyncTimer) clearTimeout(this.jsonlResyncTimer);
    this.jsonlResyncTimer = setTimeout(() => {
      this.jsonlResyncTimer = null;
      if (this.jsonlResyncBusy) {
        // Another sync is already running — re-arm so we pick up anything
        // that lands after it finishes.
        this.scheduleJsonlResync();
        return;
      }
      void this.resyncFromDisk();
    }, 200);
  }

  async rename(title: string): Promise<{ ok: true } | { ok: false; error: string }> {
    const trimmed = title.trim();
    if (!trimmed) return { ok: false, error: "title required" };
    // The sessions index is authoritative — it works regardless of whether
    // the SDK's JSONL exists yet. If this throws we fail the whole
    // operation; the user sees the error and the title doesn't change.
    // Best-effort mirror to the SDK so external clients (the CLI's
    // `/rename`, other tooling) see it too.
    try {
      await setSessionTitle(this.cwd, this.id, trimmed);
    } catch (err) {
      return { ok: false, error: err instanceof Error ? err.message : String(err) };
    }
    try {
      await renameSession(this.id, trimmed, { dir: this.cwd });
    } catch {
      // Non-fatal. The most common reason this fails is "no JSONL yet" for a
      // fresh session that hasn't completed a turn — once the SDK persists
      // the first turn, our local title remains the source of truth and a
      // future boot of any client reading both will see them in agreement.
    }
    this.title = trimmed;
    this.broadcast({ type: "session_title", title: trimmed });
    return { ok: true };
  }

  private canUseTool: CanUseTool = (toolName, input, ctx) => {
    return new Promise<PermissionResult>((resolve) => {
      const requestId = randomUUID();

      // ── Internal goal tool — auto-allow, never prompt ─────────────────
      // `mcp__claudius_goal__report_goal_achieved` is our own in-process
      // plumbing, not a user-facing action. Surfacing an Allow/Deny card for
      // it would gate the celebratory "goal achieved" banner behind a click
      // (and confuse the user with a tool they never installed). Resolve
      // straight to allow with the input untouched.
      if (toolName.startsWith("mcp__claudius_goal__")) {
        resolve({ behavior: "allow", updatedInput: input as Record<string, unknown> });
        return;
      }

      // ── ExitPlanMode is the model's "ready to execute" signal ─────────
      // Don't show the generic Allow/Deny card — surface the plan in our own
      // overlay so the user can read it and decide. Accepting flips the
      // session out of plan mode (handled in resolvePlan); rejecting sends
      // a deny message back so the model can iterate.
      if (toolName === "ExitPlanMode") {
        const planText =
          typeof (input as { plan?: unknown }).plan === "string"
            ? ((input as { plan: string }).plan)
            : JSON.stringify(input, null, 2);
        const pending: PendingPlan = {
          requestId,
          toolUseId: ctx.toolUseID,
          plan: planText,
          raw: input as Record<string, unknown>,
          resolve,
        };
        this.pendingPlans.set(requestId, pending);
        this.broadcast({
          type: "plan_approval_request",
          requestId,
          toolUseId: ctx.toolUseID,
          plan: planText,
          raw: input as Record<string, unknown>,
        });
        this.broadcastTurnStatusIfChanged();
        ctx.signal.addEventListener("abort", () => {
          const p = this.pendingPlans.get(requestId);
          if (!p) return;
          this.pendingPlans.delete(requestId);
          p.resolve({ behavior: "deny", message: "Aborted" });
          this.broadcastTurnStatusIfChanged();
        });
        return;
      }

      // ── AskUserQuestion is the model's interactive form ────────────────
      // Don't render the standard "Allow / Deny" permission card for it —
      // unpack the `questions` array and emit our own SSE event so the
      // browser shows the form. The user's selections come back via
      // submitAskAnswer(), which resolves this same promise with
      // updatedInput.answers — that's the shape the SDK feeds the model as
      // the tool's effective output.
      if (toolName === "AskUserQuestion") {
        const questions = parseAskQuestions(input);
        if (questions.length > 0) {
          const pending: PendingAskQuestion = {
            requestId,
            toolUseId: ctx.toolUseID,
            questions,
            resolve,
          };
          this.pendingAskQuestions.set(requestId, pending);
          this.broadcast({
            type: "ask_user_question",
            requestId,
            toolUseId: ctx.toolUseID,
            questions,
          });
          this.broadcastTurnStatusIfChanged();

          ctx.signal.addEventListener("abort", () => {
            const p = this.pendingAskQuestions.get(requestId);
            if (!p) return;
            this.pendingAskQuestions.delete(requestId);
            p.resolve({ behavior: "deny", message: "Aborted" });
            this.broadcastTurnStatusIfChanged();
          });
          return;
        }
        // Malformed input — fall through to the standard permission flow so
        // the user at least sees something, instead of silently hanging.
      }

      const meta: PermissionRequestEvent = {
        type: "permission_request",
        requestId,
        toolName,
        toolUseId: ctx.toolUseID,
        input,
        title: ctx.title,
        description: ctx.description,
        displayName: ctx.displayName,
      };
      this.pendingPermissions.set(requestId, { requestId, resolve, meta });
      this.broadcast(meta);
      this.broadcastTurnStatusIfChanged();

      ctx.signal.addEventListener("abort", () => {
        const pending = this.pendingPermissions.get(requestId);
        if (!pending) return;
        this.pendingPermissions.delete(requestId);
        pending.resolve({ behavior: "deny", message: "Aborted" });
        this.broadcastTurnStatusIfChanged();
      });
    });
  };

  resolvePermission(requestId: string, decision: PermissionDecision): boolean {
    const pending = this.pendingPermissions.get(requestId);
    if (!pending) return false;
    this.pendingPermissions.delete(requestId);
    // The request is now resolved — clear the matching inbox row so the user
    // doesn't keep seeing "Claude needs permission" after they've answered.
    void notificationBus.markReadByRequestId(this.cwd, requestId);

    if (decision.kind === "deny") {
      pending.resolve({ behavior: "deny", message: decision.message ?? "User denied" });
      return true;
    }

    // The SDK's PermissionResult schema requires `updatedInput` to be a record
    // on every "allow" — it represents the (possibly-mutated) tool args that
    // will run. We don't mutate args here, so just echo the original input
    // captured when the prompt was raised. Without this the SDK rejects the
    // response with a Zod error ("expected record, received undefined") and
    // the tool call loops until the session aborts.
    const inputRecord =
      pending.meta.input && typeof pending.meta.input === "object" && !Array.isArray(pending.meta.input)
        ? (pending.meta.input as Record<string, unknown>)
        : {};
    const result: PermissionResult = { behavior: "allow", updatedInput: inputRecord };
    if (decision.kind === "allow_always_session") {
      result.updatedPermissions = [
        {
          type: "addRules",
          behavior: "allow",
          rules: [{ toolName: pending.meta.toolName }],
          destination: "session",
        },
      ];
    } else if (decision.kind === "allow_always_save") {
      result.updatedPermissions = [
        {
          type: "addRules",
          behavior: "allow",
          rules: [{ toolName: pending.meta.toolName }],
          destination: decision.destination,
        },
      ];
    }
    pending.resolve(result);
    this.broadcastTurnStatusIfChanged();
    return true;
  }

  /**
   * Resolve a pending AskUserQuestion form. The SDK's `AskUserQuestionOutput`
   * (sdk-tools.d.ts) is shaped as `{ questions, answers, annotations?, response? }`
   * where `answers` is a MAP keyed by question text → string (multi-select
   * values are comma-separated). The original `questions` array must be
   * preserved on `updatedInput`, otherwise the SDK's post-processing
   * (it `.map`s over `input.questions` to format the result) crashes with
   * "undefined is not an object (evaluating 'H.map')".
   *
   * `response` (new in SDK 0.3.158) carries freeform text for the single-
   * question "Other" path — the user typed instead of selecting a structured
   * option. Multi-question forms leave it unset (the field is a single string
   * and it's ambiguous which question it would represent).
   *
   * If the user submits no answers (the cancel path), we deny instead of
   * allow — that's a cleaner signal to the model than empty strings.
   */
  submitAskAnswer(requestId: string, answers: AskAnswer[]): boolean {
    const pending = this.pendingAskQuestions.get(requestId);
    if (!pending) return false;
    this.pendingAskQuestions.delete(requestId);
    // Mirror resolvePermission: clear the matching inbox row so an answered
    // question stops showing as unread.
    void notificationBus.markReadByRequestId(this.cwd, requestId);

    const hasAnyContent = answers.some((a) => {
      if (!a) return false;
      if (typeof a.label === "string" && a.label) return true;
      if (Array.isArray(a.selected) && a.selected.length > 0) return true;
      if (typeof a.custom === "string" && a.custom.trim()) return true;
      return false;
    });
    if (answers.length === 0 || !hasAnyContent) {
      pending.resolve({ behavior: "deny", message: "User cancelled the question" });
      this.broadcastTurnStatusIfChanged();
      return true;
    }

    pending.resolve({
      behavior: "allow",
      updatedInput: buildAskUpdatedInput(pending.questions, answers),
    });
    this.broadcastTurnStatusIfChanged();
    return true;
  }

  /**
   * Resolve a pending ExitPlanMode prompt. Accepting also flips the session
   * out of plan mode into `acceptEdits` so the agent can actually execute the
   * plan it just laid out — that's the whole point of the exit. Rejecting
   * keeps plan mode and forwards the user's feedback as the deny message,
   * letting the model iterate.
   */
  async resolvePlan(requestId: string, decision: PlanDecision): Promise<boolean> {
    const pending = this.pendingPlans.get(requestId);
    if (!pending) return false;
    this.pendingPlans.delete(requestId);
    // Mirror resolvePermission: clear the matching inbox row so a resolved
    // plan-approval request stops showing as unread.
    void notificationBus.markReadByRequestId(this.cwd, requestId);

    if (decision.kind === "reject") {
      pending.resolve({
        behavior: "deny",
        message: decision.message ?? "User rejected the plan — keep iterating.",
      });
      // Feature 33 parity: persist the model's plan draft even on reject so
      // a later plan-mode re-entry can reference what was deliberated last
      // round. The CLI's on-disk plan file behaves the same way — it lingers
      // regardless of whether the user accepted the plan that produced it.
      void mergeSessionState(this.cwd, this.id, { priorPlan: pending.plan });
      this.broadcastTurnStatusIfChanged();
      return true;
    }

    // Hand the mode transition to the SDK via `updatedPermissions` instead
    // of pre-flipping with `query.setPermissionMode()`. The SDK's
    // ExitPlanMode tool checks its own pre-plan-mode state when it runs,
    // and a race-y external flip makes the tool emit `is_error: true`
    // ("ExitPlanMode never reached" / "gate is off"), which surfaced as a
    // red ⚠ icon on the activity rail even though the user had accepted
    // the plan. Returning the setMode as part of the allow lets the SDK
    // perform the transition atomically and the tool returns success.
    this.permissionMode = "acceptEdits";
    // `updatedInput` is REQUIRED on the allow branch even though sdk.d.ts
    // marks it optional — the SDK's runtime Zod validator rejects
    // `undefined` with "Invalid input: expected record, received undefined"
    // and surfaces it to the model as a tool_result error. The model then
    // retries ExitPlanMode (re-opening our plan overlay) and the user is
    // stuck in a loop. We mirror the original tool input here; the edited-
    // plan branch below replaces it with the user's draft when applicable.
    // Same defense as `resolvePermission` at line 708.
    const rawInput =
      pending.raw && typeof pending.raw === "object" && !Array.isArray(pending.raw)
        ? pending.raw
        : {};
    const result: PermissionResult = {
      behavior: "allow",
      updatedInput: rawInput,
      updatedPermissions: [
        { type: "setMode", mode: "acceptEdits", destination: "session" },
      ],
    };
    // If the user hand-edited the plan in the overlay, ship their version
    // as the tool's effective input. The SDK feeds this to ExitPlanMode
    // which writes the file + records it in the tool_result, so the next
    // model turn references the edited plan rather than the original draft.
    // Preserve any other fields the model passed (e.g. `allowedPrompts`).
    const editedPlan = decision.editedPlan?.trim();
    if (editedPlan && editedPlan !== pending.plan.trim()) {
      result.updatedInput = { ...rawInput, plan: editedPlan };
    }
    // Feature 33 parity: persist whichever plan the model actually saw as
    // the round's outcome — the user's edit if they hand-tweaked it in the
    // overlay, otherwise the model's draft. A later re-entry into plan mode
    // (handled in `setPermissionMode`) reads this back and queues a
    // `plan-mode-reentry` reminder so the agent treats the new round as a
    // fresh planning session rather than assuming the prior plan still holds.
    void mergeSessionState(this.cwd, this.id, {
      priorPlan: editedPlan && editedPlan.length > 0 ? editedPlan : pending.plan,
    });
    // Feature 39 parity: arm the post-execution verify nudge. The flag is
    // drained at the next `result` boundary in `consume()` (NOT here, NOT
    // at the reject branch) so the reminder rides the turn that follows
    // plan execution rather than landing while the agent is still working.
    this.planAwaitingVerify = true;
    pending.resolve(result);
    // The SDK doesn't echo `setMode` permission updates back through its
    // message iterator — broadcast manually so the client UI's mode badge
    // (plan → acceptEdits) follows along immediately.
    this.broadcast({ type: "mode_changed", mode: "acceptEdits" });
    this.broadcastTurnStatusIfChanged();
    return true;
  }

  sendInput(
    text: string,
    images?: Array<{ data: string; mediaType: string; ordinal?: number }>,
    opts?: { uuid?: string; slash?: boolean },
  ): void {
    if (this.done) return;
    type ContentBlock =
      | { type: "text"; text: string }
      | { type: "image"; source: { type: "base64"; media_type: string; data: string } };

    // Pin a uuid for this user turn. The SDK's iterator never echoes user
    // input back to consume(), so without surfacing it ourselves the in-memory
    // buffer would carry only assistant/result events — and any new SSE
    // subscriber (a reloaded tab, a second tab on the same session) would see
    // assistant replies floating with no preceding human message. We mint
    // here, broadcast into the buffer, and forward the same id into the
    // inputQueue so the SDK writes it to the JSONL — keeping the disk uuid
    // and the buffer uuid aligned for `loadOlder`'s `?before=<uuid>` cursor.
    // The SDK types `uuid` as a template-literal UUID. `randomUUID()` already
    // returns that branded type; a caller-supplied string needs to be widened
    // to it via cast (we trust the client to send a real uuid — worst case
    // is an inert dedup key, not a security issue).
    const uuid = (opts?.uuid ?? randomUUID()) as ReturnType<typeof randomUUID>;

    // Mid-turn capture (Claude Code TUI parity, feature 37). True when a
    // previous turn was still running when this `sendInput` was called —
    // i.e. the user (or any future coordinator/peer hook) typed during an
    // in-flight turn. Must be read BEFORE `turnInFlight` is set to true
    // below, otherwise every send looks mid-turn against itself.
    const wasMidTurn = this.turnInFlight;

    // Stamp the bus so the next `result` after this turn counts as "idle"
    // (i.e. crossed the IDLE_NOTIFY_MIN_MS threshold). Without this the
    // bus suppresses idle notifications because it never saw a user-input
    // signal for the session.
    notificationBus.markUserInput(this.id);
    this.sawUserInput = true;
    this.turnInFlight = true;
    this.broadcastTurnStatusIfChanged();

    // Slash-command shortcut: send `/compact`, `/init`, etc. to the SDK
    // verbatim so the CLI subprocess can interpret them, but DON'T broadcast
    // the synthetic user-message echo — otherwise the chat shows `/compact`
    // as if the user had typed it. We drop in a small `slash_invoked` system
    // event so the chat doesn't go silent while the SDK works. Image
    // attachments are not supported alongside slash commands (the dispatcher
    // in app/page.tsx already gates this), so we ignore `images` here.
    //
    // We re-use the *same* `uuid` for both the inputQueue user message and
    // the broadcast `slash_invoked` system event. This matters on reload:
    // `resyncFromDisk` (and `loadHistorical` on session start) build their
    // "already seen" set from buffer uuids and skip any JSONL message whose
    // uuid is already in the buffer. Without this, the disk-side `/compact`
    // user message would re-broadcast on every refresh and the echo bug
    // would come back via the resync path.
    if (opts?.slash) {
      const message = { role: "user" as const, content: text };
      const command = text.trim().split(/\s+/, 1)[0] ?? "/";
      const args = text.trim().slice(command.length).trim();
      this.broadcast({
        type: "sdk",
        message: {
          type: "system",
          subtype: "slash_invoked",
          command,
          args,
          session_id: this.id,
          uuid,
        } as unknown as SDKMessage,
      });
      this.inputQueue.push({
        type: "user",
        message,
        parent_tool_use_id: null,
        session_id: this.id,
        uuid,
      });
      return;
    }

    // Date-change ambient reminder (Claude Code TUI parity, feature 28).
    // First real user turn baselines `lastSeenLocalDate` and does NOT fire
    // — the SDK system prompt already announced today's date at start().
    // Every subsequent turn compares today's local-calendar key against
    // the baseline and, when they differ (session lived through midnight),
    // queues an ambient `<system-reminder>` whose literal body matches the
    // CLI's "DO NOT mention this to the user" wording so the rollover stays
    // model-only. Same channel/ordering as the ultrathink scan below — the
    // drain in both branches rides this turn.
    const todayKey = localDateKey(new Date());
    if (this.lastSeenLocalDate === null) {
      this.lastSeenLocalDate = todayKey;
    } else if (this.lastSeenLocalDate !== todayKey) {
      const body = dateChangeReminderBody(this.lastSeenLocalDate, new Date());
      if (body) queueReminder(this, "date-change", body);
      this.lastSeenLocalDate = todayKey;
    }

    // Prose-keyword scan for `ultrathink` (Claude Code TUI parity, feature 27).
    // Done HERE — after the slash-command early-return, before the image
    // branch — so:
    //   1. slash commands like `/compact` never queue a reminder that would
    //      then leak onto the next real prompt;
    //   2. one queue call covers both the text-only and image-bearing
    //      branches below.
    // The block is appended by the existing `takePendingReminders` drain in
    // both branches, so it rides THIS turn (same call ordering as the goal
    // reminder).
    const ultrathinkBody = ultrathinkReminderBody(text);
    if (ultrathinkBody) queueReminder(this, "ultrathink-prose", ultrathinkBody);

    // Mid-turn user inject nudge (Claude Code TUI parity, feature 37). When
    // the user submits a follow-up while a previous turn is still running,
    // wrap the queued content in a forceful "MUST address" reminder so the
    // model doesn't read the late message as a fresh acknowledgement. Same
    // drain channel as the scans above — rides THIS message (the mid-turn
    // one), matching the back-to-back queue/drain ordering. Placed after
    // the slash-command early-return so a mid-turn `/compact` doesn't burn
    // a reminder onto a synthetic slash invocation.
    if (wasMidTurn) queueReminder(this, "midturn-inject", midturnInjectReminderBody());

    // Linter-modified-file scan (Claude Code TUI parity, feature 29). Walks
    // the post-Edit/Write hash snapshots captured by the PostToolUse hook
    // and queues a reminder for any path the user's PostToolUse formatter
    // (or the user themselves) rewrote between turns. Same drain channel
    // as the nudges above — rides this turn.
    this.flushLinterModifiedReminder();

    // Stale-TodoWrite nudge (Claude Code TUI parity, feature 31). The
    // counter is bumped here (after the slash-command early-return so a
    // `/compact` or `/init` doesn't burn a real turn) and reset to 0 in
    // `captureSnapshotState` when the model invokes TodoWrite. Crossing
    // the threshold queues a `stale-todowrite` reminder for THIS turn and
    // rearms at 0 — so long todo-silent stretches yield a periodic poke
    // rather than every-turn spam after the first fire.
    this.turnsSinceTodoWrite += 1;
    if (this.turnsSinceTodoWrite >= STALE_TODO_TURN_THRESHOLD) {
      const body = staleTodoReminderBody(this.latestTodosSnapshot ?? []);
      queueReminder(this, "stale-todowrite", body);
      this.turnsSinceTodoWrite = 0;
    }

    if (!images || images.length === 0) {
      const message = { role: "user" as const, content: text };
      this.broadcast({
        type: "sdk",
        message: {
          type: "user",
          message,
          parent_tool_use_id: null,
          session_id: this.id,
          uuid,
        } as unknown as SDKMessage,
      });
      // One-shot goal reminder rides the *queued* content only — never the
      // broadcast echo above — so the chat shows the user's plain text while
      // the agent receives the objective. Same uuid on both means a reload's
      // resync skips the disk copy (already in the buffer), so the prefix
      // never leaks into the visible transcript. The same reasoning applies
      // to any `<system-reminder>` blocks queued via `system-reminders.ts`
      // by upcoming parity features — they ride the queued content only.
      const reminder = this.takeGoalReminder();
      const pending = takePendingReminders(this) ?? "";
      const prefix = reminder + pending;
      const queued = prefix ? { role: "user" as const, content: prefix + text } : message;
      this.inputQueue.push({
        type: "user",
        message: queued,
        parent_tool_use_id: null,
        session_id: this.id,
        uuid,
      });
      return;
    }

    const byOrdinal = new Map<number, { data: string; mediaType: string }>();
    for (const img of images) {
      if (typeof img.ordinal === "number") {
        byOrdinal.set(img.ordinal, { data: img.data, mediaType: img.mediaType });
      }
    }

    const content: ContentBlock[] = [];
    const tokenRe = /\[Image #(\d+)\]/g;
    let cursor = 0;
    let m: RegExpExecArray | null;
    while ((m = tokenRe.exec(text))) {
      const ord = Number(m[1]);
      const img = byOrdinal.get(ord);
      if (!img) continue; // leave unknown tokens as literal text — fall through
      const before = text.slice(cursor, m.index);
      if (before) content.push({ type: "text", text: before });
      content.push({
        type: "image",
        source: { type: "base64", media_type: img.mediaType, data: img.data },
      });
      // Mark this ordinal consumed so a duplicate token in the text doesn't
      // try to inline the same image twice.
      byOrdinal.delete(ord);
      cursor = m.index + m[0].length;
    }
    const tail = text.slice(cursor);
    if (tail) content.push({ type: "text", text: tail });

    // Any images that didn't have a token in the text — append at the end so
    // they aren't silently dropped (mirrors current behavior for ordinal-less
    // legacy callers).
    for (const img of images) {
      if (typeof img.ordinal !== "number") {
        content.push({
          type: "image",
          source: { type: "base64", media_type: img.mediaType, data: img.data },
        });
      }
    }

    const message = { role: "user" as const, content: content as unknown as string };
    this.broadcast({
      type: "sdk",
      message: {
        type: "user",
        message,
        parent_tool_use_id: null,
        session_id: this.id,
        uuid,
      } as unknown as SDKMessage,
    });
    // One-shot goal reminder — prepend a text block to the *queued* content
    // only (see the text-only branch above for the reload-safety rationale).
    // System-reminder queue rides the same channel and is appended after the
    // goal reminder so the goal stays the first thing the agent sees.
    const reminder = this.takeGoalReminder();
    const pending = takePendingReminders(this) ?? "";
    const prefix = reminder + pending;
    const queuedContent = prefix
      ? [{ type: "text" as const, text: prefix }, ...content]
      : content;
    this.inputQueue.push({
      type: "user",
      message: { role: "user" as const, content: queuedContent as unknown as string },
      parent_tool_use_id: null,
      session_id: this.id,
      uuid,
    });
  }

  /** Build the in-process MCP server that exposes the goal-reporting tool. */
  private buildGoalMcpServer(): McpSdkServerConfigWithInstance {
    return createSdkMcpServer({
      name: "claudius_goal",
      version: "1.0.0",
      tools: [
        tool(
          "report_goal_achieved",
          "Report that the user's stated session goal has been fully accomplished. " +
            "Only call this when the goal is genuinely complete — never for partial " +
            "progress or intermediate steps. Calling it marks the goal as done in the UI.",
          { summary: z.string().describe("One sentence summarizing what was accomplished.") },
          async ({ summary }) => {
            await this.markGoalAchieved(typeof summary === "string" ? summary : "");
            return {
              content: [
                { type: "text" as const, text: "Recorded: the session goal is marked achieved." },
              ],
            };
          },
        ),
      ],
    });
  }

  /** System-prompt append describing the goal that exists at session start. */
  private goalSystemPromptAppend(): string {
    if (!this.goal.goal) return "";
    return [
      "## Session goal",
      "",
      "The user has set an explicit goal for this session:",
      "",
      `> ${this.goal.goal}`,
      "",
      "Keep this objective in mind across turns. When — and only when — you are " +
        "confident it has been fully accomplished, call the " +
        "`mcp__claudius_goal__report_goal_achieved` tool with a one-sentence summary. " +
        "Do not call it for partial progress, and don't bring the goal up unprompted.",
    ].join("\n");
  }

  /**
   * The one-shot reminder text for a goal set mid-session, consumed exactly
   * once: returns the reminder (and flips `goalAnnounced`) the first time it's
   * called after a goal is set, then "" thereafter until the goal changes.
   */
  private takeGoalReminder(): string {
    if (!this.goal.goal || this.goalAnnounced) return "";
    this.goalAnnounced = true;
    return (
      "<session-goal>\n" +
      `The user has set this goal for the session: ${this.goal.goal}\n\n` +
      "Work toward it. When you are confident it is fully accomplished, call the " +
      "mcp__claudius_goal__report_goal_achieved tool with a one-sentence summary. " +
      "Do not call it for partial progress.\n" +
      "</session-goal>\n\n"
    );
  }

  /**
   * Claude Code TUI parity (29-linter-modified-file-reminder). Drains the
   * post-Edit/Write hash snapshot map, re-hashes each path on disk, and
   * queues a single `linter-modified-file` reminder naming every path
   * whose hash differs from the value captured at PostToolUse. Always
   * clears the map afterwards so the next turn starts clean.
   *
   * Called once per real user turn, just before the existing
   * `takePendingReminders` drain at the inputQueue prepend site, so the
   * reminder rides the same drain and lands in the same wrapper sequence
   * as the date-change / ultrathink / goal nudges.
   *
   * Synchronous on purpose — keeps `sendInput`'s signature unchanged.
   * The map is bounded by the number of files Claude edited in the
   * previous turn (typically 1-3) and `readFileSync` is satisfied from
   * the OS page cache for files Claude just wrote to.
   */
  private flushLinterModifiedReminder(): void {
    if (this.postWriteSnapshots.size === 0) return;
    const changed: string[] = [];
    for (const [path, prevHash] of this.postWriteSnapshots) {
      try {
        const buf = readFileSync(path);
        const nowHash = createHash("sha256").update(buf).digest("hex");
        if (nowHash !== prevHash) changed.push(path);
      } catch {
        // File deleted, unreadable, or moved between turns — skip silently.
        // A subsequent re-write will re-snapshot it; we'd rather miss one
        // edge-case reminder than fire a wrong "don't revert" nudge.
      }
    }
    this.postWriteSnapshots.clear();
    const body = linterModifiedReminderBody(changed);
    if (body) queueReminder(this, "linter-modified-file", body);
  }

  /** Snapshot the current goal state as a broadcastable event. */
  private goalEvent(): GoalChangedEvent {
    return {
      type: "goal_changed",
      goal: this.goal.goal,
      achieved: this.goal.achieved,
      summary: this.goal.summary,
      setAt: this.goal.setAt,
      achievedAt: this.goal.achievedAt,
    };
  }

  private broadcastGoal(): void {
    this.broadcast(this.goalEvent());
  }

  /** Current goal state (for API reads). */
  getGoal(): SessionGoal {
    return this.goal;
  }

  /**
   * Set or replace the session goal. Replacing resets achievement. The agent
   * learns the new goal via a one-shot reminder on the next user turn (the
   * query's system prompt is fixed at creation), so `goalAnnounced` is reset.
   */
  async setGoal(text: string): Promise<SessionGoal> {
    const trimmed = text.trim();
    if (!trimmed) return this.clearGoal();
    this.goal = await setSessionGoal(this.cwd, this.id, trimmed);
    this.goalAnnounced = false;
    this.broadcastGoal();
    return this.goal;
  }

  /** Clear the session goal (and any achievement). */
  async clearGoal(): Promise<SessionGoal> {
    this.goal = await clearSessionGoal(this.cwd, this.id);
    this.goalAnnounced = true; // nothing left to announce
    this.broadcastGoal();
    return this.goal;
  }

  /**
   * Mark the current goal achieved — invoked by the in-process
   * `report_goal_achieved` tool. No-op when there's no goal or it's already
   * achieved (the model occasionally double-calls).
   */
  async markGoalAchieved(summary: string): Promise<void> {
    if (!this.goal.goal || this.goal.achieved) return;
    this.goal = await setGoalAchieved(this.cwd, this.id, summary);
    this.broadcastGoal();
  }

  async interrupt(): Promise<void> {
    if (this.query) await this.query.interrupt().catch(() => {});
  }

  async setPermissionMode(mode: PermissionMode): Promise<void> {
    // Plan-mode re-entry reminder (Claude Code TUI parity, feature 33). When
    // the user flips back into plan mode after a prior planning round in
    // this session, queue a `plan-mode-reentry` reminder citing the
    // previously resolved plan — the CLI does the same against an on-disk
    // plan file, which Claudius doesn't have, so we lean on the JSON state
    // bag (`priorPlan`) populated in `resolvePlan`. Persist-backed (vs the
    // in-memory counters used by stale-todowrite / date-change) because
    // "previous planning session" should survive resume, matching the
    // CLI's on-disk semantics. Gate on the *transition*: a redundant
    // `setPermissionMode("plan")` while already in plan mode (or the
    // direct field write in `resolvePlan` flipping to `acceptEdits`) must
    // not re-fire the reminder.
    const wasPlan = this.permissionMode === "plan";
    // Auto-mode exit reminder (Claude Code TUI parity, feature 34). When
    // the user Shift+Tabs out of `auto`, the CLI injects a `## Exited Auto
    // Mode` reminder so the agent shifts back to an interactive posture.
    // Capture `wasAuto` BEFORE the mode write — same shape as `wasPlan`
    // above — and gate on the *transition* so a redundant
    // `setPermissionMode("auto")` while already in auto can't re-fire.
    const wasAuto = this.permissionMode === "auto";
    this.permissionMode = mode;
    if (!wasPlan && mode === "plan") {
      const state: Record<string, unknown> = await getSessionState(this.cwd, this.id).catch(
        () => ({}),
      );
      const priorPlan = typeof state.priorPlan === "string" ? state.priorPlan.trim() : "";
      if (priorPlan) {
        queueReminder(this, "plan-mode-reentry", planModeReentryReminderBody(priorPlan));
      }
    }
    if (wasAuto && mode !== "auto") {
      queueReminder(this, "auto-mode-exit", autoModeExitReminderBody());
    }
    if (this.query) await this.query.setPermissionMode(mode).catch(() => {});
    this.broadcast({
      type: "mode_changed",
      mode,
    });
  }

  getPermissionMode(): PermissionMode {
    return this.permissionMode;
  }

  /**
   * Snapshot of the session-only loops/wake-ups armed via the SDK's
   * `CronCreate` / `ScheduleWakeup` tools. Returned as a fresh array so
   * callers can't mutate the internal Map.
   *
   * Used by `GET /api/schedule/session-loops` to surface in-flight loops
   * on the `/schedule` page across every open session.
   */
  getScheduledLoops(): SessionLoop[] {
    return [...this.scheduledLoops.values()];
  }

  /**
   * Observe an SDK message and update `scheduledLoops` if it carries any
   * `CronCreate` / `CronDelete` / `ScheduleWakeup` tool_use blocks (or
   * the matching tool_result).
   *
   * Why duplicate the client-side reducer here:
   *   - The client only sees its own session via SSE; the `/schedule` page
   *     wants a global view across every live session. The server is the
   *     only place that can aggregate.
   *   - We need state that survives a closed browser tab — as long as the
   *     Session object lives (i.e. the agent runtime is still up and the
   *     cron can actually fire), the loop entry has to stay visible.
   *
   * The text-result regex must match `lib/client/use-session.ts`'s reducer
   * so the cron id / humanSchedule resolve to the same values on both
   * sides. Update them together.
   *
   * `at` is the observed-at timestamp for this message — the JSONL
   * `timestamp` field on disk-replay, or `Date.now()` for live SDK
   * events. We use it as `startedAt` so the countdown is anchored to
   * when the loop was *originally* armed, not when the page happened to
   * replay it. Without this, every refresh resets the timer to the
   * original delay (the user-visible "timer goes to 9m every reload"
   * bug). Defaults to `Date.now()` when callers don't pass one — that
   * preserves the original behavior for the live consume() path where
   * "now" is genuinely the arming time.
   */
  private trackScheduledLoops(message: SDKMessage, at?: number): void {
    const observedAt = typeof at === "number" ? at : Date.now();
    type ToolUseBlock = {
      type: "tool_use";
      id: string;
      name: string;
      input: Record<string, unknown>;
    };
    type ToolResultBlock = {
      type: "tool_result";
      tool_use_id: string;
      content: unknown;
      is_error?: boolean;
    };

    const m = message as {
      type?: string;
      message?: { content?: unknown };
    };

    const content = m.message?.content;
    if (!Array.isArray(content)) return;

    if (m.type === "assistant") {
      for (const raw of content) {
        const b = raw as { type?: string };
        if (b.type !== "tool_use") continue;
        const tu = raw as ToolUseBlock;

        if (tu.name === "CronCreate") {
          const inp = tu.input as {
            cron?: unknown;
            prompt?: unknown;
            recurring?: unknown;
          };
          const cron = typeof inp.cron === "string" ? inp.cron : "";
          const prompt = typeof inp.prompt === "string" ? inp.prompt : "";
          if (!cron) continue;
          // Dedup: if we've already promoted this tool_use into the
          // active map (via its later tool_result), don't re-stamp it as
          // pending — that would orphan the entry. The active-map
          // dedup below handles the unpromoted-pending case the same
          // way (idempotent on replay).
          if (this.pendingScheduledLoops.has(tu.id)) continue;
          this.pendingScheduledLoops.set(tu.id, {
            kind: "cron",
            id: tu.id, // placeholder; re-keyed once tool_result lands
            toolUseId: tu.id,
            cron,
            humanSchedule: null,
            delaySeconds: null,
            prompt,
            recurring: inp.recurring === true,
            durable: false,
            startedAt: observedAt,
            cancelled: false,
          });
          continue;
        }

        if (tu.name === "CronDelete") {
          const idRaw = (tu.input as { id?: unknown }).id;
          const id = typeof idRaw === "string" ? idRaw : null;
          if (!id) continue;
          const entry = this.scheduledLoops.get(id);
          if (entry) entry.cancelled = true;
          continue;
        }

        if (tu.name === "ScheduleWakeup") {
          const inp = tu.input as {
            delaySeconds?: unknown;
            reason?: unknown;
            prompt?: unknown;
          };
          // Dedup: replaying the same tool_use shouldn't reset its own
          // startedAt. Without this guard, the "delete prior wake-ups"
          // step below would drop the entry and we'd re-insert it with
          // a fresh `observedAt` — fine on the very first replay, but
          // would lose the entry on subsequent re-broadcasts when no
          // new wake-up has actually been armed.
          if (this.scheduledLoops.has(tu.id)) continue;
          // One-shot: a fresh wake-up supersedes any prior pending wake-up
          // for this session (matches the client's reducer).
          for (const [k, v] of this.scheduledLoops) {
            if (v.kind === "wakeup" && !v.cancelled) this.scheduledLoops.delete(k);
          }
          this.scheduledLoops.set(tu.id, {
            kind: "wakeup",
            id: tu.id,
            toolUseId: tu.id,
            cron: null,
            humanSchedule: null,
            delaySeconds: typeof inp.delaySeconds === "number" ? inp.delaySeconds : null,
            prompt: typeof inp.prompt === "string" ? inp.prompt : "",
            reason: typeof inp.reason === "string" ? inp.reason : undefined,
            recurring: false,
            durable: false,
            startedAt: observedAt,
            cancelled: false,
          });
          continue;
        }
      }
      return;
    }

    if (m.type === "user") {
      for (const raw of content) {
        const b = raw as { type?: string };
        if (b.type !== "tool_result") continue;
        const tr = raw as ToolResultBlock;
        const pending = this.pendingScheduledLoops.get(tr.tool_use_id);
        if (!pending) continue;
        this.pendingScheduledLoops.delete(tr.tool_use_id);

        // Extract the text payload — `content` is either a string or an
        // array of `{type:"text", text:string}` blocks per the Anthropic
        // wire format. Mirror what extractToolResult does on the client.
        let text = "";
        if (typeof tr.content === "string") {
          text = tr.content;
        } else if (Array.isArray(tr.content)) {
          for (const c of tr.content as Array<{ type?: string; text?: string }>) {
            if (c?.type === "text" && c.text) text += c.text;
          }
        }

        if (tr.is_error) continue; // drop pending: the tool failed

        // Same regex as the client reducer — keep in sync.
        const idMatch = text.match(/job\s+([a-z0-9]+)\s*\(([^)]+)\)/i);
        const cronId = idMatch?.[1] ?? pending.toolUseId;
        const humanSchedule = idMatch?.[2] ?? null;
        const durable = !/session[- ]only/i.test(text);

        this.scheduledLoops.set(cronId, {
          ...pending,
          id: cronId,
          humanSchedule,
          durable,
        });
      }
    }
  }

  async setModel(
    model?: string,
  ): Promise<{ ok: true; model?: string } | { ok: false; error: string; model?: string }> {
    // Forward the pick to the active SDK query and surface its rejection
    // instead of swallowing. Previously a `.catch(() => {})` discarded
    // failures, so the picker would close and the optimistic UI would claim
    // the new model while the SDK kept running the old one. We now short-
    // circuit on rejection so the in-memory `this.model`, the persisted DB
    // row, and the `model_changed` broadcast all stay consistent — and the
    // route returns the failure so the client can revert and toast.
    //
    // No remote/teleport concept exists in Claudius; this is the local
    // analogue of the TUI's host-rejected model switch.
    if (this.query) {
      try {
        await this.query.setModel(model);
      } catch (err) {
        return {
          ok: false,
          error: err instanceof Error ? err.message : String(err),
          model: this.model,
        };
      }
    }
    this.model = model;
    // Persist so the pick survives reap → resume. Without this the in-memory
    // mutation is lost when the SessionManager evicts the Session object, and
    // the next `start()` pulls the (stale) original model from the constructor
    // path. The `sessions.model` column already exists (migration 002) and
    // `upsertSession` upserts on conflict — no schema change needed.
    try {
      await upsertSession({
        id: this.id,
        cwd: this.cwd,
        model: this.model,
        title: this.title,
      });
    } catch {
      // Non-fatal: SSE listeners still get the change, and the SDK side
      // still applied it. DB write failure just means the next resume
      // falls back to the prior default.
    }
    this.broadcast({ type: "model_changed", model });
    return { ok: true, model };
  }

  /**
   * Set the reasoning-effort level for subsequent turns.
   *
   * The SDK exposes effort via `applyFlagSettings({ effortLevel })`, not as
   * a slash command — an earlier cut of the client routed `/effort <level>`
   * through the input pipeline, but the SDK answers that with
   * `/effort isn't available in this environment.` because no such command
   * is registered. The flag-settings layer sits above project/user settings
   * and below managed-policy settings, so the override survives until we
   * clear it (or the SDK session ends).
   *
   * `null` / `"auto"` clears the override and returns the model to its
   * default adaptive behavior. Other values pass through verbatim — we let
   * the SDK validate against the active model's `supportedEffortLevels`
   * rather than re-implementing that check here. The `Settings.effortLevel`
   * type currently excludes `"max"` but the SDK's `EffortLevel` includes
   * it; we cast and forward so the picker's max chip works on models that
   * support it.
   *
   * No DB persistence — effort isn't on the `sessions` schema. After a
   * reap → resume, the level falls back to default. The client mirrors the
   * pick optimistically so the SessionCard pill stays honest within a
   * session's lifetime; that's the trade we accept until the SDK adds an
   * `effort_changed` event we can subscribe to.
   */
  async setEffort(level: EffortLevel | "auto"): Promise<void> {
    if (!this.query) return;
    // Cast: `Settings.effortLevel` is `'low' | 'medium' | 'high' | 'xhigh'`
    // (no max), but the SDK accepts max at runtime on supporting models.
    // Trust the SDK to reject unsupported levels rather than narrowing here.
    const value = level === "auto" ? null : (level as "low" | "medium" | "high" | "xhigh");
    await this.query.applyFlagSettings({ effortLevel: value }).catch(() => {});
  }

  /**
   * Toggle "ultracode" (Dynamic Workflows) for subsequent turns.
   *
   * Ultracode is the SDK flag behind Opus 4.8's Dynamic Workflows: it runs
   * the session at `xhigh` effort plus standing dynamic-workflow
   * orchestration (the model plans, then fans out parallel subagents). Set
   * through the same `applyFlagSettings` control channel as `setEffort` —
   * there's no slash command for it.
   *
   * The SDK requires the Workflows feature to be enabled (plan-gated) and
   * an `xhigh`-capable model. We don't re-implement those checks: the
   * picker only offers the toggle on `xhigh`-capable models, and we trust
   * the SDK to no-op if Workflows aren't enabled for the user. Session-
   * scoped with no DB persistence (same as effort) — resets to off after a
   * reap → resume.
   */
  async setUltracode(enabled: boolean): Promise<void> {
    if (!this.query) return;
    await this.query.applyFlagSettings({ ultracode: enabled }).catch(() => {});
  }

  /**
   * Toggle "fast mode" for subsequent turns.
   *
   * Fast mode is the SDK's accelerated-decoding flag (Opus 4.8 — cheat-sheet
   * binding `Option+O` / `/fast`). Set through the same `applyFlagSettings`
   * control channel as `setEffort`/`setUltracode`. Unlike ultracode it is
   * *orthogonal to effort*: it does NOT force `xhigh` — it just runs the model
   * at accelerated rates, so the effort mirror is left untouched.
   *
   * The SDK requires a fast-capable model; we don't re-implement that check —
   * the picker only offers the toggle on `supportsFastMode` models, and we
   * trust the SDK to no-op otherwise. Session-scoped with no DB persistence
   * (same as effort/ultracode): resets to off after a reap → resume. Gated
   * client-side on `supportsFastMode`.
   */
  async setFast(enabled: boolean): Promise<void> {
    if (!this.query) return;
    await this.query.applyFlagSettings({ fastMode: enabled }).catch(() => {});
  }

  /**
   * Forward user feedback to Anthropic via the SDK's *undocumented* control
   * method `query.submitFeedback`. It isn't in the SDK's public typings (no
   * `.d.ts` entry), but it lives on the same control-protocol object that
   * backs the typed methods like `setEffort`/`seedReadState` and routes
   * through the same channel the CLI's session-quality survey uses to reach
   * Anthropic. We feature-detect and swallow failures: if a future SDK drops
   * the method, forwarding degrades to a no-op and the caller still persists
   * the feedback locally. Returns whether the SDK accepted the forward.
   */
  async submitFeedback(description: string, surface = "claudius"): Promise<boolean> {
    const q = this.query as
      | (Query & {
          submitFeedback?: (
            description: string,
            opts?: { surface?: string },
          ) => Promise<unknown>;
        })
      | null;
    if (!q || typeof q.submitFeedback !== "function") return false;
    try {
      await q.submitFeedback(description, { surface });
      return true;
    } catch {
      return false;
    }
  }

  /**
   * After a successful turn, occasionally nudge the user for feedback —
   * Claudius's replica of the CLI's session-quality survey. Eligibility +
   * probability live in `feedback-survey.ts` (pure, tested); the rate comes
   * from the user-scope `feedbackSurveyRate` setting. Best-effort: any error
   * is swallowed so the consume() loop is never disrupted by a nudge.
   */
  private async maybeOfferFeedbackSurvey(message: SDKMessage): Promise<void> {
    try {
      const isError = (message as { is_error?: boolean }).is_error === true;
      // Cheap synchronous gates first — avoid a settings file read on every
      // turn while throttled or ineligible.
      if (isError || !this.sawUserInput) return;
      const now = Date.now();
      if (now - getLastSurveyShownAt() < SURVEY_MIN_INTERVAL_MS) return;
      const settings = await readSettings("user", this.cwd).catch(
        () => ({}) as ClaudeSettings,
      );
      const rate = coerceSurveyRate(settings.feedbackSurveyRate);
      if (
        !shouldOfferSurvey({
          rate,
          isError,
          sawUserInput: this.sawUserInput,
          now,
          lastShownAt: getLastSurveyShownAt(),
        })
      ) {
        return;
      }
      noteSurveyShown(now);
      this.broadcast({ type: "feedback_survey", sessionId: this.id, surface: "claudius" });
    } catch {
      // A feedback nudge is never worth disrupting the turn loop.
    }
  }

  /**
   * Forward the model list the SDK advertises for this session. The SDK
   * returns per-model metadata (display name, description, supported effort
   * levels) so the picker can render the same options the CLI's `/model`
   * surface offers.
   *
   * Throws when there's no active query (session not started yet, or
   * reaped); the API route maps that to a 503 so the client can retry.
   */
  async supportedModels(): Promise<{ ok: true; data: unknown } | { ok: false; error: string }> {
    if (!this.query) return { ok: false, error: "session not active" };
    try {
      const data = await this.query.supportedModels();
      return { ok: true, data };
    } catch (err) {
      return { ok: false, error: err instanceof Error ? err.message : String(err) };
    }
  }

  /**
   * Forward the subagent list the SDK has loaded for this session — the same
   * `AgentInfo[]` the CLI's `claude agents` surface and the `--agent` picker
   * read. This is the source of truth for "which agents are actually live"
   * (file-based `.claude/agents/*.md`, plugin-injected, and the built-in
   * general-purpose / Explore agents), as opposed to the filesystem listing
   * in `lib/server/agents.ts` which only sees the markdown files on disk.
   *
   * Same `{ ok, data | error }` envelope as `supportedModels`; the API route
   * maps `ok: false` to a 503 so a not-yet-started session can be retried.
   */
  async supportedAgents(): Promise<{ ok: true; data: unknown } | { ok: false; error: string }> {
    if (!this.query) return { ok: false, error: "session not active" };
    try {
      const data = await this.query.supportedAgents();
      return { ok: true, data };
    } catch (err) {
      return { ok: false, error: err instanceof Error ? err.message : String(err) };
    }
  }

  /**
   * Forward the slash-command list the SDK advertises for this session as
   * rich `SlashCommand` objects (name + description + argumentHint + aliases)
   * — richer than the bare name list in the system:init message. Used to
   * enrich the slash-command picker's descriptions for SDK/plugin-provided
   * commands and to refresh after a plugin reload. Same `{ ok, data | error }`
   * envelope as `supportedAgents` / `supportedModels`.
   */
  async supportedCommands(): Promise<{ ok: true; data: unknown } | { ok: false; error: string }> {
    if (!this.query) return { ok: false, error: "session not active" };
    try {
      const data = await this.query.supportedCommands();
      return { ok: true, data };
    } catch (err) {
      return { ok: false, error: err instanceof Error ? err.message : String(err) };
    }
  }

  async getContextUsage(): Promise<{ ok: true; data: unknown } | { ok: false; error: string }> {
    if (!this.query) return { ok: false, error: "no active query" };
    try {
      const data = await this.query.getContextUsage();
      return { ok: true, data };
    } catch (err) {
      return { ok: false, error: err instanceof Error ? err.message : String(err) };
    }
  }

  async mcpServerStatus(): Promise<{ ok: true; data: unknown } | { ok: false; error: string }> {
    if (!this.query) return { ok: false, error: "no active query" };
    try {
      const data = await this.query.mcpServerStatus();
      return { ok: true, data };
    } catch (err) {
      return { ok: false, error: err instanceof Error ? err.message : String(err) };
    }
  }

  async reconnectMcp(name: string): Promise<{ ok: true } | { ok: false; error: string }> {
    if (!this.query) return { ok: false, error: "no active query" };
    try {
      await this.query.reconnectMcpServer(name);
      // MCP delta reminder (Claude Code TUI parity, feature 35). A reconnect
      // request is a "tools may be coming back" transition — but the SDK's
      // status may still report `pending` immediately after this await, so
      // we don't re-query and assert "connected"; we surface the reconnect
      // intent and lean on the CLI's wait-and-search guidance baked into
      // `mcpDeltaReminderBody`. Next user turn drains it.
      const body = mcpDeltaReminderBody({ reconnecting: [name] });
      if (body) queueReminder(this, "mcp-delta", body);
      return { ok: true };
    } catch (err) {
      return { ok: false, error: err instanceof Error ? err.message : String(err) };
    }
  }

  async toggleMcp(name: string, enabled: boolean): Promise<{ ok: true } | { ok: false; error: string }> {
    if (!this.query) return { ok: false, error: "no active query" };
    try {
      await this.query.toggleMcpServer(name, enabled);
      // MCP delta reminder (Claude Code TUI parity, feature 35). Intent is
      // deterministic from `enabled` — disabled removes tools, enabled brings
      // them back (subject to a reconnect race we cover via the "wait and
      // search" clause in `mcpDeltaReminderBody`). No re-query needed.
      const body = mcpDeltaReminderBody(
        enabled ? { added: [name] } : { disabled: [name] },
      );
      if (body) queueReminder(this, "mcp-delta", body);
      return { ok: true };
    } catch (err) {
      return { ok: false, error: err instanceof Error ? err.message : String(err) };
    }
  }

  /**
   * Dynamically replace this session's set of SDK-added MCP servers (B4.8).
   * Wraps Query.setMcpServers — connects new servers, disconnects removed
   * ones, and returns which were added/removed plus any connection errors.
   * Only affects servers added via this method; file-configured servers are
   * untouched. Pass an empty object to remove all dynamic servers. Lets a user
   * try a server config in one session without writing it to settings.
   */
  async setMcpServers(
    servers: Record<string, McpServerConfig>,
  ): Promise<{ ok: true; data: unknown } | { ok: false; error: string }> {
    if (!this.query) return { ok: false, error: "no active query" };
    try {
      const data = await this.query.setMcpServers(servers);
      // MCP delta reminder (Claude Code TUI parity, feature 35). The SDK
      // hands back the canonical add/remove lists in McpSetServersResult,
      // so we use those directly rather than re-querying status (which
      // would race the same way reconnect does). Empty add+remove (a no-op
      // call) returns null from `mcpDeltaReminderBody` and we skip queueing.
      const result = data as
        | { added?: unknown; removed?: unknown; errors?: unknown }
        | null
        | undefined;
      // McpSetServersResult.errors lists servers that failed to connect; the
      // SDK still surfaces those in `added` (the server was added to the
      // dynamic set even though the handshake failed). Filter them out so
      // we don't tell the model "now available" for a server that never
      // connected — the wait-and-search clause would self-correct, but
      // claiming availability up front is misleading.
      const errored =
        result?.errors && typeof result.errors === "object"
          ? new Set(Object.keys(result.errors as Record<string, unknown>))
          : new Set<string>();
      const added = Array.isArray(result?.added)
        ? (result?.added as unknown[]).filter(
            (s): s is string => typeof s === "string" && !errored.has(s),
          )
        : [];
      const removed = Array.isArray(result?.removed)
        ? (result?.removed as unknown[]).filter((s): s is string => typeof s === "string")
        : [];
      const body = mcpDeltaReminderBody({ added, removed });
      if (body) queueReminder(this, "mcp-delta", body);
      return { ok: true, data };
    } catch (err) {
      return { ok: false, error: err instanceof Error ? err.message : String(err) };
    }
  }

  async reloadPlugins(): Promise<{ ok: true; data: unknown } | { ok: false; error: string }> {
    if (!this.query) return { ok: false, error: "no active query" };
    try {
      const data = await this.query.reloadPlugins();
      return { ok: true, data };
    } catch (err) {
      return { ok: false, error: err instanceof Error ? err.message : String(err) };
    }
  }

  /**
   * Memory-update reminder (Claude Code TUI parity, feature 36). The
   * `/api/memory/auto` route calls this on every CRUD against the
   * auto-memory directory so the next user turn carries a
   * `<system-reminder>` naming the files that changed — plus a
   * staleness clause for any file the model has already Read this
   * session. Computing `inContextPaths` here (rather than at the route)
   * keeps `recentReadPaths` private and lets each live session decide
   * independently which of its reads are stale. No-op when `updates`
   * is empty.
   */
  notifyMemoryUpdate(updates: readonly MemoryUpdate[]): void {
    if (updates.length === 0) return;
    const changed = new Set(updates.map((u) => u.path));
    const inContext: string[] = [];
    for (const p of this.recentReadPaths) {
      if (changed.has(p)) inContext.push(p);
    }
    const body = memoryUpdateReminderBody(updates, inContext);
    if (body) queueReminder(this, "memory-update", body);
  }

  async accountInfo(): Promise<{ ok: true; data: unknown } | { ok: false; error: string }> {
    if (!this.query) return { ok: false, error: "no active query" };
    try {
      const data = await this.query.accountInfo();
      return { ok: true, data };
    } catch (err) {
      return { ok: false, error: err instanceof Error ? err.message : String(err) };
    }
  }

  /**
   * Rewind tracked files to their state at a given user message. Requires
   * `enableFileCheckpointing` (set in start()). With `dryRun: true` the SDK
   * reports what *would* change (filesChanged / insertions / deletions)
   * without touching the working tree — the client uses that for a preview
   * before the user confirms a destructive rewind.
   *
   * Returns the SDK's RewindFilesResult on success. `canRewind: false` (with
   * an `error` string) is a normal, non-throwing outcome — e.g. the message
   * id is unknown or no checkpoint exists — and is surfaced to the caller
   * inside `data`, not as `{ ok: false }`.
   */
  async rewindFiles(
    userMessageId: string,
    opts?: { dryRun?: boolean },
  ): Promise<{ ok: true; data: unknown } | { ok: false; error: string }> {
    if (!this.query) return { ok: false, error: "no active query" };
    try {
      const data = await this.query.rewindFiles(userMessageId, opts);
      return { ok: true, data };
    } catch (err) {
      return { ok: false, error: err instanceof Error ? err.message : String(err) };
    }
  }

  /**
   * Stop a single running task (Bash command or subagent) by its task id —
   * the SDK emits a `task_notification` with status 'stopped' in response.
   * Targets just that task, unlike `interrupt()` which aborts the whole turn
   * (B2.4). Task ids come from the `task_started` / `task_notification`
   * events the client already tracks in TaskInfo.
   */
  async stopTask(taskId: string): Promise<{ ok: true } | { ok: false; error: string }> {
    if (!this.query) return { ok: false, error: "no active query" };
    try {
      await this.query.stopTask(taskId);
      return { ok: true };
    } catch (err) {
      return { ok: false, error: err instanceof Error ? err.message : String(err) };
    }
  }

  /**
   * Push in-flight foreground work to the background — the control-request
   * equivalent of Ctrl+B in the terminal (B2.4). With `toolUseId` it targets
   * the single blocking task started by that tool_use block; without it,
   * backgrounds all foreground tasks. The blocking tool call returns
   * immediately with a "running in the background" tool_result and the turn
   * continues; the task keeps running and emits a `task_notification` when it
   * settles. Returns the SDK's boolean (false only when a given `toolUseId`
   * matched no foreground task).
   */
  async backgroundTasks(
    toolUseId?: string,
  ): Promise<{ ok: true; backgrounded: boolean } | { ok: false; error: string }> {
    if (!this.query) return { ok: false, error: "no active query" };
    try {
      const backgrounded = await this.query.backgroundTasks(toolUseId);
      return { ok: true, backgrounded };
    } catch (err) {
      return { ok: false, error: err instanceof Error ? err.message : String(err) };
    }
  }

  /**
   * B2.3: replay every path the model has Read this session through the
   * SDK's `seedReadState(path, mtime)` so the CLI's readFileState cache is
   * repopulated after a `compact_boundary`. Without this, an Edit after
   * compaction fails "file not read yet" even though the model believes
   * (correctly) that it has read the file.
   *
   * Best-effort throughout: stat failures (file deleted, permission denied)
   * skip that single path; an SDK throw on `seedReadState` skips this path
   * too. Nothing here surfaces an error to the user — the worst case is the
   * "file not read yet" error this method was added to prevent, which the
   * user will see and recover from manually. We don't await this from the
   * consume loop; the iterator must keep draining the SDK stream.
   *
   * mtimeMs is floored per the SDK contract ("File mtime (floored ms) at
   * the time of the observed Read") so the SDK accepts the seed.
   */
  private async reseedReadPathsAfterCompact(): Promise<void> {
    if (!this.query) return;
    for (const path of this.recentReadPaths) {
      try {
        const st = await fsp.stat(path);
        await this.query.seedReadState(path, Math.floor(st.mtimeMs));
      } catch {
        // Single-path failure (stat threw / seedReadState threw / query
        // closed mid-pass) is non-fatal — move on to the next path.
      }
    }
  }

  /**
   * The subset of create options needed to rebuild this session under the
   * same id during auto-recovery (see `SessionManager.recoverInPlace`).
   * `resume` / `resumeSessionAt` are supplied by the caller.
   */
  getRebuildOpts(): {
    cwd: string;
    model?: string;
    agent?: string;
    maxBudgetUsd?: number;
    taskBudgetTokens?: number;
    maxTurns?: number;
    fallbackModel?: string;
    sandboxEnabled?: boolean;
    enable1mContext?: boolean;
    persistSession?: boolean;
    additionalDirectories?: string[];
    systemPromptAppend?: string;
    planModeInstructions?: string;
    permissionMode: PermissionMode;
  } {
    // Must carry EVERY session-create option so an auto-recovered session
    // (recoverInPlace) is rebuilt identically — omitting a field silently
    // drops that setting on recovery. Keep this in sync with the constructor.
    return {
      cwd: this.cwd,
      model: this.model,
      agent: this.agent,
      maxBudgetUsd: this.maxBudgetUsd,
      taskBudgetTokens: this.taskBudgetTokens,
      maxTurns: this.maxTurns,
      fallbackModel: this.fallbackModel,
      sandboxEnabled: this.sandboxEnabled,
      enable1mContext: this.enable1mContext,
      persistSession: this.persistSession,
      additionalDirectories: this.additionalDirectories,
      systemPromptAppend: this.systemPromptAppend,
      planModeInstructions: this.planModeInstructions,
      permissionMode: this.permissionMode,
    };
  }

  /**
   * One-shot trigger for thinking-block-replay auto-recovery. Called from the
   * `consume()` loop when it observes the 400. Deferred so the current
   * iterator unwinds before we tear the Session down and rebuild it.
   */
  private scheduleThinkingReplayRecovery(): void {
    if (this.thinkingReplayRecoveryScheduled) return;
    this.thinkingReplayRecoveryScheduled = true;
    this.broadcast({
      type: "error",
      message:
        "Thinking-block replay error (HTTP 400) — auto-recovering: rewinding past the failed turn and retrying.",
    });
    setTimeout(() => {
      void this.runThinkingReplayRecovery();
    }, 0);
  }

  /**
   * Feed one observation into the consecutive-overload counter and emit the
   * one-shot manual-switch nudge once the streak crosses
   * `OPUS_OVERLOAD_NUDGE_THRESHOLD`. Gated on:
   *
   *   - The active model is Opus (`isOpusModelId`) — the nudge text only
   *     makes sense for Opus users; firing on Sonnet would be confusing.
   *   - The nudge hasn't already fired this session — fire-once, since the
   *     banner stays dismissible client-side and a streak that keeps growing
   *     after the user has decided is just noise.
   *
   * The streak is reset to 0 by the `result: success` branch in `consume()`.
   * A non-overload observation here doesn't reset (the caller passes false
   * for "no signal seen this iteration" — many message types aren't an
   * overload, but they aren't a *success* either; only a clean turn clears).
   */
  private noteOverloadObservation(isOverload: boolean): void {
    if (!isOverload) return;
    // Count at most once per turn — see `opusOverloadCountedThisTurn` for why.
    if (this.opusOverloadCountedThisTurn) return;
    this.opusOverloadCountedThisTurn = true;
    this.opusOverloadStreak += 1;
    if (this.opusOverloadNudgeFired) return;
    if (!isOpusModelId(this.model)) return;
    if (this.opusOverloadStreak < OPUS_OVERLOAD_NUDGE_THRESHOLD) return;
    this.opusOverloadNudgeFired = true;
    this.broadcast({
      type: "opus_overload_nudge",
      model: this.model ?? "",
      count: this.opusOverloadStreak,
    });
  }

  /**
   * Fire the one-shot long-context credits-required nudge when an SDK
   * `billing_error` is observed on a session that has the 1M-context beta
   * enabled. Mirrors the Claude Code TUI line "Extra usage is required for
   * long context · run /usage-credits to turn them on, or /model to switch
   * to standard context" — the dual-remediation banner is rendered
   * client-side. Gated on:
   *
   *   - `enable1mContext` true on this session — out-of-credits on standard
   *     context is already covered by the rate-limit `overageDisabledReason`
   *     copy in SystemPill, so this stays the 1M-specific surface.
   *   - The nudge hasn't already fired this session — fire-once, since the
   *     banner is dismissible client-side and a repeat error in the same
   *     session just re-pops a dismissed nudge.
   */
  private noteLongContextCreditsObservation(isBillingError: boolean): void {
    if (!isBillingError) return;
    if (this.longContextCreditsNudgeFired) return;
    if (!this.enable1mContext) return;
    this.longContextCreditsNudgeFired = true;
    this.broadcast({
      type: "long_context_credits_required",
      model: this.model ?? "",
    });
  }

  /**
   * Rebuild the session truncated to before the poisoned turn, then re-send
   * the prompt that started it. Reuses the proven resume path
   * (`SessionManager.recoverInPlace` → `create({ resume, resumeSessionAt })`)
   * so the session id — and therefore the open browser tab's URL — is
   * preserved; the client just reconnects to the rebuilt session. Failures
   * are surfaced to the user rather than silently looping.
   */
  private async runThinkingReplayRecovery(): Promise<void> {
    try {
      const messages = await getSessionMessages(this.id, {
        dir: this.cwd,
        includeSystemMessages: false,
      });
      const plan = planThinkingReplayRecovery(messages);
      if (!plan) {
        this.broadcast({
          type: "error",
          message:
            "Could not auto-recover from the thinking-block error (no safe rewind point). Start a new session, or fork before the failing turn.",
        });
        return;
      }
      // Dynamic import avoids a static session ⇄ session-manager import cycle
      // (the manager statically imports Session).
      const { sessionManager } = await import("./session-manager");
      const res = await sessionManager.recoverInPlace(this.id, {
        resumeAt: plan.resumeAt,
        replayPrompt: plan.replayPrompt,
      });
      if (!res.ok) {
        this.broadcast({
          type: "error",
          message:
            res.reason === "max_attempts"
              ? "Auto-recovery gave up after repeated thinking-block failures on the same turn — please start a new session."
              : `Auto-recovery could not rebuild the session (${res.reason}).`,
        });
      }
    } catch (err) {
      this.broadcast({
        type: "error",
        message: `Auto-recovery failed: ${err instanceof Error ? err.message : String(err)}`,
      });
    }
  }

  async end(): Promise<void> {
    this.inputQueue.close();
    this.abortController.abort();
    this.done = true;
    this.stopJsonlWatcher();
    // Backstop: drain any pending agent-decision maps before the Session
    // is dropped. The per-tool `ctx.signal` abort listeners (set when each
    // request was raised) are SUPPOSED to fire from this `abortController.abort()`
    // and clean up the maps themselves, but the cascade depends on how the
    // SDK wires `ctx.signal` to `options.abortController` — if any tool-use
    // signal failed to propagate, the entry would sit forever and any caller
    // touching the stale Session would see `getStatus() === "running"`. The
    // map mutations here are no-ops when the abort listeners already ran
    // (they `.delete` and resolve, the map is empty by the time we get here),
    // so this is purely defensive. See docs/notifications.md §10.2.A.
    this.drainPendingDecisions("Aborted");
    // Drop ephemeral loop state. The Session instance itself is about to
    // be dropped by SessionManager.remove, but if anyone holds a stale
    // reference (test helper, etc.) we don't want them to read ghost
    // loops or pending entries that will never resolve.
    this.scheduledLoops.clear();
    this.pendingScheduledLoops.clear();
  }

  /**
   * Resolve + clear every entry in the three `pending*` decision maps. Used
   * as a backstop from `consume()` finally and `end()` — anywhere the
   * Session is about to stop processing input and we can't leave entries
   * waiting forever (their pending promises would never settle, AND
   * `getStatus()` would return `"running"` indefinitely, which silently
   * breaks both the tab-strip status dot and the `session_idle`
   * notification, since both are gated on `getStatus()` flipping to
   * `"idle"`). Existing abort handlers (lines ~613, ~648, ~675) clean
   * these up via the per-tool `ctx.signal` cascade in the normal case;
   * this is the safety net for when that cascade misses an entry.
   *
   * Caller is responsible for calling `broadcastTurnStatusIfChanged()`
   * afterwards — keeps the broadcast-on-status-flip invariant in one
   * place per call site rather than emitting from inside the drain.
   */
  private drainPendingDecisions(reason: string): void {
    if (
      this.pendingPermissions.size === 0 &&
      this.pendingAskQuestions.size === 0 &&
      this.pendingPlans.size === 0
    ) {
      return;
    }
    const denyResult: PermissionResult = { behavior: "deny", message: reason };
    for (const [id, p] of this.pendingPermissions) {
      this.pendingPermissions.delete(id);
      try {
        p.resolve(denyResult);
      } catch {
        // resolver already settled — fine, we just needed the map slot freed
      }
    }
    for (const [id, p] of this.pendingAskQuestions) {
      this.pendingAskQuestions.delete(id);
      try {
        p.resolve(denyResult);
      } catch {
        // ignore
      }
    }
    for (const [id, p] of this.pendingPlans) {
      this.pendingPlans.delete(id);
      try {
        p.resolve(denyResult);
      } catch {
        // ignore
      }
    }
  }

  /**
   * Re-read the on-disk JSONL for this session and broadcast any messages
   * whose uuid isn't already in the buffer. Used so a browser refresh picks
   * up turns the user added via `claude --resume` in the terminal (or any
   * other writer to the same session file).
   *
   * Idempotent and best-effort — the SDK reader can fail (file moved,
   * permissions, malformed line) and we don't want to block the normal
   * subscribe flow when it does.
   */
  async resyncFromDisk(): Promise<{ added: number }> {
    let added = 0;
    this.jsonlResyncBusy = true;
    try {
      const disk = await getSessionMessages(this.id, {
        dir: this.cwd,
        includeSystemMessages: true,
      });
      if (disk.length === 0) {
        if (sessLoadDebug()) {
           
          console.log("[sess-load] resyncFromDisk empty", {
            id: this.id,
            cwd: this.cwd,
            bufferLen: this.buffer.length,
          });
        }
        return { added: 0 };
      }
      const seen = new Set<string>();
      for (const ev of this.buffer) {
        if (ev.type !== "sdk") continue;
        const m = ev.message as { uuid?: string };
        if (m.uuid) seen.add(m.uuid);
      }
      // Carry-forward timestamp anchor — walk the full disk list (not just
      // the new tail) so assistants we're about to broadcast inherit their
      // turn's user timestamp even when the user record was already in the
      // buffer and we're only adding the assistants that follow it.
      let carriedAt: number | undefined;
      for (const m of disk) {
        const ts = (m as { timestamp?: string }).timestamp;
        const parsed = typeof ts === "string" ? Date.parse(ts) : NaN;
        if (Number.isFinite(parsed)) {
          carriedAt = parsed;
        } else if (typeof carriedAt === "number") {
          carriedAt = carriedAt + 1;
        }
        const uuid = (m as { uuid?: string }).uuid;
        if (!uuid || seen.has(uuid)) continue;
        // Preserve the original JSONL `timestamp` as `at` so the UI shows
        // the time the message was actually written, not "now". Without
        // this, `broadcast()` defaults `at` to Date.now() and a watcher-
        // driven resync (terminal `claude --resume`, external SDK writer)
        // makes historically-old messages appear as if they just arrived
        // — exactly the "old messages coming as new" symptom users hit
        // when they switched contexts. For assistants (no JSONL stamp),
        // ride on the carry-forward so they inherit their turn time
        // instead of falling through to Date.now() in `broadcast()`.
        const at = Number.isFinite(parsed) ? parsed : carriedAt;
        const sdk = m as unknown as SDKMessage;
        this.broadcast({ type: "sdk", message: sdk, at });
        // External writers (terminal `claude --resume`, another SDK client)
        // can arm or cancel loops on disk; replay them through the tracker
        // here too so the server-side store mirrors the client rail after
        // a resync. Pass `at` so `startedAt` reflects the JSONL timestamp
        // (original arming time) and not the resync moment.
        this.trackScheduledLoops(sdk, at ?? undefined);
        added++;
      }
      if (sessLoadDebug()) {
         
        console.log("[sess-load] resyncFromDisk done", {
          id: this.id,
          diskLen: disk.length,
          added,
          bufferLen: this.buffer.length,
        });
      }
    } catch (err) {
      if (sessLoadDebug()) {
         
        console.warn("[sess-load] resyncFromDisk FAILED", {
          id: this.id,
          err: err instanceof Error ? err.message : String(err),
        });
      }
      // non-fatal — the caller proceeds with whatever's already in the buffer
    } finally {
      this.jsonlResyncBusy = false;
    }
    return { added };
  }

  subscribe(fn: Subscriber, opts?: { tail?: number }): () => void {
    const replayWindow = computeReplayWindow(this.buffer, opts?.tail);
    const startIdx = replayWindow.startIdx;
    const hasMoreAbove = replayWindow.hasMoreAbove || this.bufferTrimmed;
    const sliced: ReadonlyArray<ServerEvent> =
      startIdx === 0 ? this.buffer : this.buffer.slice(startIdx);
    // Belt-and-suspenders chronological order for the replay window. The
    // buffer is APPENDED in broadcast order, and broadcast order is normally
    // chronological — but a `resyncFromDisk` race that finds disk lines the
    // live `consume()` loop hasn't pushed yet can append an older message
    // after a newer one. The client also sorts defensively, but doing it
    // here means even a session whose buffer drifted out of order
    // self-corrects on every reconnect. Sort only `sdk` events among
    // themselves and keep non-sdk events (ready / session_title / mode_changed
    // pills) anchored to their original buffer position so control-plane
    // ordering is preserved.
    const toReplay = orderSdkEventsChronologically(sliced);
    if (sessLoadDebug()) {
       
      console.log("[sess-load] subscribe", {
        id: this.id,
        tail: opts?.tail,
        bufferLen: this.buffer.length,
        startIdx,
        replayLen: toReplay.length,
        hasMoreAbove,
        priorSubscribers: this.subscribers.size,
      });
    }
    // Drop ephemeral interactive events from the replay. `permission_request`
    // and `ask_user_question` represent live, in-flight UI prompts — once
    // resolved, replaying them on a new subscriber (reload, second tab,
    // late connect) would re-pop a stale modal whose answer is already on
    // the wire. Live subscribers still see them when the original
    // broadcast happens; only the buffer replay filters them out.
    for (const ev of toReplay) {
      if (
        ev.type === "permission_request" ||
        ev.type === "ask_user_question" ||
        ev.type === "plan_approval_request" ||
        // A one-shot feedback nudge tied to a turn that already finished —
        // replaying it on reload would re-pop a stale survey.
        ev.type === "feedback_survey" ||
        // One-shot Opus overload nudge — once the user has seen it (or the
        // overload event has passed) replaying on reload would re-pop a
        // stale banner. Live subscribers see the original broadcast.
        ev.type === "opus_overload_nudge" ||
        // One-shot long-context credits-required nudge — same shape: once
        // the billing-error has passed (or the user has acted on the dual
        // remediation) replaying on reload would re-pop a stale banner.
        ev.type === "long_context_credits_required"
      )
        continue;
      fn(ev);
    }
    // Tell the client the replay window is over so it can anchor and arm
    // the "load older" sentinel.
    fn({ type: "replay_done", hasMoreAbove });
    // Rehydrate derived state that lives upstream of the tail window. A
    // session might have set its todos hundreds of turns ago, or — far
    // more commonly — its last user prompt is buried under a long tool
    // chain. Either way `replay_done` alone leaves the client without
    // the "what was I asking?" anchor. Both pieces of state ride on the
    // same snapshot event so reconnect paints them atomically.
    if (this.latestTodosSnapshot || this.latestUserPromptSnapshot) {
      fn({
        type: "session_snapshot",
        ...(this.latestTodosSnapshot ? { todos: this.latestTodosSnapshot } : {}),
        ...(this.latestUserPromptSnapshot
          ? { lastUserPrompt: this.latestUserPromptSnapshot }
          : {}),
      });
    }
    // Re-emit `ready` for tail-truncated sessions. `ready` is broadcast
    // exactly once at start() (sits at buffer index 0), so any session
    // with more turns than `tail` slices it off the replay window —
    // leaving the client stuck on the "starting" status indicator even
    // though the SDK Query is healthy. Same shape of bug the
    // `sendFreshTitle` path below works around for session_title.
    if (this.query) {
      fn({
        type: "ready",
        sessionId: this.id,
        ...(this.agent ? { agent: this.agent } : {}),
        ...(this.fallbackModel ? { fallbackModel: this.fallbackModel } : {}),
      });
    }
    // Re-emit the current permission mode for the same reason. A
    // `mode_changed` event broadcast mid-conversation (e.g. by the
    // session-create reconciler when a workspace's default flips, or by
    // the user clicking the mode pill) lives in the buffer at whatever
    // turn it landed on — `tail`-truncated replays slice it off and the
    // client falls back to its initial "default" state, even though the
    // SDK is running with a different mode. Echoing the authoritative
    // current mode here keeps the pill correct on every reconnect.
    fn({ type: "mode_changed", mode: this.permissionMode });
    // Echo the current turn status. The buffer replay only carries
    // streaming assistant chunks; on `replay_done` the client unconditionally
    // clears `pending`, which would leave the StatusLine / tab dot stuck on
    // "Idle" for a session that's still mid-turn (e.g. inside a long Bash).
    // This event resyncs `pending` to the server's authoritative state.
    fn({ type: "turn_status", status: this.getStatus() });
    // Server-driven spinner tips. The client rotates through these under the
    // "Claude is working…" row, but the *catalog* lives server-side so the
    // backend (and, later, the SDK) is the single source of truth — new-feature
    // tips can ship without a client deploy. Emitted per-subscriber (like
    // turn_status / mode_changed above) rather than via the buffer, so every
    // reload/tab gets the current list and it never needs replay handling.
    // `selectTips()` is the seam where contextual gating / a backend feed go.
    // The `spinnerTipsConfig` cache feeds the CLI-parity user-settings knobs
    // (`spinnerTipsEnabled` / `spinnerTipsOverride`) without a per-attach
    // disk read.
    fn({
      type: "tips",
      tips: selectTips({
        spinnerTipsEnabled: this.spinnerTipsConfig.enabled,
        spinnerTipsOverride: this.spinnerTipsConfig.override,
      }),
    });
    // Re-emit the agent's effective working directory for the same
    // tail-truncation reason as `mode_changed`/`turn_status` above. The
    // `cwd_changed` event that moved the agent into a git worktree is
    // broadcast exactly once (deduped in `broadcastCwd`), so any session that
    // entered the worktree more than `tail` turns ago — or more than ~1000
    // events ago, past the buffer cap — slices it off the replay window and
    // the client never paints the "worktree" badge even though the agent is
    // still working outside the session root. `lastCwdBroadcast` is the
    // in-memory source of truth, so echo it here directly (no need to round
    // trip through `broadcastCwd`). Self-clearing still works: if the agent
    // has since returned to the root, `lastCwdBroadcast` equals the root and
    // the client's `worktreeBadge` renders nothing.
    if (this.lastCwdBroadcast) {
      fn({ type: "cwd_changed", cwd: this.lastCwdBroadcast });
    }
    // Re-emit the current goal state for the same tail-truncation reason as
    // `mode_changed`/`cwd_changed` above: the `goal_changed` event broadcast
    // when the goal was set/achieved sits at whatever buffer position it
    // landed on, so a `tail`-truncated replay slices it off and a reconnecting
    // tab paints no GoalBanner even though a goal is active. `this.goal` is the
    // in-memory source of truth; echo it directly. Skip when no goal is set so
    // a fresh subscriber on a goalless session gets nothing to render.
    if (this.goal.goal) {
      fn(this.goalEvent());
    }
    // Now re-emit any interactive prompts that are STILL pending. The
    // historical replay above is filtered to "resolved" prompts; questions
    // and permission requests that the agent is still waiting on need to
    // be redelivered to the new subscriber, otherwise reloading the page
    // (or switching session tabs and coming back) leaves the user with no
    // way to answer them.
    for (const pending of this.pendingAskQuestions.values()) {
      fn({
        type: "ask_user_question",
        requestId: pending.requestId,
        toolUseId: pending.toolUseId,
        questions: pending.questions,
      });
    }
    for (const pending of this.pendingPermissions.values()) {
      fn(pending.meta);
    }
    for (const pending of this.pendingPlans.values()) {
      fn({
        type: "plan_approval_request",
        requestId: pending.requestId,
        toolUseId: pending.toolUseId,
        plan: pending.plan,
        ...(pending.raw ? { raw: pending.raw } : {}),
      });
    }
    this.subscribers.add(fn);
    this.notifySubscriberCount();
    // Pull the freshest SDK-derived title into this subscriber. Two reasons:
    //   1. start() captures the title once; if the SDK auto-generates an
    //      aiTitle/summary AFTER a turn lands (which is the common case for
    //      a fresh session), the original session_title broadcast is stale
    //      or absent and a reload would otherwise see no banner.
    //   2. tail-mode replay slices the buffer to the last N turns; the
    //      session_title event broadcast at start() lives at index 0 and
    //      gets pruned out for any session with more than `tail` turns,
    //      so reconnecting tabs miss it.
    void this.sendFreshTitle(fn);
    // Rehydrate persisted subagent (Task) metadata + inner conversations.
    // These ride on transient SSE-only events absent from the JSONL, so a
    // session rebuilt from disk loses them; this repaints them from SQLite.
    void this.sendTaskSnapshot(fn);
    return () => {
      this.subscribers.delete(fn);
      this.notifySubscriberCount();
    };
  }

  /**
   * Register a callback fired on every subscriber-count change. Used by
   * SessionManager to drive idle reaping: if the count drops to zero and
   * stays there past a grace window, the manager calls `end()` to release
   * the SDK child process. Returns an unregister function.
   */
  onSubscriberCountChange(cb: (count: number) => void): () => void {
    this.subscriberCountListeners.add(cb);
    return () => {
      this.subscriberCountListeners.delete(cb);
    };
  }

  /** Current SSE subscriber count. */
  subscriberCount(): number {
    return this.subscribers.size;
  }

  /**
   * True when the agent is blocked on an interactive prompt that only the
   * user can resolve — an AskUserQuestion form, a permission decision, or
   * a plan-mode approval. The idle reaper consults this so a session with
   * a pending prompt is never killed mid-question; reaping would resolve
   * the SDK's `canUseTool` promise as `{ behavior: "deny", message:
   * "Aborted" }`, writing an errored tool_result that — once on disk —
   * permanently hides the modal and the "Answer" pill from the user.
   *
   * Distinct from `getStatus()` because `turnInFlight` alone (a long-
   * running Bash, a slow tool) doesn't need a human in the loop; we
   * still want the reaper to clean those up so a runaway turn without a
   * watcher doesn't leak the SDK process forever.
   */
  hasPendingUserPrompts(): boolean {
    return (
      this.pendingPermissions.size > 0 ||
      this.pendingAskQuestions.size > 0 ||
      this.pendingPlans.size > 0
    );
  }

  /**
   * Coarse session state for the tabs strip and SessionPicker. Inactive
   * tabs need to know "is the agent currently producing output / awaiting my
   * input?" — this collapses the underlying signals (`turnInFlight`, the
   * three pending-decision maps) into a two-state answer so the StatusDot
   * stays readable.
   *
   *   - `"running"`  → a turn is in flight, OR a permission / ask-user /
   *                    plan-mode prompt is open and waiting for the user.
   *   - `"idle"`     → in memory, last result has been received, no pending
   *                    decisions. The session is ready to accept new input.
   */
  getStatus(): "running" | "idle" {
    if (this.turnInFlight) return "running";
    if (this.pendingPermissions.size > 0) return "running";
    if (this.pendingAskQuestions.size > 0) return "running";
    if (this.pendingPlans.size > 0) return "running";
    if (this.hasActiveSubagents()) return "running";
    return "idle";
  }

  /**
   * True if any tracked subagent (Task) is still doing work that the
   * session should be considered "busy" for. The SDK closes the parent
   * turn (`result` fires, `turnInFlight` flips to false) independently
   * of subagent activity — see the comment on the `result` handler in
   * `consume()` — so without this check a session with a live Explore /
   * subagent would read "Idle" in the StatusLine the instant the parent
   * agent's outer response completed, even though there's real work in
   * flight. Backgrounded Tasks (`run_in_background: true`) are excluded:
   * they're fire-and-forget by contract, and the parent has already
   * moved past them.
   */
  private hasActiveSubagents(): boolean {
    for (const meta of this.taskMetaById.values()) {
      if (meta.isBackgrounded) continue;
      if (meta.status === "running" || meta.status === "pending") return true;
    }
    return false;
  }

  /**
   * Broadcast a `turn_status` event when (and only when) `getStatus()` has
   * flipped since the last broadcast. Call this from every site that mutates
   * `turnInFlight` or the three pending-decision maps — the dedupe keeps the
   * wire clean while guaranteeing late-attaching tabs hear about a running
   * turn even when no further assistant chunks arrive.
   */
  private broadcastTurnStatusIfChanged(): void {
    const next = this.getStatus();
    if (next === this.lastBroadcastStatus) return;
    this.lastBroadcastStatus = next;
    this.broadcast({ type: "turn_status", status: next });
  }

  private notifySubscriberCount(): void {
    const n = this.subscribers.size;
    for (const cb of this.subscriberCountListeners) {
      try {
        cb(n);
      } catch {
        // listener throws shouldn't break the subscribe path
      }
    }
  }

  private async sendFreshTitle(fn: Subscriber): Promise<void> {
    try {
      // Local rename store wins — that's the authoritative override for
      // titles set inside Claudius (and survives across SDK weirdness).
      const local = await getSessionTitle(this.cwd, this.id).catch(() => null);
      const info = local
        ? null
        : await getSessionInfo(this.id, { dir: this.cwd }).catch(() => null);
      // `resolveSessionTitle` returns ONLY trusted titles (DB local or
      // SDK customTitle). It never derives one from prompt text, so a
      // reload / late subscribe can no longer morph the title into the
      // last user message.
      const next = resolveSessionTitle({ local, info });
      if (next && next !== this.title) {
        // Title moved (e.g. TUI rename arrived after start()). Broadcast
        // to every subscriber and persist into the index.
        this.title = next;
        this.broadcast({ type: "session_title", title: next });
        upsertSession({
          id: this.id,
          cwd: this.cwd,
          model: this.model,
          title: next,
        }).catch(() => {});
      } else if (this.title) {
        // No movement, but the new subscriber may have missed the
        // original `session_title` broadcast (tail-pruned by the replay
        // window, or buffered before they connected). Echo the current
        // title just to them — `fn` is the subscriber callback the
        // caller handed us for this one connection, not the full
        // broadcast list.
        fn({ type: "session_title", title: this.title });
      }
      // else: no trusted title and no in-memory title — leave it alone,
      // the UI falls back to the id-prefix label.
    } catch {
      // non-fatal — banner stays empty, header still works
    }
  }

  /**
   * Last effective working directory broadcast to clients via `cwd_changed`.
   * Several independent signals can move it — the SDK's `CwdChanged` hook,
   * `WorktreeCreate`/`WorktreeRemove`, and the PreToolUse path heuristic — so
   * we dedupe against this single source of truth to avoid spamming the SSE
   * stream (and the replay buffer) with redundant events.
   */
  private lastCwdBroadcast: string | null = null;

  /**
   * Broadcast a `cwd_changed` only when the effective cwd actually moved.
   * Centralises the dedupe so every detector can call it freely; the client
   * paints the "worktree" badge whenever this differs from the session root
   * and self-clears when it returns to the root.
   */
  private broadcastCwd(cwd: string): void {
    if (!cwd || cwd === this.lastCwdBroadcast) return;
    this.lastCwdBroadcast = cwd;
    this.broadcast({ type: "cwd_changed", cwd });
  }

  private broadcast(event: ServerEvent): void {
    // Stamp SDK messages with an "observed at" time at this single funnel so
    // the value travels through the replay buffer — every late subscriber
    // (reload, tab-switch, second tab) sees the same time as the first one.
    // Disk-replay callers pre-set `at` from the JSONL `timestamp` field; live
    // sites leave it unset and we default to "now" here.
    if (event.type === "sdk" && event.at == null) {
      event = { ...event, at: Date.now() };
    }
    this.buffer.push(event);
    if (this.buffer.length > 1000) {
      this.bufferTrimmed = true;
      this.buffer.splice(0, this.buffer.length - 1000);
    }
    // Sniff for derived state we want to rehydrate on tab-switch / reload.
    // The tail-replay window can slice off the original tool_use that set
    // these, so we cache the latest payload server-side and replay it via
    // session_snapshot in subscribe().
    this.captureSnapshotState(event);
    // Sniff transient subagent (Task) state — token/tool/duration counters and
    // the inner conversation — and persist it on completion so it survives a
    // disk-rebuild of this session. See captureTaskState() + session-tasks-db.
    this.captureTaskState(event);
    for (const sub of this.subscribers) {
      try {
        sub(event);
      } catch {
        // ignore subscriber errors
      }
    }
    // Feed the workspace notification inbox. The bus filters/dedups internally
    // (subagent skip, kind whitelist, per-session mute, background-session
    // suppression) and swallows errors — failures here must never disrupt
    // the session flow.
    //
    // `hasSubscribers` tells the bus whether this session currently has any
    // live SSE client. When it doesn't (the user switched to another tab),
    // the bus drops session_idle / session_error notifications — they're
    // noise for a session the user isn't looking at. Actionable kinds still
    // ring regardless because the agent is blocked on them.
    void notificationBus.recordSessionEvent(this.cwd, this.id, event, {
      hasSubscribers: this.subscribers.size > 0,
      // Mirror `tabLabelFor`'s fallback so an untitled session still shows a
      // recognisable id-prefix instead of the raw cwd in the inbox.
      sessionTitle: this.title?.trim() || this.id.slice(0, 8),
    });
  }

  /**
   * Latest `todos` payload from a TodoWrite tool_use. Stored as raw
   * `unknown[]` because the client already knows how to coerce that shape;
   * keeping it untouched here means the snapshot is byte-identical with
   * what would be re-synthesised from the buffer.
   */
  private latestTodosSnapshot: unknown[] | null = null;
  private latestTodosSnapshotAt = -Infinity;
  /** Pending TaskCreate tool_use blocks awaiting their tool_result. */
  private pendingTaskCreates = new Map<string, { content: string; activeForm?: string }>();

  /**
   * Latest top-level user prompt (the real one the user typed, not a
   * tool_result wrapper). Tracked separately from the buffer so we can
   * replay it on attach even when a long trailing assistant/tool chain
   * has pushed the original event outside the requested tail window —
   * `subscribe()` emits it inside the `session_snapshot` event after
   * `replay_done`. Same shape of rehydration as the todos snapshot.
   */
  private latestUserPromptSnapshot: { uuid: string; text: string; at?: number } | null = null;

  private captureSnapshotState(event: ServerEvent): void {
    if (event.type !== "sdk") return;
    const m = event.message as {
      type?: string;
      uuid?: string;
      message?: { content?: unknown };
    };
    const parent = (event.message as { parent_tool_use_id?: string | null }).parent_tool_use_id;
    if (parent) return;
    // Real user prompt → cache for the rehydration snapshot. Skip
    // SDK-synthetic tool_result wrappers (same distinction as
    // `isRealUserPrompt` used by computeReplayWindow).
    //
    // Prefer the envelope's `at` over wall-clock now: disk-replay callers
    // (`Session.start` resume path, `resyncFromDisk`) pre-set `at` from the
    // JSONL `timestamp`, so the snapshot reflects when the user actually
    // sent the prompt rather than when we happened to re-broadcast it.
    // For live broadcasts the funnel in `broadcast()` already stamps `at`
    // to Date.now(), so the fallback is just belt-and-suspenders.
    if (m.type === "user") {
      const text = extractUserPromptText(m.message?.content);
      if (text && m.uuid) {
        const at =
          typeof event.at === "number" && Number.isFinite(event.at)
            ? event.at
            : Date.now();
        const prevAt = this.latestUserPromptSnapshot?.at ?? -Infinity;
        if (at >= prevAt) {
          this.latestUserPromptSnapshot = {
            uuid: m.uuid,
            text,
            at,
          };
        }
      }
      // TaskCreate tool_result — promote pending entry to snapshot with real id.
      const userContent = m.message?.content;
      if (Array.isArray(userContent)) {
        for (const raw of userContent as Array<{ type?: string; tool_use_id?: string; content?: unknown; is_error?: boolean }>) {
          if (raw?.type !== "tool_result") continue;
          const toolUseId = raw.tool_use_id;
          if (!toolUseId) continue;
          const pending = this.pendingTaskCreates.get(toolUseId);
          if (!pending) continue;
          this.pendingTaskCreates.delete(toolUseId);
          if (raw.is_error) {
            // Remove the temp entry from the snapshot on error.
            if (this.latestTodosSnapshot) {
              this.latestTodosSnapshot = this.latestTodosSnapshot.filter(
                (t) => (t as Record<string, unknown>).id !== toolUseId,
              );
            }
            continue;
          }
          // Extract result text (string or [{type:"text",text:...}] array).
          let resultText = "";
          if (typeof raw.content === "string") {
            resultText = raw.content;
          } else if (Array.isArray(raw.content)) {
            for (const c of raw.content as Array<{ type?: string; text?: string }>) {
              if (c?.type === "text" && c.text) resultText += c.text;
            }
          }
          try {
            const payload = JSON.parse(resultText) as { task?: { id?: string } };
            const realId = payload?.task?.id;
            if (realId && this.latestTodosSnapshot) {
              this.latestTodosSnapshot = this.latestTodosSnapshot.map((t) =>
                (t as Record<string, unknown>).id === toolUseId
                  ? { ...(t as Record<string, unknown>), id: realId }
                  : t,
              );
            }
          } catch {
            // Parsing failed; leave temp-id entry in place.
          }
        }
      }
      return;
    }
    if (m.type !== "assistant") return;
    const content = m.message?.content;
    if (!Array.isArray(content)) return;
    const at =
      typeof event.at === "number" && Number.isFinite(event.at)
        ? event.at
        : Date.now();
    for (const block of content as Array<{ type?: string; id?: string; name?: string; input?: unknown }>) {
      if (block?.type !== "tool_use") continue;

      // Worktree detection that survives a disk rebuild. The live PreToolUse
      // hook (signal #2 in start()) flags the worktree as edits execute, but
      // that hook does NOT re-fire when a session is rebuilt from its JSONL on
      // a server restart — so a session still working inside a worktree would
      // silently lose its badge after a restart. The mutating-file tool_use
      // blocks ARE in the replayed transcript, and `captureSnapshotState` runs
      // from `broadcast()` on both the live and disk-replay paths, so re-run
      // the same `worktreeRootFromPath` heuristic here. Set-only by design,
      // mirroring the live hook: "agent returned to root" is detected by the
      // SDK's `CwdChanged` hook, which isn't replayed from disk. The value is
      // carried to late subscribers by the `lastCwdBroadcast` re-emit in
      // `subscribe()` (the buffered `cwd_changed` itself gets trimmed).
      if (
        block.name === "Edit" ||
        block.name === "Write" ||
        block.name === "MultiEdit" ||
        block.name === "NotebookEdit"
      ) {
        const inp =
          (block.input as { file_path?: unknown; notebook_path?: unknown } | null) ?? {};
        const target =
          typeof inp.file_path === "string"
            ? inp.file_path
            : typeof inp.notebook_path === "string"
            ? inp.notebook_path
            : null;
        if (target) {
          const wt = worktreeRootFromPath(target);
          if (wt) this.broadcastCwd(wt);
        }
        continue;
      }

      // TodoWrite — full snapshot replacement (legacy; kept for backward compat).
      if (block.name === "TodoWrite") {
        const raw = (block.input as { todos?: unknown } | null)?.todos;
        if (Array.isArray(raw)) {
          if (at >= this.latestTodosSnapshotAt) {
            this.latestTodosSnapshot = raw;
            this.latestTodosSnapshotAt = at;
          }
        }
        // Feature 31 parity: rearm the stale-TodoWrite counter on any
        // TodoWrite tool_use, including disk-replayed ones — a replayed
        // historical write resetting 0 → 0 is harmless, and it keeps the
        // counter aligned with what the agent has actually done.
        this.turnsSinceTodoWrite = 0;
        continue;
      }

      // TaskCreate — add pending entry to snapshot (keyed by tool_use_id);
      // real id arrives via the matching tool_result.
      if (block.name === "TaskCreate" && typeof block.id === "string") {
        if (this.pendingTaskCreates.has(block.id)) continue; // dedup on replay
        // Also skip if already promoted (replayed tool_use after tool_result).
        if (this.latestTodosSnapshot?.some((t) => (t as Record<string, unknown>).id === block.id)) continue;
        const inp = (block.input as { subject?: unknown; activeForm?: unknown }) ?? {};
        const content2 = typeof inp.subject === "string" ? inp.subject : "";
        this.pendingTaskCreates.set(block.id, {
          content: content2,
          activeForm: typeof inp.activeForm === "string" ? inp.activeForm : undefined,
        });
        if (!this.latestTodosSnapshot) this.latestTodosSnapshot = [];
        this.latestTodosSnapshot = [
          ...this.latestTodosSnapshot,
          {
            id: block.id,
            content: content2,
            status: "pending",
            activeForm: typeof inp.activeForm === "string" ? inp.activeForm : undefined,
          },
        ];
        if (at >= this.latestTodosSnapshotAt) this.latestTodosSnapshotAt = at;
        continue;
      }

      // TaskUpdate — apply status/subject changes in-place by taskId.
      if (block.name === "TaskUpdate" && this.latestTodosSnapshot) {
        const inp = (block.input as { taskId?: unknown; subject?: unknown; status?: unknown }) ?? {};
        const taskId = typeof inp.taskId === "string" ? inp.taskId : null;
        if (!taskId) continue;
        const status = typeof inp.status === "string" ? inp.status : null;
        if (status === "deleted") {
          this.latestTodosSnapshot = this.latestTodosSnapshot.filter(
            (t) => (t as Record<string, unknown>).id !== taskId,
          );
        } else {
          this.latestTodosSnapshot = this.latestTodosSnapshot.map((t) => {
            const entry = t as Record<string, unknown>;
            if (entry.id !== taskId) return t;
            const updated = { ...entry };
            if (status) updated.status = status;
            if (typeof inp.subject === "string" && inp.subject) updated.content = inp.subject;
            return updated;
          });
        }
        continue;
      }
    }
  }

  /**
   * In-memory accumulators for subagent (Task) state observed on the wire.
   * Task metadata is keyed by the SDK `task_id`; the inner conversation is
   * keyed by the parent Task `tool_use_id` (== the subagent messages'
   * `parent_tool_use_id`). Both are flushed to SQLite atomically on
   * `task_notification` (completion) by `persistTask`, then replayed via
   * `task_snapshot` in `subscribe()`. Purely live state — rebuilt from the
   * DB on the next session, never read back here.
   */
  private taskMetaById = new Map<string, TaskSnapshotEntry>();
  private subagentMsgsByToolUseId = new Map<string, Array<{ at?: number; message: unknown }>>();
  /** Cap inner-message retention per task so a marathon subagent can't bloat one row. */
  private static readonly MAX_INNER_MESSAGES = 500;
  /**
   * Throttle the live-persist path so a chatty subagent doesn't hammer SQLite.
   * Keyed by `taskId` → last persist timestamp; we only flush again when this
   * cadence has elapsed. Terminal events (`task_notification`) bypass the
   * throttle — they always persist the final state.
   */
  private taskPersistThrottleAt = new Map<string, number>();
  private static readonly TASK_PERSIST_THROTTLE_MS = 2_000;

  /**
   * Sniff subagent (Task) state out of the broadcast stream. Mirrors the
   * client reducer in `lib/client/use-session.ts` (task_started / task_progress
   * / task_updated / task_notification + `parent_tool_use_id` messages), but
   * its sole job is to persist that state on completion. Best-effort and
   * side-effect-free beyond the in-memory maps + the DB write it kicks off.
   */
  private captureTaskState(event: ServerEvent): void {
    if (event.type !== "sdk") return;
    const msg = event.message as {
      type?: string;
      subtype?: string;
      parent_tool_use_id?: string | null;
      task_id?: string;
      tool_use_id?: string;
      description?: string;
      task_type?: string;
      workflow_name?: string;
      summary?: string;
      status?: string;
      patch?: {
        status?: string;
        description?: string;
        error?: string;
        is_backgrounded?: boolean;
      };
      usage?: { total_tokens?: number; tool_uses?: number; duration_ms?: number };
    };

    // Subagent inner message — accumulate the raw envelope under its parent
    // tool_use id so we can replay the conversation faithfully.
    const parent = msg.parent_tool_use_id ?? null;
    if (parent) {
      const list = this.subagentMsgsByToolUseId.get(parent) ?? [];
      list.push({ at: event.at, message: event.message });
      if (list.length > Session.MAX_INNER_MESSAGES) {
        list.splice(0, list.length - Session.MAX_INNER_MESSAGES);
      }
      this.subagentMsgsByToolUseId.set(parent, list);
      // Flush partial inner-message state to SQLite (throttled). This is
      // what makes mid-run reloads survive a server restart / idle-reap:
      // the row gets the latest inner conversation snapshot every couple
      // of seconds while the subagent is alive, instead of only at
      // task_notification (completion).
      this.persistTaskForToolUse(parent, { throttle: true });
      return;
    }

    if (msg.type !== "system" || !msg.task_id) return;
    const taskId = msg.task_id;
    switch (msg.subtype) {
      case "task_started": {
        const meta: TaskSnapshotEntry = {
          taskId,
          toolUseId: msg.tool_use_id,
          description: msg.description,
          taskType: msg.task_type,
          workflowName: msg.workflow_name,
          status: "running",
          innerMessages: [],
        };
        this.taskMetaById.set(taskId, meta);
        // Persist the row immediately so a reload during the very first
        // few seconds of a subagent run still finds metadata in the DB
        // (description, tool_use_id, status="running") — without this the
        // task_snapshot would be empty until the first throttle window
        // elapsed for inner messages, or until the terminal
        // task_notification. Unthrottled so the row exists from t=0.
        this.persistTask(meta);
        // A fresh running subagent is part of `getStatus()` now — the
        // outer parent turn can close (`result` fires) while this Task
        // is still alive, so we have to re-evaluate. See
        // `hasActiveSubagents()`. Re-entry through `broadcast()` is safe
        // because `captureTaskState()` ignores non-`sdk` events (the
        // `turn_status` short-circuits on its `event.type !== "sdk"`
        // guard at the top of this method).
        this.broadcastTurnStatusIfChanged();
        break;
      }
      case "task_progress": {
        const meta = this.taskMetaById.get(taskId);
        if (!meta) break;
        if (msg.description) meta.description = msg.description;
        if (msg.summary) meta.summary = msg.summary;
        if (msg.usage?.total_tokens != null) meta.totalTokens = msg.usage.total_tokens;
        if (msg.usage?.tool_uses != null) meta.toolUses = msg.usage.tool_uses;
        if (msg.usage?.duration_ms != null) meta.durationMs = msg.usage.duration_ms;
        // Periodic AI summary / counter update — flush the updated meta
        // and the latest inner-message accumulator to SQLite. Throttled
        // so a chatty subagent doesn't generate a write per progress
        // tick; the terminal task_notification path is unthrottled and
        // always writes the final state.
        this.persistTask(meta, { throttle: true });
        break;
      }
      case "task_updated": {
        const meta = this.taskMetaById.get(taskId);
        if (!meta) break;
        if (msg.patch?.status) meta.status = msg.patch.status;
        if (msg.patch?.description) meta.description = msg.patch.description;
        if (msg.patch?.error) meta.error = msg.patch.error;
        // Backgrounded tasks must be excluded from `hasActiveSubagents()` —
        // their fire-and-forget contract means a Task can be alive while
        // the session is genuinely idle (the parent already moved on).
        // Same re-entry note as `task_started`.
        if (msg.patch?.is_backgrounded != null) meta.isBackgrounded = msg.patch.is_backgrounded;
        // Persist immediately on state changes — a backgrounded / failed
        // task may not get another touch before the user reloads.
        this.persistTask(meta);
        this.broadcastTurnStatusIfChanged();
        break;
      }
      case "task_notification": {
        const meta = this.taskMetaById.get(taskId) ?? {
          taskId,
          status: msg.status ?? "completed",
          innerMessages: [],
        };
        if (msg.status) meta.status = msg.status;
        if (msg.summary) meta.summary = msg.summary;
        if (msg.usage?.total_tokens != null) meta.totalTokens = msg.usage.total_tokens;
        if (msg.usage?.tool_uses != null) meta.toolUses = msg.usage.tool_uses;
        if (msg.usage?.duration_ms != null) meta.durationMs = msg.usage.duration_ms;
        this.taskMetaById.set(taskId, meta);
        this.persistTask(meta);
        // Terminal subagent event — if this was the last non-backgrounded
        // task running after the parent already closed, `getStatus()`
        // flips back to "idle" here. Without this broadcast the status
        // dot and StatusLine would stay stuck on "running".
        this.broadcastTurnStatusIfChanged();
        break;
      }
      default:
        break;
    }
  }

  /**
   * Snapshot the task (meta + captured inner conversation) into SQLite.
   *
   * `throttle: true` skips the write if `TASK_PERSIST_THROTTLE_MS` hasn't
   * elapsed since the last persist for this taskId — used on the hot path
   * (each inner subagent message, each `task_progress`) so we don't
   * generate one DB write per token. Unthrottled callers (`task_started`,
   * `task_updated`, `task_notification`) always write — those are state
   * transitions whose ordering matters more than write volume.
   */
  private persistTask(meta: TaskSnapshotEntry, opts?: { throttle?: boolean }): void {
    if (opts?.throttle) {
      const last = this.taskPersistThrottleAt.get(meta.taskId) ?? 0;
      const now = Date.now();
      if (now - last < Session.TASK_PERSIST_THROTTLE_MS) return;
      this.taskPersistThrottleAt.set(meta.taskId, now);
    } else {
      // Reset the throttle window on unthrottled writes too, so a flurry
      // of throttled calls right after a state transition doesn't
      // immediately fire a redundant second write.
      this.taskPersistThrottleAt.set(meta.taskId, Date.now());
    }
    const inner = meta.toolUseId
      ? this.subagentMsgsByToolUseId.get(meta.toolUseId) ?? []
      : [];
    const entry: TaskSnapshotEntry = { ...meta, innerMessages: inner };
    void saveSessionTask(this.cwd, this.id, entry).catch(() => {
      // best-effort — a failed persist just means this task won't survive a
      // disk-rebuild; never disrupt the session over it.
    });
  }

  /**
   * Sibling to `persistTask` keyed on the parent `tool_use_id` instead of
   * the SDK task id. Used from the subagent-inner-message hot path, where
   * we only have the `parent_tool_use_id` from the envelope. Resolves to
   * the matching `taskMetaById` entry and delegates; no-ops if we haven't
   * seen `task_started` yet for that tool_use (which would mean the
   * envelope ordering put inner messages before the task header — rare,
   * but the next inner message or `task_started` will catch up).
   */
  private persistTaskForToolUse(toolUseId: string, opts?: { throttle?: boolean }): void {
    for (const meta of this.taskMetaById.values()) {
      if (meta.toolUseId !== toolUseId) continue;
      this.persistTask(meta, opts);
      return;
    }
  }

  /**
   * Best-effort replay of persisted subagent (Task) state to a freshly
   * attached subscriber. Mirrors `sendFreshTitle` — fired async from
   * `subscribe()` so the synchronous buffer replay isn't blocked on a DB
   * read. The client merges idempotently and prefers anything already
   * restored from the buffer, so this only repaints sessions rebuilt from
   * disk (idle-reaped / server-restarted) where the live data was lost.
   */
  private async sendTaskSnapshot(fn: Subscriber): Promise<void> {
    try {
      const tasks = await listSessionTasks(this.cwd, this.id);
      if (tasks.length === 0) return;
      if (!this.subscribers.has(fn)) return; // unsubscribed during the await
      fn({ type: "task_snapshot", tasks });
    } catch {
      // non-fatal — task counters/transcripts simply stay blank on this load
    }
  }

  private async consume(): Promise<void> {
    if (!this.query) return;
    // Track whether the SDK ever emitted a `result` message during this
    // iterator's lifetime, and whether we already broadcast an `error`
    // from the catch. Both feed the synthetic-idle decision in `finally`:
    // we only want to invent a `session_idle` notification when the
    // iterator ended WITHOUT a real terminal event AND without us already
    // having surfaced an error (which would double-notify). See
    // docs/notifications.md §10.2.B.
    let sawResult = false;
    let sawError = false;
    try {
      for await (const message of this.query as AsyncIterable<SDKMessage>) {
        this.broadcast({ type: "sdk", message });
        // Auto-recover from the thinking-block replay 400. The SDK surfaces it
        // as a synthetic assistant "API Error: …" message (not a thrown
        // error), then ends the turn — leaving the poisoned turn as the
        // conversation tail so every future prompt re-fails. Detect it here
        // and schedule an in-place rewind+retry; the guard inside makes it
        // fire at most once per query lifetime.
        if (thinkingReplayErrorFrom(message)) {
          this.scheduleThinkingReplayRecovery();
        }
        // Count consecutive Opus overloads. After a small streak we surface a
        // one-shot banner asking the user to manually `/model` to Sonnet —
        // complementing the SDK's automatic fallback (Options.fallbackModel),
        // which swaps silently and only on configured sessions.
        this.noteOverloadObservation(isOverloadSignal(message));
        // Long-context credits-required nudge (Claude Code TUI parity). Only
        // fires when this session has the 1M-context beta enabled AND the SDK
        // tagged the assistant message `billing_error`. Out-of-credits on a
        // standard-context session is already covered by the existing
        // rate-limit `overageDisabledReason` copy in SystemPill, so the
        // 1M-only gate keeps the two paths from doubling up.
        this.noteLongContextCreditsObservation(isBillingErrorSignal(message));
        // Side-effect: keep the per-session ScheduledLoops map in sync with
        // any cron/wake-up tool_use + tool_result blocks observed on the
        // wire. Mirror of the client-side reducer in `lib/client/use-session.ts` —
        // duplicated rather than shared because the client and server
        // observe different events (SSE vs raw SDK).
        this.trackScheduledLoops(message);
        // B2.3: track every file the model has Read this session, and re-seed
        // the SDK's readFileState cache after each `compact_boundary` so a
        // subsequent Edit doesn't fail "file not read yet" just because
        // compaction stripped the prior Read tool_use from the conversation.
        // Path extraction lives in `lib/shared/read-tool-paths.ts` (unit-tested);
        // the re-seed is fire-and-forget so it never blocks the iterator.
        for (const p of extractReadPaths(message)) this.recentReadPaths.add(p);
        const sysMsg = message as { type?: string; subtype?: string };
        if (sysMsg.type === "system" && sysMsg.subtype === "compact_boundary") {
          void this.reseedReadPathsAfterCompact();
        }
        // Bump the sessions index on each completed turn so list views can
        // sort newest-active first. `result` is the SDK's per-turn done
        // marker — independent of subagent activity.
        if ((message as { type?: string }).type === "result") {
          sawResult = true;
          this.turnInFlight = false;
          this.broadcastTurnStatusIfChanged();
          // Feature 39 parity: if a plan was accepted earlier this run, this
          // is the first turn boundary AFTER its execution finished. Queue
          // the verify-plan nudge so it rides the next real user turn's
          // `takePendingReminders` drain; clearing the flag here keeps it
          // fire-once per accepted plan (a follow-up plan re-arms it via
          // the same `resolvePlan` accept branch).
          if (this.planAwaitingVerify) {
            this.planAwaitingVerify = false;
            queueReminder(this, "verify-plan", verifyPlanReminderBody());
          }
          // A successful turn clears the consecutive thinking-replay recovery
          // budget, so a later, unrelated 400 can still auto-recover even after
          // earlier recoveries this session. Only `subtype: "success"` resets —
          // a poisoned turn never produces one — so a tight recover→re-poison
          // loop (no success between) still trips the cap. Dynamic import keeps
          // the session ⇄ session-manager cycle out of the static graph.
          if ((message as { subtype?: string }).subtype === "success") {
            void import("./session-manager").then(({ sessionManager }) =>
              sessionManager.noteThinkingRecoverySuccess(this.id),
            );
            // A clean turn clears the consecutive-overload streak so a later,
            // unrelated 529 doesn't ride a stale count into the nudge. The
            // nudge itself is fire-once per session lifetime regardless.
            this.opusOverloadStreak = 0;
          }
          // Turn boundary — release the per-turn overload dedupe so the next
          // turn's first 529 signal can bump the streak again. Cleared on
          // every result (success or error) since both end the turn.
          this.opusOverloadCountedThisTurn = false;
          void touchSession(this.cwd, this.id).catch(() => {
            // index update is non-critical; never crash consume() over it
          });
          // Occasionally nudge for feedback (CLI-style survey). Fire-and-
          // forget so the settings read never blocks the turn loop.
          void this.maybeOfferFeedbackSurvey(message);
        }
      }
    } catch (err) {
      // Distinguish a reaper-initiated abort from any other failure. When
      // the SessionManager's idle reaper fires `session.end()`, it calls
      // `abortController.abort()`, which makes the SDK's iterator throw
      // "Claude Code process aborted by user" — but the user wasn't doing
      // anything; they were AWAY, that's why the reaper fired. Surfacing
      // that as a `session_error` notification gives the user a phantom
      // "something broke" alert when they come back. Skip the broadcast
      // entirely in that case so the bus never sees an error event.
      //
      // The user-initiated stop path goes through `query.interrupt()`
      // (not abortController), so `signal.aborted` stays false and the
      // broadcast still fires — picked up by the bus, then auto-read on
      // arrival by the NotificationsProvider gate (same-session-visible
      // mirrors `useNotifications.notify`'s OS-popup suppression).
      if (!this.abortController.signal.aborted) {
        const message = err instanceof Error ? err.message : String(err);
        this.broadcast({ type: "error", message });
        sawError = true;
        // A thrown 529 lands here when the SDK iterator gives up (not as a
        // synthetic API-error assistant message). Feed it through the same
        // overload counter so a catch-block path still trips the nudge.
        this.noteOverloadObservation(isOverloadErrorText(message));
      }
    } finally {
      this.done = true;
      // Defensive: if the SDK iterator returned without ever emitting a
      // `result` (crash / abort), the turn would otherwise look forever
      // "running" to the tabs strip. Drain pending agent-decision maps
      // BEFORE flipping `turnInFlight` so `getStatus()`'s pending-map
      // checks don't keep the session stuck in "running" even after the
      // iterator has clearly ended. Without this drain, a permission /
      // ask-user / plan-mode request whose abort listener didn't fire
      // (the per-tool `ctx.signal` cascade is owned by the SDK and isn't
      // guaranteed to propagate to every listener on every exit path)
      // would leave a phantom entry, getStatus() would still return
      // "running", broadcastTurnStatusIfChanged would dedupe-and-skip,
      // and the session would be silently stuck — exactly the failure
      // mode documented in docs/notifications.md §10.2.A.
      this.drainPendingDecisions("Aborted");
      this.turnInFlight = false;
      this.broadcastTurnStatusIfChanged();

      // Synthetic session_idle for the §10.2.B case: the SDK iterator ended
      // cleanly without ever emitting a terminal `result` message, the user
      // didn't stop or reap the session (signal not aborted), and we didn't
      // already broadcast an error (which would map to session_error). In
      // that gap, neither path fires a notification — the status flips, but
      // the user gets nothing. Route a synthetic `sdk` result event through
      // the bus's public API so it picks up every downstream gate (master
      // switch, kind enablement, per-session mute, background suppression,
      // and crucially the `lastUserInputAt` gate — which still suppresses
      // for resumed / replayed sessions where the user never typed in this
      // process). The event never reaches subscribers or the replay buffer:
      // calling the bus directly keeps disk/buffer parity intact.
      if (
        !sawResult &&
        !sawError &&
        !this.abortController.signal.aborted
      ) {
        void notificationBus.recordSessionEvent(
          this.cwd,
          this.id,
          {
            type: "sdk",
            message: { type: "result" } as unknown as SDKMessage,
          },
          {
            hasSubscribers: this.subscribers.size > 0,
            sessionTitle: this.title?.trim() || this.id.slice(0, 8),
          },
        );
      }
    }
  }
}
