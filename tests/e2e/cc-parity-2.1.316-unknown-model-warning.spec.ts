/**
 * CC 2.1.316 parity — "Fixed /model <id> not warning when the model isn't
 * recognized by this version and auto-compact will assume a 200K context
 * window".
 *
 * The engine only warns from its own terminal `/model` command. Claudius
 * runs `/model <id>` itself (ChatSurface → `Session.setModel`), so the server
 * now decides (`lib/shared/model-recognition.ts`) and carries the engine's
 * text on the `model_changed` broadcast and the `/model` POST response. The
 * chat-command model notice shows it as an amber second line and stays up
 * until dismissed.
 *
 * Recognition and every gate are unit-tested (including the Session wiring);
 * here the POST answers as the server does for an unknown id so the client
 * half runs against the real app.
 *
 * Screenshot target: docs/cc-parity/2.1.316/unknown-model-warning.png
 */

import { mkdirSync } from "node:fs";
import { resolve } from "node:path";
import { test, expect, type Page, type Route } from "../helpers/test";
import { activateClaudiusWorkspace } from "./helpers/workspace";
import { unknownModelWarningText } from "@/lib/shared/model-recognition";

const SHOTS_DIR = resolve(process.cwd(), "docs/cc-parity/2.1.316");
mkdirSync(SHOTS_DIR, { recursive: true });

const FAKE_SESSION_ID = "aaaaaaaa-bbbb-cccc-dddd-00000316unkm";
const GATEWAY_MODEL = "my-gateway-model";
const WARNING = unknownModelWarningText(GATEWAY_MODEL);

type SdkEvent = Record<string, unknown>;

function sseBody(events: SdkEvent[]): string {
  return events.map((e) => `data: ${JSON.stringify(e)}\n\n`).join("");
}

const MODELS = [
  {
    value: "sonnet",
    resolvedModel: "claude-sonnet-5-5",
    displayName: "Sonnet 5.5",
    description: "Balanced speed and quality.",
  },
];

const PRELUDE: SdkEvent[] = [
  { type: "ready", sessionId: FAKE_SESSION_ID },
  { type: "sdk", message: { type: "system", subtype: "init", uuid: "sys-init-316unk", model: "claude-sonnet-5-5" } },
  { type: "replay_done", hasMoreAbove: false },
];

async function mockChatBackend(page: Page) {
  await page.route("**/api/sessions", async (route: Route) => {
    if (route.request().method() !== "POST") return route.fallback();
    return route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify({ id: FAKE_SESSION_ID }) });
  });
  await page.route(`**/api/sessions/${FAKE_SESSION_ID}/stream*`, async (route: Route) => {
    return route.fulfill({
      status: 200,
      headers: { "Content-Type": "text/event-stream", "Cache-Control": "no-cache", Connection: "keep-alive" },
      body: sseBody(PRELUDE),
    });
  });
  const modelPosts: Array<{ model?: string; source?: string }> = [];
  await page.route(`**/api/sessions/${FAKE_SESSION_ID}/model`, async (route: Route) => {
    if (route.request().method() === "GET") {
      return route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify({ models: MODELS }) });
    }
    // What the server answers for a chat-command switch to an id it can't
    // recognize (`Session.setModel` → `unknownModelWarning`, unit-tested in
    // cc-parity-2.1.316-unknown-model-warning.test.ts).
    const body = route.request().postDataJSON() as { model?: string; source?: string };
    modelPosts.push(body);
    return route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify({
        ok: true,
        model: body.model ?? null,
        ...(body.source === "chat_command" && body.model === GATEWAY_MODEL ? { unrecognizedModelWarning: WARNING } : {}),
      }),
    });
  });
  await page.route(`**/api/sessions/${FAKE_SESSION_ID}/advisor`, async (route: Route) => {
    return route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify({ model: null }) });
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
  return { modelPosts };
}

test.beforeEach(async ({ page }) => {
  await activateClaudiusWorkspace(page);
});

test("/model with an unrecognized id warns that auto-compact assumes a 200k window", async ({ page }) => {
  test.setTimeout(60_000);
  const state = await mockChatBackend(page);
  await page.goto("/");

  const composer = page.getByTestId("prompt-input");
  await expect(composer).toBeEnabled({ timeout: 30_000 });
  await composer.click();
  await composer.fill(`/model ${GATEWAY_MODEL}`);
  await expect(composer).toHaveValue(`/model ${GATEWAY_MODEL}`);
  await page.getByTestId("prompt-send").click();

  await expect.poll(() => state.modelPosts.at(-1)).toMatchObject({ model: GATEWAY_MODEL, source: "chat_command" });

  const notice = page.locator('[data-pane-name="model-chat-command-notice"]');
  await expect(notice).toBeVisible({ timeout: 10_000 });
  await expect(notice).toContainText(`Switched to ${GATEWAY_MODEL}`);
  const warning = notice.getByTestId("model-unrecognized-warning");
  await expect(warning).toBeVisible();
  await expect(warning).toContainText(`doesn't recognize the model "${GATEWAY_MODEL}"`);
  await expect(warning).toContainText("assumes a context window of 200k tokens");

  await page.waitForTimeout(200);
  await page.screenshot({ path: resolve(SHOTS_DIR, "unknown-model-warning.png"), fullPage: false });

  // Unlike the plain switch notice (8s fade), it stays until dismissed.
  await page.waitForTimeout(8_500);
  await expect(warning).toBeVisible();
  await notice.getByRole("button", { name: "Dismiss model switch notice" }).click();
  await expect(notice).toBeHidden();
});
