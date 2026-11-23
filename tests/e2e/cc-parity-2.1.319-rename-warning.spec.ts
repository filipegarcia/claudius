/**
 * CC 2.1.319 parity — "Fixed `/rename` reporting plain success when the new
 * name could not be saved to the session transcript; it now warns that the
 * new name may not last". `/rename <name>` now reads the route's answer: a
 * rename whose transcript write failed shows the engine's warning in the
 * chat toast, and a failed rename says so instead of "Renamed".
 *
 * The rename route is mocked to answer as the server does when the JSONL
 * append fails (unit-tested in cc-parity-2.1.319-rename-warning.test.ts).
 *
 * Screenshot target: docs/cc-parity/2.1.319/rename-warning.png
 */
import { mkdirSync } from "node:fs";
import { resolve } from "node:path";
import { test, expect, type Page, type Route } from "../helpers/test";
import { activateClaudiusWorkspace } from "./helpers/workspace";
import { RENAME_MAY_NOT_LAST_WARNING } from "@/lib/shared/rename-warning";

const SHOTS_DIR = resolve(process.cwd(), "docs/cc-parity/2.1.319");
mkdirSync(SHOTS_DIR, { recursive: true });

const FAKE_SESSION_ID = "aaaaaaaa-bbbb-cccc-dddd-00000319renm";

type SdkEvent = Record<string, unknown>;
const sseBody = (events: SdkEvent[]) => events.map((e) => `data: ${JSON.stringify(e)}\n\n`).join("");

async function mockChatBackend(page: Page, renameAnswer: { status: number; body: unknown }) {
  const renames: unknown[] = [];
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
        { type: "sdk", message: { type: "system", subtype: "init", uuid: "sys-init-0", model: "claude-sonnet-5-5" } },
        { type: "replay_done", hasMoreAbove: false },
      ]),
    }),
  );
  await page.route("**/api/sessions/rename", async (route: Route) => {
    renames.push(route.request().postDataJSON());
    return route.fulfill({ status: renameAnswer.status, contentType: "application/json", body: JSON.stringify(renameAnswer.body) });
  });
  await page.route(`**/api/sessions/${FAKE_SESSION_ID}/pending-prompts`, async (route: Route) =>
    route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify({ asks: [], permissions: [] }) }),
  );
  await page.route("**/api/sessions/open-tabs", async (route: Route) =>
    route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify({ activeId: null, tabs: [] }) }),
  );
  await page.route("**/api/limits*", async (route: Route) =>
    route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify({ limits: { sessionUsd: 0, projectDailyUsd: 0 } }) }),
  );
  return renames;
}

async function rename(page: Page, name: string) {
  const composer = page.getByTestId("prompt-input");
  await expect(composer).toBeEnabled({ timeout: 30_000 });
  await composer.click();
  await composer.fill(`/rename ${name}`);
  await page.getByTestId("prompt-send").click();
}

test.beforeEach(async ({ page }) => {
  await activateClaudiusWorkspace(page);
});

test("/rename whose transcript write failed warns the name may not last", async ({ page }) => {
  test.setTimeout(60_000);
  const renames = await mockChatBackend(page, { status: 200, body: { ok: true, warning: RENAME_MAY_NOT_LAST_WARNING } });
  await page.goto("/");
  await rename(page, "Auth audit");

  await expect.poll(() => renames.at(-1)).toEqual({ sessionId: FAKE_SESSION_ID, title: "Auth audit" });
  const toast = page.getByTestId("chat-toast");
  await expect(toast).toHaveText(
    "Renamed — the new name may not last: the session transcript could not be updated",
  );
  await page.waitForTimeout(150);
  await page.screenshot({ path: resolve(SHOTS_DIR, "rename-warning.png"), fullPage: false });
});

test("/rename that fails says so instead of 'Renamed'", async ({ page }) => {
  test.setTimeout(60_000);
  await mockChatBackend(page, { status: 500, body: { error: "disk I/O error" } });
  await page.goto("/");
  await rename(page, "Auth audit");
  await expect(page.getByTestId("chat-toast")).toHaveText("Rename failed: disk I/O error");
});

test("/rename that lands shows plain 'Renamed'", async ({ page }) => {
  test.setTimeout(60_000);
  await mockChatBackend(page, { status: 200, body: { ok: true } });
  await page.goto("/");
  await rename(page, "Auth audit");
  await expect(page.getByTestId("chat-toast")).toHaveText("Renamed");
});
