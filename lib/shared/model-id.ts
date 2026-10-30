/**
 * CC 2.1.314 — "Fixed model IDs spelled with a dot behind an LLM gateway,
 * such as `claude-opus-4.8`, being treated as an older model with the wrong
 * context window, output limit, effort, thinking mode and cost".
 *
 * Context window, output limit, effort and thinking come from the engine
 * (`supportedModels()` / `modelUsage`), so the engine fix covers them. Cost is
 * Claudius's own: its pricing tables match model families by *dashed*
 * substring (`opus-5-5` before `opus-5`), so a dotted gateway id fell
 * through to the older entry (`claude-opus-5.5` priced as Opus 5).
 *
 * Rewrites only a `[claude-]<family>-<major>.<minor>` version dot to a dash
 * (gateways also send bare `sonnet-5.5`).
 * Every other dot is left alone: `us.anthropic.` / `anthropic.` provider
 * prefixes, `-v1:0` suffixes, and legacy ids like `claude-2.1` or
 * `claude-instant-1.2`. Date suffixes are kept (unlike `canonicalModelId`),
 * because the more specific pricing keys depend on them.
 */
const DOTTED_VERSION = /\b((?:claude-)?(?:opus|sonnet|haiku|fable|mythos)-\d+)\.(\d+)/gi;

export function normalizeDottedModelVersion(model: string): string {
  return model.replace(DOTTED_VERSION, "$1-$2");
}
