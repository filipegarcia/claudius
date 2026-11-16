/**
 * CC 2.1.326 parity — "Fixed /resume search saying \"No sessions match\" for
 * older sessions that exist".
 *
 * `/resume` with no args opens the Sessions page, whose search only scored the
 * pages already fetched. A query matching only an older session said
 * "No sessions match." while "Load more" was still on offer. Now a no-match
 * query keeps loading older pages ("Searching older sessions…") and only says
 * "No sessions match." once everything is loaded.
 *
 * `/api/sessions/all` is mocked: the first page (limit=200) is a full page of
 * recent sessions with no match; the next (limit=400) adds the older match.
 *
 * Screenshot target: docs/cc-parity/2.1.326/sessions-search-older.png
 */

import { mkdirSync } from "node:fs";
import { resolve } from "node:path";
import { test, expect, type Page, type Route } from "../helpers/test";
import { activateClaudiusWorkspace } from "./helpers/workspace";

const SCREENSHOT_DIR = resolve(process.cwd(), "docs/cc-parity/2.1.326");
mkdirSync(SCREENSHOT_DIR, { recursive: true });

type WorkspaceSummary = { id: string; name: string; rootPath: string };

const OLD_ID = "00000000-0000-4000-8000-000000009999";
const QUERY = "quokka";

async function activeWorkspace(page: Page): Promise<WorkspaceSummary> {
  const r = await page.request.get("/api/workspaces");
  const data = (await r.json()) as { workspaces: WorkspaceSummary[]; activeId?: string };
  const ws =
    data.workspaces.find((w) => w.id === data.activeId) ??
    data.workspaces.find((w) => w.name === "claudius") ??
    data.workspaces.find((w) => w.rootPath === process.cwd());
  expect(ws, "an active workspace").toBeTruthy();
  return ws!;
}

function recentSessions(cwd: string, count: number) {
  const now = Date.now();
  return Array.from({ length: count }, (_, i) => ({
    // Hex-only ids so the (non-hex) query can't substring-match them.
    sessionId: `00000000-0000-4000-8000-${String(i + 1).padStart(12, "0")}`,
    summary: `Recent session ${i + 1}`,
    claudiusTitle: `Recent session ${i + 1}`,
    firstPrompt: `Refactor module ${i + 1}`,
    lastModified: now - (i + 1) * 60_000,
    createdAt: now - (i + 1) * 60_000,
    fileSize: 4096,
    gitBranch: "main",
    cwd,
  }));
}

function olderMatch(cwd: string) {
  const t = Date.now() - 90 * 86_400_000;
  return {
    sessionId: OLD_ID,
    summary: "Quokka migration notes",
    claudiusTitle: "Quokka migration notes",
    firstPrompt: "Plan the quokka data migration",
    lastModified: t,
    createdAt: t,
    fileSize: 18_432,
    gitBranch: "main",
    cwd,
  };
}

/** The app-wide updater banner is unrelated to this feature — dismiss it. */
async function dismissUpdaterBanner(page: Page): Promise<void> {
  const dismiss = page.getByRole("button", { name: /^Dismiss (updater error|update-feed notice|for this session|for 24 hours|until a newer version is available)$/ });
  for (let i = 0; i < 3 && (await dismiss.count()) > 0; i++) {
    await dismiss.first().click().catch(() => {});
  }
}

test.beforeEach(async ({ page }) => {
  await activateClaudiusWorkspace(page);
});

test("search keeps loading older pages and finds an older session (CC 2.1.326)", async ({ page }) => {
  test.setTimeout(60_000);
  const ws = await activeWorkspace(page);
  const recent = recentSessions(ws.rootPath, 200);

  // Hold the second page so the in-between "Searching older sessions…" state
  // is observable.
  let releaseOlder!: () => void;
  const olderGate = new Promise<void>((r) => {
    releaseOlder = r;
  });
  const limits: number[] = [];

  await page.route("**/api/sessions/all**", async (route: Route) => {
    if (route.request().method() !== "GET") return route.fallback();
    const limit = Number(new URL(route.request().url()).searchParams.get("limit") ?? "200");
    limits.push(limit);
    if (limit <= 200) {
      // A full page: the hook reads that as "more may exist".
      return route.fulfill({
        status: 200,
        contentType: "application/json",
        body: JSON.stringify({ sessions: recent.slice(0, limit), accountsConfigured: 0 }),
      });
    }
    await olderGate;
    return route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify({ sessions: [...recent, olderMatch(ws.rootPath)], accountsConfigured: 0 }),
    });
  });

  await page.goto(`/${ws.id}/sessions`);
  const rows = page.getByTestId("session-row");
  await expect(rows).toHaveCount(200, { timeout: 20_000 });
  await expect(page.getByTestId("sessions-load-more")).toBeVisible();

  await page.getByRole("textbox", { name: "Search sessions" }).fill(QUERY);

  // The bug: this said "No sessions match." while older pages existed.
  const status = page.getByTestId("sessions-search-status");
  await expect(status).toHaveText("Searching older sessions…");
  await expect(page.getByText("No sessions match.")).toHaveCount(0);
  await expect.poll(() => limits.some((l) => l > 200)).toBe(true);

  releaseOlder();

  const oldRow = page.locator(`[data-testid="session-row"][data-session-id="${OLD_ID}"]`);
  await expect(oldRow).toBeVisible({ timeout: 15_000 });
  await expect(oldRow).toContainText("Quokka migration notes");
  await expect(rows).toHaveCount(1);
  await expect(status).toHaveCount(0);
  // 201 < 400: everything is loaded, so no further pages were requested.
  expect(Math.max(...limits)).toBe(400);
  await expect(page.getByTestId("sessions-load-more")).toHaveCount(0);

  await dismissUpdaterBanner(page);
  await page.waitForTimeout(300);
  await page.screenshot({ path: resolve(SCREENSHOT_DIR, "sessions-search-older.png"), fullPage: false });
});

test("only says no match once every session is loaded (CC 2.1.326)", async ({ page }) => {
  test.setTimeout(60_000);
  const ws = await activeWorkspace(page);
  const recent = recentSessions(ws.rootPath, 200);

  await page.route("**/api/sessions/all**", async (route: Route) => {
    if (route.request().method() !== "GET") return route.fallback();
    const limit = Number(new URL(route.request().url()).searchParams.get("limit") ?? "200");
    // 200 on the first page, then 230 total: no more after page 2.
    const sessions = limit <= 200 ? recent : [...recent, ...recentSessions(ws.rootPath, 230).slice(200)];
    return route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify({ sessions, accountsConfigured: 0 }),
    });
  });

  await page.goto(`/${ws.id}/sessions`);
  await expect(page.getByTestId("session-row")).toHaveCount(200, { timeout: 20_000 });
  await page.getByRole("textbox", { name: "Search sessions" }).fill(QUERY);

  await expect(page.getByTestId("sessions-search-status")).toHaveText("No sessions match.", { timeout: 15_000 });
  await expect(page.getByTestId("sessions-load-more")).toHaveCount(0);
});
