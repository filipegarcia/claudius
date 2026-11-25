/**
 * CC 2.1.328 parity — "Changed plan mode and Bash prompts for Opus 4.6 and
 * Sonnet 4.6 on third-party providers to use and offer auto mode, as on
 * newer models; `disableAutoMode` turns both off".
 *
 * Claudius's plan approval overlay only had "Accept & execute", which always
 * switched to acceptEdits, so no model ever got the CLI's "Yes, and use auto
 * mode". The overlay now offers "Accept & use auto mode" first, which posts
 * `{ kind: "accept", mode: "auto" }`, and hides it when the user's
 * `disableAutoMode` is set. (The Bash half was already there: the permission
 * card's auto-mode tip.) The server side, including the fallback to
 * acceptEdits on a model that can't run auto, is unit-tested in
 * tests/unit/cc-parity-2.1.328-plan-accept-auto.test.ts.
 *
 * Screenshot target: docs/cc-parity/2.1.328/plan-accept-auto.png
 */

import { mkdirSync } from "node:fs";
import { resolve } from "node:path";
import { test, expect, type Page, type Route } from "../helpers/test";
import { activateClaudiusWorkspace } from "./helpers/workspace";
import { initEvent, mockChatBackend, type SdkEvent } from "./helpers/mock-chat";

const SCREENSHOT_DIR = resolve(process.cwd(), "docs/cc-parity/2.1.328");
mkdirSync(SCREENSHOT_DIR, { recursive: true });

const FAKE_SESSION_ID = "aaaaaaaa-bbbb-cccc-dddd-000002328b06";

// The init event carries a cwd so the client's `disableAutoMode` lookup
// (`useDisableAutoMode`, keyed on the session cwd) runs.
const INIT = initEvent("sys-328-plan") as { type: string; message: Record<string, unknown> };
const EVENTS: SdkEvent[] = [
  { type: "ready", sessionId: FAKE_SESSION_ID },
  { ...INIT, message: { ...INIT.message, cwd: "/tmp/claudius-e2e-328-plan" } },
  { type: "replay_done", hasMoreAbove: false },
  {
    type: "plan_approval_request",
    requestId: "req-328-plan",
    toolUseId: "toolu_328_plan",
    plan: [
      "## Plan: add rate limiting to the export endpoint",
      "",
      "1. Add a token bucket in `lib/server/rate-limit.ts`.",
      "2. Wrap `app/api/export/route.ts` with it (10 requests a minute).",
      "3. Return 429 with a `Retry-After` header when the bucket is empty.",
    ].join("\n"),
  },
];

/** Answer the user-scope settings read behind `useDisableAutoMode`. */
async function mockUserSettings(page: Page, settings: Record<string, unknown>) {
  await page.route(
    (url) => url.pathname === "/api/settings" && url.searchParams.get("scope") === "user",
    async (route: Route) => {
      if (route.request().method() !== "GET") return route.fallback();
      return route.fulfill({ status: 200, json: { settings } });
    },
  );
}

async function capturePlanDecisions(page: Page): Promise<unknown[]> {
  const posted: unknown[] = [];
  await page.route(`**/api/sessions/${FAKE_SESSION_ID}/plan`, async (route: Route) => {
    posted.push(route.request().postDataJSON());
    return route.fulfill({ status: 200, json: { ok: true } });
  });
  return posted;
}

test.beforeEach(async ({ page }) => {
  await activateClaudiusWorkspace(page);
  await mockChatBackend(page, FAKE_SESSION_ID, EVENTS);
  // With a session cwd, ChatSurface reads `overrides` off the limits state;
  // the shared mock's limits body has none, so answer with the full shape.
  await page.route("**/api/limits*", (route: Route) =>
    route.fulfill({ status: 200, json: { limits: { sessionUsd: 0, projectDailyUsd: 0 }, overrides: {} } }),
  );
});

test("plan approval offers Accept & use auto mode first, and it accepts in auto", async ({ page }) => {
  await mockUserSettings(page, {});
  const posted = await capturePlanDecisions(page);
  await page.goto("/");

  const auto = page.getByTestId("plan-accept-auto");
  await expect(auto).toBeVisible({ timeout: 15_000 });
  await expect(auto).toHaveText(/Accept & use auto mode/);
  const [autoBox, plainBox] = await Promise.all([auto.boundingBox(), page.getByTestId("plan-accept").boundingBox()]);
  expect(autoBox!.x).toBeLessThan(plainBox!.x);

  await page.screenshot({ path: resolve(SCREENSHOT_DIR, "plan-accept-auto.png") });

  await auto.click();
  await expect.poll(() => posted.length).toBe(1);
  expect(posted[0]).toEqual({ requestId: "req-328-plan", decision: { kind: "accept", mode: "auto" } });
});

test("with disableAutoMode set there is no auto option", async ({ page }) => {
  await mockUserSettings(page, { disableAutoMode: "disable" });
  const posted = await capturePlanDecisions(page);
  await page.goto("/");

  const plain = page.getByTestId("plan-accept");
  await expect(plain).toBeVisible({ timeout: 15_000 });
  await expect(page.getByTestId("plan-accept-auto")).toHaveCount(0);

  await plain.click();
  await expect.poll(() => posted.length).toBe(1);
  expect(posted[0]).toEqual({ requestId: "req-328-plan", decision: { kind: "accept" } });
});
