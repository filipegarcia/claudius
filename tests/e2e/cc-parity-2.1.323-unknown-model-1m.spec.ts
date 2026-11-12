/**
 * CC 2.1.323 parity — "Changed the context window assumed for a model ID that
 * Claude Code doesn't recognize from 200K to 1M; use /autocompact to compact
 * earlier, or CLAUDE_CODE_DISABLE_1M_CONTEXT=1 to keep 200K".
 *
 * Claudius handles `/model <id>` itself and keeps its own copy of the
 * engine's unknown-model notice (CC 2.1.316), which always said "200k". The
 * server now builds it with the engine's rule (`unknownModelWarning` with the
 * merged process + settings env; unit-tested in
 * cc-parity-2.1.316-unknown-model-warning.test.ts). The model route is
 * mocked to answer with exactly what the server builds for each env.
 *
 * Screenshot target: docs/cc-parity/2.1.323/unknown-model-1m.png
 */
import { mkdirSync } from "node:fs";
import { resolve } from "node:path";
import { test, expect, type Page, type Route } from "../helpers/test";
import { activateClaudiusWorkspace } from "./helpers/workspace";
import { unknownModelWarning } from "@/lib/shared/model-recognition";

const SHOTS_DIR = resolve(process.cwd(), "docs/cc-parity/2.1.323");
mkdirSync(SHOTS_DIR, { recursive: true });

const FAKE_SESSION_ID = "aaaaaaaa-bbbb-cccc-dddd-00000323unkm";
const GATEWAY_MODEL = "acme-gateway/coder-large";

type SdkEvent = Record<string, unknown>;
const sseBody = (events: SdkEvent[]) => events.map((e) => `data: ${JSON.stringify(e)}\n\n`).join("");

async function mockChatBackend(page: Page, env: Record<string, string>) {
  await page.route("**/api/sessions", async (route: Route) => {
    if (route.request().method() !== "POST") return route.fallback();
    return route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify({ id: FAKE_SESSION_ID }) });
  });
  await page.route(`**/api/sessions/${FAKE_SESSION_ID}/stream*`, async (route: Route) =>
    route.fulfill({
      status: 200,
      headers: { "Content-Type": "text/event-stream", "Cache-Control": "no-cache", Connection: "keep-alive" },
      body: sseBody([
        { type: "ready", sessionId: FAKE_SESSION_ID },
        { type: "sdk", message: { type: "system", subtype: "init", uuid: "sys-init-323unk", model: "claude-sonnet-5-5" } },
        { type: "replay_done", hasMoreAbove: false },
      ]),
    }),
  );
  await page.route(`**/api/sessions/${FAKE_SESSION_ID}/model`, async (route: Route) => {
    if (route.request().method() === "GET") {
      return route.fulfill({
        status: 200,
        contentType: "application/json",
        body: JSON.stringify({ models: [{ value: "sonnet", resolvedModel: "claude-sonnet-5-5", displayName: "Sonnet 5.5", description: "" }] }),
      });
    }
    const body = route.request().postDataJSON() as { model?: string; source?: string };
    const warning = body.source === "chat_command" ? unknownModelWarning({ model: body.model, env }) : null;
    return route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify({
        ok: true,
        model: body.model ?? null,
        ...(warning ? { unrecognizedModelWarning: warning, unrecognizedModelWarningId: "warn-323" } : {}),
      }),
    });
  });
  await page.route(`**/api/sessions/${FAKE_SESSION_ID}/advisor`, async (route: Route) =>
    route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify({ model: null }) }),
  );
  await page.route(`**/api/sessions/${FAKE_SESSION_ID}/pending-prompts`, async (route: Route) =>
    route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify({ asks: [], permissions: [] }) }),
  );
  await page.route("**/api/sessions/open-tabs", async (route: Route) =>
    route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify({ activeId: null, tabs: [] }) }),
  );
  await page.route("**/api/limits*", async (route: Route) =>
    route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify({ limits: { sessionUsd: 0, projectDailyUsd: 0 } }) }),
  );
}

async function switchModel(page: Page) {
  const composer = page.getByTestId("prompt-input");
  await expect(composer).toBeEnabled({ timeout: 30_000 });
  await composer.click();
  await composer.fill(`/model ${GATEWAY_MODEL}`);
  await expect(composer).toHaveValue(`/model ${GATEWAY_MODEL}`);
  await page.getByTestId("prompt-send").click();
  const warning = page.locator('[data-pane-name="model-chat-command-notice"]').getByTestId("model-unrecognized-warning");
  await expect(warning).toBeVisible({ timeout: 10_000 });
  return warning;
}

test.beforeEach(async ({ page }) => {
  await activateClaudiusWorkspace(page);
});

test("an unrecognized model id is assumed to have a 1m window", async ({ page }) => {
  test.setTimeout(60_000);
  await mockChatBackend(page, {});
  await page.goto("/");
  const warning = await switchModel(page);
  await expect(warning).toContainText(`doesn't recognize the model "${GATEWAY_MODEL}"`);
  await expect(warning).toContainText("assumes a context window of 1m tokens");
  await expect(warning).not.toContainText("200k");

  await page.waitForTimeout(200);
  await page.screenshot({ path: resolve(SHOTS_DIR, "unknown-model-1m.png"), fullPage: false });
});

test("CLAUDE_CODE_DISABLE_1M_CONTEXT=1 keeps the 200k window", async ({ page }) => {
  test.setTimeout(60_000);
  await mockChatBackend(page, { CLAUDE_CODE_DISABLE_1M_CONTEXT: "1" });
  await page.goto("/");
  const warning = await switchModel(page);
  await expect(warning).toContainText("assumes a context window of 200k tokens");
});
