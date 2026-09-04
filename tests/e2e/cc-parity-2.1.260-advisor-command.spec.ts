/**
 * CC 2.1.260 — "Added a text form of `/advisor` (`/advisor`, `/advisor
 * <model>`, `/advisor off`) for the desktop app, Remote Control, and other
 * headless (`-p`/Agent SDK) sessions."
 *
 * Claudius already had the full Advisor model/settings/API/UI stack
 * (`lib/shared/advisor.ts`, `app/api/sessions/[id]/advisor/route.ts`,
 * `ModelPicker.tsx`) plus a native `/advisor` command — but typing it only
 * ever opened the picker, with no way to set (or clear) the advisor
 * directly from the chat composer. This spec exercises the new argument
 * parsing (`resolveAdvisorCommandArg` in `lib/shared/advisor.ts`) end to
 * end through the chat surface.
 *
 * Screenshot target: docs/cc-parity/2.1.260/advisor-command.png
 */
import { mkdirSync } from "node:fs";
import { resolve } from "node:path";
import { test, expect, type Page, type Route } from "../helpers/test";
import { activateClaudiusWorkspace } from "./helpers/workspace";

const SHOTS_DIR = resolve(process.cwd(), "docs/cc-parity/2.1.260");
mkdirSync(SHOTS_DIR, { recursive: true });

const FAKE_SESSION_ID = "bbbbbbbb-1111-2222-3333-444444444444";

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
  await page.route(`**/api/sessions/${FAKE_SESSION_ID}/advisor`, async (route: Route) => {
    if (route.request().method() === "POST") {
      const body = JSON.parse(route.request().postData() ?? "{}") as { model?: string | null };
      return route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify({ ok: true, model: body.model ?? null }) });
    }
    return route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify({ model: null }) });
  });
}

const PRELUDE: SdkEvent[] = [
  { type: "ready", sessionId: FAKE_SESSION_ID },
  { type: "sdk", message: { type: "system", subtype: "init", uuid: "sys-init-0", model: "claude-sonnet-4-6" } },
  { type: "replay_done", hasMoreAbove: false },
];

test.beforeEach(async ({ page }) => {
  await activateClaudiusWorkspace(page);
});

test.describe("Text form of /advisor (CC 2.1.260 parity)", () => {
  test("'/advisor <model>' sets the advisor directly and confirms via toast", async ({ page }) => {
    await mockChatBackend(page, PRELUDE);
    await page.goto("/");

    const composer = page.getByTestId("prompt-input");
    await expect(composer).toBeVisible({ timeout: 15_000 });

    const advisorPost = page.waitForRequest(
      (req) => req.url().includes(`/api/sessions/${FAKE_SESSION_ID}/advisor`) && req.method() === "POST",
    );
    await composer.fill("/advisor opus");
    await page.getByTestId("prompt-send").click();
    const req = await advisorPost;
    expect(JSON.parse(req.postData() ?? "{}")).toEqual({ model: "claude-opus-4-8" });

    const toast = page.getByTestId("chat-toast");
    await expect(toast).toBeVisible({ timeout: 5_000 });
    await expect(toast).toContainText("Advisor → opus");

    // Screenshot in context — chat surface + composer + toast, all visible.
    await page.waitForTimeout(150);
    await page.screenshot({ path: resolve(SHOTS_DIR, "advisor-command.png"), fullPage: false });
  });

  test("'/advisor off' clears the advisor", async ({ page }) => {
    await mockChatBackend(page, PRELUDE);
    await page.goto("/");

    const composer = page.getByTestId("prompt-input");
    await expect(composer).toBeVisible({ timeout: 15_000 });

    const advisorPost = page.waitForRequest(
      (req) => req.url().includes(`/api/sessions/${FAKE_SESSION_ID}/advisor`) && req.method() === "POST",
    );
    await composer.fill("/advisor off");
    await page.getByTestId("prompt-send").click();
    const req = await advisorPost;
    expect(JSON.parse(req.postData() ?? "{}")).toEqual({ model: null });

    await expect(page.getByTestId("chat-toast")).toContainText("Advisor off");
  });

  test("an unrecognized model name is reported, not silently dropped", async ({ page }) => {
    await mockChatBackend(page, PRELUDE);
    await page.goto("/");

    const composer = page.getByTestId("prompt-input");
    await expect(composer).toBeVisible({ timeout: 15_000 });
    await composer.fill("/advisor banana");
    await page.getByTestId("prompt-send").click();

    await expect(page.getByTestId("chat-toast")).toContainText("Unknown advisor model: banana");
  });

  test("'/advisor' with no args still opens the picker (pre-2.1.260 behavior preserved)", async ({ page }) => {
    await mockChatBackend(page, PRELUDE);
    await page.goto("/");

    const composer = page.getByTestId("prompt-input");
    await expect(composer).toBeVisible({ timeout: 15_000 });
    await composer.fill("/advisor");
    await page.getByTestId("prompt-send").click();

    await expect(page.getByTestId("model-picker-advisor").first()).toBeVisible({ timeout: 5_000 });
  });
});
