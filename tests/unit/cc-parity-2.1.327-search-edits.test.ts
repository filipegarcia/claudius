import { describe, expect, it } from "vitest";
import {
  toolInputMatches,
  toolInputTextFields,
  toolInputTextKeys,
} from "@/lib/shared/tool-input-search";

describe("toolInputTextFields", () => {
  it("names the old and new text of an Edit", () => {
    expect(
      toolInputTextFields("Edit", { file_path: "/a.ts", old_string: "foo", new_string: "bar\nbaz" }),
    ).toEqual([
      { label: "old_string", text: "foo" },
      { label: "new_string", text: "bar\nbaz" },
    ]);
  });

  it("numbers each MultiEdit edit and skips malformed entries", () => {
    expect(
      toolInputTextFields("MultiEdit", {
        file_path: "/a.ts",
        edits: [{ old_string: "a", new_string: "b" }, null, "junk", { old_string: 3, new_string: "d" }],
      }),
    ).toEqual([
      { label: "edit 1 · old_string", text: "a" },
      { label: "edit 1 · new_string", text: "b" },
      { label: "edit 4 · new_string", text: "d" },
    ]);
    expect(toolInputTextFields("MultiEdit", { edits: "nope" })).toEqual([]);
  });

  it("reads Write content and NotebookEdit new_source", () => {
    expect(toolInputTextFields("Write", { file_path: "/a", content: "hello" })).toEqual([
      { label: "content", text: "hello" },
    ]);
    expect(toolInputTextFields("NotebookEdit", { notebook_path: "/n.ipynb", new_source: "x = 1" })).toEqual([
      { label: "new_source", text: "x = 1" },
    ]);
    // A delete carries no new_source.
    expect(toolInputTextFields("NotebookEdit", { notebook_path: "/n.ipynb", edit_mode: "delete" })).toEqual([]);
  });

  it("is empty for tools that don't write files", () => {
    expect(toolInputTextFields("Bash", { command: "echo content", content: "x" })).toEqual([]);
    expect(toolInputTextKeys("Bash")).toEqual([]);
  });

  it("lists the input keys rendered as text", () => {
    expect(toolInputTextKeys("Edit")).toEqual(["old_string", "new_string"]);
    expect(toolInputTextKeys("MultiEdit")).toEqual(["edits"]);
    expect(toolInputTextKeys("Write")).toEqual(["content"]);
    expect(toolInputTextKeys("NotebookEdit")).toEqual(["new_source"]);
  });
});

describe("toolInputMatches", () => {
  const edit = { file_path: "/a.ts", old_string: "const A = 1;", new_string: 'say "Zebra"\nnext line' };

  it("matches a literal substring of any text field, case-insensitively by default", () => {
    expect(toolInputMatches("Edit", edit, "zebra", false)).toBe(true);
    expect(toolInputMatches("Edit", edit, 'say "zeb', false)).toBe(true);
    expect(toolInputMatches("Edit", edit, "const a", false)).toBe(true);
  });

  it("respects matchCase", () => {
    expect(toolInputMatches("Edit", edit, "zebra", true)).toBe(false);
    expect(toolInputMatches("Edit", edit, "Zebra", true)).toBe(true);
  });

  it("treats regex metacharacters literally and doesn't trim the query", () => {
    expect(toolInputMatches("Write", { content: "a.b" }, "a.b", false)).toBe(true);
    expect(toolInputMatches("Write", { content: "axb" }, "a.b", false)).toBe(false);
    expect(toolInputMatches("Write", { content: "ab" }, " ab", false)).toBe(false);
  });

  it("never matches an empty query, the file path, or a non-file tool", () => {
    expect(toolInputMatches("Edit", edit, "", false)).toBe(false);
    expect(toolInputMatches("Edit", edit, "/a.ts", false)).toBe(false);
    expect(toolInputMatches("Bash", { command: "zebra" }, "zebra", false)).toBe(false);
  });

  it("searches MultiEdit edits and NotebookEdit source", () => {
    expect(
      toolInputMatches("MultiEdit", { edits: [{ old_string: "x", new_string: "needle" }] }, "NEEDLE", false),
    ).toBe(true);
    expect(toolInputMatches("NotebookEdit", { new_source: "print(42)" }, "print(", false)).toBe(true);
  });
});
