import { describe, expect, test } from "vitest";
import {
  filesHref,
  looksLikeFilePath,
  resolveDroppedPath,
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
      // Binary / image references the chat regularly emits. Whitelisting
      // these is what stops `[…](site/og.png)` from being routed to a
      // `target="_blank"` anchor — and from there to a same-origin child
      // window where `/<workspaceId>/site/og.png` 404s the whole app.
      "site/og.png",
      "docs/screenshots/hero.jpg",
      "design/icon.svg",
      "downloads/spec.pdf",
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

describe("resolveDroppedPath", () => {
  test("crops the cwd prefix when the dropped file lives inside the workspace", () => {
    expect(
      resolveDroppedPath(`${CWD}/scripts/sdk-update/prompt.md`, "prompt.md", CWD),
    ).toBe("scripts/sdk-update/prompt.md");
  });

  test("tolerates a trailing slash on cwd", () => {
    expect(resolveDroppedPath(`${CWD}/a/b.ts`, "b.ts", `${CWD}/`)).toBe("a/b.ts");
  });

  test("returns the absolute path verbatim when the file is outside the workspace", () => {
    expect(
      resolveDroppedPath("/Users/me/Documents/notes.md", "notes.md", CWD),
    ).toBe("/Users/me/Documents/notes.md");
  });

  test("does not crop look-alike sibling roots (no spurious prefix match)", () => {
    // /Users/me/Projects/claudius-fork/... must NOT be cropped against
    // /Users/me/Projects/claudius. Trailing-slash guard protects against this.
    expect(
      resolveDroppedPath(`${CWD}-fork/a.ts`, "a.ts", CWD),
    ).toBe(`${CWD}-fork/a.ts`);
  });

  test("falls back to basename when no absolute path is available (web build)", () => {
    expect(resolveDroppedPath(null, "notes.md", CWD)).toBe("notes.md");
  });

  test("returns absolute path when cwd is unknown", () => {
    expect(
      resolveDroppedPath("/Users/me/Documents/notes.md", "notes.md", null),
    ).toBe("/Users/me/Documents/notes.md");
  });

  test("returns absolute path when cwd is empty", () => {
    expect(resolveDroppedPath("/abs/x.ts", "x.ts", "")).toBe("/abs/x.ts");
  });

  test("returns the absolute path itself when it equals the workspace root", () => {
    // Defensive — drops are files, not directories, but the helper shouldn't
    // crash on the degenerate case.
    expect(resolveDroppedPath(CWD, "claudius", CWD)).toBe(CWD);
  });
});
