/**
 * Claude Code 2.1.290 parity (shipped in the 2.1.289 → 2.1.291 cycle) — the
 * chat-surface items the first classification pass missed:
 *
 *  - "Fixed a crash ("Maximum call stack size exceeded") when a response
 *    nested lists or quotes thousands of levels deep." Claudius's
 *    react-markdown renderer had the same crash; `Markdown.tsx` now renders
 *    such text plain (and catches any other render throw).
 *  - "[VSCode] Changed message timestamps to show by default." Bubbles now
 *    always show their time unless `showMessageTimestamps` is false.
 *  - "[VSCode] Added a screen reader announcement, "Message queued.", when you
 *    send a message while Claude is working."
 *  - "Improved the / and @ suggestion lists: the selected row now starts with
 *    a ❯ pointer, so you can see it without color."
 *
 * Mocks the chat backend the same way `cc-parity-2.1.210-tool-call-elapsed`
 * does (fixed SSE fixture + routed endpoints).
 *
 * Screenshot targets: docs/cc-parity/2.1.291/{markdown-deep-nesting,
 * message-timestamps,picker-pointer}.png
 */

import { mkdirSync } from "node:fs";
import { resolve } from "node:path";
import { test, expect, type Page, type Route } from "../helpers/test";
import { activateClaudiusWorkspace } from "./helpers/workspace";

const SHOTS_DIR = resolve(process.cwd(), "docs/cc-parity/2.1.291");
mkdirSync(SHOTS_DIR, { recursive: true });

const FAKE_SESSION_ID = "aaaaaaaa-bbbb-cccc-dddd-000000229101";
const NOW = Date.now();

type SdkEvent = Record<string, unknown>;

function sseBody(events: SdkEvent[]): string {
  return events.map((e) => `data: ${JSON.stringify(e)}\n\n`).join("");
}

async function mockChatBackend(
  page: Page,
  events: SdkEvent[],
  opts: { userSettings?: Record<string, unknown> } = {},
): Promise<{ inputs: unknown[] }> {
  const inputs: unknown[] = [];
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
  await page.route(`**/api/sessions/${FAKE_SESSION_ID}/input`, async (route: Route) => {
    inputs.push(route.request().postDataJSON());
    return route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify({ ok: true }) });
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
  // `/api/limits` is left to the real route: with `cwd` set (below) the chat
  // reads `state.overrides` from it, which the older specs' stub omits.
  if (opts.userSettings) {
    const settings = opts.userSettings;
    await page.route(
      (url) => url.pathname === "/api/settings" && url.searchParams.get("scope") === "user",
      async (route: Route) => {
      if (route.request().method() !== "GET") return route.fallback();
      return route.fulfill({
        status: 200,
        contentType: "application/json",
        body: JSON.stringify({ settings }),
      });
      },
    );
  }
  return { inputs };
}

const PRELUDE: SdkEvent[] = [
  { type: "ready", sessionId: FAKE_SESSION_ID },
  {
    type: "sdk",
    // `cwd` gates the user-scope settings fetches (useShowMessageTimestamps & co).
    message: { type: "system", subtype: "init", uuid: "sys-init-0", model: "claude-sonnet-4-6", cwd: process.cwd() },
  },
  { type: "replay_done", hasMoreAbove: false },
];

function assistantText(uuid: string, text: string, at: number): SdkEvent {
  return {
    type: "sdk",
    at,
    message: {
      type: "assistant",
      uuid,
      parent_tool_use_id: null,
      message: {
        id: `msg_${uuid}`,
        model: "claude-sonnet-4-6",
        content: [{ type: "text", text }],
        usage: { input_tokens: 10, output_tokens: 10 },
      },
    },
  };
}

test.beforeEach(async ({ page }) => {
  await activateClaudiusWorkspace(page);
});

