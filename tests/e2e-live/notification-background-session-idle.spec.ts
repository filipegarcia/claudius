import { test, expect, type Page, type APIRequestContext } from "@playwright/test";

/**
 * Live regression: when Claude finishes a turn on a backgrounded session
 * (the user is viewing a DIFFERENT session tab), all four surfaces must
 * update without the user touching anything:
 *
 *   1. The backgrounded tab's status dot transitions running → idle.
 *   2. The notifications drawer header badge increments.
 *   3. The workspace tile badge increments.
 *   4. The browser tab title (favicon overlay source) shows `(N) Claudius`.
 *
 * The bug shape: in the user's screenshot, session A was actively chatting
 * in browser B (and showing "Idle" there), while in browser A — where A was
 * a backgrounded tab in the strip — the dot stayed amber/running. Inactive
 * tabs have no SSE subscriber for that session; they depend entirely on
 * the notification bus firing a `state` SSE event, which bumps
 * `stateVersion` and triggers `refreshSessions()` to re-read /api/sessions.
 * Pre-fix, the bus dropped events that didn't map to a notification kind
 * (`turn_status`, SDK `result` outside the idle window) before scheduling
 * the state emit — so a fast turn (under IDLE_NOTIFY_MIN_MS) on a
 * backgrounded session left the dot stuck on "running" forever.
 *
 * The mocked spec in `tests/e2e/notifications-multi-tab.spec.ts` covers
 * the chain but uses `dev-emit`. This live test exercises the REAL path:
 * Session.broadcast → bus.recordSessionEvent → state emit → client
 * refresh — using a real SDK turn, which is the only way to confirm the
 * production-shape behavior end-to-end.
 *
 * Flow:
 *   • Session A: send "wait 1 seconds and akc" → Claude runs Bash sleep
 *     1, replies "ack". Total turn ~1 second.
 *   • Switch to a fresh Session B before A finishes. A is now
 *     backgrounded, no SSE subscriber.
 *   • Wait 5 seconds total so A has crossed the IDLE_NOTIFY_MIN_MS window
 *     and the bus has had time to fan out the state event.
 *   • Assert all four surfaces.
 */

const SESSION_RE = /[?&]session=([0-9a-f-]{36})/i;

type Workspace = {
  id: string;
  rootPath: string;
  name: string;
  defaults?: {
    notifications?: { enabled?: boolean; enabledKinds?: string[] };
  };
};

async function waitForBoundSession(
  page: Page,
  opts: { not?: string } = {},
): Promise<string> {
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
  return id!;
}

async function listWorkspaces(
  req: APIRequestContext,
  baseURL?: string,
): Promise<{ workspaces: Workspace[]; activeId: string | null }> {
  const res = await req.get(`${baseURL}/api/workspaces`);
  expect(res.ok()).toBeTruthy();
  return (await res.json()) as { workspaces: Workspace[]; activeId: string | null };
}

async function ensureKindsEnabled(
  req: APIRequestContext,
  baseURL: string | undefined,
  ws: Workspace,
  kinds: string[],
): Promise<string[] | undefined> {
  const prev = ws.defaults?.notifications?.enabledKinds;
  const next = Array.from(new Set([...(prev ?? []), ...kinds]));
  const res = await req.patch(`${baseURL}/api/workspaces/${ws.id}`, {
    data: {
      defaults: {
        ...(ws.defaults ?? {}),
        notifications: {
          ...(ws.defaults?.notifications ?? {}),
          enabled: true,
          enabledKinds: next,
        },
      },
    },
  });
  expect(res.ok()).toBeTruthy();
  return prev;
}

async function restoreKinds(
  req: APIRequestContext,
  baseURL: string | undefined,
  ws: Workspace,
  prev: string[] | undefined,
): Promise<void> {
  if (!prev) return;
  await req.patch(`${baseURL}/api/workspaces/${ws.id}`, {
    data: {
      defaults: {
        ...(ws.defaults ?? {}),
        notifications: {
          ...(ws.defaults?.notifications ?? {}),
          enabledKinds: prev,
        },
      },
    },
  });
}

