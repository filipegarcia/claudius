import { describe, expect, test } from "vitest";

import { shouldResetHighlight } from "@/lib/shared/picker-highlight";

/**
 * CC 2.1.331 parity — "[VSCode] Fixed the command menu keeping an earlier
 * match highlighted while you type more in its filter, so Enter could run the
 * wrong row". The composer menus reset their highlight on a filter change,
 * not only on a row-count change.
 */
describe("shouldResetHighlight (CC 2.1.331)", () => {
  test("typing more resets the highlight even when the capped list stays full", () => {
    // The slash menu shows at most 16 rows: "/co" → "/com" is still 16.
    expect(shouldResetHighlight({ filter: "co", count: 16 }, { filter: "com", count: 16 })).toBe(true);
  });

  test("a changed row count still resets, as before", () => {
    expect(shouldResetHighlight({ filter: "co", count: 16 }, { filter: "co", count: 3 })).toBe(true);
  });

  test("a re-render with the same filter and rows keeps the user's highlight", () => {
    expect(shouldResetHighlight({ filter: "com", count: 16 }, { filter: "com", count: 16 })).toBe(false);
  });

  test("deleting a character is a filter change too", () => {
    expect(shouldResetHighlight({ filter: "com", count: 16 }, { filter: "co", count: 16 })).toBe(true);
  });
});
