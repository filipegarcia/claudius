import { describe, expect, test } from "vitest";
import { INSTALL_REFRESH_DELAYS_MS } from "@/lib/client/usePlugins";

/**
 * CC 2.1.268 (G7) — after dispatching `/plugin install`, the list auto-refreshes
 * on a bounded, increasing schedule so a newly installed plugin appears without
 * a manual Refresh (the SDK registers it asynchronously during the chat turn).
 */
describe("INSTALL_REFRESH_DELAYS_MS (G7)", () => {
  test("is a non-empty, strictly increasing, bounded schedule", () => {
    expect(INSTALL_REFRESH_DELAYS_MS.length).toBeGreaterThan(0);
    for (let i = 1; i < INSTALL_REFRESH_DELAYS_MS.length; i++) {
      expect(INSTALL_REFRESH_DELAYS_MS[i]).toBeGreaterThan(INSTALL_REFRESH_DELAYS_MS[i - 1]);
    }
    // Every delay is a sane positive, capped value (no runaway polling).
    for (const d of INSTALL_REFRESH_DELAYS_MS) {
      expect(d).toBeGreaterThan(0);
      expect(d).toBeLessThanOrEqual(30_000);
    }
  });
});
