import { describe, expect, test } from "vitest";
import { formatElapsed } from "@/lib/client/use-elapsed";

/**
 * CC 2.1.210 parity — "live elapsed-time counter on the collapsed tool
 * summary line". `formatElapsed` is the pure formatter behind ToolCall's
 * ticking badge (`useElapsedSeconds` drives the 1Hz re-render; that part
 * needs a DOM/timer harness, so it's covered by the Playwright spec —
 * this test locks down the pure formatting logic).
 */
describe("formatElapsed", () => {
  test("under a minute renders as seconds", () => {
    expect(formatElapsed(0)).toBe("0s");
    expect(formatElapsed(45)).toBe("45s");
    expect(formatElapsed(59)).toBe("59s");
  });

  test("under an hour renders as minutes and seconds", () => {
    expect(formatElapsed(60)).toBe("1m 0s");
    expect(formatElapsed(83)).toBe("1m 23s");
    expect(formatElapsed(3599)).toBe("59m 59s");
  });

  test("an hour or more renders as hours and minutes", () => {
    expect(formatElapsed(3600)).toBe("1h 0m");
    expect(formatElapsed(3725)).toBe("1h 2m");
    expect(formatElapsed(7384)).toBe("2h 3m");
  });
});
