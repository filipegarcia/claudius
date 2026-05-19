import { test, expect } from "@playwright/test";

/**
 * Per-workspace SideNav order. Users can drag-reorder the rail icons; the
 * order persists on the workspace record as `navOrder` (a list of stable
 * `actionId`s like "nav.chat", "nav.git").
 *
 * We test the read+persist half of the feature here — PATCH a custom
 * order via the public API, reload, and confirm:
 *   1. The rail renders the saved order (visible DOM order matches).
 *   2. The order survives a full reload (round-trip from disk).
 *
 * The drag handlers themselves are a thin clone of WorkspaceSwitcher's
 * native-HTML5-drag pattern and aren't covered here — Playwright's
 * `dragTo` on HTML5 native drag is flaky and the repo has no working
 * precedent for testing it. Reading the saved order is what makes the
 * feature useful to the user; that's what we pin down.
 */
test.describe("SideNav — per-workspace reorder", () => {
  test("saved navOrder is honored on reload", async ({ page, baseURL }) => {
    test.setTimeout(60_000);

    type WorkspaceSummary = {
      id: string;
      name: string;
      navOrder?: string[];
    };

    // Resolve the active workspace via the API. The e2e harness boots
    // with a single "claudius" workspace under an isolated HOME, but we
    // look it up by `activeId` so the test stays robust even if the boot
    // order changes.
    const initialList = await page.request
      .get(`${baseURL}/api/workspaces`)
      .then(
        (r) =>
          r.json() as Promise<{
            workspaces: WorkspaceSummary[];
            activeId: string | null;
          }>,
      );
    const activeId =
      initialList.activeId ?? initialList.workspaces[0]?.id ?? null;
    expect(activeId, "an active workspace must exist").toBeTruthy();
    const wsId = activeId!;
    const originalNavOrder = initialList.workspaces.find((w) => w.id === wsId)
      ?.navOrder;

    // Pick a deliberate non-default order: Git first, then Files, then
    // Sessions, then Chat. Anything not listed falls back to its default
    // slot — that's part of the merge rule (see `applyNavOrder` in
    // SideNav.tsx).
    const customOrder = ["nav.git", "nav.files", "nav.sessions", "nav.chat"];

    try {
      const patchRes = await page.request.patch(`${baseURL}/api/workspaces/${wsId}`, {
        data: { navOrder: customOrder },
      });
      expect(patchRes.ok(), "PATCH navOrder must succeed").toBeTruthy();

      await page.goto("/", { waitUntil: "load" });
      // Wait for the rail to settle. We key on a tile we know is in the
      // default install — Chat — and confirm its data-testid is present.
      await expect(page.getByTestId("sidenav-tile-nav.chat")).toBeVisible({
        timeout: 10_000,
      });

      // Pull the rendered order of the first four tiles from the DOM.
      // SideNav writes a `data-testid="sidenav-tile-<actionId>"` on each
      // draggable wrapper; their document order IS the visible order
      // because Tailwind's `flex-col` lays them out top-to-bottom and the
      // workspace switcher's tiles use different testids.
      //
      // `expect.poll` covers the gap between the initial render (which
      // uses default order — `useWorkspaces` hasn't fetched yet) and the
      // post-fetch re-render where the saved `navOrder` actually takes
      // effect. Once the client hook resolves, the order matches.
      await expect
        .poll(
          async () =>
            page.evaluate(() => {
              const tiles = Array.from(
                document.querySelectorAll<HTMLElement>(
                  "[data-testid^='sidenav-tile-']",
                ),
              );
              return tiles
                .map((el) => el.dataset.testid!.replace(/^sidenav-tile-/, ""))
                .slice(0, 4);
            }),
          {
            message: "sidenav should re-render in saved order once /api/workspaces resolves",
          },
        )
        .toEqual(customOrder);

      // Round-trip check: the server reports the saved order back.
      const fetched = await page.request
        .get(`${baseURL}/api/workspaces/${wsId}`)
        .then((r) => r.json() as Promise<WorkspaceSummary>);
      expect(fetched.navOrder).toEqual(customOrder);
    } finally {
      // Restore the original navOrder (or clear it if there was none)
      // so the next spec starts from a clean rail. We round-trip through
      // PATCH rather than DELETE because there's no dedicated endpoint
      // for clearing a single field — passing `[]` re-uses the same
      // shape-check codepath and is semantically "no custom order".
      await page.request
        .patch(`${baseURL}/api/workspaces/${wsId}`, {
          data: { navOrder: originalNavOrder ?? [] },
        })
        .catch(() => {});
    }
  });
});
