/**
 * Claude Code 2.1.299 parity — "Added /effort and /fast in agent view to set
 * what new sessions start with; a bare /model, /effort or /fast there now
 * opens a picker".
 *
 * Claudius translation: in the chat composer, a bare `/model` used to only
 * toast "Pass a model id", a bare `/effort` only toasted the current level,
 * and `/fast` was forwarded straight to the SDK. Now all three (with no args)
 * dispatch `claudius:open-model-picker` (`lib/client/model-picker-events.ts`),
 * which the right-rail SessionCard claims to open its ModelPicker — the same
 * panel that hosts the model list plus the effort and fast-mode rows. The
 * args forms (`/model <id>`, `/effort <level>`, `/fast on|off`) are unchanged.
 *
 * Screenshot target: docs/cc-parity/2.1.299/bare-model-picker.png
 */

import { mkdirSync } from "node:fs";
import { resolve } from "node:path";
import { test, expect, type Page, type Route } from "../helpers/test";
import { activateClaudiusWorkspace } from "./helpers/workspace";

const SHOTS_DIR = resolve(process.cwd(), "docs/cc-parity/2.1.299");
mkdirSync(SHOTS_DIR, { recursive: true });

const FAKE_SESSION_ID = "aaaaaaaa-bbbb-cccc-dddd-00000299b4e1";

type SdkEvent = Record<string, unknown>;

function sseBody(events: SdkEvent[]): string {
  return events.map((e) => `data: ${JSON.stringify(e)}\n\n`).join("");
}

// The active model (from the init event below) supports effort AND fast mode,
// so the open picker renders both the effort chips and the fast-mode toggle.
const MODELS = [
  {
    value: "claude-sonnet-4-6",
    displayName: "Sonnet 4.6",
    description: "Balanced speed and quality.",
    supportsEffort: true,
    supportedEffortLevels: ["low", "medium", "high"],
    supportsAdaptiveThinking: true,
    supportsFastMode: true,
  },
  {
    value: "claude-haiku-4-5",
    displayName: "Haiku 4.5",
    description: "Fast and cheap.",
  },
];

type Capture = { inputPosts: Array<{ text: string; slash?: boolean }> };

async function mockChatBackend(page: Page, events: SdkEvent[], capture: Capture): Promise<void> {
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

  await page.route(`**/api/sessions/${FAKE_SESSION_ID}/model`, async (route: Route) => {
    if (route.request().method() === "GET") {
      return route.fulfill({
        status: 200,
        contentType: "application/json",
        body: JSON.stringify({ models: MODELS }),
      });
    }
    return route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify({ ok: true }),
    });
  });

  await page.route(`**/api/sessions/${FAKE_SESSION_ID}/advisor`, async (route: Route) => {
    return route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify({ model: null }),
    });
  });

  // Captures anything forwarded to the SDK — a bare `/model` / `/effort` /
  // `/fast` must NOT reach it while the picker can open.
  await page.route(`**/api/sessions/${FAKE_SESSION_ID}/input`, async (route: Route) => {
    if (route.request().method() !== "POST") return route.fallback();
    const body = route.request().postDataJSON() as { text: string; slash?: boolean };
    capture.inputPosts.push({ text: body.text, slash: body.slash });
    return route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify({ ok: true }),
    });
  });
}

const PRELUDE: SdkEvent[] = [
  { type: "ready", sessionId: FAKE_SESSION_ID },
  {
    type: "sdk",
    message: {
      type: "system",
      subtype: "init",
      uuid: "sys-init-299bmp",
      model: "claude-sonnet-4-6",
    },
  },
  { type: "replay_done", hasMoreAbove: false },
];

/**
 * Type a bare slash command and run it with the keyboard: the first Enter
 * accepts the slash-picker's (confident) match, completing the composer to
 * `/<name> `; the second Enter submits it. Waits for the slash picker to have
 * the command highlighted first, so the Enter can't race the picker's keydown
 * listener mounting.
 */
