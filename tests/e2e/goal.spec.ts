import { test, expect, type Page } from "../helpers/test";

const SESSION_RE = /[?&]session=([0-9a-f-]{36})/i;

async function waitForBoundSession(page: Page): Promise<string> {
  await page.waitForURL((url) => SESSION_RE.test(String(url)), { timeout: 30_000 });
  const id = page.url().match(SESSION_RE)?.[1];
  expect(id).toMatch(/^[0-9a-f-]{36}$/i);
  return id!;
}

/**
 * End-to-end coverage for the `/goal` feature: setting a goal via the composer
 * surfaces the GoalBanner, an agent-reported achievement (simulated via the
 * dev-broadcast endpoint, so we never hit the live SDK) flips the banner into
 * its celebratory state, the goal survives a reload (DB persistence +
 * subscribe re-emit), and clearing hides the banner.
 *
 * The achievement broadcast mirrors what `Session.markGoalAchieved` emits when
 * the in-process `report_goal_achieved` SDK tool fires.
 */
test.describe("Session goal", () => {
  test("set via /goal, show achievement, persist across reload, and clear", async ({
    page,
    request,
    baseURL,
  }) => {
    const goalText = `Ship the goal feature ${Date.now().toString(36)}`;

    // ── 1. Bind a real session ───────────────────────────────────────────
    await page.goto("/");
    const sessionId = await waitForBoundSession(page);

    // ── 2. Set the goal through the composer (`/goal <text>`) ─────────────
    const composer = page.getByTestId("prompt-input");
    await expect(composer).toBeVisible({ timeout: 30_000 });
    await composer.click();
    await composer.fill(`/goal ${goalText}`);
    await page.getByTestId("prompt-send").click();

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
});
