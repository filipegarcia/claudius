/**
 * CC 2.1.316 parity — "Fixed prompts containing invisible characters needing
 * a second Enter to send; plain prompts now send cleaned on the first Enter,
 * and commands still wait for review".
 *
 * Claudius's composer (`components/chat/PromptInput.tsx`) strips invisible
 * Unicode at submit time. Since 2.1.277 any prompt that needed cleaning was
 * put back for review, so a stray zero-width space from a web copy-paste
 * cost a second Send. Now a plain prompt goes out cleaned on the first
 * Enter and the footer says how many characters were removed; a bidi
 * control, a `/` command or an empty-once-cleaned prompt with nothing
 * attached is still held
 * (`invisibleStripNeedsReview`, pinned by the vitest
 * `cc-parity-2.1.316-invisible-send.test.ts`).
 *
 * The chat backend is route-mocked (fixed SSE fixture + recorded `/input`
 * POSTs), so the test can assert exactly what text left the composer.
 *
 * Screenshot target: docs/cc-parity/2.1.316/invisible-sent-cleaned.png
 */

import { mkdirSync } from "node:fs";
import { resolve } from "node:path";
import { test, expect, type Page, type Route } from "../helpers/test";
import { activateClaudiusWorkspace } from "./helpers/workspace";

const SHOTS_DIR = resolve(process.cwd(), "docs/cc-parity/2.1.316");
mkdirSync(SHOTS_DIR, { recursive: true });

const FAKE_SESSION_ID = "aaaaaaaa-bbbb-cccc-dddd-00000316ivs1";

type SdkEvent = Record<string, unknown>;

const PRELUDE: SdkEvent[] = [
  { type: "ready", sessionId: FAKE_SESSION_ID },
  { type: "sdk", message: { type: "system", subtype: "init", uuid: "sys-init-316ivs", model: "claude-sonnet-4-6" } },
  { type: "replay_done", hasMoreAbove: false },
];

async function mockChatBackend(page: Page): Promise<{ sentTexts: string[] }> {
  const sentTexts: string[] = [];
  await page.route("**/api/sessions", async (route: Route) => {
    if (route.request().method() !== "POST") return route.fallback();
    return route.fulfill({ json: { id: FAKE_SESSION_ID } });
  });
  await page.route(`**/api/sessions/${FAKE_SESSION_ID}/stream*`, (route: Route) =>
    route.fulfill({
      status: 200,
      headers: { "Content-Type": "text/event-stream", "Cache-Control": "no-cache", Connection: "keep-alive" },
      body: PRELUDE.map((e) => `data: ${JSON.stringify(e)}\n\n`).join(""),
    }),
  );
  await page.route(`**/api/sessions/${FAKE_SESSION_ID}/input`, (route: Route) => {
    const body = route.request().postDataJSON() as { text?: string };
    sentTexts.push(body?.text ?? "");
    return route.fulfill({ json: { ok: true, queued: false } });
  });
  await page.route("**/api/sessions/open-tabs", (route: Route) =>
    route.fulfill({ json: { activeId: null, tabs: [] } }),
  );
  await page.route(`**/api/sessions/${FAKE_SESSION_ID}/pending-prompts`, (route: Route) =>
    route.fulfill({ json: { asks: [], permissions: [] } }),
  );
  await page.route(`**/api/sessions/${FAKE_SESSION_ID}/prompt-draft`, (route: Route) =>
    route.request().method() === "GET"
      ? route.fulfill({ json: { text: "", images: [] } })
      : route.fulfill({ json: { ok: true } }),
  );
  await page.route("**/api/limits*", (route: Route) =>
    route.fulfill({ json: { limits: { sessionUsd: 0, projectDailyUsd: 0 } } }),
  );
  return { sentTexts };
}

test.beforeEach(async ({ page }) => {
  await activateClaudiusWorkspace(page);
});

test("a plain prompt with invisible characters sends cleaned on the first Enter", async ({ page }) => {
  const { sentTexts } = await mockChatBackend(page);
  await page.goto("/");

  const composer = page.getByTestId("prompt-input");
  await expect(composer).toBeEnabled({ timeout: 15_000 });

  // Two invisible characters a web copy-paste typically drags along: a
  // zero-width space and a byte-order mark.
  await composer.fill("Summarize\u{200B} the failing tests in\u{FEFF} the CI log");
  await composer.press("Enter");

  // One Enter: the cleaned text left, the composer emptied, no hold toast.
  await expect.poll(() => sentTexts).toEqual(["Summarize the failing tests in the CI log"]);
  await expect(composer).toHaveValue("");
  await expect(page.getByTestId("chat-toast")).toHaveCount(0);

  const notice = page.getByTestId("prompt-invisible-unicode-notice");
  await expect(notice).toHaveText("Removed 2 hidden characters from your prompt");

  // The footer notice auto-dismisses after a few seconds — capture it now.
  await page.screenshot({ path: resolve(SHOTS_DIR, "invisible-sent-cleaned.png"), fullPage: false });
});

test("a command with an invisible character still waits for review", async ({ page }) => {
  const { sentTexts } = await mockChatBackend(page);
  await page.goto("/");

  const composer = page.getByTestId("prompt-input");
  await expect(composer).toBeEnabled({ timeout: 15_000 });

  // Click Send rather than pressing Enter: a leading `/word` opens the slash
  // picker, which would take the Enter itself.
  await composer.fill("/exit\u{200B}");
  await page.getByTestId("prompt-send").click();

  await expect(page.getByTestId("chat-toast")).toContainText(/review and press Send again/);
  await expect(composer).toHaveValue("/exit");
  await page.waitForTimeout(300);
  expect(sentTexts).toEqual([]);
  await expect(page.getByTestId("prompt-invisible-unicode-notice")).toHaveCount(0);
});
