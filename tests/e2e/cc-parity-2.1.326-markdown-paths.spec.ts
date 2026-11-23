/**
 * CC 2.1.326 parity — two transcript-rendering fixes:
 *
 *  - "Fixed Windows paths in Claude's responses losing the backslash before
 *    folders like `.claude` or `_build`". CommonMark reads `\.` and `\_` as
 *    escapes, so `C:\Users\me\.claude` showed as `C:\Users\me.claude`
 *    (`lib/shared/lone-backslash.ts`).
 *  - "Fixed asterisks disappearing from your own prompts in the transcript,
 *    such as `src/**` + `/*.ts` or `2*3*4`". User prompts are markdown, so
 *    `2*3*4` showed as 2<em>3</em>4 (`lib/shared/user-asterisks.ts`).
 *
 * Screenshot target: docs/cc-parity/2.1.326/markdown-paths.png
 */

import { mkdirSync } from "node:fs";
import { resolve } from "node:path";
import { test, expect, type Page, type Route } from "../helpers/test";
import { activateClaudiusWorkspace } from "./helpers/workspace";

const SHOTS_DIR = resolve(process.cwd(), "docs/cc-parity/2.1.326");
mkdirSync(SHOTS_DIR, { recursive: true });

const FAKE_SESSION_ID = "aaaaaaaa-bbbb-cccc-dddd-000002326b01";

const PROMPT = "Is 2*3*4 right? Then lint src/**/*.ts and lib/**/*.ts — **only** those.";

const REPLY = [
  "Yes, it is 24. On Windows the files are here:",
  "",
  "- Settings: C:\\Users\\me\\.claude\\settings.json",
  "- Build output: D:\\repo\\_build\\out",
  "",
  "Escaped emphasis still works: snake\\_case\\_name.",
].join("\n");

type SdkEvent = Record<string, unknown>;

const EVENTS: SdkEvent[] = [
  { type: "ready", sessionId: FAKE_SESSION_ID },
  { type: "sdk", message: { type: "system", subtype: "init", uuid: "sys-init-326b", model: "claude-sonnet-4-6" } },
  { type: "replay_done", hasMoreAbove: false },
  {
    type: "sdk",
    at: 1_774_000_000_000,
    message: {
      type: "user",
      uuid: "user-326b-1",
      parent_tool_use_id: null,
      isSynthetic: false,
      message: { role: "user", content: [{ type: "text", text: PROMPT }] },
    },
  },
  {
    type: "sdk",
    at: 1_774_000_001_000,
    message: {
      type: "assistant",
      uuid: "assistant-326b-1",
      parent_tool_use_id: null,
      message: {
        id: "msg_326b_1",
        model: "claude-sonnet-4-6",
        content: [{ type: "text", text: REPLY }],
        usage: { input_tokens: 40, output_tokens: 60 },
      },
    },
  },
  {
    type: "sdk",
    message: {
      type: "result",
      uuid: "result-326b-1",
      subtype: "success",
      total_cost_usd: 0.01,
      num_turns: 1,
      duration_ms: 500,
      duration_api_ms: 400,
    },
  },
];

async function mockChatBackend(page: Page): Promise<void> {
  await page.route("**/api/sessions", async (route: Route) => {
    if (route.request().method() !== "POST") return route.fallback();
    return route.fulfill({ json: { id: FAKE_SESSION_ID } });
  });
  await page.route(`**/api/sessions/${FAKE_SESSION_ID}/stream*`, async (route: Route) =>
    route.fulfill({
      status: 200,
      headers: { "Content-Type": "text/event-stream", "Cache-Control": "no-cache", Connection: "keep-alive" },
      body: EVENTS.map((e) => `data: ${JSON.stringify(e)}\n\n`).join(""),
    }),
  );
  await page.route("**/api/sessions/open-tabs", (route: Route) => route.fulfill({ json: { activeId: null, tabs: [] } }));
  await page.route(`**/api/sessions/${FAKE_SESSION_ID}/pending-prompts`, (route: Route) =>
    route.fulfill({ json: { asks: [], permissions: [] } }),
  );
  await page.route("**/api/limits*", (route: Route) =>
    route.fulfill({ json: { limits: { sessionUsd: 0, projectDailyUsd: 0 } } }),
  );
}

test.beforeEach(async ({ page }) => {
  await activateClaudiusWorkspace(page);
  await mockChatBackend(page);
});

test("Windows paths keep their backslashes and a prompt keeps its asterisks", async ({ page }) => {
  await page.goto("/");

  const prompt = page.locator('[data-message-role="user"]').first();
  await expect(prompt).toBeVisible({ timeout: 15_000 });
  await expect(prompt).toContainText("Is 2*3*4 right? Then lint src/**/*.ts and lib/**/*.ts");
  // Deliberate bold still renders as bold; the globs don't.
  await expect(prompt.locator("strong")).toHaveText("only");
  await expect(prompt.locator("em")).toHaveCount(0);

  const reply = page.locator('[data-message-role="assistant"]').last();
  await expect(reply).toBeVisible({ timeout: 15_000 });
  const items = reply.locator("li");
  await expect(items).toHaveCount(2);
  await expect(items.nth(0)).toHaveText("Settings: C:\\Users\\me\\.claude\\settings.json");
  await expect(items.nth(1)).toHaveText("Build output: D:\\repo\\_build\\out");
  await expect(reply).toContainText("snake_case_name");
  await expect(reply.locator("em")).toHaveCount(0);

  await page.waitForTimeout(200);
  await page.screenshot({ path: resolve(SHOTS_DIR, "markdown-paths.png"), fullPage: false });
});
