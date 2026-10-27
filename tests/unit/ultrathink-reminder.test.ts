import { describe, expect, test } from "vitest";

import { ultrathinkReminderBody } from "@/lib/server/session";

/**
 * Boundary behavior for the `ultrathink` prose-keyword detector that
 * triggers the per-turn deeper-reasoning `<system-reminder>` (Claude Code
 * TUI parity, feature 27). The detector must:
 *   - match the bare word in any case;
 *   - reject extensions like `ultrathinking` / `ultrathinker` (those would be
 *     unrelated words containing the substring);
 *   - return a stable body so the wire format stays diffable across edits.
 *
 * The helper is pure — no Session lifecycle involved — so we exercise it
 * directly. The integration with `queueReminder` is covered transitively by
 * the existing `system-reminders.test.ts`.
 */

describe("ultrathinkReminderBody", () => {
  test("returns a stable body when the bare word appears", () => {
    const body = ultrathinkReminderBody("please ultrathink this problem");
    expect(body).not.toBeNull();
    expect(body).toContain("ultrathink");
    expect(body).toContain("deeper reasoning");
  });

  test("matches case-insensitively", () => {
    expect(ultrathinkReminderBody("Ultrathink the design")).not.toBeNull();
    expect(ultrathinkReminderBody("ULTRATHINK this")).not.toBeNull();
  });

  test("matches across word boundaries (start, end, punctuation)", () => {
    expect(ultrathinkReminderBody("ultrathink")).not.toBeNull();
    expect(ultrathinkReminderBody("ok ultrathink.")).not.toBeNull();
    expect(ultrathinkReminderBody("ultrathink, then fix it")).not.toBeNull();
    expect(ultrathinkReminderBody("Ultrathink!")).not.toBeNull();
  });

  // CC 2.1.311 — the keyword only counts where the engine's quote- and
  // path-aware finder sees it. `(ultrathink)` used to match; it is now a
  // bracketed mention, like the quoted and path cases below.
  test("ignores the keyword inside quotes, backticks and brackets (CC 2.1.311)", () => {
    expect(ultrathinkReminderBody("(ultrathink)")).toBeNull();
    expect(ultrathinkReminderBody("what does `ultrathink` do?")).toBeNull();
    expect(ultrathinkReminderBody('the word "ultrathink" is special')).toBeNull();
    expect(ultrathinkReminderBody("rename the 'ultrathink' flag")).toBeNull();
    expect(ultrathinkReminderBody("see [ultrathink] in the docs")).toBeNull();
    expect(ultrathinkReminderBody("set {ultrathink} in the template")).toBeNull();
  });

  test("ignores the keyword as part of a path, flag or file name (CC 2.1.311)", () => {
    expect(ultrathinkReminderBody("open docs/ultrathink.md")).toBeNull();
    expect(ultrathinkReminderBody("read ultrathink.md first")).toBeNull();
    expect(ultrathinkReminderBody("pass --ultrathink-mode")).toBeNull();
    expect(ultrathinkReminderBody("check src\\ultrathink\\x")).toBeNull();
    expect(ultrathinkReminderBody("what is ultrathink?")).toBeNull();
    expect(ultrathinkReminderBody("/tmp/notes ultrathink")).toBeNull();
  });

  test("an apostrophe in a contraction does not open a quoted span", () => {
    expect(ultrathinkReminderBody("don't stop, ultrathink this")).not.toBeNull();
    expect(ultrathinkReminderBody("it's tricky so ultrathink")).not.toBeNull();
  });

  test("still matches when a bare mention sits beside a quoted one", () => {
    expect(ultrathinkReminderBody('"ultrathink" means this — ultrathink now')).not.toBeNull();
  });

  test("a keyword only inside a large paste doesn't count", () => {
    const paste = "log line: ultrathink enabled\nmore log";
    expect(ultrathinkReminderBody(`look at this ${paste}`, [paste])).toBeNull();
    expect(ultrathinkReminderBody(`ultrathink about ${paste}`, [paste])).not.toBeNull();
    // No paste provenance → scanned as typed text.
    expect(ultrathinkReminderBody(`look at this ${paste}`)).not.toBeNull();
  });

  test("quotes, backticks or a leading / inside a paste don't hide a typed keyword", () => {
    const quote = 'he said "hello\nand left';
    expect(ultrathinkReminderBody(`${quote} ultrathink about "x"`, [quote])).not.toBeNull();
    const path = "/var/log/app.log line 1\nline 2";
    expect(ultrathinkReminderBody(`${path} ultrathink why`, [path])).not.toBeNull();
    const tick = "a ` stray backtick";
    expect(ultrathinkReminderBody(`${tick} ultrathink, then run \`npm test\``, [tick])).not.toBeNull();
  });

  test("non-string paste entries from a request body are ignored, not looped on", () => {
    const bad = [123, null, "", { length: 3 }] as unknown as string[];
    expect(ultrathinkReminderBody("ultrathink 123", bad)).not.toBeNull();
  });

  test("stays linear on long prompts", () => {
    const long = "() ultrathink ".repeat(70_000); // ~1 MB
    const t0 = Date.now();
    expect(ultrathinkReminderBody(long, ['"ultrathink"'])).not.toBeNull();
    expect(Date.now() - t0).toBeLessThan(1500);
  });

  test("rejects extensions that just contain the substring", () => {
    // `\b` denies these — they're distinct words, not the keyword the TUI
    // grounds the nudge on.
    expect(ultrathinkReminderBody("she is ultrathinking it")).toBeNull();
    expect(ultrathinkReminderBody("the ultrathinker decided")).toBeNull();
    expect(ultrathinkReminderBody("preultrathink mode")).toBeNull();
  });

  test("returns null when the keyword is absent", () => {
    expect(ultrathinkReminderBody("")).toBeNull();
    expect(ultrathinkReminderBody("just a normal prompt")).toBeNull();
    expect(ultrathinkReminderBody("think deeply about this")).toBeNull();
  });
});
