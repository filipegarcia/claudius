import { test, expect, type Locator, type Page } from "@playwright/test";

/**
 * Covers the "Answer" pill on the AskUserQuestion ToolCall row. Renders the
 * dev preview at /dev/tool-call-preview, which mounts the component matrix
 * (and an AssistantMessage integration block) so we can assert visibility,
 * click behavior, and toolUseId-matching without booting a live agent.
 *
 * Conventions:
 *   - Pill is queried by data-testid="tool-call-answer-pill", SCOPED to its
 *     case wrapper (data-testid="case-body:<id>") so cases don't bleed into
 *     each other.
 *   - The reopen-count counter on the page root lets us assert that the
 *     pill's onClick actually fired, without poking React internals.
 */

const PILL = "tool-call-answer-pill";

function pillIn(scope: Locator) {
  return scope.getByTestId(PILL);
}

async function reopenCount(page: Page): Promise<number> {
  const txt = (await page.getByTestId("reopen-count").innerText()).trim();
  return Number(txt);
}

test.describe("AskUserQuestion Answer pill", () => {
  test.beforeEach(async ({ page }) => {
    await page.goto("/dev/tool-call-preview");
    await expect(page.getByTestId("tool-call-preview-root")).toBeVisible();
  });

  test("renders the pill on the happy-path case (pending + no result + handler)", async ({ page }) => {
    const scope = page.getByTestId("case-body:ask-pending-match");
    await expect(pillIn(scope)).toBeVisible();
    await expect(pillIn(scope)).toHaveText(/Answer/);
  });

  test("does NOT render when isPendingAsk is explicitly false", async ({ page }) => {
    const scope = page.getByTestId("case-body:ask-pending-flag-false");
    await expect(pillIn(scope)).toHaveCount(0);
  });

  test("does NOT render when isPendingAsk prop is missing", async ({ page }) => {
    const scope = page.getByTestId("case-body:ask-no-pending-prop");
    await expect(pillIn(scope)).toHaveCount(0);
  });

  test("does NOT render once a successful result is set (already answered)", async ({ page }) => {
    const scope = page.getByTestId("case-body:ask-resolved-success");
    await expect(pillIn(scope)).toHaveCount(0);
  });

  test("does NOT render when result.isError is true (declined / aborted)", async ({ page }) => {
    const scope = page.getByTestId("case-body:ask-resolved-error");
    await expect(pillIn(scope)).toHaveCount(0);
  });

  test("does NOT render when onReopenAsk is undefined", async ({ page }) => {
    const scope = page.getByTestId("case-body:ask-pending-no-callback");
    await expect(pillIn(scope)).toHaveCount(0);
  });

  test("ToolCall itself does not gate on `name` — non-AskUserQuestion w/ flag still renders the pill", async ({
    page,
  }) => {
    // This is the "AssistantMessage is the gate" contract — ToolCall trusts
    // its caller. The integration tests below confirm AssistantMessage holds
    // up its end of the bargain. Documenting the boundary here keeps a future
    // refactor honest.
    const scope = page.getByTestId("case-body:non-ask-with-pending-flag");
    await expect(pillIn(scope)).toBeVisible();
  });

  test("clicking the pill calls onReopenAsk and does NOT toggle expand", async ({ page }) => {
    const scope = page.getByTestId("case-body:ask-pending-match");
    const before = await reopenCount(page);
    await pillIn(scope).click();
    const after = await reopenCount(page);
    expect(after - before).toBe(1);

    // The expand body is conditionally rendered ("input" label appears only
    // when open). Confirm the row stayed collapsed after the pill click.
    await expect(scope.getByText("input", { exact: true })).toHaveCount(0);
  });

  test("clicking the row (outside the pill) toggles expand normally", async ({ page }) => {
    const scope = page.getByTestId("case-body:ask-pending-match");
    // The first <button> inside the row is the toggle (chevron + name);
    // the pill is the second. Click the toggle by name.
    await scope.getByRole("button", { name: /AskUserQuestion/ }).click();
    await expect(scope.getByText("input", { exact: true })).toBeVisible();
  });

  test("pill is keyboard-activatable (Enter) and counts as a reopen", async ({ page }) => {
    const scope = page.getByTestId("case-body:ask-pending-match");
    const before = await reopenCount(page);
    await pillIn(scope).focus();
    await page.keyboard.press("Enter");
    const after = await reopenCount(page);
    expect(after - before).toBe(1);
  });

  test("pill is keyboard-activatable (Space) and counts as a reopen", async ({ page }) => {
    const scope = page.getByTestId("case-body:ask-pending-match");
    const before = await reopenCount(page);
    await pillIn(scope).focus();
    await page.keyboard.press(" ");
    const after = await reopenCount(page);
    expect(after - before).toBe(1);
  });

  test("rapid double-click counts as two reopens (no debouncing)", async ({ page }) => {
    // The handler is idempotent (`setAskMinimizedFor(null)` is a no-op when
    // already null) but the click itself is not debounced — documenting the
    // contract so a "let's debounce that pill" change can't slip in unnoticed.
    const scope = page.getByTestId("case-body:ask-pending-match");
    const before = await reopenCount(page);
    await pillIn(scope).click();
    await pillIn(scope).click();
    const after = await reopenCount(page);
    expect(after - before).toBe(2);
  });
});

test.describe("AssistantMessage integration — toolUseId match gating", () => {
  test.beforeEach(async ({ page }) => {
    await page.goto("/dev/tool-call-preview");
    await expect(page.getByTestId("tool-call-preview-root")).toBeVisible();
  });

  test("with a matching pendingAskToolUseId, exactly ONE pill appears across the message", async ({
    page,
  }) => {
    const scope = page.getByTestId("case:integration-matching");
    await expect(pillIn(scope)).toHaveCount(1);
  });

  test("the non-matching AskUserQuestion block stays a normal collapsed row", async ({
    page,
  }) => {
    // The matching scope has two ask blocks; only one has a pill. The other
    // is still a button (the toggle), but no pill descendant.
    const scope = page.getByTestId("case:integration-matching");
    const pills = pillIn(scope);
    await expect(pills).toHaveCount(1);
    // Two ask tool buttons total — one with pill, one without.
    const askToggles = scope.getByRole("button", { name: /AskUserQuestion/ });
    await expect(askToggles).toHaveCount(2);
  });

  test("non-AskUserQuestion blocks never get the pill, even when the message has a pending ask", async ({
    page,
  }) => {
    const scope = page.getByTestId("case:integration-matching");
    // Read row exists; pill must not be inside it. We grab the Read button
    // and ensure no pill descendant exists adjacent to it.
    const readToggle = scope.getByRole("button", { name: /Read/ });
    await expect(readToggle).toHaveCount(1);
    // Pill should still be exactly 1 across the whole message — the Read
    // block contributing zero is the assertion here.
    await expect(pillIn(scope)).toHaveCount(1);
  });

  test("with pendingAskToolUseId=null, NO ask block in the message shows a pill", async ({
    page,
  }) => {
    const scope = page.getByTestId("case:integration-no-match");
    await expect(pillIn(scope)).toHaveCount(0);
  });

  test("clicking the integration pill bumps the reopen counter", async ({ page }) => {
    const scope = page.getByTestId("case:integration-matching");
    const before = await reopenCount(page);
    await pillIn(scope).click();
    const after = await reopenCount(page);
    expect(after - before).toBe(1);
  });
});
