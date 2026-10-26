/**
 * CC 2.1.311 parity — "Fixed a lone backslash in quotes or brackets, like
 * `"\"` or `(\)`, disappearing from Claude's responses".
 *
 * Claudius's markdown pipeline (remark / CommonMark) read `\"`, `\)` and `\]`
 * as escapes, so a reply saying `Use "\" as the separator` rendered as
 * `Use "" as the separator`. A render-only pre-pass
 * (`lib/shared/lone-backslash.ts`) now keeps the backslash. This spec streams
 * an assistant reply with all three shapes plus a code span and an inline
 * formula, and asserts each renders as written.
 *
 * Screenshot target: docs/cc-parity/2.1.311/lone-backslash.png
 */

import { mkdirSync } from "node:fs";
import { resolve } from "node:path";
import { test, expect, type Page, type Route } from "../helpers/test";
import { activateClaudiusWorkspace } from "./helpers/workspace";

const SHOTS_DIR = resolve(process.cwd(), "docs/cc-parity/2.1.311");
mkdirSync(SHOTS_DIR, { recursive: true });

const FAKE_SESSION_ID = "aaaaaaaa-bbbb-cccc-dddd-00000311lb01";

const REPLY = [
  "Windows paths use a backslash, so split on `\"\\\\\"` in code, or on the separator itself:",
  "",
  '- The separator is "\\" (one backslash).',
  "- In a regex, a literal backslash is written as an escape (\\) before it.",
  "- A character class with just a backslash looks like [\\].",
  "",
  "Inline math still works: \\(n^2\\).",
].join("\n");

type SdkEvent = Record<string, unknown>;

const EVENTS: SdkEvent[] = [
  { type: "ready", sessionId: FAKE_SESSION_ID },
  { type: "sdk", message: { type: "system", subtype: "init", uuid: "sys-init-311lb", model: "claude-sonnet-4-6" } },
  { type: "replay_done", hasMoreAbove: false },
  {
    type: "sdk",
    at: 1_774_000_000_000,
    message: {
      type: "user",
      uuid: "user-lb-1",
      parent_tool_use_id: null,
      isSynthetic: false,
      message: { role: "user", content: [{ type: "text", text: "How do I split a Windows path?" }] },
    },
  },
  {
    type: "sdk",
    at: 1_774_000_001_000,
    message: {
      type: "assistant",
      uuid: "assistant-lb-1",
      parent_tool_use_id: null,
      message: {
        id: "msg_lb_1",
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
      uuid: "result-lb-1",
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
  await page.route("**/api/sessions/open-tabs", (route: Route) =>
    route.fulfill({ json: { activeId: null, tabs: [] } }),
  );
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

test("a lone backslash in quotes or brackets stays visible in Claude's reply", async ({ page }) => {
  await page.goto("/");
  await expect(page.getByText("How do I split a Windows path?")).toBeVisible({ timeout: 15_000 });

  const reply = page.locator('[data-message-role="assistant"]').last();
  await expect(reply).toBeVisible({ timeout: 15_000 });
  const items = reply.locator("li");
  await expect(items).toHaveCount(3);
  await expect(items.nth(0)).toHaveText('The separator is "\\" (one backslash).');
  await expect(items.nth(1)).toHaveText("In a regex, a literal backslash is written as an escape (\\) before it.");
  await expect(items.nth(2)).toHaveText("A character class with just a backslash looks like [\\].");
  // The code span shows exactly what was typed.
  await expect(reply.locator("code").first()).toHaveText('"\\\\"');
  // Inline LaTeX still becomes math.
  await expect(reply.locator(".katex").first()).toBeVisible();

  await page.waitForTimeout(200);
  await page.screenshot({ path: resolve(SHOTS_DIR, "lone-backslash.png"), fullPage: false });
});
