// Pure parsers over the `content` field of SDK user-shaped messages. Live
// in their own module so the chat-render code in `use-session.ts` can
// stay focused on state plumbing and the parsers can be unit-tested
// without standing up a React hook. None of these touch React, the DOM,
// or any persistent storage — they're string-shape recognizers.

import { findSlashCommand } from "@/lib/shared/slash-commands";

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
  let text: string;
  if (typeof content === "string") text = content;
  else if (Array.isArray(content)) {
    let buf = "";
    for (const c of content as Array<{ type?: string; text?: string }>) {
      if (c?.type === "text" && typeof c.text === "string") buf += c.text;
    }
    text = buf;
  } else return null;
  const trimmed = text.trim();
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
  let text: string;
  if (typeof content === "string") {
    text = content;
  } else if (Array.isArray(content)) {
    let buf = "";
    for (const c of content as Array<{ type?: string; text?: string }>) {
      if (c?.type === "text" && typeof c.text === "string") buf += c.text;
    }
    text = buf;
  } else {
    return false;
  }
  return /^\s*<task-notification[\s>]/.test(text);
}
