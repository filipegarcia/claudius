/**
 * CC 2.1.301 parity —
 *  - "Fixed the Read tool reading binary files such as .xlsm, .parquet, .epub
 *    and .heic as text": the Files viewer showed binaries as garbled
 *    read-only text. It now shows a "Binary file — not shown as text"
 *    placeholder.
 *  - "Fixed Grep and Glob reporting no matches when the search program failed
 *    unexpectedly before returning any results": the Files search answered
 *    "No files match." when it couldn't read the folder at all. It now says
 *    the search failed.
 *
 * Both are driven for real against a scratch workspace: a ZIP-headed .xlsm,
 * and a workspace root made unreadable after the tree has loaded.
 *
 * Screenshot targets: docs/cc-parity/2.1.301/files-binary.png,
 *                     docs/cc-parity/2.1.301/files-search-failed.png
 */

import { chmodSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { test, expect, type Page } from "../helpers/test";

const SHOTS_DIR = resolve(process.cwd(), "docs/cc-parity/2.1.301");
mkdirSync(SHOTS_DIR, { recursive: true });

// ZIP local-file header + some deflate-ish bytes: what an .xlsm starts with.
const XLSM_BYTES = Buffer.concat([
  Buffer.from([0x50, 0x4b, 0x03, 0x04, 0x14, 0x00, 0x06, 0x00, 0x08, 0x00, 0x00, 0x00, 0x21, 0x00]),
  Buffer.from("[Content_Types].xml", "latin1"),
  Buffer.from(Array.from({ length: 2048 }, (_, i) => (i * 37) % 256)),
]);

async function withScratchWorkspace(page: Page, baseURL: string | undefined, body: (wsId: string, root: string) => Promise<void>) {
  const root = mkdtempSync(join(tmpdir(), "claudius-files-binary-"));
  writeFileSync(join(root, "budget-2026.xlsm"), XLSM_BYTES);
  writeFileSync(join(root, "README.md"), "# Quarterly numbers\n\nSee budget-2026.xlsm.\n");
  const r = await page.request.post(`${baseURL}/api/workspaces`, {
    data: { name: `files-binary-${Date.now()}`, rootPath: root },
  });
  expect(r.ok(), "creating scratch workspace").toBeTruthy();
  const ws = (await r.json()) as { id: string };
  try {
    await page.request.post(`${baseURL}/api/workspaces/${ws.id}/select`);
    await body(ws.id, root);
  } finally {
    chmodSync(root, 0o755);
    const list = (await page.request
      .get(`${baseURL}/api/workspaces`)
      .then((res) => res.json())
      .catch(() => ({ workspaces: [] }))) as { workspaces: Array<{ id: string; name: string }> };
    const claudius = list.workspaces.find((w) => w.name === "claudius");
    if (claudius) await page.request.post(`${baseURL}/api/workspaces/${claudius.id}/select`).catch(() => {});
    await page.request.delete(`${baseURL}/api/workspaces/${ws.id}`).catch(() => {});
    rmSync(root, { recursive: true, force: true });
  }
}

test("a binary .xlsm shows a placeholder instead of garbled text", async ({ page, baseURL }) => {
  await withScratchWorkspace(page, baseURL, async (wsId) => {
    await page.goto(`/${wsId}/files`);
    await page.locator("aside").getByRole("button", { name: "budget-2026.xlsm" }).click({ timeout: 15_000 });

    const placeholder = page.getByTestId("files-binary-placeholder");
    await expect(placeholder).toBeVisible({ timeout: 15_000 });
    await expect(placeholder).toContainText("Binary file — not shown as text");
    await expect(placeholder).toContainText("budget-2026.xlsm");
    await expect(page.locator("#files-editor-textarea")).toHaveCount(0);
    await expect(page.getByTestId("files-save")).toBeDisabled();

    await page.waitForTimeout(200);
    await page.screenshot({ path: resolve(SHOTS_DIR, "files-binary.png"), fullPage: false });

    // A text file next to it still opens in the editor.
    await page.locator("aside").getByRole("button", { name: "README.md" }).click();
    await expect(page.locator("#files-editor-textarea")).toHaveValue(/Quarterly numbers/);
    await expect(page.getByTestId("files-binary-placeholder")).toHaveCount(0);
  });
});

test("a search that can't read the folder says it failed, not 'No files match.'", async ({ page, baseURL }) => {
  test.skip(process.getuid?.() === 0, "chmod 000 doesn't block root");
  await withScratchWorkspace(page, baseURL, async (wsId, root) => {
    await page.goto(`/${wsId}/files`);
    await expect(page.locator("aside").getByRole("button", { name: "README.md" })).toBeVisible({ timeout: 15_000 });

    // The folder becomes unreadable after the tree loaded (e.g. a revoked
    // macOS privacy grant, a remounted volume).
    chmodSync(root, 0o000);
    await page.getByLabel("Search files").fill("budget");

    const err = page.getByTestId("file-search-error");
    await expect(err).toBeVisible({ timeout: 15_000 });
    await expect(err).toContainText("Search failed: permission denied");
    await expect(page.getByText("No files match.")).toHaveCount(0);

    await page.waitForTimeout(200);
    await page.screenshot({ path: resolve(SHOTS_DIR, "files-search-failed.png"), fullPage: false });

    // Readable again → the same search finds the file.
    chmodSync(root, 0o755);
    await page.getByLabel("Search files").fill("budget-");
    await expect(page.locator("aside").getByText("budget-2026.xlsm")).toBeVisible({ timeout: 15_000 });
    await expect(page.getByTestId("file-search-error")).toHaveCount(0);
  });
});
