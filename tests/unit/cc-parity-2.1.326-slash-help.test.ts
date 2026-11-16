import { describe, expect, test } from "vitest";
import { findHelpTopic, helpTopic, isGoalClear, isHelpRequest, usageLine } from "@/lib/shared/slash-help";
import { SLASH_COMMANDS } from "@/lib/shared/slash-commands";

/**
 * CC 2.1.326 parity — "Fixed `/clear --help` and other built-in commands
 * running at an idle prompt instead of showing usage; added `/help <command>`"
 * and "Fixed `/goal clear` … not sticking".
 */

describe("isHelpRequest", () => {
  test("--help and -h ask for usage", () => {
    for (const a of ["--help", " -h ", "--HELP"]) expect(isHelpRequest(a)).toBe(true);
  });
  test("anything else runs the command", () => {
    for (const a of ["", "help", "--help me", "fix the help page"]) expect(isHelpRequest(a)).toBe(false);
  });
});

describe("helpTopic", () => {
  test("names the command without its slash, lowercased", () => {
    expect(helpTopic("clear")).toBe("clear");
    expect(helpTopic(" /Goal extra")).toBe("goal");
  });
  test("bare /help has no topic", () => {
    expect(helpTopic("")).toBeNull();
    expect(helpTopic("  /  ")).toBeNull();
  });
});

describe("findHelpTopic / usageLine", () => {
  test("finds by name or alias in the real registry", () => {
    expect(findHelpTopic(SLASH_COMMANDS, "clear")?.id).toBe("clear");
    expect(findHelpTopic(SLASH_COMMANDS, "reset")?.id).toBe("clear");
    expect(findHelpTopic(SLASH_COMMANDS, "nope")).toBeUndefined();
  });
  test("usage line carries the args hint", () => {
    expect(usageLine({ name: "clear" })).toBe("/clear");
    expect(usageLine({ name: "goal", argsHint: "[goal text]" })).toBe("/goal [goal text]");
  });
});

describe("isGoalClear", () => {
  test("clear / off / reset / none clear the goal", () => {
    for (const a of ["clear", " CLEAR ", "off", "reset", "none"]) expect(isGoalClear(a)).toBe(true);
  });
  test("goal text that merely mentions clearing is still a goal", () => {
    for (const a of ["", "clear the cache", "make it clear"]) expect(isGoalClear(a)).toBe(false);
  });
});
