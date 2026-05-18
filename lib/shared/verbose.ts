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
 * Three levels balance "I want only the conversation" vs. "show me
 * everything the model emits":
 *
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
 *                  un-hides it.
 *
 * Persistence: the workspace's default lives in
 * `WorkspaceDefaults.verbose` (workspaces.json). The chat header lets the
 * user remap on the fly; that change is persisted back to the workspace,
 * so the next session in the same workspace inherits it.
 */

import type { DisplayBlock, DisplayMessage } from "@/lib/client/types";

export const VERBOSE_LEVELS = ["compact", "normal", "verbose"] as const;
export type VerboseLevel = (typeof VERBOSE_LEVELS)[number];

export const DEFAULT_VERBOSE: VerboseLevel = "normal";

export function isVerboseLevel(v: unknown): v is VerboseLevel {
  return typeof v === "string" && (VERBOSE_LEVELS as readonly string[]).includes(v);
}

/**
 * Apply the level to a single assistant block list. Returns a fresh array.
 * - `compact`: keeps only `text` blocks.
 * - `normal`: drops `thinking` blocks; keeps text + tool_use (incl. Task).
 * - `verbose`: returns the input unchanged.
 *
 * User messages aren't passed here — they're never filtered.
 */
export function filterAssistantBlocks(
  blocks: DisplayBlock[],
  level: VerboseLevel,
): DisplayBlock[] {
  if (level === "verbose") return blocks;
  // One pass + reference-stable: if nothing was filtered, return the input
  // array unchanged so downstream `useMemo` / `=== prev` checks short-circuit.
  // The straightforward `.filter` always allocates a new array even when the
  // predicate keeps every entry — costly when the user is at a non-verbose
  // level and most assistant turns happen to be prose-only.
  const keep = (b: DisplayBlock): boolean =>
    level === "compact"
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
  if (level === "verbose") return false;
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
  if (level === "verbose") return messages;
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
  return out;
}

/**
 * Short human label for the level. Used in the StatusLine dropdown and
 * tooltips.
 */
export function verboseLabel(level: VerboseLevel): string {
  switch (level) {
    case "compact":
      return "Compact";
    case "normal":
      return "Normal";
    case "verbose":
      return "Verbose";
  }
}

export function verboseDescription(level: VerboseLevel): string {
  switch (level) {
    case "compact":
      return "Only user + assistant text. Tool calls and thinking are hidden from the chat (still visible in the right rail).";
    case "normal":
      return "Text + tool calls + subagent (Task) blocks. Thinking stays hidden.";
    case "verbose":
      return "Everything — text, tool calls, Task, and the full thinking stream.";
  }
}
