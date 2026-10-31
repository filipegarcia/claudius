/**
 * CC 2.1.316 parity — "[Cloud sessions] Added a 'Catching up…' line that
 * shows while a cloud or Remote Control session you switch back to is still
 * bringing its messages up to date".
 *
 * Switching back to a session clears the transcript, awaits the resume POST
 * (`POST /api/sessions { resume }`), then replays history over SSE. In that
 * window Claudius showed the brand-new-session splash, so a session with
 * history looked empty. Now a "Catching up…" line shows until the replay
 * lands.
 *
 * History is seeded through the dev-only `dev-broadcast` endpoint (as in
 * `session-tab-switch.spec.ts`), and the resume POST is held ~2s so the
 * catching-up window is observable.
 *
 * Screenshot target: docs/cc-parity/2.1.316/catching-up.png
 */

import { mkdirSync } from "node:fs";
import { resolve } from "node:path";
import { test, expect, type Page } from "../helpers/test";
import { activateClaudiusWorkspace } from "./helpers/workspace";

const SHOTS_DIR = resolve(process.cwd(), "docs/cc-parity/2.1.316");
mkdirSync(SHOTS_DIR, { recursive: true });

const SESSION_RE = /[?&]session=([0-9a-f-]{36})/i;
const HOLD_MS = 2000;

async function waitForBoundSession(page: Page, opts: { not?: string } = {}): Promise<string> {
  await page.waitForURL(
    (url) => {
      const m = String(url).match(SESSION_RE);
      return Boolean(m && (!opts.not || m[1] !== opts.not));
    },
    { timeout: 30_000 },
  );
  return page.url().match(SESSION_RE)![1];
}

test.beforeEach(async ({ page, request }) => {
  await activateClaudiusWorkspace(page);
  await request.put("/api/sessions/open-tabs", { data: { tabs: [], activeId: null } });
});

test("switching back to a session shows 'Catching up…' instead of the splash until its history replays", async ({
  page,
}) => {
  test.setTimeout(60_000);
  await page.goto("/");
  const idA = await waitForBoundSession(page);

  // Seed history in A without a live model.
  const stamp = Date.now().toString(36);
  const sentinel = `catching-up sentinel ${stamp}`;
  const res = await page.request.post(`/api/sessions/${idA}/dev-broadcast`, {
    data: {
      event: {
        type: "sdk",
        message: {
          type: "assistant",
          uuid: `00000000-0000-4000-a316-${stamp.padStart(12, "0").slice(-12)}`,
          parent_tool_use_id: null,
          message: { model: "claude-sonnet-4-6", content: [{ type: "text", text: sentinel }] },
        },
      },
    },
  });
  expect(res.ok()).toBeTruthy();
  await expect(page.getByText(sentinel).first()).toBeVisible({ timeout: 10_000 });

  // A second, brand-new session keeps the splash (no catching-up line).
  await page.locator('button[title="New session tab"]').click();
  await waitForBoundSession(page, { not: idA });
  await expect(page.getByTestId("splash-greeting")).toBeVisible({ timeout: 15_000 });
  await expect(page.getByTestId("transcript-catching-up")).toHaveCount(0);

  // Hold A's resume POST so the catching-up window stays open.
  let held = 0;
  await page.route("**/api/sessions", async (route) => {
    const req = route.request();
    if (req.method() !== "POST") return route.fallback();
    const body = (req.postDataJSON() ?? {}) as { resume?: string };
    if (body.resume !== idA) return route.fallback();
    held++;
    await new Promise((r) => setTimeout(r, HOLD_MS));
    return route.fallback();
  });

  const tab = page.locator(`[data-testid="session-tab"][data-tab-id="${idA}"] button`).first();
  await tab.scrollIntoViewIfNeeded();
  await tab.click();

  const catchingUp = page.getByTestId("transcript-catching-up");
  await expect(catchingUp).toBeVisible({ timeout: 5_000 });
  await expect(catchingUp).toHaveText("Catching up…");
  await expect(catchingUp).toHaveAttribute("role", "status");
  await expect(page.getByTestId("splash-greeting")).toHaveCount(0);
  await page.screenshot({ path: resolve(SHOTS_DIR, "catching-up.png"), fullPage: false });
  expect(held).toBe(1);

  // Once the replay lands, the line goes and A's history renders.
  await expect(page.getByText(sentinel).first()).toBeVisible({ timeout: 15_000 });
  await expect(catchingUp).toHaveCount(0);
  await expect(page.getByTestId("splash-greeting")).toHaveCount(0);
});

test("while the stream is down the catching-up line says it's reconnecting instead of claiming progress", async ({
  page,
}) => {
  test.setTimeout(60_000);
  await page.goto("/");
  const idA = await waitForBoundSession(page);

  // A second session so there's something to switch back from.
  await page.locator('button[title="New session tab"]').click();
  await waitForBoundSession(page, { not: idA });
  await expect(page.getByTestId("splash-greeting")).toBeVisible({ timeout: 15_000 });

  // A's stream is unreachable after the switch, so its replay (and
  // `replay_done`) never arrives and the pane stays catching up.
  let refused = 0;
  await page.route(`**/api/sessions/${idA}/stream*`, (route) => {
    refused++;
    return route.fulfill({ status: 503, contentType: "text/plain", body: "unavailable" });
  });

  const tab = page.locator(`[data-testid="session-tab"][data-tab-id="${idA}"] button`).first();
  await tab.scrollIntoViewIfNeeded();
  await tab.click();

  // The reconnecting badge is debounced (STREAM_BADGE_AFTER_MS), then the
  // line swaps to the working row's disconnected copy.
  const disconnected = page.getByTestId("transcript-catching-up-disconnected");
  await expect(disconnected).toBeVisible({ timeout: 15_000 });
  await expect(disconnected).toHaveText("Disconnected — reconnecting…");
  await expect(disconnected).toHaveAttribute("role", "status");
  await expect(page.getByTestId("transcript-catching-up")).toHaveCount(0);
  await expect(page.getByTestId("splash-greeting")).toHaveCount(0);
  expect(refused).toBeGreaterThan(0);
  await page.screenshot({ path: resolve(SHOTS_DIR, "catching-up-disconnected.png"), fullPage: false });
});
