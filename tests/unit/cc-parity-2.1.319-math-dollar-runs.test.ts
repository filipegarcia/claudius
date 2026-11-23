import { describe, expect, test } from "vitest";

import { hasPathologicalDollarRuns, MAX_LONG_DOLLAR_RUNS } from "@/lib/shared/math-delimiters";

/**
 * CC 2.1.319 parity — "[VSCode] Fixed the chat panel slowing down while a
 * reply with many unclosed `$$` math fences, each shorter than the last,
 * streams in". Claudius's remark-math pass had the same super-linear cost
 * (measured: ~1s for an 80 KB reply of shrinking `$` runs vs ~30 ms without
 * math), re-run on every streaming delta. `Markdown` now renders such a
 * message without math.
 */
describe("hasPathologicalDollarRuns", () => {
  test("ordinary math, prices and the odd `$$$` are fine", () => {
    expect(hasPathologicalDollarRuns("Energy: $$E = mc^2$$ and \\(x\\) cost $5")).toBe(false);
    expect(hasPathologicalDollarRuns("$$\n\\int_0^1 x\\,dx\n$$\n".repeat(50))).toBe(false);
    expect(hasPathologicalDollarRuns("$$$ ".repeat(MAX_LONG_DOLLAR_RUNS))).toBe(false);
  });

  test("many long runs, each shorter than the last, trip the guard", () => {
    let t = "";
    for (let k = 60; k >= 3; k--) t += `${"$".repeat(k)} x `;
    expect(hasPathologicalDollarRuns(t)).toBe(true);
  });

  test("linear on a huge input", () => {
    const big = "$$$ a ".repeat(200_000);
    const start = performance.now();
    expect(hasPathologicalDollarRuns(big)).toBe(true);
    expect(hasPathologicalDollarRuns("x".repeat(1_000_000))).toBe(false);
    expect(performance.now() - start).toBeLessThan(500);
  });
});
