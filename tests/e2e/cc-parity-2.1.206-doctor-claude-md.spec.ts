/**
 * CC 2.1.206 — "/doctor ... proposes trimming checked-in CLAUDE.md files by
 * cutting content Claude could derive from the codebase."
 *
 * Claudius's `/doctor` (`app/doctor`) already ships deterministic, session-less
 * checks (Node version, SDK version, auth, ~/.claude dirs, git). This release
 * adds a per-workspace `claude-md-size:<id>` warn check (see
 * `app/api/doctor/route.ts#claudeMdSizeChecks`) that flags a workspace whose
 * checked-in CLAUDE.md content has grown past a line-count threshold, and
 * links into the existing per-workspace Memory editor
 * (`/[workspaceId]/memory`) instead of trying to auto-trim it — trimming
 * needs judgment, which Claudius already has a chat/Memory surface for.
 *
 * This spec drives the Doctor page directly (mocked `GET /api/doctor`) in
 * the full app chrome (SideNav + header), asserts the warn row + its detail
 * text, clicks the "Review in Memory" link, and asserts it lands on the
 * real workspace's Memory page.
 *
 * Screenshot target: docs/cc-parity/2.1.206/doctor-claude-md-size.png
 */

import { mkdirSync } from "node:fs";
import { resolve } from "node:path";
import { test, expect, type Page, type Route } from "../helpers/test";
import { activateClaudiusWorkspace } from "./helpers/workspace";

const SHOTS_DIR = resolve(process.cwd(), "docs/cc-parity/2.1.206");
mkdirSync(SHOTS_DIR, { recursive: true });

type Check = {
  id: string;
  label: string;
  status: "ok" | "warn" | "fail";
  detail?: string;
  fixable?: boolean;
  link?: { href: string; label: string };
};

function reportWith(workspaceId: string): {
  runtime: { node: string; platform: string; arch: string };
  sdk: { version: string | null };
  checks: Check[];
} {
  const checks: Check[] = [
    { id: "node", label: "Node.js", status: "ok", detail: "v22.0.0" },
    { id: "agent-sdk", label: "@anthropic-ai/claude-agent-sdk", status: "ok", detail: "0.3.206 (Claude Code 2.1.206)" },
    { id: "auth", label: "Auth", status: "ok", detail: "ANTHROPIC_API_KEY set" },
    { id: "claude-dir", label: "~/.claude", status: "ok", detail: "/home/user/.claude" },
    { id: "projects-dir", label: "~/.claude/projects", status: "ok", detail: "writable" },
    { id: "git", label: "git", status: "ok", detail: "git version 2.43.0" },
    {
      id: `claude-md-size:${workspaceId}`,
      label: "CLAUDE.md size — claudius",
      status: "warn",
      detail:
        "412 lines (~14 KB) across 1 checked-in file — Claude can usually re-derive routine " +
        "info (file layout, tech stack, build commands) from the codebase itself; consider " +
        "trimming content it doesn't need spelled out, or moving procedures into a skill.",
      link: { href: `/${workspaceId}/memory`, label: "Review in Memory" },
    },
  ];
  return { runtime: { node: "22.0.0", platform: "darwin", arch: "arm64" }, sdk: { version: "0.3.206" }, checks };
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

test.describe("CC 2.1.206 — Doctor checked-in CLAUDE.md size check", () => {
  test("warns on an oversized checked-in CLAUDE.md and links to Memory", async ({ page }) => {
    const list = await page.request
      .get("/api/workspaces")
      .then((r) => r.json() as Promise<{ workspaces: Array<{ id: string; name: string }> }>);
    const ws = list.workspaces[0];
    expect(ws).toBeDefined();

    await mockDoctorBackend(page, ws.id);
    await page.goto("/doctor");

    const row = page.locator("li", { hasText: "CLAUDE.md size" });
    await expect(row).toBeVisible({ timeout: 15_000 });
    await expect(row.getByText(/412 lines/)).toBeVisible();
    await expect(row.getByText(/Claude can usually re-derive/)).toBeVisible();

    const link = page.getByTestId(`doctor-link-claude-md-size:${ws.id}`);
    await expect(link).toBeVisible();
    await expect(link).toHaveText("Review in Memory");

    await page.waitForTimeout(200);
    await page.screenshot({
      path: resolve(SHOTS_DIR, "doctor-claude-md-size.png"),
      fullPage: false,
    });

    await link.click();
    await expect(page).toHaveURL(new RegExp(`/${ws.id}/memory$`));
    await expect(page.getByText("Memory", { exact: true }).first()).toBeVisible();
  });
});
