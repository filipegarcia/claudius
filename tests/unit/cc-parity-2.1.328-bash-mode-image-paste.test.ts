import { describe, expect, test } from "vitest";

import { bashModeFileInsert, shellQuotePath } from "@/lib/shared/bash-mode-paths";

/**
 * CC 2.1.328 parity — "Fixed an image path pasted into a `!` command becoming
 * an attachment". In `!` mode the composer inserts a dropped or pasted file
 * (image or not) as a shell-quoted path instead of attaching it.
 */
describe("shellQuotePath (CC 2.1.328)", () => {
  test("a plain path stays a bare word", () => {
    expect(shellQuotePath("assets/logo.png")).toBe("assets/logo.png");
    expect(shellQuotePath("/Users/me/shot-1.png")).toBe("/Users/me/shot-1.png");
  });

  test("spaces and shell metacharacters are single-quoted", () => {
    expect(shellQuotePath("Screen Shot 2026.png")).toBe("'Screen Shot 2026.png'");
    expect(shellQuotePath("a$(rm -rf).png")).toBe("'a$(rm -rf).png'");
    expect(shellQuotePath("[Image #1].png")).toBe("'[Image #1].png'");
  });

  test("an embedded single quote is closed, escaped and reopened", () => {
    expect(shellQuotePath("it's.png")).toBe("'it'\\''s.png'");
  });
});

describe("bashModeFileInsert (CC 2.1.328)", () => {
  test("joins several paths with spaces, quoting only where needed", () => {
    expect(bashModeFileInsert(["a.png", "my pic.jpg"])).toBe("a.png 'my pic.jpg'");
  });

  test("never produces the @-mention form or an image token", () => {
    const out = bashModeFileInsert(["shot.png"]);
    expect(out).toBe("shot.png");
    expect(out).not.toMatch(/^@|\[Image #/);
  });

  test("empty paths are skipped", () => {
    expect(bashModeFileInsert(["", "x.png"])).toBe("x.png");
    expect(bashModeFileInsert([])).toBe("");
  });
});
