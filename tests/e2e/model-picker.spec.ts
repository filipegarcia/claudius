import { test, expect, type Page, type Route } from "@playwright/test";

/**
 * E2E coverage for the right-rail Model picker.
 *
 * What the picker is supposed to do:
 *   - Click the model row in the Session card → popover opens, anchored
 *     below the trigger.
 *   - The popover fetches `/api/sessions/<id>/model` and renders one row
 *     per `ModelInfo` returned by the SDK. The currently-active model is
 *     marked with a check.
 *   - When the focused model `supportsEffort`, an effort row appears with
 *     one chip per `supportedEffortLevels` value, plus an "Auto" chip if
 *     `supportsAdaptiveThinking` is not explicitly false.
 *   - Clicking a model fires POST `/api/sessions/<id>/model` with the
 *     value. Clicking an effort chip fires POST `/api/sessions/<id>/effort`
 *     with `{ level }` and closes the picker. (An earlier version routed
 *     effort through the input/slash-command pipeline as `/effort <level>`,
 *     but the SDK doesn't register that command — see the dedicated
 *     `effort/route.ts` for the rationale.)
 *   - The GET endpoint returning HTTP 503 with an `{error}` body shows a
 *     friendly "Couldn't load models" state instead of a generic crash.
 *     This is the regression we shipped after the HMR-stale `Session`
 *     prototype bug (see `model-picker-route.test.ts`).
 *
 * All endpoints are mocked — we never hit the real SDK. The chat backend
 * helper here is the same pattern `cost-tile.spec.ts` established.
 */

const FAKE_SESSION_ID = "00000000-1111-2222-3333-444444444444";

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

type ModelEndpointBehavior =
  | { kind: "ok"; models: ModelInfo[] }
  | { kind: "error"; status: number; error: string };

type MockScript = {
  events: SdkEvent[];
  modelGet: ModelEndpointBehavior;
  /**
   * Capture POSTs to `/api/sessions/<id>/model` (model change),
   * `/api/sessions/<id>/effort` (effort change), and
   * `/api/sessions/<id>/input` (regular chat sends). Tests assert against
   * this after acting on the picker.
   */
  capture: {
    modelPosts: Array<{ model: string | null }>;
    effortPosts: Array<{ level: string }>;
    inputPosts: Array<{ text: string; slash?: boolean }>;
  };
};

const PRELUDE: SdkEvent[] = [
  { type: "ready", sessionId: FAKE_SESSION_ID },
  {
    type: "sdk",
    message: {
      type: "system",
      subtype: "init",
      uuid: "sys-1",
      model: "claude-sonnet-4-6",
    },
  },
  { type: "replay_done", hasMoreAbove: false },
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

  // The picker calls GET, the model-change action calls POST. Same URL,
  // different methods.
  await page.route(`**/api/sessions/${FAKE_SESSION_ID}/model`, async (route: Route) => {
    const method = route.request().method();
    if (method === "GET") {
      if (script.modelGet.kind === "ok") {
        return route.fulfill({
          status: 200,
          contentType: "application/json",
          body: JSON.stringify({ models: script.modelGet.models }),
        });
      }
      return route.fulfill({
        status: script.modelGet.status,
        contentType: "application/json",
        body: JSON.stringify({ error: script.modelGet.error }),
      });
    }
    if (method === "POST") {
      const body = route.request().postDataJSON() as { model?: string | null };
      script.capture.modelPosts.push({ model: body?.model ?? null });
      return route.fulfill({
        status: 200,
        contentType: "application/json",
        body: JSON.stringify({ ok: true, model: body?.model }),
      });
    }
    return route.fallback();
  });

  // Effort changes have their own dedicated route — they used to ride the
  // /input slash pipeline, but the SDK doesn't expose `/effort` as a
  // command, so the server now calls `applyFlagSettings` directly. See
  // `app/api/sessions/[id]/effort/route.ts`.
  await page.route(`**/api/sessions/${FAKE_SESSION_ID}/effort`, async (route: Route) => {
    if (route.request().method() !== "POST") return route.fallback();
    const body = route.request().postDataJSON() as { level?: string };
    script.capture.effortPosts.push({ level: body?.level ?? "" });
    return route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify({ ok: true, level: body?.level }),
    });
  });

  await page.route(`**/api/sessions/${FAKE_SESSION_ID}/input`, async (route: Route) => {
    if (route.request().method() !== "POST") return route.fallback();
    const body = route.request().postDataJSON() as { text: string; slash?: boolean };
    script.capture.inputPosts.push({ text: body.text, slash: body.slash });
    return route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify({ ok: true }),
    });
  });
}

