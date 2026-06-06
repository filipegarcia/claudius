import { describe, expect, test } from "vitest";
import { parseUserTextWithBashIO } from "@/lib/shared/bash-io";

/**
 * `parseUserTextWithBashIO` is the bridge between the server's
 * `formatBashIOBlock` output and the chat renderer. It runs on every
 * user-turn render, so a regex hiccup here either shows the model's raw
 * `<bash-input>` markup in the bubble or silently swallows the user's
 * real text. These tests pin the contract:
 *
 *   - inputs without bash blocks round-trip to one plain-text segment
 *   - a pure-bash payload (live broadcast) becomes one bash segment
 *   - a mixed payload (prefix from `pending-bash-output` + user text)
 *     interleaves correctly
 *   - multiple consecutive `!cmd`s before a real prompt all split out
 */

describe("parseUserTextWithBashIO", () => {
  test("plain text → single text segment", () => {
    const segs = parseUserTextWithBashIO("hello world");
    expect(segs).toEqual([{ kind: "text", text: "hello world" }]);
  });

  test("empty input → empty segment list", () => {
    expect(parseUserTextWithBashIO("")).toEqual([]);
  });

  test("pure bash echo (live broadcast shape) → single bash segment", () => {
    const segs = parseUserTextWithBashIO(
      "<bash-input>ls</bash-input>\n<bash-stdout>file.txt\n</bash-stdout><bash-stderr></bash-stderr>",
    );
    expect(segs).toEqual([
      { kind: "bash", command: "ls", stdout: "file.txt\n", stderr: "" },
    ]);
  });

  test("prefix block + user text (JSONL replay shape)", () => {
    const segs = parseUserTextWithBashIO(
      "<bash-input>pwd</bash-input>\n<bash-stdout>/tmp\n</bash-stdout><bash-stderr></bash-stderr>" +
        "\n" +
        "now read foo.ts",
    );
    expect(segs).toHaveLength(2);
    expect(segs[0]).toEqual({
      kind: "bash",
      command: "pwd",
      stdout: "/tmp\n",
      stderr: "",
    });
    expect(segs[1].kind).toBe("text");
    // Leading newline tolerated — visible text starts with the user's
    // actual prompt.
    if (segs[1].kind === "text") {
      expect(segs[1].text).toContain("now read foo.ts");
    }
  });

  test("multiple consecutive bash blocks each split out", () => {
    const segs = parseUserTextWithBashIO(
      "<bash-input>a</bash-input>\n<bash-stdout>A</bash-stdout><bash-stderr></bash-stderr>" +
        "\n" +
        "<bash-input>b</bash-input>\n<bash-stdout>B</bash-stdout><bash-stderr></bash-stderr>",
    );
    const bashSegs = segs.filter((s) => s.kind === "bash");
    expect(bashSegs).toHaveLength(2);
    expect(bashSegs[0]).toMatchObject({ command: "a", stdout: "A" });
    expect(bashSegs[1]).toMatchObject({ command: "b", stdout: "B" });
  });

  test("stderr content is captured even with a newline before <bash-stderr>", () => {
    const segs = parseUserTextWithBashIO(
      "<bash-input>x</bash-input>\n<bash-stdout></bash-stdout>\n<bash-stderr>boom\n</bash-stderr>",
    );
    expect(segs).toHaveLength(1);
    expect(segs[0]).toEqual({
      kind: "bash",
      command: "x",
      stdout: "",
      stderr: "boom\n",
    });
  });
});
