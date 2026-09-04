/**
 * CC 2.1.260 — "Added a diff panel that opens beside the conversation in
 * fullscreen mode and shows your uncommitted changes as Claude edits;
 * toggle it with `/diff`."
 *
 * Claudius has no beside-chat split-pane layout (every slash-command panel
 * is either a full overlay or a separate route — see the rejected
 * alternative in `.claudius/cc-parity/run-notes/2.1.260.md`), so `/diff` is
 * reimplemented as `DiffOverlay` — a full-screen overlay reusing the same
 * `git/status` + `git/diff` endpoints and `DiffViewer` component the full
 * Git page (`app/[workspaceId]/git/`) already uses. `/diff` itself was
 * already registered in `lib/shared/slash-commands.ts` but forwarded to the
 * SDK as plain text (`handler: "sdk"`) — this spec exercises the flipped
 * native handler end to end.
 *
 * Screenshot target: docs/cc-parity/2.1.260/diff-panel.png
 */
import { mkdirSync } from "node:fs";
import { resolve } from "node:path";
import { test, expect, type Page, type Route } from "../helpers/test";
import { activateClaudiusWorkspace } from "./helpers/workspace";

const SHOTS_DIR = resolve(process.cwd(), "docs/cc-parity/2.1.260");
mkdirSync(SHOTS_DIR, { recursive: true });

const FAKE_SESSION_ID = "aaaaaaaa-1111-2222-3333-444444444444";

type SdkEvent = Record<string, unknown>;

function sseBody(events: SdkEvent[]): string {
  return events.map((e) => `data: ${JSON.stringify(e)}\n\n`).join("");
}

async function mockChatBackend(page: Page, events: SdkEvent[]): Promise<void> {
  await page.route("**/api/sessions", async (route: Route) => {
    if (route.request().method() !== "POST") return route.fallback();
    return route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify({ id: FAKE_SESSION_ID }),
    });
  });
  await page.route(`**/api/sessions/${FAKE_SESSION_ID}/stream*`, async (route: Route) => {
    return route.fulfill({
      status: 200,
      headers: { "Content-Type": "text/event-stream", "Cache-Control": "no-cache", Connection: "keep-alive" },
      body: sseBody(events),
    });
  });
  await page.route("**/api/sessions/open-tabs", async (route: Route) => {
    return route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify({ activeId: null, tabs: [] }),
    });
  });
  await page.route(`**/api/sessions/${FAKE_SESSION_ID}/pending-prompts`, async (route: Route) => {
    return route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify({ asks: [], permissions: [] }) });
  });
  await page.route("**/api/limits*", async (route: Route) => {
    return route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify({ limits: { sessionUsd: 0, projectDailyUsd: 0 } }) });
  });
}

const PRELUDE: SdkEvent[] = [
  { type: "ready", sessionId: FAKE_SESSION_ID },
  { type: "sdk", message: { type: "system", subtype: "init", uuid: "sys-init-0", model: "claude-sonnet-4-6" } },
  { type: "replay_done", hasMoreAbove: false },
];

const FAKE_DIFF = [
  "diff --git a/src/example.ts b/src/example.ts",
  "index 1111111..2222222 100644",
  "--- a/src/example.ts",
  "+++ b/src/example.ts",
  "@@ -1,3 +1,4 @@",
  " export function example() {",
  "+  // added a comment while Claude was editing",
  "   return 1;",
  " }",
  "",
].join("\n");

test.beforeEach(async ({ page }) => {
  await activateClaudiusWorkspace(page);
  // Mock the git plumbing DiffOverlay calls — deterministic content
  // regardless of this repo's actual working-tree state at test time.
  await page.route("**/api/workspaces/*/git/status", async (route: Route) => {
    return route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify({
        isRepo: true,
        branch: "main",
        files: [{ path: "src/example.ts", index: " ", worktree: "M", untracked: false }],
      }),
    });
  });
  await page.route("**/api/workspaces/*/git/diff**", async (route: Route) => {
    return route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify({ diff: FAKE_DIFF, binary: false }),
    });
  });
});

test.describe("Diff overlay via native /diff command (CC 2.1.260 parity)", () => {
  test("shows uncommitted changes as an overlay beside the chat chrome", async ({ page }) => {
    await mockChatBackend(page, PRELUDE);
    await page.goto("/");

    const composer = page.getByTestId("prompt-input");
    await expect(composer).toBeVisible({ timeout: 15_000 });
    await composer.fill("/diff");
    // Enter would be intercepted by the slash-autocomplete menu — click Send
    // directly, same pattern as the other native-slash-command specs.
    await page.getByTestId("prompt-send").click();

    // Overlay chrome + the mocked changed file + its diff content, all in
    // context with the chat surface / side nav behind it.
    await expect(page.getByText("Uncommitted changes")).toBeVisible({ timeout: 5_000 });
    const fileList = page.getByTestId("diff-overlay-file-list");
    await expect(fileList).toBeVisible({ timeout: 5_000 });
    await expect(fileList).toContainText("src/example.ts");
    await expect(page.getByText("added a comment while Claude was editing")).toBeVisible({ timeout: 5_000 });

    await page.waitForTimeout(300);
    await page.screenshot({ path: resolve(SHOTS_DIR, "diff-panel.png"), fullPage: false });
  });

  test("shows an empty state when there are no uncommitted changes", async ({ page }) => {
    await page.route("**/api/workspaces/*/git/status", async (route: Route) => {
      return route.fulfill({
        status: 200,
        contentType: "application/json",
        body: JSON.stringify({ isRepo: true, branch: "main", files: [] }),
      });
    });
    await mockChatBackend(page, PRELUDE);
    await page.goto("/");

    const composer = page.getByTestId("prompt-input");
    await expect(composer).toBeVisible({ timeout: 15_000 });
    await composer.fill("/diff");
    await page.getByTestId("prompt-send").click();

    await expect(page.getByTestId("diff-overlay-empty")).toBeVisible({ timeout: 5_000 });
    await expect(page.getByTestId("diff-overlay-empty")).toContainText("No uncommitted changes");
  });
});
