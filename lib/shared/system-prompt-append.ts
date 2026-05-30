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
