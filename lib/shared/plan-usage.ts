/**
 * CC 2.1.236 — normalize `get_usage`'s `rate_limits.extra_usage` (usage
 * credits) from the SDK's snake_case shape into the camelCase form the
 * `PlanUsageEvent`/`PlanRateLimits` carry. Returns null when absent. Pure, so
 * the server mapping is unit-testable without a live session.
 */
export type ExtraUsageRaw = {
  is_enabled: boolean;
  monthly_limit?: number | null;
  used_credits?: number | null;
  utilization?: number | null;
  currency?: string | null;
} | null | undefined;

export type ExtraUsage = {
  isEnabled: boolean;
  monthlyLimit: number | null;
  usedCredits: number | null;
  utilization: number | null;
  currency: string | null;
};

/**
 * CC 2.1.329 — `monthly_limit` / `used_credits` are minor units of `currency`
 * (cents for USD): the SDK documents it on `SDKUsageReport.extra_usage`, and
 * the CLI's own `/usage` row divides by 100 except for the zero-decimal
 * currencies below. Claudius printed the raw number as dollars (100× too high).
 */
const ZERO_DECIMAL_CURRENCIES: ReadonlySet<string> = new Set(["JPY", "KRW", "VND"]);

export function creditsToMajorUnits(amount: number, currency: string | null | undefined): number {
  return ZERO_DECIMAL_CURRENCIES.has((currency ?? "USD").toUpperCase()) ? amount : amount / 100;
}

/**
 * CC 2.1.329 — "is_enabled is false while extra usage cannot cover sends", so
 * the flag also drops when the monthly limit is reached. True for that case,
 * where `/cost` keeps the row (captioned as reached) instead of hiding it.
 */
export function extraUsageAtMonthlyLimit(eu: ExtraUsage | null | undefined): boolean {
  if (!eu || eu.isEnabled) return false;
  return eu.monthlyLimit !== null && eu.usedCredits !== null && eu.usedCredits >= eu.monthlyLimit;
}

export function normalizeExtraUsage(raw: ExtraUsageRaw): ExtraUsage | null {
  if (!raw) return null;
  return {
    isEnabled: raw.is_enabled,
    monthlyLimit: raw.monthly_limit ?? null,
    usedCredits: raw.used_credits ?? null,
    utilization: raw.utilization ?? null,
    currency: raw.currency ?? null,
  };
}
