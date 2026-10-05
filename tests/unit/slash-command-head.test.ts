import { describe, expect, test } from "vitest";
import { isSlashCommandHead } from "@/lib/shared/slash-commands";

/**
 * CC 2.1.246 (FIX) — a `/`-prefixed prompt whose head isn't a command
 * identifier must be sent to the model as ordinary text, not rejected as
 * "Unknown command". `isSlashCommandHead` is the gate: true only for things
 * shaped like a command name.
 */
describe("isSlashCommandHead (CC 2.1.246 — D2)", () => {
  test("accepts real command-name shapes", () => {
    for (const h of ["compact", "code-review", "plugin:skill", "foo_bar", "a", "review2"]) {
      expect(isSlashCommandHead(h)).toBe(true);
    }
  });

  test("a command-shaped-but-unknown head still passes (handled as a typo downstream)", () => {
    expect(isSlashCommandHead("lkjasdf")).toBe(true);
  });

  test("rejects slash-prefixed prose / paths / flags", () => {
    // `/--flag` → head "--flag"; `/usr/bin/x` → head "usr/bin/x"; etc.
    for (const h of ["--flag", "-x", "usr/bin/x", "./src", "", ":leading", "a b", "@mention", "3.5"]) {
      expect(isSlashCommandHead(h)).toBe(false);
    }
  });
});
