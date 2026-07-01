/**
 * SDK 0.3.197 — "current Sonnet" doc-example rename, claude-sonnet-4-6 →
 * claude-sonnet-5.
 *
 * The SDK bump itself ships no new exports or behaviour (`sdk.mjs` diffs to
 * two doc-string literals plus the version stamp; every other bundled
 * `.d.ts`/`.mjs` file is byte-identical against 0.3.196 — see the run-notes
 * for 0.3.197). The one real delta is model-identity: `sdk.d.ts`'s
 * `Options.model` doc, the prompt-hook / agent-hook `model` field docs, and
 * the `xhigh` effort-tier doc all replaced their `claude-sonnet-4-6` example
 * with `claude-sonnet-5`. Per this migration's rules, a model-identity
 * change like that isn't safe to wave off — Claudius hard-codes the id as
 * the product-blessed "current Sonnet" in the Advisor picker
 * (`lib/shared/advisor.ts`'s `ADVISOR_SONNET_VALUE`), so it was bumped to
 * `claude-sonnet-5` alongside the label ("Sonnet 4.6" → "Sonnet 5").
 *
 * This spec is modeled directly on `advisor-picker.spec.ts` (same mock
 * harness shape) and verifies:
 *   a. The Advisor section's second radio row now carries
 *      `data-advisor="claude-sonnet-5"` and the "Sonnet 5" label.
 *   b. Clicking it POSTs `{ model: "claude-sonnet-5" }` to
 *      `/api/sessions/<id>/advisor` — the value actually written to
 *      settings.json, not just a display-copy change.
 *   c. A screenshot of the open picker (full SessionCard chrome, three
 *      advisor rows, "Sonnet 5" row scrolled into view) for PR review.
 *
 * Screenshot target: docs/sdk-updates/0.3.197/advisor-picker-sonnet-5.png
 */

import { mkdirSync } from "node:fs";
import { resolve } from "node:path";
import { test, expect, type Page, type Route } from "../helpers/test";

const SHOTS_DIR = resolve(process.cwd(), "docs/sdk-updates/0.3.197");
mkdirSync(SHOTS_DIR, { recursive: true });

const FAKE_SESSION_ID = "aaaaaaaa-bbbb-cccc-dddd-000000000197";

type SdkEvent = Record<string, unknown>;

function sseBody(events: SdkEvent[]): string {
  return events.map((e) => `data: ${JSON.stringify(e)}\n\n`).join("");
}

type ModelInfo = {
  value: string;
  displayName: string;
  description: string;
};

type MockScript = {
  events: SdkEvent[];
  models: ModelInfo[];
  initialAdvisor: string | null;
  capture: { advisorPosts: Array<{ model: string | null }> };
};

const PRELUDE: SdkEvent[] = [
  { type: "ready", sessionId: FAKE_SESSION_ID },
  {
    type: "sdk",
    message: {
      type: "system",
      subtype: "init",
      uuid: "sys-1",
      model: "claude-sonnet-5",
    },
  },
  { type: "replay_done", hasMoreAbove: false },
];

const MODELS: ModelInfo[] = [
  {
    value: "claude-sonnet-5",
    displayName: "Sonnet 5",
    description: "Balanced.",
  },
  {
    value: "claude-haiku-4-5",
    displayName: "Haiku 4.5",
    description: "Fast.",
  },
];

async function mockChatBackend(page: Page, script: MockScript): Promise<void> {
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
      body: sseBody(script.events),
    });
  });

  await page.route("**/api/sessions/open-tabs", async (route: Route) => {
    return route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify({ activeId: null, tabs: [] }),
    });
  });

  await page.route(
    `**/api/sessions/${FAKE_SESSION_ID}/pending-prompts`,
    async (route: Route) => {
      return route.fulfill({
        status: 200,
        contentType: "application/json",
        body: JSON.stringify({ asks: [], permissions: [] }),
      });
    },
  );

  await page.route("**/api/limits*", async (route: Route) => {
    return route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify({ limits: { sessionUsd: 0, projectDailyUsd: 0 } }),
    });
  });

  await page.route(`**/api/sessions/${FAKE_SESSION_ID}/model`, async (route: Route) => {
    const method = route.request().method();
    if (method === "GET") {
      return route.fulfill({
        status: 200,
        contentType: "application/json",
        body: JSON.stringify({ models: script.models }),
      });
    }
    return route.fallback();
  });

  await page.route(`**/api/sessions/${FAKE_SESSION_ID}/advisor`, async (route: Route) => {
    const method = route.request().method();
    if (method === "GET") {
      return route.fulfill({
        status: 200,
        contentType: "application/json",
        body: JSON.stringify({ model: script.initialAdvisor }),
      });
    }
    if (method === "POST") {
      const body = route.request().postDataJSON() as { model?: string | null };
      script.capture.advisorPosts.push({ model: body?.model ?? null });
      return route.fulfill({
        status: 200,
        contentType: "application/json",
        body: JSON.stringify({ ok: true, model: body?.model ?? null }),
      });
    }
    return route.fallback();
  });
}

test.describe("SDK 0.3.197 — Sonnet 5 advisor rename", () => {
  test("Advisor picker's Sonnet row is claude-sonnet-5 and POSTs it", async ({ page }) => {
    const script: MockScript = {
      events: PRELUDE,
      models: MODELS,
      initialAdvisor: null,
      capture: { advisorPosts: [] },
    };
    await mockChatBackend(page, script);

    await page.goto("/");

    // Same hydration-race anchor as advisor-picker.spec.ts: wait for the
    // trigger's *content* (not just presence) before clicking it.
    const trigger = page.getByTestId("model-picker-trigger");
    await expect(trigger).toContainText("sonnet-5", { timeout: 30_000 });
    await trigger.click();

    const panel = page.getByTestId("model-picker-panel");
    await expect(panel).toBeVisible({ timeout: 10_000 });

    const opts = panel.getByTestId("model-picker-advisor");
    await expect(opts).toHaveCount(3);
    await expect(opts.nth(0)).toHaveAttribute("data-advisor", "claude-opus-4-8");

    const sonnetRow = opts.nth(1);
    await expect(sonnetRow).toHaveAttribute("data-advisor", "claude-sonnet-5");
    await expect(sonnetRow).toContainText("Sonnet 5");
    await expect(opts.nth(2)).toHaveAttribute("data-advisor", "none");

    // Scroll the row into view and let the panel settle before the shot —
    // captures the full SessionCard chrome (trigger, header, all three
    // rows) around the row under test, not a cropped element.
    await sonnetRow.scrollIntoViewIfNeeded();
    await page.waitForTimeout(200);
    await page.screenshot({
      path: resolve(SHOTS_DIR, "advisor-picker-sonnet-5.png"),
      fullPage: false,
    });

    // Clicking it POSTs the real product-blessed id, not just display copy.
    await sonnetRow.click();
    await expect
      .poll(() => script.capture.advisorPosts.length, { timeout: 5_000 })
      .toBeGreaterThan(0);
    expect(script.capture.advisorPosts.at(-1)?.model).toBe("claude-sonnet-5");
    await expect(sonnetRow).toHaveAttribute("aria-checked", "true");
  });
});
