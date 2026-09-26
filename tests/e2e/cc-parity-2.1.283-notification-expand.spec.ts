/**
 * CC 2.1.283 — "Added click-to-expand for truncated messages from your
 * other sessions in fullscreen mode."
 *
 * Claudius's closest analogue to Claude Code's multi-session "fullscreen"
 * overview is the cross-workspace NotificationsDrawer's blocked-session peek
 * (CC 2.1.207 parity, `components/nav/NotificationsDrawer.tsx`) — it already
 * leads an unread, actionable row with the OTHER session's own question
 * (single-line `truncate`'d) instead of the generic kind label. Before this
 * release a long question just got cut off with an ellipsis and no way to
 * read the rest short of clicking through to that session. This release adds
 * a ▸/▾ expand toggle next to the primary line, matching the same
 * local-state pattern `SystemPill.tsx`'s `SystemReminderPill` already uses.
 *
 * This spec emits a `permission_request` notification for another session
 * with a long question (same dev-emit fixture as
 * `cc-parity-2.1.207-blocked-session-peek.spec.ts`), asserts the expand
 * toggle appears, is truncated by default, and reveals the full question on
 * click without navigating away or clearing the notification.
 *
 * Screenshot target: docs/cc-parity/2.1.283/notification-peek-expand.png
 */

import { mkdirSync } from "node:fs";
import { resolve } from "node:path";
import { test, expect, type APIRequestContext } from "../helpers/test";
import { activateClaudiusWorkspace } from "./helpers/workspace";

const SHOTS_DIR = resolve(process.cwd(), "docs/cc-parity/2.1.283");
mkdirSync(SHOTS_DIR, { recursive: true });

const SESSION_RE = /[?&]session=([0-9a-f-]{36})/i;

type Workspace = { id: string; rootPath: string };

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

async function clearAllWorkspacesUnread(req: APIRequestContext, baseURL?: string): Promise<void> {
  const res = await req.get(`${baseURL}/api/workspaces`);
  if (!res.ok()) return;
  const data = (await res.json()) as { workspaces: Array<{ id: string }> };
  await Promise.all(
    data.workspaces.map((w) =>
      req.post(`${baseURL}/api/notifications/read-all`, { data: { workspaceId: w.id } }).catch(() => {}),
    ),
  );
}

test.beforeEach(async ({ page }) => {
  await activateClaudiusWorkspace(page);
  await page.route("**/api/sessions/open-tabs", async (route) => {
    if (route.request().method() === "PUT") {
      return route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify({ ok: true }) });
    }
    return route.fallback();
  });
});

test.describe("CC 2.1.283 — blocked-session peek click-to-expand", () => {
  test("a long blocked question truncates with an expand toggle that reveals the full text", async ({
    page,
    request,
    baseURL,
  }) => {
    await page.goto("/");
    await page.waitForURL((url) => SESSION_RE.test(String(url)), { timeout: 30_000 });
    const ws = await getActiveWorkspace(request, baseURL);
    await clearAllWorkspacesUnread(request, baseURL);

    await expect(page.getByTestId("notifications-drawer-trigger")).toBeVisible({ timeout: 15_000 });

    const otherSessionId = "aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee";
    const longQuestion =
      "Delete every generated build artifact under dist/, .next/, and node_modules/.cache, then reinstall " +
      "all workspace dependencies from a clean lockfile before re-running the full test suite?";
    const emit = await request.post(`${baseURL}/api/notifications/dev-emit`, {
      data: {
        cwd: ws.rootPath,
        sessionId: otherSessionId,
        event: {
          type: "permission_request",
          requestId: "req-e2e-expand-1",
          toolName: "Bash",
          toolUseId: "tool-e2e-expand-1",
          input: { command: "rm -rf dist .next node_modules/.cache && npm ci && npm test" },
          title: longQuestion,
        },
      },
    });
    expect(emit.ok()).toBeTruthy();

    await expect(page.getByTestId("notifications-drawer-badge")).toHaveText("1", { timeout: 15_000 });
    await page.getByTestId("notifications-drawer-trigger").click();
    const panel = page.getByTestId("notifications-drawer-panel");
    await expect(panel).toBeVisible();

    const primary = panel.getByTestId("notification-primary-text").first();
    await expect(primary).toHaveText(longQuestion);

    const toggle = panel.getByTestId("notification-peek-expand").first();
    await expect(toggle).toBeVisible();
    await expect(toggle).toHaveText("▸");
    await expect(toggle).toHaveAttribute("aria-expanded", "false");

    // Truncated by default — the primary line's rendered box is far
    // narrower than the full question would need on one line.
    const collapsedBox = await primary.boundingBox();
    expect(collapsedBox).not.toBeNull();

    await page.waitForTimeout(150);
    await page.screenshot({ path: resolve(SHOTS_DIR, "notification-peek-expand.png"), fullPage: false });

    await toggle.click();
    await expect(toggle).toHaveText("▾");
    await expect(toggle).toHaveAttribute("aria-expanded", "true");
    // Still the same text, now allowed to wrap onto multiple lines — the
    // row must NOT have navigated away or cleared the unread notification.
    await expect(primary).toHaveText(longQuestion);
    const expandedBox = await primary.boundingBox();
    expect(expandedBox).not.toBeNull();
    expect(expandedBox!.height).toBeGreaterThan(collapsedBox!.height);
    await expect(page.getByTestId("notifications-drawer-badge")).toHaveText("1");

    await page.waitForTimeout(150);
    await page.screenshot({ path: resolve(SHOTS_DIR, "notification-peek-expanded.png"), fullPage: false });
  });
});
