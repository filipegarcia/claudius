/**
 * CC 2.1.248 parity — "Added `--restricted` (or `CLAUDE_CODE_RESTRICTED=1`):
 * removes the built-in tools that run commands or code and `WebFetch`, keeps
 * file tools inside the working directory, refuses `bypassPermissions`, and
 * ignores user, project and local settings files."
 *
 * The SDK doesn't expose this launch flag, but every primitive it needs
 * already exists in Claudius (`Options.disallowedTools`, `permissionMode`, the
 * per-workspace defaults store). Claudius reimplements it as a per-workspace
 * "Restricted mode" toggle in the WorkspaceForm's Advanced section: when on,
 * the Session forwards `disallowedTools` for Bash/BashOutput/KillBash +
 * WebFetch and coerces `bypassPermissions` to `default`.
 *
 * This spec drives the real "+ New workspace" UI flow end-to-end (matching the
 * sibling sandbox spec): opens the form, expands Advanced, checks Restricted
 * mode, saves, and asserts the POST body carries `defaults.restrictedMode`.
 *
 * Screenshot target: docs/cc-parity/2.1.248/restricted-mode-toggle.png
 */

import { mkdirSync, promises as fs } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { test, expect, type Route } from "../helpers/test";

const SHOTS_DIR = resolve(process.cwd(), "docs/cc-parity/2.1.248");
mkdirSync(SHOTS_DIR, { recursive: true });

test.describe("restricted mode (CC 2.1.248 parity)", () => {
  test("WorkspaceForm exposes a Restricted mode default that POSTs restrictedMode", async ({
    page,
    baseURL,
  }) => {
    let capturedPostBody: {
      name?: unknown;
      defaults?: { restrictedMode?: unknown };
    } | null = null;

    await page.route("**/api/workspaces", async (route: Route) => {
      if (route.request().method() === "POST") {
        try {
          capturedPostBody = (await route.request().postDataJSON()) as typeof capturedPostBody;
        } catch {
          capturedPostBody = null;
        }
      }
      return route.fallback();
    });

    await page.goto("/");

    const newWorkspaceBtn = page.locator('button[title="New workspace"]').first();
    await expect(newWorkspaceBtn).toBeVisible({ timeout: 30_000 });
    await newWorkspaceBtn.click();

    const formNameLabel = page.getByText("Name", { exact: true });
    await expect(formNameLabel).toBeVisible({ timeout: 10_000 });

    const isolatedRoot = await fs.mkdtemp(join(tmpdir(), "claudius-e2e-restricted-"));
    let createdId: string | null = null;
    try {
      const wsName = `E2E restricted ${Date.now()}`;
      await page.getByRole("textbox", { name: "Name" }).fill(wsName);
      await page.getByRole("textbox", { name: /root folder/i }).fill(isolatedRoot);

      // Expand Advanced.
      await page.getByRole("button", { name: "Advanced" }).click();

      const restrictedCheckbox = page.getByTestId("workspace-restricted-mode");
      await expect(restrictedCheckbox).toBeVisible();
      await expect(restrictedCheckbox).not.toBeChecked();

      await restrictedCheckbox.check();
      await expect(restrictedCheckbox).toBeChecked();

      await page.waitForTimeout(150);
      await page.screenshot({
        path: resolve(SHOTS_DIR, "restricted-mode-toggle.png"),
        fullPage: false,
      });

      const saveBtn = page.getByRole("button", { name: /^save$/i });
      await expect(saveBtn).toBeEnabled();
      await saveBtn.click();

      await expect(formNameLabel).toBeHidden({ timeout: 10_000 });

      expect(capturedPostBody, "form should POST a body to /api/workspaces").toBeTruthy();
      expect(capturedPostBody!.defaults?.restrictedMode).toBe(true);

      const listRes = await page.request.get(`${baseURL}/api/workspaces`);
      expect(listRes.ok()).toBe(true);
      const list = (await listRes.json()) as { workspaces: { id: string; name: string }[] };
      expect(list.workspaces.map((w) => w.name)).toContain(wsName);
      createdId = list.workspaces.find((w) => w.name === wsName)?.id ?? null;

      if (createdId) {
        await page.request.delete(`${baseURL}/api/workspaces/${createdId}`).catch(() => {});
      }
    } finally {
      await fs.rm(isolatedRoot, { recursive: true, force: true }).catch(() => {});
    }
  });
});
