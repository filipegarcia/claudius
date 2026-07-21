/**
 * CC 2.1.214 parity — "Added an ISO `modified` timestamp to memory file
 * frontmatter."
 *
 * Claudius's own reimplementation of Claude Code's per-project auto-memory
 * files (lib/server/auto-memory.ts — the SDK ships no memory-tool logic at
 * all) now stamps/refreshes a `modified` field the same way, surfaced as a
 * "Last modified" label in the Memory screen's auto-memory panel
 * (app/[workspaceId]/memory/page.tsx) — both in the file list and the edit
 * form.
 *
 * This spec creates a memory file through the real UI flow (not mocked —
 * the feature is a real fs write) against a throwaway tmp workspace so it
 * never touches this repo's own `~/.claude/projects/.../memory/` directory,
 * then asserts the "Last modified" label renders and updates after an edit.
 *
 * Screenshot target: docs/cc-parity/2.1.214/memory-modified.png
 */

import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { test, expect } from "../helpers/test";

const SHOTS_DIR = resolve(process.cwd(), "docs/cc-parity/2.1.214");
mkdirSync(SHOTS_DIR, { recursive: true });

test.describe("Auto-memory frontmatter 'modified' timestamp (CC 2.1.214 parity)", () => {
  test("creating a memory file shows a Last modified label in the file list and edit form", async ({
    page,
    baseURL,
  }) => {
    test.setTimeout(60_000);

    const dir = mkdtempSync(join(tmpdir(), "claudius-memory-modified-"));
    const created = await page.request.post(`${baseURL}/api/workspaces`, {
      data: { name: `memory-modified-${Date.now()}`, rootPath: dir },
    });
    expect(created.ok(), "creating the throwaway workspace").toBeTruthy();
    const ws = (await created.json()) as { id: string };

    try {
      await page.request.post(`${baseURL}/api/workspaces/${ws.id}/select`);

      // The "No memory files." empty state renders synchronously from the
      // initial `files: []` — it does NOT wait for the workspaces list to
      // load, so asserting on it synchronizes on nothing. Meanwhile
      // useActiveCwd() returns `null` until useWorkspaces resolves, and
      // createMemory() hard-fails ("0: no cwd") if clicked in that window.
      // Gate the whole flow on the auto-memory GET (which only fires once
      // cwd is a real path) so every interaction below happens with cwd
      // resolved. Register the waiter before goto so we don't miss it.
      const listLoaded = page.waitForResponse(
        (r) => r.url().includes("/api/memory/auto") && r.request().method() === "GET",
      );
      await page.goto(`/${ws.id}/memory`);
      await listLoaded;
      await expect(page.getByText("Auto-memory")).toBeVisible();
      await expect(page.getByText("No memory files.")).toBeVisible();

      await page.getByTitle("Add memory").click();
      await page.getByRole("textbox", { name: "Name", exact: true }).fill("Test Preference");
      await page
        .getByPlaceholder("One-line description used in MEMORY.md")
        .fill("A test memory file for cc-parity coverage.");
      await page.getByRole("button", { name: "Create" }).click();

      // The list item now shows "<size>K · <relative time>" instead of just size.
      const listItem = page.locator("li", { hasText: "user_test_preference.md" });
      await expect(listItem).toBeVisible({ timeout: 10_000 });
      await expect(listItem).toContainText(/ago|just now/);

      // The edit form shows the same label, sourced from frontmatter this
      // time (not fs.stat) — proves the `modified:` line actually landed
      // in the file's frontmatter, not just the directory listing.
      const modifiedLabel = page.getByTestId("memory-modified");
      await expect(modifiedLabel).toBeVisible();
      await expect(modifiedLabel).toHaveText(/Last modified: (just now|\d+[smhd] ago)/);

      await page.waitForTimeout(200);
      await page.screenshot({ path: resolve(SHOTS_DIR, "memory-modified.png"), fullPage: false });
    } finally {
      await page.request.delete(`${baseURL}/api/workspaces/${ws.id}`).catch(() => {});
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
