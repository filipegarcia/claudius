import { test, expect, type Page } from "../helpers/test";
import { chmodSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

/**
 * The Files tree used to render a bare blank pane for an empty project
 * folder — and for a folder the server couldn't read, because readdir errors
 * were swallowed into `[]`. Both looked like "Claudius can't read my
 * project". The tree now says what it found, and a sub-folder that fails to
 * list shows the reason inline without blanking its siblings.
 */
test.describe("Files — empty and unreadable folders", () => {
  async function withScratchWorkspace(
    page: Page,
    baseURL: string | undefined,
    seed: (root: string) => void,
    body: (wsId: string, root: string) => Promise<void>,
  ) {
    const root = mkdtempSync(join(tmpdir(), "claudius-files-empty-"));
    seed(root);
    const r = await page.request.post(`${baseURL}/api/workspaces`, {
      data: { name: `files-empty-${Date.now()}`, rootPath: root },
    });
    expect(r.ok(), "creating scratch workspace").toBeTruthy();
    const ws = (await r.json()) as { id: string };
    try {
      await page.request.post(`${baseURL}/api/workspaces/${ws.id}/select`);
      await body(ws.id, root);
    } finally {
      // Re-pin the seeded "claudius" workspace before deleting ours so the
      // server's fallback active workspace stays deterministic for later specs.
      const list = (await page.request
        .get(`${baseURL}/api/workspaces`)
        .then((res) => res.json())
        .catch(() => ({ workspaces: [] }))) as { workspaces: Array<{ id: string; name: string }> };
      const claudius = list.workspaces.find((w) => w.name === "claudius");
      if (claudius) await page.request.post(`${baseURL}/api/workspaces/${claudius.id}/select`).catch(() => {});
      await page.request.delete(`${baseURL}/api/workspaces/${ws.id}`).catch(() => {});
      try {
        chmodSync(join(root, "locked"), 0o755);
      } catch {
        // only the unreadable-folder test creates it
      }
      rmSync(root, { recursive: true, force: true });
    }
  }

  test("an empty project folder says so", async ({ page, baseURL }) => {
    await withScratchWorkspace(page, baseURL, () => {}, async (wsId) => {
      await page.goto(`/${wsId}/files`);
      await expect(page.getByTestId("file-tree-empty")).toHaveText("This folder is empty.", { timeout: 15_000 });
    });
  });

  test("a folder with only hidden entries says how many are hidden", async ({ page, baseURL }) => {
    await withScratchWorkspace(
      page,
      baseURL,
      (root) => {
        mkdirSync(join(root, ".git"));
        writeFileSync(join(root, ".env"), "X=1");
      },
      async (wsId) => {
        await page.goto(`/${wsId}/files`);
        await expect(page.getByTestId("file-tree-empty")).toHaveText("No visible files — 2 hidden items.", {
          timeout: 15_000,
        });
      },
    );
  });

  test("an unreadable sub-folder shows the error inline and keeps the tree", async ({ page, baseURL }) => {
    // chmod 000 doesn't stop root, so this case can't be staged there.
    test.skip(process.getuid?.() === 0, "running as root");
    await withScratchWorkspace(
      page,
      baseURL,
      (root) => {
        mkdirSync(join(root, "locked"));
        writeFileSync(join(root, "locked", "secret.txt"), "x");
        mkdirSync(join(root, "empty-dir"));
        writeFileSync(join(root, "README.md"), "# hi");
        chmodSync(join(root, "locked"), 0o000);
      },
      async (wsId) => {
        await page.goto(`/${wsId}/files`);
        const tree = page.locator("aside");
        await expect(tree.getByRole("button", { name: "README.md" })).toBeVisible({ timeout: 15_000 });

        await tree.getByRole("button", { name: "empty-dir" }).click();
        await expect(tree.getByText("Empty", { exact: true })).toBeVisible();

        await tree.getByRole("button", { name: "locked" }).click();
        await expect(tree.getByText(/Permission denied/)).toBeVisible();
        // The rest of the tree is still there.
        await expect(tree.getByRole("button", { name: "README.md" })).toBeVisible();
      },
    );
  });
});
