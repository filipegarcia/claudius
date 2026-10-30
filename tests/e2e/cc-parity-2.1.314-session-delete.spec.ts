/**
 * CC 2.1.314 parity — two session-delete fixes on Claudius's own /sessions
 * surface:
 *
 * 1. "Fixed a rare case where a deleted session could reappear in the resume
 *    list as an almost empty entry". Delete only unlinked the SDK transcript;
 *    a renamed session's `.claudius.db` row stayed and `/api/sessions/all`
 *    rebuilt a title-only entry from it. A session renamed before its first
 *    message (no transcript yet) couldn't be deleted at all — the SDK said
 *    "not found" and the row stayed forever.
 *
 * 2. "[VSCode] Fixed session group changes that cannot be saved, such as a
 *    delete, failing silently; an error notification now appears". Claudius
 *    has no session groups; its Delete had the same silent failure. A delete
 *    the server refuses now shows the reason in the page header.
 *
 * Runs against the real backend; (2) forces the failure with page.route.
 *
 * Screenshot target: docs/cc-parity/2.1.314/session-delete-error.png
 */

import { mkdirSync } from "node:fs";
import { resolve } from "node:path";
import { test, expect, type Page } from "../helpers/test";
import { activateClaudiusWorkspace } from "./helpers/workspace";

const SHOTS_DIR = resolve(process.cwd(), "docs/cc-parity/2.1.314");
mkdirSync(SHOTS_DIR, { recursive: true });

const SESSION_RE = /[?&]session=([0-9a-f-]{36})/i;

type WorkspaceSummary = { id: string; name: string; rootPath: string };
type SessionsAll = { sessions: Array<{ sessionId: string; claudiusTitle?: string }> };

async function waitForBoundSession(page: Page): Promise<string> {
  await page.waitForURL((url) => SESSION_RE.test(String(url)), { timeout: 30_000 });
  const id = page.url().match(SESSION_RE)?.[1];
  expect(id).toMatch(/^[0-9a-f-]{36}$/i);
  return id!;
}

async function listedIds(page: Page): Promise<string[]> {
  const r = await page.request.get("/api/sessions/all?limit=200");
  expect(r.ok()).toBeTruthy();
  return ((await r.json()) as SessionsAll).sessions.map((s) => s.sessionId);
}

async function activeWorkspaceId(page: Page): Promise<string> {
  const r = await page.request.get("/api/workspaces");
  const data = (await r.json()) as { workspaces: WorkspaceSummary[]; activeId?: string };
  const ws =
    data.workspaces.find((w) => w.id === data.activeId) ??
    data.workspaces.find((w) => w.name === "claudius") ??
    data.workspaces.find((w) => w.rootPath === process.cwd());
  expect(ws, "an active workspace").toBeTruthy();
  return ws!.id;
}

/** A live session with an index-row title and no transcript yet. */
async function namedSession(page: Page, title: string): Promise<string> {
  await page.goto("/");
  const id = await waitForBoundSession(page);
  const r = await page.request.post("/api/sessions/rename", { data: { sessionId: id, title } });
  expect(r.ok()).toBeTruthy();
  return id;
}

async function clickDelete(page: Page, sessionId: string): Promise<void> {
  const row = page.locator(`[data-testid="session-row"][data-session-id="${sessionId}"]`);
  await expect(row).toBeVisible({ timeout: 20_000 });
  await row.hover();
  page.once("dialog", (d) => void d.accept());
  await row.getByRole("button", { name: "Delete" }).click();
}

test.beforeEach(async ({ page }) => {
  await activateClaudiusWorkspace(page);
});

test("a deleted session stays deleted after a reload", async ({ page }) => {
  test.setTimeout(90_000);
  const title = `Delete me ${Date.now().toString(36)}`;
  const id = await namedSession(page, title);
  expect(await listedIds(page)).toContain(id);

  const wsId = await activeWorkspaceId(page);
  await page.goto(`/${wsId}/sessions`);
  await clickDelete(page, id);

  const row = page.locator(`[data-testid="session-row"][data-session-id="${id}"]`);
  await expect(row).toHaveCount(0, { timeout: 15_000 });
  await expect(page.getByTestId("sessions-action-error")).toHaveCount(0);

  // The bug: the title-only index row came back as an almost empty entry.
  const relisted = page.waitForResponse((r) => r.url().includes("/api/sessions/all") && r.ok(), { timeout: 20_000 });
  await page.reload();
  await relisted;
  await expect(row).toHaveCount(0);
  expect(await listedIds(page)).not.toContain(id);
});

test("a delete the server refuses says why instead of failing silently", async ({ page }) => {
  test.setTimeout(90_000);
  const title = `Can't delete ${Date.now().toString(36)}`;
  const id = await namedSession(page, title);

  const wsId = await activeWorkspaceId(page);
  await page.route(`**/api/sessions/file/${id}**`, (route) =>
    route.request().method() === "DELETE"
      ? route.fulfill({ status: 500, json: { error: "EACCES: permission denied, unlink" } })
      : route.continue(),
  );
  await page.goto(`/${wsId}/sessions`);
  await clickDelete(page, id);

  const err = page.getByTestId("sessions-action-error");
  await expect(err).toBeVisible();
  await expect(err).toContainText(`Couldn't delete session ${id.slice(0, 8)}`);
  await expect(err).toContainText("EACCES: permission denied");
  // The row is still there: nothing was deleted.
  await expect(page.locator(`[data-testid="session-row"][data-session-id="${id}"]`)).toBeVisible();

  await page.waitForTimeout(200);
  await page.screenshot({ path: resolve(SHOTS_DIR, "session-delete-error.png"), fullPage: false });

  // Clean up the fixture session for real.
  await page.unroute(`**/api/sessions/file/${id}**`);
  const del = await page.request.delete(`/api/sessions/file/${id}`);
  expect(del.ok()).toBeTruthy();
});
