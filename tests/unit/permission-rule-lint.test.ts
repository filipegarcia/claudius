import { describe, expect, test } from "vitest";
import { lintBashWildcardRule, lintPermissionRule, lintTrailingGarbageRule } from "@/lib/shared/permission-rule-lint";

/**
 * CC 2.1.210 parity — "Added a startup warning for `Write(path)`,
 * `NotebookEdit(path)`, and `Glob(path)` permission rules — use
 * `Edit(path)` or `Read(path)` instead". Claudius surfaces this inline on
 * the `/permissions` page (see `app/[workspaceId]/permissions/page.tsx`);
 * this covers the pure lint logic behind it.
 */
describe("lintPermissionRule", () => {
  test("flags path-scoped Write with Edit(path)", () => {
    expect(lintPermissionRule("Write(./src/**)")).toEqual({ tool: "Write", suggestion: "Edit(path)" });
  });

  test("flags path-scoped NotebookEdit with Edit(path)", () => {
    expect(lintPermissionRule("NotebookEdit(./notebooks/**/*.ipynb)")).toEqual({
      tool: "NotebookEdit",
      suggestion: "Edit(path)",
    });
  });

  test("flags path-scoped Glob with Read(path)", () => {
    expect(lintPermissionRule("Glob(./src/**)")).toEqual({ tool: "Glob", suggestion: "Read(path)" });
  });

  test("does not flag the bare unscoped tool name", () => {
    expect(lintPermissionRule("Write")).toBeNull();
    expect(lintPermissionRule("Glob")).toBeNull();
    expect(lintPermissionRule("NotebookEdit")).toBeNull();
  });

  test("does not flag supported path-scoped tools", () => {
    expect(lintPermissionRule("Edit(./src/**/*.ts)")).toBeNull();
    expect(lintPermissionRule("Read(./src/**)")).toBeNull();
    expect(lintPermissionRule("Bash(npm run *)")).toBeNull();
  });

  test("does not flag unrelated or malformed input", () => {
    expect(lintPermissionRule("")).toBeNull();
    expect(lintPermissionRule("mcp__server__tool")).toBeNull();
    expect(lintPermissionRule("Write(unterminated")).toBeNull();
  });

  test("tolerates surrounding whitespace", () => {
    expect(lintPermissionRule("  Write(./src/**)  ")).toEqual({ tool: "Write", suggestion: "Edit(path)" });
  });
});

/**
 * CC 2.1.246 parity — "Added a startup warning for Bash allow rules with a
 * wildcard before the subcommand (e.g. `Bash(git * main)`), since they
 * also match options inserted before the subcommand". Claudius surfaces
 * this inline on the `/permissions` page; this covers the pure lint logic.
 */
describe("lintBashWildcardRule", () => {
  test("flags a wildcard before a fixed trailing token", () => {
    expect(lintBashWildcardRule("Bash(git * main)")).toEqual({ command: "git * main" });
  });

  test("flags a wildcard in the middle with multiple trailing tokens", () => {
    expect(lintBashWildcardRule("Bash(git * origin main)")).toEqual({
      command: "git * origin main",
    });
  });

  test("does not flag a trailing wildcard — the common 'anything after this' pattern", () => {
    expect(lintBashWildcardRule("Bash(npm run *)")).toBeNull();
    expect(lintBashWildcardRule("Bash(git commit *)")).toBeNull();
    expect(lintBashWildcardRule("Bash(*)")).toBeNull();
  });

  test("does not flag rules with no wildcard", () => {
    expect(lintBashWildcardRule("Bash(git status)")).toBeNull();
    expect(lintBashWildcardRule("Bash")).toBeNull();
  });

  test("does not flag non-Bash rules", () => {
    expect(lintBashWildcardRule("Read(./src/**)")).toBeNull();
    expect(lintBashWildcardRule("mcp__server__tool")).toBeNull();
  });

  test("does not flag malformed input", () => {
    expect(lintBashWildcardRule("")).toBeNull();
    expect(lintBashWildcardRule("Bash(unterminated")).toBeNull();
    expect(lintBashWildcardRule("Bash()")).toBeNull();
  });

  test("tolerates surrounding whitespace", () => {
    expect(lintBashWildcardRule("  Bash(git * main)  ")).toEqual({ command: "git * main" });
  });
});

/**
 * CC 2.1.260 parity — "Changed permission rules with text after the closing
 * parenthesis (e.g. `Bash(ls) x`), which never matched anything, to be
 * reported as invalid settings instead of being silently ignored."
 */
describe("lintTrailingGarbageRule", () => {
  test("flags text after the closing parenthesis", () => {
    expect(lintTrailingGarbageRule("Bash(ls) x")).toEqual({ trailing: "x" });
  });

  test("flags text with no separating space", () => {
    expect(lintTrailingGarbageRule("Bash(ls)x")).toEqual({ trailing: "x" });
  });

  test("does not flag a well-formed rule", () => {
    expect(lintTrailingGarbageRule("Bash(ls)")).toBeNull();
    expect(lintTrailingGarbageRule("Write(./src/**)")).toBeNull();
  });

  test("does not flag a bare, unscoped rule name", () => {
    expect(lintTrailingGarbageRule("Bash")).toBeNull();
    expect(lintTrailingGarbageRule("")).toBeNull();
  });

  test("does not flag trailing whitespace-only content", () => {
    expect(lintTrailingGarbageRule("Bash(ls)   ")).toBeNull();
  });

  test("a rule with an inner, escaped-looking parenthesis is not misread as trailing garbage", () => {
    // The ambiguous-escaping case CC 2.1.260 separately improves the error
    // message for — Claudius deliberately doesn't attempt to disambiguate
    // it here (see the doc comment), but it must not be misclassified as
    // *this* warning either: the string DOES end with its true closing
    // paren, so nothing should be flagged.
    expect(lintTrailingGarbageRule("Edit(C:\\dir\\(name)\\**)")).toBeNull();
  });

  test("does not flag a rule with no closing paren at all", () => {
    expect(lintTrailingGarbageRule("Bash(unterminated")).toBeNull();
  });
});
