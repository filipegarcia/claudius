// Shared predicates for "does this SDK user message represent a real user
// prompt?" Used in two places:
//   1. Server snapshot capture (`Session.captureSnapshotState`) — decides
//      whether to refresh `latestUserPromptSnapshot` for tail-truncated
//      replay rehydration.
//   2. Client pin walk (`MessageList`'s last-user-message memo) — decides
//      whether a user bubble counts as a real prompt worth pinning at the
//      top of the chat viewport.
//
// Keeping a single source of truth here means a future SDK plumbing wrapper
// (a new `<task-foo>` synthesized envelope, say) only needs to be filtered
// once, and the server-side snapshot stays in lockstep with the client-side
// pin. The functions are pure on raw SDK content shapes — no Node-specific
// or browser-specific dependencies, so they live in `lib/shared/`.

/**
 * Test whether a content body is the SDK-synthesized `<task-notification>`
 * wrapper. These arrive as user-role SDK messages so the model can react
 * to a finished background task, but they're noise in the chat UI — the
 * user didn't type them. Accepts the same raw content shapes as
 * `extractUserPromptText`.
 *
 * Recognition is text-shaped because the wrappers arrive as plain text
 * content (no structural marker on the SDK envelope distinguishes them).
 */
function isTaskNotificationText(text: string): boolean {
  return /^\s*<task-notification[\s>]/.test(text);
}

/**
 * Pull the plain-text body out of a user SDK message's `content`. Returns
 * null for:
 *   - empty string content,
 *   - arrays with no text blocks (e.g. image-only prompts — those still
 *     survive via the SSE replay path; the snapshot fallback just doesn't
 *     carry their pixels),
 *   - synthetic `<task-notification>` wrappers.
 *
 * Returns null for synthetic tool_result wrappers (which have no `text`
 * blocks) by virtue of the text accumulator staying at length 0.
 *
 * @param content Either a string or an array of SDK content blocks
 *                (`{ type, text }`-shaped objects).
 */
export function extractUserPromptText(content: unknown): string | null {
  if (typeof content === "string") {
    if (content.length === 0) return null;
    if (isTaskNotificationText(content)) return null;
    return content;
  }
  if (!Array.isArray(content)) return null;
  let text = "";
  for (const block of content) {
    const b = block as { type?: string; text?: string } | null;
    if (b?.type === "text" && typeof b.text === "string") {
      text += b.text;
    }
  }
  if (text.length === 0) return null;
  if (isTaskNotificationText(text)) return null;
  return text;
}

/**
 * Distinguish a real user prompt from an SDK-synthetic wrapper (tool_result
 * envelopes, `<task-notification>` injections, empty content). Mirrors the
 * check that gates `latestUserPromptSnapshot` updates on the server, so the
 * server-snapshot and the client-pin agree on what counts.
 */
export function isRealUserPrompt(content: unknown): boolean {
  return extractUserPromptText(content) !== null;
}
