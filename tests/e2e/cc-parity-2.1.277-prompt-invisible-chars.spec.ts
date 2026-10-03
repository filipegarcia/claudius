/**
 * CC 2.1.277 parity — "Improved prompt handling: invisible Unicode
 * formatting and tag characters in a prompt are removed and the cleaned
 * prompt is shown for review before it is sent."
 *
 * Claudius owns its own composer (components/chat/PromptInput.tsx) rather
 * than delegating text entry to the SDK, so the hardening is reimplemented
 * there directly: `lib/shared/invisible-unicode.ts` strips invisible
 * Unicode/tag characters at submit time, and if anything was removed the
 * send is HELD — the cleaned text is written back into the composer and a
 * toast explains why, instead of silently forwarding a cleaned prompt the
 * user never saw.
 *
 * This spec mocks the chat backend the same way
 * `cc-parity-2.1.275-send-all-queued.spec.ts` does (fixed SSE fixture +
 * routed POSTs), types a prompt containing a hidden zero-width character,
 * presses Send, and asserts the send was held (composer keeps the cleaned
 * text, no message left the session) plus the notice toast renders.
 *
 * Screenshot target: docs/cc-parity/2.1.277/prompt-invisible-chars-held.png
 */

import { mkdirSync } from "node:fs";
import { resolve } from "node:path";
import { test, expect, type Page, type Route } from "../helpers/test";
import { activateClaudiusWorkspace } from "./helpers/workspace";

const SCREENSHOT_DIR = resolve(process.cwd(), "docs/cc-parity/2.1.277");
mkdirSync(SCREENSHOT_DIR, { recursive: true });

const FAKE_SESSION_ID = "aaaaaaaa-bbbb-cccc-dddd-0000002771q";

type SdkEvent = Record<string, unknown>;

function sseBody(events: SdkEvent[]): string {
  return events.map((e) => `data: ${JSON.stringify(e)}\n\n`).join("");
}

async function mockChatBackend(page: Page, events: SdkEvent[]): Promise<{ sentTexts: string[] }> {
  const sentTexts: string[] = [];

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
      headers: {
        "Content-Type": "text/event-stream",
        "Cache-Control": "no-cache",
        Connection: "keep-alive",
      },
      body: sseBody(events),
    });
  });

  // `/input` is what `session.send()` (lib/client/use-session.ts) actually
  // POSTs a user turn to — record the text so the test can assert it was
  // NEVER called for the tainted prompt.
  await page.route(`**/api/sessions/${FAKE_SESSION_ID}/input`, async (route: Route) => {
    const body = route.request().postDataJSON() as { text?: string };
    sentTexts.push(body?.text ?? "");
    return route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify({ ok: true, queued: false }),
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
    return route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify({ asks: [], permissions: [] }),
    });
  });

  await page.route("**/api/limits*", async (route: Route) => {
    return route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify({ limits: { sessionUsd: 0, projectDailyUsd: 0 } }),
    });
  });

  return { sentTexts };
}

const PRELUDE: SdkEvent[] = [
  { type: "ready", sessionId: FAKE_SESSION_ID },
  {
    type: "sdk",
    message: {
      type: "system",
      subtype: "init",
      uuid: "sys-init-0",
      model: "claude-sonnet-4-6",
    },
  },
  { type: "replay_done", hasMoreAbove: false },
];

test.beforeEach(async ({ page }) => {
  await activateClaudiusWorkspace(page);
});

test.describe("Invisible-Unicode prompt hardening (CC 2.1.277 parity)", () => {
  test("a prompt with a hidden zero-width character is held for review instead of sent", async ({
    page,
  }) => {
    const { sentTexts } = await mockChatBackend(page, PRELUDE);
    await page.goto("/");

    const composer = page.getByTestId("prompt-input");
    await expect(composer).toBeEnabled({ timeout: 15_000 });

    // A zero-width space hidden inside otherwise-ordinary text — invisible
    // in the rendered textarea, but present in the DOM value.
    const tainted = "Please run tests​ and report back";
    await composer.fill(tainted);
    await page.getByTestId("prompt-send").click();

    // Held: the toast explains why, and the composer keeps the CLEANED text
    // (zero-width character gone) rather than clearing on send.
    const toast = page.getByTestId("chat-toast");
    await expect(toast).toBeVisible();
    await expect(toast).toContainText(/hidden character/i);
    await expect(composer).toHaveValue("Please run tests and report back");
    expect(sentTexts).toHaveLength(0);

    await page.waitForTimeout(200);
    await page.screenshot({
      path: resolve(SCREENSHOT_DIR, "prompt-invisible-chars-held.png"),
      fullPage: false,
    });

    // Pressing Send again on the now-clean text goes through normally.
    await page.getByTestId("prompt-send").click();
    await expect(composer).toHaveValue("");
  });

  test("an ordinary prompt with no hidden characters sends immediately", async ({ page }) => {
    const { sentTexts } = await mockChatBackend(page, PRELUDE);
    await page.goto("/");

    const composer = page.getByTestId("prompt-input");
    await expect(composer).toBeEnabled({ timeout: 15_000 });
    await composer.fill("Plain, visible prompt text");
    await page.getByTestId("prompt-send").click();

    await expect(composer).toHaveValue("");
    await expect.poll(() => sentTexts.length).toBeGreaterThan(0);
  });
});
