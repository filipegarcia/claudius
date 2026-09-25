/**
 * CC 2.1.283 — "Added `/doctor prompt-audit` (also `/checkup prompt-audit`)
 * to audit your CLAUDE.md files, skills, agents and commands for prompting
 * patterns written for older models" + "Improved `prompt-audit` on Claude
 * Code configuration: stale paths, stale commands and contradicting
 * instruction files now lead the report, and thinking keywords that Claude
 * Code documents are kept."
 *
 * Claudius's `/doctor` (`app/doctor`) already ships deterministic,
 * session-less checks (Node version, SDK version, auth, CLAUDE.md size —
 * see CC 2.1.206 parity). This release adds a per-workspace
 * `prompt-audit:<id>` check (`app/api/doctor/route.ts#promptAuditChecks`,
 * heuristics in `lib/shared/prompt-audit.ts` + `lib/server/prompt-audit.ts`)
 * grouped under its own "Prompt audit" section, reachable directly via
 * `/doctor prompt-audit` (or `/checkup prompt-audit`) which deep-links to
 * `/doctor?section=prompt-audit` (`ChatSurface.tsx`'s `case "doctor":`).
 *
 * This spec drives the Doctor page directly (mocked `GET /api/doctor`) in
 * the full app chrome (SideNav + header), asserts the warn row + its detail
 * text lives in the dedicated "Prompt audit" section (not mixed into the
 * general "Checks" list), asserts the deep-link scrolls it into view, then
 * clicks "Review in Memory" and confirms it lands on the real workspace's
 * Memory page.
 *
 * Screenshot target: docs/cc-parity/2.1.283/doctor-prompt-audit.png
 */

import { mkdirSync } from "node:fs";
import { resolve } from "node:path";
import { test, expect, type Page, type Route } from "../helpers/test";
import { activateClaudiusWorkspace } from "./helpers/workspace";

const SHOTS_DIR = resolve(process.cwd(), "docs/cc-parity/2.1.283");
mkdirSync(SHOTS_DIR, { recursive: true });

type Check = {
  id: string;
  label: string;
  status: "ok" | "warn" | "fail";
  detail?: string;
  fixable?: boolean;
  link?: { href: string; label: string };
  category?: "prompt-audit";
};

function reportWith(workspaceId: string): {
  runtime: { node: string; platform: string; arch: string };
  sdk: { version: string | null };
  checks: Check[];
} {
  const checks: Check[] = [
    { id: "node", label: "Node.js", status: "ok", detail: "v22.0.0" },
    { id: "agent-sdk", label: "@anthropic-ai/claude-agent-sdk", status: "ok", detail: "0.3.283 (Claude Code 2.1.283)" },
    { id: "auth", label: "Auth", status: "ok", detail: "ANTHROPIC_API_KEY set" },
    { id: "claude-dir", label: "~/.claude", status: "ok", detail: "/home/user/.claude" },
    { id: "projects-dir", label: "~/.claude/projects", status: "ok", detail: "writable" },
    { id: "git", label: "git", status: "ok", detail: "git version 2.43.0" },
    {
      id: `prompt-audit:${workspaceId}`,
      label: "Prompt audit — claudius",
      status: "warn",
      detail:
        "2 stale prompting patterns · 1 path reference to a missing file. " +
        'claude-md:project — chain-of-thought scaffolding — redundant with native extended thinking ("Always think step by step before writing code."); ' +
        'skill:my-skill — pre-Claude assistant-persona boilerplate ("You are a helpful AI assistant."); ' +
        "claude-md:project — references missing `lib/server/does-not-exist.ts`",
      link: { href: `/${workspaceId}/memory`, label: "Review in Memory" },
      category: "prompt-audit",
    },
  ];
  return { runtime: { node: "22.0.0", platform: "darwin", arch: "arm64" }, sdk: { version: "0.3.283" }, checks };
}

async function mockDoctorBackend(page: Page, workspaceId: string): Promise<void> {
  await page.route("**/api/doctor", async (route: Route) => {
    return route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify(reportWith(workspaceId)),
    });
  });
}

test.beforeEach(async ({ page }) => {
  await activateClaudiusWorkspace(page);
});

test.describe("CC 2.1.283 — Doctor prompt audit", () => {
  test("warns on stale prompting patterns in its own section and deep-links from /doctor prompt-audit", async ({ page }) => {
    const list = await page.request
      .get("/api/workspaces")
      .then((r) => r.json() as Promise<{ workspaces: Array<{ id: string; name: string }> }>);
    const ws = list.workspaces[0];
    expect(ws).toBeDefined();

    await mockDoctorBackend(page, ws.id);

    // Drive it the way a user actually reaches it: `/doctor prompt-audit`
    // deep-links to `?section=prompt-audit`, which the page scrolls into
    // view (see `app/doctor/page.tsx`'s scroll-into-view effect).
    await page.goto("/doctor?section=prompt-audit");

    const section = page.getByTestId("doctor-prompt-audit-section");
    await expect(section).toBeVisible({ timeout: 15_000 });
    await expect(section.getByText("Prompt audit", { exact: true })).toBeVisible();

    const row = section.locator("li", { hasText: "Prompt audit — claudius" });
    await expect(row).toBeVisible();
    await expect(row.getByText(/2 stale prompting patterns/)).toBeVisible();
    await expect(row.getByText(/step by step/)).toBeVisible();
    await expect(row.getByText(/does-not-exist\.ts/)).toBeVisible();

    // The general "Checks" section must NOT also contain the prompt-audit
    // row — it's grouped under its own heading, not mixed in.
    const generalChecks = page.getByText("Checks", { exact: true }).locator("..");
    await expect(generalChecks.getByText("Prompt audit — claudius")).toHaveCount(0);

    const link = page.getByTestId(`doctor-link-prompt-audit:${ws.id}`);
    await expect(link).toBeVisible();
    await expect(link).toHaveText("Review in Memory");

    await page.waitForTimeout(200);
    await page.screenshot({
      path: resolve(SHOTS_DIR, "doctor-prompt-audit.png"),
      fullPage: false,
    });

    await link.click();
    await expect(page).toHaveURL(new RegExp(`/${ws.id}/memory$`));
    await expect(page.getByText("Memory", { exact: true }).first()).toBeVisible();
  });

  test("shows an ok row and an empty-state note when nothing is stale", async ({ page }) => {
    const list = await page.request
      .get("/api/workspaces")
      .then((r) => r.json() as Promise<{ workspaces: Array<{ id: string; name: string }> }>);
    const ws = list.workspaces[0];

    await page.route("**/api/doctor", async (route: Route) => {
      const clean = reportWith(ws.id);
      clean.checks = clean.checks.map((c) =>
        c.category === "prompt-audit"
          ? { ...c, status: "ok" as const, detail: "No stale prompting patterns or broken path references found.", link: undefined }
          : c,
      );
      return route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify(clean) });
    });

    await page.goto("/doctor");
    const section = page.getByTestId("doctor-prompt-audit-section");
    await expect(section).toBeVisible({ timeout: 15_000 });
    await expect(section.getByText(/No stale prompting patterns/)).toBeVisible();
  });
});
