/**
 * Shared `<system-reminder>` injection channel — two channels by timing:
 *
 *   1. Next-turn (`queueReminder` / `takePendingReminders`): drops a one-shot
 *      reminder onto the agent's NEXT user turn. `Session` drains alongside
 *      its existing `takeGoalReminder()` call at the inputQueue site. Use
 *      for cross-turn nudges (date rollover, stale TodoWrite, plan re-entry,
 *      auto-mode exit, memory staleness).
 *
 *   2. Mid-turn (`queueMidTurnReminder` / `takeMidTurnReminders`): fires
 *      BEFORE the next tool call within the same turn, via the SDK's
 *      PreToolUse hook returning `additionalContext` on its
 *      `PreToolUseHookSpecificOutput`. The SDK has supported this on 11
 *      hook return types since 0.3.x (verified at 0.3.160). Use for
 *      reactions to tool results that should reach the agent before its
 *      next action (truncated Read, linter rewrote our Edit, MCP delta
 *      mid-turn).
 *
 * Canonical wrapper format matches the `cleanReminders` regex in
 * `lib/server/customization-description.ts` — the opening tag must be
 * exactly `<system-reminder>` (no attributes) so cleaning still strips
 * the block downstream. We carry the `kind` in-memory for debug/telemetry
 * but never on the tag.
 */

/** String-literal union of every reminder kind we expect across the parity work. */
export type ReminderKind =
  | "date-change"
  | "stale-todowrite"
  | "stale-task-tools"
  | "todos-current"
  | "plan-mode-reentry"
  | "auto-mode-exit"
  | "memory-update"
  | "verify-plan"
  | "ultrathink-prose"
  | "ultraplan-prose"
  | "midturn-inject"
  | "linter-modified-file"
  | "mcp-delta"
  // Mid-turn kinds — fire via the PreToolUse hook's `additionalContext`
  // return before the agent's next tool call within the same turn.
  | "truncated-read"
  | "linter-modified-file-midturn"
  | "mcp-delta-midturn";

/**
 * Minimal structural host. Anything with a stable `id` will do — keeping
 * this loose lets unit tests pass `{ id: "s1" }` without constructing a
 * full `Session` (and avoids a circular type import).
 */
export type ReminderHost = { readonly id: string };

type Entry = { kind: ReminderKind; xml: string };

// WeakMap so a session that's evicted by `SessionManager` GCs its queue
// alongside the instance — mirrors how `scheduledLoops` dies with the
// session. Keyed by the host object (not its id) so two transient hosts
// sharing an id can't cross-contaminate.
const queues = new WeakMap<ReminderHost, Entry[]>();

/**
 * Separate queue for mid-turn reminders. Drained by the PreToolUse hook
 * in `Session.start()` (which returns the concatenation as the hook's
 * `additionalContext` field) so the agent sees them before its next tool
 * call. Kept separate from the next-turn queue because the lifetimes
 * differ — a mid-turn reminder is per-tool-call ephemeral, a next-turn
 * one survives until the user submits again.
 */
const midTurnQueues = new WeakMap<ReminderHost, Entry[]>();

/**
 * Wrap raw text in the canonical `<system-reminder>` block. Trailing `\n\n`
 * matters: the goal-reminder path bakes the same separator in so that
 * concatenating N reminders + the user's text never butts blocks together
 * or against the user's first character.
 */
export function wrapReminder(body: string): string {
  return `<system-reminder>\n${body}\n</system-reminder>\n\n`;
}

/**
 * Wrap + tag for telemetry/debug. The `kind` is recorded on the queue
 * entry, NOT on the XML tag — adding an attribute would break the
 * `cleanReminders` regex (`<system-reminder>` with no attrs) and leak
 * the tag into the cleaned prompt downstream.
 */
export function buildNextTurnReminder(kind: ReminderKind, body: string): string {
  void kind; // surface in queue entry; intentionally not on the tag
  return wrapReminder(body);
}

/** Queue a reminder onto the host's next-turn channel. */
export function queueReminder(host: ReminderHost, kind: ReminderKind, body: string): void {
  const xml = buildNextTurnReminder(kind, body);
  const existing = queues.get(host);
  if (existing) {
    existing.push({ kind, xml });
    return;
  }
  queues.set(host, [{ kind, xml }]);
}

/**
 * Drain every queued reminder for the host. Returns the concatenated XML
 * (each block already carries a trailing `\n\n`, so concatenation is
 * clean) or `null` when nothing is pending — callers branch on null the
 * same way they branch on `takeGoalReminder()` returning `""`.
 */
export function takePendingReminders(host: ReminderHost): string | null {
  const entries = queues.get(host);
  if (!entries || entries.length === 0) return null;
  queues.delete(host);
  return entries.map((e) => e.xml).join("");
}

/** Test-only: peek queue length without draining. Useful for unit assertions. */
export function pendingReminderCount(host: ReminderHost): number {
  return queues.get(host)?.length ?? 0;
}

/**
 * Queue a reminder onto the host's mid-turn channel. The reminder fires
 * via the PreToolUse hook's `additionalContext` return before the agent's
 * next tool call. Drained by `takeMidTurnReminders`. Once drained the
 * queue is empty — a reminder fires exactly once.
 */
export function queueMidTurnReminder(
  host: ReminderHost,
  kind: ReminderKind,
  body: string,
): void {
  const xml = buildNextTurnReminder(kind, body);
  const existing = midTurnQueues.get(host);
  if (existing) {
    existing.push({ kind, xml });
    return;
  }
  midTurnQueues.set(host, [{ kind, xml }]);
}

/**
 * Drain every queued mid-turn reminder for the host. Returns the
 * concatenated XML or `null` when nothing is pending. The PreToolUse
 * hook in `Session.start()` calls this and threads the result through
 * `hookSpecificOutput.additionalContext` so the agent receives the
 * reminder text before deciding on its next tool.
 */
export function takeMidTurnReminders(host: ReminderHost): string | null {
  const entries = midTurnQueues.get(host);
  if (!entries || entries.length === 0) return null;
  midTurnQueues.delete(host);
  return entries.map((e) => e.xml).join("");
}

/** Test-only: peek mid-turn queue length without draining. */
export function midTurnReminderCount(host: ReminderHost): number {
  return midTurnQueues.get(host)?.length ?? 0;
}
