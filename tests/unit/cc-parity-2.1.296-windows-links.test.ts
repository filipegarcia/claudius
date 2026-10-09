import { describe, expect, test } from "vitest";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { Markdown } from "@/components/chat/Markdown";
import { FileLinkProvider } from "@/lib/client/file-link-context";
import {
  isLocalFileRef,
  looksLikeFilePath,
  normalizeLocalPath,
  toWorkspaceRelative,
} from "@/lib/client/file-paths";

/**
 * CC 2.1.296 — "[VSCode] Fixed chat links written as a full Windows path,
 * such as C:\repo\file.ts or file:///C:/repo/file.ts, not opening the file on
 * Windows". Claudius owns its own chat-link → Files-browser routing and ships
 * a Windows build; both spellings fell through to a broken (or stripped) link.
 */
const WIN_CWD = "C:\\repo";

describe("normalizeLocalPath", () => {
  test("Windows and file:// spellings normalise to a forward-slash path", () => {
    expect(normalizeLocalPath("C:\\repo\\src\\a.ts")).toBe("C:/repo/src/a.ts");
    expect(normalizeLocalPath("C:%5Crepo%5Csrc%5Ca.ts")).toBe("C:/repo/src/a.ts");
    expect(normalizeLocalPath("file:///C:/repo/src/a.ts")).toBe("C:/repo/src/a.ts");
    expect(normalizeLocalPath("file:///C:/my%20repo/a.ts")).toBe("C:/my repo/a.ts");
    expect(normalizeLocalPath("file:///home/me/repo/a.ts")).toBe("/home/me/repo/a.ts");
  });

  test("UNC file URLs, malformed escapes and ordinary text are left alone", () => {
    expect(normalizeLocalPath("file://server/share/a.ts")).toBe("file://server/share/a.ts");
    expect(normalizeLocalPath("file:///C:/%E0%A4%A/a.ts")).toBe("file:///C:/%E0%A4%A/a.ts");
    expect(normalizeLocalPath("src/a.ts")).toBe("src/a.ts");
    expect(normalizeLocalPath("https://x.dev/a.ts")).toBe("https://x.dev/a.ts");
  });
});

describe("toWorkspaceRelative — Windows paths", () => {
  test("drive-letter and file:/// paths inside the workspace resolve", () => {
    expect(toWorkspaceRelative("C:\\repo\\file.ts", WIN_CWD)).toBe("file.ts");
    expect(toWorkspaceRelative("c:/repo/src/file.ts", WIN_CWD)).toBe("src/file.ts");
    expect(toWorkspaceRelative("file:///C:/repo/src/file.ts", WIN_CWD)).toBe("src/file.ts");
    expect(toWorkspaceRelative("C:\\Repo\\file.ts", "c:\\repo\\")).toBe("file.ts");
  });

  test("paths outside the workspace, the root itself and escapes stay unlinked", () => {
    expect(toWorkspaceRelative("C:\\other\\file.ts", WIN_CWD)).toBeNull();
    expect(toWorkspaceRelative("D:\\repo\\file.ts", WIN_CWD)).toBeNull();
    expect(toWorkspaceRelative("C:\\repo", WIN_CWD)).toBeNull();
    expect(toWorkspaceRelative("C:\\repo\\..\\secrets.txt", WIN_CWD)).toBeNull();
    expect(toWorkspaceRelative("C:\\repo-other\\file.ts", WIN_CWD)).toBeNull();
  });

  test("a POSIX workspace never matches a drive path, and vice versa", () => {
    expect(toWorkspaceRelative("C:\\repo\\file.ts", "/repo")).toBeNull();
    expect(toWorkspaceRelative("/repo/file.ts", WIN_CWD)).toBeNull();
  });

  test("file:/// works for POSIX workspaces too", () => {
    expect(toWorkspaceRelative("file:///Users/me/repo/a.ts", "/Users/me/repo")).toBe("a.ts");
  });
});

describe("looksLikeFilePath / isLocalFileRef", () => {
  test("Windows and file:// paths with a file extension look like files", () => {
    expect(looksLikeFilePath("C:\\repo\\file.ts")).toBe(true);
    expect(looksLikeFilePath("file:///C:/repo/file.ts")).toBe(true);
    expect(looksLikeFilePath("file://server/share/file.ts")).toBe(false);
  });

  test("isLocalFileRef recognises only file:// and drive-letter refs", () => {
    expect(isLocalFileRef("file:///C:/a.ts")).toBe(true);
    expect(isLocalFileRef("C:\\a.ts")).toBe(true);
    expect(isLocalFileRef("c:/a.ts")).toBe(true);
    expect(isLocalFileRef("https://x.dev")).toBe(false);
    expect(isLocalFileRef("javascript:alert(1)")).toBe(false);
    expect(isLocalFileRef("src/a.ts")).toBe(false);
  });
});

function render(md: string, cwd = WIN_CWD): string {
  return renderToStaticMarkup(
    createElement(FileLinkProvider, { value: { workspaceId: "wks_1", cwd } }, createElement(Markdown, null, md)),
  );
}

describe("Markdown links — Windows paths", () => {
  test("[x](C:\\repo\\file.ts) inside the workspace links to the Files browser", () => {
    const html = render("[open](C:\\repo\\src\\file.ts)");
    expect(html).toContain('href="/wks_1/files?path=src%2Ffile.ts"');
  });

  test("[x](file:///C:/repo/file.ts) inside the workspace links to the Files browser", () => {
    const html = render("[open](file:///C:/repo/file.ts)");
    expect(html).toContain('href="/wks_1/files?path=file.ts"');
  });

  test("a local-file link outside the workspace renders as plain text — never an OS-openable href", () => {
    const html = render("[run me](file:///C:/Windows/System32/calc.exe)");
    expect(html).not.toContain('href="file:');
    expect(html).not.toContain("<a");
    expect(html).toContain("run me");
  });

  test("javascript: hrefs are still stripped by the default sanitiser", () => {
    const html = render("[x](javascript:alert(1))");
    expect(html).not.toContain("javascript:");
  });

  test("an inline-code Windows path inside the workspace is linkified", () => {
    const html = render("see `C:\\repo\\src\\file.ts`");
    expect(html).toContain('href="/wks_1/files?path=src%2Ffile.ts"');
  });
});
