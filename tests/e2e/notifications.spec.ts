import { test, expect, type Page, type APIRequestContext } from "@playwright/test";

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

async function waitForBoundSession(page: Page): Promise<string> {
  await page.waitForURL((url) => SESSION_RE.test(String(url)), { timeout: 30_000 });
  const m = page.url().match(SESSION_RE);
  expect(m).toBeTruthy();
  return m![1];
}

/**
 * Ensure the workspace allows notifications. The fixture sometimes starts
 * with no `notifications` field on `defaults` (defaults apply, all kinds on);
 * if a previous test left it disabled, flip it on. Idempotent.
 */
async function ensureNotificationsEnabled(
  req: APIRequestContext,
  baseURL: string | undefined,
  ws: Workspace,
): Promise<void> {
  if (ws.defaults?.notifications?.enabled === false) {
    const res = await req.patch(`${baseURL}/api/workspaces/${ws.id}`, {
      data: {
        defaults: {
          ...ws.defaults,
          notifications: { ...ws.defaults.notifications, enabled: true },
        },
      },
    });
    expect(res.ok()).toBeTruthy();
  }
}

test.describe("Notifications pipeline", () => {
  test("bus → DB → SSE → UI: a synthetic error event surfaces in the drawer with a badge", async ({
    page,
    request,
    baseURL,
  }) => {
    // ── 1. Boot the app, capture the auto-bound session ──────────────────
    await page.goto("/");
    const sessionId = await waitForBoundSession(page);
    const ws = await getActiveWorkspace(request, baseURL);
    await ensureNotificationsEnabled(request, baseURL, ws);

    // Wait for the workspace switcher to mount — every subsequent assertion
    // hinges on the NotificationsProvider being subscribed to the stream.
    await expect(page.getByTestId("notifications-drawer-trigger")).toBeVisible({
      timeout: 15_000,
    });

    // ── 2. Clear any pre-existing unread so counts start from zero ───────
    await request.post(`${baseURL}/api/notifications/read-all`, {
      data: { workspaceId: ws.id },
    });

    // ── 3. Trigger the bus directly via the dev endpoint ─────────────────
    // `session_error` is the cleanest kind to synthesize: maps from a plain
    // `error` ServerEvent, no SDK quirks, and is enabled by default.
    const emit = await request.post(`${baseURL}/api/notifications/dev-emit`, {
      data: {
        cwd: ws.rootPath,
        sessionId,
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
    // This test pokes a session's PRIVATE broadcast method through the
    // dev endpoint and verifies the bus still records. If a future
    // refactor accidentally drops the `notificationBus.recordSessionEvent`
    // call from `Session.broadcast`, this will fail.
    await page.goto("/");
    const sessionId = await waitForBoundSession(page);
    const ws = await getActiveWorkspace(request, baseURL);
    await ensureNotificationsEnabled(request, baseURL, ws);

    await request.post(`${baseURL}/api/notifications/read-all`, {
      data: { workspaceId: ws.id },
    });

    // Snapshot the unread count BEFORE broadcasting.
    const countsBefore = await request.get(`${baseURL}/api/notifications/counts`);
    expect(countsBefore.ok()).toBeTruthy();
    const before = ((await countsBefore.json()) as { counts: Record<string, number> }).counts;
    const baseCount = before[ws.id] ?? 0;

    // Use a unique message so the assertion can't false-positive on a row
    // from a sibling test re-using the inbox.
    const tag = `broadcast-probe-${Date.now()}`;
    const res = await request.post(
      `${baseURL}/api/sessions/${sessionId}/dev-broadcast`,
      {
        data: { event: { type: "error", message: tag } },
      },
    );
    expect(res.ok()).toBeTruthy();
    const broadcastInfo = (await res.json()) as {
      sessionCwd?: string;
      sessionId?: string;
    };
    // The bus's cwd→workspace lookup is the most common silent failure.
    // Surface the session's actual cwd and compare with the workspace
    // rootPath so a mismatch (the suspect for "the row never lands")
    // becomes the test failure message rather than a generic timeout.
    expect(
      broadcastInfo.sessionCwd,
      `Session.cwd (${broadcastInfo.sessionCwd}) must equal the workspace rootPath (${ws.rootPath}) for the bus to find the workspace`,
    ).toBe(ws.rootPath);

    // The list endpoint is the cleanest read — counts are eventually
    // consistent (the bus emits SSE first, then re-queries the count), so
    // poll the list for our tag.
    await expect.poll(async () => {
        const r = await request.get(
          `${baseURL}/api/notifications?workspace=${ws.id}&limit=10`,
        );
        if (!r.ok()) return false;
        const items = ((await r.json()) as { items: Array<{ body: string }> }).items;
        return items.some((row) => row.body === tag);
      }, { timeout: 15_000, message: "broadcast-driven row never landed in the inbox" })
      .toBeTruthy();

    // And the workspace tile badge reflects the new row.
    const badge = page.getByTestId(`workspace-notification-badge-${ws.id}`);
    await expect(badge).toBeVisible({ timeout: 15_000 });
    const badgeText = await badge.textContent();
    const n = Number(badgeText) || 0;
    expect(n).toBeGreaterThan(baseCount);
  });

  test("per-session block suppresses notifications for that session only", async ({
    page,
    request,
    baseURL,
  }) => {
    await page.goto("/");
    const sessionId = await waitForBoundSession(page);
    const ws = await getActiveWorkspace(request, baseURL);
    await ensureNotificationsEnabled(request, baseURL, ws);

    await request.post(`${baseURL}/api/notifications/read-all`, {
      data: { workspaceId: ws.id },
    });

    // Block this session.
    const block = await request.post(
      `${baseURL}/api/sessions/${sessionId}/notification-prefs`,
      { data: { blocked: true } },
    );
    expect(block.ok()).toBeTruthy();

    const beforeList = await request.get(
      `${baseURL}/api/notifications?workspace=${ws.id}&limit=10`,
    );
    const beforeItems = ((await beforeList.json()) as { items: unknown[] }).items.length;

    // Fire an event — it should be dropped at the bus's per-session filter.
    const fire = await request.post(`${baseURL}/api/notifications/dev-emit`, {
      data: {
        cwd: ws.rootPath,
        sessionId,
        event: { type: "error", message: "should-be-dropped" },
      },
    });
    expect(fire.ok()).toBeTruthy();

    // Allow the SSE round-trip time it would normally need to settle, then
    // confirm nothing new arrived.
    await page.waitForTimeout(500);
    const afterList = await request.get(
      `${baseURL}/api/notifications?workspace=${ws.id}&limit=10`,
    );
    const afterItems = ((await afterList.json()) as { items: Array<{ body: string }> }).items;
    expect(afterItems.length).toBe(beforeItems);
    expect(afterItems.some((r) => r.body === "should-be-dropped")).toBe(false);

    // Cleanup — restore default behaviour for the rest of the suite.
    await request.post(`${baseURL}/api/sessions/${sessionId}/notification-prefs`, {
      data: { blocked: false },
    });
  });
});
