/**
 * Chat verbosity levels — how much of an assistant turn ends up rendered in
 * the middle pane.
 *
 * The right-side activity rail (BackgroundTasksPanel) is intentionally NOT
 * gated by this — it derives from `toolHistory`, which records every tool
 * invocation regardless of chat filtering. That's the design contract: the
 * user gets a quieter conversation surface without losing the ability to
 * inspect what the agent is actually doing.
 *
 * Five levels span "just the conclusion" → "show me everything, expanded":
 *
 *   - `ultra-compact` — the tightest view. Same prose-only block filter as
 *                  `compact`, but each turn additionally collapses to its
 *                  *last* assistant message: you see the prompt and the final
 *                  answer, with all the intermediate back-and-forth dropped.
 *                  Status pills are hidden too.
 *   - `compact`  — only user/assistant prose. Tool calls, subagent (Task)
 *                  blocks, and thinking blocks are dropped from the chat.
 *                  Assistant messages whose blocks are entirely filtered
 *                  out collapse to nothing (no empty bubble).
 *   - `normal`   — the historical default: prose + tool calls + Task. The
 *                  thinking stream stays hidden because it can be very long
 *                  and most users don't care to read it inline.
 *   - `verbose`  — everything. The SDK is already configured with
 *                  `thinking: { type: "adaptive" }` (see lib/server/session.ts)
 *                  so the thinking text is always streamed; this level just
 *                  un-hides it. Cards (tool calls, thinking, Task, workflow)
 *                  still render collapsed — click to expand.
 *   - `ultra-verbose` — same content as `verbose`, but every collapsible card
 *                  renders already-expanded. Nothing to click; the full input,
 *                  result, reasoning, and subagent transcript are all visible
 *                  inline. See {@link shouldExpandAllBlocks}.
 *
 * Persistence: the workspace's default lives in
 * `WorkspaceDefaults.verbose` (workspaces.json). The chat header lets the
 * user remap on the fly; that change is persisted back to the workspace,
 * so the next session in the same workspace inherits it.
 */

import type { DisplayBlock, DisplayMessage, SystemEntry } from "@/lib/client/types";

// Ordered least-verbose → most-verbose. The StatusLine dropdown and the
// dev preview both iterate this array, so the order here is the order the
// user sees.
export const VERBOSE_LEVELS = [
  "ultra-compact",
  "compact",
  "normal",
  "verbose",
  "ultra-verbose",
] as const;
export type VerboseLevel = (typeof VERBOSE_LEVELS)[number];

export const DEFAULT_VERBOSE: VerboseLevel = "normal";

export function isVerboseLevel(v: unknown): v is VerboseLevel {
  return typeof v === "string" && (VERBOSE_LEVELS as readonly string[]).includes(v);
}

/**
 * Apply the level to a single assistant block list. Returns a fresh array.
 * - `ultra-compact` / `compact`: keeps only `text` blocks. (The per-turn
 *   "last message only" collapse for `ultra-compact` happens at the message
 *   level in {@link filterMessagesByVerbose}, not here.)
 * - `normal`: drops `thinking` blocks; keeps text + tool_use (incl. Task).
 * - `verbose` / `ultra-verbose`: returns the input unchanged. The two differ
 *   only in how the surviving cards render (collapsed vs. auto-expanded),
 *   which is a presentation concern — see {@link shouldExpandAllBlocks}.
 *
 * User messages aren't passed here — they're never filtered.
 */
export function filterAssistantBlocks(
  blocks: DisplayBlock[],
  level: VerboseLevel,
): DisplayBlock[] {
  if (level === "verbose" || level === "ultra-verbose") return blocks;
  // One pass + reference-stable: if nothing was filtered, return the input
  // array unchanged so downstream `useMemo` / `=== prev` checks short-circuit.
  // The straightforward `.filter` always allocates a new array even when the
  // predicate keeps every entry — costly when the user is at a non-verbose
  // level and most assistant turns happen to be prose-only.
  const keep = (b: DisplayBlock): boolean =>
    level === "compact" || level === "ultra-compact"
      ? b.kind === "text"
      : // normal: drop thinking, keep text + tool_use (incl. Task)
        b.kind !== "thinking";
  let firstReject = -1;
  for (let i = 0; i < blocks.length; i++) {
    if (!keep(blocks[i]!)) {
      firstReject = i;
      break;
    }
  }
  if (firstReject === -1) return blocks;
  const out = blocks.slice(0, firstReject);
  for (let i = firstReject + 1; i < blocks.length; i++) {
    if (keep(blocks[i]!)) out.push(blocks[i]!);
  }
  return out;
}

/**
 * Whether an assistant message should disappear entirely after filtering.
 * Returns true when the message has no surviving blocks. Apply at the
 * MessageList level so the bubble chrome (avatar, timestamp) doesn't render
 * an empty card.
 *
 * User messages always survive.
 */
export function isMessageHiddenAtLevel(
  message: Pick<DisplayMessage, "role" | "blocks">,
  level: VerboseLevel,
): boolean {
  if (message.role === "user") return false;
  if (level === "verbose" || level === "ultra-verbose") return false;
  const kept = filterAssistantBlocks(message.blocks, level);
  return kept.length === 0;
}

