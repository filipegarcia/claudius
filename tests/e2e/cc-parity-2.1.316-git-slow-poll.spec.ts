/**
 * CC 2.1.316 parity — "Improved /diff on large repositories: each refresh
 * usually runs one fewer full-repository git command, and refreshes are
 * spaced out when git is slow".
 *
 * Claudius's Git page polled `git/status` on a fixed 4s `setInterval` and
 * every tick aborted the in-flight request, so on a repo where `git status`
 * takes longer than 4s the Changes list never rendered and the server's git
 * children overlapped. Now the poll waits for the running request and spaces
 * the next one by `3 ×` its duration (`lib/client/git-poll.ts`).
 *
 * Here every `git/status` answer is held ~5s (a "slow repo") and fulfilled
 * with a fixture. No visible UI changed, so no screenshot.
 */

import { test, expect } from "../helpers/test";
import { activateClaudiusWorkspace } from "./helpers/workspace";

const HOLD_MS = 5000;
const FIXTURE_PATH = "cc-parity-2.1.316/slow-repo-file.ts";

test.beforeEach(async ({ page }) => {
  await activateClaudiusWorkspace(page);
});

test("a slow git status still lands in the Changes list and is never overlapped or aborted", async ({
  page,
}) => {
  test.setTimeout(90_000);
  const cwd = process.cwd();
  const list = (await (await page.request.get("/api/workspaces")).json()) as {
    workspaces: { id: string; name: string; rootPath: string }[];
  };
  const ws = list.workspaces.find((w) => w.name === "claudius") ?? list.workspaces.find((w) => w.rootPath === cwd);
  expect(ws, "the claudius workspace").toBeTruthy();

  type Req = { startedAt: number; endedAt: number | null; failed: boolean };
  const reqs: Req[] = [];
  const byRequest = new Map<unknown, Req>();
  let measureFrom = Number.POSITIVE_INFINITY;

  page.on("requestfailed", (r) => {
    const rec = byRequest.get(r);
    if (rec) {
      rec.failed = true;
      rec.endedAt ??= Date.now();
    }
  });

  await page.route(`**/api/workspaces/${ws!.id}/git/status*`, async (route) => {
    const rec: Req = { startedAt: Date.now(), endedAt: null, failed: false };
    reqs.push(rec);
    byRequest.set(route.request(), rec);
    await new Promise((r) => setTimeout(r, HOLD_MS));
    try {
      await route.fulfill({
        status: 200,
        json: {
          isRepo: true,
          repoRoot: cwd,
          branch: "main",
          head: "0000000",
          ahead: 0,
          behind: 0,
          files: [{ path: FIXTURE_PATH, index: " ", worktree: "M", untracked: false }],
        },
      });
    } catch {
      // The page cancelled this request (e.g. React Strict Mode's mount →
      // cleanup → mount in dev aborts the very first one).
      rec.failed = true;
    }
    rec.endedAt ??= Date.now();
  });

  await page.goto(`/${ws!.id}/git`);

  // Before: a 4s poll aborted every 5s answer, so this never rendered.
  const row = page.getByRole("button", { name: /slow-repo-file\.ts/ });
  await expect(row).toBeVisible({ timeout: 20_000 });
  const renderedAt = Date.now();
  // Strict Mode's discarded first mount may have started (and aborted) one
  // request at boot; measure only what happens after the list rendered.
  measureFrom = renderedAt;

  // The next background poll is spaced by ~3 × the 5s duration, not 4s.
  await expect
    .poll(() => reqs.filter((r) => r.startedAt >= measureFrom).length, { timeout: 30_000 })
    .toBeGreaterThanOrEqual(1);
  const next = reqs.find((r) => r.startedAt >= measureFrom)!;
  expect(next.startedAt - renderedAt).toBeGreaterThanOrEqual(10_000);

  // Let that poll finish, then check nothing overlapped or was aborted.
  await expect.poll(() => next.endedAt, { timeout: 15_000 }).not.toBeNull();
  const measured = reqs.filter((r) => r.startedAt >= measureFrom);
  expect(measured.some((r) => r.failed), "no poll after the first render was aborted").toBe(false);
  const events = measured
    .flatMap((r) => [
      { t: r.startedAt, d: 1 },
      { t: r.endedAt ?? Number.POSITIVE_INFINITY, d: -1 },
    ])
    .sort((a, b) => a.t - b.t || a.d - b.d);
  let inFlight = 0;
  let maxInFlight = 0;
  for (const e of events) {
    inFlight += e.d;
    maxInFlight = Math.max(maxInFlight, inFlight);
  }
  expect(maxInFlight).toBeLessThanOrEqual(1);
  await expect(row).toBeVisible();
});
