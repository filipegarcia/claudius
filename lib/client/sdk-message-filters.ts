// Pure parsers over the `content` field of SDK user-shaped messages. Live
// in their own module so the chat-render code in `use-session.ts` can
// stay focused on state plumbing and the parsers can be unit-tested
// without standing up a React hook. None of these touch React, the DOM,
// or any persistent storage — they're string-shape recognizers.

import { findSlashCommand } from "@/lib/shared/slash-commands";
import { COMPACT_SUMMARY_PREFIX, isRealUserPrompt } from "@/lib/shared/user-prompt";
import type { DisplayMessage } from "./types";

/**
 * Detect a user message whose entire content is an SDK-handled slash
 * command (e.g. `/compact`, `/init`, `/recap`). Used to filter the chat-
 * prose render on resume / resyncFromDisk paths: when the on-disk JSONL
 * has a `/compact` user message left over from a prior turn, we render
 * a system pill in its place instead of echoing the slash text as if the
 * user had typed it again.
 *
 * The live-send path doesn't need this — the server already skips the
 * user-message broadcast for opt-in slash sends — but disk-sourced
 * messages flow back through the same `msg.type === "user"` branch and
 * would otherwise re-introduce the echo bug on reload.
 */
export function isSdkSlashUserMessage(
  content: unknown,
): { command: string; args: string } | null {
  let text: string;
  if (typeof content === "string") text = content;
  else if (Array.isArray(content)) {
    let acc = "";
    for (const c of content as Array<{ type?: string; text?: string }>) {
      if (c?.type === "text" && c.text) acc += c.text;
      else return null; // anything non-text means it wasn't a pure slash command
    }
    text = acc;
  } else return null;
  const trimmed = text.trim();
  if (!trimmed.startsWith("/")) return null;
  const m = /^\/([^\s/]+)(?:\s+([\s\S]*))?$/.exec(trimmed);
  if (!m) return null;
  const cmd = findSlashCommand(m[1]);
  if (!cmd || cmd.handler !== "sdk") return null;
  return { command: `/${m[1]}`, args: (m[2] ?? "").trim() };
}

/**
 * Detect the user-shaped messages the Claude Code CLI synthesizes around a
 * slash-command run. These arrive as user-role messages on the SDK stream
 * but were never typed by the user — they're internal handshake the
 * subprocess emits so the model can see what command ran and what its
 * stdout was. Examples:
 *
 *   <command-name>/compact</command-name>
 *   <command-message>compact</command-message>
 *   <command-args></command-args>
 *
 *   <local-command-stdout>Compacted </local-command-stdout>
 *   <local-command-stderr>...</local-command-stderr>
 *
 * Rendering them as user bubbles surfaces XML the user didn't write and
 * makes the chat look like the user posted plumbing. The caller lifts a
 * match to a small assistant-side system pill instead.
 */
export type SyntheticCliWrapper =
  | { kind: "command"; command: string; args: string }
  | { kind: "stdout" | "stderr"; text: string };

export function parseSyntheticCliWrapper(content: unknown): SyntheticCliWrapper | null {
  const trimmed = contentAsTrimmedText(content);
  if (!trimmed) return null;
  // <command-name>/X</command-name>... — capture the slash and trailing args.
  const cmdMatch = /^<command-name>\s*(\/[^\s<]+)\s*<\/command-name>/i.exec(trimmed);
  if (cmdMatch) {
    const argsMatch = /<command-args>([\s\S]*?)<\/command-args>/i.exec(trimmed);
    return { kind: "command", command: cmdMatch[1], args: (argsMatch?.[1] ?? "").trim() };
  }
  const stdoutMatch = /^<local-command-stdout>([\s\S]*?)<\/local-command-stdout>/i.exec(trimmed);
  if (stdoutMatch) return { kind: "stdout", text: stdoutMatch[1].trim() };
  const stderrMatch = /^<local-command-stderr>([\s\S]*?)<\/local-command-stderr>/i.exec(trimmed);
  if (stderrMatch) return { kind: "stderr", text: stderrMatch[1].trim() };
  return null;
}

/**
 * Fold the various `MessageParam.content` shapes (string | array of blocks)
 * down to a single trimmed string so the regex-based detectors can run a
 * consistent shape check. Returns `""` for unsupported shapes; callers
 * short-circuit on empty.
 */
function contentAsTrimmedText(content: unknown): string {
  if (typeof content === "string") return content.trim();
  if (!Array.isArray(content)) return "";
  let buf = "";
  for (const c of content as Array<{ type?: string; text?: string }>) {
    if (c?.type === "text" && typeof c.text === "string") buf += c.text;
  }
  return buf.trim();
}

