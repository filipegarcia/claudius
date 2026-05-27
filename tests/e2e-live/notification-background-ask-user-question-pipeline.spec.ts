import { test, expect, type Page, type APIRequestContext } from "@playwright/test";

/**
 * Pipeline regression: when an `ask_user_question` ServerEvent is recorded
 * against a backgrounded session (the user has switched to a different
 * session tab), all the cross-session notification surfaces must tick:
 *
 *   1. Workspace tile badge ≥ 1
 *   2. Notifications drawer header badge ≥ 1
 *   3. Per-session tab badge on the backgrounded session ≥ 1
 *   4. Document title shows `(N) Claudius`
 *
 * Synthesises the event via the dev-only `/api/notifications/dev-emit`
 * endpoint instead of driving a real Anthropic turn, so the test runs in
 * the playwright-managed E2E_HOME tempdir without needing keychain
 * credentials. The dev-emit path goes through the SAME
 * `notificationBus.recordSessionEvent` call that `Session.broadcast` uses
 * in production — only the upstream trigger differs.
 *
 * Why this spec exists: live e2e investigation of a user-reported
 * "AskUserQuestion fires no notification" bug. We rigged this test as the
 * downstream half of the diagnostic — if it passes, the bus + client
 * pipeline are healthy and the bug is upstream (session.ts's canUseTool
 * handler, SDK tool routing, or workspace prefs). Keeping it as a
 * regression guard so a future bus / SSE / client refactor can't
 * silently break the chain again.
 *
 * **This does NOT cover the SDK → session.broadcast → bus chain.** That
 * coverage lives in `notification-background-session-idle.spec.ts`
 * (which uses real SDK turns) and would need an authenticated
 * environment to add a true AskUserQuestion-driven equivalent.
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

/**
 * Tap the notifications SSE stream from inside the page so we capture the
 * exact events the client sees. Used as a failure-diagnostic attachment.
 */
async function tapNotificationStream(
  page: Page,
): Promise<{ events: () => Promise<unknown[]> }> {
  await page.evaluate(() => {
    const w = window as unknown as {
      __notifEvents?: unknown[];
      __notifEs?: EventSource;
    };
    if (w.__notifEs) return;
    w.__notifEvents = [];
    const es = new EventSource("/api/notifications/stream");
    es.onmessage = (ev) => {
      try {
        const data = JSON.parse(ev.data);
        w.__notifEvents!.push({ at: Date.now(), data });
      } catch {
        w.__notifEvents!.push({ at: Date.now(), raw: ev.data });
      }
    };
    w.__notifEs = es;
  });
  return {
    events: async () =>
      page.evaluate(() => {
        const w = window as unknown as { __notifEvents?: unknown[] };
        return w.__notifEvents ?? [];
      }),
  };
}

