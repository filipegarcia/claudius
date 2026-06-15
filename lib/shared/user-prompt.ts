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
 * The stable opening sentence of the SDK's post-compact "Session continued
 * from a previous conversation…" summary — a `user`-shaped record the SDK
 * synthesizes after a manual or automatic compaction. It lives here (shared)
 * rather than only in the client-side display filter so the server snapshot
 * predicates below and `sdk-message-filters.ts`'s `isCompactSummaryContent`
 * resolve the same string and can't drift. Matching on the leading sentence
 * is robust because that text is hard-coded in the SDK runtime.
 */
export const COMPACT_SUMMARY_PREFIX =
  "This session is being continued from a previous conversation";

function isCompactSummaryText(text: string): boolean {
  return text.trimStart().startsWith(COMPACT_SUMMARY_PREFIX);
}

/**
 * The CLI plumbing wrappers the Claude Code subprocess injects as *user*-role
 * records around a slash-command run — the model sees them, but the user never
 * typed them:
 *
 *   <command-name>/compact</command-name><command-message>…</command-message>…
 *   <local-command-stdout>Compacted </local-command-stdout>
 *   <local-command-stderr>…</local-command-stderr>
 *   <local-command-caveat>…</local-command-caveat>
 *
 * The chat-render filters in `sdk-message-filters.ts` already lift these to
 * small system pills, but the server's `latestUserPromptSnapshot` (and the
 * client pin walk) resolve "the last real user prompt" through THIS predicate.
 * Without this check, a `/compact` whose plumbing is the most-recent user
 * record gets snapshotted as the last prompt and re-injected as a user bubble
 * via `session_snapshot` — surfacing raw XML the user never wrote. Recognising
 * the wrappers here keeps the snapshot and the pin in lockstep with the render
 * filters.
 */
function isCliPlumbingText(text: string): boolean {
  return /^\s*<(?:command-name|command-message|command-args|local-command-stdout|local-command-stderr|local-command-caveat)[\s>]/i.test(
    text,
  );
}

/**
 * The Claude-only goal reminder the server prepends to the user's prompt when
 * a session goal is set (`Session.takeGoalReminder` →
 * `<session-goal>…</session-goal>`). It rides the SDK input — and thus the
 * on-disk JSONL — so the model keeps the objective in mind, but the user never
 * typed it. While the originating session is live in memory the chat shows the
 * clean broadcast echo; once the session is resumed cold from disk the JSONL
 * copy (wrapper + text) is all that's left, so the wrapper would surface in the
 * user's own bubble. Strip it on display so only the real prompt shows.
 *
 * No-op when the wrapper isn't present (the common case), so it's safe to run
 * on every user message.
 */
const GOAL_REMINDER_RE = /^\s*<session-goal>[\s\S]*?<\/session-goal>\s*/;

export function stripGoalReminder(text: string): string {
  return text.replace(GOAL_REMINDER_RE, "");
}

/**
 * Cross-turn `<system-reminder>` blocks the server prepends to the user's
 * SDK input via `takePendingReminders` (todos-current every-turn nudge,
 * stale-todowrite, date-change, plan-mode-reentry, etc. — see
 * `lib/server/system-reminders.ts`'s `ReminderKind` union). Like the goal
 * reminder, they ride the SDK input — and thus the on-disk JSONL — but
 * were never authored by the user. The live broadcast deliberately omits
 * them (so the chat shows the user's plain text), but a session resumed
 * cold from disk would otherwise surface the wrapper inside the user's
 * own bubble.
 *
 * `splitLeadingSystemReminders` peels off every consecutive leading block
 * (multiple stack when several reminders queue between turns) and returns
 * the parsed bodies separately so callers can render them as their own
 * `system_reminder` system pill instead of inlining them in the user
 * bubble. `stripSystemReminders` is the convenience wrapper that just
 * returns the residual text — use it when the bodies aren't needed
 * (`extractUserPromptText`, the pagination/`synthesizeOlder` path whose
 * only output channel is DisplayMessage[]).
 *
 * Anchored at the start so a user prompt that quotes `<system-reminder>`
 * mid-text isn't mangled.
 */
const SYSTEM_REMINDER_LEADING_RE = /^\s*<system-reminder>([\s\S]*?)<\/system-reminder>\s*/;

