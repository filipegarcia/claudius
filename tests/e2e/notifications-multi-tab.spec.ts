import { test, expect, type Page, type APIRequestContext } from "../helpers/test";

const SESSION_RE = /[?&]session=([0-9a-f-]{36})/i;

/**
 * End-to-end coverage for the multi-tab / multi-workspace notification fan-out.
 *
 * The scenario behind every assertion in here is the one the user has been
 * surfacing: they have several session tabs open, switch between them, finish
 * work on one, look at the activity rail to see what's new. The four surfaces
 * involved — workspace tile badge, per-tab unread badge, notifications drawer
 * header badge, drawer item list — must always agree. Previously the bus
 * dropped session_idle / session_error rows entirely when the originating
 * session had zero SSE subscribers (user switched away), which made
 * backgrounded turns completely invisible. The fix persists the row + emits
 * the `state` event regardless, and only suppresses the per-row `notification`
 * SSE event (the OS-toast feed) for the switched-away case.
 *
 * Drives the bus through `/api/notifications/dev-emit`, which lets the test
 * fake `hasSubscribers: false` without standing up real SDK sessions. The
 * dev-emit endpoint 404s in production.
 */

type Workspace = {
  id: string;
  rootPath: string;
  name: string;
  defaults?: {
    notifications?: { enabled?: boolean; enabledKinds?: string[] };
  };
};

async function listWorkspaces(
  req: APIRequestContext,
  baseURL?: string,
): Promise<{ workspaces: Workspace[]; activeId: string | null }> {
  const res = await req.get(`${baseURL}/api/workspaces`);
  expect(res.ok()).toBeTruthy();
  return (await res.json()) as { workspaces: Workspace[]; activeId: string | null };
}

async function waitForBoundSession(page: Page): Promise<string> {
  await page.waitForURL((url) => SESSION_RE.test(String(url)), { timeout: 30_000 });
  const m = page.url().match(SESSION_RE);
  expect(m).toBeTruthy();
  return m![1];
}

/**
 * Force the workspace to have the kinds we need for the test. session_error
 * is opt-in (off by default) so any test that emits it has to enable it
 * explicitly; session_idle is in defaults but harmless to ensure. Persists
 * the original `enabledKinds` so the cleanup hook can restore.
 */
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

/**
 * Clear unread on every workspace. The drawer header badge counts
 * cross-workspace, so leftover unread in OTHER workspaces (from prior tests
 * or the user's own dev poking) will throw off `toHaveText("N")` assertions
 * against the drawer badge. Wiping everything at test start gives us a
 * stable baseline. Idempotent.
 */
async function clearAllWorkspacesUnread(
  req: APIRequestContext,
  baseURL: string | undefined,
  workspaces: Workspace[],
): Promise<void> {
  await Promise.all(
    workspaces.map((w) =>
      req
        .post(`${baseURL}/api/notifications/read-all`, {
          data: { workspaceId: w.id },
        })
        .catch(() => {
          // Some fixture workspaces may have no DB yet — best-effort.
        }),
    ),
  );
}

async function devEmit(
  req: APIRequestContext,
  baseURL: string | undefined,
  args: {
    cwd: string;
    sessionId: string;
    kind: "session_error" | "permission_request";
    message?: string;
    /** Forwarded to the bus to simulate a backgrounded (switched-away) session. */
    hasSubscribers?: boolean;
  },
): Promise<void> {
  const event =
    args.kind === "session_error"
      ? { type: "error" as const, message: args.message ?? "e2e-multi-tab" }
      : {
          type: "permission_request" as const,
          requestId: `r-${Math.random().toString(36).slice(2)}`,
          toolName: "Bash",
          toolUseId: `t-${Math.random().toString(36).slice(2)}`,
          input: {},
        };
  const res = await req.post(`${baseURL}/api/notifications/dev-emit`, {
    data: {
      cwd: args.cwd,
      sessionId: args.sessionId,
      event,
      ...(typeof args.hasSubscribers === "boolean"
        ? { hasSubscribers: args.hasSubscribers }
        : {}),
    },
  });
  expect(res.ok()).toBeTruthy();
}

