import { test, expect, type Page, type Route } from "../helpers/test";

/**
 * E2E coverage for the "Advisor (experimental)" section inside the
 * right-rail SessionCard's model picker, plus the closed-card pill that
 * mirrors the active advisor.
 *
 * What the surface is supposed to do:
 *   - The picker fetches `/api/sessions/<id>/advisor` (GET) when the
 *     session binds, so the radio shows the value persisted in
 *     `~/.claude/settings.json` even if the user never opens the picker.
 *   - Inside the picker the verbatim Claude Code copy renders: the
 *     "(experimental)" header, the explanatory paragraph, the recommended
 *     setup line, and the learn-more link.
 *   - Three fixed options render in order: Opus 4.8 (marked recommended) /
 *     Sonnet 4.6 / No advisor. List is product-blessed, not derived from
 *     `supportedModels`.
 *   - Clicking an option POSTs `{ model: <value> | null }` to
 *     `/api/sessions/<id>/advisor`, which persists to settings.json AND
 *     calls `applyFlagSettings` mid-session. The picker stays open so the
 *     user can keep tweaking (matches the model-list behavior).
 *   - The SessionCard's closed-state "advisor: opus / sonnet" pill mirrors
 *     the selection — absent when `null` (No advisor), present otherwise.
 *
 * All endpoints are mocked. Modeled on `model-picker.spec.ts`.
 */