/**
 * Convenience pass: apply both the per-block filter and the empty-message
 * drop in one call. Returns a new array; original messages are not mutated
 * (blocks are referentially the same when nothing was removed).
 */
export function filterMessagesByVerbose(
  messages: DisplayMessage[],
  level: VerboseLevel,
): DisplayMessage[] {
  if (level === "verbose" || level === "ultra-verbose") return messages;
  const out: DisplayMessage[] = [];
  for (const m of messages) {
    if (m.role === "user") {
      out.push(m);
      continue;
    }
    const blocks = filterAssistantBlocks(m.blocks, level);
    if (blocks.length === 0) continue; // drop empty assistant bubble
    // Preserve reference identity when nothing changed — cheaper for React
    // memoisation downstream.
    out.push(blocks === m.blocks ? m : { ...m, blocks });
  }
  if (level !== "ultra-compact") return out;
  // ultra-compact: collapse each turn to its last assistant message. A turn
  // is a user message followed by a run of assistant messages (or, for a
  // resumed-session prelude, a leading assistant run with no user). We keep
  // every user message and only the *final* assistant message of each run —
  // the conclusion — discarding the intermediate back-and-forth.
  return collapseTurnsToLastAssistant(out);
}

/**
 * Keep all user messages; within each maximal run of consecutive assistant
 * messages, keep only the last one. Operates on the already block-filtered
 * list from {@link filterMessagesByVerbose}, so "last assistant" means the
 * last one that still had surviving prose.
 */
function collapseTurnsToLastAssistant(messages: DisplayMessage[]): DisplayMessage[] {
  const out: DisplayMessage[] = [];
  let lastAssistant: DisplayMessage | null = null;
  for (const m of messages) {
    if (m.role === "user") {
      if (lastAssistant) {
        out.push(lastAssistant);
        lastAssistant = null;
      }
      out.push(m);
    } else {
      // Hold onto this assistant message; if another assistant follows it in
      // the same run it wins, otherwise it gets flushed at the next user
      // boundary (or after the loop).
      lastAssistant = m;
    }
  }
  if (lastAssistant) out.push(lastAssistant);
  return out;
}

/**
 * Whether a system pill of the given `kind` should be hidden from the chat at
 * this verbose level. The chat's `systemEntries` stream (init, hook, status,
 * rate-limit, …) renders separately from assistant turns, so the block-level
 * filters above never see it — this is the parallel gate for that surface.
 *
 * Today the only rule: the transient `status` ticker ("Status: requesting")
 * is plumbing, not conversation, so it's dropped at `compact` (and tighter).
 * `compact`'s own contract — "only user + assistant text" — promises exactly
 * this; the pill leaking through was a bug against that description. Normal /
 * verbose keep all plumbing pills by design.
 */
export function isSystemEntryHiddenAtLevel(
  kind: SystemEntry["kind"],
  level: VerboseLevel,
): boolean {
  if ((level === "compact" || level === "ultra-compact") && kind === "status") return true;
  // System reminders are server-side plumbing (cross-turn nudges the model
  // sees, surfaced here so they're visible-but-tidy on resume). At compact
  // and tighter the contract is "user + assistant text only" — hiding them
  // there matches the same reasoning as the `status` rule above.
  if ((level === "compact" || level === "ultra-compact") && kind === "system_reminder")
    return true;
  return false;
}

/**
 * Short human label for the level. Used in the StatusLine dropdown and
 * tooltips.
 */
export function verboseLabel(level: VerboseLevel): string {
  switch (level) {
    case "ultra-compact":
      return "Extra compact";
    case "compact":
      return "Compact";
    case "normal":
      return "Normal";
    case "verbose":
      return "Verbose";
    case "ultra-verbose":
      return "Extra verbose";
  }
}

export function verboseDescription(level: VerboseLevel): string {
  switch (level) {
    case "ultra-compact":
      return "Only the prompt and the final answer of each turn. Intermediate messages, tool calls, and thinking are hidden from the chat (still visible in the right rail).";
    case "compact":
      return "Only user + assistant text. Tool calls and thinking are hidden from the chat (still visible in the right rail).";
    case "normal":
      return "Text + tool calls + subagent (Task) blocks. Thinking stays hidden.";
    case "verbose":
      return "Everything — text, tool calls, Task, and the full thinking stream. Cards start collapsed.";
    case "ultra-verbose":
      return "Everything, with every tool call, thinking, Task, and workflow card expanded by default.";
  }
}

/**
 * Whether collapsible cards (tool calls, thinking, Task, workflow) should
 * render already-expanded for this level. Only `ultra-verbose` opts in;
 * every other level keeps cards collapsed so the transcript stays scannable.
 * Threaded from `AssistantMessage` down to each card's `defaultOpen` prop.
 */
export function shouldExpandAllBlocks(level: VerboseLevel): boolean {
  return level === "ultra-verbose";
}
