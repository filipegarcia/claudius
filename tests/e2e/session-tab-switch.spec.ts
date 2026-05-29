import { test, expect, type Page } from "../helpers/test";

/**
 * Regression coverage for two tab-switching bugs reported 2026-05-12:
 *
 *   1. Title preserved on tab switch — a session that's been renamed (DB
 *      title set) must keep that title when the user clicks away and
 *      clicks back. The earlier bug surfaced the SDK's `summary` field
 *      as a fallback, which equals the last user prompt, so a renamed
 *      session ended up showing prompt text in the tab strip.
 *
 *   2. Content loads without a refresh — clicking a tab whose session
 *      had been reaped (or never woken in-memory) used to leave the
 *      chat empty until the user hit reload. The fix: `switchSession`
 *      now AWAITS a POST `/api/sessions { resume: id }` before opening
 *      the SSE, mirroring what the boot path always did. Without the
 *      await the wake POST raced the SSE subscribe and sometimes lost.
 *
 * We drive the chain end-to-end without an Anthropic API key by using
 * two dev-only endpoints:
 *   - `POST /api/sessions/:id/dev-broadcast`  push fake SDK messages
 *   - `POST /api/sessions/:id/dev-reap`        force-evict from memory
 *
 * The forced-reap variant exercises the very same path a stale tab
 * click takes after the natural reap timer fires — that's the failure
 * mode the user keeps reporting.
 */

const SESSION_RE = /[?&]session=([0-9a-f-]{36})/i;

async function waitForBoundSession(page: Page, opts: { not?: string } = {}): Promise<string> {
  await page.waitForURL(
    (url) => {
      const m = String(url).match(SESSION_RE);
      if (!m) return false;
      if (opts.not && m[1] === opts.not) return false;
      return true;
    },
    { timeout: 30_000 },
  );
  const id = page.url().match(SESSION_RE)?.[1];
  expect(id).toMatch(/^[0-9a-f-]{36}$/i);
  if (opts.not) expect(id).not.toBe(opts.not);
  return id!;
}

/** Push an assistant message into a session's broadcast bus via the dev API. */
async function pushAssistantText(
  page: Page,
  sessionId: string,
  text: string,
  uuid: string,
): Promise<void> {
  const res = await page.request.post(`/api/sessions/${sessionId}/dev-broadcast`, {
    data: {
      event: {
        type: "sdk",
        message: {
          type: "assistant",
          uuid,
          parent_tool_use_id: null,
          message: {
            model: "claude-sonnet-4-6",
            content: [{ type: "text", text }],
          },
        },
      },
    },
  });
  expect(res.ok(), `dev-broadcast should succeed for ${sessionId}`).toBeTruthy();
}

/** Force-reap the session from server memory. The next subscribe must
 *  resume from disk (and is exactly the path the natural reaper exercises
 *  when the idle window elapses). */
async function forceReap(page: Page, sessionId: string): Promise<void> {
  const res = await page.request.post(`/api/sessions/${sessionId}/dev-reap`);
  expect(res.ok(), `dev-reap should succeed for ${sessionId}`).toBeTruthy();
  const data = (await res.json()) as { ok: boolean; reaped: boolean };
  expect(data.ok).toBeTruthy();
  expect(data.reaped, "session must have been in memory before the reap").toBeTruthy();
}

/** Rename via the public API so we exercise the same path the UI uses. */
async function renameSession(page: Page, sessionId: string, title: string): Promise<void> {
  const res = await page.request.post("/api/sessions/rename", {
    data: { sessionId, title },
  });
  expect(res.ok(), `rename should succeed for ${sessionId}`).toBeTruthy();
}

function tabButtonFor(page: Page, id: string) {
  // Inner button has the click handler — the wrapping div doesn't.
  return page.locator(`[data-testid="session-tab"][data-tab-id="${id}"] button`).first();
}

/**
 * Click a tab, scrolling it into view first. The strip uses
 * `overflow: hidden` and renders extra tabs into an overflow menu, so
 * a brand-new test tab can land beyond the visible edge — Playwright's
 * default click waits for `visible` and times out instead of scrolling
 * the strip. `scrollIntoViewIfNeeded` handles both the visible and
 * overflow-clipped cases.
 */
