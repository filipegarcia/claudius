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
 *
 * CC 2.1.323: a model that runs only on usage credits ("<Model> requires
 * usage credits.") comes first → `model-needs-credits` (turn on usage
 * credits + the upgrade links, or the contact-admin line when the seat can't
 * buy them).
 */
export type RateLimitCtaKind =
  | "model-needs-credits"
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
  modelNeedsCredits?: string;
}): RateLimitCtaKind {
  if (hit.modelNeedsCredits) return "model-needs-credits";
  if (hit.errorCode === "credits_required") {
    return hit.canUserPurchaseCredits !== false ? "buy-credits" : "contact-admin-credits";
  }
  if (hit.limitScope === "group_pool") return "contact-admin-pool";
  if (hit.subscriptionType === "team" || hit.subscriptionType === "enterprise") return "usage-credits";
  return "upgrade";
}

/**
 * CC 2.1.301 ([VSCode] "Added a 'Get more usage' link to the usage-limit
 * banner for Pro and Max plans"). Pro and Max can keep going past a limit by
 * buying extra usage — the CLI's own limit line reads "/upgrade or
 * /usage-credits to finish what you're working on". The upgrade links alone
 * told a Max user to upgrade to the plan they already have. Unknown tier
 * (no `plan_usage` yet) keeps the old upgrade-only row.
 */
export function offersGetMoreUsage(subscriptionType: string | null | undefined): boolean {
  return subscriptionType === "pro" || subscriptionType === "max";
}
