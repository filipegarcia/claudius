/**
 * CC 2.1.326 parity — three fixes to Claudius's own slash commands
 * (`ChatSurface.tsx` `handleSend` / `runNative`):
 *
 *  - "Fixed `/clear --help` and other built-in commands running at an idle
 *    prompt instead of showing usage; added `/help <command>`". `--help` on a
 *    Claudius command now opens the Help overlay on a usage card for it, and
 *    `/help <command>` does the same.
 *  - "Fixed `/goal clear` … not sticking". Claudius had no `clear`
 *    subcommand, so `/goal clear` set the goal to "clear" and sent the word to
 *    Claude.
 *  - "Fixed `/copy` … saying 'copied to clipboard' when … nothing" was copied.
 *
 * Screenshot target: docs/cc-parity/2.1.326/slash-help.png
 */

import { mkdirSync } from "node:fs";
import { resolve } from "node:path";
import { test, expect, type Page, type Route } from "../helpers/test";
import { activateClaudiusWorkspace } from "./helpers/workspace";

const SHOTS_DIR = resolve(process.cwd(), "docs/cc-parity/2.1.326");
mkdirSync(SHOTS_DIR, { recursive: true });

const FAKE_SESSION_ID = "aaaaaaaa-bbbb-cccc-dddd-000002326a01";

type SdkEvent = Record<string, unknown>;

const PRELUDE: SdkEvent[] = [
  { type: "ready", sessionId: FAKE_SESSION_ID },
  { type: "sdk", message: { type: "system", subtype: "init", uuid: "sys-init-326h", model: "claude-sonnet-4-6" } },
  { type: "replay_done", hasMoreAbove: false },
];

/** A finished turn whose reply is a tool call only, with no text. */
const TOOL_ONLY_TURN: SdkEvent[] = [
  {
    type: "sdk",
    at: 1_774_000_000_000,
    message: {
      type: "user",
      uuid: "user-326h-1",
      parent_tool_use_id: null,
      isSynthetic: false,
      message: { role: "user", content: [{ type: "text", text: "List the files." }] },
    },
  },
  {
    type: "sdk",
    at: 1_774_000_001_000,
    message: {
      type: "assistant",
      uuid: "assistant-326h-1",
      parent_tool_use_id: null,
      message: {
        id: "msg_326h_1",
        model: "claude-sonnet-4-6",
        content: [{ type: "tool_use", id: "toolu_326h_1", name: "Bash", input: { command: "ls" } }],
        usage: { input_tokens: 20, output_tokens: 10 },
      },
    },
  },
  {
    type: "sdk",
    message: {
      type: "result",
      uuid: "result-326h-1",
      subtype: "success",
      total_cost_usd: 0.01,
      num_turns: 1,
      duration_ms: 300,
      duration_api_ms: 200,
    },
  },
];

type Counters = { sessionPosts: number; goalPosts: number; inputs: number };

async function mockChatBackend(page: Page, events: SdkEvent[]): Promise<Counters> {
  const counters: Counters = { sessionPosts: 0, goalPosts: 0, inputs: 0 };
  await page.route("**/api/sessions", async (route: Route) => {
    if (route.request().method() !== "POST") return route.fallback();
    counters.sessionPosts += 1;
    return route.fulfill({ json: { id: FAKE_SESSION_ID } });
  });
  await page.route(`**/api/sessions/${FAKE_SESSION_ID}/stream*`, async (route: Route) =>
    route.fulfill({
      status: 200,
      headers: { "Content-Type": "text/event-stream", "Cache-Control": "no-cache", Connection: "keep-alive" },
      body: events.map((e) => `data: ${JSON.stringify(e)}\n\n`).join(""),
    }),
  );
  await page.route("**/api/sessions/open-tabs", (route: Route) => route.fulfill({ json: { activeId: null, tabs: [] } }));
  await page.route(`**/api/sessions/${FAKE_SESSION_ID}/pending-prompts`, (route: Route) =>
    route.fulfill({ json: { asks: [], permissions: [] } }),
  );
  await page.route("**/api/limits*", (route: Route) =>
    route.fulfill({ json: { limits: { sessionUsd: 0, projectDailyUsd: 0 } } }),
  );
  await page.route(`**/api/sessions/${FAKE_SESSION_ID}/goal`, (route: Route) => {
    if (route.request().method() === "POST") counters.goalPosts += 1;
    return route.fulfill({ json: { ok: true } });
  });
  await page.route(`**/api/sessions/${FAKE_SESSION_ID}/input`, (route: Route) => {
    counters.inputs += 1;
    return route.fulfill({ json: { ok: true } });
  });
  return counters;
}