const SYNTHETIC_TAB_A = "11111111-1111-4111-8111-111111111111";
const SYNTHETIC_TAB_B = "22222222-2222-4222-8222-222222222222";
const SYNTHETIC_TAB_C = "33333333-3333-4333-8333-333333333333";
const SYNTHETIC_TAB_IDS = new Set([SYNTHETIC_TAB_A, SYNTHETIC_TAB_B, SYNTHETIC_TAB_C]);

test.describe("Notifications: multi-tab + workspace switching", () => {
  // Belt-and-braces cleanup: each test restores open-tabs in its own
  // finally-equivalent path, but if an assertion fails BEFORE that cleanup
  // runs the synthetic UUIDs stay in `/api/sessions/open-tabs` for the
  // user's real Claudius. The chat-page boot then tries to bind to one of
  // these IDs, the SDK can't find the JSONL, and the dev console fills
  // with `Claude Code returned an error result: No conversation found
  // with session ID: 11111111-…`. Strip them globally after every test
  // regardless of test-level cleanup. Idempotent.
  test.afterEach(async ({ request, baseURL }) => {
    try {
      const res = await request.get(`${baseURL}/api/sessions/open-tabs`);
      if (!res.ok()) return;
      const data = (await res.json()) as {
        tabs?: string[];
        activeId?: string | null;
      };
      const dirty =
        (data.tabs ?? []).some((t) => SYNTHETIC_TAB_IDS.has(t)) ||
        (data.activeId != null && SYNTHETIC_TAB_IDS.has(data.activeId));
      if (!dirty) return;
      await request.put(`${baseURL}/api/sessions/open-tabs`, {
        data: {
          tabs: (data.tabs ?? []).filter((t) => !SYNTHETIC_TAB_IDS.has(t)),
          activeId:
            data.activeId && !SYNTHETIC_TAB_IDS.has(data.activeId)
              ? data.activeId
              : null,
        },
      });
    } catch {
      // best-effort — never fail a test because of cleanup
    }
  });

  test("backgrounded session badge: per-tab + workspace tile + drawer all agree after a switched-away notification", async ({
    page,
    request,
    baseURL,
  }) => {
    await page.goto("/");
    const realSessionId = await waitForBoundSession(page);
    const { workspaces, activeId } = await listWorkspaces(request, baseURL);
    const active = workspaces.find((w) => w.id === activeId) ?? workspaces[0]!;
    const prevKinds = await ensureKindsEnabled(request, baseURL, active, [
      "session_error",
      "session_idle",
    ]);
    // Wipe EVERY workspace so the cross-workspace drawer header starts at 0;
    // a single leftover unread in any other workspace would otherwise inflate
    // the drawer count and make the assertion-by-exact-number flake.
    await clearAllWorkspacesUnread(request, baseURL, workspaces);

    // Capture the existing openTabs so we can restore them at the end.
    // Without this, every subsequent test inherits our synthetic tab IDs and
    // — worse — the active marker we wrote, which makes the page boot bound
    // to a synthetic UUID with no real Session backing it. Downstream tests
    // that rely on auto-read gating (sessionId === activeSessionId) then
    // misfire because the active id IS the fake id they emit against.
    const tabsBefore = (await (await request.get(`${baseURL}/api/sessions/open-tabs`)).json()) as {
      tabs?: string[];
      activeId?: string | null;
      labelMaxWidth?: number;
    };

    // Stub GET /api/sessions/open-tabs so the server's sanitization filter
    // (which removes session IDs not present in listIndexedSessions) doesn't
    // silently drop SYNTHETIC_TAB_A/B. We include the real session so the
    // boot's activeId → resume path still finds a real session to bind to.
    await page.route("**/api/sessions/open-tabs", async (route) => {
      if (route.request().method() !== "GET") return route.fallback();
      await route.fulfill({
        status: 200,
        contentType: "application/json",
        body: JSON.stringify({
          tabs: [realSessionId, SYNTHETIC_TAB_A, SYNTHETIC_TAB_B],
          activeId: realSessionId,
          labelMaxWidth: 180,
        }),
      });
    });

    // Seed the tab strip with two synthetic IDs that are NOT the bound
    // session (the bound id auto-reads). These IDs aren't in sessionManager,
    // so the dot will paint "background" (gray) — that's fine; this test
    // doesn't assert dot state, it asserts the unread badge.
    await request.put(`${baseURL}/api/sessions/open-tabs`, {
      data: { tabs: [SYNTHETIC_TAB_A, SYNTHETIC_TAB_B] },
    });
    await page.reload();
    await waitForBoundSession(page);
    // The reload re-adds the bound session id to openTabs via the auto-add
    // effect; we expect three tabs total. The synthetic ones must be present.
    await expect(page.locator(`[data-tab-id="${SYNTHETIC_TAB_A}"]`)).toBeAttached({
      timeout: 10_000,
    });
    await expect(page.locator(`[data-tab-id="${SYNTHETIC_TAB_B}"]`)).toBeAttached();
    await expect(page.getByTestId("notifications-drawer-trigger")).toBeVisible({
      timeout: 15_000,
    });

    // ── Phase 1: emit ONE session_error on tab A with hasSubscribers=false.
    // This is the failure mode: user switched away from session A, A finishes
    // a turn / errors. The fix: bus must still persist the row and emit a
    // `state` event so every badge ticks.
    await devEmit(request, baseURL, {
      cwd: active.rootPath,
      sessionId: SYNTHETIC_TAB_A,
      kind: "session_error",
      message: "bg-A-1",
      hasSubscribers: false,
    });

    const tileBadge = page.getByTestId(`workspace-notification-badge-${active.id}`);
    const drawerBadge = page.getByTestId("notifications-drawer-badge");
    await expect(tileBadge).toHaveText("1", { timeout: 15_000 });
    await expect(drawerBadge).toHaveText("1");

    // Per-tab badge: the strip reads `notifications.unreadBySession[A]`
    // which is fed from the bus's `perSession` map inside the state event.
    // Without the fix, this would never have ticked above 0.
    const tabBadgeA = page
      .locator(`[data-tab-id="${SYNTHETIC_TAB_A}"]`)
      .getByTestId("session-tab-unread");
    await expect(tabBadgeA).toHaveText("1", { timeout: 10_000 });

    // ── Phase 2: emit TWO more on tab B, also backgrounded.
    await devEmit(request, baseURL, {
      cwd: active.rootPath,
      sessionId: SYNTHETIC_TAB_B,
      kind: "session_error",
      message: "bg-B-1",
      hasSubscribers: false,
    });
    await devEmit(request, baseURL, {
      cwd: active.rootPath,
      sessionId: SYNTHETIC_TAB_B,
      kind: "session_error",
      message: "bg-B-2",
      hasSubscribers: false,
    });

    await expect(tileBadge).toHaveText("3");
    await expect(drawerBadge).toHaveText("3");
    const tabBadgeB = page
      .locator(`[data-tab-id="${SYNTHETIC_TAB_B}"]`)
      .getByTestId("session-tab-unread");
    await expect(tabBadgeB).toHaveText("2");

    // ── Phase 3: open the drawer and verify the cross-row list. Three rows,
    // all visible, no client-side filter eating older ones (the redesign
    // pushes `unreadOnly=1` to SQL).
    await page.getByTestId("notifications-drawer-trigger").click();
    const panel = page.getByTestId("notifications-drawer-panel");
    await expect(panel).toBeVisible();
    const rows = panel.locator("[data-testid^='notification-row-']");
    await expect(rows).toHaveCount(3);

    // ── Phase 4: clicking the tab marks its unread read (markSessionRead is
    // wired into onSelect in app/page.tsx). After clicking tab A, A's badge
    // disappears, tile drops to 2, drawer to 2.
    await page.keyboard.press("Escape");
    await expect(panel).not.toBeVisible();
    await page.locator(`[data-tab-id="${SYNTHETIC_TAB_A}"]`).click();
    await expect(tabBadgeA).toHaveCount(0, { timeout: 10_000 });
    await expect(tileBadge).toHaveText("2");
    await expect(drawerBadge).toHaveText("2");

    // ── Phase 5: mark-all-read clears the rest.
    await request.post(`${baseURL}/api/notifications/read-all`, {
      data: { workspaceId: active.id },
    });
    await expect(tileBadge).not.toBeVisible({ timeout: 10_000 });
    await expect(drawerBadge).not.toBeVisible();
    await expect(tabBadgeB).toHaveCount(0);

    // ── Cleanup: restore enabledKinds + the original openTabs list so
    // downstream tests don't boot bound to a synthetic UUID.
    await page.unroute("**/api/sessions/open-tabs");
    await restoreKinds(request, baseURL, active, prevKinds);
    await request.put(`${baseURL}/api/sessions/open-tabs`, {
      data: {
        tabs: (tabsBefore.tabs ?? []).filter(
          (t) => t !== SYNTHETIC_TAB_A && t !== SYNTHETIC_TAB_B && t !== SYNTHETIC_TAB_C,
        ),
        activeId:
          tabsBefore.activeId &&
          tabsBefore.activeId !== SYNTHETIC_TAB_A &&
          tabsBefore.activeId !== SYNTHETIC_TAB_B &&
          tabsBefore.activeId !== SYNTHETIC_TAB_C
            ? tabsBefore.activeId
            : null,
      },
    });
  });

  test("workspace switch: per-workspace tile badges + cross-workspace drawer total", async ({
    page,
    request,
    baseURL,
  }) => {
    await page.goto("/");
    await waitForBoundSession(page);
    const { workspaces, activeId } = await listWorkspaces(request, baseURL);
    // Need two workspaces to switch between. Skip if the fixture is single.
    test.skip(
      workspaces.length < 2,
      "needs at least two workspaces to exercise workspace switching",
    );
    const a = workspaces.find((w) => w.id === activeId) ?? workspaces[0]!;
    const b = workspaces.find((w) => w.id !== a.id)!;
    const prevA = await ensureKindsEnabled(request, baseURL, a, ["session_error"]);
    const prevB = await ensureKindsEnabled(request, baseURL, b, ["session_error"]);
    await clearAllWorkspacesUnread(request, baseURL, workspaces);

    await expect(page.getByTestId("notifications-drawer-trigger")).toBeVisible({
      timeout: 15_000,
    });

    // Emit 2 in A, 3 in B, all backgrounded.
    for (let i = 0; i < 2; i++) {
      await devEmit(request, baseURL, {
        cwd: a.rootPath,
        sessionId: SYNTHETIC_TAB_A,
        kind: "session_error",
        message: `cross-a-${i}`,
        hasSubscribers: false,
      });
    }
    for (let i = 0; i < 3; i++) {
      await devEmit(request, baseURL, {
        cwd: b.rootPath,
        sessionId: SYNTHETIC_TAB_C,
        kind: "session_error",
        message: `cross-b-${i}`,
        hasSubscribers: false,
      });
    }

    // Workspace tiles paint per-workspace counts independently.
    const tileA = page.getByTestId(`workspace-notification-badge-${a.id}`);
    const tileB = page.getByTestId(`workspace-notification-badge-${b.id}`);
    await expect(tileA).toHaveText("2", { timeout: 15_000 });
    await expect(tileB).toHaveText("3");

    // The drawer is cross-workspace: header badge counts everything.
    const drawerBadge = page.getByTestId("notifications-drawer-badge");
    await expect(drawerBadge).toHaveText("5");

    // Open drawer — should see rows from BOTH workspaces. Rows for the
    // non-active workspace carry a small workspace-name pill so the user
    // can tell where each row came from before clicking.
    await page.getByTestId("notifications-drawer-trigger").click();
    const panel = page.getByTestId("notifications-drawer-panel");
    await expect(panel).toBeVisible();
    const rows = panel.locator("[data-testid^='notification-row-']");
    await expect(rows).toHaveCount(5);
    // At least one row should display the non-active workspace's name pill.
    const nonActive = a.id === activeId ? b : a;
    await expect(panel.getByText(nonActive.name, { exact: false }).first()).toBeVisible();
    await page.keyboard.press("Escape");

    // Switch to workspace B by POSTing to /select then navigating. We don't
    // click the tile because its onClick triggers `window.location.assign`
    // to the workspace's last-visited URL, which can be any page (sessions,
    // files, etc.), and then `waitForLoadState("networkidle")` would never
    // resolve because the SSE stream keeps the network busy forever. The
    // explicit goto gives us a deterministic destination + sane wait.
    const selectRes = await request.post(`${baseURL}/api/workspaces/${b.id}/select`);
    expect(selectRes.ok()).toBeTruthy();
    await page.goto("/");
    // Workspace switcher remounts; wait for the drawer trigger to indicate
    // the NotificationsProvider has resubscribed to the SSE.
    await expect(page.getByTestId("notifications-drawer-trigger")).toBeVisible({
      timeout: 15_000,
    });
    // After switching, the drawer header is still 5 (cross-workspace), but
    // both tile badges should still reflect their respective per-workspace
    // counts.
    await expect(page.getByTestId("notifications-drawer-badge")).toHaveText("5", {
      timeout: 15_000,
    });
    await expect(page.getByTestId(`workspace-notification-badge-${a.id}`)).toHaveText("2");
    await expect(page.getByTestId(`workspace-notification-badge-${b.id}`)).toHaveText("3");

    // Clean up rows + restore kinds.
    await request.post(`${baseURL}/api/notifications/read-all`, {
      data: { workspaceId: a.id },
    });
    await request.post(`${baseURL}/api/notifications/read-all`, {
      data: { workspaceId: b.id },
    });
    await restoreKinds(request, baseURL, a, prevA);
    await restoreKinds(request, baseURL, b, prevB);
    // Restore the originally-active workspace so the next test starts where
    // the dev server's cookie pointed before we ran. Skipping this leaks
    // state across tests and stalls follow-up specs that assert against the
    // *previous* active workspace's id.
    if (activeId) {
      await request
        .post(`${baseURL}/api/workspaces/${activeId}/select`)
        .catch(() => {
          // Best-effort — a failed restore at most affects ordering in the
          // next test, which has its own getActiveWorkspace lookup.
        });
    }
  });

  test("workspace settings: disabling a kind clears existing unread of that kind", async ({
    page,
    request,
    baseURL,
  }) => {
    // The user's explicit ask: "when I remove a notification from settings,
    // you should mark that type from that workspace as read also". Test
    // verifies the POST /api/notifications/read-by-kind side effect that
    // fires from the workspace settings page on Save.
    await page.goto("/");
    await waitForBoundSession(page);
    const { workspaces, activeId } = await listWorkspaces(request, baseURL);
    const ws = workspaces.find((w) => w.id === activeId) ?? workspaces[0]!;
    const prev = await ensureKindsEnabled(request, baseURL, ws, ["session_error"]);
    await clearAllWorkspacesUnread(request, baseURL, workspaces);

    // Plant 2 session_error rows on a backgrounded tab.
    for (let i = 0; i < 2; i++) {
      await devEmit(request, baseURL, {
        cwd: ws.rootPath,
        sessionId: SYNTHETIC_TAB_A,
        kind: "session_error",
        message: `disable-kind-${i}`,
        hasSubscribers: false,
      });
    }
    const tileBadge = page.getByTestId(`workspace-notification-badge-${ws.id}`);
    await expect(tileBadge).toHaveText("2", { timeout: 15_000 });

    // Call the read-by-kind endpoint directly — the settings page does this
    // for every kind the user removed before persisting the new enabledKinds.
    const res = await request.post(`${baseURL}/api/notifications/read-by-kind`, {
      data: { workspaceId: ws.id, kind: "session_error" },
    });
    expect(res.ok()).toBeTruthy();

    // Badge should drop to zero once the SSE state event reaches the
    // provider.
    await expect(tileBadge).not.toBeVisible({ timeout: 10_000 });

    await restoreKinds(request, baseURL, ws, prev);
  });

  test("disabled workspace: emitting under workspace.notifications.enabled=false drops the row entirely", async ({
    page,
    request,
    baseURL,
  }) => {
    // Sanity check on the workspace master switch. With enabled=false, the
    // bus must drop everything — no row, no tile badge, no drawer entry.
    // Separate from the per-kind background suppression because this is a
    // user-facing "off" toggle, not a "tab switched away" gate.
    await page.goto("/");
    await waitForBoundSession(page);
    const { workspaces, activeId } = await listWorkspaces(request, baseURL);
    const ws = workspaces.find((w) => w.id === activeId) ?? workspaces[0]!;
    await clearAllWorkspacesUnread(request, baseURL, workspaces);
    const prevEnabled = ws.defaults?.notifications?.enabled !== false;

    // Disable.
    await request.patch(`${baseURL}/api/workspaces/${ws.id}`, {
      data: {
        defaults: {
          ...(ws.defaults ?? {}),
          notifications: {
            ...(ws.defaults?.notifications ?? {}),
            enabled: false,
          },
        },
      },
    });

    await devEmit(request, baseURL, {
      cwd: ws.rootPath,
      sessionId: SYNTHETIC_TAB_A,
      kind: "permission_request",
      hasSubscribers: false,
    });

    // Give SSE a beat to deliver any (hypothetical) state event.
    await page.waitForTimeout(500);
    // No badge should appear.
    await expect(
      page.getByTestId(`workspace-notification-badge-${ws.id}`),
    ).not.toBeVisible();
    // And the server's authoritative list is empty.
    const r = await request.get(
      `${baseURL}/api/notifications?workspace=${ws.id}&limit=5&unreadOnly=1`,
    );
    const items = ((await r.json()) as { items: unknown[] }).items;
    expect(items).toHaveLength(0);

    // Restore.
    if (prevEnabled) {
      await request.patch(`${baseURL}/api/workspaces/${ws.id}`, {
        data: {
          defaults: {
            ...(ws.defaults ?? {}),
            notifications: {
              ...(ws.defaults?.notifications ?? {}),
              enabled: true,
            },
          },
        },
      });
    }
  });

  /**
   * The four-surfaces test: when a backgrounded session emits something the
   * user would have noticed had they been looking at the tab, the per-tab
   * unread badge, the workspace tile, the drawer badge, AND the inactive
   * tab's status dot (running → idle) AND the browser tab title overlay
   * (favicon `(N) Claudius`) must all update without a manual refresh.
   *
   * The earlier suite only checks the unread surfaces. The user's screenshot
   * report was about the *status dot* getting stuck on "running" in one
   * browser while another browser viewing the same session sees "idle" —
   * i.e. the bus → SSE → `refreshSessions` → `/api/sessions` → tab-status
   * chain is broken end-to-end for backgrounded tabs. This test mocks
   * `/api/sessions` so we can pin the synthetic backgrounded session's
   * `getStatus()` to "running" before the emit and "idle" after, then
   * asserts the dot follows.
   */
  test("backgrounded session status dot + favicon + drawer items all update via the SSE-driven refresh", async ({
    page,
    request,
    baseURL,
  }) => {
    await page.goto("/");
    const realSessionId = await waitForBoundSession(page);
    const { workspaces, activeId } = await listWorkspaces(request, baseURL);
    const active = workspaces.find((w) => w.id === activeId) ?? workspaces[0]!;
    const prevKinds = await ensureKindsEnabled(request, baseURL, active, [
      "session_error",
    ]);
    await clearAllWorkspacesUnread(request, baseURL, workspaces);
    const tabsBefore = (await (await request.get(`${baseURL}/api/sessions/open-tabs`)).json()) as {
      tabs?: string[];
      activeId?: string | null;
    };

    // Status the mocked /api/sessions endpoint advertises for the synthetic
    // backgrounded session. We flip it part-way through the test; the
    // closure-bound handler picks up the new value on every fetch so the
    // client's stateVersion-driven refresh observes the transition.
    let bgStatus: "running" | "idle" = "running";
    await page.route("**/api/sessions", async (route) => {
      if (route.request().method() !== "GET") return route.fallback();
      return route.fulfill({
        status: 200,
        contentType: "application/json",
        body: JSON.stringify([
          {
            id: SYNTHETIC_TAB_C,
            cwd: active.rootPath,
            model: "claude-opus-4-7",
            title: null,
            status: bgStatus,
          },
        ]),
      });
    });

    // Stub GET /api/sessions/open-tabs so the server's sanitization filter
    // (which removes session IDs not present in listIndexedSessions) doesn't
    // silently drop SYNTHETIC_TAB_C. We include the real session so the boot's
    // activeId → resume path still finds a real session to bind to.
    await page.route("**/api/sessions/open-tabs", async (route) => {
      if (route.request().method() !== "GET") return route.fallback();
      await route.fulfill({
        status: 200,
        contentType: "application/json",
        body: JSON.stringify({
          tabs: [realSessionId, SYNTHETIC_TAB_C],
          activeId: realSessionId,
          labelMaxWidth: 180,
        }),
      });
    });

    await request.put(`${baseURL}/api/sessions/open-tabs`, {
      data: { tabs: [SYNTHETIC_TAB_C] },
    });
    await page.reload();
    await waitForBoundSession(page);

    const bgTab = page.locator(`[data-tab-id="${SYNTHETIC_TAB_C}"]`).first();
    await expect(bgTab).toBeAttached({ timeout: 15_000 });
    const bgDot = bgTab.locator('[data-testid="session-tab-status-dot"]');
    await expect(bgDot).toHaveAttribute("data-status", "running", { timeout: 15_000 });

    // Initial title is just "Claudius" (no unread).
    await expect(page).toHaveTitle(/Claudius$/, { timeout: 5_000 });

    // ── Fire the backgrounded-session event. session_error is opt-in but
    // enabled above; the bus persists the row and emits a `state` event
    // even though `hasSubscribers: false` suppresses the OS toast feed.
    bgStatus = "idle";
    await devEmit(request, baseURL, {
      cwd: active.rootPath,
      sessionId: SYNTHETIC_TAB_C,
      kind: "session_error",
      message: "bg→idle transition",
      hasSubscribers: false,
    });

    // The state event should drive: status dot → idle (via refreshSessions),
    // tab unread → 1, workspace tile → 1, drawer header → 1, browser title
    // → (1) Claudius.
    await expect(bgDot).toHaveAttribute("data-status", "idle", { timeout: 15_000 });

    const tabBadge = bgTab.locator('[data-testid="session-tab-unread"]');
    await expect(tabBadge).toHaveText("1", { timeout: 10_000 });
    await expect(page.getByTestId(`workspace-notification-badge-${active.id}`)).toHaveText(
      "1",
    );
    await expect(page.getByTestId("notifications-drawer-badge")).toHaveText("1");
    await expect(page).toHaveTitle(/^\(1\)\s/, { timeout: 10_000 });

    // Drawer renders the row, not "You're all caught up".
    await page.getByTestId("notifications-drawer-trigger").click();
    const panel = page.getByTestId("notifications-drawer-panel");
    await expect(panel).toBeVisible();
    await expect(panel.locator("[data-testid^='notification-row-']")).toHaveCount(1);
    await page.keyboard.press("Escape");

    // Cleanup.
    await page.unroute("**/api/sessions");
    await page.unroute("**/api/sessions/open-tabs");
    await request.post(`${baseURL}/api/notifications/read-all`, {
      data: { workspaceId: active.id },
    });
    await restoreKinds(request, baseURL, active, prevKinds);
    await request.put(`${baseURL}/api/sessions/open-tabs`, {
      data: {
        tabs: (tabsBefore.tabs ?? []).filter((t) => t !== SYNTHETIC_TAB_C),
        activeId:
          tabsBefore.activeId && tabsBefore.activeId !== SYNTHETIC_TAB_C
            ? tabsBefore.activeId
            : null,
      },
    });
  });

  /**
   * Non-mapping events (turn_status, tool_use, assistant chunks, …) hit
   * `notificationBus.record` from `Session.broadcast` but exit early in
   * `mapEventToKind` because they don't produce a notification. The bug
   * the user is hitting: those exits skip `scheduleStateEmit`, so the
   * SSE state event never fans out and the inactive tab — which depends
   * on `stateVersion` ticks to call `refreshSessions` — has no way to
   * learn that the session's `getStatus()` flipped.
   *
   * Symptom in the user's screenshot: browser B (active on the session)
   * shows "Idle", browser A (the same session as a backgrounded tab)
   * shows "Running" forever. This test asserts the dot transition for a
   * NON-mapping event. Expected to FAIL on current main; the fix makes
   * the bus emit `state` (or an equivalent status-sync signal) on every
   * recorded session event regardless of whether a row was persisted.
   */
  test("backgrounded session status dot updates even for events that don't map to a notification kind", async ({
    page,
    request,
    baseURL,
  }) => {
    await page.goto("/");
    const realSessionId = await waitForBoundSession(page);
    const { workspaces, activeId } = await listWorkspaces(request, baseURL);
    const active = workspaces.find((w) => w.id === activeId) ?? workspaces[0]!;
    const prevKinds = await ensureKindsEnabled(request, baseURL, active, [
      "session_error",
    ]);
    await clearAllWorkspacesUnread(request, baseURL, workspaces);
    const tabsBefore = (await (await request.get(`${baseURL}/api/sessions/open-tabs`)).json()) as {
      tabs?: string[];
      activeId?: string | null;
    };

    let bgStatus: "running" | "idle" = "running";
    await page.route("**/api/sessions", async (route) => {
      if (route.request().method() !== "GET") return route.fallback();
      return route.fulfill({
        status: 200,
        contentType: "application/json",
        body: JSON.stringify([
          {
            id: SYNTHETIC_TAB_C,
            cwd: active.rootPath,
            model: "claude-opus-4-7",
            title: null,
            status: bgStatus,
          },
        ]),
      });
    });

    // Stub GET /api/sessions/open-tabs so the server's sanitization filter
    // (which removes session IDs not present in listIndexedSessions) doesn't
    // silently drop SYNTHETIC_TAB_C. We include the real session so the boot's
    // activeId → resume path still finds a real session to bind to.
    await page.route("**/api/sessions/open-tabs", async (route) => {
      if (route.request().method() !== "GET") return route.fallback();
      await route.fulfill({
        status: 200,
        contentType: "application/json",
        body: JSON.stringify({
          tabs: [realSessionId, SYNTHETIC_TAB_C],
          activeId: realSessionId,
          labelMaxWidth: 180,
        }),
      });
    });

    await request.put(`${baseURL}/api/sessions/open-tabs`, {
      data: { tabs: [SYNTHETIC_TAB_C] },
    });
    await page.reload();
    await waitForBoundSession(page);

    const bgTab = page.locator(`[data-tab-id="${SYNTHETIC_TAB_C}"]`).first();
    await expect(bgTab).toBeAttached({ timeout: 15_000 });
    const bgDot = bgTab.locator('[data-testid="session-tab-status-dot"]');
    await expect(bgDot).toHaveAttribute("data-status", "running", { timeout: 15_000 });

    // Flip the mocked status and fire a non-mapping event. `turn_status` is
    // the canonical broadcast a real Session emits on `result` (right after
    // `turnInFlight = false`) — the SDK result itself maps to session_idle
    // only when the idle window is crossed AND markUserInput was called,
    // both of which fail in plenty of real scenarios (HMR cleared the
    // lastUserInputAt map, a quick turn under 5s, a resumed session that
    // never saw a markUserInput). When session_idle is suppressed for any
    // of those reasons, `turn_status` is the only signal the bus sees that
    // the agent is actually idle — and on current main it gets dropped.
    bgStatus = "idle";
    const res = await request.post(`${baseURL}/api/notifications/dev-emit`, {
      data: {
        cwd: active.rootPath,
        sessionId: SYNTHETIC_TAB_C,
        event: { type: "turn_status", status: "idle" },
        hasSubscribers: false,
      },
    });
    expect(res.ok()).toBeTruthy();

    // The inactive tab's dot should follow the server's authoritative
    // status. On current main this hangs at "running" because the bus
    // never emits a state event for the turn_status broadcast.
    await expect(bgDot).toHaveAttribute("data-status", "idle", { timeout: 15_000 });

    // Cleanup.
    await page.unroute("**/api/sessions");
    await page.unroute("**/api/sessions/open-tabs");
    await restoreKinds(request, baseURL, active, prevKinds);
    await request.put(`${baseURL}/api/sessions/open-tabs`, {
      data: {
        tabs: (tabsBefore.tabs ?? []).filter((t) => t !== SYNTHETIC_TAB_C),
        activeId:
          tabsBefore.activeId && tabsBefore.activeId !== SYNTHETIC_TAB_C
            ? tabsBefore.activeId
            : null,
      },
    });
  });
});
