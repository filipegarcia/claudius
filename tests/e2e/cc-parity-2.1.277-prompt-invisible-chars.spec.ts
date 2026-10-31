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
 * CC 2.1.316 narrowed the hold: a plain prompt now sends cleaned on the
 * first Send (with a footer notice); only a prompt with a bidi control, a
 * command (`/…`, `!…`, exit words) or nothing left after cleaning is held.
 *
 * This spec mocks the chat backend the same way
 * `cc-parity-2.1.275-send-all-queued.spec.ts` does (fixed SSE fixture +
 * routed POSTs), types prompts containing hidden characters, presses Send,
 * and asserts which are sent cleaned and which are held (composer keeps the
 * cleaned text, no message left the session, notice toast renders).
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
  // CC 2.1.316 parity — "Fixed prompts containing invisible characters
  // needing a second Enter to send; plain prompts now send cleaned on the
  // first Enter, and commands still wait for review". This used to be the
  // "held for review" case; a plain prompt now goes out cleaned at once.
  test("a plain prompt with a hidden zero-width character is sent cleaned on the first Send", async ({
    page,
  }) => {
    const { sentTexts } = await mockChatBackend(page, PRELUDE);
    await page.goto("/");

    const composer = page.getByTestId("prompt-input");
    await expect(composer).toBeEnabled({ timeout: 15_000 });

    // A zero-width space hidden inside otherwise-ordinary text — invisible
    // in the rendered textarea, but present in the DOM value.
    await composer.fill("Please run tests\u{200B} and report back");
    await page.getByTestId("prompt-send").click();

    await expect.poll(() => sentTexts[0]).toBe("Please run tests and report back");
    expect(sentTexts).toHaveLength(1);
    await expect(composer).toHaveValue("");
    await expect(page.getByTestId("prompt-invisible-unicode-notice")).toContainText(
      "Removed 1 invisible character from your prompt",
    );
  });

  test("a prompt with a hidden bidi override is held for review instead of sent", async ({ page }) => {
    const { sentTexts } = await mockChatBackend(page, PRELUDE);
    await page.goto("/");

    const composer = page.getByTestId("prompt-input");
    await expect(composer).toBeEnabled({ timeout: 15_000 });

    // A right-to-left override (U+202E) can visually reorder the text that
    // follows it, so the user must see the cleaned prompt before it leaves.
    await composer.fill("Please open \u{202E}txt.exe and report back");
    await page.getByTestId("prompt-send").click();

    // Held: the toast explains why, and the composer keeps the CLEANED text
    // (bidi control gone) rather than clearing on send.
    const toast = page.getByTestId("chat-toast");
    await expect(toast).toBeVisible();
    await expect(toast).toContainText(/hidden character/i);
    await expect(composer).toHaveValue("Please open txt.exe and report back");
    expect(sentTexts).toHaveLength(0);

    await page.waitForTimeout(200);
    await page.screenshot({
      path: resolve(SCREENSHOT_DIR, "prompt-invisible-chars-held.png"),
      fullPage: false,
    });

    // Pressing Send again on the now-clean text goes through normally.
    await page.getByTestId("prompt-send").click();
    await expect(composer).toHaveValue("");
    await expect.poll(() => sentTexts[0]).toBe("Please open txt.exe and report back");
  });

  test("a slash command with a hidden character still waits for review", async ({ page }) => {
    const { sentTexts } = await mockChatBackend(page, PRELUDE);
    await page.goto("/");

    const composer = page.getByTestId("prompt-input");
    await expect(composer).toBeEnabled({ timeout: 15_000 });

    // Click Send rather than pressing Enter: a leading `/word` opens the
    // slash picker, which would take the Enter itself.
    await composer.fill("/cost\u{200B}");
    await page.getByTestId("prompt-send").click();

    await expect(page.getByTestId("chat-toast")).toContainText(/hidden character/i);
    await expect(composer).toHaveValue("/cost");
    expect(sentTexts).toHaveLength(0);
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
