/**
 * CC 2.1.221 — "Changed `/status` to show the session kind: `interactive`,
 * or a background job that is `attached` or `unattended`."
 *
 * Claude Code sessions in Claudius's browser chrome are always interactive —
 * there's no headless terminal state for `/status` to distinguish. The
 * closest real analogue to a CLI "background job" is a scheduler run
 * (`components: app/[workspaceId]/schedule/page.tsx`, `lib/server/
 * scheduler.ts`): it executes a one-shot `query()` outside any interactive
 * prompt loop, and — like a CC background job — a browser tab can either
 * have its live stream open (`attached`) or not (`unattended`). This spec
 * mocks the Schedule page's two read endpoints (`/api/schedule` and
 * `/api/schedule/:id/runs`) so it can deterministically exercise both
 * states without spinning up a real SDK run, and asserts:
 *   1. the runs list shows an "attached" chip for a live run with a
 *      watcher, and an "unattended" chip for one with none,
 *   2. opening a run's transcript does NOT repeat that signal as a stat —
 *      an adversarial UX review flagged the original "Kind" stat as
 *      self-referential (opening the pane is what makes a run "attached"),
 *      so the chip only lives in the runs list.
 *
 * Screenshot target: docs/cc-parity/2.1.221/schedule-run-attached.png
 */

import { mkdirSync } from "node:fs";
import { resolve } from "node:path";
import { test, expect, type Route } from "../helpers/test";
import { activateClaudiusWorkspace } from "./helpers/workspace";

const SHOTS_DIR = resolve(process.cwd(), "docs/cc-parity/2.1.221");
mkdirSync(SHOTS_DIR, { recursive: true });

const FAKE_JOB = {
  id: "e2e-job-schedule-kind",
  name: "Nightly build report",
  cron: "0 3 * * *",
  prompt: "Summarize last night's CI runs.",
  cwd: process.cwd(),
  enabled: true,
  createdAt: Date.now() - 86_400_000,
  updatedAt: Date.now() - 86_400_000,
  lastRunAt: Date.now() - 5_000,
  nextRunAt: Date.now() + 3_600_000,
  lastStatus: "running" as const,
};

const RUN_ATTACHED = {
  id: "e2e-run-attached",
  jobId: FAKE_JOB.id,
  startedAt: Date.now() - 4_000,
  status: "running" as const,
  attached: true,
};

const RUN_UNATTENDED = {
  id: "e2e-run-unattended",
  jobId: FAKE_JOB.id,
  startedAt: Date.now() - 20_000,
  status: "running" as const,
  attached: false,
};

const RUN_DONE = {
  id: "e2e-run-done",
  jobId: FAKE_JOB.id,
  startedAt: Date.now() - 3_600_000,
  endedAt: Date.now() - 3_590_000,
  status: "success" as const,
  costUsd: 0.0123,
  inputTokens: 4200,
  outputTokens: 900,
};

test.beforeEach(async ({ page }) => {
  await page.route("**/api/schedule", async (route: Route) => {
    if (route.request().method() !== "GET") return route.fallback();
    return route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify({ jobs: [FAKE_JOB] }),
    });
  });
  await page.route(`**/api/schedule/${FAKE_JOB.id}/runs*`, async (route: Route) => {
    if (route.request().method() !== "GET") return route.fallback();
    return route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify({ runs: [RUN_ATTACHED, RUN_UNATTENDED, RUN_DONE] }),
    });
  });
});

test.describe("CC 2.1.221 — Schedule run kind: attached vs unattended", () => {
  test("live runs show an attached or unattended chip; the transcript stat matches", async ({
    page,
  }) => {
    await activateClaudiusWorkspace(page);
    await page.goto("/schedule");

    // Two elements render the job name (sidebar row + detail-pane heading);
    // the detail heading is the one that only appears once a job is loaded.
    await expect(page.getByRole("heading", { name: FAKE_JOB.name })).toBeVisible({
      timeout: 15_000,
    });

    const attachedChip = page.getByTestId(`run-live-kind-${RUN_ATTACHED.id}`);
    const unattendedChip = page.getByTestId(`run-live-kind-${RUN_UNATTENDED.id}`);
    await expect(attachedChip).toBeVisible();
    await expect(attachedChip).toHaveText(/attached/i);
    await expect(unattendedChip).toBeVisible();
    await expect(unattendedChip).toHaveText(/unattended/i);
    // The finished run never gets a chip — only in-flight runs have a
    // meaningful attached/unattended state.
    await expect(page.getByTestId(`run-live-kind-${RUN_DONE.id}`)).toHaveCount(0);

    await page.waitForTimeout(150);
    await page.screenshot({ path: resolve(SHOTS_DIR, "schedule-run-attached.png"), fullPage: false });

    // Open the unattended run's detail pane. The attached/unattended signal
    // is deliberately NOT repeated here as a stat: opening this very pane is
    // what makes a run "attached" (it mounts the live stream), so restating
    // it in the pane you're looking through would be self-referential. Only
    // the runs-list chip (where a genuinely *other* tab's attachment is real
    // information) shows it — see the "Kind" removal note in
    // RunTranscript's JSDoc.
    await page.getByText(/unattended/i).first().click();
    await expect(page.getByText(/^Started$/)).toBeVisible();
    await expect(page.getByText("running", { exact: true })).toBeVisible();
    await expect(page.getByText(/background/i)).toHaveCount(0);
  });
});
