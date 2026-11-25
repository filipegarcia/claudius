/**
 * CC 2.1.331 parity —
 *   "[VSCode] Fixed the @ menu inserting the wrong file on a quick Tab or
 *    Enter, and Enter not sending a prompt that ends in an @word with no
 *    matching file", and
 *   "[VSCode] Fixed the @ menu showing "No files found" before its first
 *    search results arrived, or when it couldn't search all files of a very
 *    large workspace, which it now says".
 *
 * Claudius's @ menu had all three:
 *   1. While the search for the token as typed was still running, the
 *      previous query's rows stayed on screen and took Tab/Enter, so a quick
 *      Tab inserted the wrong file. Tab/Enter now wait for the results.
 *   2. With a prompt ending in an `@word` nothing matches (`thanks @zzzz`),
 *      Enter inserted a newline. It now sends.
 *   3. The server walk stops at 5,000 entries or depth 6, and a file beyond
 *      that made the menu close as if it didn't exist. When a partial search
 *      matches nothing, the menu now says the search was partial. The note
 *      stays out of the way when there are rows: the depth limit alone marks
 *      most real repos as partial. (The "No files found" half was already
 *      fine: the menu shows "loading…" until results land.)
 *
 * Screenshot target: docs/cc-parity/2.1.331/at-menu-truncated.png
 */

import { mkdirSync } from "node:fs";
import { resolve } from "node:path";
import { test, expect, type Page, type Route } from "../helpers/test";
import { activateClaudiusWorkspace } from "./helpers/workspace";
import { initEvent, mockChatBackend } from "./helpers/mock-chat";

const SHOTS_DIR = resolve(process.cwd(), "docs/cc-parity/2.1.331");
mkdirSync(SHOTS_DIR, { recursive: true });

const FAKE_SESSION_ID = "aaaaaaaa-bbbb-cccc-dddd-00000331am01";

type FsAnswer = { entries: Array<{ relPath: string; absPath: string; type: "file" | "dir" }>; truncated?: boolean };

async function setup(
  page: Page,
  answer: (q: string) => { body: FsAnswer; delayMs?: number },
): Promise<{ inputs: string[] }> {
  const inputs: string[] = [];
  await mockChatBackend(page, FAKE_SESSION_ID, [
    { type: "ready", sessionId: FAKE_SESSION_ID },
    initEvent("sys-init-331am"),
    { type: "replay_done", hasMoreAbove: false },
  ]);
  await page.route(`**/api/sessions/${FAKE_SESSION_ID}/prompt-draft`, (route: Route) =>
    route.request().method() === "GET"
      ? route.fulfill({ json: { text: "", images: [] } })
      : route.fulfill({ json: { ok: true } }),
  );
  await page.route(`**/api/sessions/${FAKE_SESSION_ID}/input`, (route: Route) => {
    const body = route.request().postDataJSON() as { text?: string };
    inputs.push(body?.text ?? "");
    return route.fulfill({ json: { ok: true, queued: false, uuid: `u-${inputs.length}` } });
  });
  await page.route("**/api/fs/list**", async (route: Route) => {
    const q = new URL(route.request().url()).searchParams.get("q") ?? "";
    const { body, delayMs } = answer(q);
    if (delayMs) await new Promise((r) => setTimeout(r, delayMs));
    return route.fulfill({ json: body }).catch(() => {});
  });
  return { inputs };
}

const file = (relPath: string) => ({ relPath, absPath: `/repo/${relPath}`, type: "file" as const });

test.beforeEach(async ({ page }) => {
  await activateClaudiusWorkspace(page);
});

test("a quick Tab waits for the current search instead of inserting the previous query's file", async ({ page }) => {
  await setup(page, (q) =>
    q === "ab"
      ? { body: { entries: [file("ab-new.ts")] }, delayMs: 1500 }
      : { body: { entries: [file("a-old.ts")] } },
  );
  await page.goto("/");

  const composer = page.getByTestId("prompt-input");
  await expect(composer).toBeEnabled({ timeout: 15_000 });
  await composer.focus();
  await composer.pressSequentially("@a");
  await expect(page.getByText("a-old.ts")).toBeVisible();

  // Type one more letter and Tab right away, before `ab` has answered.
  await composer.pressSequentially("b");
  await page.keyboard.press("Tab");
  await expect(composer).toHaveValue("@ab");

  // Once the results for `ab` are in, Tab picks from them.
  await expect(page.getByText("ab-new.ts")).toBeVisible();
  await page.keyboard.press("Tab");
  await expect(composer).toHaveValue("@ab-new.ts ");
});

test("Enter sends a prompt that ends in an @word with no matching file", async ({ page }) => {
  const { inputs } = await setup(page, () => ({ body: { entries: [] } }));
  await page.goto("/");

  const composer = page.getByTestId("prompt-input");
  await expect(composer).toBeEnabled({ timeout: 15_000 });
  await composer.focus();
  const searched = page.waitForResponse((r) => r.url().includes("/api/fs/list") && r.url().includes("q=zzzz"));
  await composer.pressSequentially("thanks @zzzz");
  await searched;

  await page.keyboard.press("Enter");
  await expect.poll(() => inputs.length).toBe(1);
  expect(inputs[0]).toBe("thanks @zzzz");
});

test("a partial search of a large workspace says so instead of closing the menu", async ({ page }) => {
  await setup(page, () => ({ body: { entries: [], truncated: true } }));
  await page.goto("/");

  const composer = page.getByTestId("prompt-input");
  await expect(composer).toBeEnabled({ timeout: 15_000 });
  await composer.focus();
  await composer.pressSequentially("see @deep/nested/file.ts");
  await expect(page.getByTestId("at-mention-search-truncated")).toBeVisible();

  await page.waitForTimeout(100);
  await page.screenshot({ path: resolve(SHOTS_DIR, "at-menu-truncated.png"), fullPage: false });
});

test("the partial-search note stays hidden while there are matches to pick", async ({ page }) => {
  await setup(page, () => ({ body: { entries: [file("src/billing.ts")], truncated: true } }));
  await page.goto("/");

  const composer = page.getByTestId("prompt-input");
  await expect(composer).toBeEnabled({ timeout: 15_000 });
  await composer.focus();
  await composer.pressSequentially("see @billing");
  await expect(page.getByText("src/billing.ts")).toBeVisible();
  await expect(page.getByTestId("at-mention-search-truncated")).toHaveCount(0);
});
