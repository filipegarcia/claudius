/**
 * CC 2.1.295 parity — "Improved headless rate_limit_event usage-limit
 * warnings to say whether the account has extra usage turned on".
 *
 * Claudius renders its own copy for `rate_limit_event`s (RateLimitPill in
 * `components/chat/SystemPill.tsx`). Before this, a soft `allowed_warning`
 * pill never said what happens when the limit is actually hit — whether the
 * session will roll onto extra usage (overage) or simply pause. This helper
 * collapses the overage fields of `SDKRateLimitInfo` into a single tri-state
 * the pill can phrase:
 *
 *   "on"  — extra usage is enabled / already being drawn from
 *   "off" — extra usage is disabled, unavailable, or exhausted
 *   null  — the event carries no overage signal; say nothing rather than guess
 *
 * Precedence: "off" signals win over "on" signals. The line answers "will I
 * keep going after this limit?", and an exhausted overage bucket
 * (`overageStatus: 'rejected'`) or an explicit `overageDisabledReason` means
 * no — even if `isUsingOverage` is still true from earlier in the window.
 * The `fetch_error` / `unknown` reasons are the exception: they say the status
 * couldn't be read, so they fall through to the other fields.
 *
 * A warning about the extra-usage limit itself (`rateLimitType: 'overage'`)
 * returns null: "you'll keep going on extra usage after this limit" would be
 * wrong when *this* is the extra-usage limit.
 */

export type ExtraUsageState = "on" | "off";

/** Structural subset of `SDKRateLimitInfo` (and Claudius' client mirror). */
export interface ExtraUsageInfo {
  rateLimitType?: string;
  overageStatus?: "allowed" | "allowed_warning" | "rejected";
  overageDisabledReason?: string;
  isUsingOverage?: boolean;
  overageInUse?: boolean;
}

/**
 * `overageDisabledReason` values that mean the overage status couldn't be
 * read — not that extra usage is disabled. They don't count as an "off"
 * signal; the remaining fields decide (or nothing is said).
 */
const UNREADABLE_DISABLED_REASONS: ReadonlySet<string> = new Set(["fetch_error", "unknown"]);

export function extraUsageState(info: ExtraUsageInfo | null | undefined): ExtraUsageState | null {
  if (!info) return null;
  if (info.rateLimitType === "overage") return null;
  if (info.overageDisabledReason && !UNREADABLE_DISABLED_REASONS.has(info.overageDisabledReason)) {
    return "off";
  }
  if (info.overageStatus === "rejected") return "off";
  if (
    info.isUsingOverage === true ||
    info.overageInUse === true ||
    info.overageStatus === "allowed" ||
    info.overageStatus === "allowed_warning"
  ) {
    return "on";
  }
  return null;
}
