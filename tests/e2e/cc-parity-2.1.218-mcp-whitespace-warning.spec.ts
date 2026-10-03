/**
 * CC 2.1.218 parity — "Added HTTP status and error text to `claude mcp list`
 * and `/mcp` when a server fails to connect, and a warning for MCP config
 * values with hidden leading or trailing whitespace."
 *
 * Claudius already forwarded the SDK's `McpServerStatus.error` verbatim in
 * the expanded server row (the HTTP-status/error-text half of this line
 * arrives for free with the SDK bump — see the run-notes classification).
 * The whitespace warning was a real gap: `lib/server/mcp.ts`'s config
 * readers and the Add-server form never checked for it, and hand-edited
 * `.mcp.json`/`settings.json` bypass the form's own `.trim()` entirely.
 *
 * `listConfigured()` now computes a `warnings: string[]` per server
 * (`findConfigWhitespaceWarnings`) and the `/mcp` page renders it as an
 * amber notice next to the existing red error block, once the row is
 * expanded.
 *
 * This spec seeds a project-scope `.mcp.json` (the canonical location both
 * Claude Code and the SDK read) with a URL carrying trailing whitespace,
 * via the real `POST /api/mcp` route (project scope), then drives the
 * actual `/mcp` UI to expand the row and assert the warning.
 *
 * Screenshot target: docs/cc-parity/2.1.218/mcp-whitespace-warning.png
 */

import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { test, expect } from "../helpers/test";

const SHOTS_DIR = resolve(process.cwd(), "docs/cc-parity/2.1.218");
mkdirSync(SHOTS_DIR, { recursive: true });

test.describe("MCP config whitespace warning (CC 2.1.218 parity)", () => {
  test("expanded server row shows a whitespace warning for a tainted URL", async ({
    page,
    baseURL,
  }) => {
    test.setTimeout(60_000);

    const root = mkdtempSync(join(tmpdir(), "claudius-e2e-mcp-whitespace-"));
    let wsId: string | null = null;
    let claudiusId: string | null = null;

    try {
      const wsRes = await page.request.post(`${baseURL}/api/workspaces`, {
        data: { name: `E2E mcp-whitespace ${Date.now()}`, rootPath: root },
      });
      expect(wsRes.ok()).toBeTruthy();
      wsId = ((await wsRes.json()) as { id: string }).id;
      await page.request.post(`${baseURL}/api/workspaces/${wsId}/select`);

      // Seed a project-scope server via the real API — the config value
      // carries a trailing space, exactly the "pasted a URL with a stray
      // character" scenario the changelog line targets.
      const upsertRes = await page.request.post(`${baseURL}/api/mcp`, {
        data: {
          scope: "project",
          cwd: root,
          name: "tainted-server",
          config: { type: "http", url: "https://example.com/mcp " },
        },
      });
      expect(upsertRes.ok()).toBeTruthy();

      await page.goto("/mcp");

      const row = page.getByText("tainted-server", { exact: true });
      await expect(row).toBeVisible({ timeout: 15_000 });
      await row.click();

      const warning = page.getByTestId("mcp-whitespace-warning");
      await expect(warning).toBeVisible();
      await expect(warning).toContainText("url has leading/trailing whitespace");

      await page.waitForTimeout(150);
      await page.screenshot({
        path: resolve(SHOTS_DIR, "mcp-whitespace-warning.png"),
        fullPage: false,
      });
    } finally {
      const list = await page.request
        .get(`${baseURL}/api/workspaces`)
        .then((r) => r.json() as Promise<{ workspaces: Array<{ id: string; name: string }> }>)
        .catch(() => ({ workspaces: [] as Array<{ id: string; name: string }> }));
      claudiusId = list.workspaces.find((w) => w.name === "claudius")?.id ?? null;
      if (claudiusId) {
        await page.request.post(`${baseURL}/api/workspaces/${claudiusId}/select`).catch(() => {});
      }
      if (wsId) {
        await page.request.delete(`${baseURL}/api/workspaces/${wsId}`).catch(() => {});
      }
      rmSync(root, { recursive: true, force: true });
    }
  });
});
