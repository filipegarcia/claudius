/**
 * CC 2.1.300 parity — "[Remote Control] Fixed the diff view in Remote Control
 * sessions on claude.ai and the desktop app showing deleted and renamed files
 * as modified".
 *
 * Claudius's `/diff` overlay (`components/overlays/DiffOverlay.tsx`) badged
 * each row with the worktree status first (`lib/shared/diff-overlay.ts`
 * `statusChar`). A staged rename that was then edited (porcelain `RM`) came
 * out as "M / Modified", and the row showed only the new path. The Git page's
 * `ChangesList` was already right. Now the overlay keeps the R badge, labels
 * the row `old → new` like the Git page does, and deletes from either slot
 * stay "D".
 *
 * Screenshot target: docs/cc-parity/2.1.300/diff-rename.png
 */
import { mkdirSync } from "node:fs";
import { resolve } from "node:path";
import { test, expect, type Page, type Route } from "../helpers/test";
import { activateClaudiusWorkspace } from "./helpers/workspace";

const SHOTS_DIR = resolve(process.cwd(), "docs/cc-parity/2.1.300");
mkdirSync(SHOTS_DIR, { recursive: true });

const FAKE_SESSION_ID = "aaaaaaaa-bbbb-cccc-dddd-00000300df01";

type SdkEvent = Record<string, unknown>;

function sseBody(events: SdkEvent[]): string {
  return events.map((e) => `data: ${JSON.stringify(e)}\n\n`).join("");
}

async function mockChatBackend(page: Page, events: SdkEvent[]): Promise<void> {
  await page.route("**/api/sessions", async (route: Route) => {
    if (route.request().method() !== "POST") return route.fallback();
    return route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify({ id: FAKE_SESSION_ID }),
    });
  });
  await page.route(`**/api/sessions/${FAKE_SESSION_ID}/stream*`, async (route: Route) => {
    return route.fulfill({
      status: 200,
      headers: { "Content-Type": "text/event-stream", "Cache-Control": "no-cache", Connection: "keep-alive" },
      body: sseBody(events),
    });
  });
  await page.route("**/api/sessions/open-tabs", async (route: Route) => {
    return route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify({ activeId: null, tabs: [] }),
    });
  });
  await page.route(`**/api/sessions/${FAKE_SESSION_ID}/pending-prompts`, async (route: Route) => {
    return route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify({ asks: [], permissions: [] }) });
  });
  await page.route("**/api/limits*", async (route: Route) => {
    return route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify({ limits: { sessionUsd: 0, projectDailyUsd: 0 } }) });
  });
}

const PRELUDE: SdkEvent[] = [
  { type: "ready", sessionId: FAKE_SESSION_ID },
  { type: "sdk", message: { type: "system", subtype: "init", uuid: "sys-init-300df", model: "claude-sonnet-4-6" } },
  { type: "replay_done", hasMoreAbove: false },
];

const FAKE_DIFF = [
  "diff --git a/lib/utils.ts b/lib/utils.ts",
  "index 1111111..2222222 100644",
  "--- a/lib/utils.ts",
  "+++ b/lib/utils.ts",
  "@@ -1,3 +1,4 @@",
  " export function sessionTitle(id: string) {",
  "+  // edited after the rename was staged",
  "   return id.slice(0, 8);",
  " }",
  "",
].join("\n");

test.beforeEach(async ({ page }) => {
  await activateClaudiusWorkspace(page);
  await page.route("**/api/workspaces/*/git/status", async (route: Route) => {
    return route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify({
        isRepo: true,
        branch: "main",
        files: [
          // `git mv lib/helpers.ts lib/utils.ts`, then edited.
          {
            path: "lib/utils.ts",
            oldPath: "lib/helpers.ts",
            index: "R",
            worktree: "M",
            untracked: false,
          },
          // Staged and unstaged deletes.
          { path: "lib/legacy-cache.ts", index: "D", worktree: " ", untracked: false },
          { path: "lib/old-flags.ts", index: " ", worktree: "D", untracked: false },
          // A plain modification, for contrast.
          { path: "app/page.tsx", index: " ", worktree: "M", untracked: false },
        ],
      }),
    });
  });
  await page.route("**/api/workspaces/*/git/diff**", async (route: Route) => {
    return route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify({ diff: FAKE_DIFF, binary: false }),
    });
  });
});

test("the /diff overlay shows renamed and deleted files as such, not as modified", async ({ page }) => {
  await mockChatBackend(page, PRELUDE);
  await page.goto("/");

  const composer = page.getByTestId("prompt-input");
  await expect(composer).toBeVisible({ timeout: 15_000 });
  await composer.fill("/diff");
  await page.getByTestId("prompt-send").click();

  const fileList = page.getByTestId("diff-overlay-file-list");
  await expect(fileList).toBeVisible({ timeout: 5_000 });

  const rows = page.getByTestId("diff-overlay-file");
  await expect(rows).toHaveCount(4);

  const renamed = rows.filter({ hasText: "utils.ts" });
  await expect(renamed).toHaveText(/R\s*lib\/helpers\.ts → lib\/utils\.ts/);
  await expect(renamed).toHaveAttribute("data-status", "R");
  await expect(renamed).toHaveAttribute("title", /— Renamed$/);

  for (const name of ["legacy-cache.ts", "old-flags.ts"]) {
    const row = rows.filter({ hasText: name });
    await expect(row).toHaveAttribute("data-status", "D");
    await expect(row).toHaveAttribute("title", /— Deleted$/);
  }

  await expect(rows.filter({ hasText: "app/page.tsx" })).toHaveAttribute("data-status", "M");

  await renamed.click();
  await expect(page.getByText("edited after the rename was staged")).toBeVisible({ timeout: 5_000 });

  await page.waitForTimeout(300);
  await page.screenshot({ path: resolve(SHOTS_DIR, "diff-rename.png"), fullPage: false });
});
