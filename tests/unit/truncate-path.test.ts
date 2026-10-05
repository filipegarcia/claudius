import { describe, expect, test } from "vitest";
import { splitPathForTruncation } from "@/lib/shared/truncate-path";

/**
 * CC 2.1.239 (F5) — split a tool-row path into a truncatable directory head
 * and a whole-filename tail, so the filename survives truncation.
 */
describe("splitPathForTruncation (F5)", () => {
  test("splits at the last slash, keeping it on the head", () => {
    expect(splitPathForTruncation("/Users/me/project/components/chat/ToolCall.tsx")).toEqual({
      head: "/Users/me/project/components/chat/",
      tail: "ToolCall.tsx",
    });
  });

  test("head + tail reconstruct the original path", () => {
    const p = "/a/very/long/path/to/some/deeply/nested/file.ts";
    const { head, tail } = splitPathForTruncation(p);
    expect(head + tail).toBe(p);
  });

  test("a bare filename is all tail (nothing to truncate)", () => {
    expect(splitPathForTruncation("README.md")).toEqual({ head: "", tail: "README.md" });
  });

  test("a relative path splits at its last slash", () => {
    expect(splitPathForTruncation("src/lib/foo.ts")).toEqual({ head: "src/lib/", tail: "foo.ts" });
  });

  test("a trailing slash (directory) puts everything in the head", () => {
    expect(splitPathForTruncation("/Users/me/project/")).toEqual({
      head: "/Users/me/project/",
      tail: "",
    });
  });

  test("Windows backslashes split too", () => {
    expect(splitPathForTruncation("C:\\Users\\me\\file.ts")).toEqual({
      head: "C:\\Users\\me\\",
      tail: "file.ts",
    });
  });

  test("empty input is empty head/tail", () => {
    expect(splitPathForTruncation("")).toEqual({ head: "", tail: "" });
  });
});
