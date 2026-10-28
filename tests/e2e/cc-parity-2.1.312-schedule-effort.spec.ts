/**
 * CC 2.1.312 parity — "[Cloud sessions] Added an effort level to the model
 * picker when you create or edit a routine that runs in the cloud".
 *
 * Claudius's Schedule page is its local routines surface (the 2.1.302 routine
 * banner was mirrored there too). The new-job form now has an optional Effort
 * select beside Model. The level is sent with the create request, and the job
 * page shows it. The runner passes it to the SDK as `effort`, which is
 * unit-tested in `tests/unit/cc-parity-2.1.312-schedule-effort.test.ts`.
 *
 * Screenshot target: docs/cc-parity/2.1.312/schedule-effort.png
 */

import { mkdirSync } from "node:fs";
import { resolve } from "node:path";
import { test, expect, type Page, type Route } from "../helpers/test";
import { activateClaudiusWorkspace } from "./helpers/workspace";

const SHOTS_DIR = resolve(process.cwd(), "docs/cc-parity/2.1.312");
mkdirSync(SHOTS_DIR, { recursive: true });

const NOW = Date.now();

async function mockSchedule(page: Page): Promise<{ posted: Record<string, unknown>[] }> {
  const posted: Record<string, unknown>[] = [];
  const jobs: Record<string, unknown>[] = [];
  await page.route("**/api/schedule", async (route: Route) => {
    const method = route.request().method();
    if (method === "GET") return route.fulfill({ json: { jobs } });
    if (method === "POST") {
      const body = route.request().postDataJSON() as Record<string, unknown>;
      posted.push(body);
      const job = {
        id: "e2e-job-2-1-312",
        name: body.name,
        cron: body.cron,
        prompt: body.prompt,
        cwd: process.cwd(),
        ...(body.model ? { model: body.model } : {}),
        ...(body.effort ? { effort: body.effort } : {}),
        enabled: true,
        createdAt: NOW,
        updatedAt: NOW,
        nextRunAt: NOW + 3_600_000,
      };
      jobs.push(job);
      return route.fulfill({ status: 201, json: job });
    }
    return route.fallback();
  });
  await page.route("**/api/schedule/e2e-job-2-1-312/runs*", (route: Route) => route.fulfill({ json: { runs: [] } }));
  await page.route("**/api/schedule/session-loops*", (route: Route) => route.fulfill({ json: { loops: [] } }));
  return { posted };
}

test.beforeEach(async ({ page }) => {
  await activateClaudiusWorkspace(page);
});

test("a new scheduled job can pick an effort level beside its model", async ({ page }) => {
  const { posted } = await mockSchedule(page);
  await page.goto("/schedule");

  await page.getByRole("button", { name: "New job" }).click();
  const effort = page.getByTestId("schedule-effort-select");
  await expect(effort).toBeVisible({ timeout: 15_000 });
  // Default keeps the model's own level, and every effort level is offered.
  await expect(effort).toHaveValue("");
  await expect(effort.locator("option")).toHaveText(["Default", "low", "medium", "high", "xhigh", "max"]);

  await page.getByPlaceholder("Daily build status").fill("Nightly dependency audit");
  await page
    .getByPlaceholder("Summarize today's commits and post a 3-bullet update.")
    .fill("Check for outdated dependencies and open a summary.");
  await page.getByPlaceholder("claude-sonnet-4-6").fill("claude-opus-5-5");
  await effort.selectOption("high");
  await expect(effort).toHaveValue("high");

  // Bring the Model + Effort row into the middle of the form for the shot.
  await effort.evaluate((el) => el.scrollIntoView({ block: "center" }));
  await page.waitForTimeout(200);
  await page.screenshot({ path: resolve(SHOTS_DIR, "schedule-effort.png"), fullPage: false });

  await page.getByRole("button", { name: "Save" }).click();
  await expect.poll(() => posted.length).toBe(1);
  expect(posted[0]).toMatchObject({ model: "claude-opus-5-5", effort: "high" });

  // The job page lists the effort next to the model.
  await expect(page.getByTestId("job-effort")).toHaveText("high");
});

test("leaving Effort on Default sends no effort", async ({ page }) => {
  const { posted } = await mockSchedule(page);
  await page.goto("/schedule");
  await page.getByRole("button", { name: "New job" }).click();
  await page.getByPlaceholder("Daily build status").fill("Plain job");
  await page.getByPlaceholder("Summarize today's commits and post a 3-bullet update.").fill("Say hi.");
  await page.getByRole("button", { name: "Save" }).click();
  await expect.poll(() => posted.length).toBe(1);
  expect("effort" in posted[0]).toBe(false);
  await expect(page.getByTestId("job-effort")).toHaveCount(0);
});
