import { describe, expect, test } from "vitest";
import { rateLimitHitFromBlocks } from "@/lib/client/use-session";
import { isTopPlan, rateLimitCtaKind } from "@/lib/client/rate-limit-cta";
import { matchesUsageLimitPrefix, modelRequiringCreditsFromText } from "@/lib/shared/rate-limit-prefixes";

/**
 * CC 2.1.323 — "Added an options menu (stop, switch to usage credits,
 * upgrade) when a model needs usage credits that are turned off or used up".
 * The engine's headless text is "<Model> requires usage credits."; Claudius's
 * limit panel used to read it as a plan window ("weekly Opus limit") with an
 * unrelated reset clock.
 */
const block = (text: string) => [{ kind: "text" as const, text }];

describe("modelRequiringCreditsFromText", () => {
  test("names the model", () => {
    expect(modelRequiringCreditsFromText("Fable 5.2 requires usage credits. Turn them on in Settings.")).toBe("Fable 5.2");
    expect(modelRequiringCreditsFromText("Opus 5 requires usage credits.")).toBe("Opus 5");
    expect(modelRequiringCreditsFromText("Fable requires usage credits.")).toBe("Fable");
  });
  test("ignores other text", () => {
    expect(modelRequiringCreditsFromText("You've hit your weekly limit · resets 9pm")).toBeNull();
    expect(modelRequiringCreditsFromText("Note: Opus 5 requires usage credits.")).toBeNull();
  });
  test("stays in sync with the limit-hit detector", () => {
    expect(matchesUsageLimitPrefix("Fable 5.2 requires usage credits.")).toBe(true);
  });
});

describe("rateLimitHitFromBlocks — model needs credits", () => {
  test("no tier, reset or fallback; keeps purchase + plan signals", () => {
    const hit = rateLimitHitFromBlocks(
      block("Opus 5 requires usage credits."),
      { rateLimitType: "five_hour", resetsAt: 1_900_000_000, canUserPurchaseCredits: true } as never,
      "claude-sonnet-5-5",
      "max",
    );
    expect(hit).toEqual({ modelNeedsCredits: "Opus 5", canUserPurchaseCredits: true, subscriptionType: "max" });
    expect(rateLimitCtaKind(hit)).toBe("model-needs-credits");
  });

  test("an ordinary limit is unchanged", () => {
    const hit = rateLimitHitFromBlocks(block("You've hit your weekly Opus limit"), null, "claude-sonnet-5-5", null);
    expect(hit.modelNeedsCredits).toBeUndefined();
    expect(hit.rateLimitType).toBe("seven_day_opus");
    expect(rateLimitCtaKind(hit)).toBe("upgrade");
  });
});

describe("isTopPlan (model-needs-credits upgrade links)", () => {
  test("Team and Enterprise get no upgrade links; Pro, Max and unknown do", () => {
    expect(isTopPlan("team")).toBe(true);
    expect(isTopPlan("enterprise")).toBe(true);
    for (const t of ["pro", "max", null, undefined]) expect(isTopPlan(t), String(t)).toBe(false);
  });
});
