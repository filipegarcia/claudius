import { test, expect } from "../helpers/test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

/**
 * Workspace rail tiles show their direct-jump number.
 *
 * `workspace.go1..go9` (⌘⌥1–9 / Ctrl+Alt+1–9) jump to the workspace at that
 * position in the rail. The chord used to be discoverable only from the hover
 * label; each of the first nine tiles now carries a small number chip
 * (`workspace-shortcut-number-<id>`) in its bottom-right corner. Tiles past
 * the ninth have no chord, so they get no chip.
 *
 * The test seeds enough scratch workspaces to push the rail past nine tiles,
 * then checks the chips read 1..9 in rail order and stop there. The chip is
 * aria-hidden, so it must not leak into the tile button's accessible name.
 */
test.describe("Workspace rail — shortcut numbers", () => {
  test("first nine tiles are numbered 1–9 in rail order; the rest are not", async ({
    page,
    baseURL,
  }, testInfo) => {
    test.setTimeout(90_000);

    const created: Array<{ id: string; dir: string }> = [];
    try {
      // Ten scratch workspaces guarantees at least ten tiles regardless of
      // what the run's sandboxed HOME already holds.
      for (let i = 0; i < 10; i++) {
        const dir = mkdtempSync(join(tmpdir(), "claudius-ws-num-"));
        const res = await page.request.post(`${baseURL}/api/workspaces`, {
          data: { name: `ws-num-${i}-${Date.now()}`, rootPath: dir },
        });
        expect(res.ok(), `creating scratch workspace ${i}`).toBeTruthy();
        const ws = (await res.json()) as { id: string };
        created.push({ id: ws.id, dir });
      }

      await page.goto("/");
      const rail = page.locator('[data-pane-name="workspace-switcher"]');
      const chips = rail.locator('[data-testid^="workspace-shortcut-number-"]');

      await expect(chips).toHaveCount(9);
      await expect(chips).toHaveText(["1", "2", "3", "4", "5", "6", "7", "8", "9"]);

      // Each chip sits on its own tile: the tile's tooltip names the same
      // position's chord, so the number and the shortcut can't drift apart.
      for (let n = 1; n <= 9; n++) {
        const tileButton = chips.nth(n - 1).locator("xpath=ancestor::button[1]");
        await expect(tileButton).toHaveAttribute("title", new RegExp(`Shortcut: .*${n}$`, "m"));
        // aria-hidden keeps the digit out of the accessible name.
        await expect(tileButton).not.toHaveAccessibleName(new RegExp(`\\b${n}$`));
      }

      // A tile past the ninth (one of ours, since they were appended last)
      // has no chord and therefore no chip.
      const last = created[created.length - 1];
      await expect(rail.getByTestId(`workspace-shortcut-number-${last.id}`)).toHaveCount(0);

      await rail.screenshot({ path: testInfo.outputPath("workspace-rail-numbers.png") });
    } finally {
      // Re-pin claudius active before deleting, same as the other workspace
      // specs, so the server's fallback choice stays deterministic.
      const list = await page.request
        .get(`${baseURL}/api/workspaces`)
        .then((r) => r.json() as Promise<{ workspaces: Array<{ id: string; name: string }> }>)
        .catch(() => ({ workspaces: [] as Array<{ id: string; name: string }> }));
      const claudius = list.workspaces.find((w) => w.name === "claudius");
      if (claudius) {
        await page.request.post(`${baseURL}/api/workspaces/${claudius.id}/select`).catch(() => {});
      }
      for (const { id, dir } of created) {
        await page.request.delete(`${baseURL}/api/workspaces/${id}`).catch(() => {});
        try {
          rmSync(dir, { recursive: true, force: true });
        } catch {
          // non-fatal
        }
      }
    }
  });
});
