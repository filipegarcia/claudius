/**
 * Which call-to-action the `RateLimitHitPanel` shows for a hard rate-limit
 * hit. Pure (React-free) so the branching is unit-testable.
 *
 * Precedence:
 *  - `credits_required` → buy credits (or contact-admin when the seat can't
 *    purchase);
 *  - a shared group-pool denial → contact-admin (upgrading a personal plan
 *    wouldn't refill a shared pool);
 *  - CC 2.1.284: a Team/Enterprise account is already top-tier, so point at
 *    usage credits rather than the personal "Upgrade your plan/Team" links;
 *  - otherwise (Pro/Max/unknown) → the upgrade links.
 */
export type RateLimitCtaKind =
  | "buy-credits"
  | "contact-admin-credits"
  | "contact-admin-pool"
  | "usage-credits"
  | "upgrade";

export function rateLimitCtaKind(hit: {
  errorCode?: string;
  canUserPurchaseCredits?: boolean;
  limitScope?: string;
  subscriptionType?: string;
}): RateLimitCtaKind {
  if (hit.errorCode === "credits_required") {
    return hit.canUserPurchaseCredits !== false ? "buy-credits" : "contact-admin-credits";
  }
  if (hit.limitScope === "group_pool") return "contact-admin-pool";
  if (hit.subscriptionType === "team" || hit.subscriptionType === "enterprise") return "usage-credits";
  return "upgrade";
}
