import { test, expect, type Locator, type Page } from "../helpers/test";

/**
 * Covers the "Answer" / "Reopen" pill on the AskUserQuestion ToolCall row.
 * Renders the dev preview at /dev/tool-call-preview, which mounts the
 * component matrix (and an AssistantMessage integration block) so we can
 * assert visibility, click behavior, and toolUseId-matching without booting
 * a live agent.
 *
 * Pill visibility rule (after the resurrection refactor):
 *   - Row must be `name === "AskUserQuestion"`.
 *   - `onReopenAsk` handler must be wired.
 *   - Everything else (result present / errored / `liveAsk=false`) still
 *     gets a pill, because the user can resurrect a historic ask as a
 *     follow-up message.
 *
 * The `data-live-ask` attribute on the pill records the visual variant:
 *   - "true"  → pulsing "Answer" pill (SDK actively waiting).
 *   - "false" → static "Reopen" pill (historic / errored ask).
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

test.describe("AskUserQuestion pill", () => {
  test.beforeEach(async ({ page }) => {
    await page.goto("/dev/tool-call-preview");
    await expect(page.getByTestId("tool-call-preview-root")).toBeVisible();
  });

  test("renders live (pulsing) Answer pill on the matching row", async ({ page }) => {
    const scope = page.getByTestId("case-body:ask-live-match");
    await expect(pillIn(scope)).toBeVisible();
    await expect(pillIn(scope)).toHaveText(/Answer/);
    await expect(pillIn(scope)).toHaveAttribute("data-live-ask", "true");
  });

  test("renders historic (static) Reopen pill when liveAsk is false", async ({ page }) => {
    const scope = page.getByTestId("case-body:ask-historic-no-result");
    await expect(pillIn(scope)).toBeVisible();
    await expect(pillIn(scope)).toHaveText(/Reopen/);
    await expect(pillIn(scope)).toHaveAttribute("data-live-ask", "false");
  });

  test("defaults to historic variant when liveAsk prop is missing", async ({ page }) => {
    const scope = page.getByTestId("case-body:ask-no-liveask-prop");
    await expect(pillIn(scope)).toBeVisible();
    await expect(pillIn(scope)).toHaveText(/Reopen/);
  });

  test("still renders when a successful result is set", async ({ page }) => {
    // Historic asks remain resurrectable — the click goes through as a
    // follow-up user message, not a phantom SDK answer.
    const scope = page.getByTestId("case-body:ask-resolved-success");
    await expect(pillIn(scope)).toBeVisible();
  });

  test("still renders when result.isError is true (declined / aborted)", async ({ page }) => {
    // This is the case the user actually hit in production — the permission
    // stream closed, the SDK got a deny tool_result, and the row needs to
    // remain clickable so the user can recover the question.
    const scope = page.getByTestId("case-body:ask-resolved-error");
    await expect(pillIn(scope)).toBeVisible();
    await expect(pillIn(scope)).toHaveText(/Reopen/);
  });

  test("does NOT render when onReopenAsk is undefined", async ({ page }) => {
    const scope = page.getByTestId("case-body:ask-no-callback");
    await expect(pillIn(scope)).toHaveCount(0);
  });

  test("ToolCall refuses the pill on a non-AskUserQuestion row even if liveAsk is set", async ({
    page,
  }) => {
    // This is the "ToolCall is its own gate" contract — even if a future
    // refactor accidentally sets `liveAsk` on a non-ask row, ToolCall checks
    // `name === "AskUserQuestion"` itself.
    const scope = page.getByTestId("case-body:non-ask-with-liveask-flag");
    await expect(pillIn(scope)).toHaveCount(0);
  });

  test("clicking the pill calls onReopenAsk and does NOT toggle expand", async ({ page }) => {
    const scope = page.getByTestId("case-body:ask-live-match");
    const before = await reopenCount(page);
    await pillIn(scope).click();
    const after = await reopenCount(page);
    expect(after - before).toBe(1);

    // The expand body is conditionally rendered ("input" label appears only
    // when open). Confirm the row stayed collapsed after the pill click.
    await expect(scope.getByText("input", { exact: true })).toHaveCount(0);
  });

  test("clicking the row (outside the pill) toggles expand normally", async ({ page }) => {
    const scope = page.getByTestId("case-body:ask-live-match");
    // The first <button> inside the row is the toggle (chevron + name);
    // the pill is the second. Click the toggle by name.
    await scope.getByRole("button", { name: /AskUserQuestion/ }).click();
    await expect(scope.getByText("input", { exact: true })).toBeVisible();
  });

  test("pill is keyboard-activatable (Enter) and counts as a reopen", async ({ page }) => {
    const scope = page.getByTestId("case-body:ask-live-match");
    const before = await reopenCount(page);
    await pillIn(scope).focus();
    await page.keyboard.press("Enter");
    const after = await reopenCount(page);
    expect(after - before).toBe(1);
  });

  test("pill is keyboard-activatable (Space) and counts as a reopen", async ({ page }) => {
    const scope = page.getByTestId("case-body:ask-live-match");
    const before = await reopenCount(page);
    await pillIn(scope).focus();
    await page.keyboard.press(" ");
    const after = await reopenCount(page);
    expect(after - before).toBe(1);
  });

  test("rapid double-click counts as two reopens (no debouncing)", async ({ page }) => {
    // The handler may be idempotent for live asks (`setAskMinimizedFor(null)`
    // is a no-op when already null) but the click itself is not debounced —
    // documenting the contract so a "let's debounce that pill" change can't
    // slip in unnoticed. Historic asks would re-resurrect the modal on each
    // click, but the page-level state setter is also idempotent.
    const scope = page.getByTestId("case-body:ask-live-match");
    const before = await reopenCount(page);
    await pillIn(scope).click();
    await pillIn(scope).click();
    const after = await reopenCount(page);
    expect(after - before).toBe(2);
  });
});

test.describe("AssistantMessage integration — pill variant per row", () => {
  test.beforeEach(async ({ page }) => {
    await page.goto("/dev/tool-call-preview");
    await expect(page.getByTestId("tool-call-preview-root")).toBeVisible();
  });

  test("the live (matching) ask row is suppressed; the non-matching one shows the historic pill", async ({
    page,
  }) => {
    const scope = page.getByTestId("case:integration-matching");
    // The live ask (matching pendingAskToolUseId) is no longer a standalone
    // row here — MessageList renders it as the merged inline form (tool-call
    // header + question in one card). So NO live pill appears through
    // AssistantMessage; only the non-matching ask keeps its historic Reopen
    // pill (and returns for the live one too, once it's answered).
    const livePill = scope.locator(`[data-testid="${PILL}"][data-live-ask="true"]`);
    await expect(livePill).toHaveCount(0);
    await expect(pillIn(scope)).toHaveCount(1);
    const historicPill = scope.locator(`[data-testid="${PILL}"][data-live-ask="false"]`);
    await expect(historicPill).toHaveCount(1);
    await expect(historicPill).toHaveText(/Reopen/);
  });

  test("non-AskUserQuestion blocks never get a pill, even alongside a pending ask", async ({
    page,
  }) => {
    const scope = page.getByTestId("case:integration-matching");
    // The Read row is present with no pill. The live ask is suppressed (shown
    // as the merged form by MessageList), so only the historic ask's pill
    // remains here.
    const readToggle = scope.getByRole("button", { name: /Read/ });
    await expect(readToggle).toHaveCount(1);
    await expect(pillIn(scope)).toHaveCount(1);
  });

  test("with pendingAskToolUseId=null, ALL ask blocks render the historic variant", async ({
    page,
  }) => {
    const scope = page.getByTestId("case:integration-no-match");
    await expect(pillIn(scope)).toHaveCount(2);
    // None of them are live.
    const livePill = scope.locator(`[data-testid="${PILL}"][data-live-ask="true"]`);
    await expect(livePill).toHaveCount(0);
  });

  test("clicking any integration pill bumps the reopen counter", async ({ page }) => {
    const scope = page.getByTestId("case:integration-matching");
    const before = await reopenCount(page);
    await pillIn(scope).first().click();
    const after = await reopenCount(page);
    expect(after - before).toBe(1);
  });
});
