/**
 * Claude Code 2.1.299 parity — "Fixed Read garbling UTF-16LE files with a
 * byte-order mark, and Write dropping byte-order marks or silently converting
 * Windows-1252, Shift-JIS, GBK or UTF-16BE files to UTF-8 (now refused)".
 *
 * Claudius's Files browser reads/writes through `GET/PUT
 * /api/workspaces/:id/files`, which used to assume UTF-8 both ways. This spec
 * seeds a scratch workspace with a Windows-1252 file and a UTF-16LE+BOM file:
 *   - the cp1252 one opens read-only (amber banner, Save disabled, editor
 *     not editable) with a readable preview;
 *   - the UTF-16LE one decodes correctly, shows its encoding chip, and has no
 *     read-only banner.
 *
 * Screenshot target: docs/cc-parity/2.1.299/files-encoding-readonly.png
 */

import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { test, expect, type Page } from "../helpers/test";

const SHOTS_DIR = resolve(process.cwd(), "docs/cc-parity/2.1.299");
mkdirSync(SHOTS_DIR, { recursive: true });

// "café au lait" with a lone 0xE9 — valid Windows-1252, invalid UTF-8.
const CP1252_BYTES = Buffer.concat([
  Buffer.from("caf", "latin1"),
  Buffer.from([0xe9]),
  Buffer.from(" au lait\n", "latin1"),
]);
const UTF16_TEXT = "héllo wörld\n";
const UTF16LE_BYTES = Buffer.concat([Buffer.from([0xff, 0xfe]), Buffer.from(UTF16_TEXT, "utf16le")]);

async function withScratchWorkspace(
  page: Page,
  baseURL: string | undefined,
  body: (wsId: string) => Promise<void>,
) {
  const root = mkdtempSync(join(tmpdir(), "claudius-files-encoding-"));
  writeFileSync(join(root, "legacy-cp1252.txt"), CP1252_BYTES);
  writeFileSync(join(root, "notes-utf16le.txt"), UTF16LE_BYTES);
  const r = await page.request.post(`${baseURL}/api/workspaces`, {
    data: { name: `files-encoding-${Date.now()}`, rootPath: root },
  });
  expect(r.ok(), "creating scratch workspace").toBeTruthy();
  const ws = (await r.json()) as { id: string };
  try {
    await page.request.post(`${baseURL}/api/workspaces/${ws.id}/select`);
    await body(ws.id);
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
    rmSync(root, { recursive: true, force: true });
  }
}

test("a Windows-1252 file opens read-only; a UTF-16LE file decodes and stays editable", async ({
  page,
  baseURL,
}) => {
  await withScratchWorkspace(page, baseURL, async (wsId) => {
    await page.goto(`/${wsId}/files`);
    const tree = page.locator("aside");

    // --- Windows-1252: read-only banner, Save disabled, preview readable.
    await tree.getByRole("button", { name: "legacy-cp1252.txt" }).click({ timeout: 15_000 });
    const banner = page.getByTestId("files-encoding-readonly");
    await expect(banner).toBeVisible({ timeout: 15_000 });
    await expect(banner).toContainText("Read-only");
    await expect(banner).toContainText("Windows-1252");
    await expect(page.getByTestId("files-save")).toBeDisabled();
    const editor = page.locator("#files-editor-textarea");
    await expect(editor).toHaveValue("café au lait\n");
    await expect(editor).toHaveAttribute("readonly", "");

    // Neither typing nor the editor's own Enter/Backspace handling edits it.
    await editor.click();
    await page.keyboard.type("x");
    await page.keyboard.press("Enter");
    await page.keyboard.press("Backspace");
    await expect(editor).toHaveValue("café au lait\n");
    await expect(page.getByTestId("files-dirty")).toHaveCount(0);

    await page.waitForTimeout(200);
    await page.screenshot({ path: resolve(SHOTS_DIR, "files-encoding-readonly.png"), fullPage: true });

    // --- UTF-16LE + BOM: decoded text, encoding chip, no banner, editable.
    await tree.getByRole("button", { name: "notes-utf16le.txt" }).click();
    await expect(page.getByTestId("files-encoding-badge")).toHaveText("UTF-16LE");
    await expect(page.locator("#files-editor-textarea")).toHaveValue(UTF16_TEXT);
    await expect(page.getByTestId("files-encoding-readonly")).toHaveCount(0);
    await expect(page.locator("#files-editor-textarea")).not.toHaveAttribute("readonly", "");
  });
});
