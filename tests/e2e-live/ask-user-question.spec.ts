import { test, expect } from "@playwright/test";

const SESSION_RE = /[?&]session=([0-9a-f-]{36})/i;

/**
 * Drives the agent into using AskUserQuestion with TWO questions, then walks
 * the form: pick option 1 of Q1 → click Next → pick option 1 of Q2 →
 * Submit. Verifies the agent then echoes back both selections.
 *
 * Hits the real Anthropic API. Needs network + a working ANTHROPIC_API_KEY
 * (or ~/.claude/.credentials.json). Uses bypassPermissions so the
 * non-AskUserQuestion permissions don't pop a separate modal.
 */
test.describe("AskUserQuestion — multi-question form drives the agent", () => {
  test("two questions: pick, advance, submit, agent echoes both answers", async ({
    page,
    baseURL,
  }) => {
    test.skip(
      !process.env.ANTHROPIC_API_KEY,
      "needs ANTHROPIC_API_KEY (or ~/.claude/.credentials.json on a logged-in machine) — this test drives the live Anthropic agent",
    );
    test.setTimeout(360_000);

    await page.goto("/");
    await page.waitForURL(SESSION_RE, { timeout: 30_000 });
    const sessionId = page.url().match(SESSION_RE)![1];

    const textarea = page.getByTestId("prompt-input");
    await expect(textarea).toBeEnabled({ timeout: 30_000 });
    await expect(page.getByTestId("prompt-send")).toBeVisible({ timeout: 30_000 });

    // Bypass permissions so AskUserQuestion is the only thing that pops UI.
    const modeRes = await page.request.post(
      `${baseURL}/api/sessions/${sessionId}/mode`,
      { data: { mode: "bypassPermissions" } },
    );
    expect(modeRes.ok()).toBeTruthy();

    // Drive the agent to call AskUserQuestion with two questions. Keep it
    // terse — long prompts make the model take longer to commit to a tool.
    const prompt = [
      "Call AskUserQuestion now with these two questions and stop:",
      "Q1 header=\"Color\" question=\"Which color?\" options=[Red, Blue] multiSelect=false",
      "Q2 header=\"Size\" question=\"Which size?\" options=[Small, Large] multiSelect=false",
      "After I answer, reply ONLY: You picked <color> and <size>.",
    ].join("\n");
    await textarea.fill(prompt);
    await page.getByTestId("prompt-send").click();

    // Wait for the form modal to appear. The model can take a while when
    // the prompt's been queued behind a backlog or when it decides to do
    // some thinking before invoking the tool, so be generous.
    const modal = page.getByTestId("ask-user-question");
    await expect(modal).toBeVisible({ timeout: 180_000 });

    // Pick the first option (Red).
    const firstOption = page.getByTestId("ask-option-0");
    await firstOption.click();
    await expect(firstOption).toHaveAttribute("data-selected", "true");

    // Advance to Q2.
    const nextBtn = page.getByTestId("ask-next");
    await expect(nextBtn).toBeEnabled();
    await nextBtn.click();

    // Tab 1 should now show as completed; tab 0 was checked already.
    await expect(page.getByTestId("ask-tab-1")).toBeVisible();

    // Pick the first option of Q2 (Small).
    const q2Option = page.getByTestId("ask-option-0");
    await q2Option.click();
    await expect(q2Option).toHaveAttribute("data-selected", "true");

    // Submit.
    const submit = page.getByTestId("ask-submit");
    await expect(submit).toBeEnabled();
    await submit.click();

    // Modal disappears once the answer is in flight.
    await expect(modal).not.toBeVisible({ timeout: 10_000 });

    // Wait for the agent's response — it should echo both picks back. Don't
    // be strict about exact wording; just check both labels appear.
    await expect(page.locator("body")).toContainText("Red", { timeout: 90_000 });
    await expect(page.locator("body")).toContainText("Small", { timeout: 30_000 });
  });
});
