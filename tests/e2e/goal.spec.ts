import { test, expect, type Page } from "../helpers/test";

const SESSION_RE = /[?&]session=([0-9a-f-]{36})/i;

async function waitForBoundSession(page: Page): Promise<string> {
  await page.waitForURL((url) => SESSION_RE.test(String(url)), { timeout: 30_000 });
  const id = page.url().match(SESSION_RE)?.[1];
  expect(id).toMatch(/^[0-9a-f-]{36}$/i);
  return id!;
}

/**
 * End-to-end coverage for the `/goal` feature.
 *
 * The goal STATE machine (set → achieved → persist → clear) is exercised
 * SDK-free: the goal is set via the `/api/sessions/:id/goal` endpoint and the
 * achievement is simulated via the dev-broadcast endpoint, so neither test
 * spins up a live agent turn. The achievement broadcast mirrors what
 * `Session.markGoalAchieved` emits when the in-process `report_goal_achieved`
 * SDK tool fires.
 *
 * The goal INPUT (the header composer) is a separate test: submitting it both
 * sets the goal and starts Claude (it reuses the chat composer, `PromptInput`,
 * for images + @-mentions). We assert the banner reflects the new goal; the
 * agent turn it kicks off is not awaited.
 */
test.describe("Session goal", () => {
  test("goal state: set, show achievement, persist across reload, and clear", async ({
    page,
    request,
    baseURL,
  }) => {
    const goalText = `Ship the goal feature ${Date.now().toString(36)}`;

    // ── 1. Bind a real session ───────────────────────────────────────────
    await page.goto("/");
    const sessionId = await waitForBoundSession(page);
    await expect(page.getByTestId("prompt-input")).toBeVisible({ timeout: 30_000 });

    // ── 2. Set the goal via the API (passive — no agent turn) ─────────────
    // POST from the browser context (where the session is bound + cookies
    // present), mirroring how the app's `setGoal` reaches the endpoint.
    const setResult = await page.evaluate(
      async ({ id, goal }) => {
        const r = await fetch(`/api/sessions/${id}/goal`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ goal }),
        });
        return { status: r.status, body: await r.text() };
      },
      { id: sessionId, goal: goalText },
    );
    expect(setResult, `goal POST: ${JSON.stringify(setResult)}`).toMatchObject({ status: 200 });

    // The banner appears once the server broadcasts `goal_changed`.
    const banner = page.getByTestId("goal-banner");
    await expect(banner).toBeVisible({ timeout: 15_000 });
    await expect(page.getByTestId("goal-banner-text")).toHaveText(goalText);
    await expect(banner).toHaveAttribute("data-achieved", "0");

    // ── 3. Simulate the agent reporting the goal achieved ─────────────────
    const summary = "Built the GoalBanner and wired the SDK tool.";
    const res = await request.post(`${baseURL}/api/sessions/${sessionId}/dev-broadcast`, {
      data: {
        event: {
          type: "goal_changed",
          goal: goalText,
          achieved: true,
          summary,
          setAt: Date.now(),
          achievedAt: Date.now(),
        },
      },
    });
    expect(res.ok()).toBeTruthy();

    await expect(banner).toHaveAttribute("data-achieved", "1", { timeout: 15_000 });
    await expect(banner).toContainText("Goal achieved");
    await expect(page.getByTestId("goal-banner-summary")).toHaveText(summary);

    // ── 4. Reload — the goal persists via the DB + subscribe re-emit. The
    //       achievement was only broadcast (not persisted), so the reloaded
    //       banner shows the goal in its un-achieved state. Assert the same
    //       session resumed so a flake in session resumption surfaces as a
    //       clear id mismatch rather than a confusing "banner missing".
    await page.waitForTimeout(500);
    await page.reload();
    const afterReload = await waitForBoundSession(page);
    expect(afterReload, "reload should resume the same session").toBe(sessionId);
    await expect(page.getByTestId("goal-banner-text")).toHaveText(goalText, {
      timeout: 15_000,
    });

    // ── 5. Clear the goal — the banner disappears ─────────────────────────
    await page.getByTestId("goal-banner-clear").click();
    await expect(banner).toBeHidden({ timeout: 15_000 });
  });

  test("goal input: the header composer sets the goal and starts a turn", async ({ page }) => {
    await page.goto("/");
    await waitForBoundSession(page);
    await expect(page.getByTestId("prompt-input")).toBeVisible({ timeout: 30_000 });

    // A fresh session guarantees no existing goal, so the empty-state
    // "Set a session goal" button is the affordance on screen.
    await page.locator('button[title="New session tab"]').click();
    await waitForBoundSession(page);

    const setButton = page.getByTestId("goal-banner-set");
    await expect(setButton).toBeVisible({ timeout: 15_000 });
    await setButton.click();

    // The header composer (a reused PromptInput, distinct testid prefix)
    // opens; type a goal and submit with Enter. Submitting both records the
    // goal and kicks off Claude — we assert the banner reflects the goal;
    // the agent turn it starts is not awaited.
    const goalText = `Composer goal ${Date.now().toString(36)}`;
    const input = page.getByTestId("goal-prompt-input");
    await expect(input).toBeVisible();
    await input.fill(goalText);
    await input.press("Enter");

    // The prominent banner replaces the editor.
    await expect(page.getByTestId("goal-banner")).toBeVisible({ timeout: 15_000 });
    await expect(page.getByTestId("goal-banner-text")).toHaveText(goalText);

    // The goal text is also sent as a user message, badged "Goal" (optimistic
    // — appears immediately, independent of the agent turn it kicks off).
    await expect(page.getByTestId("user-message-goal-badge")).toBeVisible({ timeout: 15_000 });
  });

  test("goal provenance round-trips through the DB", async ({ page }) => {
    await page.goto("/");
    const sessionId = await waitForBoundSession(page);
    await expect(page.getByTestId("prompt-input")).toBeVisible({ timeout: 30_000 });

    // Send a user message flagged `fromGoal` straight through the input API
    // (from the browser context, where the session is bound). The route
    // records (session_id, uuid) in `goal_messages`; the agent turn it queues
    // is irrelevant to this assertion.
    const uuid = "11111111-2222-4333-8444-555555555555";
    const status = await page.evaluate(
      async ({ id, u }) => {
        const r = await fetch(`/api/sessions/${id}/input`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ text: "make the tests pass", uuid: u, fromGoal: true }),
        });
        return r.status;
      },
      { id: sessionId, u: uuid },
    );
    expect(status).toBe(200);

    // The provenance is now queryable — survives reload via this endpoint.
    const uuids = await page.evaluate(async (id) => {
      const r = await fetch(`/api/sessions/${id}/goal-messages`);
      return (await r.json()) as { uuids?: string[] };
    }, sessionId);
    expect(uuids.uuids ?? []).toContain(uuid);
  });
});
