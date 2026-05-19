import { test, expect, type Page } from "@playwright/test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

/**
 * Per-workspace route memory: clicking a workspace tile should return
 * the user to the last URL they were on *inside that workspace*, not the
 * chat home, and not the path they happen to be on under the previous
 * workspace's cwd.
 *
 * Concrete flow this test pins down:
 *   1. Be in workspace A, navigate to /git.
 *   2. Click workspace B's tile → land in B (its lastPath is unset, so
 *      `/` is the natural fallback).
 *   3. Navigate to /files inside B.
 *   4. Click workspace A's tile → must land back on /git (A's last URL).
 *
 * The two-workspace setup mirrors `workspace-cwd-binding.spec.ts` — same
 * cleanup pattern so a failing assertion doesn't litter scratch
 * workspaces into the live switcher rail.
 */
test.describe("Workspace switch — per-workspace route memory", () => {
  test("clicking a workspace tile returns to its last-visited URL", async ({
    page,
    baseURL,
  }) => {
    test.setTimeout(60_000);

    const dirA = mkdtempSync(join(tmpdir(), "claudius-ws-route-A-"));
    const dirB = mkdtempSync(join(tmpdir(), "claudius-ws-route-B-"));

    const create = async (name: string, root: string) => {
      const r = await page.request.post(`${baseURL}/api/workspaces`, {
        data: { name, rootPath: root },
      });
      expect(r.ok(), `creating workspace ${name}`).toBeTruthy();
      return (await r.json()) as { id: string };
    };
    const wsA = await create(`route-test-A-${Date.now()}`, dirA);
    const wsB = await create(`route-test-B-${Date.now()}`, dirB);

    const selectViaApi = async (id: string) => {
      const r = await page.request.post(`${baseURL}/api/workspaces/${id}/select`);
      expect(r.ok(), "selecting workspace via API").toBeTruthy();
    };

    try {
      // Step 1: activate A, open /git. The tracker effect in the
      // WorkspaceSwitcher fires on mount with (activeId=A, pathname=/git)
      // and writes "/git" under A in localStorage.
      await selectViaApi(wsA.id);
      await page.goto("/git");
      await expect(page).toHaveURL(/\/git$/);

      // Sanity: the tracker has actually written /git under A. Doing this
      // before the workspace switch avoids a race where we click B's tile
      // before the effect has flushed.
      await page.waitForFunction(
        (id) => {
          try {
            const raw = window.localStorage.getItem(
              "claudius.workspace.lastPath",
            );
            if (!raw) return false;
            const map = JSON.parse(raw) as Record<string, unknown>;
            return map[id] === "/git";
          } catch {
            return false;
          }
        },
        wsA.id,
        { timeout: 5_000 },
      );

      // Step 2: click B's tile from the rail. `select(id)` will navigate
      // to B's last URL (unset → workspace root), which is a full document
      // load. Workspace-scoped URLs now carry the workspace id as a prefix
      // (see `middleware.ts` + `app/[workspaceId]/`), so the chat root for
      // B is `/<B.id>` rather than `/`.
      const tileForB = await findWorkspaceTile(page, wsB.id);
      await tileForB.click();
      await expect(page).toHaveURL(new RegExp(`/${wsB.id}/?$`), {
        timeout: 10_000,
      });

      // Step 3: navigate to /files inside B. After the page renders, the
      // tracker writes "/files" under B.
      await page.goto("/files");
      await expect(page).toHaveURL(/\/files$/);
      await page.waitForFunction(
        (id) => {
          try {
            const raw = window.localStorage.getItem(
              "claudius.workspace.lastPath",
            );
            if (!raw) return false;
            const map = JSON.parse(raw) as Record<string, unknown>;
            return map[id] === "/files";
          } catch {
            return false;
          }
        },
        wsB.id,
        { timeout: 5_000 },
      );

      // Step 4: click A's tile. This is the assertion that owns the bug
      // fix — before the change, this landed on `/files` (legacy reload)
      // or `/` (legacy customize fallback), never the workspace's actual
      // last URL.
      const tileForA = await findWorkspaceTile(page, wsA.id);
      await tileForA.click();
      await expect(page).toHaveURL(/\/git$/, { timeout: 10_000 });
    } finally {
      // Pin claudius active before deleting the scratch workspaces — if A
      // or B were active when deleted, the server falls back to "the
      // first remaining workspace," which is non-deterministic.
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

      for (const id of [wsA?.id, wsB?.id]) {
        if (!id) continue;
        await page.request
          .delete(`${baseURL}/api/workspaces/${id}`)
          .catch(() => {});
      }

      // Drop the localStorage keys for the deleted workspaces so a re-run
      // doesn't see stale data in the switcher's tracker — best-effort.
      await page
        .evaluate(
          ({ a, b }) => {
            try {
              const raw = window.localStorage.getItem(
                "claudius.workspace.lastPath",
              );
              if (!raw) return;
              const map = JSON.parse(raw) as Record<string, unknown>;
              delete map[a];
              delete map[b];
              window.localStorage.setItem(
                "claudius.workspace.lastPath",
                JSON.stringify(map),
              );
            } catch {
              // ignore — non-fatal
            }
          },
          { a: wsA.id, b: wsB.id },
        )
        .catch(() => {});

      for (const dir of [dirA, dirB]) {
        try {
          rmSync(dir, { recursive: true, force: true });
        } catch {
          // ignore
        }
      }
    }
  });
});

/**
 * The leftmost workspace switcher renders one tile per workspace. Tiles
 * have a `title` attribute that starts with the workspace name (then
 * "\n<rootPath>\nDrag to reorder"). Resolve by id via the API, then
 * locate by name.
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
