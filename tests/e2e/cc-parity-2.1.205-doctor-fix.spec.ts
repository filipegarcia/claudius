/**
 * CC 2.1.205 — "/doctor is now a full setup checkup that can diagnose and
 * fix issues; /checkup is its alias."
 *
 * Claudius already ships a `/doctor` slash command + `app/doctor` page with
 * diagnose-only checks. This release adds a `/checkup` alias (see
 * `lib/shared/slash-commands.ts`) and real "Fix" actions for the two checks
 * that are safe, local, non-destructive mkdir operations against fixed
 * paths under `homedir()` (`~/.claude`, `~/.claude/projects`) — see
 * `app/api/doctor/fix/route.ts`.
 *
 * This spec drives the Doctor page directly (mocked `GET /api/doctor` +
 * `POST /api/doctor/fix`), in the full app chrome (SideNav + header),
 * clicks Fix on a failing/fixable check, and asserts it flips to ok.
 *
 * Screenshot target: docs/cc-parity/2.1.205/doctor-fix.png
 */

import { mkdirSync } from "node:fs";
import { resolve } from "node:path";
import { test, expect, type Page, type Route } from "../helpers/test";
import { activateClaudiusWorkspace } from "./helpers/workspace";

const SHOTS_DIR = resolve(process.cwd(), "docs/cc-parity/2.1.205");
mkdirSync(SHOTS_DIR, { recursive: true });

type Check = {
  id: string;
  label: string;
  status: "ok" | "warn" | "fail";
  detail?: string;
  fixable?: boolean;
};

function reportWith(projectsDirStatus: "ok" | "warn"): {
  runtime: { node: string; platform: string; arch: string };
  sdk: { version: string | null };
  checks: Check[];
} {
  const checks: Check[] = [
    { id: "node", label: "Node.js", status: "ok", detail: "v22.0.0" },
    { id: "agent-sdk", label: "@anthropic-ai/claude-agent-sdk", status: "ok", detail: "0.3.205 (Claude Code 2.1.205)" },
    { id: "auth", label: "Auth", status: "ok", detail: "ANTHROPIC_API_KEY set" },
    { id: "claude-dir", label: "~/.claude", status: "ok", detail: "/home/user/.claude" },
    {
      id: "projects-dir",
      label: "~/.claude/projects",
      status: projectsDirStatus,
      detail:
        projectsDirStatus === "ok"
          ? "writable"
          : "missing or read-only — sessions can't persist",
      fixable: projectsDirStatus !== "ok",
    },
    { id: "git", label: "git", status: "ok", detail: "git version 2.43.0" },
  ];
  return { runtime: { node: "22.0.0", platform: "darwin", arch: "arm64" }, sdk: { version: "0.3.205" }, checks };
}

async function mockDoctorBackend(page: Page): Promise<void> {
  let fixed = false;

  await page.route("**/api/doctor", async (route: Route) => {
    return route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify(reportWith(fixed ? "ok" : "warn")),
    });
  });

  await page.route("**/api/doctor/fix", async (route: Route) => {
    if (route.request().method() !== "POST") return route.fallback();
    fixed = true;
    return route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify({ ok: true, id: "projects-dir", path: "/home/user/.claude/projects" }),
    });
  });
}

test.beforeEach(async ({ page }) => {
  await activateClaudiusWorkspace(page);
});

test.describe("CC 2.1.205 — Doctor diagnose-and-fix", () => {
  test("Fix button remediates a fixable check and the page re-runs to ok", async ({ page }) => {
    await mockDoctorBackend(page);
    await page.goto("/doctor");

    const row = page.locator("li", { hasText: "~/.claude/projects" });
    await expect(row).toBeVisible({ timeout: 15_000 });
    await expect(row.getByText("missing or read-only")).toBeVisible();

    const fixButton = page.getByTestId("doctor-fix-projects-dir");
    await expect(fixButton).toBeVisible();
    await expect(fixButton).toHaveText("Fix");

    await fixButton.click();

    // After the fix POST resolves, the page re-runs GET /api/doctor (now
    // reporting ok) and the Fix button disappears — status-driven, no
    // separate "fixed!" toast state to race against.
    await expect(fixButton).toHaveCount(0, { timeout: 10_000 });
    await expect(row.getByText("writable")).toBeVisible();

    await page.waitForTimeout(200);
    await page.screenshot({
      path: resolve(SHOTS_DIR, "doctor-fix.png"),
      fullPage: false,
    });
  });
});