async function runBareCommand(page: Page, name: string): Promise<void> {
  const composer = page.getByTestId("prompt-input");
  await expect(composer).toBeEnabled({ timeout: 15_000 });
  await composer.click();
  await composer.pressSequentially(`/${name}`, { delay: 20 });
  const pointer = page.getByTestId("picker-selected-pointer");
  await expect(pointer).toHaveCount(1, { timeout: 10_000 });
  await expect(pointer.locator("xpath=ancestor::button[1]")).toContainText(`/${name}`);
  await composer.press("Enter");
  await expect(composer).toHaveValue(`/${name} `);
  await composer.press("Enter");
}

test.beforeEach(async ({ page }) => {
  await activateClaudiusWorkspace(page);
});

test("a bare /model or /effort opens the model picker with its effort and fast rows", async ({ page }) => {
  const capture: Capture = { inputPosts: [] };
  await mockChatBackend(page, PRELUDE, capture);
  await page.goto("/");

  // Wait for the SessionCard to hydrate with the active model.
  const trigger = page.getByTestId("model-picker-trigger");
  await expect(trigger).toContainText("Sonnet 4.6", { timeout: 30_000 });
  const panel = page.getByTestId("model-picker-panel");
  await expect(panel).toHaveCount(0);

  // ── bare /model ──────────────────────────────────────────────────────
  await runBareCommand(page, "model");

  await expect(panel).toBeVisible({ timeout: 5_000 });
  await expect(trigger).toHaveAttribute("aria-expanded", "true");
  await expect(panel.getByTestId("model-picker-option")).toHaveCount(MODELS.length);
  // Effort row (the chip count depends on the user's `maxEffortLevel` cap,
  // read from the real settings route, so only assert the row is there).
  await expect(panel.getByTestId("model-picker-effort").first()).toBeVisible();
  // Fast-mode row.
  await expect(panel.getByTestId("model-picker-fast")).toBeVisible();
  // The old dead-end hint is gone, and nothing was forwarded to the SDK.
  await expect(page.getByText("Pass a model id")).toHaveCount(0);
  expect(capture.inputPosts).toEqual([]);

  // Screenshot in context — full chat chrome with the rail's open picker.
  await page.waitForTimeout(200);
  await page.screenshot({ path: resolve(SHOTS_DIR, "bare-model-picker.png"), fullPage: false });

  // Close via the trigger (the picker's outside-click handler ignores its
  // anchor, so this is a clean toggle).
  await trigger.click();
  await expect(panel).toHaveCount(0);

  // ── bare /effort ─────────────────────────────────────────────────────
  await runBareCommand(page, "effort");

  await expect(panel).toBeVisible({ timeout: 5_000 });
  await expect(panel.getByTestId("model-picker-effort").first()).toBeVisible();
  await expect(panel.getByTestId("model-picker-fast")).toBeVisible();
  // No "Effort: …" toast — the picker replaced it.
  await expect(page.getByTestId("chat-toast")).toHaveCount(0);
  expect(capture.inputPosts).toEqual([]);
});

test("a bare /fast opens the picker; /fast on is still forwarded to the SDK", async ({ page }) => {
  const capture: Capture = { inputPosts: [] };
  await mockChatBackend(page, PRELUDE, capture);
  await page.goto("/");

  const trigger = page.getByTestId("model-picker-trigger");
  await expect(trigger).toContainText("Sonnet 4.6", { timeout: 30_000 });
  const panel = page.getByTestId("model-picker-panel");

  await runBareCommand(page, "fast");
  await expect(panel).toBeVisible({ timeout: 5_000 });
  await expect(panel.getByTestId("model-picker-fast")).toBeVisible();
  expect(capture.inputPosts).toEqual([]);

  await trigger.click();
  await expect(panel).toHaveCount(0);

  const composer = page.getByTestId("prompt-input");
  await composer.fill("/fast on");
  await page.getByTestId("prompt-send").click();
  await expect.poll(() => capture.inputPosts.length, { timeout: 5_000 }).toBeGreaterThan(0);
  expect(capture.inputPosts.at(-1)?.text).toBe("/fast on");
  await expect(panel).toHaveCount(0);
});
