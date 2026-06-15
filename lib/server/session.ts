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
  type SDKControlGetUsageResponse,
  type SDKMessage,
  type SDKUserMessage,
} from "@anthropic-ai/claude-agent-sdk";
import { z } from "zod";
import { projectRoot } from "./db";
import { AsyncQueue } from "./async-queue";
import { notificationBus } from "./notification-bus";
import {
  queueReminder,
  takeMidTurnReminders,
  takePendingReminders,
} from "./system-reminders";
import {
  formatBashIOBlock,
  queueBashBlock,
  takePendingBashBlocks,
} from "./pending-bash-output";
import { dropBashSession, getOrCreateBashSession } from "./bash-mode";
import { validateWorkspaceCwd } from "./workspace-cwd-preflight";
import {
  isOpusModelId,
  isOverloadErrorText,
  isOverloadSignal,
} from "./opus-overload-detector";
import { isBillingErrorSignal } from "./long-context-credits-detector";
import {
  isAuthFailedErrorText,
  isAuthFailedSignal,
} from "./auth-failed-detector";
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
  type PlanUsageEvent,
  type ServerEvent,
  type TaskSnapshotEntry,
} from "@/lib/shared/events";
import { listSessionTasks, saveSessionTask } from "./session-tasks-db";
import {
  listQueue,
  enqueueTail,
  popHead as popQueueHead,
  popByUuid as popQueuedByUuid,
  removeByUuid as removeQueuedByUuid,
  updateByUuid as updateQueuedByUuid,
  moveByUuid as moveQueuedByUuid,
  type QueuedMessageRow,
} from "./queued-messages-db";
import type { QueuedMessageMeta } from "@/lib/shared/events";
import { extractUserPromptText, isAnchorableUserPrompt } from "@/lib/shared/user-prompt";
import {
  planThinkingReplayRecovery,
  thinkingReplayErrorFrom,
} from "./thinking-replay-recovery";
import { extractReadPaths } from "@/lib/shared/read-tool-paths";
import { parseTaskListResult } from "@/lib/shared/parse-tasklist-result";
import { joinSystemPromptAppends } from "@/lib/shared/system-prompt-append";
import { loadDbAgentsForOptions } from "@/lib/server/db-agents";
import { selectTips } from "@/lib/shared/tips";
import type { SessionLoop } from "@/lib/shared/session-loops";
import { readSettings, writeSettings, type ClaudeSettings } from "./settings";
import {
  extractTranscriptTail,
  generateRecap,
  RECAP_DEDUPE_WINDOW_MS,
} from "./session-recap";
import {
  coerceSurveyRate,
  getLastSurveyShownAt,
  noteSurveyShown,
  shouldOfferSurvey,
  SURVEY_MIN_INTERVAL_MS,
} from "./feedback-survey";
import {
  buildEnvForProfile,
  getActiveProfile,
  readAccountsRaw,
  rotateToNextProfile,
  type AccountProfile,
} from "./accounts-store";

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
 * Server-side mirror of `RATE_LIMIT_HIT_TEXT_RE` from
 * `lib/client/use-session.ts`. The CLI emits the rate-limit wall as a
 * plain assistant text message — same regex shape on both sides keeps
 * server-side auto-rotate (account switcher) firing on exactly the
 * messages the client renders as a rate-limit hit. Duplicated rather
 * than shared to avoid pulling client-only types into the server tree.
 */
const RATE_LIMIT_HIT_TEXT_RE = /^you['’]ve hit your [\w .'-]*\blimit\b/i;

