/**
 * Static mirror of the deprecation map baked into the upstream Claude Agent
 * SDK (`sdk.mjs`'s `jw` constant — model id → end-of-life date string). The
 * SDK only surfaces this via a console.warn at request time; nothing on
 * `ModelInfo` carries the flag, so we mirror it here to drive an in-app
 * "model deprecated" chip on the StatusLine before the next request fails
 * over.
 *
 * Source of truth: https://docs.anthropic.com/en/docs/resources/model-deprecations
 * Snapshot taken from claude-agent-sdk @ 2026-Q2. Refresh when bumping the
 * SDK and dates appear in the changelog.
 *
 * Note: the SDK keeps a second list (`Zv`) for models where `thinking.type=
 * enabled` is deprecated in favour of `thinking.type=adaptive`. That is a
 * thinking-config nag, NOT a model end-of-life signal, and is intentionally
 * not mirrored here.
 */
export const DEPRECATED_MODELS: Record<string, string> = {
  "claude-1.3": "November 6th, 2024",
  "claude-1.3-100k": "November 6th, 2024",
  "claude-instant-1.1": "November 6th, 2024",
  "claude-instant-1.1-100k": "November 6th, 2024",
  "claude-instant-1.2": "November 6th, 2024",
  "claude-2.0": "July 21st, 2025",
  "claude-2.1": "July 21st, 2025",
  "claude-3-sonnet-20240229": "July 21st, 2025",
  "claude-3-opus-20240229": "January 5th, 2026",
  "claude-3-7-sonnet-latest": "February 19th, 2026",
  "claude-3-7-sonnet-20250219": "February 19th, 2026",
  "claude-3-5-haiku-latest": "February 19th, 2026",
  "claude-3-5-haiku-20241022": "February 19th, 2026",
  "claude-opus-4-0": "June 15th, 2026",
  "claude-opus-4-20250514": "June 15th, 2026",
  "claude-sonnet-4-0": "June 15th, 2026",
  "claude-sonnet-4-20250514": "June 15th, 2026",
};

/**
 * EOL date for a model id, or null if it isn't on the deprecation list. The
 * id is matched verbatim — aliases like `claude-3-5-sonnet-latest` that the
 * SDK doesn't list resolve to null, mirroring the SDK's own behaviour.
 */
export function modelDeprecationDate(model: string | null | undefined): string | null {
  if (!model) return null;
  return DEPRECATED_MODELS[model] ?? null;
}
