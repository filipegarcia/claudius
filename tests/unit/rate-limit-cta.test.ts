import { describe, expect, test } from "vitest";
import { rateLimitCtaKind } from "@/lib/client/rate-limit-cta";

/**
 * CC 2.1.284 (E9) — the usage-limit panel drops the personal upgrade links for
 * Team/Enterprise and points at usage credits; existing credits/pool paths win
 * over it.
 */
describe("rateLimitCtaKind (E9)", () => {
  test("credits_required → buy, or contact-admin when the seat can't purchase", () => {
    expect(rateLimitCtaKind({ errorCode: "credits_required" })).toBe("buy-credits");
    expect(rateLimitCtaKind({ errorCode: "credits_required", canUserPurchaseCredits: false })).toBe(
      "contact-admin-credits",
    );
  });

  test("a shared group-pool denial → contact-admin", () => {
    expect(rateLimitCtaKind({ limitScope: "group_pool" })).toBe("contact-admin-pool");
  });

  test("Team/Enterprise → usage credits, NOT upgrade links", () => {
    expect(rateLimitCtaKind({ subscriptionType: "team" })).toBe("usage-credits");
    expect(rateLimitCtaKind({ subscriptionType: "enterprise" })).toBe("usage-credits");
  });

  test("Pro/Max/unknown → the upgrade links", () => {
    expect(rateLimitCtaKind({ subscriptionType: "pro" })).toBe("upgrade");
    expect(rateLimitCtaKind({ subscriptionType: "max" })).toBe("upgrade");
    expect(rateLimitCtaKind({})).toBe("upgrade");
  });

  test("credits/pool precedence beats the tier check", () => {
    // Even an enterprise seat with a credits_required error buys credits first.
    expect(rateLimitCtaKind({ errorCode: "credits_required", subscriptionType: "enterprise" })).toBe(
      "buy-credits",
    );
    expect(rateLimitCtaKind({ limitScope: "group_pool", subscriptionType: "team" })).toBe(
      "contact-admin-pool",
    );
  });
});
