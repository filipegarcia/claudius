/**
 * CC 2.1.206 — "Added a `/doctor` check that proposes trimming checked-in
 * CLAUDE.md files by cutting content Claude could derive from the
 * codebase."
 *
 * Claudius already ships a `/doctor` slash command + `app/doctor` page
 * (see `cc-parity-2.1.205-doctor-fix.spec.ts`). This release adds one more
 * check: a per-workspace warning when a project's checked-in CLAUDE.md
 * content (project root + `.claude/CLAUDE.md`) crosses a line-count
 * threshold (`CLAUDE_MD_WARN_LINES` in `lib/server/claudemd.ts`). Unlike
 * upstream's model-driven "what could be derived" analysis, this is a
 * fast, deterministic, session-less probe — so instead of an automated
 * "Fix" action it links into the existing per-workspace Memory editor
 * (`/[workspaceId]/memory`) where trimming is actually a judgment call.
 *
 * This spec drives the Doctor page directly (mocked `GET /api/doctor`),
 * in the full app chrome (SideNav + header), and asserts the new warn row
 * and its "Review in Memory" link render and point at the active
 * workspace's Memory page.
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
      id: `claude-md-size-${workspaceId}`,
      label: "CLAUDE.md size — claudius",
      status: "warn",
      detail: "412 lines (18.3 KB) checked in — consider trimming content Claude could derive from the codebase",
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

test.describe("CC 2.1.206 — Doctor checked-in CLAUDE.md size check", () => {
  test("warns when a workspace's CLAUDE.md crosses the line threshold, links into Memory", async ({ page }) => {
    await activateClaudiusWorkspace(page);
    const { workspaces } = (await page.request
      .get("/api/workspaces")
      .then((r) => r.json())) as { workspaces: Array<{ id: string; name: string }> };
    const ws = workspaces.find((w) => w.name === "claudius") ?? workspaces[0];
    expect(ws).toBeTruthy();

    await mockDoctorBackend(page, ws.id);
    await page.goto("/doctor");

    const row = page.locator("li", { hasText: "CLAUDE.md size" });
    await expect(row).toBeVisible({ timeout: 15_000 });
    await expect(row.getByText(/checked in — consider trimming/)).toBeVisible();

    const link = page.getByTestId(`doctor-link-claude-md-size-${ws.id}`);
    await expect(link).toBeVisible();
    await expect(link).toHaveText("Review in Memory");
    await expect(link).toHaveAttribute("href", `/${ws.id}/memory`);

    await page.waitForTimeout(200);
    await page.screenshot({
      path: resolve(SHOTS_DIR, "doctor-claude-md-size.png"),
      fullPage: false,
    });
  });
});