const FAKE_SESSION_ID = "aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee";

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
  /** Models advertised through GET /api/sessions/<id>/model. */
  models: ModelInfo[];
  /**
   * What GET /api/sessions/<id>/advisor returns — the value the SessionCard
   * primes its mirror with. `null` simulates "no advisor configured".
   */
  initialAdvisor: string | null;
  capture: {
    advisorPosts: Array<{ model: string | null }>;
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

/**
 * PRELUDE variant where the SDK's init message lists `"advisor"` in its
 * tools array — the strong "advisor is on" signal we use as a fallback
 * when GET /advisor comes back null. Used in the test that proves the
 * badge still renders even when the server-side persistence/fetch path
 * is broken (stale dev-server, profile-dir divergence, etc).
 */
const PRELUDE_WITH_ADVISOR_TOOL: SdkEvent[] = [
  { type: "ready", sessionId: FAKE_SESSION_ID },
  {
    type: "sdk",
    message: {
      type: "system",
      subtype: "init",
      uuid: "sys-1",
      model: "claude-sonnet-4-6",
      tools: ["Read", "Edit", "Bash", "advisor"],
    },
  },
  { type: "replay_done", hasMoreAbove: false },
];

const MODELS: ModelInfo[] = [
  {
    value: "claude-sonnet-4-6",
    displayName: "Sonnet 4.6",
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

  // The advisor endpoint. GET primes the picker state on session bind;
  // POST captures user picks for the test to assert against.
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

test.describe("advisor picker", () => {
  test("renders the verbatim Claude Code copy and the three options", async ({ page }) => {
    const script: MockScript = {
      events: PRELUDE,
      models: MODELS,
      initialAdvisor: null,
      capture: { advisorPosts: [] },
    };
    await mockChatBackend(page, script);

    await page.goto("/");

    // Wait for the SessionCard's model name to commit before driving the
    // picker — anchoring on the *content* of the trigger (rather than
    // just its presence) is the only signal that React has hydrated
    // the click handler. The trigger element exists in the DOM the
    // moment the rail mounts, but clicking it before the model state
    // settles makes the click race the `onClick` attachment and the
    // panel never opens (this is the same race that makes 4/6 tests
    // in `model-picker.spec.ts` flake on cold boot).
    const trigger = page.getByTestId("model-picker-trigger");
    await expect(trigger).toContainText("sonnet-4-6", { timeout: 30_000 });
    await trigger.click();

    const panel = page.getByTestId("model-picker-panel");
    await expect(panel).toBeVisible({ timeout: 10_000 });

    // Verbatim Claude Code copy. Keep these assertions loose against
    // punctuation so a future tweak to the em-dash / smart-quote shape
    // doesn't break the suite — the words are what matter.
    await expect(panel).toContainText(/Advisor.*experimental/i);
    await expect(panel).toContainText(/stronger judgment/i);
    await expect(panel).toContainText(/escalates to the advisor model/i);
    await expect(panel).toContainText(/Recommended setup: Sonnet as the main model/i);

    // Learn-more link points to the documented URL.
    const learnMore = panel.locator('a[href="https://claude.com/blog/the-advisor-strategy"]');
    await expect(learnMore).toBeVisible();

    // Three radio rows, ordered Opus → Sonnet → None.
    const opts = panel.getByTestId("model-picker-advisor");
    await expect(opts).toHaveCount(3);
    await expect(opts.nth(0)).toHaveAttribute("data-advisor", "claude-opus-4-8");
    await expect(opts.nth(1)).toHaveAttribute("data-advisor", "claude-sonnet-5");
    await expect(opts.nth(2)).toHaveAttribute("data-advisor", "none");

    // Only the Opus row carries the "recommended" badge.
    await expect(opts.nth(0)).toContainText(/recommended/i);
    await expect(opts.nth(1)).not.toContainText(/recommended/i);
    await expect(opts.nth(2)).not.toContainText(/recommended/i);
  });

  test("seeds the radio from GET /advisor and updates on click", async ({ page }) => {
    const script: MockScript = {
      events: PRELUDE,
      models: MODELS,
      // Simulate the recommended Sonnet-main / Opus-advisor setup
      // already persisted in settings.json. The picker must reflect
      // it on first open — that's the regression this guards against
      // (badge silently saying "No advisor" even with a configured
      // advisor was the reported bug).
      initialAdvisor: "claude-opus-4-8",
      capture: { advisorPosts: [] },
    };
    await mockChatBackend(page, script);

    await page.goto("/");

    // Anchor on the model-name hydration signal — see test 1 for the
    // race rationale. With `initialAdvisor` non-null we could also wait
    // on the pill, but this keeps the wait condition identical between
    // tests so a future copy change to the pill text doesn't break here.
    const trigger = page.getByTestId("model-picker-trigger");
    await expect(trigger).toContainText("sonnet-4-6", { timeout: 30_000 });
    await trigger.click();
    const panel = page.getByTestId("model-picker-panel");
    await expect(panel).toBeVisible({ timeout: 10_000 });

    const opus = panel.locator('[data-testid="model-picker-advisor"][data-advisor="claude-opus-4-8"]');
    const sonnet = panel.locator(
      '[data-testid="model-picker-advisor"][data-advisor="claude-sonnet-5"]',
    );

    // Wait for the bind-time GET to land and the state to reflect it.
    await expect(opus).toHaveAttribute("data-current", "1");
    await expect(opus).toHaveAttribute("aria-checked", "true");
    await expect(sonnet).toHaveAttribute("aria-checked", "false");

    // Click Sonnet — the POST captures the new value.
    await sonnet.click();
    await expect
      .poll(() => script.capture.advisorPosts.length, { timeout: 5_000 })
      .toBeGreaterThan(0);
    expect(script.capture.advisorPosts.at(-1)?.model).toBe("claude-sonnet-5");

    // Optimistic mirror: Sonnet is now the checked row, picker stays open.
    await expect(sonnet).toHaveAttribute("aria-checked", "true");
    await expect(opus).toHaveAttribute("aria-checked", "false");
    await expect(panel).toBeVisible();
  });

  test("dispatching the /advisor intercept event opens the picker", async ({ page }) => {
    // The `/advisor` slash command isn't an SDK command — the page-level
    // `runNative` handler intercepts it and dispatches the window
    // CustomEvent this test simulates. The SessionCard's listener (added
    // when `pickerEnabled`) opens the picker. We drive the event
    // directly rather than typing `/advisor` because the input pipeline
    // requires SDK fixtures we don't otherwise need for this assertion.
    const script: MockScript = {
      events: PRELUDE,
      models: MODELS,
      initialAdvisor: null,
      capture: { advisorPosts: [] },
    };
    await mockChatBackend(page, script);

    await page.goto("/");

    // Wait for the card to hydrate — same anchor as the other tests.
    const trigger = page.getByTestId("model-picker-trigger");
    await expect(trigger).toContainText("sonnet-4-6", { timeout: 30_000 });

    // Picker is closed initially.
    await expect(page.getByTestId("model-picker-panel")).toHaveCount(0);

    // Dispatch the intercept event. Wrapped in a Promise so we know the
    // dispatch happened on the page before we assert the panel opened.
    await page.evaluate(() => {
      window.dispatchEvent(new CustomEvent("claudius:open-advisor-picker"));
    });

    await expect(page.getByTestId("model-picker-panel")).toBeVisible({ timeout: 5_000 });
    // The Advisor section is rendered in the open picker — proves the
    // intercept lands the user on the right surface.
    await expect(page.getByTestId("model-picker-panel")).toContainText(/Advisor.*experimental/i);
  });

  test('aliases / older ids highlight the right family row (not "No advisor")', async ({
    page,
  }) => {
    // Regression cover for the user-reported screenshot:
    // - Badge correctly read "advisor: opus" (server returned an
    //   opus-family value).
    // - But the picker's radio showed "No advisor" checked, because
    //   the strict `normalizeAdvisorChoice` only matched the exact
    //   `claude-opus-4-8` string.
    // The fix: use family-matching (`advisorFamily`) for the radio
    // highlight so an alias like `"opus"` (or an older full id like
    // `"claude-opus-4-7"`) still checks the Opus row.
    const script: MockScript = {
      events: PRELUDE,
      models: MODELS,
      initialAdvisor: "opus",
      capture: { advisorPosts: [] },
    };
    await mockChatBackend(page, script);

    await page.goto("/");

    const trigger = page.getByTestId("model-picker-trigger");
    await expect(trigger).toContainText("sonnet-4-6", { timeout: 30_000 });
    await trigger.click();

    const panel = page.getByTestId("model-picker-panel");
    await expect(panel).toBeVisible({ timeout: 10_000 });

    const opus = panel.locator(
      '[data-testid="model-picker-advisor"][data-advisor="claude-opus-4-8"]',
    );
    const none = panel.locator(
      '[data-testid="model-picker-advisor"][data-advisor="none"]',
    );

    // Opus row is highlighted (family match), No advisor is NOT.
    await expect(opus).toHaveAttribute("aria-checked", "true");
    await expect(none).toHaveAttribute("aria-checked", "false");
  });

  test("non-family advisor renders a Custom row, never No advisor", async ({ page }) => {
    // A value like `"haiku"` doesn't belong to the opus/sonnet
    // families, but it's still a *configured* advisor — the picker
    // must surface it as Custom rather than silently misrepresenting
    // it as "No advisor".
    const script: MockScript = {
      events: PRELUDE,
      models: MODELS,
      initialAdvisor: "haiku",
      capture: { advisorPosts: [] },
    };
    await mockChatBackend(page, script);

    await page.goto("/");
    const trigger = page.getByTestId("model-picker-trigger");
    await expect(trigger).toContainText("sonnet-4-6", { timeout: 30_000 });
    await trigger.click();
    const panel = page.getByTestId("model-picker-panel");
    await expect(panel).toBeVisible({ timeout: 10_000 });

    // Custom row appears with the raw value.
    const custom = panel.getByTestId("model-picker-advisor-custom");
    await expect(custom).toBeVisible();
    await expect(custom).toContainText("haiku");

    // "No advisor" is NOT checked — the user *has* an advisor on, it
    // just isn't one of our three options.
    const none = panel.locator(
      '[data-testid="model-picker-advisor"][data-advisor="none"]',
    );
    await expect(none).toHaveAttribute("aria-checked", "false");
  });

  test("falls back to init.tools when GET /advisor returns null", async ({ page }) => {
    // Regression cover for the user-reported bug: a session whose
    // `~/.claude/settings.json` had `advisorModel: claude-opus-4-8`
    // showed no badge after the page refresh. The repro: GET /advisor
    // returns null (stale dev-server build that doesn't yet have the
    // settings.json fallback), but the SDK still has the advisor tool
    // registered in init. The badge must render anyway — using the
    // sentinel label "on" — so the user doesn't think the advisor is
    // off when it isn't.
    const script: MockScript = {
      events: PRELUDE_WITH_ADVISOR_TOOL,
      models: MODELS,
      initialAdvisor: null,
      capture: { advisorPosts: [] },
    };
    await mockChatBackend(page, script);

    await page.goto("/");

    const pill = page.getByTestId("session-card-advisor-pill");
    await expect(pill).toBeVisible({ timeout: 15_000 });
    // Sentinel label — we know the advisor is on but not which model
    // (the SDK init message doesn't carry the model id).
    await expect(pill).toContainText(/on/i);
  });

  test('"No advisor" POSTs null and removes the SessionCard pill', async ({ page }) => {
    const script: MockScript = {
      events: PRELUDE,
      models: MODELS,
      initialAdvisor: "claude-opus-4-8",
      capture: { advisorPosts: [] },
    };
    await mockChatBackend(page, script);

    await page.goto("/");

    // The "advisor: opus" pill is visible on the closed card before we
    // open the picker — proves the GET /advisor seeding flows all the
    // way through to the badge, not just the picker's internal state.
    const pill = page.getByTestId("session-card-advisor-pill");
    await expect(pill).toBeVisible({ timeout: 15_000 });
    await expect(pill).toHaveAttribute("data-advisor", "claude-opus-4-8");
    await expect(pill).toContainText(/opus/);

    await page.getByTestId("model-picker-trigger").click();
    const panel = page.getByTestId("model-picker-panel");
    await expect(panel).toBeVisible();

    // Click "No advisor". Body carries an explicit null (the route
    // distinguishes null from undefined — null means "remove the key
    // from settings.json AND clear the flag layer"; undefined would
    // mean the picker forgot to send anything).
    const none = panel.locator(
      '[data-testid="model-picker-advisor"][data-advisor="none"]',
    );
    await none.click();
    await expect
      .poll(() => script.capture.advisorPosts.length, { timeout: 5_000 })
      .toBeGreaterThan(0);
    expect(script.capture.advisorPosts.at(-1)?.model).toBeNull();

    // Optimistic mirror clears the badge from the closed card (the
    // SessionCard pill only renders when an advisor is actually set —
    // its presence is the signal, no explicit "off" state).
    await expect(none).toHaveAttribute("aria-checked", "true");
    await page.keyboard.press("Escape");
    await expect(panel).toBeHidden();
    await expect(page.getByTestId("session-card-advisor-pill")).toHaveCount(0);
  });
});
