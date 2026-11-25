import { describe, expect, test } from "vitest";
import { RESUME_GAP_NOTICE } from "@/lib/server/session-resume";
import { isEngineResumeGapNotice, resumeGapNotice } from "@/lib/shared/resume-gap-notice";

/**
 * CC 2.1.329 — "Fixed the line about earlier messages on resume blaming a
 * damaged file when the file was intact".
 * CC 2.1.332 — "Added a notice in VS Code and Desktop's Code tab when a
 * resumed session's earlier messages weren't loaded".
 */
describe("resume-gap notice wording (2.1.329)", () => {
  test("is the engine's line, which names no cause", () => {
    expect(RESUME_GAP_NOTICE).toBe(
      "Earlier messages in this session weren't loaded. Claude won't see them, so repeat anything it still needs.",
    );
    expect(RESUME_GAP_NOTICE).not.toMatch(/damaged|missing|file/i);
  });

  test("the dated lead matches the engine's cut-off variant", () => {
    expect(resumeGapNotice("Messages in this session from before 3:04 PM")).toBe(
      "Messages in this session from before 3:04 PM weren't loaded. Claude won't see them, so repeat anything it still needs.",
    );
  });
});

describe("isEngineResumeGapNotice (2.1.332 dedupe)", () => {
  const info = (content: unknown) => ({ type: "system", subtype: "informational", level: "warning", content });

  test("matches the engine's line in both wordings", () => {
    expect(isEngineResumeGapNotice(info(RESUME_GAP_NOTICE))).toBe(true);
    expect(isEngineResumeGapNotice(info(resumeGapNotice("Messages in this session from before Nov 3, 2026")))).toBe(true);
  });

  test("leaves every other message alone", () => {
    expect(isEngineResumeGapNotice(info("Hook blocked the prompt."))).toBe(false);
    expect(isEngineResumeGapNotice(info(undefined))).toBe(false);
    expect(
      isEngineResumeGapNotice({ type: "assistant", subtype: "informational", content: RESUME_GAP_NOTICE }),
    ).toBe(false);
    expect(isEngineResumeGapNotice({ type: "system", subtype: "init", content: RESUME_GAP_NOTICE })).toBe(false);
    // Same tail, different subject: not the resume line.
    expect(
      isEngineResumeGapNotice(info("Some skills weren't loaded. Claude won't see them, so repeat anything it still needs.")),
    ).toBe(false);
    expect(isEngineResumeGapNotice(null)).toBe(false);
  });
});