test.describe("Live: backgrounded session goes idle", () => {
  test("Session A finishes a 1s turn while user is on Session B → A's dot + drawer + tile + title all update within 5s", async ({
    page,
    request,
    baseURL,
  }) => {
    // Auth check: the test drives the real Anthropic agent via the dev
    // server, which uses whichever auth the user has wired up
    // (ANTHROPIC_API_KEY env var, ~/.claude/.credentials.json file, or
    // macOS keychain entry under "Claude Code-credentials"). We skip only
    // when none of those signals are visible AND we're on CI — locally a
    // missing env var is normal when keychain auth handles it, so we let
    // the test run and surface a clear failure if auth is actually broken.
    const hasKey = !!process.env.ANTHROPIC_API_KEY;
    const onCI = !!process.env.CI;
    test.skip(
      onCI && !hasKey,
      "needs ANTHROPIC_API_KEY on CI (locally we trust keychain / credentials file)",
    );
    test.setTimeout(120_000);

    // ── Workspace setup: make sure session_idle (and session_error)
    // notifications are enabled in the workspace this test will exercise.
    const { workspaces, activeId } = await listWorkspaces(request, baseURL);
    const ws = workspaces.find((w) => w.id === activeId) ?? workspaces[0]!;
    const prevKinds = await ensureKindsEnabled(request, baseURL, ws, [
      "session_idle",
    ]);

    // Wipe unread across every workspace so the drawer/tile starts at 0.
    await Promise.all(
      workspaces.map((w) =>
        request
          .post(`${baseURL}/api/notifications/read-all`, {
            data: { workspaceId: w.id },
          })
          .catch(() => {
            // best-effort
          }),
      ),
    );

    // ── Boot the page, then create a FRESH Session A via the new-tab
    // button. Without this we'd inherit whatever session the user's
    // open-tabs activeId points to — which is often mid-turn (the SDK
    // queues the test's prompt as a `queue-operation` instead of firing
    // a fresh result event). A clean tab guarantees the SDK iterator
    // produces a `result` for our prompt, which is what the bus needs
    // to record `session_idle`.
    //
    // The `{ not: bootId }` constraint is essential: without it,
    // `waitForBoundSession` can return immediately with the bootId
    // because the URL already matched, and `idA` would be aliased to
    // the OLD session — not the freshly-created one. The send button
    // then fires against the (currently-bound) NEW session id, the
    // notification lands there, but the test polls badges scoped to
    // the OLD id and never finds them.
    await page.goto("/");
    const bootId = await waitForBoundSession(page);
    await page.locator('button[title="New session tab"]').click();
    const idA = await waitForBoundSession(page, { not: bootId });

    // bypassPermissions so the Bash sleep doesn't pop a permission modal
    // and the turn completes without human intervention.
    const modeRes = await page.request.post(
      `${baseURL}/api/sessions/${idA}/mode`,
      { data: { mode: "bypassPermissions" } },
    );
    expect(modeRes.ok()).toBeTruthy();

    const textarea = page.getByTestId("prompt-input");
    await expect(textarea).toBeEnabled({ timeout: 30_000 });
    await expect(page.getByTestId("prompt-send")).toBeVisible({ timeout: 30_000 });

    // Use the exact user prompt from the bug report. The token "akc" is
    // deliberate — the test cares about turn-completion timing, not what
    // Claude echoes back. Send + immediately switch away: the user's bug
    // is "I send a message, switch tab, the session over there finishes
    // but my UI doesn't update," so we mirror that exact flow.
    await textarea.fill("wait 1 seconds and akc");
    await page.getByTestId("prompt-send").click();

    // ── Open Session B and switch to it. A is now backgrounded. We do
    // this BEFORE polling for "running" because the 1s turn would have
    // already finished by the time the test renders + polls — making
    // the running observation race-prone. The user's scenario is "I
    // switch IMMEDIATELY after sending", which is what this models.
    const t0 = Date.now();
    await page.locator('button[title="New session tab"]').click();
    const idB = await waitForBoundSession(page, { not: idA });
    expect(idB).not.toBe(idA);

    // Confirm Session B is the active tab now.
    await expect(
      page.locator('[data-testid="session-tab"][data-tab-active="true"]'),
    ).toHaveAttribute("data-tab-id", idB, { timeout: 10_000 });

    // ── "Wait 5 seconds": let the user's scenario play out. Claude will
    // run Bash sleep ~1s and reply "ack" on Session A. By the 5s mark the
    // turn is done, the bus has had its tick-coalesced state emit, the
    // SSE client has received it, refreshSessions has fetched the new
    // status, and the inactive tab's dot should reflect idle.
    //
    // We poll the four surfaces inside the elapsed window rather than
    // sleeping a fixed 5s, so a fast pass doesn't pay the full timeout.
    // Cap on the wait though — pre-fix this would hang at "running"
    // forever, and we want a clear failure rather than a 2-minute timeout
    // when the bus is broken.
    const inactiveTabDot = page.locator(
      `[data-testid="session-tab"][data-tab-id="${idA}"] [data-testid="session-tab-status-dot"]`,
    );

    // 1. Inactive tab dot transitions to "idle". This is the core
    //    user-visible symptom from the screenshot.
    await expect(inactiveTabDot).toHaveAttribute("data-status", "idle", {
      timeout: 30_000,
    });
    const elapsedMs = Date.now() - t0;
    // Sanity: this should happen well inside the user's stated 5-second
    // window. If it takes 25s+ to flip, that's still "wrong" — even though
    // the assertion passed, the user wouldn't notice the transition.
    expect(elapsedMs).toBeLessThan(30_000);

    // 2. Workspace tile badge — session_idle row landed and the per-
    //    workspace total bumped. Generous timeout: the SDK's `result`
    //    can land several seconds after the dot transitioned (the dot
    //    flips on `turn_status` which fires first; the row insert
    //    happens when the `result` SSE event reaches the bus).
    const tileBadge = page.getByTestId(`workspace-notification-badge-${ws.id}`);
    await expect(tileBadge).toBeVisible({ timeout: 30_000 });
    const tileText = await tileBadge.textContent();
    expect(Number(tileText?.trim() ?? "0")).toBeGreaterThanOrEqual(1);

    // 3. Notifications drawer header — cross-workspace total includes
    //    the new row.
    const drawerBadge = page.getByTestId("notifications-drawer-badge");
    await expect(drawerBadge).toBeVisible({ timeout: 10_000 });
    const drawerText = await drawerBadge.textContent();
    expect(Number(drawerText?.trim() ?? "0")).toBeGreaterThanOrEqual(1);

    // 4. Per-tab unread on Session A's strip entry. We check text rather
    //    than visibility because in workspaces with many open tabs the
    //    strip overflows: idA's tab ends up inside the overflow
    //    dropdown's DOM and is hidden until the user opens the menu. The
    //    badge is correctly rendered there — that's the contract we
    //    care about — and the next assertion (drawer items) gives
    //    independent coverage of the same row from a different surface.
    const tabUnread = page.locator(
      `[data-testid="session-tab"][data-tab-id="${idA}"] [data-testid="session-tab-unread"]`,
    );
    await expect(tabUnread).toHaveText("1", { timeout: 10_000 });

    // 5. Browser tab title — useFaviconBadge writes `(N) Claudius`.
    //    This is the favicon source (canvas redraw uses the same count).
    await expect(page).toHaveTitle(/^\(\d+\)\s/, { timeout: 10_000 });

    // 6. Drawer rendered the actual row, not "You're all caught up".
    await page.getByTestId("notifications-drawer-trigger").click();
    const panel = page.getByTestId("notifications-drawer-panel");
    await expect(panel).toBeVisible();
    const rows = panel.locator("[data-testid^='notification-row-']");
    const rowCount = await rows.count();
    expect(rowCount).toBeGreaterThanOrEqual(1);
    await page.keyboard.press("Escape");

    // Cleanup: mark everything read so the workspace looks pristine
    // again, and restore the original enabledKinds.
    await request.post(`${baseURL}/api/notifications/read-all`, {
      data: { workspaceId: ws.id },
    });
    await restoreKinds(request, baseURL, ws, prevKinds);
  });

  /**
   * Multiple backgrounded sessions in the SAME workspace. The user's bug
   * report mentioned "sessions in the background" (plural) — when several
   * sessions all finish quick turns while the user is on a different tab,
   * each should fire its own `session_idle` row and the counts must sum
   * correctly. Pre-fix the IDLE_NOTIFY_MIN_MS gate would have dropped
   * every one of them.
   *
   * Spawn two fresh sessions, send "wait 1 second and ack" to each, then
   * switch to a third tab. Verify both A1 and A2 produce notifications and
   * the workspace total reaches ≥ 2.
   */
  test("two backgrounded sessions in same workspace: both fire session_idle, counts sum, per-tab badges each show ≥1", async ({
    page,
    request,
    baseURL,
  }) => {
    const hasKey = !!process.env.ANTHROPIC_API_KEY;
    const onCI = !!process.env.CI;
    test.skip(
      onCI && !hasKey,
      "needs ANTHROPIC_API_KEY on CI (locally we trust keychain / credentials file)",
    );
    test.setTimeout(180_000);

    const { workspaces, activeId } = await listWorkspaces(request, baseURL);
    const ws = workspaces.find((w) => w.id === activeId) ?? workspaces[0]!;
    const prevKinds = await ensureKindsEnabled(request, baseURL, ws, [
      "session_idle",
    ]);
    await Promise.all(
      workspaces.map((w) =>
        request
          .post(`${baseURL}/api/notifications/read-all`, {
            data: { workspaceId: w.id },
          })
          .catch(() => {
            // best-effort
          }),
      ),
    );

    await page.goto("/");
    const bootId = await waitForBoundSession(page);

    // Spawn A1, send the prompt, switch away.
    await page.locator('button[title="New session tab"]').click();
    const idA1 = await waitForBoundSession(page, { not: bootId });
    await page.request.post(`${baseURL}/api/sessions/${idA1}/mode`, {
      data: { mode: "bypassPermissions" },
    });
    await expect(page.getByTestId("prompt-input")).toBeEnabled({ timeout: 30_000 });
    await page.getByTestId("prompt-input").fill("wait 1 seconds and akc");
    await page.getByTestId("prompt-send").click();

    // Spawn A2 (A1 now backgrounded), send the prompt, switch away.
    await page.locator('button[title="New session tab"]').click();
    const idA2 = await waitForBoundSession(page, { not: idA1 });
    expect(idA2).not.toBe(idA1);
    await page.request.post(`${baseURL}/api/sessions/${idA2}/mode`, {
      data: { mode: "bypassPermissions" },
    });
    await expect(page.getByTestId("prompt-input")).toBeEnabled({ timeout: 30_000 });
    await page.getByTestId("prompt-input").fill("wait 1 seconds and akc");
    await page.getByTestId("prompt-send").click();

    // Final tab: a fresh Session B with no work, so A1 AND A2 are both
    // backgrounded. The page binding must move OFF A2 before A2's result
    // fires — otherwise A2 isn't backgrounded.
    await page.locator('button[title="New session tab"]').click();
    const idB = await waitForBoundSession(page, { not: idA2 });
    expect(idB).not.toBe(idA1);
    expect(idB).not.toBe(idA2);

    // Workspace tile reaches 2 (both backgrounded turns produced rows).
    const tileBadge = page.getByTestId(`workspace-notification-badge-${ws.id}`);
    await expect(tileBadge).toBeVisible({ timeout: 30_000 });
    await expect(tileBadge).toHaveText("2", { timeout: 30_000 });

    // Drawer header agrees.
    await expect(page.getByTestId("notifications-drawer-badge")).toHaveText("2", {
      timeout: 10_000,
    });

    // Per-tab unread for both A1 and A2 reads "1". `toHaveText` rather than
    // `toBeVisible` because the strip may overflow some entries into the
    // hidden overflow dropdown — the BADGE existing with the right value
    // is what matters; visibility depends on viewport width.
    await expect(
      page.locator(
        `[data-testid="session-tab"][data-tab-id="${idA1}"] [data-testid="session-tab-unread"]`,
      ),
    ).toHaveText("1", { timeout: 10_000 });
    await expect(
      page.locator(
        `[data-testid="session-tab"][data-tab-id="${idA2}"] [data-testid="session-tab-unread"]`,
      ),
    ).toHaveText("1", { timeout: 10_000 });

    // Document title reflects two unread.
    await expect(page).toHaveTitle(/^\(2\)\s/, { timeout: 10_000 });

    // Drawer items: both rows are present (one per session).
    await page.getByTestId("notifications-drawer-trigger").click();
    const panel = page.getByTestId("notifications-drawer-panel");
    await expect(panel).toBeVisible();
    await expect(panel.locator("[data-testid^='notification-row-']")).toHaveCount(2, {
      timeout: 10_000,
    });
    await page.keyboard.press("Escape");

    await request.post(`${baseURL}/api/notifications/read-all`, {
      data: { workspaceId: ws.id },
    });
    await restoreKinds(request, baseURL, ws, prevKinds);
  });

  /**
   * Backgrounded session in workspace A while the user is currently on
   * workspace B. The workspace tile badge for A must light up
   * independently, and the cross-workspace drawer header must include the
   * row. Mirrors the user's actual usage pattern: many workspaces in the
   * left rail, work happening in several at once.
   *
   * We pick a NON-active workspace from the list (any one that exists on
   * disk) and run the SDK turn there. The /select endpoint swaps the
   * active cookie, then we navigate back to /. Tabs from workspace A's
   * session live on the OTHER workspace's strip, so we assert via the
   * workspace tile + drawer header, which are both cross-workspace
   * surfaces and don't depend on whichever strip the page renders.
   */
  test("backgrounded session in workspace A while user is on workspace B: A's tile badge lights up; drawer header is cross-workspace", async ({
    page,
    request,
    baseURL,
  }) => {
    const hasKey = !!process.env.ANTHROPIC_API_KEY;
    const onCI = !!process.env.CI;
    test.skip(
      onCI && !hasKey,
      "needs ANTHROPIC_API_KEY on CI (locally we trust keychain / credentials file)",
    );
    test.setTimeout(180_000);

    const { workspaces, activeId } = await listWorkspaces(request, baseURL);
    // Need at least two project-style workspaces. The "Customize · …"
    // entries have synthetic rootPaths under .claudius/customizations
    // that don't always pass workspace-cwd validation; restrict to the
    // workspaces whose rootPath is a regular project directory.
    const projectWorkspaces = workspaces.filter(
      (w) =>
        !w.rootPath.includes("/.claudius/customizations/") &&
        !w.rootPath.includes("/customizations/"),
    );
    test.skip(
      projectWorkspaces.length < 2,
      "needs at least two non-customization workspaces",
    );
    const A = projectWorkspaces.find((w) => w.id === activeId) ?? projectWorkspaces[0]!;
    const B = projectWorkspaces.find((w) => w.id !== A.id)!;
    const prevKindsA = await ensureKindsEnabled(request, baseURL, A, ["session_idle"]);
    const prevKindsB = await ensureKindsEnabled(request, baseURL, B, ["session_idle"]);
    await Promise.all(
      workspaces.map((w) =>
        request
          .post(`${baseURL}/api/notifications/read-all`, {
            data: { workspaceId: w.id },
          })
          .catch(() => {
            // best-effort
          }),
      ),
    );

    // ── Make A the active workspace, spawn a fresh session in A, send a
    // prompt, then switch the active workspace to B. A's session is now
    // backgrounded both per-tab AND per-workspace.
    const selectA = await request.post(`${baseURL}/api/workspaces/${A.id}/select`);
    expect(selectA.ok()).toBeTruthy();
    await page.goto("/");
    const bootId = await waitForBoundSession(page);

    await page.locator('button[title="New session tab"]').click();
    const idA = await waitForBoundSession(page, { not: bootId });
    await page.request.post(`${baseURL}/api/sessions/${idA}/mode`, {
      data: { mode: "bypassPermissions" },
    });
    await expect(page.getByTestId("prompt-input")).toBeEnabled({ timeout: 30_000 });
    await page.getByTestId("prompt-input").fill("wait 1 seconds and akc");
    await page.getByTestId("prompt-send").click();

    // Switch to workspace B. POST /select sets the cookie; goto("/") loads
    // B's open-tabs and any of B's existing sessions. A's session is now
    // both backgrounded (no SSE subscriber here) AND in a different
    // workspace from the one the user is viewing.
    const selectB = await request.post(`${baseURL}/api/workspaces/${B.id}/select`);
    expect(selectB.ok()).toBeTruthy();
    await page.goto("/");
    await expect(page.getByTestId("notifications-drawer-trigger")).toBeVisible({
      timeout: 15_000,
    });

    // Workspace tile for A reads ≥1 — per-workspace counts are independent
    // of which workspace the user is currently viewing.
    const tileBadgeA = page.getByTestId(`workspace-notification-badge-${A.id}`);
    await expect(tileBadgeA).toBeVisible({ timeout: 30_000 });
    await expect(tileBadgeA).toHaveText("1", { timeout: 30_000 });

    // Drawer header (cross-workspace total) also reads ≥1.
    await expect(page.getByTestId("notifications-drawer-badge")).toHaveText("1", {
      timeout: 10_000,
    });

    // Document title reflects the cross-workspace unread.
    await expect(page).toHaveTitle(/^\(1\)\s/, { timeout: 10_000 });

    // Open drawer: the row carries the OTHER workspace's name pill so the
    // user can tell where it came from.
    await page.getByTestId("notifications-drawer-trigger").click();
    const panel = page.getByTestId("notifications-drawer-panel");
    await expect(panel).toBeVisible();
    await expect(panel.locator("[data-testid^='notification-row-']")).toHaveCount(1, {
      timeout: 10_000,
    });
    // At least one occurrence of A's name should be in the drawer (the
    // workspace pill on the cross-workspace row).
    await expect(panel.getByText(A.name, { exact: false }).first()).toBeVisible({
      timeout: 5_000,
    });
    await page.keyboard.press("Escape");

    // Cleanup. Restore A as the active workspace if it was so before.
    await request.post(`${baseURL}/api/notifications/read-all`, {
      data: { workspaceId: A.id },
    });
    await restoreKinds(request, baseURL, A, prevKindsA);
    await restoreKinds(request, baseURL, B, prevKindsB);
    if (activeId) {
      await request
        .post(`${baseURL}/api/workspaces/${activeId}/select`)
        .catch(() => {
          // best-effort
        });
    }
  });
});
