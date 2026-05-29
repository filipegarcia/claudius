import { test, expect, type Page, type APIRequestContext } from "../helpers/test";

const SESSION_RE = /[?&]session=([0-9a-f-]{36})/i;

/**
 * End-to-end coverage for the notifications pipeline. We deliberately do NOT
 * hit the live Anthropic API — the test drives the in-process bus through
 * two dev-only endpoints so it stays deterministic and fast:
 *
 *   • POST /api/notifications/dev-emit       — calls notificationBus.recordSessionEvent directly
 *   • POST /api/sessions/:id/dev-broadcast   — invokes Session.broadcast() directly
 *
 * The first endpoint proves the bus → DB → SSE → provider → drawer/badge
 * chain works. The second endpoint proves Session.broadcast still wires into
 * the bus (the regression the user hit on a stale-HMR session).
 *
 * Both endpoints 404 in production builds.
 */

type Workspace = {
  id: string;
  rootPath: string;
  defaults?: {
    notifications?: { enabled?: boolean; enabledKinds?: string[] };
  };
};

async function getActiveWorkspace(req: APIRequestContext, baseURL?: string): Promise<Workspace> {
  // /api/workspaces returns `activeId` via the server-side resolver, which
  // honours the workspace cookie and falls back to workspaces.json's
  // activeId hint. We use that instead of "first in list", because the
  // first workspace in the JSON is rarely the active one.
  const res = await req.get(`${baseURL}/api/workspaces`);
  expect(res.ok()).toBeTruthy();
  const data = (await res.json()) as { workspaces: Workspace[]; activeId: string | null };
  const ws = data.activeId
    ? data.workspaces.find((w) => w.id === data.activeId) ?? null
    : data.workspaces[0];
  expect(ws, "no workspace bound — fixture is in a bad state").toBeTruthy();
  return ws!;
}

/**
 * Wipe unread across every workspace. The drawer header badge is cross-
 * workspace, so leftover unread in workspaces OTHER than `ws` will make the
 * `toHaveText("1")` assertion fail with received="2". This test is OK to
 * clear globally — the dev fixture is shared, and any leftover unread is
 * developer detritus, not user data.
 */
async function clearAllWorkspacesUnread(
  req: APIRequestContext,
  baseURL: string | undefined,
): Promise<void> {
  const res = await req.get(`${baseURL}/api/workspaces`);
  if (!res.ok()) return;
  const data = (await res.json()) as { workspaces: Array<{ id: string }> };
  await Promise.all(
    data.workspaces.map((w) =>
      req
        .post(`${baseURL}/api/notifications/read-all`, {
          data: { workspaceId: w.id },
        })
        .catch(() => {
          // best-effort — workspaces with no DB yet 404 the read-all call
        }),
    ),
  );
}

async function waitForBoundSession(page: Page): Promise<string> {
  await page.waitForURL((url) => SESSION_RE.test(String(url)), { timeout: 30_000 });
  const m = page.url().match(SESSION_RE);
  expect(m).toBeTruthy();
  return m![1];
}

/**
 * Ensure the workspace allows notifications AND has `session_error` in its
 * enabledKinds — every test below emits a synthetic `session_error` row,
 * but `session_error` is opt-in (off by default) per the user's request
 * that errors not ring uninvited. Without this the workspace silently drops
 * the row and the assertions fail with "count 0, expected ≥ 1". Idempotent.
 */
async function ensureNotificationsEnabled(
  req: APIRequestContext,
  baseURL: string | undefined,
  ws: Workspace,
): Promise<void> {
  const prevKinds = ws.defaults?.notifications?.enabledKinds;
  const needsKinds = !prevKinds || !prevKinds.includes("session_error");
  const needsEnable = ws.defaults?.notifications?.enabled === false;
  if (!needsKinds && !needsEnable) return;
  const nextKinds = Array.from(new Set([...(prevKinds ?? []), "session_error"]));
  const res = await req.patch(`${baseURL}/api/workspaces/${ws.id}`, {
    data: {
      defaults: {
        ...(ws.defaults ?? {}),
        notifications: {
          ...(ws.defaults?.notifications ?? {}),
          enabled: true,
          enabledKinds: nextKinds,
        },
      },
    },
  });
  expect(res.ok()).toBeTruthy();
}

