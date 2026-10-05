import { describe, expect, test } from "vitest";
import { extractWeeklyUsedSkills, isSkillUnusedThisWeek } from "@/lib/shared/skill-usage";

/**
 * CC 2.1.261 (H4) — "unused (7d)" skills from the usage API's weekly behaviors.
 */
describe("extractWeeklyUsedSkills (H4)", () => {
  test("pulls names from behaviors.week.skills with pct > 0", () => {
    const usage = {
      behaviors: {
        week: { skills: [{ name: "pdf", pct: 42 }, { name: "docx", pct: 3 }] },
        day: { skills: [{ name: "other", pct: 10 }] },
      },
    };
    expect(extractWeeklyUsedSkills(usage).sort()).toEqual(["docx", "pdf"]);
  });

  test("drops zero-pct entries but keeps a name with no pct", () => {
    const usage = { behaviors: { week: { skills: [{ name: "a", pct: 0 }, { name: "b" }] } } };
    expect(extractWeeklyUsedSkills(usage)).toEqual(["b"]);
  });

  test("defensive: unexpected shapes → []", () => {
    expect(extractWeeklyUsedSkills(null)).toEqual([]);
    expect(extractWeeklyUsedSkills({})).toEqual([]);
    expect(extractWeeklyUsedSkills({ behaviors: { week: {} } })).toEqual([]);
    expect(extractWeeklyUsedSkills({ behaviors: { week: { skills: "nope" } } })).toEqual([]);
  });
});

describe("isSkillUnusedThisWeek (H4)", () => {
  test("case-insensitive membership", () => {
    expect(isSkillUnusedThisWeek("PDF", ["pdf", "docx"])).toBe(false);
    expect(isSkillUnusedThisWeek("xlsx", ["pdf", "docx"])).toBe(true);
    expect(isSkillUnusedThisWeek("anything", [])).toBe(true);
  });
});