export function splitLeadingSystemReminders(text: string): {
  reminders: string[];
  rest: string;
} {
  const reminders: string[] = [];
  let rest = text;
  // Loop because the server can queue several reminders for the same turn
  // (e.g. todos-current + stale-task-tools + date-change) and they're
  // emitted back-to-back into the same SDK content string.
  for (;;) {
    const m = SYSTEM_REMINDER_LEADING_RE.exec(rest);
    if (!m) break;
    reminders.push(m[1].trim());
    rest = rest.slice(m[0].length);
  }
  return { reminders, rest };
}

export function stripSystemReminders(text: string): string {
  return splitLeadingSystemReminders(text).rest;
}

/**
 * Strip both the goal reminder and any leading `<system-reminder>` blocks
 * from the start of `text`. The server prepends `goal + system-reminders`
 * in that order (`Session.sendInput` →
 * `reminder = takeGoalReminder(); pending = takePendingReminders()`), so
 * the order here matches. Either side is a no-op when its wrapper is
 * absent, so this is safe to run on every user message.
 */
function stripLeadingReminders(text: string): string {
  return stripSystemReminders(stripGoalReminder(text));
}

/**
 * Pull the plain-text body out of a user SDK message's `content`. Returns
 * null for:
 *   - empty string content,
 *   - arrays with no text blocks (e.g. image-only prompts — those still
 *     survive via the SSE replay path; the snapshot fallback just doesn't
 *     carry their pixels),
 *   - synthetic `<task-notification>` wrappers,
 *   - the SDK's post-compact "Session continued from a previous
 *     conversation…" summary. That record is shaped like a user message but
 *     was authored by the SDK runtime, not the user. Excluding it here stops
 *     the server's `latestUserPromptSnapshot` from caching it (and the
 *     `session_snapshot` rehydration from re-injecting it as a user bubble),
 *     and stops the client pin walk from pinning it as "the last prompt".
 *     The chat surfaces a `compact_boundary` divider in its place instead.
 *   - reminder-only content: a user record whose entire body is goal /
 *     system-reminder wrappers with no user text after them. After stripping
 *     the residual is empty, so we return null and the pin walk skips it.
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
    if (isCompactSummaryText(content)) return null;
    if (isCliPlumbingText(content)) return null;
    const stripped = stripLeadingReminders(content);
    if (stripped.length === 0) return null;
    return stripped;
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
  if (isCompactSummaryText(text)) return null;
  if (isCliPlumbingText(text)) return null;
  const stripped = stripLeadingReminders(text);
  if (stripped.length === 0) return null;
  return stripped;
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

/**
 * Like {@link isRealUserPrompt}, but also treats **image-only** prompts as
 * genuine user input.
 *
 * `extractUserPromptText` (and therefore `isRealUserPrompt`) returns null for a
 * user record whose content is images with no text — see the doc comment there.
 * That's correct for the snapshot/pin callers (they cache prose and can't carry
 * pixels), but WRONG for the replay-window anchor: an image-only paste is a real
 * thing the user did, it survives the SSE replay, and the window should be
 * allowed to open on it instead of falling through to the assistant/tool turn
 * that followed. Anchoring on text-only prompts left image pastes unable to
 * anchor, so a reattach could land mid-tool-chain ("started on an agent").
 *
 * Still excludes the SDK bookkeeping that masquerades as a user record:
 * `tool_result` envelopes, `<task-notification>` injections, the post-compact
 * summary, CLI plumbing, and empty/reminder-only content — none of those are
 * conversational turns and none should anchor the window.
 */
export function isAnchorableUserPrompt(content: unknown): boolean {
  // Real text prompt (string or text blocks). Also rejects the synthetic
  // wrappers (tool_result-only arrays have no text; task-notification /
  // compact-summary / CLI plumbing are matched and stripped to empty).
  if (extractUserPromptText(content) !== null) return true;
  // No anchorable text — accept only if it's a genuine image-bearing prompt.
  // A `tool_result` block disqualifies it outright (that's a tool round-trip
  // envelope, never user input), regardless of any sibling blocks.
  if (!Array.isArray(content)) return false;
  let hasImage = false;
  for (const block of content) {
    const b = block as { type?: string } | null;
    if (b?.type === "tool_result") return false;
    if (b?.type === "image") hasImage = true;
  }
  return hasImage;
}
