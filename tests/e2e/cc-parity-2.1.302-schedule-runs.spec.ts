/**
 * CC 2.1.302 (cloud routines → Claudius scheduled jobs):
 *  - "Added a banner on a routine's page that says why its last run didn't
 *    start" → an amber banner under the job header names the skip reason
 *    (previous run still going, job folder gone), and run rows say it in words
 *    instead of a raw code.
 *  - "Fixed routine runs showing as Completed after their cloud session
 *    stopped unexpectedly … instead of failed" → a run Claudius was
 *    interrupted during (quit / crash) is recorded as `error` with a readable
 *    reason, not left "Live" forever.
 *
 * The Schedule page's read endpoints are mocked (same pattern as
 * cc-parity-2.1.221-schedule-run-attached); the server-side recording is
 * covered by tests/unit/cc-parity-2.1.302-schedule-runs.test.ts.
 *
 * Screenshot targets:
 *   docs/cc-parity/2.1.302/schedule-skip-banner.png
 *   docs/cc-parity/2.1.302/schedule-interrupted-run.png
 */

import { mkdirSync } from "node:fs";
import { resolve } from "node:path";
import { test, expect, type Page, type Route } from "../helpers/test";
import { activateClaudiusWorkspace } from "./helpers/workspace";

const SHOTS_DIR = resolve(process.cwd(), "docs/cc-parity/2.1.302");
mkdirSync(SHOTS_DIR, { recursive: true });

const NOW = Date.now();

function baseJob(over: Record<string, unknown>) {
  return {
    id: "e2e-job-2-1-302",
    name: "Nightly CI digest",
    cron: "0 3 * * *",
    prompt: "Summarize last night's CI runs.",
    cwd: process.cwd(),
    enabled: true,
    createdAt: NOW - 7 * 86_400_000,
    updatedAt: NOW - 7 * 86_400_000,
    nextRunAt: NOW + 3_600_000,
    ...over,
  };
}

async function mockSchedule(page: Page, job: Record<string, unknown>, runs: unknown[]): Promise<void> {
  await page.route("**/api/schedule", async (route: Route) => {
    if (route.request().method() !== "GET") return route.fallback();
    return route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify({ jobs: [job] }) });
  });
  await page.route(`**/api/schedule/${job.id as string}/runs*`, async (route: Route) => {
    if (route.request().method() !== "GET") return route.fallback();
    return route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify({ runs }) });
  });
}

test.beforeEach(async ({ page }) => {
  await activateClaudiusWorkspace(page);
});

test.describe("CC 2.1.302 — scheduled runs that didn't start or didn't finish", () => {
  test("the job page says why its last run didn't start", async ({ page }) => {
    const job = baseJob({
      lastRunAt: NOW - 86_400_000,
      lastStatus: "success",
      lastSkipReason: "workspace_folder_missing",
      lastSkipAt: NOW - 120_000,
    });
    await mockSchedule(page, job, [
      {
        id: "run-skip",
        jobId: job.id,
        startedAt: NOW - 120_000,
        endedAt: NOW - 120_000,
        status: "skipped",
        note: "workspace_folder_missing",
      },
      {
        id: "run-ok",
        jobId: job.id,
        startedAt: NOW - 86_400_000,
        endedAt: NOW - 86_390_000,
        status: "success",
        costUsd: 0.0123,
      },
    ]);
    await page.goto("/schedule");
    await expect(page.getByRole("heading", { name: job.name as string })).toBeVisible({ timeout: 15_000 });

    const banner = page.getByTestId("job-skip-banner");
    await expect(banner).toBeVisible();
    await expect(banner).toContainText("Last run didn't start");
    await expect(banner).toContainText("The job's folder no longer exists · 2m ago");
    // The skipped run row reads in words, not the raw code.
    await expect(page.getByText(/· The job's folder no longer exists$/)).toBeVisible();
    await expect(page.getByText("workspace_folder_missing")).toHaveCount(0);

    await page.waitForTimeout(150);
    await page.screenshot({ path: resolve(SHOTS_DIR, "schedule-skip-banner.png"), fullPage: false });
  });

  test("a skip older than the latest run shows no banner", async ({ page }) => {
    const job = baseJob({
      lastRunAt: NOW - 60_000,
      lastStatus: "success",
      lastSkipReason: "previous_run_in_progress",
      lastSkipAt: NOW - 3_600_000,
    });
    await mockSchedule(page, job, []);
    await page.goto("/schedule");
    await expect(page.getByRole("heading", { name: job.name as string })).toBeVisible({ timeout: 15_000 });
    await expect(page.getByTestId("job-skip-banner")).toHaveCount(0);
  });

  test("a run Claudius was interrupted during reads as failed, with the reason", async ({ page }) => {
    const job = baseJob({ lastRunAt: NOW - 3_600_000, lastStatus: "error" });
    await mockSchedule(page, job, [
      {
        id: "run-interrupted",
        jobId: job.id,
        startedAt: NOW - 3_600_000,
        // Recovery leaves endedAt unset: when the run died is unknown.
        status: "error",
        note: "interrupted",
      },
      {
        id: "run-no-result",
        jobId: job.id,
        startedAt: NOW - 2 * 86_400_000,
        endedAt: NOW - 2 * 86_400_000 + 4_000,
        status: "error",
        note: "session_ended_without_result",
      },
    ]);
    await page.goto("/schedule");
    await expect(page.getByRole("heading", { name: job.name as string })).toBeVisible({ timeout: 15_000 });

    await expect(page.getByText(/· Claudius stopped while this run was in progress$/)).toBeVisible();
    await expect(page.getByText(/· The session ended before the run finished$/)).toBeVisible();
    // Neither run is "Live" — no live-kind chip, no Live status.
    await expect(page.getByText("Live", { exact: true })).toHaveCount(0);
    await expect(page.getByTestId("job-skip-banner")).toHaveCount(0);

    await page.waitForTimeout(150);
    await page.screenshot({ path: resolve(SHOTS_DIR, "schedule-interrupted-run.png"), fullPage: false });
  });
});
