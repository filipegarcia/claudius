import { describe, expect, test } from "vitest";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { Markdown } from "@/components/chat/Markdown";
import { FileLinkProvider } from "@/lib/client/file-link-context";
import { linkHrefWorkspacePath } from "@/lib/client/file-paths";

/**
 * CC 2.1.332 — "[VSCode] Fixed most links to files without an extension, to
 * folders, and with a line and column doing nothing".
 *
 * `MarkdownLink` only routed an href to the Files view when it had a known
 * file extension; `[Makefile](Makefile)` or `[lib](src/lib/)` became an
 * `<a target="_blank">` to a relative URL — a new tab on an app route that
 * doesn't exist.
 */
const CWD = "/Users/me/repo";

describe("linkHrefWorkspacePath", () => {
  test("extensionless files, folders and line/column suffixes resolve", () => {
    expect(linkHrefWorkspacePath("Makefile", CWD)).toBe("Makefile");
    expect(linkHrefWorkspacePath("./LICENSE:3", CWD)).toBe("LICENSE");
    expect(linkHrefWorkspacePath("bin/claudius:12:4", CWD)).toBe("bin/claudius");
    expect(linkHrefWorkspacePath("src/lib/", CWD)).toBe("src/lib");
    expect(linkHrefWorkspacePath("src/lib", CWD)).toBe("src/lib");
    expect(linkHrefWorkspacePath("/Users/me/repo/scripts", CWD)).toBe("scripts");
    expect(linkHrefWorkspacePath("src/app.ts:42", CWD)).toBe("src/app.ts");
  });

  test("percent-escapes in the href are decoded", () => {
    expect(linkHrefWorkspacePath("docs/my%20notes", CWD)).toBe("docs/my notes");
    expect(linkHrefWorkspacePath("docs/%E0%A4%A", CWD)).toBeNull(); // malformed
  });

  test("local file refs still resolve inside the workspace only", () => {
    expect(linkHrefWorkspacePath("file:///Users/me/repo/Dockerfile", CWD)).toBe("Dockerfile");
    expect(linkHrefWorkspacePath("C:%5Crepo%5CMakefile", "C:\\repo")).toBe("Makefile");
    expect(linkHrefWorkspacePath("file:///etc/hosts", CWD)).toBeNull();
  });

  test("URLs, anchors, queries and escapes are not workspace paths", () => {
    for (const href of [
      "https://example.com/Makefile",
      "mailto:me@example.com",
      "vscode://file/x",
      "data:text/plain,hi",
      "//cdn.example.com/x",
      "#install",
      "README#install",
      "search?q=1",
      "../outside",
      "src/../../outside",
      "~/notes",
      "@scope/pkg",
      "/etc/hosts",
      "/Users/me/repo",
    ]) {
      expect(linkHrefWorkspacePath(href, CWD), href).toBeNull();
    }
  });
});

function render(md: string): string {
  return renderToStaticMarkup(
    createElement(FileLinkProvider, { value: { workspaceId: "wks_1", cwd: CWD } }, createElement(Markdown, null, md)),
  );
}

describe("Markdown links", () => {
  test("[Makefile](Makefile), [lib](src/lib/) and [LICENSE](./LICENSE:3) open in the Files view", () => {
    const html = render("See [Makefile](Makefile), [lib](src/lib/) and [LICENSE](./LICENSE:3).");
    expect(html).toContain('href="/wks_1/files?path=Makefile"');
    expect(html).toContain('href="/wks_1/files?path=src%2Flib"');
    expect(html).toContain('href="/wks_1/files?path=LICENSE"');
    expect(html).not.toContain('target="_blank"');
  });

  test("web links and anchors still open as before", () => {
    const html = render("[docs](https://example.com/docs) and [top](#top) and [mail](mailto:me@example.com)");
    expect(html).toContain('href="https://example.com/docs" target="_blank"');
    expect(html).toContain('href="#top" target="_blank"');
    expect(html).toContain('href="mailto:me@example.com" target="_blank"');
    expect(html).not.toContain("/wks_1/files");
  });

  test("without a workspace, a relative link is left alone", () => {
    const html = renderToStaticMarkup(createElement(Markdown, null, "[Makefile](Makefile)"));
    expect(html).toContain('href="Makefile" target="_blank"');
  });
});
