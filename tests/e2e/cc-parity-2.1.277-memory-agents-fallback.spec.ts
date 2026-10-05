/**
 * CC 2.1.277 parity — "Added AGENTS.md support: in a project with no
 * CLAUDE.md, Claude Code reads AGENTS.md instead; change it under 'Project
 * instructions' in /config".
 *
 * Claudius reimplements project-instructions browsing/editing natively
 * (lib/server/claudemd.ts, the Memory page's "project" scope) rather than
 * forwarding a CLI panel, so the fallback has to be mirrored there: when a
 * workspace's project directory has an AGENTS.md but no CLAUDE.md, the
 * "Project" scope tab now reads (and, on save, writes back to) AGENTS.md
 * instead of showing an empty CLAUDE.md editor — matching what the live
 * agent session actually reads.
 *
 * This spec creates a throwaway workspace whose root has only an AGENTS.md,
 * opens the Memory page (the real UI flow, not mocked), and asserts the
 * "Project" scope shows the AGENTS.md content plus the fallback badge.
 *
 * Screenshot target: docs/cc-parity/2.1.277/memory-agents-fallback.png
 */

import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { test, expect } from "../helpers/test";

const SHOTS_DIR = resolve(process.cwd(), "docs/cc-parity/2.1.277");
mkdirSync(SHOTS_DIR, { recursive: true });

test.describe("Memory page AGENTS.md project-instructions fallback (CC 2.1.277 parity)", () => {
  test("Project scope reads AGENTS.md and shows the fallback badge when no CLAUDE.md exists", async ({
    page,
    baseURL,
  }) => {
    test.setTimeout(60_000);

    const dir = mkdtempSync(join(tmpdir(), "claudius-memory-agents-fallback-"));
    writeFileSync(
      join(dir, "AGENTS.md"),
      "# Project agent instructions\n\nRun `bun run test` before committing.\n",
      "utf8",
    );

    const created = await page.request.post(`${baseURL}/api/workspaces`, {
      data: { name: `agents-fallback-${Date.now()}`, rootPath: dir },
    });
    expect(created.ok(), "creating the throwaway workspace").toBeTruthy();
    const ws = (await created.json()) as { id: string };

    try {
      await page.request.post(`${baseURL}/api/workspaces/${ws.id}/select`);

      const claudemdLoaded = page.waitForResponse(
        (r) => r.url().includes("/api/claudemd") && !r.url().includes("resolved=1"),
      );
      await page.goto(`/${ws.id}/memory`);
      await claudemdLoaded;

      // "Project" is the default active scope tab for a workspace-scoped
      // Memory page — no click needed to land on it.
      await expect(page.getByText("reading AGENTS.md (no CLAUDE.md)")).toBeVisible();
      const pathBar = page.locator("text=AGENTS.md").first();
      await expect(pathBar).toBeVisible();

      const editor = page.getByPlaceholder("(empty — start typing to create the file)");
      await expect(editor).toHaveValue(/Run `bun run test` before committing\./);

      await page.waitForTimeout(200);
      await page.screenshot({
        path: resolve(SHOTS_DIR, "memory-agents-fallback.png"),
        fullPage: false,
      });
    } finally {
      await page.request.delete(`${baseURL}/api/workspaces/${ws.id}`).catch(() => {});
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