test.describe("CC 2.1.290 — chat surface parity", () => {
  test("a reply nesting quotes thousands deep renders as plain text instead of crashing the chat", async ({
    page,
  }) => {
    const deep = `${">".repeat(2500)} the innermost quote`;
    await mockChatBackend(page, [
      ...PRELUDE,
      assistantText("a-normal", "A normal reply with a short list:\n\n- one\n  - two\n\n> a quote", NOW - 60_000),
      assistantText("a-deep", deep, NOW),
    ]);
    const pageErrors: string[] = [];
    page.on("pageerror", (err) => pageErrors.push(err.message));
    await page.goto("/");

    const fallback = page.getByTestId("markdown-plain-fallback");
    await expect(fallback).toBeVisible({ timeout: 15_000 });
    await expect(fallback).toContainText("the innermost quote");
    await expect(fallback).toContainText("nests lists or quotes too deeply to format");
    // The ordinary reply still goes through react-markdown.
    await expect(page.locator("blockquote", { hasText: "a quote" })).toBeVisible();
    await expect(page.locator("li", { hasText: "two" }).first()).toBeVisible();
    // And the app is still alive — no global error page, composer usable.
    await expect(page.getByTestId("prompt-input")).toBeVisible();
    expect(pageErrors.filter((m) => /Maximum call stack/i.test(m))).toEqual([]);

    // The fallback is the latest message; jump there so its note isn't
    // hidden under the "Jump to latest" pill.
    const jump = page.getByRole("button", { name: /Jump to latest/ });
    if (await jump.isVisible()) await jump.click();
    await page.waitForTimeout(400);
    await page.screenshot({ path: resolve(SHOTS_DIR, "markdown-deep-nesting.png"), fullPage: false });
  });

  test("message timestamps show without hovering by default", async ({ page }) => {
    await mockChatBackend(page, [
      ...PRELUDE,
      assistantText("a-1", "Here's the summary you asked for.", NOW - 120_000),
      assistantText("a-2", "And the follow-up, a couple of minutes later.", NOW),
    ]);
    await page.goto("/");

    const stamps = page.getByLabel(/^Sent /);
    await expect(stamps.first()).toBeVisible({ timeout: 15_000 });
    await page.mouse.move(0, 0);
    const opacity = await stamps.first().evaluate((el) => Number(getComputedStyle(el).opacity));
    expect(opacity).toBeGreaterThan(0);

    await page.waitForTimeout(300);
    await page.screenshot({ path: resolve(SHOTS_DIR, "message-timestamps.png"), fullPage: false });
  });

  test("showMessageTimestamps: false brings back hover-only timestamps", async ({ page }) => {
    await mockChatBackend(
      page,
      [...PRELUDE, assistantText("a-1", "Times appear only on hover now.", NOW)],
      { userSettings: { showMessageTimestamps: false } },
    );
    await page.goto("/");

    const stamp = page.getByLabel(/^Sent /).first();
    await expect(stamp).toBeAttached({ timeout: 15_000 });
    await page.mouse.move(0, 0);
    await expect
      .poll(() => stamp.evaluate((el) => Number(getComputedStyle(el).opacity)), { timeout: 10_000 })
      .toBe(0);
  });

  test("sending while Claude is working announces 'Message queued.' to screen readers", async ({ page }) => {
    const { inputs } = await mockChatBackend(page, [
      ...PRELUDE,
      assistantText("a-1", "Working on it…", NOW),
      { type: "turn_status", status: "running" },
    ]);
    await page.goto("/");

    const announcer = page.getByTestId("chat-live-announcer");
    await expect(announcer).toHaveAttribute("aria-live", "polite");
    await expect(announcer).toHaveText("");

    const composer = page.getByTestId("prompt-input");
    await expect(composer).toBeEnabled({ timeout: 15_000 });
    await composer.click();
    await composer.fill("also update the changelog");
    await composer.press("Enter");

    await expect(announcer).toHaveText("Message queued.", { timeout: 5_000 });
    await expect.poll(() => inputs.length).toBeGreaterThan(0);
  });

  test("the slash-command picker marks the selected row with a ❯ pointer", async ({ page }) => {
    await mockChatBackend(page, [...PRELUDE]);
    await page.goto("/");

    const composer = page.getByTestId("prompt-input");
    await expect(composer).toBeEnabled({ timeout: 15_000 });
    await composer.click();
    await composer.pressSequentially("/co", { delay: 20 });

    const pointer = page.getByTestId("picker-selected-pointer");
    await expect(pointer).toHaveCount(1, { timeout: 10_000 });
    await expect(pointer).toHaveText("❯");
    await expect(pointer).toHaveAttribute("aria-hidden", "true");

    const firstRow = pointer.locator("xpath=ancestor::button[1]");
    const firstRowText = await firstRow.textContent();
    await composer.press("ArrowDown");
    await expect(pointer).toHaveCount(1);
    await expect.poll(() => pointer.locator("xpath=ancestor::button[1]").textContent()).not.toBe(firstRowText);

    await page.waitForTimeout(200);
    await page.screenshot({ path: resolve(SHOTS_DIR, "picker-pointer.png"), fullPage: false });
  });
});
