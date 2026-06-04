import { describe, expect, it } from "vitest";
import {
  extractUserPromptText,
  isRealUserPrompt,
  splitLeadingSystemReminders,
  stripSystemReminders,
} from "@/lib/shared/user-prompt";

// The exact reminder shape `Session` queues via `wrapReminder` in
// `lib/server/system-reminders.ts`. Trailing `\n\n` matters: stacked
// reminders concatenate clean against the next block / user text.
function reminder(body: string): string {
  return `<system-reminder>\n${body}\n</system-reminder>\n\n`;
}

const TODOS_BODY =
  "The current to-do list for this session is shown below. As you work, " +
  "keep it aligned with reality…";

describe("splitLeadingSystemReminders", () => {
  it("peels one leading block off and returns the body + the user's prompt", () => {
    const raw = reminder(TODOS_BODY) + "real user prompt";
    const r = splitLeadingSystemReminders(raw);
    expect(r.reminders).toEqual([TODOS_BODY]);
    expect(r.rest).toBe("real user prompt");
  });

  it("peels multiple stacked blocks in order", () => {
    const raw =
      reminder("todos body") +
      reminder("stale task tools body") +
      "follow-up question";
    const r = splitLeadingSystemReminders(raw);
    expect(r.reminders).toEqual(["todos body", "stale task tools body"]);
    expect(r.rest).toBe("follow-up question");
  });

  it("is a no-op when no wrapper is present", () => {
    const plain = "just a normal prompt with <not-a-reminder> tags inside";
    const r = splitLeadingSystemReminders(plain);
    expect(r.reminders).toEqual([]);
    expect(r.rest).toBe(plain);
  });

  it("only strips a leading wrapper, not one mid-message", () => {
    const text = "do the thing <system-reminder>x</system-reminder> mentioned above";
    const r = splitLeadingSystemReminders(text);
    expect(r.reminders).toEqual([]);
    expect(r.rest).toBe(text);
  });

  it("handles leading whitespace before the wrapper", () => {
    const raw = `\n  ${reminder("g")}real prompt`;
    const r = splitLeadingSystemReminders(raw);
    expect(r.reminders).toEqual(["g"]);
    expect(r.rest).toBe("real prompt");
  });

  it("returns trimmed bodies (the wrap shape carries \\n inside the tag)", () => {
    const raw = "<system-reminder>\n  padded body  \n</system-reminder>\n\nx";
    const r = splitLeadingSystemReminders(raw);
    expect(r.reminders).toEqual(["padded body"]);
  });
});

describe("stripSystemReminders", () => {
  it("returns only the residual user text", () => {
    const raw = reminder(TODOS_BODY) + "real user prompt";
    expect(stripSystemReminders(raw)).toBe("real user prompt");
  });

  it("is a no-op without a wrapper", () => {
    expect(stripSystemReminders("just text")).toBe("just text");
  });
});

describe("extractUserPromptText with system-reminders", () => {
  it("returns the clean prompt for a reminder-prefixed message", () => {
    const raw = reminder(TODOS_BODY) + "follow-up";
    expect(extractUserPromptText(raw)).toBe("follow-up");
    expect(extractUserPromptText([{ type: "text", text: raw }])).toBe("follow-up");
  });

  it("returns null when the entire body is reminder wrappers (pin walk skips)", () => {
    // Should never happen in practice — the server always prepends to user
    // text — but if the user prompt is empty by some path we don't want the
    // bubble pinned as the "last real prompt."
    const raw = reminder(TODOS_BODY);
    expect(extractUserPromptText(raw)).toBeNull();
    expect(isRealUserPrompt(raw)).toBe(false);
  });

  it("strips goal + system reminders together", () => {
    const goalAndSys =
      "<session-goal>\nThe user has set this goal: ship it\n</session-goal>\n\n" +
      reminder(TODOS_BODY) +
      "user prompt";
    expect(extractUserPromptText(goalAndSys)).toBe("user prompt");
  });
});
