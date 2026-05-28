import { describe, expect, it } from "vitest";
import { isRateLimitHitText, rateLimitTypeFromText } from "@/lib/client/use-session";
import type { DisplayBlock } from "@/lib/client/types";

const text = (t: string): DisplayBlock[] => [{ kind: "text", text: t }];

describe("isRateLimitHitText", () => {
  it("matches the CLI hard-limit prose (the replay signal)", () => {
    // The SDK strips `error` on the replay/pagination paths, leaving only this
    // text — see the fixture captured from a real session.
    expect(isRateLimitHitText(text("You've hit your session limit · resets 8:10pm (Europe/Berlin)"))).toBe(true);
    // Curly apostrophe + other tier labels the CLI renders.
    expect(isRateLimitHitText(text("You’ve hit your weekly limit"))).toBe(true);
    expect(isRateLimitHitText(text("You've hit your 5-hour limit · resets 7:38 PM"))).toBe(true);
    expect(isRateLimitHitText(text("You've hit your monthly spend limit"))).toBe(true);
  });

  it("does not match normal assistant prose that merely mentions limits", () => {
    expect(isRateLimitHitText(text("Let me check whether we hit your rate limit earlier."))).toBe(false);
    expect(isRateLimitHitText(text("The function enforces a 5-hour limit on the cache."))).toBe(false);
    expect(isRateLimitHitText(text("You've reached the end of the file."))).toBe(false);
  });

  it("requires a pure-text message anchored at the start", () => {
    // Leading whitespace is tolerated (we trim), ...
    expect(isRateLimitHitText(text("  You've hit your session limit"))).toBe(true);
    // ... but a tool_use block alongside text means it's a real turn, not a wall.
    const mixed: DisplayBlock[] = [
      { kind: "text", text: "You've hit your session limit" },
      { kind: "tool_use", id: "t1", name: "Bash", input: {} },
    ];
    expect(isRateLimitHitText(mixed)).toBe(false);
    expect(isRateLimitHitText([])).toBe(false);
  });
});

describe("rateLimitTypeFromText", () => {
  it("maps prose labels onto SDK rate-limit tiers", () => {
    expect(rateLimitTypeFromText("You've hit your session limit · resets 8:10pm")).toBe("five_hour");
    expect(rateLimitTypeFromText("You've hit your weekly limit")).toBe("seven_day");
    expect(rateLimitTypeFromText("You've hit your weekly Opus limit")).toBe("seven_day_opus");
    expect(rateLimitTypeFromText("You've hit your weekly Sonnet limit")).toBe("seven_day_sonnet");
  });

  it("returns undefined for an unrecognized label (panel falls back to generic copy)", () => {
    expect(rateLimitTypeFromText("You've hit your usage limit")).toBeUndefined();
    expect(rateLimitTypeFromText("You've hit your monthly spend limit")).toBeUndefined();
  });
});