function isRateLimitHitSdkMessage(message: unknown): boolean {
  if (!message || typeof message !== "object") return false;
  const m = message as {
    type?: string;
    message?: { content?: unknown };
    parent_tool_use_id?: unknown;
  };
  if (m.type !== "assistant") return false;
  // Subagent text shouldn't trigger account rotation — that's an
  // inner conversation, not the main thread the user is watching.
  if (m.parent_tool_use_id) return false;
  const content = m.message?.content;
  if (!Array.isArray(content) || content.length === 0) return false;
  // Match the client rule: every block must be a text block AND the
  // first one must match the rate-limit phrasing. A mixed
  // text+tool_use block is a real working turn, not a wall.
  for (const block of content) {
    if (!block || typeof block !== "object") return false;
    if ((block as { type?: string }).type !== "text") return false;
  }
  const first = content[0] as { text?: unknown };
  if (typeof first.text !== "string") return false;
  return RATE_LIMIT_HIT_TEXT_RE.test(first.text.trim());
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
 * Per-turn to-do awareness reminder — Claudius-specific (not a CLI parity
 * feature, but inspired by Claude Code's own behavior of keeping the
 * model's to-do list resident in context). Fires on the user's NEXT turn
 * whenever the session has an open snapshot at turn end. Replaces the
 * prior `todos-reconcile` cadence-based design: a 3-turn silent threshold
 * paired with "ignore if not applicable" softening empirically left the
 * "0/N — model never marks anything done" symptom intact, because the
 * model treated the reminder as discretionary. The new shape:
 *
 *   - Fires every user turn (no `silentTurnsSinceReconcileFire` cadence).
 *     Repeated mild pressure keeps the list resident in context the way
 *     Claude Code's CLI does it, so the model is reasoning over the live
 *     state instead of a snapshot it captured 4 turns ago.
 *   - Drops the "this is just a gentle reminder - ignore if not applicable"
 *     softener. Compliance with the to-do-tracking discipline is the goal;
 *     handing the model a permission slip to ignore was load-bearing in
 *     the prior failure mode.
 *   - Stays specifically about the to-do list (no overlap with the rail's
 *     manual per-item controls — those route through `updateTodoItem` and
 *     don't talk to the model). The model still owns "this work is done"
 *     vs "this work is paused"; the user controls the UI directly.
 *
 * Pure helper — no Session lifecycle — so the unit test pins the literal
 * prose contract without constructing a Session. The body is also reused
 * by `Session.maybeAutoSyncTodosOnTurnEnd`, which queues it via
 * `queueReminder(host, "todos-current", body)`.
 */
export function todosCurrentReminderBody(todos: readonly unknown[]): string {
  const base =
    "The current to-do list for this session is shown below. As you work, " +
    "keep it aligned with reality: mark items completed when finished " +
    '(TodoWrite with status "completed", or TaskUpdate with ' +
    'status="completed"), and prune items that are no longer relevant ' +
    '(TaskUpdate with status="deleted", or omit them from the next ' +
    "TodoWrite call). Add new items as they emerge via TaskCreate or by " +
    "extending the next TodoWrite call. The list is visible to the user " +
    "in real time — keeping it accurate is part of the turn's work.";
  if (todos.length === 0) return base;
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

/**
 * Wall-clock age at which a TodoWrite snapshot is considered abandoned and
 * dropped automatically — evaluated at session start (after disk replay).
 * The "stale-todowrite" reminder above is the *soft* nudge that hopes the
 * model prunes itself; this is the *hard* fallback for the case the user
 * flagged: session goes idle, model never closes items, the stale list
 * haunts the UI forever. 24h keeps a long lunch break safe but still catches
 * truly abandoned sessions before the next day starts.
 *
 * The auto-clear also persists a `todosClearedAt` marker — see
 * `Session.clearTodos` — so a server restart that rebuilds from disk JSONL
 * doesn't resurrect the dropped list.
 */
const TODOS_AUTO_CLEAR_MS = 24 * 60 * 60 * 1000;

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
    // The `tail` budget counts CONVERSATIONAL turns, not raw SDK messages.
    // Tool round-trips in Claude Code emit a `user`-role SDK message whose
    // content is a `tool_result` block (plus `<task-notification>`, the
    // post-compact summary, CLI plumbing — all user-shaped bookkeeping the
    // user never typed). A single agentic turn produces dozens of these, so
    // counting them as turns exhausted `tail=20` almost immediately and the
    // window opened deep inside a tool chain — on an assistant/tool turn
    // rather than the prompt ("started on an agent" on reattach). Skip any
    // user record that isn't an anchorable prompt so the budget reflects
    // real back-and-forth. Assistant turns always count.
    const isUserPrompt = m.type === "user" && isAnchorableUserPrompt(m.message?.content);
    if (m.type === "user" && !isUserPrompt) continue;
    turnIdx.push(i);
    // Anchor the window on a real user prompt — `isAnchorableUserPrompt`
    // accepts text prompts AND image-only pastes (genuine input that
    // `isRealUserPrompt` rejects because it carries no prose), while still
    // rejecting the bookkeeping records filtered out above.
    if (isUserPrompt) {
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
   * Account profile this session was spawned under (account-switcher,
   * see `lib/server/accounts-store.ts`). Resolved in `start()` from the
   * "active" profile at the moment of spawn, then frozen — switching
   * the global active profile mid-session must NOT change the auth a
   * running query is using (the SDK reads env once, at `query()`
   * construction). Null = no profile configured; the SDK inherits the
   * ambient environment (pre-account-switcher behavior).
   */
  accountProfileId: string | null = null;
  /**
   * Per-session fire-once flag for account-switcher auto-rotation.
   * When the SDK emits the rate-limit-hit assistant message we want
   * to rotate the active profile ONCE — re-firing every time the
   * client re-asks (which produces the same assistant message via
   * replay) would clobber the rotation back through every configured
   * account. Reset only on session end / start, never mid-life.
   */
  private accountAutoRotated = false;
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
   *
   * Mutable — `setAgent` flips it mid-session via `applyFlagSettings` and the
   * updated value persists to the recovery snapshot so a reap→resume carries
   * the switch forward (same semantics as `model`).
   */
  agent?: string;
  /**
   * Effective advisor model — what the SDK will escalate to mid-turn for
   * stronger judgment. Tracked here so the client can be honestly informed
   * of the current value at any point in the session lifetime (the SDK's
   * `system:init` message does NOT carry advisorModel, so we can't rely on
   * the existing init plumbing the way `model` / `permissionMode` do).
   *
   * Initialized in `start()` from `userSettings.advisorModel` (the value
   * we also forward into the inline `settings` option at session start),
   * and updated in `setAdvisorModel` so picker-driven mid-session changes
   * are reflected here. The /api/sessions/[id]/advisor GET handler reads
   * this field so the client can prime its optimistic mirror on bind.
   *
   * Undefined = no advisor in effect (neither per-session nor settings.json).
   */
  advisorModel?: string;
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
   * array carries `context-1m-2025-08-07`. Only meaningful for Sonnet 4/4.5;
   * newer models (Fable, Opus 4.6+, Sonnet 4.6) include a 1M window by default,
   * so the beta is a no-op for them. Off by default.
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
  /**
   * tabId of the SSE client that currently holds write access.
   * The first client to subscribe with a tabId claims the holder slot;
   * subsequent clients are notified via `holder_changed` and render read-only.
   * Cleared when the holder's SSE stream disconnects.
   * `null` = no holder (session has no live subscriber with a tabId).
   */
  private holderId: string | null = null;
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
  /**
   * Frozen account-switcher env injected at session start (mirrors the
   * `env: envOverride` spread on the main `query()` Options). Cached so any
   * off-band query — today just `generateRecap` — runs under the SAME
   * credentials the conversation started with. Without this the recap would
   * inherit `process.env`, which authenticates with whatever the global
   * active-profile pointer happens to be when the recap fires (could be a
   * different account than the one the session is using).
   */
  private envOverride: { [envVar: string]: string | undefined } | null = null;

  /**
   * Epoch ms of the last completed (or in-flight) recap firing. Backs the
   * multi-tab dedupe guard in `requestRecap`: when N tabs each regain focus
   * after a long blur they all POST to `/recap` within milliseconds, and
   * without this gate every one would spawn its own off-band query. The gate
   * is intentionally one-sided — we record the start, not the end, so a
   * slow generation still suppresses follow-up requests.
   */
  private lastRecapAt: number | null = null;
  /**
   * AbortController for an in-flight recap. Lets a fresh turn (`sendInput`)
   * cancel a stale recap mid-flight — a banner against a now-moving
   * conversation would be misleading.
   */
  private recapAbort: AbortController | null = null;

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
   * Fire-once gate for the authentication-failed nudge — mirrors the Claude
   * Code TUI "Please run /login" hint, scoped to Claudius's accounts UI
   * (`/usage#accounts`). Trips when the SDK emits an `authentication_failed`
   * structured tag OR a synthetic "API Error: 401 / Failed to authenticate"
   * assistant body. Banner is dismissible client-side; re-firing inside the
   * same session lifetime would just re-pop a dismissed banner, so we gate
   * once-per-session like the other one-shot nudges.
   */
  private authFailedNudgeFired = false;

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
   * Did the model call TodoWrite / TaskCreate / TaskUpdate during the
   * currently-running turn? Reset to false at every real `sendInput`
   * (after the slash-command early-return, same site as the
   * `turnsSinceTodoWrite` bump); flipped to true in `captureSnapshotState`
   * whenever any of those three tool_use blocks land. Read in the
   * `consume()` `result` handler to decide whether to queue the
   * `todos-current` next-turn reminder when the turn ends with pending
   * items the model didn't acknowledge.
   *
   * Distinct from `turnsSinceTodoWrite`: that one tracks `TodoWrite`
   * specifically (the legacy snapshot-replacement tool, paired with
   * `stale-todowrite`), and the in-process `TaskCreate`/`TaskUpdate` flow
   * is its own parity feature (`stale-task-tools`). For the turn-end
   * reconcile nudge we want a wider "did the agent touch the list at
   * all this turn" signal — pruning via TaskUpdate is exactly the
   * affordance the nudge is trying to surface, so a turn that fired
   * `TaskUpdate(status="deleted")` shouldn't also trip the reminder.
   *
   * In-memory only (not persisted via `mergeSessionState`): the lifetime
   * is "current turn", same reasoning as the surrounding flags.
   */
  private todosTouchedThisTurn = false;

  /**
   * User-authored per-item overrides that beat what the agent's transcript
   * said about that item. Keyed by todo id, value is the new authoritative
   * status the user clicked into being via the banner / rail UI:
   *
   *   - `"completed"` → user marked the item done (the model never got
   *     around to it).
   *   - `"pending"` → user reopened a previously-completed item.
   *   - `"in_progress"` → user marked an item active (rare; offered for
   *     symmetry with the model's own status set).
   *   - `"deleted"` → user removed the item from the list entirely.
   *     Deleted items don't appear in `latestTodosSnapshot` after the
   *     override is applied — they're filtered, not just hidden.
   *
   * Persisted via `mergeSessionState({manualTodoOverrides})` so a server
   * restart that rebuilds the snapshot from JSONL still honors the user's
   * intent — without persistence, the user's clicks would silently
   * un-stick on every dev-mode HMR rebuild. Applied to `latestTodosSnapshot`
   * at the end of `start()` after disk replay finishes building the
   * pre-override list (so the model's transcript paints first, the user's
   * overrides paint on top).
   *
   * Clear-on-touch: whenever the model touches an id via TodoWrite /
   * TaskCreate / TaskUpdate (live or replayed), the matching override is
   * dropped. The model is asserting a fresh fact about that id, so the
   * user's prior override is stale — let the model win for the next
   * iteration. This keeps the override semantics intuitive ("user nudges
   * the model, model takes over once it engages") and avoids stale
   * overrides quietly diverging from what the model believes long after
   * the conflict was resolved.
   */
  private manualTodoOverrides: Record<string, "completed" | "pending" | "in_progress" | "deleted"> = {};

  /**
   * Set to `true` while `start()` is broadcasting disk-replayed historical
   * events through `captureSnapshotState`, and back to `false` once the
   * replay window is closed. Guards `clearManualTodoOverrideFor` against
   * the load-bearing failure mode where replayed historical TodoWrite /
   * TaskCreate / TaskUpdate events would wipe the just-loaded
   * `manualTodoOverrides` map *before* `applyManualTodoOverrides` had a
   * chance to use it. By invariant, anything in the persisted override
   * map represents user clicks that the live model never engaged with
   * (live `clearManualTodoOverrideFor` already wiped overrides for ids
   * the model touched), so a replay-time clear has no honest signal to
   * act on and only removes information.
   *
   * Not persisted: scope is "this start() invocation" only.
   */
  private isReplayingTranscript = false;

  /**
   * In-memory mirror of `queued_messages` for this session, ordered by `position`
   * ascending. Loaded lazily on first read/mutation and kept in sync by every
   * queue method below. The cache exists so `getStatus()` and `flushQueueIfIdle()`
   * can answer "is the queue empty?" without an awaited DB round-trip — the DB
   * is still the source of truth, every mutation re-syncs from it.
   */
  private queueCache: QueuedMessageRow[] = [];
  private queueLoaded = false;
  /**
   * Mutex for `flushQueueIfIdle()`. Two concurrent drains (e.g. a `result`
   * handler firing at the same instant as `submitPermissionAnswer` resolving)
   * would both pass the `getStatus()==="idle"` guard, both await `popQueueHead`,
   * and pop two items in a single turn boundary — breaking the one-message-
   * per-turn invariant. The flag is checked-and-set before any await so the
   * second caller short-circuits before the race window opens.
   */
  private isDraining = false;

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

  /**
   * Default dispatch mode for new user messages — mirrors the user-scope
   * `queueDispatchMode` setting. Cached at `start()` so the per-send hot
   * path (`/api/sessions/[id]/input`) reads it from memory instead of
   * stat-ing the settings file on every keystroke.
   *
   *   - `"wait"` (default): the existing queue/idle drain behaviour.
   *   - `"asap"`: skip the DB queue, push straight to the SDK's input
   *     pipe on every send, even when a turn is in flight.
   *
   * The per-message "Send now" override on the QueueIndicator strip
   * bypasses this for one item at a time via `sendQueuedNow()` — that
   * path is the same as asap for the popped item.
   */
  private queueDispatchMode: "wait" | "asap" = "wait";

  /** Public accessor used by the /input route to resolve queue-vs-send. */
  get effectiveQueueDispatchMode(): "wait" | "asap" {
    return this.queueDispatchMode;
  }

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

    // Pre-flight: verify the workspace cwd actually exists on disk.
    //
    // Refuses to spawn the SDK when the workspace folder is missing or
    // isn't a directory. Without this, the SDK's `spawn(claudeBin, args,
    // { cwd })` call fails with ENOENT on the cwd, Node attributes the
    // errno to the binary arg, and the user sees the misleading "Claude
    // Code native binary … exists but failed to launch" banner with no
    // path forward. See `workspace-cwd-preflight.ts` for the full
    // story + the regression that motivated extracting the check into
    // its own unit-tested module.
    const preflight = await validateWorkspaceCwd(this.cwd);
    if (!preflight.ok) {
      this.broadcast({ type: "error", message: preflight.message });
      return;
    }

    // Sweep orphaned actionable notification rows for this session. The
    // in-memory `pendingAskQuestions` / `pendingPermissions` / `pendingPlans`
    // maps start empty on a fresh Session instance — by definition, any
    // unread `permission_request` / `ask_user_question` / `plan_approval_request`
    // row in the DB tied to this sessionId is an orphan from a prior
    // lifecycle (typical: dev-mode HMR rebuild between question creation
    // and the user's answer; also: hard server crash, or any path that
    // dropped the pending entry without firing markReadByRequestId).
    // Without this sweep the badge ticks up on the tab strip and never
    // clears, because actionable rows are excluded from the normal
    // "I selected the tab" auto-read sweep (markReadBySession) by design.
    // Fire-and-forget: failure to sweep is strictly cosmetic, must not
    // block the SDK query from spinning up.
    void notificationBus.sweepOrphanedActionableForSession(this.cwd, this.id);

    // Seed the TodoWrite cutoff from the durable clear marker (if any)
    // BEFORE the resume block below replays disk events. Without this seed
    // every replayed `TodoWrite` / `TaskCreate` tool_use lands through
    // `captureSnapshotState` and re-populates `latestTodosSnapshot` — the
    // user's manual or auto-fired Clear would silently resurrect on every
    // server start. With the seed, `at < latestTodosSnapshotAt` guards in
    // both branches bounce pre-clear entries while admitting anything the
    // model writes afterwards. Missing/malformed state stays at the
    // `-Infinity` sentinel, which is `< any-finite-at`, so a fresh session
    // admits every replay.
    try {
      const state = await getSessionState(this.cwd, this.id);
      const clearedAt =
        typeof state.todosClearedAt === "number" && Number.isFinite(state.todosClearedAt)
          ? state.todosClearedAt
          : null;
      if (clearedAt != null) this.latestTodosSnapshotAt = clearedAt;
      // Load persisted per-item overrides — applied to the snapshot AFTER
      // disk replay finishes (see the `applyManualTodoOverrides` call
      // below). Replay runs `captureSnapshotState` for every TodoWrite /
      // TaskCreate / TaskUpdate event, and each of those branches clears
      // the override for any id the model touched in the transcript. So
      // by the time we apply, the override map only contains entries the
      // model never engaged with — exactly the "user said done, model
      // never acknowledged" case the per-item UI exists for.
      const rawOverrides = state.manualTodoOverrides;
      if (rawOverrides && typeof rawOverrides === "object" && !Array.isArray(rawOverrides)) {
        const next: Record<string, "completed" | "pending" | "in_progress" | "deleted"> = {};
        for (const [id, status] of Object.entries(rawOverrides as Record<string, unknown>)) {
          if (typeof id !== "string" || !id) continue;
          if (
            status === "completed" ||
            status === "pending" ||
            status === "in_progress" ||
            status === "deleted"
          ) {
            next[id] = status;
          }
        }
        this.manualTodoOverrides = next;
      }
    } catch {
      // best-effort: a missed read just falls back to the default sentinel
    }

    // The SDK's `resume` option loads the conversation into the model's
    // context but does NOT re-emit historical events to our consumer
    // iterable. Read them from disk via `getSessionMessages` and broadcast
    // each into our buffer so SSE subscribers replay the full transcript.
    //
    // The `isReplayingTranscript` flag below tells `captureSnapshotState`
    // it's processing HISTORICAL events, not live ones. The only path
    // that respects it today is `clearManualTodoOverrideFor`: replayed
    // events predate the user's persisted override (otherwise the
    // override would have been cleared LIVE before persisting), so a
    // replay-time clear would defeat the override durability we built.
    // Live events after `start()` returns clear normally — that's the
    // "model engaged with this id post-click, take over" semantic.
    this.isReplayingTranscript = true;
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
    // Replay window is closed — from this point on, every
    // `captureSnapshotState` call is processing a LIVE event, and
    // `clearManualTodoOverrideFor` is allowed to drop overrides for ids
    // the model touches going forward.
    this.isReplayingTranscript = false;

    // Stale-snapshot auto-clear. After the resume loop rebuilt
    // `latestTodosSnapshot` from any TodoWrite/TaskCreate tool_uses in the
    // JSONL, drop the list if its newest entry is older than
    // `TODOS_AUTO_CLEAR_MS`. Catches the abandoned-session case (model
    // finished a turn without closing items, user wandered off for a day)
    // without poking the model. Recently-touched lists are left alone —
    // the user might still be mid-plan. `clearTodos` writes the
    // `todosClearedAt` marker, broadcasts the empty snapshot for any tab
    // already attached, and bumps the cutoff so the synthetic post-replay
    // snapshot in `subscribe()` paints `[]` for late subscribers too.
    if (
      this.latestTodosSnapshot &&
      this.latestTodosSnapshot.length > 0 &&
      Number.isFinite(this.latestTodosSnapshotAt) &&
      Date.now() - this.latestTodosSnapshotAt > TODOS_AUTO_CLEAR_MS
    ) {
      await this.clearTodos("stale").catch(() => {});
    }

    // Apply manual per-item overrides on top of the replayed snapshot.
    // Runs AFTER the staleness auto-clear (no point overriding items
    // about to be wholesale dropped) and AFTER captureSnapshotState has
    // already cleared overrides for ids the model touched in the
    // transcript. Whatever survives is the "user said done, model never
    // engaged" set — apply it directly to the snapshot. No broadcast
    // here: this runs before `subscribe()` accepts its first subscriber,
    // so the post-replay `session_snapshot` synthesized in `subscribe()`
    // already paints the override-applied list.
    this.applyManualTodoOverrides();

    // All-completed auto-clear on resume. The live turn-end version of
    // this check fires from `maybeAutoSyncTodosOnTurnEnd`, but a session
    // that finished its work and then went idle (no further turn) would
    // resurface the "6/6 All done" list to the user on every restart
    // until they reached for the Clear button. Mirror the live check
    // here so a JSONL-rebuild that lands in the all-completed state
    // drops the list automatically — same honest signal (only the model
    // produces the `"completed"` status), same `clearTodos("completed")`
    // call path. Guarded on length>0 because `[].every(...)` is true on
    // the empty array and we don't want to bump the cutoff for a list
    // that wasn't there.
    if (
      this.latestTodosSnapshot &&
      this.latestTodosSnapshot.length > 0 &&
      this.latestTodosSnapshot.every(
        (t) => (t as { status?: unknown }).status === "completed",
      )
    ) {
      await this.clearTodos("completed").catch(() => {});
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
    // Resolve the queue-dispatch mode from user settings (default "wait").
    // Cached for the lifetime of this Session; a settings change after
    // start() won't retroactively apply — the user already accepted that
    // tradeoff for the other settings-derived caches above.
    this.queueDispatchMode =
      userSettings.queueDispatchMode === "asap" ? "asap" : "wait";

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

    // Account-switcher (see `accounts-store.ts`). When the user has
    // configured one or more accounts and picked an active one, build a
    // scrubbed env that injects exactly that profile's credential — and
    // freeze the profile id on `this` so the live session keeps the auth
    // it spawned under, even if the user flips the global "active"
    // pointer mid-conversation. When no profile is configured the SDK
    // inherits process.env (pre-account-switcher behavior preserved
    // byte-for-byte).
    let activeProfile: AccountProfile | null = null;
    try {
      activeProfile = await getActiveProfile();
    } catch {
      // Disk read failed (corrupt JSON, perms). Fall through to ambient
      // env — refusing to start a session over an accounts.json glitch
      // would block the user from the obvious recovery (open /usage
      // and re-add).
      activeProfile = null;
    }
    this.accountProfileId = activeProfile?.id ?? null;
    // `buildEnvForProfile` is async: it provisions a per-profile
    // config dir (with the profile's `.credentials.json`) and sets
    // `CLAUDE_CONFIG_DIR` to it — the only mechanism we've found that
    // actually routes billing to the chosen account. Env-only
    // injection of `CLAUDE_CODE_OAUTH_TOKEN` is silently overridden by
    // the SDK's macOS Keychain credential lookup. See
    // `provisionProfileConfigDir` in `accounts-store.ts`.
    const envOverride = activeProfile ? await buildEnvForProfile(activeProfile) : null;
    // Freeze for off-band queries (recap) — see `envOverride` field doc.
    this.envOverride = envOverride;

    // Cache the effective advisor on `this` so the client can prime its
    // optimistic mirror via GET /api/sessions/[id]/advisor — the SDK's
    // `system:init` message doesn't carry advisorModel, so without this
    // the SessionCard would always render "No advisor" even when the user's
    // settings.json sets one (i.e. the recommended Sonnet-main / Opus-
    // advisor setup). Updates flow through `setAdvisorModel` to keep this
    // in lock-step with the flag-layer override during the session.
    if (typeof userSettings.advisorModel === "string") {
      this.advisorModel = userSettings.advisorModel;
    }

    // Proactively clear the advisor when the persisted model is incompatible
    // with it. This handles the case where the user switched to an
    // incompatible model in a *previous* session (setModel() cleared it for
    // that session's turns, but the user may have the advisor re-enabled
    // between sessions, or the model was set at DB level without going
    // through setModel). Fable-class models reject any advisor tool in the
    // API request (400: "cannot be used as an advisor when the request model
    // is 'claude-fable-*'"). Clearing here — before options/settings are
    // built — prevents the first user message from failing.
    //
    // We also delete the key from the in-memory `userSettings` object so
    // that the `options.settings` spread below (which forwards advisorModel
    // to the SDK flag layer) doesn't seed the incompatible value.
    if (this.advisorModel && this.model?.includes("fable")) {
      const previousAdvisor = this.advisorModel;
      this.advisorModel = undefined;
      delete (userSettings as ClaudeSettings).advisorModel;
      // Best-effort disk clear so subsequent sessions also start clean.
      const cleaned: ClaudeSettings = { ...userSettings };
      writeSettings("user", this.cwd, cleaned).catch((err) => {
        console.error("[session.start] advisor-fable-incompatible clear failed", err);
      });
      // We don't broadcast here synchronously; the SSE client subscribes
      // after start() returns. Instead, schedule it after the session_ready
      // broadcast so the client's event handler is live.
      setImmediate(() => {
        this.broadcast({
          type: "advisor_disabled_on_model_change",
          previousAdvisor,
          newModel: this.model,
        });
      });
    }

    const options: Options = {
      cwd: this.cwd,
      model: this.model,
      // Account-switcher env injection. When a profile is active, the SDK
      // sees a scrubbed env (no stray auth vars) plus the single one this
      // profile dictates. When no profile is configured we omit `env`
      // entirely so the SDK falls back to inheriting process.env (the SDK
      // contract: `Options.env` REPLACES the subprocess env if set).
      ...(envOverride ? { env: envOverride } : {}),
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
      // Forward Settings-level flags through the inline `settings` option —
      // anything that lives in the `Settings` type (not `Options`) needs an
      // explicit hand-off when we want the value at the SDK's *flag* layer
      // rather than the *user/project/local* layer. The SDK does load
      // filesystem settings by default (settingSources unset ⇒ all sources;
      // sdk.d.ts ~1834), but the account-switcher above can re-point
      // `CLAUDE_CONFIG_DIR` at a per-profile directory — and the SDK's
      // auto-load follows that env, so a value in `~/.claude/settings.json`
      // (what `readSettings("user")` here resolves) may NOT be the file the
      // SDK actually reads under an active profile. Forwarding here puts
      // the value at the flag layer, which sits above all filesystem layers
      // in precedence — so the choice surfaced in the global Settings page
      // takes effect even when the SDK's disk path has diverged from ours.
      //
      // Both forwarded values share the same `settings` key, so we build
      // ONE object: an earlier `settings: {...}` spread would be clobbered
      // by a later one (object-literal duplicate-key semantics).
      //
      //   • includeCoAuthoredBy — Git trailer toggle (Settings → Git).
      //   • advisorModel — advisor escalation model (Settings → Model &
      //     behavior). Picker lives both on the SessionCard and on the
      //     global Settings page; values are constrained to those three
      //     via lib/shared/advisor.ts but we forward whatever string the
      //     user has (advanced users can hand-edit settings.json).
      ...(typeof userSettings.includeCoAuthoredBy === "boolean" ||
      typeof userSettings.advisorModel === "string"
        ? {
            settings: {
              ...(typeof userSettings.includeCoAuthoredBy === "boolean"
                ? { includeCoAuthoredBy: userSettings.includeCoAuthoredBy }
                : {}),
              ...(typeof userSettings.advisorModel === "string"
                ? { advisorModel: userSettings.advisorModel }
                : {}),
            },
          }
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
                // Mid-turn reminder drain (parity features 29, 35, 40). Any
                // queueMidTurnReminder() since the previous tool call gets
                // threaded into the agent's context here, before it sees
                // the next tool result. Wrapped in hookSpecificOutput per
                // the SDK's PreToolUseHookSpecificOutput shape.
                const additionalContext = takeMidTurnReminders(this);
                if (additionalContext) {
                  return {
                    continue: true,
                    hookSpecificOutput: {
                      hookEventName: "PreToolUse",
                      additionalContext,
                    },
                  };
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
    // Auto-drain any items that were sitting in the queue when the server
    // came back up (or when this session was reaped while idle and is now
    // being revived). The whole point of moving the queue server-side: even
    // if the user never reopens the tab, queued messages will eventually
    // run. `flushQueueIfIdle` guards on `getStatus() === "idle"`, so if a
    // resumed turn is somehow already running we'll skip and the result-
    // handler drain picks it up later.
    void this.flushQueueIfIdle().catch(() => {});
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
          // Clear the matching inbox row so the per-tab badge for an
          // aborted plan-approval doesn't linger as an orphan. Mirror of
          // resolvePlan() — see drainPendingDecisions for the full rationale.
          void notificationBus.markReadByRequestId(this.cwd, requestId);
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
            // Clear the matching inbox row so an aborted question doesn't
            // sit unread on the badge. Mirror of submitAskAnswer; see
            // drainPendingDecisions for the full rationale.
            void notificationBus.markReadByRequestId(this.cwd, requestId);
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
        // Clear the matching inbox row so an aborted permission request
        // doesn't sit unread on the badge. Mirror of resolvePermission; see
        // drainPendingDecisions for the full rationale.
        void notificationBus.markReadByRequestId(this.cwd, requestId);
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
    // If this answer cleared the last gating prompt and no turn is in flight,
    // drain a queued message. Idle-guard inside `flushQueueIfIdle` makes this
    // a no-op when the turn continues, so we can call unconditionally.
    void this.flushQueueIfIdle().catch(() => {});
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
      void this.flushQueueIfIdle().catch(() => {});
      return true;
    }

    pending.resolve({
      behavior: "allow",
      updatedInput: buildAskUpdatedInput(pending.questions, answers),
    });
    this.broadcastTurnStatusIfChanged();
    void this.flushQueueIfIdle().catch(() => {});
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
      void this.flushQueueIfIdle().catch(() => {});
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
    void this.flushQueueIfIdle().catch(() => {});
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

    // Cancel any in-flight recap — a "where were we?" banner against a
    // conversation that's about to advance would mislead. The aborted-result
    // branch in `requestRecap` swallows silently so no error event lands.
    if (this.recapAbort) {
      this.recapAbort.abort();
      this.recapAbort = null;
    }

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
      // Only fire when there's actually a list to be stale ABOUT. The
      // legacy behavior queued the reminder unconditionally — including
      // for sessions that had never touched a to-do (pure research /
      // single-shot Q&A), nudging the model to "consider TodoWrite" for
      // work that genuinely doesn't need tracking. That's noise: the
      // upstream SDK already fires its own `task_reminder` for that
      // case via the TaskCreate / TaskUpdate tool gate, which we can't
      // suppress without disabling the tools, so duplicating the nudge
      // from Claudius's side is pure tax. Gate on snapshot presence so
      // this reminder is exclusively about cleaning up a list that's
      // already started and gone idle — its honest signal.
      //
      // The counter still resets either way so a single "burned" silent
      // stretch doesn't keep tripping every turn after threshold.
      const snapshot = this.latestTodosSnapshot;
      if (snapshot && snapshot.length > 0) {
        const body = staleTodoReminderBody(snapshot);
        queueReminder(this, "stale-todowrite", body);
      }
      this.turnsSinceTodoWrite = 0;
    }

    // Rearm the per-turn "did the agent touch the to-do list" detector for
    // the upcoming assistant turn. Set BEFORE the inputQueue push so a
    // racing `captureSnapshotState` (it runs synchronously off `broadcast`)
    // observed before this line can't be silently overwritten — in practice
    // `sendInput` runs before the SDK has consumed the queued message, so
    // the assistant tool_uses can only land after this reset.
    this.todosTouchedThisTurn = false;

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
      // `!` bash-mode output (Claude Code parity). Drained at the same site
      // as reminders so a series of `!` commands followed by a real prompt
      // hands the model `<bash-input>/…/<bash-stderr>` blocks as committed
      // history. Order: bash blocks BEFORE goal/reminder text so the model
      // reads them as past turns the user already saw, with the goal/nudge
      // sitting closest to "now" in the assembled prefix.
      const bashBlocks = takePendingBashBlocks(this) ?? "";
      const prefix = bashBlocks + reminder + pending;
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
    // `!` bash-mode output rides the same prefix slot here too — same
    // ordering rationale as the text-only branch above. Falls into a
    // single text block alongside reminders/goal so the prepend stays
    // a single ContentBlock prepended ahead of the user's images.
    const bashBlocks = takePendingBashBlocks(this) ?? "";
    const prefix = bashBlocks + reminder + pending;
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

  /**
   * Run a command on the session's persistent `!` bash and surface the result
   * to both the chat UI and the model (Claude Code `!`-mode parity).
   *
   *   - Live UI: a synthetic SDK user-turn event is broadcast carrying
   *     `<bash-input>cmd</bash-input>` AND the formatted stdout/stderr block,
   *     so the chat renders a BashIO row immediately. This event lives in
   *     the SSE replay buffer only — it does NOT push into the SDK
   *     inputQueue, so the model is NOT invoked (matching `shouldQuery:false`
   *     in the leaked Claude Code `processBashCommand`).
   *   - Next prompt: the same block is queued onto `pending-bash-output` so
   *     when the user types a real prompt next, `sendInput`'s prefix drain
   *     prepends the bash IO to the inputQueue content. The model reads it
   *     as committed prior conversation context. This is the only path that
   *     reaches JSONL (the SDK writes what it sees on the inputQueue).
   *
   * Sudo: if `sudoPassword` is set, the command is rewritten to `sudo -S
   * -p '' …` and the password (with a trailing newline) is fed to the
   * shell's stdin BEFORE the command runs, so the first `sudo` read picks
   * it up. The password is NEVER logged, broadcast, queued, or persisted
   * in any form — only the rewritten command string (which does NOT
   * contain the password) appears in the user-visible echo.
   */
  async runBashCommand(opts: {
    command: string;
    sudoPassword?: string;
    uuid?: string;
  }): Promise<{
    uuid: string;
    stdout: string;
    stderr: string;
    exitCode: number;
    truncated: boolean;
    timedOut: boolean;
  }> {
    const { command, sudoPassword } = opts;
    const uuid = (opts.uuid ?? randomUUID()) as ReturnType<typeof randomUUID>;

    const bash = getOrCreateBashSession(this.id, this.cwd);
    // Sudo wrapping: bash itself consumes stdin between commands in a
    // persistent shell, so we can't safely feed the password via a stdin
    // write. Instead we wrap the `sudo` invocation in a per-call heredoc
    // — bash routes the heredoc body to sudo's stdin only, leaving the
    // shell's own input stream untouched. The delimiter carries the same
    // UUID-y entropy as the bash-mode sentinel so the password's content
    // cannot collide with it.
    let wrappedCommand = command;
    if (sudoPassword) {
      // Compound-command guard. The heredoc `<<'DELIM'` binds to the
      // LAST simple command on its line, so `sudo a && sudo b` routes
      // the password to `sudo b` and leaves `sudo a` waiting on stdin
      // (which it gets from the persistent bash's input stream — a
      // silent footgun). Detect and surface a clean error rather than
      // produce a confusing half-broken run; users can run a single
      // sudo (`sudo bash -c "a && b"`) instead. Word-anchored so a
      // literal `sudo` inside e.g. `echo "use sudo"` is ignored.
      const sudoOccurrences = (command.match(/\bsudo\b/g) ?? []).length;
      if (sudoOccurrences > 1) {
        const errBlock = formatBashIOBlock(command, {
          stdout: "",
          stderr:
            "claudius: compound sudo commands aren't supported in `!`-mode. " +
            "Wrap them in a single `sudo bash -c \"…\"` so one password unlocks the whole run.",
        });
        queueBashBlock(this, errBlock);
        this.broadcast({
          type: "sdk",
          message: {
            type: "user",
            message: { role: "user", content: errBlock },
            parent_tool_use_id: null,
            session_id: this.id,
            uuid,
          } as unknown as SDKMessage,
        });
        return {
          uuid,
          stdout: "",
          stderr:
            "claudius: compound sudo commands aren't supported in `!`-mode. " +
            "Wrap them in a single `sudo bash -c \"…\"` so one password unlocks the whole run.",
          exitCode: -1,
          truncated: false,
          timedOut: false,
        };
      }
      const delim = `__CLAUDIUS_PWD_${uuid.replace(/-/g, "")}__`;
      // Inject `-S -p ''` so sudo reads from stdin and stays silent on
      // its prompt. Anchor on the first `sudo` token so a literal `sudo`
      // anywhere later (e.g. inside `echo`) is untouched.
      const sudoified = command.replace(/^(\s*sudo\b)/, "$1 -S -p ''");
      wrappedCommand = `${sudoified} <<'${delim}'\n${sudoPassword}\n${delim}`;
    }

    const result = await bash.exec(wrappedCommand);

    // Build the IO block once — same string lives in the broadcast echo
    // AND in the model-facing pending queue, so the UI and the model see
    // byte-identical context.
    const ioBlock = formatBashIOBlock(command, result);
    queueBashBlock(this, ioBlock);

    // Broadcast a synthetic user-turn message for the chat. The content
    // is the full IO block (input + stdout + stderr); the chat renderer
    // (`UserMessage`) recognises the `<bash-input>` opener and switches to
    // the BashIO component. Lives only in the SSE replay buffer; reloads
    // before the next real prompt won't see it (the model-facing copy
    // arrives in JSONL via the next user-turn prefix drain). NB: we DO
    // NOT set `isMeta` here — the client filter (`sdk-message-filters.ts`)
    // drops `isMeta` messages, which would silently hide the bash echo.
    // Derived-string cleanliness is handled by `cleanBashBlocks` in
    // `customization-description.ts`, so isMeta carries downside only.
    this.broadcast({
      type: "sdk",
      message: {
        type: "user",
        message: { role: "user", content: ioBlock },
        parent_tool_use_id: null,
        session_id: this.id,
        uuid,
      } as unknown as SDKMessage,
    });

    return {
      uuid,
      stdout: result.stdout,
      stderr: result.stderr,
      exitCode: result.exitCode,
      truncated: result.truncated,
      timedOut: result.timedOut,
    };
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
   * Drop the agent's TodoWrite snapshot — the user-facing "this list is
   * dead, stop showing it" lever. Wired from the chat-level `TodosBanner`
   * Clear button and the rail's To-dos eraser; also re-invoked internally
   * from `start()` for the staleness auto-clear.
   *
   * Always advances the cutoff, always persists the marker, always
   * broadcasts the empty snapshot — even when the server-side
   * `latestTodosSnapshot` is already null. That asymmetry-tolerant rule is
   * load-bearing: the client's `latestTodos` and the server's snapshot are
   * two independent accumulators. The client rebuilds its list from
   * replayed `TodoWrite` / `TaskCreate` tool_use events on every reconnect,
   * while the server snapshot can already be null from a prior auto-clear
   * (whose cutoff bounced those replays). Skipping the broadcast in that
   * state would no-op the click for every user whose UI is showing a
   * rebuilt list — the exact "Clear button does nothing" symptom we
   * saw. Idempotent for honestly-empty cases, load-bearing for the
   * asymmetric one.
   *
   * Durability rides on `mergeSessionState({ todosClearedAt })`: a later
   * server restart that rebuilds from disk JSONL replays every `TodoWrite`
   * / `TaskCreate` through `captureSnapshotState`, and the seeded
   * `latestTodosSnapshotAt` cutoff bounces every pre-clear entry. The
   * `subscribe()` synthetic snapshot then paints `[]` for late
   * subscribers, overriding any list the client may have rebuilt from the
   * SSE-replayed tool_use events that the cutoff bounced server-side but
   * couldn't pull off the wire.
   */
  async clearTodos(reason: "manual" | "stale" | "completed" = "manual"): Promise<void> {
    const prevCount = this.latestTodosSnapshot?.length ?? 0;
    const at = Date.now();
    // Set in-memory state first so a racing `TodoWrite` tool_use (already
    // observed but not yet captured by `broadcast()`) lands AFTER the
    // cutoff and survives the clear.
    this.latestTodosSnapshot = null;
    this.latestTodosSnapshotAt = at;
    this.pendingTaskCreates.clear();
    // Rearm the stale-TodoWrite turn counter — we don't want the next
    // turn to immediately fire the gentle nudge (the list is gone; there's
    // nothing left to "prune").
    this.turnsSinceTodoWrite = 0;
    try {
      await mergeSessionState(this.cwd, this.id, { todosClearedAt: at });
    } catch {
      // best-effort: a missed marker would let a future server restart
      // re-replay the JSONL TodoWrites; the live broadcast below still
      // gives every connected tab an empty state immediately.
    }
    this.broadcast({ type: "session_snapshot", todos: [] });
    // Transient toast for system-initiated closes only. Manual clears
    // (the user clicked Clear) don't need a toast — the user already
    // knows what they just did, and an "I cleared the list" notification
    // for an action the user just took reads as either dismissive or
    // chatty. Stale + all-completed clears DO benefit: the snapshot
    // simply vanishing on its own otherwise looks indistinguishable
    // from a bug, especially on a long session.
    //
    // Fire AFTER the empty `session_snapshot` so a client renderer that
    // pivots off the toast (e.g. "Cleared 6 completed todos") has the
    // empty state already in hand — no jank where the snapshot is still
    // populated when the toast claims to have cleared it.
    if (reason !== "manual" && prevCount > 0) {
      this.broadcast({
        type: "todos_auto_cleared",
        reason,
        count: prevCount,
      });
    }
    if (sessLoadDebug()) {

      console.log("[sess-load] clearTodos", { id: this.id, reason, prevCount });
    }
  }

  /**
   * Apply persisted `manualTodoOverrides` to `latestTodosSnapshot` in
   * place. Pure transform — no broadcast, no persist (the overrides are
   * already in `this.manualTodoOverrides` and on disk via the prior
   * `updateTodoItem` calls that wrote them). Called from `start()` AFTER
   * disk replay finishes and the staleness auto-clear has had its say.
   *
   * Semantics:
   *   - `"deleted"` → drop the item from the snapshot entirely.
   *   - `"completed"` / `"pending"` / `"in_progress"` → replace the
   *     status field, leave the rest of the entry alone.
   *   - Override for an id that doesn't appear in the snapshot → no-op
   *     (the model already pruned it; the override is moot but harmless
   *     to keep around in case the model re-emits the same id later).
   *
   * Idempotent on an empty / null snapshot: nothing to apply to, returns
   * without touching state. Returns the number of overrides actually
   * applied so callers/tests can assert observable effect without
   * re-reading the snapshot.
   */
  private applyManualTodoOverrides(): number {
    if (!this.latestTodosSnapshot || this.latestTodosSnapshot.length === 0) return 0;
    if (Object.keys(this.manualTodoOverrides).length === 0) return 0;
    let applied = 0;
    let next = this.latestTodosSnapshot;
    for (const [id, action] of Object.entries(this.manualTodoOverrides)) {
      if (action === "deleted") {
        const before = next.length;
        next = next.filter((t) => (t as Record<string, unknown>).id !== id);
        if (next.length !== before) applied += 1;
        continue;
      }
      let didApply = false;
      next = next.map((t) => {
        const entry = t as Record<string, unknown>;
        if (entry.id !== id) return t;
        didApply = true;
        return { ...entry, status: action };
      });
      if (didApply) applied += 1;
    }
    this.latestTodosSnapshot = next;
    return applied;
  }

  /**
   * User-driven per-item mutation — the "I'll mark this myself, I don't
   * need the model to acknowledge it" lever. Invoked from the chat-level
   * `TodosBanner` (clickable icon / × button) and the rail's To-dos
   * widget. Distinct from `clearTodos` (full wipe) and from anything the
   * model itself emits (TodoWrite / TaskUpdate).
   *
   * Mutation semantics:
   *   - `"complete"` → flip `status` to `"completed"` on the matching item.
   *   - `"reopen"` → flip `status` to `"pending"` (un-complete or re-open
   *     a model-completed item the user disagrees with).
   *   - `"in_progress"` → flip `status` to `"in_progress"` (rare; offered
   *     for symmetry with the model's own status set).
   *   - `"delete"` → filter the matching item out of the snapshot.
   *
   * Override persistence rides on `mergeSessionState({manualTodoOverrides})`:
   * a server restart that rebuilds from disk JSONL replays the model's
   * pre-override transcript through `captureSnapshotState`, and the
   * persisted overrides are then re-applied on top via
   * `applyManualTodoOverrides` from `start()`. Clear-on-touch is wired in
   * `captureSnapshotState`'s TodoWrite / TaskCreate / TaskUpdate branches:
   * once the model engages with the id, the override is dropped so the
   * model's fresh assertion wins.
   *
   * Cutoff: bumps `latestTodosSnapshotAt = at` so a concurrent late
   * `TodoWrite` / `TaskCreate` tool_use observed but not yet processed by
   * `broadcast()` lands AFTER the cutoff — protects the user's click from
   * being overwritten by a stale snapshot replacement in the same turn.
   * Same shape as `clearTodos`.
   *
   * Returns `{ok: false, error}` for diagnosable failure modes:
   *   - No snapshot (after a wholesale Clear): nothing to mutate.
   *   - Item id not present in snapshot: stale UI, no-op.
   *
   * On success, mutates in-memory state, persists the override, and
   * broadcasts the updated snapshot so every connected tab repaints.
   */
  async updateTodoItem(
    itemId: string,
    action: "complete" | "reopen" | "in_progress" | "delete",
  ): Promise<{ ok: true } | { ok: false; error: string }> {
    if (!itemId || typeof itemId !== "string") {
      return { ok: false, error: "invalid item id" };
    }
    if (!this.latestTodosSnapshot || this.latestTodosSnapshot.length === 0) {
      return { ok: false, error: "no active todo list" };
    }
    const exists = this.latestTodosSnapshot.some(
      (t) => (t as Record<string, unknown>).id === itemId,
    );
    if (!exists) {
      return { ok: false, error: "item not found" };
    }
    const at = Date.now();
    const overrideStatus: "completed" | "pending" | "in_progress" | "deleted" =
      action === "complete"
        ? "completed"
        : action === "reopen"
        ? "pending"
        : action === "in_progress"
        ? "in_progress"
        : "deleted";
    // Mutate in-memory snapshot synchronously so a racing `captureSnapshotState`
    // sees the new state on its next read. Set the cutoff to `at` so any
    // pre-update TodoWrite/TaskCreate replays that arrive after this point
    // can't undo the change. We DON'T null the snapshot the way
    // `clearTodos` does — this is a targeted item edit, not a wipe.
    if (overrideStatus === "deleted") {
      this.latestTodosSnapshot = this.latestTodosSnapshot.filter(
        (t) => (t as Record<string, unknown>).id !== itemId,
      );
    } else {
      this.latestTodosSnapshot = this.latestTodosSnapshot.map((t) => {
        const entry = t as Record<string, unknown>;
        if (entry.id !== itemId) return t;
        return { ...entry, status: overrideStatus };
      });
    }
    this.latestTodosSnapshotAt = at;
    this.manualTodoOverrides = { ...this.manualTodoOverrides, [itemId]: overrideStatus };
    try {
      await mergeSessionState(this.cwd, this.id, {
        manualTodoOverrides: this.manualTodoOverrides,
      });
    } catch {
      // best-effort: a missed persist would let a future server restart
      // re-show the un-overridden state; the live broadcast below still
      // updates every connected tab immediately.
    }
    this.broadcast({
      type: "session_snapshot",
      todos: this.latestTodosSnapshot ?? [],
    });
    return { ok: true };
  }

  /**
   * Drop a single manual override from the LIVE in-memory set, and persist
   * the change. Called from `captureSnapshotState` whenever the model
   * touches an id that has an active override — the model is asserting a
   * fresh fact about that id, so the user's stale override should not
   * survive into the next replay.
   *
   * Skipped entirely while `isReplayingTranscript` is true. By invariant,
   * anything in the persisted override map represents user clicks that
   * the live model NEVER ENGAGED WITH (live `clearManualTodoOverrideFor`
   * already wiped the override on the first model touch, and the wipe
   * was persisted). Replayed historical events therefore predate every
   * surviving override, and a replay-time clear would defeat exactly the
   * cross-restart durability the override map exists to provide.
   *
   * Fire-and-forget on the persist side: a missed write just means the
   * override re-appears on next restart and we'll clear it again on the
   * next live model touch. No correctness gap, just an extra cycle.
   */
  private clearManualTodoOverrideFor(itemId: string): void {
    if (this.isReplayingTranscript) return;
    if (!(itemId in this.manualTodoOverrides)) return;
    const next = { ...this.manualTodoOverrides };
    delete next[itemId];
    this.manualTodoOverrides = next;
    void mergeSessionState(this.cwd, this.id, {
      manualTodoOverrides: this.manualTodoOverrides,
    }).catch(() => {});
  }

  /**
   * Turn-end to-do sync — invoked from the `consume()` `result` handler
   * on `subtype: "success"`. Two honest paths (see the call site for the
   * destructiveness rationale):
   *
   *   - ALL-COMPLETED: every snapshot item has `status === "completed"`.
   *     The model itself produced the "completed" status; the list has
   *     no live work left to surface. Clear via `clearTodos("completed")`
   *     so the banner and rail repaint empty without the user reaching
   *     for the Clear button. Note: `[].every(...)` is true on the empty
   *     array, so the explicit length>0 gate matters.
   *
   *   - PER-TURN AWARENESS: any open snapshot (at least one item with a
   *     non-completed status) → queue a one-shot `todos-current` reminder
   *     for the user's NEXT turn that dumps the live list as context.
   *     Fires every turn (no cadence), drops the prior "ignore if not
   *     applicable" softener, and the `todosTouchedThisTurn` flag is
   *     deliberately NOT consulted — keeping the list resident every turn
   *     matches Claude Code's CLI behavior and avoids the "model touched
   *     once 4 turns ago, list now stale" failure mode the old cadence
   *     left open. A turn that DID touch the list still gets the next-turn
   *     reminder; the body shows the new state and is no-op for the model.
   *
   * Best-effort: a `clearTodos` reject is swallowed so a transient DB
   * write failure doesn't crash the iterator's result handler.
   */
  private async maybeAutoSyncTodosOnTurnEnd(): Promise<void> {
    const snapshot = this.latestTodosSnapshot;
    const rebuiltFromTaskList = this.todosRebuiltFromTaskListThisTurn;
    // Rearm at the END of every turn so a disk-replay path that left the
    // flag set to `true` (from historical TodoWrites) can't bleed into the
    // FIRST live turn's decisions downstream. The `sendInput` reset stays
    // as belt-and-suspenders for the sane path.
    this.todosTouchedThisTurn = false;
    this.todosRebuiltFromTaskListThisTurn = false;
    // No snapshot or empty list → nothing to keep the model aware of.
    if (!snapshot || snapshot.length === 0) return;
    const allCompleted = snapshot.every(
      (t) => (t as { status?: unknown }).status === "completed",
    );
    if (allCompleted) {
      // Suppress the all-completed auto-clear for one turn if the
      // snapshot was just rebuilt by a TaskList read. Pattern: the user
      // asked "what tasks do I have?" or "mark them done" on a previously-
      // cleared rail — the TaskList result repopulates the snapshot mid-
      // turn (see captureSnapshotState), but without this guard the
      // turn-end auto-clear immediately wipes it again, so the user sees
      // the same (0) rail they were complaining about. Skipping for one
      // turn lets the user actually SEE the rebuilt list; on a subsequent
      // turn that finishes all-done WITHOUT another TaskList read, this
      // path re-arms and clears normally — the user's stated preference
      // ("keep clearTodos auto-firing on stop-reason completed + all-done")
      // is preserved everywhere except the explicit "show me" moment.
      if (rebuiltFromTaskList) return;
      await this.clearTodos("completed").catch(() => {});
      return;
    }
    // Open items remain — queue the awareness reminder for next turn. We
    // pass the full snapshot (including any completed items) so the model
    // sees the actual state — strikethroughs and all — not a filtered view
    // that would let it forget items it already finished.
    const body = todosCurrentReminderBody(snapshot);
    queueReminder(this, "todos-current", body);
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

  /**
   * Persist the picked model to `~/.claude/settings.json` so it becomes the
   * default for any new session the user spawns afterwards — matching the
   * Claude Code TUI's `/model` behavior, where the pick sticks across
   * restarts.
   *
   * Precedence at session-create time stays:
   *   request.body.model > workspace.defaults.model > ~/.claude/settings.json
   * so workspace overrides still win. Empty / undefined removes the user
   * override (clicking "Inherit machine default" in the picker → fall back
   * to whatever the SDK CLI picks).
   *
   * Best-effort — never blocks the in-session model change on a settings
   * write failure (broken JSON, EPERM, etc). Matches the advisor write at
   * the end of `setModel` below.
   */
  private async persistModelToUserSettings(model: string | undefined): Promise<void> {
    try {
      const current = await readSettings("user", this.cwd);
      // No-op if the file already matches — avoids touching mtime and
      // triggering external watchers (Claude Code TUI, MDM tooling).
      const desired = model || undefined;
      if (current.model === desired) return;
      const next: ClaudeSettings = { ...current };
      if (desired) {
        next.model = desired;
      } else {
        delete next.model;
      }
      await writeSettings("user", this.cwd, next);
    } catch (err) {
      console.error("[session.persistModelToUserSettings] write failed", err);
    }
  }

  async setModel(
    model?: string,
    source: "picker" | "chat_command" = "picker",
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
    // Sticky model — write to ~/.claude/settings.json so the next NEW
    // session in any workspace inherits this pick. Mirrors Claude Code's
    // `/model` persistence (see `persistModelToUserSettings` doc).
    await this.persistModelToUserSettings(model);
    this.broadcast({ type: "model_changed", model, source });

    // Auto-disable the advisor when the model changes. The advisor tool
    // carries a `model` field in the API request; not all model combinations
    // are compatible (e.g. claude-fable-* rejects Opus as an advisor and
    // returns a 400). Rather than letting the next turn fail with an opaque
    // API error, we proactively clear the advisor here — both the flag-settings
    // layer (so the current request is clean) and settings.json (because
    // `applyFlagSettings({ advisorModel: null })` falls back to the file when
    // null, so the file must also be cleared for the disable to be effective).
    //
    // We broadcast `advisor_disabled_on_model_change` with the previous value
    // so the client can show a dismissible toast with a one-click "Re-enable"
    // button — the user can restore it immediately if the new model is
    // actually compatible.
    if (this.advisorModel) {
      const previousAdvisor = this.advisorModel;
      try {
        const current = await readSettings("user", this.cwd);
        if (current.advisorModel) {
          const next: ClaudeSettings = { ...current };
          delete next.advisorModel;
          await writeSettings("user", this.cwd, next);
        }
      } catch (err) {
        // Non-fatal: the flag-settings clear below still applies for this
        // session's remaining turns. The file write is best-effort.
        console.error("[session.setModel] advisor settings write failed", err);
      }
      await this.setAdvisorModel(null);
      this.broadcast({
        type: "advisor_disabled_on_model_change",
        previousAdvisor,
        newModel: model,
      });
    }

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
   * Set the advisor model for subsequent turns.
   *
   * The "advisor" is the SDK's server-side escalation model: when the main
   * model needs stronger judgment (a complex decision, an ambiguous failure,
   * a problem it's circling without progress) it pings the advisor for a
   * second opinion and resumes. The SDK persists the choice as
   * `Settings.advisorModel` (a free-form model id string); we set it via
   * `applyFlagSettings`, matching `setEffort` / `setUltracode` / `setFast`.
   *
   * Passing `null` clears the override at the flag-settings layer (the SDK
   * documents `null` as "clear" for `applyFlagSettings` keys; `undefined`
   * would be dropped by JSON serialization and have no effect). When
   * cleared, the SDK falls back to any persisted `advisorModel` in the
   * user's settings.json (the same value forwarded once at session start
   * via the inline `settings` option above).
   *
   * Session-scoped with no DB persistence (same as effort/ultracode/fast).
   * After a reap → resume, the advisor falls back to whatever
   * settings.json says — that's the desired behavior: the
   * SessionCard picker is the "just for this conversation" override, and
   * the global Settings page is the durable default.
   */
  async setAdvisorModel(model: string | null): Promise<void> {
    if (!this.query) return;
    await this.query.applyFlagSettings({ advisorModel: model }).catch(() => {});
    // Mirror the new value so the GET endpoint and any future broadcast
    // reflect it. `null` clears the flag-layer override — the effective
    // advisor then falls back to whatever's in settings.json. We DON'T
    // re-read settings.json here, so `undefined` is honest for "no
    // per-session override" rather than implying we know the fallback.
    this.advisorModel = model ?? undefined;
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
   * Switch the main-thread agent for subsequent turns (SDK 0.3.161+).
   *
   * `applyFlagSettings({ agent })` now live-applies agent changes: the new
   * agent's system prompt, tool restrictions, and model take effect on the
   * next turn without restarting the session. Passing `null` resets to the
   * default general-purpose agent.
   *
   * Unlike `effort`/`ultracode`/`fastMode`, the agent name IS persisted
   * to `this.agent` so the recovery snapshot carries the switch forward on
   * reap → resume — matching the behaviour of `model`. The change is
   * broadcast as an `agent_changed` event so all connected tabs update the
   * StatusLine badge optimistically (no dedicated SDK change event exists).
   *
   * The named agent must be available in the session (a `.claude/agents`
   * file or plugin-injected agent); the SDK silently no-ops on unknown
   * names, so we trust it to validate rather than re-implementing that check.
   */
  async setAgent(name: string | null): Promise<void> {
    if (!this.query) return;
    // The Settings type accepts `null` to clear a field at the flag layer.
    await this.query.applyFlagSettings({ agent: name as string | null }).catch(() => {});
    this.agent = name ?? undefined;
    this.broadcast({ type: "agent_changed", agent: name });
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
   * Generate and broadcast a session recap — the one-line "where were we?"
   * summary triggered when the user returns to a tab after stepping away (or
   * clicks a manual recap action). Mirrors the Claude Code TUI's
   * away-summary feature.
   *
   * Always resolves; failures broadcast a `session_recap_error` with a reason
   * rather than throwing, so the API route is fire-and-forget. The recap
   * lands as a `session_recap` event for every SSE subscriber.
   *
   * Skip paths mirror the TUI's `[awaySummary] skipped: …` debug log:
   *   - `disabled`     — settings.json's `sessionRecapEnabled === false`
   *   - `running`      — a turn / permission / subagent is in flight
   *   - `no_history`   — buffer has no text turns yet (fresh session)
   *   - `rate_limited` — another tab fired within `RECAP_DEDUPE_WINDOW_MS`
   *   - `failed`       — the off-band query errored or returned empty text
   *
   * The `draft` skip (composer has unsent text) is handled CLIENT-side: the
   * server has no good way to know which tab is the "active" composer and we
   * don't want to gate manual `/recap` invocations on draft state.
   */
  async requestRecap(origin: "away" | "manual" = "away"): Promise<void> {
    // Cheap gates first — avoid a settings read on a no-op.
    if (this.getStatus() === "running") {
      this.broadcast({ type: "session_recap_error", reason: "running" });
      return;
    }
    const now = Date.now();
    if (
      this.lastRecapAt !== null &&
      now - this.lastRecapAt < RECAP_DEDUPE_WINDOW_MS
    ) {
      this.broadcast({ type: "session_recap_error", reason: "rate_limited" });
      return;
    }
    // Settings gate. `sessionRecapEnabled === false` disables; absent/true
    // keeps it on. Best-effort: a missing/corrupt file falls through to
    // "enabled" rather than blocking a manual user request.
    const settings = await readSettings("user", this.cwd).catch(
      () => ({}) as ClaudeSettings,
    );
    if (settings.sessionRecapEnabled === false) {
      this.broadcast({ type: "session_recap_error", reason: "disabled" });
      return;
    }
    // Build the transcript tail from our in-memory buffer rather than
    // resuming the SDK session (which would re-feed the full conversation as
    // input and cost real tokens). See `session-recap.ts` for the rationale.
    const { text: tail, turnCount } = extractTranscriptTail(this.buffer);
    if (turnCount === 0 || !tail.trim()) {
      this.broadcast({ type: "session_recap_error", reason: "no_history" });
      return;
    }
    // Claim the dedupe slot BEFORE awaiting — so concurrent POSTs from other
    // tabs that race past the early gate see a populated `lastRecapAt` and
    // bail out with `rate_limited` rather than each spawning their own
    // query. The dedupe is a START-time guard, not an END-time guard.
    this.lastRecapAt = now;
    // New AbortController per request. A subsequent sendInput cancels this
    // one — a recap against a moving conversation would lie.
    if (this.recapAbort) this.recapAbort.abort();
    this.recapAbort = new AbortController();
    const signal = this.recapAbort.signal;
    const result = await generateRecap({
      cwd: this.cwd,
      transcriptTail: tail,
      // Inherit the session's model so the recap voice matches the
      // surrounding chat. If the session has no explicit model, omit it and
      // let the SDK pick the default — cheaper than hardcoding a fallback id
      // here that could drift out of sync with the SDK's model catalog.
      ...(this.model ? { model: this.model } : {}),
      // Forward the frozen account-switcher env so the recap runs under the
      // same credential as the parent session — never the global ambient
      // pointer (which may have rotated mid-conversation).
      ...(this.envOverride ? { env: this.envOverride } : {}),
      signal,
    });
    // If the abort fired between the await and the dispatch, swallow — a
    // newer turn or recap is already in flight and broadcasting now would
    // race the new state.
    if (signal.aborted) return;
    if (result.ok) {
      this.broadcast({
        type: "session_recap",
        text: result.text,
        at: Date.now(),
        origin,
      });
    } else if (result.reason === "aborted") {
      // Cancelled by a newer turn — silent (no event). The next user-visible
      // moment is the assistant turn itself.
    } else {
      this.broadcast({
        type: "session_recap_error",
        reason: "failed",
        ...(result.reason === "empty_response"
          ? { message: "empty response" }
          : { message: result.message }),
      });
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
   * Fire the one-shot authentication-failed nudge when an SDK
   * `authentication_failed` signal (structured or synthetic-text) is
   * observed. Unlike the long-context-credits nudge this is NOT gated on
   * any session-specific config — a 401 is universal regardless of which
   * model / beta the user picked, and the only fix is swapping the
   * credential. Gated only on fire-once-per-session so a repeat 401 in the
   * same session doesn't re-pop a dismissed banner.
   */
  private noteAuthFailedObservation(isAuthFailed: boolean): void {
    if (!isAuthFailed) return;
    if (this.authFailedNudgeFired) return;
    this.authFailedNudgeFired = true;
    this.broadcast({
      type: "auth_failed_required",
      model: this.model ?? "",
    });
  }

  /**
   * Account-switcher: on the first rate-limit-hit message of this
   * session, rotate the global active profile to the next configured
   * one (round-robin) when the user enabled auto-rotate. Fire-once per
   * session — replayed-from-disk messages would otherwise rotate
   * through every account every time the user reloads the tab.
   *
   * Detection mirrors `RATE_LIMIT_HIT_TEXT_RE` in
   * `lib/client/use-session.ts` so the server fires on exactly the
   * same messages the client renders as a rate-limit wall. We don't
   * try to swap the auth on the LIVE session — env is read at
   * `query()` construction, and a rate-limited session can't
   * usefully continue anyway. The rotation just teaches the NEXT
   * session to spawn under a different credential.
   */
  private async noteAccountAutoRotateObservation(message: unknown): Promise<void> {
    if (this.accountAutoRotated) return;
    if (!isRateLimitHitSdkMessage(message)) return;
    // Best-effort: a corrupt accounts.json shouldn't crash the
    // consume loop. Failing here just means no rotation this session.
    try {
      const cur = await readAccountsRaw();
      if (!cur.autoRotateOnRateLimit) return;
      if (cur.profiles.length < 2) return;
      const rotated = await rotateToNextProfile();
      if (!rotated) return;
      this.accountAutoRotated = true;
      this.broadcast({
        type: "account_auto_rotated",
        fromLabel: rotated.from.label,
        toLabel: rotated.to.label,
      });
    } catch {
      // Silently swallow — auto-rotate is a convenience layer, not a
      // correctness requirement; surfacing a generic "rotate failed"
      // would only confuse the user on top of the rate-limit wall.
    }
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
    // `!` bash-mode: kill the persistent shell + group so a long-running
    // background command can't outlive the session. The map entry is
    // keyed by sessionId in `bash-mode.ts`; drop is a no-op when the
    // session never used bash mode.
    dropBashSession(this.id);
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
    // Also clear the matching inbox rows for every drained entry. Without
    // this, draining (session end / reaper / abort cascade safety-net) leaves
    // the actionable notification rows unread forever — the user sees a
    // stale per-tab badge for a request the agent can no longer answer.
    // Mirror the resolve* paths (submitAskAnswer, resolvePermission,
    // resolvePlan), which all fire markReadByRequestId on the normal path.
    for (const [id, p] of this.pendingPermissions) {
      this.pendingPermissions.delete(id);
      void notificationBus.markReadByRequestId(this.cwd, id);
      try {
        p.resolve(denyResult);
      } catch {
        // resolver already settled — fine, we just needed the map slot freed
      }
    }
    for (const [id, p] of this.pendingAskQuestions) {
      this.pendingAskQuestions.delete(id);
      void notificationBus.markReadByRequestId(this.cwd, id);
      try {
        p.resolve(denyResult);
      } catch {
        // ignore
      }
    }
    for (const [id, p] of this.pendingPlans) {
      this.pendingPlans.delete(id);
      void notificationBus.markReadByRequestId(this.cwd, id);
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

  subscribe(fn: Subscriber, opts?: { tail?: number; tabId?: string }): () => void {
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
        ev.type === "long_context_credits_required" ||
        // One-shot authentication-failed nudge — same shape: once the user
        // has fixed (or dismissed) the bad credential, replaying on reload
        // would re-pop a stale banner. Live subscribers see the original
        // broadcast at the moment the 401 lands.
        ev.type === "auth_failed_required" ||
        // Session recap is by definition "where were we" — replaying a stale
        // one on tab switch or reload would contradict the live state. Live
        // subscribers see the one true broadcast; reloaders just wait until
        // the next blur/return cycle fires fresh.
        ev.type === "session_recap" ||
        ev.type === "session_recap_error"
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
    //
    // The `todos` field is the AUTHORITATIVE post-replay state — emit it
    // whenever any todos activity has been observed in this session
    // (`latestTodosSnapshotAt` is finite), not only when the snapshot is
    // truthy. After a clear the snapshot is null, but the client has been
    // rebuilding its own `latestTodos` from each replayed `TodoWrite` /
    // `TaskCreate` tool_use that arrived in the SSE stream — the cutoff
    // guards bounce those server-side but can't pull them off the wire.
    // Painting an explicit `[]` here overrides the client's rebuilt list,
    // closing the cross-restart durability gap the cutoff alone leaves
    // open. For a session that's never seen a TodoWrite, this stays a
    // no-op (the field isn't emitted at all).
    const hasTodosActivity = Number.isFinite(this.latestTodosSnapshotAt);
    if (hasTodosActivity || this.latestUserPromptSnapshot) {
      fn({
        type: "session_snapshot",
        ...(hasTodosActivity ? { todos: this.latestTodosSnapshot ?? [] } : {}),
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
    // Holder tracking: first tab to subscribe with a tabId claims the write
    // lock. All current subscribers (including this one) are notified; later
    // tabs that join while a holder is active just receive the current holderId
    // so they can render read-only without a full broadcast.
    const tabId = opts?.tabId ?? null;
    if (tabId) {
      if (this.holderId === null) {
        this.holderId = tabId;
        // Notify everyone (including this new subscriber already in the Set).
        this.announceHolder();
      } else {
        // Tell only the new subscriber who currently holds the lock.
        try {
          fn({ type: "holder_changed", holderId: this.holderId });
        } catch {
          // ignore
        }
      }
    }
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
    // Re-emit the current queue snapshot fresh on every subscribe.
    // `queue:updated` is excluded from the replay buffer (it's a snapshot,
    // not an event log — broadcasting full snapshots on every reorder/edit
    // into a 1000-event buffer that trims FIFO would silently evict real
    // history) so a late-joining tab needs this echo to paint the
    // QueueIndicator strip with the right contents.
    void this.sendQueueSnapshot(fn);
    return () => {
      this.subscribers.delete(fn);
      // Release the holder slot when the holder's SSE stream disconnects so
      // the next tab to subscribe can claim it.
      if (tabId && tabId === this.holderId) {
        this.holderId = null;
        this.announceHolder();
      }
      this.notifySubscriberCount();
    };
  }

  /**
   * Iterate all live subscribers and push the current `holder_changed` state.
   * Called directly (not via `broadcast`) so the event is never buffered —
   * holder state is always re-echoed fresh in `subscribe()`.
   */
  private announceHolder(): void {
    const ev: { type: "holder_changed"; holderId: string | null } = {
      type: "holder_changed",
      holderId: this.holderId,
    };
    for (const sub of this.subscribers) {
      try {
        sub(ev);
      } catch {
        // ignore subscriber errors
      }
    }
  }

  /**
   * Force-reassign the write-lock holder. Called by the
   * `PATCH /api/sessions/[id]/holder` take-over endpoint. Any connected client
   * whose tabId no longer matches will receive the event and render read-only;
   * the caller's tab becomes the new holder.
   */
  public claimHolder(tabId: string): void {
    this.holderId = tabId;
    this.announceHolder();
  }

  private async sendQueueSnapshot(fn: Subscriber): Promise<void> {
    try {
      await this.loadQueueIfNeeded();
      if (this.queueCache.length === 0) return;
      fn({
        type: "queue:updated",
        sessionId: this.id,
        queue: this.queueSnapshot(),
      });
    } catch {
      // best-effort: an empty snapshot just means the strip stays hidden
      // until the next mutation broadcast.
    }
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

  // ────────────────────────── server-side message queue ──────────────────────
  //
  // Lifecycle: messages typed while the agent is mid-turn (or while an
  // interactive prompt is open) are appended to this queue. The Session drains
  // exactly one item per "idle transition" — the `result` handler on
  // `subtype === "success"`, every successful permission/ask/plan answer, and
  // once on session boot after `start()` completes. That makes delivery
  // independent of any browser being open or focused: even a tab that was
  // closed mid-session has its queued messages run eventually.
  //
  // The previous client-side queue (sessionStorage + `flushQueue()` in
  // `use-session.ts`) was gated on a live, focused tab — backgrounded tabs
  // are throttled by the browser, so the React effect that fired the drain
  // never ran and messages sat indefinitely until refocus.
  //
  // The cache (queueCache) is an in-memory mirror of `queued_messages` for
  // fast "is the queue empty?" reads. Every mutation re-syncs the cache from
  // the DB so the broadcast snapshot is authoritative.

  private toQueueMeta(row: QueuedMessageRow): QueuedMessageMeta {
    return {
      uuid: row.uuid,
      text: row.text,
      ...(row.slash ? { slash: true } : {}),
      ...(row.fromSuggestion ? { fromSuggestion: true } : {}),
      ...(row.fromGoal ? { fromGoal: true } : {}),
      ...(row.images && row.images.length > 0 ? { hasImages: true } : {}),
      createdAtMs: row.createdAtMs,
    };
  }

  private queueSnapshot(): QueuedMessageMeta[] {
    return this.queueCache.map((r) => this.toQueueMeta(r));
  }

  private broadcastQueue(): void {
    this.broadcast({
      type: "queue:updated",
      sessionId: this.id,
      queue: this.queueSnapshot(),
    });
  }

  private async loadQueueIfNeeded(): Promise<void> {
    if (this.queueLoaded) return;
    this.queueCache = await listQueue(this.cwd, this.id).catch(() => []);
    this.queueLoaded = true;
  }

  private async refreshQueueCache(): Promise<void> {
    this.queueCache = await listQueue(this.cwd, this.id).catch(
      () => this.queueCache,
    );
    this.queueLoaded = true;
  }

  /**
   * Append a message to the tail of this session's queue. Used by `/api/sessions/[id]/input`
   * when the session is busy (or when the client explicitly opted into
   * `forceQueue`). Returns the uuid the message will carry through the
   * eventual `sendInput()` — either the caller-supplied uuid or a server-minted
   * one. Provenance bookkeeping (suggested/goal) is the route's job, keyed by
   * this same uuid, so it stays consistent whether the message ran immediately
   * or got drained later.
   */
  async enqueueMessage(input: {
    text: string;
    images?: Array<{ data: string; mediaType: string; ordinal?: number }>;
    uuid?: string;
    slash?: boolean;
    fromSuggestion?: boolean;
    fromGoal?: boolean;
  }): Promise<string> {
    await this.loadQueueIfNeeded();
    const uuid = input.uuid ?? randomUUID();
    const row = await enqueueTail(this.cwd, {
      sessionId: this.id,
      uuid,
      text: input.text ?? "",
      images: input.images,
      slash: input.slash,
      fromSuggestion: input.fromSuggestion,
      fromGoal: input.fromGoal,
    });
    this.queueCache.push(row);
    this.broadcastQueue();
    return uuid;
  }

  async removeQueued(uuid: string): Promise<boolean> {
    await this.loadQueueIfNeeded();
    const ok = await removeQueuedByUuid(this.cwd, this.id, uuid);
    if (ok) {
      this.queueCache = this.queueCache.filter((r) => r.uuid !== uuid);
      this.broadcastQueue();
    }
    return ok;
  }

  async editQueuedMessage(
    uuid: string,
    patch: {
      text?: string;
      images?: Array<{ data: string; mediaType: string; ordinal?: number }> | null;
    },
  ): Promise<boolean> {
    await this.loadQueueIfNeeded();
    const ok = await updateQueuedByUuid(this.cwd, this.id, uuid, patch);
    if (ok) {
      await this.refreshQueueCache();
      this.broadcastQueue();
    }
    return ok;
  }

  /**
   * Per-message "Send now" override: atomically pop a specific queued
   * message and push it into the SDK input pipe via `sendInput()`. The
   * SDK runs it as the very next turn (or right now, if the agent is
   * already idle). Idempotent — a second call with the same uuid is a
   * no-op because `popQueuedByUuid` returned null.
   *
   * Same semantics as the global "asap" mode for one specific item,
   * which is why the QueueIndicator button labels it "Send now" rather
   * than "Dispatch ahead of queue" — the user mental model is
   * "skip the queue for this message".
   *
   * NB: this jumps the FIFO order. If the user has three queued
   * messages [A, B, C] and clicks "Send now" on B, then B runs next
   * (after the current turn), then A drains via `flushQueueIfIdle`,
   * then C. That ordering is intentional — the explicit override is
   * the user saying "this one is more urgent than the staged ones".
   */
  async sendQueuedNow(uuid: string): Promise<boolean> {
    await this.loadQueueIfNeeded();
    const row = await popQueuedByUuid(this.cwd, this.id, uuid);
    if (!row) return false;
    this.queueCache = this.queueCache.filter((r) => r.uuid !== row.uuid);
    this.broadcastQueue();
    // Provenance was persisted at enqueue time by the /input route — keyed
    // by this same uuid, which we reuse — so the badge re-renders on the
    // bubble when sendInput's broadcast echo lands.
    this.sendInput(
      row.text,
      row.images ?? undefined,
      {
        uuid: row.uuid,
        ...(row.slash ? { slash: true } : {}),
      },
    );
    return true;
  }

  async moveQueuedMessage(uuid: string, direction: "up" | "down"): Promise<boolean> {
    await this.loadQueueIfNeeded();
    const ok = await moveQueuedByUuid(this.cwd, this.id, uuid, direction);
    if (ok) {
      await this.refreshQueueCache();
      this.broadcastQueue();
    }
    return ok;
  }

  /** Sync queue-length check used by the input route to decide queue-vs-send. */
  async queueLength(): Promise<number> {
    await this.loadQueueIfNeeded();
    return this.queueCache.length;
  }

  /** Public read for the SSE attach echo (and any future debug surface). */
  async getQueueSnapshot(): Promise<QueuedMessageMeta[]> {
    await this.loadQueueIfNeeded();
    return this.queueSnapshot();
  }

  /**
   * Pop the head of the queue and dispatch it via `sendInput()`, but only when
   * the session is currently idle (no in-flight turn, no pending decisions, no
   * live subagents). Single source of truth for "drain a queued message" —
   * called from:
   *
   *   - the `result` handler in `consume()` on `subtype === "success"` only.
   *     Interrupts (subtype !== "success") deliberately do NOT auto-drain, so
   *     hitting Stop mid-turn doesn't immediately fire the next queued item.
   *   - every successful `resolvePermission` / `submitAskAnswer` / `resolvePlan`.
   *     The idle guard short-circuits when the turn continues; only the case
   *     where the answer was the last thing actually drains.
   *   - once at the end of `start()`, after the JSONL watcher is armed. That's
   *     what gives a queue items survive a server restart: when the session
   *     loads from disk, any leftover queued message in SQLite is pushed into
   *     a fresh turn automatically.
   *
   * Guarded by `isDraining` to prevent two concurrent callers from popping
   * twice in one boundary (see the field comment).
   */
  private async flushQueueIfIdle(): Promise<void> {
    if (this.done) return;
    if (this.isDraining) return;
    if (this.getStatus() !== "idle") return;
    this.isDraining = true;
    try {
      await this.loadQueueIfNeeded();
      if (this.queueCache.length === 0) return;
      // Re-check status after any await — a fresh sendInput from the route
      // could have flipped us back to running between the guard above and
      // the popHead below.
      if (this.getStatus() !== "idle") return;
      const head = await popQueueHead(this.cwd, this.id);
      if (!head) return;
      this.queueCache = this.queueCache.filter((r) => r.uuid !== head.uuid);
      this.broadcastQueue();
      // Provenance (suggested/goal/asset) was already persisted by the input
      // route when this message was originally enqueued — keyed by the same
      // uuid we now reuse — so the badge re-renders correctly when sendInput's
      // broadcast echo lands. No bookkeeping needed here.
      this.sendInput(
        head.text,
        head.images ?? undefined,
        {
          uuid: head.uuid,
          ...(head.slash ? { slash: true } : {}),
        },
      );
    } finally {
      this.isDraining = false;
    }
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
    // `queue:updated` is a SNAPSHOT, not an event log entry — its payload is
    // the full current queue, so pushing every change into the 1000-event
    // FIFO buffer would (a) waste capacity, evicting real history, and
    // (b) replay stale snapshots on reload. Live subscribers see it directly
    // via the for-loop below; new subscribers re-render the queue from
    // `sendQueueSnapshot()` in `subscribe()`.
    // `holder_changed` is also excluded — holder state is always re-echoed
    // fresh in `subscribe()` so replaying stale ownership changes would
    // confuse late-connecting tabs. In practice `holder_changed` never goes
    // through `broadcast()` (it uses `announceHolder()` directly), but this
    // guard is here as a safety net.
    if (event.type !== "queue:updated" && event.type !== "holder_changed") {
      this.buffer.push(event);
      if (this.buffer.length > 1000) {
        this.bufferTrimmed = true;
        this.buffer.splice(0, this.buffer.length - 1000);
      }
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
   * Pending TaskList tool_use ids awaiting their tool_result. When the
   * result lands, `captureSnapshotState` parses the SDK's authoritative
   * task list out of the result text and rebuilds `latestTodosSnapshot`.
   * Self-healing path for the desync that happens after `clearTodos()`
   * (manual, "completed" auto-clear, or "stale" auto-clear) nulls the
   * snapshot while the SDK task store still has live items.
   */
  private pendingTaskLists = new Set<string>();
  /**
   * Did `captureSnapshotState` rebuild `latestTodosSnapshot` from a
   * TaskList tool_result during the current turn? Consulted by
   * `maybeAutoSyncTodosOnTurnEnd` to suppress the all-completed auto-
   * clear for one turn — without this, the user's "what tasks are left?"
   * (which is exactly the all-completed case) would trigger an immediate
   * `clearTodos("completed")` at turn end, defeating the whole point of
   * the rebuild. Rearmed false at turn end alongside `todosTouchedThisTurn`.
   */
  private todosRebuiltFromTaskListThisTurn = false;

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
    // Real user prompt → cache for the rehydration snapshot. Uses the
    // text-only `extractUserPromptText` (not the image-aware
    // `isAnchorableUserPrompt` that computeReplayWindow anchors on): this
    // snapshot caches prose for rehydration and can't carry image pixels, so
    // an image-only paste correctly doesn't update it.
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
      // TaskList  tool_result — rebuild the snapshot from the SDK's
      // authoritative list (self-heal after a `clearTodos` desync).
      const userContent = m.message?.content;
      if (Array.isArray(userContent)) {
        for (const raw of userContent as Array<{ type?: string; tool_use_id?: string; content?: unknown; is_error?: boolean }>) {
          if (raw?.type !== "tool_result") continue;
          const toolUseId = raw.tool_use_id;
          if (!toolUseId) continue;

          // TaskList result first — it's an independent self-heal path
          // and the existing TaskCreate early-exit (`if (!pending) continue;`)
          // below would otherwise skip every non-TaskCreate result before
          // we ever look at it. The two are mutually exclusive: a single
          // tool_use_id is either a TaskCreate or a TaskList, never both.
          if (this.pendingTaskLists.has(toolUseId)) {
            this.pendingTaskLists.delete(toolUseId);
            if (raw.is_error) continue;
            let listText = "";
            if (typeof raw.content === "string") {
              listText = raw.content;
            } else if (Array.isArray(raw.content)) {
              for (const c of raw.content as Array<{ type?: string; text?: string }>) {
                if (c?.type === "text" && c.text) listText += c.text;
              }
            }
            const parsed = parseTaskListResult(listText);
            if (parsed === null) continue; // unknown shape → leave snapshot
            // `at` is computed locally because the outer user-branch's
            // `at` lives inside the `if (text && m.uuid)` block above and
            // isn't in scope here.
            const tlAt =
              typeof event.at === "number" && Number.isFinite(event.at)
                ? event.at
                : Date.now();
            // Cutoff guard — same shape as the TaskCreate branch
            // (line ~5512 below). On a server restart that replays from
            // disk JSONL, `latestTodosSnapshotAt` is seeded from
            // `todosClearedAt` (line ~1426). A pre-clear TaskList replayed
            // out of the transcript would otherwise resurrect the cleared
            // list — exactly the durability bug the cutoff exists to
            // prevent. The LIVE case (post-clear TaskList: `tlAt` is
            // `Date.now()` and beats any disk cutoff) still passes, which
            // is the self-healing path we want.
            if (tlAt < this.latestTodosSnapshotAt) continue;
            // Replace the snapshot with the SDK's authoritative view.
            this.latestTodosSnapshot = parsed;
            this.latestTodosSnapshotAt = tlAt;
            // TaskList is a READ — the model isn't asserting fresh state
            // per id, just reading the SDK's. Re-apply any active manual
            // overrides on top so user-side edits still win over the
            // rebuilt view (mirrors the start-of-session apply path).
            this.applyManualTodoOverrides();
            // Mark the turn as having touched the to-do list — see the
            // TodoWrite branch below for the rationale.
            this.todosTouchedThisTurn = true;
            // Suppress the all-completed auto-clear for this turn (see
            // `maybeAutoSyncTodosOnTurnEnd` and the field declaration). The
            // user just explicitly asked "what tasks do I have?" — wiping
            // the list at turn end would defeat the whole rebuild.
            //
            // Gated on the live path only. On disk replay this branch is
            // re-running historical TaskList tool_results — `start()`'s
            // resume loop processes the whole transcript and then runs
            // the all-completed clear at line ~1622 deliberately. Setting
            // the flag here would survive into the first LIVE turn (no
            // `maybeAutoSyncTodosOnTurnEnd` runs during replay to clear
            // it), suppressing the legitimate auto-clear of a freshly
            // all-completed list — the exact bleed-across-replay hazard
            // the codebase already guards for `todosTouchedThisTurn`
            // (where it happens to be harmless because that flag isn't
            // consulted).
            if (!this.isReplayingTranscript) {
              this.todosRebuiltFromTaskListThisTurn = true;
            }
            continue;
          }

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
          // The in-process TaskCreate tool returns a PLAIN STRING — the
          // shape is `"Task #N created successfully: <subject>"` — NOT
          // JSON. The prior implementation only handled `JSON.parse` →
          // `{task: {id: "N"}}` and silently fell through to the catch,
          // leaving the temp `tool_use_id` (e.g. `toolu_01H4...`) in the
          // snapshot. Every subsequent `TaskUpdate {taskId: "N"}` then
          // mismatched (snapshot had a temp id, model used the real
          // numeric id) and got dropped — producing the user-visible
          // "6 items, none ever marked completed" bug.
          //
          // We try the plain-string regex FIRST because that's the live
          // shape; the JSON fallback handles any future SDK / tool
          // variant that decides to return structured output instead.
          let realId: string | null = null;
          const match = /Task #(\S+)\s+created/i.exec(resultText);
          if (match && match[1]) {
            realId = match[1];
          } else {
            try {
              const payload = JSON.parse(resultText) as { task?: { id?: string } };
              if (typeof payload?.task?.id === "string" && payload.task.id) {
                realId = payload.task.id;
              }
            } catch {
              // Neither regex nor JSON matched — leave temp-id entry in
              // place. The user-facing failure is the same as before
              // (TaskUpdate won't find the item), but at least the
              // snapshot still shows the item exists.
            }
          }
          if (realId && this.latestTodosSnapshot) {
            const promotedId = realId;
            this.latestTodosSnapshot = this.latestTodosSnapshot.map((t) =>
              (t as Record<string, unknown>).id === toolUseId
                ? { ...(t as Record<string, unknown>), id: promotedId }
                : t,
            );
            // If the user had an override keyed by the temp tool_use_id
            // (rare — they'd have had to click before the tool_result
            // landed), migrate it to the real id so the override survives
            // the promotion.
            if (toolUseId in this.manualTodoOverrides) {
              const status = this.manualTodoOverrides[toolUseId];
              const next = { ...this.manualTodoOverrides };
              delete next[toolUseId];
              next[promotedId] = status;
              this.manualTodoOverrides = next;
              if (!this.isReplayingTranscript) {
                void mergeSessionState(this.cwd, this.id, {
                  manualTodoOverrides: this.manualTodoOverrides,
                }).catch(() => {});
              }
            }
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
            // Clear manual overrides for any id the model just touched —
            // the model is asserting fresh state for these items, so the
            // user's prior overrides are stale. Ids absent from `raw` are
            // implicitly deleted by the model and survive as overrides
            // harmlessly (the snapshot doesn't contain them, so the
            // override is moot until the model re-emits the same id).
            for (const entry of raw as Array<Record<string, unknown>>) {
              const id = typeof entry?.id === "string" ? entry.id : null;
              if (id) this.clearManualTodoOverrideFor(id);
            }
          }
        }
        // Feature 31 parity: rearm the stale-TodoWrite counter on any
        // TodoWrite tool_use, including disk-replayed ones — a replayed
        // historical write resetting 0 → 0 is harmless, and it keeps the
        // counter aligned with what the agent has actually done.
        this.turnsSinceTodoWrite = 0;
        // Turn-end awareness nudge: bookkeeping for any future cadence-
        // dependent reminder that wants to know whether the agent
        // touched the list this turn. (The current `todos-current`
        // reminder fires every turn regardless, so this flag is no longer
        // load-bearing for it — kept for symmetry and as a hook for
        // future per-turn decisions.)
        this.todosTouchedThisTurn = true;
        continue;
      }

      // TaskCreate — add pending entry to snapshot (keyed by tool_use_id);
      // real id arrives via the matching tool_result.
      if (block.name === "TaskCreate" && typeof block.id === "string") {
        // Same cutoff the TodoWrite branch uses (~line 4226 below) — bounce
        // any pre-clear replay so a manual / staleness clear survives a
        // server restart for `TaskCreate`-built lists too (the preferred
        // task-tool path; `TodoWrite` is the legacy fallback). Without this
        // a fresh process would silently resurrect cleared items: the dedup
        // guards alone don't catch a pre-clear entry that hasn't been
        // observed yet.
        if (at < this.latestTodosSnapshotAt) continue;
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
        // Mark the turn as having touched the to-do list — see TodoWrite
        // branch above for the rationale.
        this.todosTouchedThisTurn = true;
        // Model created this item, so any pre-existing override keyed by
        // the same id is now stale (rare — the temp tool_use_id is fresh
        // per turn, but a user-typed id collision is possible).
        this.clearManualTodoOverrideFor(block.id);
        continue;
      }

      // TaskList — register the tool_use_id so the matching tool_result
      // (handled in the user-message branch above) can rebuild the
      // snapshot from the SDK's authoritative list. Self-healing path
      // after `clearTodos()` nulls the snapshot — without this, every
      // subsequent `TaskUpdate` is silently dropped by the gated branch
      // below and the rail stays at (0) forever even though the SDK store
      // still has live tasks. NOT bounced by `latestTodosSnapshotAt`:
      // a TaskList result that lands after a clear is exactly the
      // signal we want to honour (it's the SDK's source of truth, not
      // a pre-clear replay).
      if (block.name === "TaskList" && typeof block.id === "string") {
        this.pendingTaskLists.add(block.id);
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
        // Mark the turn as having touched the to-do list — see TodoWrite
        // branch above for the rationale.
        this.todosTouchedThisTurn = true;
        // The model engaged with this specific id; drop any active user
        // override so the model's fresh assertion wins on the next replay.
        this.clearManualTodoOverrideFor(taskId);
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
        // Authentication-failed nudge. Fires once per session when the SDK
        // surfaces an `authentication_failed` structured tag or a synthetic
        // "API Error: 401 / Failed to authenticate" assistant body — the
        // banner links to the accounts section so the user can swap their
        // credential without leaving the chat.
        this.noteAuthFailedObservation(isAuthFailedSignal(message));
        // Account-switcher auto-rotate. Fire-and-forget — the rotation
        // is a global-state side-effect, not blocking on the consumer
        // iterator. See `noteAccountAutoRotateObservation` for the
        // detection rules + once-per-session guard.
        void this.noteAccountAutoRotateObservation(message);
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
        const sysMsg = message as { type?: string; subtype?: string; content?: string };
        if (sysMsg.type === "system" && sysMsg.subtype === "compact_boundary") {
          void this.reseedReadPathsAfterCompact();
        }
        // Detect `/model <id>` slash-command outputs so `this.model` stays in
        // sync when the user switches via the chat command rather than the
        // picker. The SDK emits a `system/local_command_output` with content
        // "Set model to <id>" (the same text echoed to the TUI's stdout); we
        // parse the model id from it and mirror the change into our state.
        // The broadcast carries `source: "chat_command"` so the client can
        // show the "Your pick becomes the default for new sessions" notice.
        if (sysMsg.type === "system" && sysMsg.subtype === "local_command_output") {
          const localCmdContent = (message as { content?: string }).content ?? "";
          const modelMatch = /^set\s+model\s+to\s+(\S+)/i.exec(localCmdContent);
          if (modelMatch) {
            const newModel = modelMatch[1];
            if (newModel !== this.model) {
              this.model = newModel;
              this.broadcast({ type: "model_changed", model: newModel, source: "chat_command" });
              try {
                await upsertSession({ id: this.id, cwd: this.cwd, model: newModel, title: this.title });
              } catch {
                // Non-fatal: the broadcast already updated the client.
              }
              // Sticky model — same write the picker's setModel() does, so
              // `/model X` in chat also makes X the default for future new
              // sessions. The chat-command path bypasses setModel() entirely,
              // so we mirror the persistence here.
              await this.persistModelToUserSettings(newModel);
            }
          }
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
            // Fetch structured plan-level usage (subscription type + rate-limit
            // window utilization) and broadcast as a `plan_usage` event so the
            // CostOverlay can show utilization alongside cost. Fire-and-forget,
            // error-swallowed: the API is experimental and may change shape in
            // any SDK release — a failure here is always non-fatal.
            void (async () => {
              if (!this.query) return;
              let usageData: SDKControlGetUsageResponse;
              try {
                // eslint-disable-next-line @typescript-eslint/no-explicit-any
                usageData = await (this.query as any).usage_EXPERIMENTAL_MAY_CHANGE_DO_NOT_RELY_ON_THIS_API_YET();
              } catch {
                return; // experimental API unavailable or changed — ignore
              }
              const rl = usageData.rate_limits;
              const planUsageEvent: PlanUsageEvent = {
                type: "plan_usage",
                subscriptionType: usageData.subscription_type,
                rateLimitsAvailable: usageData.rate_limits_available,
                rateLimits: rl
                  ? {
                      fiveHour: rl.five_hour
                        ? { utilization: rl.five_hour.utilization, resetsAt: rl.five_hour.resets_at }
                        : rl.five_hour,
                      sevenDay: rl.seven_day
                        ? { utilization: rl.seven_day.utilization, resetsAt: rl.seven_day.resets_at }
                        : rl.seven_day,
                      sevenDayOauthApps: rl.seven_day_oauth_apps
                        ? { utilization: rl.seven_day_oauth_apps.utilization, resetsAt: rl.seven_day_oauth_apps.resets_at }
                        : rl.seven_day_oauth_apps,
                      sevenDayOpus: rl.seven_day_opus
                        ? { utilization: rl.seven_day_opus.utilization, resetsAt: rl.seven_day_opus.resets_at }
                        : rl.seven_day_opus,
                      sevenDaySonnet: rl.seven_day_sonnet
                        ? { utilization: rl.seven_day_sonnet.utilization, resetsAt: rl.seven_day_sonnet.resets_at }
                        : rl.seven_day_sonnet,
                    }
                  : null,
              };
              this.broadcast(planUsageEvent);
            })();
            // Turn-end to-do synchronization (Claudius-specific, not CLI
            // parity). Two tiers, both gated on `subtype: "success"` so an
            // errored / aborted turn — where we have no reason to believe
            // the model finished anything cleanly — never trips either:
            //
            //   1. ALL-COMPLETED auto-clear: if the snapshot has items and
            //      every one is `status === "completed"`, drop the list
            //      via `clearTodos("completed")`. Honest — only the model
            //      can produce a "completed" status, so we're not
            //      fabricating completion, just expiring a list the agent
            //      itself declared done.
            //
            //   2. PER-TURN AWARENESS: if the snapshot has open items,
            //      queue a one-shot `todos-current` reminder for the next
            //      user turn dumping the live list as context. Fires every
            //      turn (no cadence) so the model is reasoning over the
            //      live state instead of a snapshot it captured several
            //      turns ago. We deliberately don't auto-delete stale
            //      items: only the model can decide whether an unfinished
            //      todo is abandoned or paused, and a silent drop on every
            //      turn would shred long-running plans the user still
            //      expects to see (the user has manual per-item controls
            //      for that case — see `updateTodoItem`).
            //
            // The call moved to the queue-drain block below — we need its
            // promise to chain `flushQueueIfIdle` after the `todos-current`
            // reminder lands so a drained queued turn picks it up.
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
          // Drain one queued message into a fresh turn — but ONLY on
          // `subtype === "success"`. Interrupts and errored turns drop into
          // the parent `if (type === "result")` block above so `turnInFlight`
          // clears, but we deliberately don't auto-fire the next item in
          // those cases: the user (or the SDK error path) just signaled
          // stop, queueing the next message would feel like the agent
          // ignored them.
          //
          // Ordering matters: `maybeAutoSyncTodosOnTurnEnd()` above is async
          // and may queue a `todos-current` reminder for the next turn. If
          // we fire the drain before it lands, that reminder misses the
          // drained turn's `takePendingReminders()` and waits another turn.
          // The reminder-staging blocks earlier (date-change, plan-verify)
          // were already sync, so they're safe; the todos one needs the
          // chained-then below.
          if ((message as { subtype?: string }).subtype === "success") {
            const todosSettled = this.maybeAutoSyncTodosOnTurnEnd().catch(
              () => {},
            );
            void todosSettled.then(() =>
              this.flushQueueIfIdle().catch(() => {
                // drain failures are non-fatal; the next idle transition
                // will retry.
              }),
            );
          }
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
        // A thrown 401 can also land in this catch when the SDK aborts the
        // iterator on a hard auth failure (no synthetic assistant message
        // emitted). Feed the thrown message through the same auth detector
        // so the nudge still fires on this path. Mirrors the overload
        // catch-block hook one line above.
        this.noteAuthFailedObservation(isAuthFailedErrorText(message));
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