test.describe("Notification pipeline: backgrounded session ask_user_question", () => {
  test("dev-emit'd ask_user_question event on backgrounded session ticks tile + drawer + tab badge + title", async ({
    page,
    request,
    baseURL,
  }, testInfo) => {
    test.setTimeout(120_000);

    const { workspaces, activeId } = await listWorkspaces(request, baseURL);
    const ws = workspaces.find((w) => w.id === activeId) ?? workspaces[0]!;
    const prevKinds = await ensureKindsEnabled(request, baseURL, ws, [
      "ask_user_question",
    ]);
    await Promise.all(
      workspaces.map((w) =>
        request
          .post(`${baseURL}/api/notifications/read-all`, {
            data: { workspaceId: w.id },
          })
          .catch(() => undefined),
      ),
    );

    const consoleLines: string[] = [];
    page.on("console", (msg) => consoleLines.push(`[${msg.type()}] ${msg.text()}`));
    page.on("pageerror", (err) => consoleLines.push(`[pageerror] ${err.message}`));

    await page.goto("/");
    const bootId = await waitForBoundSession(page);
    const tap = await tapNotificationStream(page);

    // Two fresh sessions: A (will receive the synthesized
    // ask_user_question) and B (the currently active tab). A is
    // "backgrounded" the moment the page binding switches off it.
    await page.locator('button[title="New session tab"]').click();
    const idA = await waitForBoundSession(page, { not: bootId });
    await page.locator('button[title="New session tab"]').click();
    const idB = await waitForBoundSession(page, { not: idA });
    expect(idB).not.toBe(idA);

    await expect(
      page.locator('[data-testid="session-tab"][data-tab-active="true"]'),
    ).toHaveAttribute("data-tab-id", idB, { timeout: 10_000 });

    // Synthesize the event. `hasSubscribers: false` mirrors a real
    // backgrounded session (no per-session SSE subscriber). `requestId`
    // is required for the bus's dedup index.
    const t0 = Date.now();
    const emitRes = await request.post(`${baseURL}/api/notifications/dev-emit`, {
      data: {
        cwd: ws.rootPath,
        sessionId: idA,
        hasSubscribers: false,
        event: {
          type: "ask_user_question",
          requestId: `req-test-${Date.now()}`,
          toolUseId: "tu-test-1",
          questions: [
            {
              header: "Color",
              question: "Pick a color",
              options: [{ label: "Red" }, { label: "Blue" }],
            },
          ],
        },
      },
    });
    expect(emitRes.ok()).toBeTruthy();
    const emitJson = await emitRes.json();

    let assertionError: unknown = null;
    try {
      const tileBadge = page.getByTestId(`workspace-notification-badge-${ws.id}`);
      await expect(tileBadge).toBeVisible({ timeout: 15_000 });
      const tileText = await tileBadge.textContent();
      expect(Number(tileText?.trim() ?? "0")).toBeGreaterThanOrEqual(1);

      const drawerBadge = page.getByTestId("notifications-drawer-badge");
      await expect(drawerBadge).toBeVisible({ timeout: 10_000 });
      const drawerText = await drawerBadge.textContent();
      expect(Number(drawerText?.trim() ?? "0")).toBeGreaterThanOrEqual(1);

      const tabUnread = page.locator(
        `[data-testid="session-tab"][data-tab-id="${idA}"] [data-testid="session-tab-unread"]`,
      );
      await expect(tabUnread).toHaveText(/^[1-9]/, { timeout: 10_000 });

      await expect(page).toHaveTitle(/^\(\d+\)\s/, { timeout: 10_000 });

      // eslint-disable-next-line no-console
      console.log(
        `[ask-pipeline] all surfaces ticked within ${Date.now() - t0}ms`,
      );
    } catch (err) {
      assertionError = err;
    }

    // Attach failure diagnostics so a regression is debuggable from the
    // CI artifact alone — captures the SSE traffic, browser console, and
    // the persisted notification rows for the workspace.
    const events = await tap.events();
    await testInfo.attach("notifications-stream-events.json", {
      body: JSON.stringify(events, null, 2),
      contentType: "application/json",
    });
    await testInfo.attach("page-console.txt", {
      body: consoleLines.join("\n"),
      contentType: "text/plain",
    });
    await testInfo.attach("emit-response.json", {
      body: JSON.stringify(emitJson, null, 2),
      contentType: "application/json",
    });
    try {
      const rowsRes = await request.get(
        `${baseURL}/api/notifications?workspaceId=${ws.id}`,
      );
      const rowsJson = rowsRes.ok()
        ? await rowsRes.json()
        : { error: rowsRes.status() };
      await testInfo.attach("persisted-all.json", {
        body: JSON.stringify(rowsJson, null, 2),
        contentType: "application/json",
      });
    } catch (err) {
      await testInfo.attach("persisted-error.txt", {
        body: String(err),
        contentType: "text/plain",
      });
    }

    try {
      await request.post(`${baseURL}/api/notifications/read-all`, {
        data: { workspaceId: ws.id },
      });
      await restoreKinds(request, baseURL, ws, prevKinds);
    } catch {
      // best-effort
    }

    if (assertionError) throw assertionError;
  });
});
