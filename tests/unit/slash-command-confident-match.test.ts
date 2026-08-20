import { describe, expect, test } from "vitest";
import { isConfidentSlashMatch } from "@/lib/shared/slash-commands";

/**
 * CC 2.1.236 parity: "Pressing Enter on a slash-command typo... now reports
 * it instead of running the closest fuzzy match; prefixes and aliases still
 * run." `isConfidentSlashMatch` is the gate `SlashCommandPicker` applies
 * before letting Enter auto-complete to the top fuzzy-ranked result — see
 * the 2.1.237 run-notes for why Claudius (an independent picker
 * implementation) had the identical footgun.
 */
describe("isConfidentSlashMatch", () => {
  test("empty filter is never confident", () => {
    expect(isConfidentSlashMatch({ name: "cost" }, "")).toBe(false);
  });

  test("a prefix of the command name is confident", () => {
    expect(isConfidentSlashMatch({ name: "cost" }, "co")).toBe(true);
    expect(isConfidentSlashMatch({ name: "cost" }, "cost")).toBe(true);
  });

  test("an exact or prefix alias match is confident", () => {
    expect(isConfidentSlashMatch({ name: "usage", aliases: ["stats"] }, "stats")).toBe(true);
    expect(isConfidentSlashMatch({ name: "usage", aliases: ["stats"] }, "sta")).toBe(true);
  });

  test("a weak subsequence-only match is NOT confident (the bug being fixed)", () => {
    // "gt" is a subsequence of "git" (g...t) and would score positively under
    // SlashCommandPicker's fuzzyScore ranking, but it's neither a prefix of
    // the name nor of any alias — exactly the class of typo that used to
    // silently autocomplete on Enter.
    expect(isConfidentSlashMatch({ name: "git" }, "gt")).toBe(false);
  });

  test("a filter that matches neither the name nor an alias is not confident", () => {
    expect(isConfidentSlashMatch({ name: "cost", aliases: ["usage"] }, "xyz")).toBe(false);
  });
});