/**
 * The stable opening of the synthesized user-shaped message the SDK injects
 * immediately after a successful `/compact`. The SDK marks the envelope with
 * `isCompactSummary: true` AND `isVisibleInTranscriptOnly: true` on disk, but
 * the live `query` async iterator strips those envelope-level flags before
 * forwarding the message to consumers — `isSdkInternalEnvelope` (which reads
 * the flags) only catches the disk-replay path (`resyncFromDisk`,
 * `synthesizeOlder`).
 *
 * Without this content-shape fallback, the live `/compact` run renders the
 * entire summary ("This session is being continued from a previous
 * conversation…\n\nSummary:\n1. Primary Request…") as a user bubble at the
 * tail of the chat — the exact bug a user reported on 2026-05-14. Matching
 * on the leading sentence is robust because that text is hard-coded in the
 * SDK runtime; if Anthropic ever changes it, the disk-replay envelope check
 * still catches the same record on the next reload.
 *
 * The prefix constant lives in `lib/shared/user-prompt.ts` so this client-side
 * display filter and the server-side prompt-snapshot filter resolve the same
 * string and can't drift.
 */
export function isCompactSummaryContent(content: unknown): boolean {
  const trimmed = contentAsTrimmedText(content);
  if (!trimmed) return false;
  return trimmed.startsWith(COMPACT_SUMMARY_PREFIX);
}

/**
 * `<local-command-caveat>...` wrappers the SDK emits around slash-command
 * runs to remind the model that the local CLI handled the command. The SDK
 * stamps the envelope with `isMeta: true` on disk, but the live iterator
 * strips that flag in the same way it strips `isCompactSummary` — see the
 * docstring on `isCompactSummaryContent`. This content-shape check is the
 * live-path counterpart so the caveat never reaches the chat as a user
 * bubble even when the envelope flag is absent.
 */
export function isLocalCommandCaveatContent(content: unknown): boolean {
  const trimmed = contentAsTrimmedText(content);
  if (!trimmed) return false;
  return /^<local-command-caveat[\s>]/i.test(trimmed);
}

/**
 * True when the SDK envelope itself is flagged as transcript-only plumbing —
 * `isMeta` (e.g. `<local-command-caveat>`), `isCompactSummary` (the synthesized
 * "Session continued from a previous conversation…" user message the SDK
 * emits right after a successful /compact), or `isVisibleInTranscriptOnly`
 * (the SDK's own marker for "model-context-only, do not surface").
 *
 * These flags live on the JSONL envelope, not on the inner `message.content`,
 * so they slip past the content-shape parsers. The SDK's own slash-detection
 * (`P8` in the runtime) skips these the same way; mirroring it on the
 * display side keeps the chat clean when paginated history brings them back
 * — without this filter, a paginated /compact run shows two extra "user"
 * bubbles (the summary and the caveat) that the user never typed.
 */
export function isSdkInternalEnvelope(msg: unknown): boolean {
  if (!msg || typeof msg !== "object") return false;
  const m = msg as {
    isMeta?: boolean;
    isCompactSummary?: boolean;
    isVisibleInTranscriptOnly?: boolean;
  };
  return m.isMeta === true || m.isCompactSummary === true || m.isVisibleInTranscriptOnly === true;
}

/**
 * True when a user-message's text content is a synthetic `<task-notification>`
 * wrapper that the SDK injects to inform the model a background task finished.
 * Those wrappers are valid input to Claude — they carry the task id, output
 * path, and status — but they're noise in the chat UI: the user didn't type
 * them, and the TaskBlock surface already shows the completion state from
 * the paired system event. Filter them out at ingest so they never become a
 * user bubble.
 *
 * Recognition is text-shaped because the wrappers arrive as plain text
 * content (no structural marker on the SDK envelope distinguishes them).
 * The match is forgiving about leading whitespace; otherwise we look for the
 * opening tag at the start so we don't false-positive on a real user prompt
 * that happens to quote the string.
 */
export function isSyntheticTaskNotification(content: unknown): boolean {
  // We use contentAsTrimmedText here rather than allowing leading whitespace
  // in the regex because the shared helper is also used by the compact-summary
  // and caveat detectors below — keeping the shape-normalization in one place
  // means a future content shape (e.g. a new SDK content-block variant) gets
  // picked up by all three filters at once.
  const trimmed = contentAsTrimmedText(content);
  if (!trimmed) return false;
  return /^<task-notification[\s>]/.test(trimmed);
}

/**
 * Defense-in-depth predicate for the "what's the last user message?" pin
 * walk in `MessageList`. Reconstructs the raw text content from the bubble's
 * blocks and delegates to the shared `isRealUserPrompt` so the client pin
 * and the server's `latestUserPromptSnapshot` capture agree on what counts
 * as a real user prompt. Today the intake reducer in `use-session` already
 * drops synthetic wrappers before they reach `messages`, so this is mostly
 * belt-and-suspenders — but if a new server-side wrapper kind ships and the
 * client filter forgets to mirror it, the pin will at least skip the bogus
 * bubble instead of pinning XML the user never typed.
 */
export function isRealUserDisplayMessage(m: DisplayMessage): boolean {
  if (m.role !== "user") return false;
  let text = "";
  for (const b of m.blocks) {
    if (b.kind === "text") text += b.text;
  }
  return isRealUserPrompt(text);
}
