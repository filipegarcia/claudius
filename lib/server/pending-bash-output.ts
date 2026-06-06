/**
 * Pending `<bash-input>` / `<bash-stdout>` / `<bash-stderr>` blocks for the
 * `!` input-box mode.
 *
 * Mirrors the queue/drain shape of `system-reminders.ts` but emits RAW XML
 * (no `<system-reminder>` wrapper) — the model reads these blocks as plain
 * prior conversation context, the same way Claude Code's TUI surfaces them.
 *
 * Lifecycle:
 *   1. The `!cmd` route handler runs the command on the session's
 *      BashSession.
 *   2. Result + the original command are serialised into a single block:
 *        `<bash-input>cmd</bash-input>\n<bash-stdout>…</bash-stdout><bash-stderr>…</bash-stderr>`
 *      and queued via `queueBashBlock`.
 *   3. The next real user turn (`Session.sendInput`) drains via
 *      `takePendingBashBlocks(this)` at the same drain site as
 *      `takePendingReminders` and prepends the concatenated blocks to the
 *      inputQueue content (NOT the broadcast echo — the UI already showed
 *      the result via a synthetic SDK user event broadcast at exec time).
 *
 * Why a separate queue from system-reminders:
 *   - We don't want the `<system-reminder>` wrapper around bash output —
 *     that would imply "this is a one-shot nudge the user shouldn't see",
 *     but bash IO is real prior conversation the model should treat as
 *     committed history.
 *   - `cleanReminders` in `customization-description.ts` strips the
 *     reminder wrapper from derived strings (title summaries, etc.). Bash
 *     blocks get their own sibling `cleanBashBlocks` so derived strings
 *     are clean too.
 *
 * Stored as a `WeakMap` keyed on the host so an evicted Session GCs its
 * queue alongside the instance — identical pattern to the reminder queue.
 */

import type { ReminderHost } from "./system-reminders";

const queues = new WeakMap<ReminderHost, string[]>();

/**
 * Queue a serialized bash IO block onto the host's next-turn channel. The
 * caller is responsible for the full block shape, e.g.
 *   `<bash-input>ls</bash-input>\n<bash-stdout>file.txt</bash-stdout><bash-stderr></bash-stderr>`
 *
 * NEVER include the sudo password (or any secret) in `block` — the
 * caller's route handler is the trust boundary; this module just stores
 * what it's given, including it in the next prompt to the model.
 */
export function queueBashBlock(host: ReminderHost, block: string): void {
  const existing = queues.get(host);
  if (existing) {
    existing.push(block);
    return;
  }
  queues.set(host, [block]);
}

/**
 * Drain every queued bash block for the host. Blocks are joined with a
 * single newline (each block already terminates with `</bash-stderr>` so
 * there's no trailing whitespace to clean up). Returns `null` when
 * nothing is pending — callers branch the same way they branch on
 * `takePendingReminders` returning `null`.
 */
export function takePendingBashBlocks(host: ReminderHost): string | null {
  const entries = queues.get(host);
  if (!entries || entries.length === 0) return null;
  queues.delete(host);
  // Trailing newline so the block has clear separation from the user's
  // typed text when concatenated below.
  return entries.join("\n") + "\n";
}

/** Test seam — peek without draining. */
export function pendingBashBlockCount(host: ReminderHost): number {
  return queues.get(host)?.length ?? 0;
}

/**
 * Build a `<bash-input>…</bash-input>\n<bash-stdout>…</bash-stdout><bash-stderr>…</bash-stderr>`
 * block from a command + execution result. Mirrors the wrapper format the
 * leaked Claude Code source uses (`processBashCommand` in the Bun bundle),
 * so when the session JSONL replays on reload the renderer can recognise
 * and re-render these blocks specially via the same matcher used for live
 * broadcasts.
 *
 * Truncated bytes don't get a special marker here — the model can see the
 * raw cut-off; the UI rendering side surfaces the truncation flag visually.
 */
export function formatBashIOBlock(
  command: string,
  result: { stdout: string; stderr: string },
): string {
  return (
    `<bash-input>${command}</bash-input>\n` +
    `<bash-stdout>${result.stdout}</bash-stdout>` +
    `<bash-stderr>${result.stderr}</bash-stderr>`
  );
}
