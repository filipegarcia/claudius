/**
 * Claude Code 2.1.232 parity — "Removed the startup tip suggesting you
 * create custom subagents, and the matching nudge in the /powerup tour."
 *
 * Claudius mirrors the CLI's rotating spinner tips in its own catalog
 * (`lib/shared/tips.ts` `DEFAULT_TIPS` — see that file's header comment:
 * "the browser-side analog of the Claude Code CLI spinner tips"). Its
 * `id: "agents"` entry ("Define specialist subagents…") was the direct
 * mirror of the tip upstream just retired, so it's removed here too.
 * Claudius's own `/powerup` opens the Release Notes page (a generic
 * feature-tour surface, not a subagent-specific nudge), so there's no
 * second nudge on this side to remove.
 *
 * This spec drives the chat surface into the "Claude is working…" state
 * (the only place `SpinnerTip` renders) with `Math.random` stubbed to 0 so
 * the rotation deterministically lands on the catalog's first entry,
 * proving the rendered tip comes from the real, now-updated
 * `DEFAULT_TIPS` — not just asserting the array shape in isolation.
 *
 * Screenshot: docs/cc-parity/2.1.233/spinner-tip-agents-removed.png
 */

import { mkdirSync } from "node:fs";
import { resolve } from "node:path";
import { test, expect, type Page, type Route } from "../helpers/test";
import { activateClaudiusWorkspace } from "./helpers/workspace";
import { DEFAULT_TIPS } from "../../lib/shared/tips";

const SHOTS_DIR = resolve(process.cwd(), "docs/cc-parity/2.1.233");
mkdirSync(SHOTS_DIR, { recursive: true });

const FAKE_SESSION_ID = "aaaaaaaa-bbbb-cccc-dddd-000000021233";

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
      headers: {
        "Content-Type": "text/event-stream",
        "Cache-Control": "no-cache",
        Connection: "keep-alive",
      },
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
    return route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify({ asks: [], permissions: [] }),
    });
  });

  await page.route("**/api/limits*", async (route: Route) => {
    return route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify({ limits: { sessionUsd: 0, projectDailyUsd: 0 } }),
    });
  });
}

const PRELUDE: SdkEvent[] = [
  { type: "ready", sessionId: FAKE_SESSION_ID },
  {
    type: "sdk",
    message: {
      type: "system",
      subtype: "init",
      uuid: "sys-init-0",
      model: "claude-sonnet-4-6",
    },
  },
  { type: "replay_done", hasMoreAbove: false },
  // Authoritative "the agent is mid-turn" signal — flips `pending` true so
  // the "Claude is working…" row (and its SpinnerTip) renders.
  { type: "turn_status", status: "running" },
  // A real (non-empty) transcript — MessageList shows the empty-state
  // SplashScreen instead of the turn view whenever `messages.length === 0`.
  {
    type: "sdk",
    message: {
      type: "assistant",
      uuid: "a1",
      parent_tool_use_id: null,
      message: {
        model: "claude-sonnet-4-6",
        content: [{ type: "text", text: "Working on it…" }],
        usage: { input_tokens: 40, output_tokens: 6 },
      },
    },
  },
];

test.beforeEach(async ({ page }) => {
  // Deterministic tip: SpinnerTip's lazy initializer is
  // `Math.floor(Math.random() * list.length)`. Stubbed to 0 → always the
  // catalog's first entry, regardless of DEFAULT_TIPS' length — avoids
  // pinning this test to a specific array index that could shift as the
  // catalog changes for unrelated reasons.
  await page.addInitScript(() => {
    Math.random = () => 0;
  });
  await activateClaudiusWorkspace(page);
});

test.describe("CC 2.1.232 parity — spinner-tip custom-subagent nudge removed", () => {
  test("no longer offers the custom-subagents tip, and the working row renders it in context", async ({
    page,
  }) => {
    // Sanity: this test only proves something if the catalog it's reading
    // from actually had the tip removed.
    expect(DEFAULT_TIPS.find((t) => t.id === "agents")).toBeUndefined();

    await mockChatBackend(page, PRELUDE);
    await page.goto("/");

    const workingRow = page.getByText("Claude is working…");
    await expect(workingRow).toBeVisible({ timeout: 15_000 });

    const tip = page.getByTestId("spinner-tip");
    await expect(tip).toBeVisible();
    // Deterministic (Math.random stubbed to 0) — always DEFAULT_TIPS[0],
    // proving the rendered catalog is the real, updated one.
    await expect(tip).toContainText(DEFAULT_TIPS[0].text);
    await expect(tip).not.toContainText("subagent");
    await expect(page.getByTestId("spinner-tip-command")).not.toHaveText("/agents");

    await tip.scrollIntoViewIfNeeded();
    await page.waitForTimeout(200);
    await page.screenshot({
      path: resolve(SHOTS_DIR, "spinner-tip-agents-removed.png"),
      fullPage: false,
    });
  });
});
