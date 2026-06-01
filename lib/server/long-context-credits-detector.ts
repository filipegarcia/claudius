/**
 * Detect whether an SDK assistant message carries the structured
 * `billing_error` signal — i.e. the Anthropic API rejected the request
 * because the account lacks credits / extra-usage. Used by `Session` to
 * fire the long-context credits-required nudge (Claude Code TUI parity:
 * "Extra usage is required for long context · run /usage-credits to turn
 * them on, or /model to switch to standard context").
 *
 * The SDK normalizes the underlying API error into the
 * `SDKAssistantMessageError` enum on the assistant message (see
 * `@anthropic-ai/claude-agent-sdk` `sdk.d.ts`); `'billing_error'` is the
 * machine-readable channel — far cleaner than text-matching the
 * synthetic "API Error: …" body. The caller decides whether to fire the
 * nudge based on session state (e.g. only when 1M-context is enabled).
 *
 * Pure + dependency-light so the matching can be unit-tested without
 * spinning up a Session.
 */

/**
 * True iff the SDK message is an assistant message carrying the
 * structured `billing_error` signal. Returns false for any other shape
 * (tool results, results, system events, plain assistant text).
 */
export function isBillingErrorSignal(sdkMessage: unknown): boolean {
  if (!sdkMessage || typeof sdkMessage !== "object") return false;
  const m = sdkMessage as { type?: string; error?: unknown };
  if (m.type !== "assistant") return false;
  return m.error === "billing_error";
}
