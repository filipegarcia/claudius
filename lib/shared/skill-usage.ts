/**
 * CC 2.1.261 (H4) — the "unused skills" half of `/skill-doctor`. The SDK's
 * experimental usage API returns `behaviors.week.skills[{name, pct}]` (the
 * skills invoked across local transcripts in the last 7 days). A locally
 * present skill whose name isn't in that list hasn't been used this week — the
 * prune candidate the doctor flags alongside its context cost.
 *
 * Pure + dependency-free so the extraction/comparison is unit-testable.
 */

/**
 * Extract the names of skills used in the last 7 days from an experimental
 * usage response (`behaviors.week.skills[].name` with pct > 0). Defensive:
 * any unexpected shape yields `[]`.
 */
export function extractWeeklyUsedSkills(usageData: unknown): string[] {
  const week = (usageData as { behaviors?: { week?: { skills?: unknown } } } | null)?.behaviors?.week;
  const skills = week?.skills;
  if (!Array.isArray(skills)) return [];
  const out: string[] = [];
  for (const s of skills) {
    if (s && typeof s === "object") {
      const name = (s as { name?: unknown; pct?: unknown }).name;
      const pct = (s as { pct?: unknown }).pct;
      // pct is 0-100; treat a present name with pct > 0 as "used". A missing
      // pct still counts as used (the name appearing at all is the signal).
      if (typeof name === "string" && name && (typeof pct !== "number" || pct > 0)) {
        out.push(name);
      }
    }
  }
  return out;
}

/**
 * True when `skillName` is NOT among the weekly-used set (case-insensitive).
 * Callers only consult this when the usage signal is actually available —
 * a `null`/absent set means "unknown", not "unused".
 */
export function isSkillUnusedThisWeek(skillName: string, weeklyUsed: readonly string[]): boolean {
  const lower = skillName.toLowerCase();
  return !weeklyUsed.some((u) => u.toLowerCase() === lower);
}
