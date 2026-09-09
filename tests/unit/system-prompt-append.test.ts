import { describe, expect, test } from "vitest";
import {
  buildSystemPromptOption,
  joinSystemPromptAppends,
} from "@/lib/shared/system-prompt-append";

/**
 * Guards the fix for a duplicate-`systemPrompt`-key bug: the session goal and
 * the workspace `systemPromptAppend` both append to the Claude Code preset,
 * and emitting two `systemPrompt` keys in the Options literal would drop one.
 * This helper merges them; the key assertion is "both survive".
 */
describe("joinSystemPromptAppends", () => {
  test("merges both contributions, goal first, separated by a blank line", () => {
    expect(joinSystemPromptAppends(["GOAL: ship it", "Always use TypeScript"])).toBe(
      "GOAL: ship it\n\nAlways use TypeScript",
    );
  });

  test("a single contribution passes through unchanged", () => {
    expect(joinSystemPromptAppends(["", "house style"])).toBe("house style");
    expect(joinSystemPromptAppends(["just the goal", ""])).toBe("just the goal");
  });

  test("nothing to append yields empty string (caller omits systemPrompt)", () => {
    expect(joinSystemPromptAppends([])).toBe("");
    expect(joinSystemPromptAppends(["", "   ", null, undefined])).toBe("");
  });

  test("trims each part and drops whitespace-only entries", () => {
    expect(joinSystemPromptAppends(["  a  ", "   ", "\n b \n"])).toBe("a\n\nb");
  });

  test("preserves order of contributions", () => {
    expect(joinSystemPromptAppends(["1", "2", "3"])).toBe("1\n\n2\n\n3");
  });
});

/**
 * SDK 0.3.265 regression guard: the SDK flipped `Options.systemPrompt`'s
 * `snapshot` default from "render fresh every launch" to "record on the
 * first request, replay verbatim on every later request/resume until
 * compaction". Claudius recomputes the combined append from mutable state
 * (workspace `systemPromptAppend`, session goal) on every `Session.start()`,
 * including a resume — so it must keep opting out with `snapshot: false` to
 * preserve the pre-0.3.265 behaviour. See the doc comment on
 * `buildSystemPromptOption` and its call site in `lib/server/session.ts`.
 */
describe("buildSystemPromptOption", () => {
  test("empty append yields undefined so the caller omits systemPrompt entirely", () => {
    expect(buildSystemPromptOption("")).toBeUndefined();
  });

  test("non-empty append builds the preset object with snapshot explicitly false", () => {
    expect(buildSystemPromptOption("Always use TypeScript")).toEqual({
      type: "preset",
      preset: "claude_code",
      append: "Always use TypeScript",
      snapshot: false,
    });
  });
});
