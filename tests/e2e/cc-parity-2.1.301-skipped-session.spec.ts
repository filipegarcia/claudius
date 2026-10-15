/**
 * CC 2.1.301 parity — "[VSCode] Fixed a conversation that crashes or freezes
 * the panel being reopened on every reload".
 *
 * Claudius resumes the last-active session on every page load. A
 * conversation whose load never finishes (it froze, or crashed the page)
 * used to be resumed again on every reload. Now the next load opens a fresh
 * session instead, with a notice offering "Open anyway".
 *
 * The spec reproduces it end to end: the first load resumes a session whose
 * stream stalls before its replay completes (a freeze), the page is
 * reloaded, and the guard kicks in.
 *
 * Screenshot target: docs/cc-parity/2.1.301/skipped-session.png
 */

import { mkdirSync } from "node:fs";
import { resolve } from "node:path";
import { test, expect, type Page, type Route } from "../helpers/test";
import { activateClaudiusWorkspace } from "./helpers/workspace";
import { assistantText, initEvent, sseBody, userText } from "./helpers/mock-chat";

const SHOTS_DIR = resolve(process.cwd(), "docs/cc-parity/2.1.301");
mkdirSync(SHOTS_DIR, { recursive: true });

const STUCK = "aaaaaaaa-bbbb-cccc-dddd-000002301c01";
const FRESH = "aaaaaaaa-bbbb-cccc-dddd-000002301c02";

async function mockBackend(page: Page, opts: { stuckFinishes: () => boolean }) {
  await page.route("**/api/sessions", async (route: Route) => {
    if (route.request().method() !== "POST") return route.fallback();
    const body = (route.request().postDataJSON() ?? {}) as { resume?: string };
    return route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify({ id: body.resume === STUCK ? STUCK : FRESH }),
    });
  });
  // The stuck session: history starts streaming but its replay never
  // completes — no `replay_done` — the shape of a load that froze.
  await page.route(`**/api/sessions/${STUCK}/stream*`, async (route: Route) =>
    route.fulfill({
      status: 200,
      headers: { "Content-Type": "text/event-stream", "Cache-Control": "no-cache" },
      body: sseBody([
        { type: "ready", sessionId: STUCK },
        initEvent("sys-init-stuck"),
        userText("u-stuck", "Summarise the 40 MB log file."),
        ...(opts.stuckFinishes()
          ? [assistantText("a-stuck", "Here's the summary."), { type: "replay_done", hasMoreAbove: false }]
          : []),
      ]),
    }),
  );
  await page.route(`**/api/sessions/${FRESH}/stream*`, async (route: Route) =>
    route.fulfill({
      status: 200,
      headers: { "Content-Type": "text/event-stream", "Cache-Control": "no-cache" },
      body: sseBody([
        { type: "ready", sessionId: FRESH },
        initEvent("sys-init-fresh"),
        { type: "replay_done", hasMoreAbove: false },
      ]),
    }),
  );
  await page.route("**/api/sessions/open-tabs", async (route: Route) => {
    if (route.request().method() !== "GET") return route.fulfill({ status: 200, contentType: "application/json", body: "{}" });
    return route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify({ activeId: STUCK, tabs: [STUCK] }),
    });
  });
  await page.route("**/api/sessions/*/pending-prompts", async (route: Route) =>
    route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify({ asks: [], permissions: [] }) }),
  );
  await page.route("**/api/limits*", async (route: Route) =>
    route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify({ limits: { sessionUsd: 0, projectDailyUsd: 0 } }) }),
  );
}

test.beforeEach(async ({ page }) => {
  await activateClaudiusWorkspace(page);
});

test("a session whose load never finished isn't reopened on reload; Open anyway retries it", async ({ page }) => {
  let stuckFinishes = false;
  await mockBackend(page, { stuckFinishes: () => stuckFinishes });

  // Load 1: resumes the last-active session, whose replay stalls.
  await page.goto("/");
  await expect(page.getByText("Summarise the 40 MB log file.")).toBeVisible({ timeout: 15_000 });
  await expect(page.getByTestId("skipped-session-notice")).toHaveCount(0);

  // Load 2: the guard sees the unfinished load and opens a fresh session.
  const resumes: string[] = [];
  page.on("request", (r) => {
    if (r.url().endsWith("/api/sessions") && r.method() === "POST") {
      resumes.push(((r.postDataJSON() ?? {}) as { resume?: string }).resume ?? "(fresh)");
    }
  });
  await page.reload();
  const notice = page.getByTestId("skipped-session-notice");
  await expect(notice).toBeVisible({ timeout: 15_000 });
  await expect(notice).toContainText("didn't finish opening last time");
  await expect(notice).toContainText(STUCK.slice(0, 8));
  await expect(page.getByText("Summarise the 40 MB log file.")).toHaveCount(0);
  expect(resumes).not.toContain(STUCK);

  await page.waitForTimeout(300);
  await page.screenshot({ path: resolve(SHOTS_DIR, "skipped-session.png"), fullPage: false });

  // Open anyway: a deliberate retry resumes it (this time it loads fine,
  // which clears the guard).
  stuckFinishes = true;
  await page.getByTestId("skipped-session-open-anyway").click();
  await expect(page).toHaveURL(new RegExp(`session=${STUCK}`));
  await expect(page.getByText("Here's the summary.")).toBeVisible({ timeout: 15_000 });
  await expect(page.getByTestId("skipped-session-notice")).toHaveCount(0);

  // It finished this time, so a further reload resumes it normally.
  await page.reload();
  await expect(page.getByText("Here's the summary.")).toBeVisible({ timeout: 15_000 });
  await expect(page.getByTestId("skipped-session-notice")).toHaveCount(0);
});
