import { describe, expect, test } from "vitest";
import {
  filesHref,
  looksLikeFilePath,
  stripLineSuffix,
  toWorkspaceRelative,
} from "@/lib/client/file-paths";

const CWD = "/Users/me/Projects/claudius";

describe("toWorkspaceRelative", () => {
  test("relativizes an absolute path under the workspace root", () => {
    expect(toWorkspaceRelative(`${CWD}/scripts/sdk-update/prompt.md`, CWD)).toBe(
      "scripts/sdk-update/prompt.md",
    );
  });

  test("tolerates a trailing slash on cwd", () => {
    expect(toWorkspaceRelative(`${CWD}/a/b.ts`, `${CWD}/`)).toBe("a/b.ts");
  });

  test("rejects an absolute path outside the workspace", () => {
    expect(toWorkspaceRelative("/etc/passwd", CWD)).toBeNull();
    expect(toWorkspaceRelative("/Users/me/Projects/other/x.ts", CWD)).toBeNull();
  });

  test("rejects the workspace root itself", () => {
    expect(toWorkspaceRelative(CWD, CWD)).toBeNull();
  });

  test("keeps clean relative paths and strips a leading ./", () => {
    expect(toWorkspaceRelative("lib/client/use-session.ts", CWD)).toBe(
      "lib/client/use-session.ts",
    );
    expect(toWorkspaceRelative("./package.json", CWD)).toBe("package.json");
  });

  test("rejects escaping, urls, npm scopes, and home shorthand", () => {
    expect(toWorkspaceRelative("../secrets.txt", CWD)).toBeNull();
    expect(toWorkspaceRelative("a/../../b", CWD)).toBeNull();
    expect(toWorkspaceRelative("https://example.com/a.js", CWD)).toBeNull();
    expect(toWorkspaceRelative("@anthropic-ai/sdk", CWD)).toBeNull();
    expect(toWorkspaceRelative("~/notes.md", CWD)).toBeNull();
  });
});

describe("looksLikeFilePath", () => {
  test("accepts real-looking project file references", () => {
    for (const s of [
      "scripts/sdk-update/prompt.md",
      "package.json",
      "README.md",
      ".env",
      "lib/client/use-session.ts",
      "src/app.ts:42",
      "src/app.ts:42:7",
      "app/globals.css",
    ]) {
      expect(looksLikeFilePath(s), s).toBe(true);
    }
  });

  test("rejects the non-file things that commonly sit in backticks", () => {
    for (const s of [
      "{{NEW_VERSION}}",
      "@anthropic-ai/claude-agent-sdk",
      "docs(sdk-update): notes for {{NEW_VERSION}}",
      "npm run build",
      "https://example.com/a.js",
      "foo()",
      "Array.prototype.map",
      "acceptEdits",
      "someValue",
      "a file.md",
    ]) {
      expect(looksLikeFilePath(s), s).toBe(false);
    }
  });
});

describe("stripLineSuffix", () => {
  test("drops :line and :line:col", () => {
    expect(stripLineSuffix("src/app.ts:42")).toBe("src/app.ts");
    expect(stripLineSuffix("src/app.ts:42:7")).toBe("src/app.ts");
    expect(stripLineSuffix("src/app.ts")).toBe("src/app.ts");
  });
});

describe("filesHref", () => {
  test("builds a workspace-scoped Files URL with an encoded path", () => {
    expect(filesHref("wks_1", "a/b.md")).toBe("/wks_1/files?path=a%2Fb.md");
  });
});
