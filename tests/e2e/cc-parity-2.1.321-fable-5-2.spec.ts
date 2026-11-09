/**
 * CC 2.1.321 parity — "Added Claude Fable 5.2 (`claude-fable-5-2`), now the
 * default Fable model — 1M context, $8/$40 per Mtok with $0.20/Mtok cache
 * reads".
 *
 * The `fable` alias row that Claudius always shows (the static fallback in
 * `app/api/models/route.ts`, and the live-session twin in
 * `app/api/sessions/[id]/model/route.ts`) named Fable 5.1. This spec drives
 * the real "+ New workspace" form, opens its sessionless model picker (fed by
 * the real, unmocked `/api/models` fallback — there's no live session in the
 * e2e server), and asserts the Fable row reads "Fable 5.2" and can be picked
 * as the workspace default.
 *
 * Screenshot target: docs/cc-parity/2.1.321/fable-5-2-picker.png
 */

import { mkdirSync } from "node:fs";
import { resolve } from "node:path";
import { test, expect } from "../helpers/test";

const SHOTS_DIR = resolve(process.cwd(), "docs/cc-parity/2.1.321");
mkdirSync(SHOTS_DIR, { recursive: true });

test.describe("Fable 5.2 default Fable model (CC 2.1.321 parity)", () => {
  test("the workspace form's model picker labels the fable alias Fable 5.2", async ({ page }) => {
    await page.goto("/");

    const newWorkspaceBtn = page.locator('button[title="New workspace"]').first();
    await expect(newWorkspaceBtn).toBeVisible({ timeout: 30_000 });
    await newWorkspaceBtn.click();
    await expect(page.getByText("Name", { exact: true })).toBeVisible({ timeout: 10_000 });
    await page.getByRole("textbox", { name: "Name" }).fill("Fable 5.2 workspace");

    const modelsResponse = page.waitForResponse(
      (r) => new URL(r.url()).pathname === "/api/models" && r.request().method() === "GET",
    );
    const trigger = page.getByRole("button", { name: /inherit machine default/i });
    await expect(trigger).toBeVisible();
    await trigger.click();

    const res = await modelsResponse;
    const body = (await res.json()) as { source?: string; models?: Array<{ value: string; displayName: string }> };
    // No live session in the e2e server, so this is the static fallback —
    // the code path this release changed.
    expect(body.source).toBe("fallback");
    expect(body.models?.find((m) => m.value === "fable")?.displayName).toBe("Fable 5.2");

    const panel = page.getByTestId("model-picker-panel");
    await expect(panel).toBeVisible();
    const fableRow = panel.locator('[data-testid="model-picker-option"][data-model="fable"]');
    await expect(fableRow).toBeVisible();
    await expect(fableRow).toContainText("Fable 5.2");
    await expect(fableRow).not.toContainText("Fable 5.1");

    await fableRow.hover();
    await page.waitForTimeout(200);
    await page.screenshot({ path: resolve(SHOTS_DIR, "fable-5-2-picker.png"), fullPage: false });

    // Picking it stores the alias (which now resolves to Fable 5.2) as the
    // workspace default and closes the picker.
    await fableRow.click();
    await expect(panel).toBeHidden();
    await expect(page.getByRole("button", { name: /^fable$/ })).toBeVisible();
  });
});
