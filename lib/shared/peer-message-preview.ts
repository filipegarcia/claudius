/**
 * Claude Code 2.1.247 — "Changed cross-session peer messages to collapse by
 * default to a one-line `Message from @<sender>: <first line>` preview;
 * Ctrl+O expands the full body." Claudius has no per-message keybinding
 * surface analogous to the CLI's Ctrl+O (see `UserMessage.tsx`'s
 * click-to-expand affordance instead, matching the existing `BashIOBlock`
 * collapse pattern) but the preview-string shape is a plain, testable
 * function shared with the renderer.
 */

/** First non-empty line of `text`, trimmed. Empty input yields "". */
export function firstLine(text: string): string {
  const line = text.split("\n").find((l) => l.trim().length > 0) ?? "";
  return line.trim();
}

/** The one-line collapsed preview shown for a peer-authored turn. */
export function peerMessagePreview(name: string, body: string): string {
  const line = firstLine(body);
  return line ? `Message from ${name}: ${line}` : `Message from ${name}`;
}
