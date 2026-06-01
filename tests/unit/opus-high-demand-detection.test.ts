import { describe, expect, it } from "vitest";
import { isOpusHighDemandText } from "@/lib/client/use-session";
import type { DisplayBlock } from "@/lib/client/types";

const text = (t: string): DisplayBlock[] => [{ kind: "text", text: t }];

describe("isOpusHighDemandText", () => {
  it("matches the CLI's Opus-4 high-demand banner prose", () => {
    // Literal strings from the Claude Code TUI binary — both halves of the
    // banner mention "high demand for Opus 4" so the substring anchor catches
    // either the lead or a merged paragraph.
    expect(
      isOpusHighDemandText(
        text(
          "We are experiencing high demand for Opus 4. To continue immediately, use /model to switch to Sonnet and continue coding.",
        ),
      ),
    ).toBe(true);
    expect(isOpusHighDemandText(text("We are experiencing high demand for Opus 4."))).toBe(true);
    // Case-insensitive — the backend has flipped capitalisation in the past.
    expect(isOpusHighDemandText(text("we are experiencing High Demand for opus 4 right now"))).toBe(
      true,
    );
  });

  it("does not match normal assistant prose that merely mentions Opus or demand", () => {
    expect(
      isOpusHighDemandText(text("Opus 4 is a strong model for code-heavy workflows.")),
    ).toBe(false);
    expect(
      isOpusHighDemandText(text("There is high demand for this feature across the team.")),
    ).toBe(false);
    expect(isOpusHighDemandText(text("Switch to /model to pick a different model."))).toBe(false);
  });

  it("requires a pure-text message", () => {
    // A tool_use block alongside text means it's a real turn, not the banner.
    const mixed: DisplayBlock[] = [
      { kind: "text", text: "We are experiencing high demand for Opus 4." },
      { kind: "tool_use", id: "t1", name: "Bash", input: {} },
    ];
    expect(isOpusHighDemandText(mixed)).toBe(false);
    expect(isOpusHighDemandText([])).toBe(false);
  });
});
