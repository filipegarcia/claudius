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