async function clickTab(page: Page, id: string): Promise<void> {
  const btn = tabButtonFor(page, id);
  await btn.scrollIntoViewIfNeeded();
  await btn.click();
}

test.describe("Session tab switch", () => {
  test.beforeEach(async ({ request }) => {
    // Reset the persistent tab strip before every test. Without this,
    // a long-running dev instance (or a sibling test) leaves the strip
    // overflowing — new tabs created by the test render off-screen and
    // `clickTab` waits forever for a visible element. Clearing also
    // guarantees that "open a new tab" in step 1 of every test actually
    // creates THE first visible tab.
    await request.put("/api/sessions/open-tabs", {
      data: { tabs: [], activeId: null },
    });
  });

  test("custom title survives a tab switch (does NOT revert to prompt text)", async ({ page }) => {
    test.setTimeout(60_000);

    await page.goto("/");
    const idA = await waitForBoundSession(page);

    const customTitle = `e2e custom ${Date.now().toString(36)}`;
    await renameSession(page, idA, customTitle);
    const recapTitle = page.getByTestId("recap-banner-title");
    await expect(recapTitle).toHaveText(customTitle, { timeout: 10_000 });
    const activeTabLabel = page.locator(
      '[data-testid="session-tab"][data-tab-active="true"] [data-testid="session-tab-label"]',
    );
    await expect(activeTabLabel).toHaveText(customTitle, { timeout: 10_000 });

    // Open a second tab so A becomes inactive.
    await page.locator('button[title="New session tab"]').click();
    const idB = await waitForBoundSession(page, { not: idA });

    // Click back on A. The label was already correct before the click;
    // afterwards, the RecapBanner title also has to surface it again
    // (sourced via `sendFreshTitle` over SSE, not from any prompt-shaped
    // summary).
    await clickTab(page, idA);
    await page.waitForURL(new RegExp(`session=${idA}`), { timeout: 10_000 });
    await expect(recapTitle).toHaveText(customTitle, { timeout: 10_000 });
    await expect(activeTabLabel).toHaveText(customTitle, { timeout: 10_000 });
    // Sanity: B's id should NOT bleed in.
    expect(page.url()).toContain(idA);
    expect(page.url()).not.toContain(idB);
  });

  test("tab content reloads without a refresh (in-memory session)", async ({ page }) => {
    test.setTimeout(60_000);

    await page.goto("/");
    const idA = await waitForBoundSession(page);

    // Inject a fake assistant message — gives us a stable string to
    // search for in the transcript after we navigate away and come back.
    const stamp = Date.now().toString(36);
    const sentinel = `e2e sentinel ${stamp}`;
    const sentinelUuid = `00000000-0000-4000-a000-${stamp.padStart(12, "0").slice(-12)}`;
    await pushAssistantText(page, idA, sentinel, sentinelUuid);
    await expect(page.getByText(sentinel).first()).toBeVisible({ timeout: 10_000 });

    // Open a second tab so A's SSE closes.
    await page.locator('button[title="New session tab"]').click();
    const idB = await waitForBoundSession(page, { not: idA });
    expect(idB).not.toBe(idA);
    await expect(page.getByText(sentinel)).toHaveCount(0);

    // Click back on A's tab. The wake POST in switchSession ensures the
    // session is bound before SSE; the sentinel reappears WITHOUT a
    // page.reload().
    await clickTab(page, idA);
    await page.waitForURL(new RegExp(`session=${idA}`), { timeout: 10_000 });
    await expect(page.getByText(sentinel).first()).toBeVisible({ timeout: 15_000 });
  });

  test("tab content reloads after a reap (the actual user-reported failure)", async ({ page }) => {
    // This is the bug the user has been hitting: leave a session idle,
    // come back later, click the tab → empty chat until refresh. We
    // reproduce by FORCING the reap with the dev-only endpoint so we
    // don't have to wait the configured idle window.
    test.setTimeout(60_000);

    await page.goto("/");
    const idA = await waitForBoundSession(page);

    // For the reap scenario we need content the JSONL persists across the
    // reap, since the in-memory buffer is wiped when `Session.end()` runs.
    // A real user prompt sent via `send()` would do it, but that path
    // requires the SDK. Instead we rely on the FIRST prompt the SDK
    // writes when the session is created — or, simpler, we drive the
    // rename flow which writes a customTitle into the JSONL header and
    // outlives the reap. The transcript after-reap is empty (no
    // historical to replay), but `ready` MUST still arrive and the title
    // MUST survive — both are signals the resume-from-disk path is alive.
    const customTitle = `e2e reap ${Date.now().toString(36)}`;
    await renameSession(page, idA, customTitle);
    const recapTitle = page.getByTestId("recap-banner-title");
    await expect(recapTitle).toHaveText(customTitle, { timeout: 10_000 });

    // Open another tab so A is inactive (SSE closes on the client side).
    await page.locator('button[title="New session tab"]').click();
    const idB = await waitForBoundSession(page, { not: idA });
    expect(idB).not.toBe(idA);

    // Force-reap A. Next time anything subscribes, it goes through the
    // resume-from-disk path.
    await forceReap(page, idA);

    // Click back on A. The wake POST in switchSession runs FIRST and
    // awaits `Session.start()` server-side (which loads historical from
    // the JSONL into the in-memory buffer), so by the time the SSE
    // subscribes the title is set and `ready` is broadcast.
    await clickTab(page, idA);
    await page.waitForURL(new RegExp(`session=${idA}`), { timeout: 10_000 });

    // The custom title we set BEFORE the reap survives — proves the DB
    // was hit and the session was successfully resumed from disk.
    await expect(recapTitle).toHaveText(customTitle, { timeout: 15_000 });
    // The active tab label tracks the title too — proves `session_title`
    // made it onto the wire to the new subscriber.
    await expect(
      page.locator(
        '[data-testid="session-tab"][data-tab-active="true"] [data-testid="session-tab-label"]',
      ),
    ).toHaveText(customTitle, { timeout: 15_000 });
    // The session reached "ready" — proves the stream route completed
    // the subscribe chain. Pre-fix, the user reported being stuck on
    // "Starting" indefinitely; this assertion would have failed.
    const statusText = page.getByTestId("status-line-text");
    await expect(statusText).not.toHaveText(/starting/i, { timeout: 15_000 });
  });

  test("INACTIVE tab strip label shows the rename for a REAPED session (the actual bug)", async ({
    page,
  }) => {
    // The user-visible failure mode: a session that was renamed earlier
    // but has since been reaped from in-memory shows its UUID in the
    // tab strip. Pre-fix, the only "disk" source of titles was the SDK's
    // `customTitle`, and Claudius renames often don't make it to the
    // SDK JSONL header (renameSession silently fails when the JSONL
    // doesn't exist yet). After reaping, the live `/api/sessions`
    // endpoint no longer carries the session, so the strip falls back
    // entirely on `/api/sessions/all` — which now includes our DB title
    // as `claudiusTitle`.
    //
    // We FORCE the reap with the dev endpoint so we don't have to wait
    // an hour for the natural reaper. This is the path users hit every
    // time they come back to a tab they haven't touched in a while.
    test.setTimeout(60_000);

    await page.goto("/");
    const idA = await waitForBoundSession(page);

    const customTitle = `e2e inactive ${Date.now().toString(36)}`;
    await renameSession(page, idA, customTitle);
    const activeLabel = page.locator(
      '[data-testid="session-tab"][data-tab-active="true"] [data-testid="session-tab-label"]',
    );
    await expect(activeLabel).toHaveText(customTitle, { timeout: 10_000 });

    // Open a second tab so A becomes inactive and its SSE detaches.
    await page.locator('button[title="New session tab"]').click();
    const idB = await waitForBoundSession(page, { not: idA });
    expect(idB).not.toBe(idA);

    // Force-reap A from memory. Now the live /api/sessions returns
    // nothing for A, and the strip's label for A has to come from the
    // disk-side enrichment in /api/sessions/all. Pre-fix that meant
    // `customTitle ?? null` — and customTitle is empty since the SDK
    // rename couldn't write the JSONL header on a fresh session — so
    // the strip fell through to the id slice.
    await forceReap(page, idA);

    // Kick a refresh of the sessions list. The client does this on
    // visibility change and a few other triggers; in the test we just
    // reload the page to force `refreshSessions` to re-run cleanly.
    await page.reload();

    // The inactive A tab MUST surface the custom title, not the id
    // prefix. Locate by id (NOT by data-tab-active — A is not active
    // after reload; B is).
    const inactiveLabelA = page.locator(
      `[data-testid="session-tab"][data-tab-id="${idA}"] [data-testid="session-tab-label"]`,
    );
    await expect(inactiveLabelA).toHaveText(customTitle, { timeout: 15_000 });

    // Belt-and-braces negative assertion. Pre-fix the label was
    // `idA.slice(0,8)` — making the expected/received diff awkward in
    // CI. Asserting the negative gives a clear "label is the UUID
    // prefix" failure message if the regression comes back.
    const labelText = await inactiveLabelA.textContent();
    expect(labelText?.trim(), `inactive tab should not be the id prefix ${idA.slice(0, 8)}`)
      .not.toBe(idA.slice(0, 8));
  });

  test("inactive tab label survives a full page reload (HMR-equivalent)", async ({ page }) => {
    // The user's report: "I go there, refresh and..." — they refreshed
    // the browser before the title surfaced. After my fix, the title
    // should be there from the FIRST render after reload — no second
    // refresh needed.
    test.setTimeout(60_000);

    await page.goto("/");
    const idA = await waitForBoundSession(page);

    const customTitle = `e2e reload ${Date.now().toString(36)}`;
    await renameSession(page, idA, customTitle);

    // Open a second tab so the persistence layer records A as a
    // non-active tab in the strip.
    await page.locator('button[title="New session tab"]').click();
    const idB = await waitForBoundSession(page, { not: idA });
    expect(idB).not.toBe(idA);

    // Reload — both tabs are reconstructed from /api/sessions/open-tabs.
    // The labels come from `refreshSessions`, which hits /api/sessions
    // and /api/sessions/all. With the fix, /api/sessions/all carries
    // `claudiusTitle` so the strip lands with the right names on the
    // very first render after reload.
    await page.reload();

    // Both tabs should be present in the strip.
    await expect(
      page.locator(`[data-testid="session-tab"][data-tab-id="${idA}"]`),
    ).toBeVisible({ timeout: 15_000 });
    await expect(
      page.locator(`[data-testid="session-tab"][data-tab-id="${idB}"]`),
    ).toBeVisible({ timeout: 15_000 });

    // Whichever of A/B is inactive after reload, A's label is still the
    // custom title. (B is the last-active one so usually wins the
    // reload binding; this lets us assert against the inactive A
    // unambiguously.)
    const labelA = page.locator(
      `[data-testid="session-tab"][data-tab-id="${idA}"] [data-testid="session-tab-label"]`,
    );
    await expect(labelA).toHaveText(customTitle, { timeout: 15_000 });
  });

  test("rename → switch → switch back: inactive label remains the rename throughout", async ({
    page,
  }) => {
    // Stress-test the watchpoints: rename A, switch to B, switch to C,
    // come back. A's label must stay correct in every snapshot — not
    // just the moment we look right after the rename. This catches a
    // regression where a later `refreshSessions` (e.g. triggered by the
    // visibility-change watcher) clobbered the title with `id.slice(0,8)`.
    test.setTimeout(60_000);

    await page.goto("/");
    const idA = await waitForBoundSession(page);

    const customTitle = `e2e stress ${Date.now().toString(36)}`;
    await renameSession(page, idA, customTitle);

    const labelA = page.locator(
      `[data-testid="session-tab"][data-tab-id="${idA}"] [data-testid="session-tab-label"]`,
    );

    // Open B — A becomes inactive.
    await page.locator('button[title="New session tab"]').click();
    const idB = await waitForBoundSession(page, { not: idA });
    await expect(labelA).toHaveText(customTitle, { timeout: 10_000 });

    // Open C — A still inactive, B also becomes inactive.
    await page.locator('button[title="New session tab"]').click();
    const idC = await waitForBoundSession(page, { not: idB });
    await expect(labelA).toHaveText(customTitle, { timeout: 10_000 });

    // Back to A. The active tab label is now A's title (via the live
    // session_title broadcast), but the strip locator above doesn't
    // care which tab is active — it keys on idA — so the same
    // assertion proves the title survived the whole walk.
    await clickTab(page, idA);
    await page.waitForURL(new RegExp(`session=${idA}`), { timeout: 10_000 });
    await expect(labelA).toHaveText(customTitle, { timeout: 10_000 });
    expect(idC).not.toBe(idA);
  });
});
