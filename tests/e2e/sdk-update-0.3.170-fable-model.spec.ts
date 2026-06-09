import { mkdirSync } from "node:fs";
import { resolve } from "node:path";
import { test, expect, type Page, type Route } from "../helpers/test";

/**
 * SDK-update 0.3.170 — Fable model in the model picker.
 *
 * 0.3.170 adds `claude-fable-5` and the `fable` alias to the SDK's model
 * type system. Claudius exposes it via:
 *   1. The sessionless static fallback (`/api/models`), updated in
 *      `app/api/models/route.ts`.
 *   2. Live sessions: `query.supportedModels()` returns it automatically.
 *
 * This spec exercises path (2) — the session-scoped model picker — because
 * that's the highest-fidelity path and matches what the user sees in a live
 * workspace. Endpoints are mocked; we never hit the real SDK.
 *
 * Screenshot target: docs/sdk-updates/0.3.170/fable-model-picker.png
 */

const SHOTS_DIR = resolve(process.cwd(), "docs/sdk-updates/0.3.170");
mkdirSync(SHOTS_DIR, { recursive: true });

const FAKE_SESSION_ID = "00000000-1111-2222-3333-fable0000000";

type SdkEvent = Record<string, unknown>;

function sseBody(events: SdkEvent[]): string {
  return events.map((e) => `data: ${JSON.stringify(e)}\n\n`).join("");
}

type ModelInfo = {
  value: string;
  displayName: string;
  description: string;
  supportsEffort?: boolean;
  supportedEffortLevels?: Array<"low" | "medium" | "high" | "xhigh" | "max">;
  supportsAdaptiveThinking?: boolean;
  supportsFastMode?: boolean;
};

type MockScript = {
  events: SdkEvent[];
  models: ModelInfo[];
};

const PRELUDE: SdkEvent[] = [
  { type: "ready", sessionId: FAKE_SESSION_ID },
  {
    type: "sdk",
    message: {
      type: "system",
      subtype: "init",
      uuid: "sys-fable",
      model: "claude-sonnet-4-6",
    },
  },
  { type: "replay_done", hasMoreAbove: false },
];

/** Models list including the new fable alias added in SDK 0.3.170. */
const MODELS_WITH_FABLE: ModelInfo[] = [
  {
    value: "claude-fable-5",
    displayName: "Fable 5",
    description: "Extended thinking and reasoning.",
    supportsEffort: true,
    supportedEffortLevels: ["low", "medium", "high", "xhigh", "max"],
    supportsAdaptiveThinking: true,
  },
  {
    value: "claude-opus-4-7",
    displayName: "Opus 4.7",
    description: "Deep reasoning model.",
    supportsEffort: true,
    supportedEffortLevels: ["low", "medium", "high", "xhigh"],
    supportsAdaptiveThinking: true,
  },
  {
    value: "claude-sonnet-4-6",
    displayName: "Sonnet 4.6",
    description: "Balanced speed and quality.",
    supportsFastMode: true,
  },
  {
    value: "claude-haiku-4-5",
    displayName: "Haiku 4.5",
    description: "Fast and cheap.",
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

  await page.route(
    `**/api/sessions/${FAKE_SESSION_ID}/stream*`,
    async (route: Route) => {
      return route.fulfill({
        status: 200,
        headers: {
          "Content-Type": "text/event-stream",
          "Cache-Control": "no-cache",
          Connection: "keep-alive",
        },
        body: sseBody(script.events),
      });
    },
  );

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

  await page.route(
    `**/api/sessions/${FAKE_SESSION_ID}/model`,
    async (route: Route) => {
      const method = route.request().method();
      if (method === "GET") {
        return route.fulfill({
          status: 200,
          contentType: "application/json",
          body: JSON.stringify({ models: script.models }),
        });
      }
      if (method === "POST") {
        return route.fulfill({
          status: 200,
          contentType: "application/json",
          body: JSON.stringify({ ok: true }),
        });
      }
      return route.fallback();
    },
  );
}

test.describe("SDK 0.3.170 — fable model in picker", () => {
  test("fable model row appears in the picker and can be selected", async ({
    page,
  }) => {
    const script: MockScript = {
      events: PRELUDE,
      models: MODELS_WITH_FABLE,
    };
    await mockChatBackend(page, script);

    await page.goto("/");

    // Wait for the trigger to mount.
    const trigger = page.getByTestId("model-picker-trigger");
    await expect(trigger).toBeVisible({ timeout: 15_000 });

    // Open the picker.
    await trigger.click();
    const panel = page.getByTestId("model-picker-panel");
    await expect(panel).toBeVisible();

    // All four models are listed.
    const options = panel.getByTestId("model-picker-option");
    await expect(options).toHaveCount(MODELS_WITH_FABLE.length);

    // Fable row is present and shows the right display name.
    const fableRow = panel.locator('[data-model="claude-fable-5"]');
    await expect(fableRow).toBeVisible();
    await expect(fableRow).toContainText("Fable 5");

    // Fable is not the active model (sonnet is the init model).
    await expect(fableRow).toHaveAttribute("aria-selected", "false");

    // Capture the picker panel with surrounding chrome for the PR review.
    await fableRow.scrollIntoViewIfNeeded();
    await page.waitForTimeout(200); // let layout settle
    await page.screenshot({
      path: resolve(SHOTS_DIR, "fable-model-picker.png"),
      fullPage: false,
    });
  });
});
