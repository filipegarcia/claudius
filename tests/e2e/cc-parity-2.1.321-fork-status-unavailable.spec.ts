/**
 * CC 2.1.321 parity — "Fixed the git status given to Claude at session start
 * reading as clean when git status failed; it now reads as unavailable".
 *
 * Claudius's copy of that mistake was the `/fork` confirmation: when the
 * source repo's `git status` failed (corrupt index, a big repo past the 5 s
 * cap), `createForkWorktree` reported `dirty: false` and the toast read as if
 * every change had gone into the new worktree. The server now sends
 * `dirty: null` (unit-tested against a real corrupt-index repo in
 * cc-parity-2.1.321-fork-status-unavailable.test.ts) and the toast says the
 * check was unavailable.
 *
 * The fork route is mocked to answer as the server does in that case.
 *
 * Screenshot target: docs/cc-parity/2.1.321/fork-status-unavailable.png
 */
import { mkdirSync } from "node:fs";
import { resolve } from "node:path";
import { test, expect, type Page, type Route } from "../helpers/test";
import { activateClaudiusWorkspace } from "./helpers/workspace";

const SHOTS_DIR = resolve(process.cwd(), "docs/cc-parity/2.1.321");
mkdirSync(SHOTS_DIR, { recursive: true });

const FAKE_SESSION_ID = "aaaaaaaa-bbbb-cccc-dddd-00000321fork";
const FORK_ID = "f0c4a321-0000-4000-8000-000000000001";

type SdkEvent = Record<string, unknown>;
const sseBody = (events: SdkEvent[]) => events.map((e) => `data: ${JSON.stringify(e)}\n\n`).join("");

async function mockChatBackend(page: Page, dirty: boolean | null) {
  const forks: Array<Record<string, unknown>> = [];
  await page.route("**/api/sessions", async (route: Route) => {
    if (route.request().method() !== "POST") return route.fallback();
    return route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify({ id: FAKE_SESSION_ID }) });
  });
  await page.route(`**/api/sessions/${FAKE_SESSION_ID}/stream*`, async (route: Route) =>
    route.fulfill({
      status: 200,
      headers: { "Content-Type": "text/event-stream", "Cache-Control": "no-cache", Connection: "keep-alive" },
      body: sseBody([
        { type: "ready", sessionId: FAKE_SESSION_ID },
        { type: "sdk", message: { type: "system", subtype: "init", uuid: "sys-init-0", model: "claude-sonnet-5-5" } },
        {
          type: "sdk",
          message: { type: "user", uuid: "u-1", message: { content: [{ type: "text", text: "try the retry refactor on a branch" }] } },
        },
        {
          type: "sdk",
          message: {
            type: "assistant",
            uuid: "a-1",
            parent_tool_use_id: null,
            message: {
              model: "claude-sonnet-5-5",
              content: [{ type: "text", text: "Sure — `/fork spike` gives that attempt its own worktree." }],
              usage: { input_tokens: 10, output_tokens: 10 },
            },
          },
        },
        { type: "replay_done", hasMoreAbove: false },
      ]),
    }),
  );
  await page.route("**/api/sessions/fork", async (route: Route) => {
    if (route.request().method() !== "POST") return route.fallback();
    forks.push(route.request().postDataJSON() as Record<string, unknown>);
    return route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify({
        sessionId: FORK_ID,
        worktree: { path: "/tmp/claudius-forks/fork-f0c4a321", branch: "claudius/fork-f0c4a321", dirty },
      }),
    });
  });
  await page.route(`**/api/sessions/${FAKE_SESSION_ID}/pending-prompts`, async (route: Route) =>
    route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify({ asks: [], permissions: [] }) }),
  );
  await page.route("**/api/sessions/open-tabs", async (route: Route) =>
    route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify({ activeId: null, tabs: [] }) }),
  );
  await page.route("**/api/limits*", async (route: Route) =>
    route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify({ limits: { sessionUsd: 0, projectDailyUsd: 0 } }) }),
  );
  return forks;
}

async function fork(page: Page, title: string) {
  const composer = page.getByTestId("prompt-input");
  await expect(composer).toBeEnabled({ timeout: 30_000 });
  await composer.click();
  await composer.fill(`/fork ${title}`);
  await page.getByTestId("prompt-send").click();
}

test.beforeEach(async ({ page }) => {
  await activateClaudiusWorkspace(page);
});

test("/fork whose git status failed says the check was unavailable, not clean", async ({ page }) => {
  test.setTimeout(60_000);
  const forks = await mockChatBackend(page, null);
  await page.goto("/");
  await fork(page, "spike");

  await expect.poll(() => forks.length).toBe(1);
  expect(forks[0]).toMatchObject({ sessionId: FAKE_SESSION_ID, title: "spike", worktree: true });
  const toast = page.getByTestId("chat-toast");
  await expect(toast).toHaveText(
    `Forked as "spike" (f0c4a321) — in its own worktree claudius/fork-f0c4a321 — couldn't check for uncommitted changes (git status failed); any aren't included.`,
  );
  await page.waitForTimeout(150);
  await page.screenshot({ path: resolve(SHOTS_DIR, "fork-status-unavailable.png"), fullPage: false });
});

test("/fork from a clean tree keeps the plain confirmation", async ({ page }) => {
  test.setTimeout(60_000);
  await mockChatBackend(page, false);
  await page.goto("/");
  await fork(page, "spike");
  await expect(page.getByTestId("chat-toast")).toHaveText(
    `Forked as "spike" (f0c4a321) — in its own worktree claudius/fork-f0c4a321.`,
  );
});
