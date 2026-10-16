import { describe, expect, test } from "vitest";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { offersGetMoreUsage, rateLimitCtaKind } from "@/lib/client/rate-limit-cta";
import { GET_MORE_USAGE_URL, RateLimitUpgradeLinks } from "@/components/chat/RateLimitHitPanel";

/**
 * CC 2.1.301 ([VSCode] "Added a 'Get more usage' link to the usage-limit
 * banner for Pro and Max plans").
 */
describe("Get more usage (Pro/Max)", () => {
  test("offered to Pro and Max only", () => {
    expect(offersGetMoreUsage("pro")).toBe(true);
    expect(offersGetMoreUsage("max")).toBe(true);
    for (const t of ["team", "enterprise", null, undefined, ""]) expect(offersGetMoreUsage(t)).toBe(false);
  });

  test("Pro/Max still take the upgrade branch (the link is added, nothing removed)", () => {
    expect(rateLimitCtaKind({ subscriptionType: "max" })).toBe("upgrade");
    expect(rateLimitCtaKind({ subscriptionType: "pro" })).toBe("upgrade");
  });

  test("the shared links row leads with Get more usage for Max and keeps the upgrade links", () => {
    const html = renderToStaticMarkup(createElement(RateLimitUpgradeLinks, { subscriptionType: "max" }));
    expect(html).toContain('data-testid="rate-limit-get-more-usage-link"');
    expect(html).toContain(`href="${GET_MORE_USAGE_URL}"`);
    expect(html.indexOf("Get more usage")).toBeLessThan(html.indexOf("Upgrade your plan"));
    expect(html).toContain("Upgrade to Team plan");
  });

  test("unknown tier keeps the upgrade-only row", () => {
    const html = renderToStaticMarkup(createElement(RateLimitUpgradeLinks));
    expect(html).not.toContain("Get more usage");
    expect(html).toContain("Upgrade your plan");
  });
});
