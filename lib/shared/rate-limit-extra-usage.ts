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
 *   "off" — extra usage is disabled or unavailable
 *   "used_up" — extra usage is on but spent for now (CC 2.1.329: out of
 *            credits, or the org's monthly limit reached)
 *   null  — the event carries no overage signal; say nothing rather than guess
 *
 * SDK 0.3.295 adds `overageEnabled`, the direct answer to "is extra usage on?".
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

export type ExtraUsageState = "on" | "off" | "used_up";

/** Structural subset of `SDKRateLimitInfo` (and Claudius' client mirror). */
export interface ExtraUsageInfo {
  rateLimitType?: string;
  overageStatus?: "allowed" | "allowed_warning" | "rejected";
  overageDisabledReason?: string;
  isUsingOverage?: boolean;
  overageInUse?: boolean;
  /** SDK 0.3.295 — whether the account has extra usage turned on. */
  overageEnabled?: boolean;
}

/**
 * `overageDisabledReason` values that mean the overage status couldn't be
 * read — not that extra usage is disabled. They don't count as an "off"
 * signal; the remaining fields decide (or nothing is said).
 */
const UNREADABLE_DISABLED_REASONS: ReadonlySet<string> = new Set(["fetch_error", "unknown"]);

/**
 * CC 2.1.329 — "Fixed `/usage` saying usage credits are off when they had run
 * out or reached the monthly limit". These reasons mean the credits are on
 * but spent for now (the engine words `org_level_disabled_until` as the
 * "org's monthly usage limit · resets …"), so they read "used_up", not "off".
 */
const USED_UP_DISABLED_REASONS: ReadonlySet<string> = new Set(["out_of_credits", "org_level_disabled_until"]);

export function extraUsageState(info: ExtraUsageInfo | null | undefined): ExtraUsageState | null {
  if (!info) return null;
  if (info.rateLimitType === "overage") return null;
  if (info.overageDisabledReason && !UNREADABLE_DISABLED_REASONS.has(info.overageDisabledReason)) {
    return USED_UP_DISABLED_REASONS.has(info.overageDisabledReason) ? "used_up" : "off";
  }
  // CC 2.1.329 — a rejected overage bucket on an account with credits turned
  // on means they ran out, not that they're off.
  if (info.overageStatus === "rejected") return info.overageEnabled === true ? "used_up" : "off";
  // SDK 0.3.295 — the explicit "extra usage turned on?" flag. `false` is an
  // off signal (wins over the weaker on-signals below); `true` is an on signal.
  if (info.overageEnabled === false) return "off";
  if (
    info.overageEnabled === true ||
    info.isUsingOverage === true ||
    info.overageInUse === true ||
    info.overageStatus === "allowed" ||
    info.overageStatus === "allowed_warning"
  ) {
    return "on";
  }
  return null;
}
