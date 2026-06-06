import { describe, expect, test } from "vitest";
import { extractBangCommand } from "@/components/chat/CodeBlock";

/**
 * Gate the rule: the Execute button on a shell fence appears ONLY when the
 * model explicitly authored the code with a leading `!`. Plain ```bash
 * fences (recaps of commands the model already ran via its Bash tool,
 * snippets quoted from docs) don't get the button — the user already saw
 * the output upstream.
 *
 * Keeping this as a pure function with table-driven tests means a UI tweak
 * can't quietly change which fences look executable.
 */

describe("extractBangCommand", () => {
  test("returns null when there is no leading `!`", () => {
    expect(extractBangCommand("ls -la")).toBeNull();
    expect(extractBangCommand("echo hi\n!ls")).toBeNull(); // `!` must be FIRST
    expect(extractBangCommand("")).toBeNull();
  });

  test("strips `!` and an optional single space", () => {
    expect(extractBangCommand("!ls")).toBe("ls");
    expect(extractBangCommand("! ls")).toBe("ls");
    expect(extractBangCommand("!  ls")).toBe(" ls"); // only ONE space eaten
  });

  test("tolerates leading whitespace before the `!`", () => {
    expect(extractBangCommand("   !pwd")).toBe("pwd");
    expect(extractBangCommand("\n  !pwd")).toBe("pwd");
  });

  test("preserves the rest of a multi-line body verbatim", () => {
    // The whole body after `!` goes to the shell — useful for short
    // pipelines and let-statements the model might emit.
    expect(extractBangCommand("!for f in *.ts; do\n  echo $f\ndone")).toBe(
      "for f in *.ts; do\n  echo $f\ndone",
    );
  });

  test("a bare `!` returns the empty string (caller decides whether to disable)", () => {
    // The button is gated separately on a non-empty post-strip body in the
    // component, but the helper itself returns "" so callers can branch
    // explicitly rather than re-implement the marker detection.
    expect(extractBangCommand("!")).toBe("");
  });
});
