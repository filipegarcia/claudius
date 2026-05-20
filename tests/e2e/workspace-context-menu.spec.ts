import { test, expect, type Page } from "../helpers/test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

/**
 * Right-click context menu on a workspace tile in the left rail.
 *
 * The feature lives in `components/workspaces/WorkspaceContextMenu.tsx`. This
 * test pins down the most behaviour-bearing path through it:
 *
 *   1. Create a scratch workspace with a known letter-icon color.
 *   2. Right-click its tile → the popover surfaces with the workspace name
 *      and a row of color swatches.
 *   3. Click a different swatch → the menu closes and the workspace's icon
 *      color is updated server-side (visible via the public GET endpoint).
 *
 * Cleanup follows the same pattern as `workspace-route-memory.spec.ts` —
 * pin claudius active before deleting the scratch workspace so the server's
 * "fall back to first remaining workspace" choice stays deterministic.
 */
test.describe("Workspace tile — right-click context menu", () => {
  test("right-click → color swatch persists a new icon color", async ({
    page,
    baseURL,
  }) => {
    test.setTimeout(60_000);

    const dir = mkdtempSync(join(tmpdir(), "claudius-ws-ctx-"));
    const startingColor = "#d97757"; // first palette color — known starting point
    const targetColor = "#5588dd"; // second palette swatch in the menu

    const createRes = await page.request.post(`${baseURL}/api/workspaces`, {
      data: {
        name: `ctx-menu-${Date.now()}`,
        rootPath: dir,
        // Explicit icon so the test isn't at the mercy of the id-hash color
        // picker in `defaultLetterIcon` — we need to *know* the starting
        // color so we can pick a different swatch for the assertion.
        icon: { kind: "letter", letter: "C", color: startingColor },
      },
    });
    expect(createRes.ok(), "creating scratch workspace").toBeTruthy();
    const ws = (await createRes.json()) as { id: string; name: string };

    try {
      await page.goto("/");

      // Tile lookup mirrors `workspace-route-memory.spec.ts`: the rail's
      // tile carries a `title` attribute starting with the workspace name.
      const tile = await findWorkspaceTile(page, ws.id);
      await expect(tile).toBeVisible();

      // Right-click the tile. Playwright's `{ button: "right" }` fires a
      // real `contextmenu` event, which is what our handler listens for.
      await tile.click({ button: "right" });

      const menu = page.getByTestId(`workspace-context-menu-${ws.id}`);
      await expect(menu).toBeVisible();
      // The header in the popover shows the workspace name — confirms we
      // wired the right workspace into the panel.
      await expect(menu).toContainText(ws.name);

      // Click the swatch for the target color. The button is rendered with
      // `aria-label="Use color #XXXXXX"` so a screen reader and Playwright
      // both have a stable hook.
      const swatch = menu.getByLabel(`Use color ${targetColor}`);
      await expect(swatch).toBeVisible();
      await swatch.click();

      // Closing is part of the contract — the `onClick` chains `.finally(onClose)`
      // on the PATCH so the menu disappears whether the request succeeded or
      // not. We assert it here instead of just trusting the API check below.
      await expect(menu).toBeHidden();

      // Authoritative check: the server now reports the new color. Polling
      // (with the default expect.timeout) covers the optimistic-update +
      // refresh round-trip in `useWorkspaces.update`.
      await expect
        .poll(
          async () => {
            const r = await page.request.get(`${baseURL}/api/workspaces/${ws.id}`);
            if (!r.ok()) return null;
            const data = (await r.json()) as {
              icon: { kind: string; color?: string };
            };
            return data.icon.kind === "letter" ? data.icon.color : null;
          },
          {
            message: "workspace icon color should update after swatch click",
          },
        )
        .toBe(targetColor);
    } finally {
      // Re-pin claudius active so deleting the scratch workspace can't leave
      // the server pointed at it. Same pattern as the route-memory spec.
      const list = await page.request
        .get(`${baseURL}/api/workspaces`)
        .then(
          (r) =>
            r.json() as Promise<{
              workspaces: Array<{ id: string; name: string }>;
            }>,
        )
        .catch(() => ({
          workspaces: [] as Array<{ id: string; name: string }>,
        }));
      const claudius = list.workspaces.find((w) => w.name === "claudius");
      if (claudius) {
        await page.request
          .post(`${baseURL}/api/workspaces/${claudius.id}/select`)
          .catch(() => {});
      }

      if (ws?.id) {
        await page.request
          .delete(`${baseURL}/api/workspaces/${ws.id}`)
          .catch(() => {});
      }

      try {
        rmSync(dir, { recursive: true, force: true });
      } catch {
        // ignore — non-fatal
      }
    }
  });
});

/**
 * Resolve a workspace tile in the left rail by id. Tiles have a `title`
 * attribute that begins with the workspace name (followed by the rootPath
 * and a drag hint). We look up the name from /api/workspaces first because
 * the test creates a workspace with a unique-per-run name.
 */
async function findWorkspaceTile(page: Page, id: string) {
  const list = await page.request
    .get("/api/workspaces")
    .then(
      (r) =>
        r.json() as Promise<{
          workspaces: Array<{ id: string; name: string }>;
        }>,
    );
  const ws = list.workspaces.find((w) => w.id === id);
  if (!ws) throw new Error(`workspace ${id} not found in /api/workspaces`);
  const escaped = ws.name.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  return page.getByTitle(new RegExp(`^${escaped}(\\n|$)`)).first();
}
