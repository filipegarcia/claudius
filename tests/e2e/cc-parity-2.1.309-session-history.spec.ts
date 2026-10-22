/**
 * CC 2.1.309 parity — two session-history fixes that also lived in Claudius:
 *
 * 1. "[VSCode] Fixed Session history filling up with empty 'Untitled' sessions
 *    each time you start a new session without sending a message."
 *    `Session.start()` writes a sessions-index row right away and
 *    `/api/sessions/all` used to synthesize a history entry for every
 *    DB-only row, so each abandoned new tab showed up as "(untitled)" on
 *    `/sessions` and in the session picker. Now an untitled, never-used,
 *    no-longer-open session is left out.
 *
 * 2. "Fixed sessions renamed with /rename appearing to other sessions under a
 *    generated name after a reload or --resume." Claudius's non-live rename
 *    path only wrote the JSONL, while every reader prefers the index title, so
 *    a stale title shadowed the rename after a reload. Now the index row is
 *    updated too.
 *
 * Runs against the real backend (no stream mocks): sessions are created by
 * loading the app, evicted from memory with the dev-reap endpoint (the same
 * path the idle reaper takes), and renamed through `/api/sessions/rename`.
 *
 * Screenshot target: docs/cc-parity/2.1.309/session-history.png
 */

import { mkdirSync } from "node:fs";
import { resolve } from "node:path";
import { test, expect, type Page } from "../helpers/test";
import { activateClaudiusWorkspace } from "./helpers/workspace";

const SHOTS_DIR = resolve(process.cwd(), "docs/cc-parity/2.1.309");
mkdirSync(SHOTS_DIR, { recursive: true });

const SESSION_RE = /[?&]session=([0-9a-f-]{36})/i;

type WorkspaceSummary = { id: string; name: string; rootPath: string };
type SessionsAll = { sessions: Array<{ sessionId: string; claudiusTitle?: string }> };

async function waitForBoundSession(page: Page, opts: { not?: string } = {}): Promise<string> {
  await page.waitForURL(
    (url) => {
      const m = String(url).match(SESSION_RE);
      if (!m) return false;
      return !(opts.not && m[1] === opts.not);
    },
    { timeout: 30_000 },
  );
  const id = page.url().match(SESSION_RE)?.[1];
  expect(id).toMatch(/^[0-9a-f-]{36}$/i);
  return id!;
}

async function forceReap(page: Page, sessionId: string): Promise<void> {
  const res = await page.request.post(`/api/sessions/${sessionId}/dev-reap`);
  expect(res.ok(), `dev-reap should succeed for ${sessionId}`).toBeTruthy();
}

async function listedSessions(page: Page): Promise<SessionsAll["sessions"]> {
  const r = await page.request.get("/api/sessions/all?limit=200");
  expect(r.ok()).toBeTruthy();
  return ((await r.json()) as SessionsAll).sessions;
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

test.beforeEach(async ({ page }) => {
  await activateClaudiusWorkspace(page);
});

test("an abandoned empty session leaves history; a non-live rename survives reload", async ({ page }) => {
  test.setTimeout(90_000);

  await page.goto("/");
  const named = await waitForBoundSession(page);
  // Name it while it's live (index write), as the user would right after
  // opening it — the row the old non-live rename path left stale.
  const firstTitle = `e2e generated ${Date.now().toString(36)}`;
  const r1 = await page.request.post("/api/sessions/rename", { data: { sessionId: named, title: firstTitle } });
  expect(r1.ok()).toBeTruthy();

  // A second tab the user opens and abandons without typing anything.
  await page.locator('button[title="New session tab"]').click();
  const empty = await waitForBoundSession(page, { not: named });

  // Both leave memory (idle reaper path). From here on, only the index row
  // and any JSONL represent them.
  await forceReap(page, named);
  await forceReap(page, empty);

  // Rename the reaped session — the non-live branch of /api/sessions/rename.
  const finalTitle = `Release prep ${Date.now().toString(36)}`;
  const r2 = await page.request.post("/api/sessions/rename", { data: { sessionId: named, title: finalTitle } });
  expect(r2.ok(), "non-live rename should succeed").toBeTruthy();

  const sessions = await listedSessions(page);
  const ids = sessions.map((s) => s.sessionId);
  // (1) The empty, never-used session is not in history any more.
  expect(ids).not.toContain(empty);
  // (2) The renamed one is, under the new name — not the stale index title.
  const row = sessions.find((s) => s.sessionId === named);
  expect(row, "renamed session is listed").toBeTruthy();
  expect(row!.claudiusTitle).toBe(finalTitle);

  // Same thing on the /sessions history page, after a full reload.
  const wsId = await activeWorkspaceId(page);
  await page.goto(`/${wsId}/sessions`);
  await page.reload();
  const namedRow = page.locator(`[data-testid="session-row"][data-session-id="${named}"]`);
  await expect(namedRow).toBeVisible({ timeout: 20_000 });
  await expect(namedRow).toContainText(finalTitle);
  await expect(namedRow).not.toContainText(firstTitle);
  await expect(page.locator(`[data-testid="session-row"][data-session-id="${empty}"]`)).toHaveCount(0);

  await page.waitForTimeout(200);
  await page.screenshot({ path: resolve(SHOTS_DIR, "session-history.png"), fullPage: false });
});

test("the currently open empty session still shows in history", async ({ page }) => {
  test.setTimeout(60_000);
  await page.goto("/");
  const open = await waitForBoundSession(page);
  // Still live, so the filter must keep it: it's the tab the user is on and
  // the session picker has to be able to find it.
  await expect
    .poll(async () => (await listedSessions(page)).map((s) => s.sessionId), { timeout: 15_000 })
    .toContain(open);
});
