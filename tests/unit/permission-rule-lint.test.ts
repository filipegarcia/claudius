import { describe, expect, test } from "vitest";
import { lintPermissionRule } from "@/lib/shared/permission-rule-lint";

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
