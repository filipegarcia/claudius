/**
 * Shared next-turn `<system-reminder>` injection channel.
 *
 * Several upcoming parity features (date-change nudge, stale-TodoWrite,
 * plan-mode re-entry, etc.) all need to drop a one-shot reminder onto the
 * agent's next user turn. Rather than each one reinventing the prepend,
 * they queue here and `Session` drains the queue alongside its existing
 * `takeGoalReminder()` call at the inputQueue site.
 *
 * Mid-loop injection is NOT supported — the SDK hooks we use today don't
 * expose `additionalContext` on their return. Reminders fire on the next
 * real user message and only then.
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
  | "plan-mode-reentry"
  | "auto-mode-exit"
  | "memory-update"
  | "verify-plan"
  | "ultrathink-prose"
  | "ultraplan-prose"
  | "midturn-inject"
  | "linter-modified-file"
  | "mcp-delta";

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
