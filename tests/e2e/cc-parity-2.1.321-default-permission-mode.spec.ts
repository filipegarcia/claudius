/**
 * CC 2.1.321 parity — "Fixed /config showing Manual as the default permission
 * mode when new sessions start in auto mode".
 *
 * Claudius's own default-permission-mode UI made the same kind of mistake —
 * the "default" it showed wasn't what new chats got:
 *   - the workspace-create form's "(inherit)" option actually gives the
 *     workspace Auto (createWorkspace stamps DEFAULT_WORKSPACE_DEFAULTS);
 *   - the workspace settings page's "Inherit (default) · Use the machine-level
 *     setting" actually gives Default, because Claudius always passes an
 *     explicit mode and never reads `permissions.defaultMode`.
 * Both now say what happens.
 *
 * Drives the real create form, the real `/api/workspaces` (a scratch
 * workspace in a temp folder) and the real workspace settings page.
 *
 * Screenshot target: docs/cc-parity/2.1.321/default-permission-mode.png
 */
import { mkdirSync, promises as fs } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { test, expect } from "../helpers/test";

const SHOTS_DIR = resolve(process.cwd(), "docs/cc-parity/2.1.321");
mkdirSync(SHOTS_DIR, { recursive: true });

type WorkspaceSummary = { id: string; defaults?: { permissionMode?: string } };

test.describe("default permission mode labels (CC 2.1.321 parity)", () => {
  test("the create form says an unset mode means Auto", async ({ page }) => {
    await page.goto("/");
    const newWorkspaceBtn = page.locator('button[title="New workspace"]').first();
    await expect(newWorkspaceBtn).toBeVisible({ timeout: 30_000 });
    await newWorkspaceBtn.click();
    await expect(page.getByText("Name", { exact: true })).toBeVisible({ timeout: 10_000 });

    const select = page.locator("select").filter({ has: page.locator('option[value="acceptEdits"]') }).first();
    await expect(select.locator('option[value=""]')).toHaveText("auto (Claudius default)");
    await expect(select.locator("option", { hasText: "(inherit)" })).toHaveCount(0);
  });

  test("an unset workspace mode is labelled as the built-in Default it gives", async ({ page, baseURL }) => {
    const root = await fs.mkdtemp(join(tmpdir(), "claudius-e2e-defaultmode-"));
    // Created without a permissionMode, exactly as the form's unset option does.
    const created = await page.request.post(`${baseURL}/api/workspaces`, {
      data: { name: `default-mode-${Date.now()}`, rootPath: root },
    });
    expect(created.ok()).toBeTruthy();
    const ws = (await created.json()) as WorkspaceSummary;
    try {
      // …and it really is Auto, which is what the form now says.
      expect(ws.defaults?.permissionMode).toBe("auto");
      await page.request.post(`${baseURL}/api/workspaces/${ws.id}/select`);

      await page.goto(`/${ws.id}/workspace`);
      const unset = page.getByRole("radio", { name: /Default \(built-in\)/ });
      await expect(unset).toBeVisible({ timeout: 30_000 });
      await expect(unset).toContainText("new chats start in Default");
      await expect(unset).toContainText("permissions.defaultMode in settings.json isn't applied");
      await expect(page.getByRole("radio", { name: /Inherit \(default\)/ })).toHaveCount(0);
      await expect(page.getByText("Use the machine-level setting.")).toHaveCount(0);
      // The stamped mode is the selected one.
      await expect(page.getByRole("radio", { name: /^Auto/ })).toHaveAttribute("aria-checked", "true");
      await expect(unset).toHaveAttribute("aria-checked", "false");

      await unset.scrollIntoViewIfNeeded();
      await page.waitForTimeout(200);
      await page.screenshot({ path: resolve(SHOTS_DIR, "default-permission-mode.png"), fullPage: false });
    } finally {
      await page.request.delete(`${baseURL}/api/workspaces/${ws.id}`);
      await fs.rm(root, { recursive: true, force: true });
    }
  });
});
