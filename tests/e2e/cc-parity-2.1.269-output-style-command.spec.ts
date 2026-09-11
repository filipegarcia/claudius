/**
 * CC 2.1.269 — "Added `/output-style [name]` to list and switch output
 * styles, including over Remote Control and in cloud and other headless
 * sessions."
 *
 * Claudius already modeled `outputStyle` as a `ClaudeSettings` field (the
 * Settings page's dropdown, `readSettings`/`writeSettings`), but changing it
 * there only took effect on the *next* session start — nothing forwarded the
 * pick to the already-running SDK query, and nothing let a user discover or
 * switch styles from the chat composer. This spec exercises the new
 * `/output-style` slash command end to end through the chat surface: no
 * args lists the current + available styles via a toast, an argument
 * switches directly and confirms via `PATCH /api/sessions/<id>/output-style`.
 *
 * Screenshot target: docs/cc-parity/2.1.269/output-style-command.png
 */
import { mkdirSync } from "node:fs";
import { resolve } from "node:path";
import { test, expect, type Page, type Route } from "../helpers/test";
import { activateClaudiusWorkspace } from "./helpers/workspace";

const SHOTS_DIR = resolve(process.cwd(), "docs/cc-parity/2.1.269");
mkdirSync(SHOTS_DIR, { recursive: true });

const FAKE_SESSION_ID = "cccccccc-1111-2222-3333-444444444444";

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
  await page.route(`**/api/sessions/${FAKE_SESSION_ID}/output-style`, async (route: Route) => {
    if (route.request().method() === "PATCH") {
      const body = JSON.parse(route.request().postData() ?? "{}") as { outputStyle?: string };
      return route.fulfill({
        status: 200,
        contentType: "application/json",
        body: JSON.stringify({ ok: true, outputStyle: body.outputStyle }),
      });
    }
    return route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify({
        current: "default",
        available: ["default", "explanatory", "concise", "developer"],
        source: "session",
      }),
    });
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

test.describe("/output-style command (CC 2.1.269 parity)", () => {
  test("no args lists the current and available styles via toast", async ({ page }) => {
    await mockChatBackend(page, PRELUDE);
    await page.goto("/");

    const composer = page.getByTestId("prompt-input");
    await expect(composer).toBeVisible({ timeout: 15_000 });

    const listGet = page.waitForRequest(
      (req) => req.url().includes(`/api/sessions/${FAKE_SESSION_ID}/output-style`) && req.method() === "GET",
    );
    await composer.fill("/output-style");
    await page.getByTestId("prompt-send").click();
    await listGet;

    const toast = page.getByTestId("chat-toast");
    await expect(toast).toBeVisible({ timeout: 5_000 });
    await expect(toast).toContainText("Output style: default");
    await expect(toast).toContainText("explanatory, concise, developer");

    // Screenshot in context — chat surface + composer + toast, all visible.
    await page.waitForTimeout(150);
    await page.screenshot({ path: resolve(SHOTS_DIR, "output-style-command.png"), fullPage: false });
  });

  test("'/output-style concise' switches directly and confirms via toast", async ({ page }) => {
    await mockChatBackend(page, PRELUDE);
    await page.goto("/");

    const composer = page.getByTestId("prompt-input");
    await expect(composer).toBeVisible({ timeout: 15_000 });

    const patch = page.waitForRequest(
      (req) => req.url().includes(`/api/sessions/${FAKE_SESSION_ID}/output-style`) && req.method() === "PATCH",
    );
    await composer.fill("/output-style concise");
    await page.getByTestId("prompt-send").click();
    const req = await patch;
    expect(JSON.parse(req.postData() ?? "{}")).toEqual({ outputStyle: "concise" });

    await expect(page.getByTestId("chat-toast")).toContainText("Output style → concise");
  });

  test("reports a failed switch instead of silently dropping it", async ({ page }) => {
    await mockChatBackend(page, PRELUDE);
    await page.route(`**/api/sessions/${FAKE_SESSION_ID}/output-style`, async (route: Route) => {
      if (route.request().method() !== "PATCH") return route.fallback();
      return route.fulfill({
        status: 500,
        contentType: "application/json",
        body: JSON.stringify({ ok: false, error: "disk full" }),
      });
    });
    await page.goto("/");

    const composer = page.getByTestId("prompt-input");
    await expect(composer).toBeVisible({ timeout: 15_000 });
    await composer.fill("/output-style concise");
    await page.getByTestId("prompt-send").click();

    await expect(page.getByTestId("chat-toast")).toContainText("Output style change failed: disk full");
  });
});
