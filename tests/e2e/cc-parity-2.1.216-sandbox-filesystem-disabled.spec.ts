/**
 * CC 2.1.216 parity — "Added `sandbox.filesystem.disabled` setting to skip
 * filesystem isolation while keeping network egress control."
 *
 * Claudius already had a per-workspace "Sandbox shell commands" default
 * (components/workspaces/WorkspaceForm.tsx, `sandboxEnabled` — forwards SDK
 * `Options.sandbox.enabled`). This release adds the nested
 * `sandbox.filesystem.disabled` leaf, so Claudius extends the same Advanced
 * section with a "Skip filesystem isolation" checkbox nested under the
 * existing Sandbox checkbox — visible only while the sandbox itself is on,
 * mirroring the SDK's own nesting (the leaf is meaningless without the
 * parent enabled).
 *
 * This spec drives the real "+ New workspace" UI flow end-to-end (no API
 * short-circuit for the form itself, matching the sibling UI-driven spec in
 * app-functionality.spec.ts): opens the form, expands Advanced, checks
 * Sandbox, asserts the nested checkbox appears, checks it, saves, and
 * asserts the POST body actually carries both flags. Also asserts the
 * nested checkbox hides again when the parent is unchecked.
 *
 * Screenshot target: docs/cc-parity/2.1.216/sandbox-filesystem-disabled.png
 */

import { mkdirSync, promises as fs } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { test, expect, type Route } from "../helpers/test";

const SHOTS_DIR = resolve(process.cwd(), "docs/cc-parity/2.1.216");
mkdirSync(SHOTS_DIR, { recursive: true });

test.describe("sandbox.filesystem.disabled (CC 2.1.216 parity)", () => {
  test("WorkspaceForm exposes 'Skip filesystem isolation' nested under Sandbox", async ({
    page,
    baseURL,
  }) => {
    let capturedPostBody: {
      name?: unknown;
      defaults?: { sandboxEnabled?: unknown; sandboxFilesystemDisabled?: unknown };
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

    const isolatedRoot = await fs.mkdtemp(join(tmpdir(), "claudius-e2e-sandboxfs-"));
    let createdId: string | null = null;
    try {
      const wsName = `E2E sandbox-fs ${Date.now()}`;
      await page.getByRole("textbox", { name: "Name" }).fill(wsName);
      await page.getByRole("textbox", { name: /root folder/i }).fill(isolatedRoot);

      // Expand Advanced.
      await page.getByRole("button", { name: "Advanced" }).click();

      const sandboxCheckbox = page.getByRole("checkbox", { name: /Sandbox shell commands/ });
      await expect(sandboxCheckbox).toBeVisible();

      // The nested "Skip filesystem isolation" checkbox is only rendered
      // while the sandbox itself is on.
      const skipFsCheckbox = page.getByRole("checkbox", { name: /Skip filesystem isolation/ });
      await expect(skipFsCheckbox).toHaveCount(0);

      await sandboxCheckbox.check();
      await expect(skipFsCheckbox).toBeVisible();

      await skipFsCheckbox.check();

      await page.waitForTimeout(150);
      await page.screenshot({
        path: resolve(SHOTS_DIR, "sandbox-filesystem-disabled.png"),
        fullPage: false,
      });

      // Unchecking the parent hides the nested checkbox again — it doesn't
      // persist state visibly, but the underlying React state is guarded on
      // save (see the `defaultSandbox && defaultSandboxNoFs` check below).
      await sandboxCheckbox.uncheck();
      await expect(skipFsCheckbox).toHaveCount(0);
      await sandboxCheckbox.check();
      await expect(skipFsCheckbox).toBeVisible();
      // Re-check after the round trip so the saved payload below reflects
      // the intended "both on" state, not the transient uncheck above.
      await skipFsCheckbox.check();
      await expect(skipFsCheckbox).toBeChecked();

      const saveBtn = page.getByRole("button", { name: /^save$/i });
      await expect(saveBtn).toBeEnabled();
      await saveBtn.click();

      await expect(formNameLabel).toBeHidden({ timeout: 10_000 });

      expect(capturedPostBody, "form should POST a body to /api/workspaces").toBeTruthy();
      const postedDefaults = capturedPostBody!.defaults;
      expect(postedDefaults?.sandboxEnabled).toBe(true);
      expect(postedDefaults?.sandboxFilesystemDisabled).toBe(true);

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
