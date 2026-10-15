/**
 * CC 2.1.300 parity — "[VSCode] Fixed changes to VS Code's chat font size
 * settings needing a window reload or being undone by a theme change; diffs
 * and the plan preview now follow them too".
 *
 * Claudius has a chat text-size setting (Settings → Chat size, the
 * `--chat-text` CSS variable on `<html>`). Messages already follow it. The
 * two plan previews hard-coded `text-sm` and stayed at 14px whatever the
 * user picked: the expanded ExitPlanMode row in the transcript
 * (`components/chat/ToolCall.tsx`) and the plan approval overlay
 * (`components/overlays/PlanOverlay.tsx`). Both now use `--chat-text`.
 * Transcript rows render no inline diffs (Edit/Write show their input), and
 * the `/diff` overlay is a monospace code panel that stays fixed-size like
 * the Git page's. A theme change only flips `data-theme`, so it can't undo
 * the inline `--chat-text`. Those halves of the entry have no Claudius
 * surface.
 *
 * Screenshot target: docs/cc-parity/2.1.300/plan-chat-size.png
 */

import { mkdirSync } from "node:fs";
import { resolve } from "node:path";
import { test, expect, type Page, type Route } from "../helpers/test";
import { activateClaudiusWorkspace } from "./helpers/workspace";

const SHOTS_DIR = resolve(process.cwd(), "docs/cc-parity/2.1.300");
mkdirSync(SHOTS_DIR, { recursive: true });

const FAKE_SESSION_ID = "aaaaaaaa-bbbb-cccc-dddd-00000300pl01";
const CHAT_TEXT_PX = 20;
const PLAN = [
  "## Plan: split the settings loader",
  "",
  "1. Move `readSettings` into `lib/server/settings-io.ts`.",
  "2. Keep the old export as a re-export for one release.",
  "3. Add a unit test for an empty settings file.",
].join("\n");

type SdkEvent = Record<string, unknown>;

function sseBody(events: SdkEvent[]): string {
  return events.map((e) => `data: ${JSON.stringify(e)}\n\n`).join("");
}

async function mockChatBackend(page: Page, events: SdkEvent[]): Promise<void> {
  await page.route("**/api/sessions", async (route: Route) => {
    if (route.request().method() !== "POST") return route.fallback();
    return route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify({ id: FAKE_SESSION_ID }) });
  });
  await page.route(`**/api/sessions/${FAKE_SESSION_ID}/stream*`, async (route: Route) => {
    return route.fulfill({
      status: 200,
      headers: { "Content-Type": "text/event-stream", "Cache-Control": "no-cache", Connection: "keep-alive" },
      body: sseBody(events),
    });
  });
  await page.route("**/api/sessions/open-tabs", async (route: Route) => {
    return route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify({ activeId: null, tabs: [] }) });
  });
  await page.route(`**/api/sessions/${FAKE_SESSION_ID}/pending-prompts`, async (route: Route) => {
    return route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify({ asks: [], permissions: [] }) });
  });
  await page.route("**/api/limits*", async (route: Route) => {
    return route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify({ limits: { sessionUsd: 0, projectDailyUsd: 0 } }) });
  });
}

const TRANSCRIPT: SdkEvent[] = [
  { type: "ready", sessionId: FAKE_SESSION_ID },
  { type: "sdk", message: { type: "system", subtype: "init", uuid: "sys-init-300pl", model: "claude-sonnet-4-6" } },
  {
    type: "sdk",
    message: { type: "user", uuid: "u-1", message: { role: "user", content: [{ type: "text", text: "Plan how to split the settings loader." }] } },
  },
  {
    type: "sdk",
    message: {
      type: "assistant",
      uuid: "a-1",
      message: {
        role: "assistant",
        content: [
          { type: "text", text: "Here's the plan." },
          { type: "tool_use", id: "toolu_plan_300", name: "ExitPlanMode", input: { plan: PLAN } },
        ],
      },
    },
  },
  {
    type: "sdk",
    message: {
      type: "user",
      uuid: "u-2",
      message: { role: "user", content: [{ type: "tool_result", tool_use_id: "toolu_plan_300", content: "User approved the plan." }] },
    },
  },
  { type: "replay_done", hasMoreAbove: false },
];

test.beforeEach(async ({ page }) => {
  await activateClaudiusWorkspace(page);
  await page.addInitScript((px) => {
    window.localStorage.setItem("claudius.chatTextPx", String(px));
  }, CHAT_TEXT_PX);
});

test("the transcript's plan preview follows the Chat size setting", async ({ page }) => {
  await mockChatBackend(page, TRANSCRIPT);
  await page.goto("/");

  const row = page.locator('[data-testid="tool-call"][data-tool-name="ExitPlanMode"]');
  await expect(row).toBeVisible({ timeout: 15_000 });
  await row.getByRole("button").first().click();

  const preview = page.getByTestId("tool-call-plan-preview");
  await expect(preview).toBeVisible();
  await expect(preview).toContainText("split the settings loader");
  // Same size as the assistant's prose around it — not the old fixed 14px.
  await expect(preview).toHaveCSS("font-size", `${CHAT_TEXT_PX}px`);

  await preview.scrollIntoViewIfNeeded();
  await page.waitForTimeout(200);
  await page.screenshot({ path: resolve(SHOTS_DIR, "plan-chat-size.png"), fullPage: false });
});

test("the plan approval overlay follows the Chat size setting", async ({ page }) => {
  await mockChatBackend(page, [
    ...TRANSCRIPT.slice(0, -2),
    { type: "replay_done", hasMoreAbove: false },
    {
      type: "plan_approval_request",
      requestId: "req-plan-300",
      toolUseId: "toolu_plan_300",
      plan: PLAN,
    },
  ]);
  await page.goto("/");

  const preview = page.getByTestId("plan-overlay-preview");
  await expect(preview).toBeVisible({ timeout: 15_000 });
  await expect(preview).toContainText("Keep the old export");
  await expect(preview).toHaveCSS("font-size", `${CHAT_TEXT_PX}px`);
});