test.describe("Notifications pipeline", () => {
  test("bus → DB → SSE → UI: a synthetic error event surfaces in the drawer with a badge", async ({
    page,
    request,
    baseURL,
  }) => {
    // ── 1. Boot the app, wait for the URL to bind a session ──────────────
    // We don't reference the bound id in the emit below (see step 3 — the
    // provider auto-reads notifications targeting the active session), but
    // we still need to wait until the page is past the boot race before the
    // NotificationsProvider subscribes to the SSE stream.
    await page.goto("/");
    await waitForBoundSession(page);
    const ws = await getActiveWorkspace(request, baseURL);
    await ensureNotificationsEnabled(request, baseURL, ws);

    // Wait for the workspace switcher to mount — every subsequent assertion
    // hinges on the NotificationsProvider being subscribed to the stream.
    await expect(page.getByTestId("notifications-drawer-trigger")).toBeVisible({
      timeout: 15_000,
    });

    // ── 2. Clear pre-existing unread on EVERY workspace so the cross-
    // workspace drawer header starts at zero. A leftover unread in any
    // other workspace would push the drawer badge above 1 and the assertion
    // would fail with "expected 1, received 2/3/…".
    await clearAllWorkspacesUnread(request, baseURL);

    // ── 3. Trigger the bus directly via the dev endpoint ─────────────────
    // `session_error` is the cleanest kind to synthesize: maps from a plain
    // `error` ServerEvent, no SDK quirks, and is enabled by default.
    //
    // NB: we deliberately target a DIFFERENT sessionId than the one currently
    // bound in the page. The provider auto-reads on arrival when the row's
    // session matches the URL's active session AND the tab is visible — that
    // mirrors `useNotifications.notify`'s OS-popup gate and would immediately
    // clear the badge before this test could read it. A neighbour session id
    // breaks that gate while still exercising the full bus → DB → SSE → UI
    // chain.
    const otherSessionId = "11111111-1111-4111-8111-111111111111";
    const emit = await request.post(`${baseURL}/api/notifications/dev-emit`, {
      data: {
        cwd: ws.rootPath,
        sessionId: otherSessionId,
        event: { type: "error", message: "e2e-bus-direct" },
      },
    });
    expect(emit.ok()).toBeTruthy();
    const emitBody = (await emit.json()) as { counts: Record<string, number> };
    // The bus's authoritative count for this workspace must reflect the
    // insert. If this is 0 the server has the row but `unreadCount` can't
    // see it — points at a stale readonly DB handle.
    expect(
      emitBody.counts[ws.id],
      `bus countsAllWorkspaces() returned ${emitBody.counts[ws.id]} for ${ws.id}; expected ≥ 1`,
    ).toBeGreaterThanOrEqual(1);

    // ── 4. Server-side sanity check via the public list endpoint ─────────
    const list1 = await request.get(
      `${baseURL}/api/notifications?workspace=${ws.id}&limit=5`,
    );
    expect(list1.ok()).toBeTruthy();
    const items1 = ((await list1.json()) as { items: Array<{ kind: string; body: string }> }).items;
    expect(items1.length).toBeGreaterThanOrEqual(1);
    expect(items1[0].kind).toBe("session_error");
    expect(items1[0].body).toContain("e2e-bus-direct");

    // ── 5. Workspace tile badge + drawer badge reflect the new unread row.
    // The provider listens to SSE and updates counts; allow a generous
    // window for the EventSource to flush the first event.
    const workspaceBadge = page.getByTestId(`workspace-notification-badge-${ws.id}`);
    await expect(workspaceBadge).toBeVisible({ timeout: 15_000 });
    await expect(workspaceBadge).toHaveText("1");
    await expect(page.getByTestId("notifications-drawer-badge")).toHaveText("1");

    // ── 6. Open the drawer and verify the row renders ────────────────────
    await page.getByTestId("notifications-drawer-trigger").click();
    const panel = page.getByTestId("notifications-drawer-panel");
    await expect(panel).toBeVisible();
    await expect(panel.getByText("Session error")).toBeVisible();
    await expect(panel.getByText("e2e-bus-direct")).toBeVisible();

    // Close the drawer for the next phase.
    await page.keyboard.press("Escape");
    await expect(panel).not.toBeVisible();
  });

  test("Session.broadcast still calls the bus (no HMR regression)", async ({
    page,
    request,
    baseURL,
  }) => {
    // Regression guard for the wire from `Session.broadcast` →
    // `notificationBus.recordSessionEvent`. The bus's *behaviour* once
    // called is covered by `tests/unit/notification-bus.integration.test.ts`
    // (see `recordSessionEvent` → row + envelopes). All this test needs to
    // prove is that the call happens at all — anything richer just slows
    // the suite without adding signal.
    await page.goto("/");
    const sessionId = await waitForBoundSession(page);
    // Derive the workspace from the actual bound session rather than the
    // active-workspace cookie. A session resumed from openTabs may live in
    // a different workspace than the cookie's active id (e.g. when a prior
    // test selected a different workspace, or when the user has a tab open
    // across workspaces). Using the wrong workspace would route the bus
    // lookup to a different DB and the row would never appear.
    const broadcastRes = await request.post(
      `${baseURL}/api/sessions/${sessionId}/dev-broadcast`,
      { data: { event: { type: "error", message: "broadcast-probe-cwd-discovery" } } },
    );
    expect(broadcastRes.ok()).toBeTruthy();
    const probe = (await broadcastRes.json()) as { sessionCwd?: string };
    expect(probe.sessionCwd, "dev-broadcast didn't echo the session's cwd").toBeTruthy();
    const allRes = await request.get(`${baseURL}/api/workspaces`);
    const allData = (await allRes.json()) as { workspaces: Workspace[] };
    const ws = allData.workspaces.find((w) => w.rootPath === probe.sessionCwd);
    expect(
      ws,
      `no workspace has rootPath=${probe.sessionCwd}; can't find the bus's destination`,
    ).toBeTruthy();
    await ensureNotificationsEnabled(request, baseURL, ws!);
    await clearAllWorkspacesUnread(request, baseURL);

    const tag = `broadcast-probe-${Date.now()}`;
    const res = await request.post(
      `${baseURL}/api/sessions/${sessionId}/dev-broadcast`,
      { data: { event: { type: "error", message: tag } } },
    );
    expect(res.ok()).toBeTruthy();

    await expect
      .poll(
        async () => {
          const r = await request.get(
            `${baseURL}/api/notifications?workspace=${ws!.id}&limit=10`,
          );
          if (!r.ok()) return false;
          const items = ((await r.json()) as { items: Array<{ body: string }> }).items;
          return items.some((row) => row.body === tag);
        },
        {
          timeout: 15_000,
          message: "broadcast-driven row never landed in the inbox",
        },
      )
      .toBeTruthy();
  });

  // NOTE: "per-session block suppresses" used to live here but moved to
  // `tests/unit/notification-bus.integration.test.ts` — the browser was
  // adding no signal over the in-process bus assertion.

  test("R1: workspace tile, drawer header, and drawer items always agree", async ({
    page,
    request,
    baseURL,
  }) => {
    // Pin the consistency contract end-to-end. Three UI surfaces read from
    // three different selectors but must always equal the workspace's
    // ground-truth unread count. The rewrite drives all three from one
    // server-emitted `state` event with a monotonic version, so divergence
    // is structurally impossible — this test would catch any future
    // regression that re-introduces multiple sources of truth.
    await page.goto("/");
    await waitForBoundSession(page);
    const ws = await getActiveWorkspace(request, baseURL);
    await ensureNotificationsEnabled(request, baseURL, ws);

    // Clear EVERY workspace's unread, not just the active one. The drawer is
    // cross-workspace, so a leftover row in any other workspace would
    // surface in `rows.toHaveCount(3)` and inflate the count beyond what
    // this test emitted.
    await clearAllWorkspacesUnread(request, baseURL);

    // Emit 3 notifications, each on a different fake session id so the
    // active-session auto-read gate doesn't suppress them.
    const fakeIds = [
      "11111111-1111-4111-8111-111111111111",
      "22222222-2222-4222-8222-222222222222",
      "33333333-3333-4333-8333-333333333333",
    ];
    for (const sid of fakeIds) {
      const res = await request.post(`${baseURL}/api/notifications/dev-emit`, {
        data: {
          cwd: ws.rootPath,
          sessionId: sid,
          event: { type: "error", message: `r1-${sid.slice(0, 8)}` },
        },
      });
      expect(res.ok()).toBeTruthy();
    }

    // All three surfaces should converge on the same number.
    const tileBadge = page.getByTestId(`workspace-notification-badge-${ws.id}`);
    const drawerBadge = page.getByTestId("notifications-drawer-badge");
    await expect(tileBadge).toHaveText("3", { timeout: 15_000 });
    await expect(drawerBadge).toHaveText("3");

    await page.getByTestId("notifications-drawer-trigger").click();
    const panel = page.getByTestId("notifications-drawer-panel");
    await expect(panel).toBeVisible();
    // Drawer's visible rows must equal the badge. The redesign uses
    // `unreadOnly=1` at the SQL level, so older unread can't fall off the
    // 50-row pagination window when read rows pile up on top of them.
    const rows = panel.locator("[data-testid^='notification-row-']");
    await expect(rows).toHaveCount(3);

    // Mark one read via the API and verify all three surfaces re-converge.
    // Pull the id from the visible drawer (any row works).
    const firstRowId = await rows
      .first()
      .getAttribute("data-testid")
      .then((s) => s?.replace(/^notification-row-/, "") ?? null);
    expect(firstRowId).toBeTruthy();
    await request.post(`${baseURL}/api/notifications/${firstRowId}/read`, {
      data: { workspaceId: ws.id },
    });
    await expect(tileBadge).toHaveText("2", { timeout: 10_000 });
    await expect(drawerBadge).toHaveText("2");
    await expect(rows).toHaveCount(2);

    // markAllRead: every surface should drop to zero / disappear.
    await request.post(`${baseURL}/api/notifications/read-all`, {
      data: { workspaceId: ws.id },
    });
    await expect(tileBadge).not.toBeVisible({ timeout: 10_000 });
    await expect(drawerBadge).not.toBeVisible();
    await expect(rows).toHaveCount(0);
  });
});
