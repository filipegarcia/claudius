/**
 * Single source of truth for "why is fast mode off/unavailable" copy.
 *
 * SDK 0.3.219 added `fast_mode_disabled_reason` to the `result` and
 * `system:init` messages (`FastModeDisabledReason` in
 * `node_modules/@anthropic-ai/claude-agent-sdk/sdk.d.ts`), closing a gap the
 * FastModeNoticePanel used to call out explicitly: previously
 * `FastModeState` was the bare `'off' | 'cooldown' | 'on'` with no reason
 * attached, so the cooldown toast and the StatusLine chip could only ever
 * say "temporarily unavailable" — never *why*.
 *
 * The reason list is an open set on the SDK side (it may grow), so callers
 * should treat this as "labels for the reasons we know about today" and
 * fall back to a neutral message for anything unrecognized — see
 * `parseInitSystemMessage`'s "tolerant of schema drift" contract, which
 * this mirrors.
 */

import { canonicalModelId } from "./advisor";

/** Verbatim from `FastModeDisabledReason` in sdk.d.ts, kept here as a type-only mirror. */
export type FastModeDisabledReason =
  | "free"
  | "preference"
  | "extra_usage_disabled"
  | "network_error"
  | "unknown"
  | "not_first_party"
  | "disabled_by_env"
  | "model_not_allowed"
  | "sdk_opt_in_required"
  | "pending";

/** Short, human-readable explanation for each known reason. */
const FAST_MODE_DISABLED_REASON_LABELS: Record<FastModeDisabledReason, string> = {
  free: "Your plan doesn't include fast mode.",
  preference: "Fast mode is turned off in your preferences.",
  extra_usage_disabled: "Extra usage is disabled, and fast mode requires it.",
  network_error: "Fast mode is unavailable — a network error reaching the fast-mode backend.",
  unknown: "Fast mode is unavailable for an unspecified reason.",
  not_first_party: "Fast mode isn't available on this provider.",
  disabled_by_env: "Fast mode is disabled by your environment configuration.",
  model_not_allowed: "Fast mode isn't available for the current model.",
  sdk_opt_in_required: "Fast mode requires an SDK opt-in that hasn't been set.",
  pending: "Fast mode availability is still being determined.",
};

const KNOWN_REASONS = new Set<string>(Object.keys(FAST_MODE_DISABLED_REASON_LABELS));

/**
 * Best-effort human copy for a raw `fast_mode_disabled_reason` string.
 * Unknown/absent values (a future SDK reason we don't have a label for yet,
 * or `undefined`) fall back to the pre-0.3.219 neutral wording rather than
 * throwing or rendering a raw enum token.
 */
export function fastModeDisabledReasonLabel(raw: string | null | undefined): string {
  if (raw && KNOWN_REASONS.has(raw)) {
    return FAST_MODE_DISABLED_REASON_LABELS[raw as FastModeDisabledReason];
  }
  return "Fast mode is temporarily unavailable.";
}

/**
 * CC 2.1.300 — the `system/notification` key the engine emits when fast mode
 * is refused because usage credits ran out (`out_of_credits`,
 * `org_spend_cap_reached`, `org_level_disabled_until`). Verbatim from the
 * engine bundled with SDK 0.3.300 (Claude Code 2.1.300); the notice shape
 * `{type, subtype, key, text, priority, color}` is `SDKNotificationMessage`
 * in sdk.d.ts. Older engines never send it, so this is a no-op there.
 */
export const FAST_MODE_CREDITS_REJECTED_KEY = "fast-mode-overage-rejected";

/**
 * CC 2.1.300 parity — "[VSCode] Fixed fast mode staying on after usage
 * credits ran out, which made each request be refused and re-sent; it now
 * turns off until you turn it back on, with an error notice".
 *
 * On a credit-exhaustion rejection the engine retries that one request
 * without fast mode and emits this notice, but leaves the session's fast
 * flag on. Only the terminal REPL's own listener turns it off, which is why
 * the upstream fix shipped in the VS Code host rather than the engine. An
 * SDK host like Claudius has to do the same, or every following request is
 * refused and re-sent. Shared by the server (which turns fast off, even with
 * no tab open) and the client (which flips its toggle mirror).
 */
export function isFastModeCreditsRejectedNotice(msg: unknown): boolean {
  if (!msg || typeof msg !== "object") return false;
  const m = msg as { type?: unknown; subtype?: unknown; key?: unknown };
  return m.type === "system" && m.subtype === "notification" && m.key === FAST_MODE_CREDITS_REJECTED_KEY;
}

/**
 * CC 2.1.316 parity — "Deprecated fast mode for Opus 4.8 as of October 30,
 * 2026; it will be removed on November 30, 2026…Migrate to Opus 5.5 to keep
 * the speedup".
 *
 * The 2.1.316 engine emits a `system/notification` with this key (priority
 * `immediate`, color `warning`) when fast mode is turned ON on Opus 4.8, but
 * only from its own `/fast` command / TUI picker. Claudius's picker toggles
 * fast through `applyFlagSettings`, which never emits it, so the client
 * raises the same text itself. The key lets the transcript skip the engine's
 * copy while Claudius's own notice is showing.
 */
export const OPUS48_FAST_DEPRECATION_KEY = "opus48-fast-mode-deprecation";

/**
 * The pill tone for a `system/notification`: its `color` when the engine
 * sends `warning` / `error`, else `undefined` (toned by priority). The Opus
 * 4.8 deprecation is a warning (amber) even when it arrives without a color
 * — its `immediate` priority alone would render it red.
 */
export function notificationColor(msg: { key?: unknown; color?: unknown }): "warning" | "error" | undefined {
  if (msg.color === "warning" || msg.color === "error") return msg.color;
  if (msg.key === OPUS48_FAST_DEPRECATION_KEY) return "warning";
  return undefined;
}

/** Removal date — the engine's `tengu_sunset_penguin_opus48` flag default. */
export const OPUS48_FAST_REMOVAL_ISO = "2026-11-30";

/** Claudius's call to action under the engine's text. */
export const OPUS48_FAST_MIGRATE_HINT = "Switch to Opus 5.5 to keep the speedup.";

/**
 * The engine's notice text for turning fast mode on with `model`, or `null`
 * when it doesn't apply: anything that isn't Opus 4.8 once canonicalized
 * (`[1m]` tags, date suffixes, Bedrock / Vertex wrappers all reduce to
 * `claude-opus-4-8`), or at/after the removal instant. A bare alias like
 * `opus` can't be told apart here (it resolves to Opus 5.5 today), so pass
 * the catalog row's `resolvedModel` when there is one.
 */
export function opus48FastDeprecationText(
  model: string | null | undefined,
  now: number = Date.now(),
): string | null {
  if (canonicalModelId(model) !== "claude-opus-4-8") return null;
  const removal = Date.parse(OPUS48_FAST_REMOVAL_ISO);
  if (Number.isNaN(removal) || now >= removal) return null;
  const date = new Date(removal).toLocaleDateString("en-US", {
    month: "short",
    day: "numeric",
    timeZone: "UTC",
  });
  return `Opus 4.8 fast mode is deprecated and will be removed on ${date}`;
}