async function openComposer(page: Page) {
  await page.goto("/");
  const composer = page.getByTestId("prompt-input");
  await expect(composer).toBeVisible({ timeout: 15_000 });
  await expect(composer).toBeEnabled({ timeout: 15_000 });
  return composer;
}

test.beforeEach(async ({ page }) => {
  await activateClaudiusWorkspace(page);
});

test.describe("CC 2.1.326 — slash command usage, /goal clear and /copy", () => {
  test("/clear --help shows usage instead of clearing the session", async ({ page }) => {
    const counters = await mockChatBackend(page, PRELUDE);
    const composer = await openComposer(page);
    const postsBefore = counters.sessionPosts;

    await composer.fill("/clear --help");
    await page.getByTestId("prompt-send").click();

    const usage = page.getByTestId("help-usage");
    await expect(usage).toBeVisible({ timeout: 5_000 });
    await expect(page.getByTestId("help-usage-line")).toHaveText("/clear");
    await expect(usage).toContainText("Start a fresh session");
    await expect(usage).toContainText("Also: /reset, /new");
    // The session wasn't cleared: no new session was created, no toast.
    await page.waitForTimeout(300);
    expect(counters.sessionPosts).toBe(postsBefore);
    await expect(page.getByTestId("chat-toast")).toHaveCount(0);

    await page.waitForTimeout(150);
    await page.screenshot({ path: resolve(SHOTS_DIR, "slash-help.png"), fullPage: false });
  });

  test("/help <command> opens on that command's usage", async ({ page }) => {
    await mockChatBackend(page, PRELUDE);
    const composer = await openComposer(page);

    await composer.fill("/help /goal");
    await page.getByTestId("prompt-send").click();
    await expect(page.getByTestId("help-usage-line")).toHaveText("/goal [goal text]");
    await page.keyboard.press("Escape");
    await expect(page.getByTestId("help-usage")).toHaveCount(0);

    await composer.fill("/help nosuchcommand");
    await page.getByTestId("prompt-send").click();
    await expect(page.getByTestId("help-usage-missing")).toContainText("No command named /nosuchcommand");
  });

  test("/goal clear with no goal says so and sends nothing to Claude", async ({ page }) => {
    const counters = await mockChatBackend(page, PRELUDE);
    const composer = await openComposer(page);

    await composer.fill("/goal clear");
    await page.getByTestId("prompt-send").click();
    await expect(page.getByTestId("chat-toast")).toContainText("No goal to clear");
    await page.waitForTimeout(300);
    expect(counters.goalPosts).toBe(0);
    expect(counters.inputs).toBe(0);
  });

  test("/copy on a reply with no text doesn't claim a copy", async ({ page }) => {
    await mockChatBackend(page, [...PRELUDE, ...TOOL_ONLY_TURN]);
    const composer = await openComposer(page);
    await expect(page.getByText("List the files.")).toBeVisible({ timeout: 15_000 });

    await composer.fill("/copy");
    await page.getByTestId("prompt-send").click();
    const toast = page.getByTestId("chat-toast");
    await expect(toast).toContainText("The last response has no text to copy");
    await expect(toast).not.toContainText("Copied");
  });
});
