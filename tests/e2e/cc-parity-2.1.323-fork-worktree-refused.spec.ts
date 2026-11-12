/**
 * CC 2.1.323 parity — "Changed worktree creation to refuse checkouts whose
 * .git folders are links or hold hard links, such as git-new-workdir layouts
 * and cp -al copies; use a plain clone".
 *
 * Claudius's `/fork` runs `git worktree add` itself, so the engine's refusal
 * never applied there. `createForkWorktree` now mirrors the engine's link
 * check; on refusal the fork stays on the shared checkout and the toast says
 * why. The fork route is mocked to answer as the server does in that case.
 *
 * Screenshot target: docs/cc-parity/2.1.323/fork-worktree-refused.png
 */
import { mkdirSync } from "node:fs";
import { resolve } from "node:path";
import { test, expect, type Page, type Route } from "../helpers/test";
import { activateClaudiusWorkspace } from "./helpers/workspace";

const SHOTS_DIR = resolve(process.cwd(), "docs/cc-parity/2.1.323");
mkdirSync(SHOTS_DIR, { recursive: true });

const FAKE_SESSION_ID = "aaaaaaaa-bbbb-cccc-dddd-00000323fork";
const FORK_ID = "f0c4a323-0000-4000-8000-000000000001";
const REASON =
  "git could write outside this repository through .git/logs, which is a link or a hard link; checkouts made by git-new-workdir or cp -al need a plain clone";

type SdkEvent = Record<string, unknown>;
const sseBody = (events: SdkEvent[]) => events.map((e) => `data: ${JSON.stringify(e)}\n\n`).join("");

async function mockChatBackend(page: Page) {
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
      // What the fork route answers when createForkWorktree refuses the
      // checkout (unit-tested against real git-new-workdir / cp -al layouts in
      // cc-parity-2.1.323-fork-worktree-links.test.ts).
      body: JSON.stringify({ sessionId: FORK_ID, worktree: null, worktreeError: REASON }),
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

test("/fork in a git-new-workdir checkout stays on the shared checkout and says why", async ({ page }) => {
  test.setTimeout(60_000);
  const forks = await mockChatBackend(page);
  await page.goto("/");
  await fork(page, "spike");

  await expect.poll(() => forks.length).toBe(1);
  expect(forks[0]).toMatchObject({ sessionId: FAKE_SESSION_ID, title: "spike", worktree: true });
  const toast = page.getByTestId("chat-toast");
  await expect(toast).toHaveText(
    `Forked as "spike" (f0c4a323) — couldn't create a worktree (${REASON}); it shares your checkout.`,
  );
  await page.waitForTimeout(150);
  await page.screenshot({ path: resolve(SHOTS_DIR, "fork-worktree-refused.png"), fullPage: false });
});
