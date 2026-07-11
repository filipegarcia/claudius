/**
 * CC 2.1.207 — "Improved agent view: blocked session peeks now lead with the
 * question and show a worded staleness clock (`waiting 3m`) instead of the
 * same timestamp twice."
 *
 * Claudius's closest analogue to Claude Code's "agent view" background-
 * session list is the cross-workspace NotificationsDrawer (right-rail
 * Activity panel) — its rows already surface `permission_request` /
 * `ask_user_question` / `plan_approval_request` notifications for sessions
 * blocked elsewhere. Before this release every row led with a generic label
 * ("Claude needs permission") and a plain "3m ago" timestamp regardless of
 * kind. This spec drives a synthetic `permission_request` event through the
 * same dev-only bus endpoint the existing notifications suite uses
 * (`tests/e2e/notifications.spec.ts`) and asserts the still-unread row now
 * leads with the actual tool/question text and reads "waiting Xm" instead.
 *
 * Screenshot target: docs/cc-parity/2.1.207/blocked-session-peek.png
 */

import { mkdirSync } from "node:fs";
import { resolve } from "node:path";
import { test, expect, type APIRequestContext } from "../helpers/test";
import { activateClaudiusWorkspace } from "./helpers/workspace";

const SHOTS_DIR = resolve(process.cwd(), "docs/cc-parity/2.1.207");
mkdirSync(SHOTS_DIR, { recursive: true });

const SESSION_RE = /[?&]session=([0-9a-f-]{36})/i;

type Workspace = {
  id: string;
  rootPath: string;
  defaults?: { notifications?: { enabled?: boolean; enabledKinds?: string[] } };
};

async function getActiveWorkspace(req: APIRequestContext, baseURL?: string): Promise<Workspace> {
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
 * `session_error` ships opt-in (off by default — see
 * `DEFAULT_ENABLED_KINDS` in `lib/shared/notifications.ts`), but it's the
 * cleanest non-actionable kind to synthesize for the "never peeked" negative
 * test below. Mirrors `ensureNotificationsEnabled` in `notifications.spec.ts`.
 */
async function ensureSessionErrorEnabled(
  req: APIRequestContext,
  baseURL: string | undefined,
  ws: Workspace,
): Promise<void> {
  const prevKinds = ws.defaults?.notifications?.enabledKinds;
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

async function clearAllWorkspacesUnread(req: APIRequestContext, baseURL?: string): Promise<void> {
  const res = await req.get(`${baseURL}/api/workspaces`);
  if (!res.ok()) return;
  const data = (await res.json()) as { workspaces: Array<{ id: string }> };
  await Promise.all(
    data.workspaces.map((w) =>
      req
        .post(`${baseURL}/api/notifications/read-all`, { data: { workspaceId: w.id } })
        .catch(() => {}),
    ),
  );
}

test.beforeEach(async ({ page }) => {
  await activateClaudiusWorkspace(page);
});

test.describe("CC 2.1.207 — blocked-session peek leads with the question", () => {
  test("a pending permission_request row shows the tool question first and a worded staleness clock", async ({
    page,
    request,
    baseURL,
  }) => {
    await page.goto("/");
    await page.waitForURL((url) => SESSION_RE.test(String(url)), { timeout: 30_000 });
    const ws = await getActiveWorkspace(request, baseURL);
    await clearAllWorkspacesUnread(request, baseURL);

    await expect(page.getByTestId("notifications-drawer-trigger")).toBeVisible({
      timeout: 15_000,
    });

    // A different session id than the one bound in this tab — the provider
    // auto-reads notifications targeting the active session on arrival,
    // which would clear this row's unread state before we can assert on it.
    const otherSessionId = "22222222-3333-4444-8888-999999999999";
    const question = "Delete node_modules and reinstall from scratch?";
    const emit = await request.post(`${baseURL}/api/notifications/dev-emit`, {
      data: {
        cwd: ws.rootPath,
        sessionId: otherSessionId,
        event: {
          type: "permission_request",
          requestId: "req-e2e-peek-1",
          toolName: "Bash",
          toolUseId: "tool-e2e-peek-1",
          input: { command: "rm -rf node_modules && npm install" },
          title: question,
        },
      },
    });
    expect(emit.ok()).toBeTruthy();

    await expect(page.getByTestId("notifications-drawer-badge")).toHaveText("1", {
      timeout: 15_000,
    });

    await page.getByTestId("notifications-drawer-trigger").click();
    const panel = page.getByTestId("notifications-drawer-panel");
    await expect(panel).toBeVisible();

    // The question leads (primary line), the generic kind label demotes to
    // the secondary line, and the clock reads "waiting …" rather than a
    // plain "just now" / "Xm ago" timestamp — the exact 2.1.207 fix.
    await expect(panel.getByTestId("notification-primary-text").first()).toHaveText(question);
    await expect(panel.getByText("Claude needs permission")).toBeVisible();
    await expect(panel.getByTestId("notification-clock-text").first()).toHaveText(/^waiting /);

    await page.waitForTimeout(200);
    await page.screenshot({
      path: resolve(SHOTS_DIR, "blocked-session-peek.png"),
      fullPage: false,
    });
  });

  test("a non-actionable unread row (session_error) keeps the generic title-first layout", async ({
    page,
    request,
    baseURL,
  }) => {
    // The peek treatment (question-first + "waiting Xm") only applies while
    // the row is unread AND its kind is one the agent is blocked on — this
    // guards that the `isPeek` gate in `NotificationsDrawer.tsx` doesn't fire
    // for a non-actionable kind even when unread.
    await page.goto("/");
    await page.waitForURL((url) => SESSION_RE.test(String(url)), { timeout: 30_000 });
    const ws = await getActiveWorkspace(request, baseURL);
    await ensureSessionErrorEnabled(request, baseURL, ws);
    await clearAllWorkspacesUnread(request, baseURL);
    await expect(page.getByTestId("notifications-drawer-trigger")).toBeVisible({
      timeout: 15_000,
    });

    const otherSessionId = "44444444-5555-6666-7777-888888888888";
    const emit = await request.post(`${baseURL}/api/notifications/dev-emit`, {
      data: {
        cwd: ws.rootPath,
        sessionId: otherSessionId,
        event: { type: "error", message: "e2e-peek-non-actionable" },
      },
    });
    expect(emit.ok()).toBeTruthy();

    await expect(page.getByTestId("notifications-drawer-badge")).toHaveText("1", {
      timeout: 15_000,
    });
    await page.getByTestId("notifications-drawer-trigger").click();
    const panel = page.getByTestId("notifications-drawer-panel");
    await expect(panel).toBeVisible();

    // "Session error" is the generic title; a session_error row is never
    // "peeked" even though it's unread, because it isn't one of the
    // ACTIONABLE_KINDS the agent is blocked on.
    await expect(panel.getByTestId("notification-primary-text").first()).toHaveText(
      "Session error",
    );
    await expect(panel.getByTestId("notification-clock-text").first()).not.toHaveText(/^waiting /);
  });
});
