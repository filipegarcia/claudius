import { test, expect, type Page } from "../helpers/test";
import { activateClaudiusWorkspace } from "./helpers/workspace";

/**
 * The Git page's pop-out file window, `/<ws>/git/file?path=…&mode=…`
 * (`app/[workspaceId]/git/file/page.tsx`). A client page since N03a
 * (rust/parity/server-components.md § 3 row 5): the workspace id comes from
 * the pathname, `path` and `mode` from `useSearchParams()`.
 *
 * `git status` and the diff are stubbed so the window shows a fixed change
 * set, whatever the e2e workspace's real tree holds. The partially staged
 * file is `MD` (staged edit, deleted in the work tree): it gets the
 * staged/unstaged toggle, and nothing on disk for the editor to load.
 */

const STATUS = {
  isRepo: true,
  repoRoot: "/tmp/e2e-git-file-window",
  branch: "e2e-branch",
  ahead: 0,
  behind: 0,
  files: [
    { path: "src/partial.ts", index: "M", worktree: "D", untracked: false },
    { path: "src/new.ts", index: "?", worktree: "?", untracked: true },
  ],
};

async function claudiusWorkspaceId(page: Page): Promise<string> {
  await activateClaudiusWorkspace(page);
  const list = (await page.request.get("/api/workspaces").then((r) => r.json())) as {
    workspaces: Array<{ id: string; name: string; rootPath: string }>;
  };
  const ws =
    list.workspaces.find((w) => w.name === "claudius") ??
    list.workspaces.find((w) => w.rootPath === process.cwd());
  if (!ws) throw new Error("no claudius workspace");
  return ws.id;
}

/** Stub status + diff for `ws`; returns the diff requests' query params, in order. */
async function stubGit(page: Page, ws: string): Promise<URLSearchParams[]> {
  const diffs: URLSearchParams[] = [];
  await page.route(`**/api/workspaces/${ws}/git/status`, (route) =>
    route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify(STATUS) }),
  );
  await page.route(`**/api/workspaces/${ws}/git/diff*`, (route) => {
    diffs.push(new URL(route.request().url()).searchParams);
    return route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify({ diff: "", binary: false }),
    });
  });
  return diffs;
}

test.describe("git file window", () => {
  test("opens the file and mode named in the query, for the workspace in the path", async ({ page }) => {
    const ws = await claudiusWorkspaceId(page);
    const diffs = await stubGit(page, ws);

    await page.goto(`/${ws}/git/file?path=${encodeURIComponent("src/partial.ts")}&mode=worktree`);
    await expect(page.getByText("e2e-branch", { exact: true })).toBeVisible();
    await expect(page.getByTitle("src/partial.ts", { exact: true })).toBeVisible();
    const toggle = page.getByTestId("diff-mode-toggle");
    await expect(toggle.getByRole("tab", { name: /Unstaged/ })).toHaveAttribute("aria-selected", "true");
    await expect(toggle.getByRole("tab", { name: /Staged · HEAD/ })).toHaveAttribute("aria-selected", "false");
    await expect.poll(() => diffs.at(-1)?.get("mode")).toBe("worktree");
    expect(diffs.at(-1)?.get("path")).toBe("src/partial.ts");

    // The other side of the partial stage.
    await page.goto(`/${ws}/git/file?path=${encodeURIComponent("src/partial.ts")}&mode=staged`);
    await expect(
      page.getByTestId("diff-mode-toggle").getByRole("tab", { name: /Staged · HEAD/ }),
    ).toHaveAttribute("aria-selected", "true");
    await expect.poll(() => diffs.at(-1)?.get("mode")).toBe("staged");
  });

  test("falls back to the file's natural group when the mode is missing or doesn't apply", async ({ page }) => {
    const ws = await claudiusWorkspaceId(page);
    const diffs = await stubGit(page, ws);

    // No mode: a staged edit opens staged.
    await page.goto(`/${ws}/git/file?path=${encodeURIComponent("src/partial.ts")}`);
    await expect(
      page.getByTestId("diff-mode-toggle").getByRole("tab", { name: /Staged · HEAD/ }),
    ).toHaveAttribute("aria-selected", "true");
    await expect.poll(() => diffs.at(-1)?.get("mode")).toBe("staged");

    // `staged` doesn't apply to an untracked file.
    await page.goto(`/${ws}/git/file?path=${encodeURIComponent("src/new.ts")}&mode=staged`);
    await expect(page.getByText("Untracked · /dev/null → working")).toBeVisible();
    await expect.poll(() => diffs.at(-1)?.get("mode")).toBe("untracked");
  });

  test("without a path it says so", async ({ page }) => {
    const ws = await claudiusWorkspaceId(page);
    await stubGit(page, ws);
    await page.goto(`/${ws}/git/file`);
    await expect(page.getByText("No file specified.")).toBeVisible();
  });
});
