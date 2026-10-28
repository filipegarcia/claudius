/**
 * CC 2.1.312 parity — "Fixed agent view restoring input text on the next
 * launch after it was cleared with Ctrl+C just before exiting".
 *
 * Claudius saves the composer draft on the server (`/prompt-draft`). After a
 * reload, the restored draft doesn't count as typed. So clearing it with
 * Ctrl+C (or double-Esc) left an empty composer that the debounced save
 * skipped, the server kept the old draft, and the next launch brought the
 * cleared text back. Now clearing a non-empty composer drops the server draft
 * right away, the way a send does.
 *
 * Behaviour-only fix with no visual change, so no screenshot: the spec checks
 * that the composer is still empty after a reload.
 */

import { test, expect, type Page, type Route } from "../helpers/test";
import { activateClaudiusWorkspace } from "./helpers/workspace";

const FAKE_SESSION_ID = "aaaaaaaa-bbbb-cccc-dddd-00000312cd01";
const DRAFT = "half-written plan for the retry logic";

type SdkEvent = Record<string, unknown>;

const EVENTS: SdkEvent[] = [
  { type: "ready", sessionId: FAKE_SESSION_ID },
  { type: "sdk", message: { type: "system", subtype: "init", uuid: "sys-init-312cd", model: "claude-sonnet-4-6" } },
  { type: "replay_done", hasMoreAbove: false },
  {
    type: "sdk",
    message: {
      type: "assistant",
      uuid: "assistant-cd-1",
      parent_tool_use_id: null,
      message: {
        id: "msg_cd_1",
        model: "claude-sonnet-4-6",
        content: [{ type: "text", text: "Ready when you are." }],
        usage: { input_tokens: 10, output_tokens: 5 },
      },
    },
  },
  {
    type: "sdk",
    message: {
      type: "result",
      uuid: "result-cd-1",
      subtype: "success",
      total_cost_usd: 0.001,
      num_turns: 1,
      duration_ms: 300,
      duration_api_ms: 200,
    },
  },
  // Idle: Ctrl+C clears the composer (mid-turn it interrupts instead).
  { type: "turn_status", status: "idle" },
];

/** A server-side draft row the composer seeds from and writes back to. */
async function mockChatBackend(page: Page): Promise<{ draft: { text: string }; deletes: number[] }> {
  const state = { draft: { text: DRAFT }, deletes: [] as number[] };
  await page.route("**/api/sessions", async (route: Route) => {
    if (route.request().method() !== "POST") return route.fallback();
    return route.fulfill({ json: { id: FAKE_SESSION_ID } });
  });
  await page.route(`**/api/sessions/${FAKE_SESSION_ID}/stream*`, (route: Route) =>
    route.fulfill({
      status: 200,
      headers: { "Content-Type": "text/event-stream", "Cache-Control": "no-cache", Connection: "keep-alive" },
      body: EVENTS.map((e) => `data: ${JSON.stringify(e)}\n\n`).join(""),
    }),
  );
  await page.route(`**/api/sessions/${FAKE_SESSION_ID}/prompt-draft`, (route: Route) => {
    const method = route.request().method();
    if (method === "GET") return route.fulfill({ json: { text: state.draft.text, images: [] } });
    if (method === "DELETE") {
      state.draft.text = "";
      state.deletes.push(Date.now());
      return route.fulfill({ json: { ok: true } });
    }
    const body = route.request().postDataJSON() as { text?: string };
    state.draft.text = body.text ?? "";
    return route.fulfill({ json: { ok: true } });
  });
  await page.route("**/api/sessions/open-tabs", (route: Route) =>
    route.fulfill({ json: { activeId: null, tabs: [] } }),
  );
  await page.route(`**/api/sessions/${FAKE_SESSION_ID}/pending-prompts`, (route: Route) =>
    route.fulfill({ json: { asks: [], permissions: [] } }),
  );
  await page.route("**/api/limits*", (route: Route) =>
    route.fulfill({ json: { limits: { sessionUsd: 0, projectDailyUsd: 0 } } }),
  );
  return state;
}

test.beforeEach(async ({ page }) => {
  await activateClaudiusWorkspace(page);
});

for (const how of ["Ctrl+C", "double Esc"] as const) {
  test(`a restored draft cleared with ${how} stays cleared after a reload`, async ({ page }) => {
    const state = await mockChatBackend(page);
    await page.goto("/");

    const composer = page.getByTestId("prompt-input");
    // The draft is seeded from the server, as after a relaunch.
    await expect(composer).toHaveValue(DRAFT, { timeout: 15_000 });

    await composer.click();
    if (how === "Ctrl+C") {
      await page.keyboard.press("Control+c");
    } else {
      await page.keyboard.press("Escape");
      await page.keyboard.press("Escape");
    }
    await expect(composer).toHaveValue("");
    // The server copy is dropped right away, without waiting for the debounce.
    await expect.poll(() => state.deletes.length).toBeGreaterThan(0);
    expect(state.draft.text).toBe("");

    await page.reload();
    await expect(page.getByText("Ready when you are.")).toBeVisible({ timeout: 15_000 });
    // Give the seed fetch time to land: it must not bring the text back.
    await page.waitForTimeout(800);
    await expect(composer).toHaveValue("");
    expect(state.draft.text).toBe("");
  });
}
