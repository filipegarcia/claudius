/**
 * Combine the multiple sources that append to Claude Code's system-prompt
 * preset into a single string for `Options.systemPrompt.append`.
 *
 * Why this exists: the SDK's Options is a plain object literal, so emitting
 * `systemPrompt` more than once makes the later key silently clobber the
 * earlier (duplicate-key semantics). Two independent features append to the
 * preset — the per-session goal (authoritative objective) and the workspace
 * `systemPromptAppend` (house-style steering) — and BOTH must reach the model.
 * Funnelling them through this helper guarantees one `systemPrompt` with every
 * contribution preserved, joined by a blank line.
 *
 * Empty / whitespace-only parts are dropped; the result is `""` when nothing
 * contributes, which callers treat as "omit systemPrompt entirely" so the
 * no-extras path stays byte-identical to the SDK default.
 */
export function joinSystemPromptAppends(parts: Array<string | null | undefined>): string {
  return parts
    .map((p) => (typeof p === "string" ? p.trim() : ""))
    .filter((p) => p.length > 0)
    .join("\n\n");
}

/**
 * Build the `Options.systemPrompt` value for a non-empty combined append, or
 * `undefined` when there's nothing to append (caller omits the key so the
 * no-extras path stays byte-identical to the SDK default).
 *
 * `snapshot: false` opts out of the SDK 0.3.265 default flip (recording the
 * prompt on the conversation's first request and replaying it verbatim on
 * every later request/resume until compaction). Claudius recomputes this
 * append from mutable state — most importantly the workspace-level
 * `systemPromptAppend` (house-style steering) — on every `Session.start()`
 * call, including a resume after the idle-reap loop, with no other delivery
 * path for a change made between sessions. The default's "recorded" behaviour
 * would silently ignore such an edit until the next compaction, so we keep
 * the pre-0.3.265 "render fresh every launch" behaviour explicitly. See the
 * call site in `lib/server/session.ts` for the full trade-off note.
 */
export function buildSystemPromptOption(
  combinedAppend: string,
):
  | { type: "preset"; preset: "claude_code"; append: string; snapshot: false }
  | undefined {
  if (!combinedAppend) return undefined;
  return {
    type: "preset",
    preset: "claude_code",
    append: combinedAppend,
    snapshot: false,
  };
}