const MODELS: ModelInfo[] = [
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

test.describe("model picker", () => {
  test("opens, lists every advertised model, marks the active one", async ({ page }) => {
    const script: MockScript = {
      events: PRELUDE,
      modelGet: { kind: "ok", models: MODELS },
      capture: { modelPosts: [], effortPosts: [], inputPosts: [] },
    };
    await mockChatBackend(page, script);

    await page.goto("/");

    // Wait for the rail to mount and the trigger to be enabled (it only
    // renders as a button when `onChangeModel` is wired through).
    const trigger = page.getByTestId("model-picker-trigger");
    await expect(trigger).toBeVisible({ timeout: 15_000 });
    await expect(trigger).toHaveAttribute("aria-expanded", "false");

    // Open.
    await trigger.click();
    await expect(trigger).toHaveAttribute("aria-expanded", "true");
    const panel = page.getByTestId("model-picker-panel");
    await expect(panel).toBeVisible();

    // One option per advertised model.
    const options = panel.getByTestId("model-picker-option");
    await expect(options).toHaveCount(MODELS.length);

    // Each option carries its model value as a data attribute and shows
    // the display name.
    for (const m of MODELS) {
      const opt = panel.locator(`[data-model="${m.value}"]`);
      await expect(opt).toBeVisible();
      await expect(opt).toContainText(m.displayName);
    }

    // Active model (claude-sonnet-4-6 from the init event) is marked
    // selected. ARIA carries the truth for screen readers.
    const active = panel.locator('[data-model="claude-sonnet-4-6"]');
    await expect(active).toHaveAttribute("aria-selected", "true");
    const inactive = panel.locator('[data-model="claude-opus-4-7"]');
    await expect(inactive).toHaveAttribute("aria-selected", "false");
  });

  test("clicking a model POSTs the new value", async ({ page }) => {
    const script: MockScript = {
      events: PRELUDE,
      modelGet: { kind: "ok", models: MODELS },
      capture: { modelPosts: [], effortPosts: [], inputPosts: [] },
    };
    await mockChatBackend(page, script);

    await page.goto("/");
    await page.getByTestId("model-picker-trigger").click();
    const panel = page.getByTestId("model-picker-panel");
    await expect(panel).toBeVisible();

    await panel.locator('[data-model="claude-opus-4-7"]').click();

    // Wait until the POST is observed. `expect.poll` lets us avoid a
    // brittle fixed-delay sleep.
    await expect
      .poll(() => script.capture.modelPosts.length, { timeout: 5_000 })
      .toBeGreaterThan(0);
    expect(script.capture.modelPosts.at(-1)?.model).toBe("claude-opus-4-7");
  });

  test("effort row tracks the currently active model, not the hovered one", async ({
    page,
  }) => {
    // Regression guard: an earlier cut tied the effort row to the
    // *hovered* model so moving the mouse between model rows reshaped
    // the chips constantly. That made it impossible to click any chip
    // when the path from a supports-effort model down to the chip
    // crossed a model row that didn't support effort — the row
    // disappeared mid-mouse-travel.
    //
    // The fixed behavior: the effort row reflects the active model. The
    // initial Sonnet from the PRELUDE doesn't support effort, so the row
    // is hidden. Switching to Opus (which does) makes it appear. Hovering
    // other rows doesn't touch the row at all.
    const script: MockScript = {
      events: PRELUDE,
      modelGet: { kind: "ok", models: MODELS },
      capture: { modelPosts: [], effortPosts: [], inputPosts: [] },
    };
    await mockChatBackend(page, script);

    await page.goto("/");
    await page.getByTestId("model-picker-trigger").click();
    const panel = page.getByTestId("model-picker-panel");
    await expect(panel).toBeVisible();

    // Active model is Sonnet → no effort chips.
    await expect(panel.getByTestId("model-picker-effort")).toHaveCount(0);

    // Hovering Opus must NOT show the effort row — only selection does.
    await panel.locator('[data-model="claude-opus-4-7"]').hover();
    await expect(panel.getByTestId("model-picker-effort")).toHaveCount(0);

    // Select Opus. The picker stays open, `setModel` updates `currentModel`
    // optimistically, and the effort row appears with one chip per
    // `supportedEffortLevels` value plus an Auto chip for adaptive
    // thinking.
    await panel.locator('[data-model="claude-opus-4-7"]').click();
    const chips = panel.getByTestId("model-picker-effort");
    await expect(chips).toHaveCount(5);
    await expect(panel.locator('[data-effort="adaptive"]')).toBeVisible();
    await expect(panel.locator('[data-effort="low"]')).toBeVisible();
    await expect(panel.locator('[data-effort="xhigh"]')).toBeVisible();

    // Hovering a row that DOESN'T support effort must NOT collapse the
    // chips — this is the bug the user hit reaching for the chips with
    // the mouse.
    await panel.locator('[data-model="claude-haiku-4-5"]').hover();
    await expect(panel.getByTestId("model-picker-effort")).toHaveCount(5);
  });

  test("clicking an effort chip POSTs to `/api/sessions/<id>/effort` and closes the picker", async ({
    page,
  }) => {
    const script: MockScript = {
      events: PRELUDE,
      modelGet: { kind: "ok", models: MODELS },
      capture: { modelPosts: [], effortPosts: [], inputPosts: [] },
    };
    await mockChatBackend(page, script);

    await page.goto("/");
    await page.getByTestId("model-picker-trigger").click();
    const panel = page.getByTestId("model-picker-panel");
    await expect(panel).toBeVisible();

    // Switch to Opus so the effort row appears (PRELUDE seeds Sonnet,
    // which doesn't support effort in our MODELS fixture). Then pick
    // High and verify the dedicated effort route is hit.
    await panel.locator('[data-model="claude-opus-4-7"]').click();
    await expect(panel.locator('[data-effort="high"]')).toBeVisible();
    await panel.locator('[data-effort="high"]').click();

    // POSTed through the dedicated `/effort` route — NOT the input/slash
    // pipeline (the SDK doesn't expose `/effort` as a slash command).
    await expect
      .poll(() => script.capture.effortPosts.length, { timeout: 5_000 })
      .toBeGreaterThan(0);
    const last = script.capture.effortPosts.at(-1)!;
    expect(last.level).toBe("high");
    // The slash pipeline must NOT be touched for effort changes.
    expect(script.capture.inputPosts).toHaveLength(0);

    // Picking an effort closes the picker — confirms the
    // onPickEffort → setPickerOpen(false) wiring.
    await expect(panel).toBeHidden();
  });

  test("HTTP 503 from the GET endpoint renders a friendly error, not a crash", async ({
    page,
  }) => {
    // This is the regression coverage for the HMR-stale-prototype bug
    // (`session.supportedModels is not a function`). The route now
    // returns 503 with an `{error}` body; the picker surfaces the
    // message instead of dying.
    const script: MockScript = {
      events: PRELUDE,
      modelGet: { kind: "error", status: 503, error: "session not active" },
      capture: { modelPosts: [], effortPosts: [], inputPosts: [] },
    };
    await mockChatBackend(page, script);

    await page.goto("/");
    await page.getByTestId("model-picker-trigger").click();
    const panel = page.getByTestId("model-picker-panel");
    await expect(panel).toBeVisible();
    // Match the "load models" portion only — the apostrophe-shape is
    // encoded as `&apos;` in JSX (straight quote), and we don't want the
    // test to break if someone normalizes copy to a curly quote later.
    await expect(panel).toContainText(/load models/i);
    // The underlying SDK error is surfaced so the user (and we, in
    // triage) can see why the picker is empty.
    await expect(panel).toContainText("session not active");

    // No model options rendered when the GET failed.
    await expect(panel.getByTestId("model-picker-option")).toHaveCount(0);
  });

  test("Escape closes the picker", async ({ page }) => {
    const script: MockScript = {
      events: PRELUDE,
      modelGet: { kind: "ok", models: MODELS },
      capture: { modelPosts: [], effortPosts: [], inputPosts: [] },
    };
    await mockChatBackend(page, script);

    await page.goto("/");
    const trigger = page.getByTestId("model-picker-trigger");
    await trigger.click();
    const panel = page.getByTestId("model-picker-panel");
    await expect(panel).toBeVisible();

    await page.keyboard.press("Escape");
    await expect(panel).toBeHidden();
    await expect(trigger).toHaveAttribute("aria-expanded", "false");
  });
});
