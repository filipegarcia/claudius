import { describe, expect, it } from "vitest";
import { extractUserPromptText, stripGoalReminder } from "@/lib/shared/user-prompt";

// The exact reminder shape `Session.takeGoalReminder()` prepends to the user's
// prompt when a session goal is set. Kept in sync with session.ts.
function reminder(goal: string): string {
  return (
    "<session-goal>\n" +
    `The user has set this goal for the session: ${goal}\n\n` +
    "Work toward it. When you are confident it is fully accomplished, call the " +
    "mcp__claudius_goal__report_goal_achieved tool with a one-sentence summary. " +
    "Do not call it for partial progress.\n" +
    "</session-goal>\n\n"
  );
}

describe("stripGoalReminder", () => {
  it("removes the prepended <session-goal> wrapper, leaving the real prompt", () => {
    const goal = "fix the Electron app icon and build target";
    const raw = reminder(goal) + goal;
    expect(stripGoalReminder(raw)).toBe(goal);
  });

  it("is a no-op when no wrapper is present", () => {
    const plain = "just a normal prompt with <not-a-goal> tags inside";
    expect(stripGoalReminder(plain)).toBe(plain);
  });

  it("only strips a leading wrapper, not one mid-message", () => {
    const text = "do the thing <session-goal>x</session-goal> mentioned above";
    expect(stripGoalReminder(text)).toBe(text);
  });

  it("handles leading whitespace before the wrapper", () => {
    expect(stripGoalReminder(`\n  ${reminder("g")}real prompt`)).toBe("real prompt");
  });

  it("extractUserPromptText returns the clean prompt for a goal message", () => {
    const goal = "ship the goal feature";
    expect(extractUserPromptText(reminder(goal) + goal)).toBe(goal);
    // array (content-block) shape
    expect(
      extractUserPromptText([{ type: "text", text: reminder(goal) + goal }]),
    ).toBe(goal);
  });
});
