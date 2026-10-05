/**
 * CC 2.1.218 parity — "Changed agent markdown files to reject agent names
 * containing `:`, which is reserved for plugin namespacing."
 *
 * Claudius's own agent-creation flow (`lib/server/agents.ts`) already
 * incidentally blocked `:` in the on-disk *filename* via the pre-existing
 * `/^[\w.\-]+$/` regex — but the free-text frontmatter `name:` field a user
 * can type directly into the raw markdown textarea was never validated.
 * `writeAgent()` now rejects a colon there too, and the PUT route surfaces
 * the specific reason (not a bare 500) so the Agents editor can show it
 * inline via the existing header error slot.
 *
 * This spec seeds a real agent file on disk (so it's shown in the sidebar
 * without going through the `window.prompt()`-based "New agent" flow),
 * selects it, edits the frontmatter `name:` field to add a colon, saves,
 * and asserts the inline error.
 *
 * Screenshot target: docs/cc-parity/2.1.218/agent-name-colon-rejected.png
 */

import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { test, expect } from "../helpers/test";

const SHOTS_DIR = resolve(process.cwd(), "docs/cc-parity/2.1.218");
mkdirSync(SHOTS_DIR, { recursive: true });

test.describe("Agent frontmatter name ':' rejection (CC 2.1.218 parity)", () => {
  test("saving a frontmatter name with ':' shows an inline error, not a silent 500", async ({
    page,
    baseURL,
  }) => {
    test.setTimeout(60_000);

    const root = mkdtempSync(join(tmpdir(), "claudius-e2e-agent-colon-"));
    mkdirSync(join(root, ".claude", "agents"), { recursive: true });
    writeFileSync(
      join(root, ".claude", "agents", "test-agent.md"),
      "---\nname: test-agent\ndescription: seeded for the CC 2.1.218 e2e spec\n---\n\nPrompt body.\n",
    );

    let wsId: string | null = null;

    try {
      const wsRes = await page.request.post(`${baseURL}/api/workspaces`, {
        data: { name: `E2E agent-colon ${Date.now()}`, rootPath: root },
      });
      expect(wsRes.ok()).toBeTruthy();
      wsId = ((await wsRes.json()) as { id: string }).id;
      await page.request.post(`${baseURL}/api/workspaces/${wsId}/select`);

      await page.goto("/agents");

      const agentEntry = page.getByText("test-agent", { exact: true });
      await expect(agentEntry).toBeVisible({ timeout: 15_000 });
      await agentEntry.click();

      const textarea = page.getByTestId("agent-editor-textarea");
      await expect(textarea).toBeVisible();
      await expect(textarea).toHaveValue(/name: test-agent/);

      await textarea.fill(
        "---\nname: test-agent:sub\ndescription: seeded for the CC 2.1.218 e2e spec\n---\n\nPrompt body.\n",
      );

      await page.getByRole("button", { name: /^save$/i }).click();

      const error = page.getByTestId("agent-editor-error");
      await expect(error).toBeVisible({ timeout: 10_000 });
      await expect(error).toContainText("reserved for plugin namespacing");

      await page.waitForTimeout(150);
      await page.screenshot({
        path: resolve(SHOTS_DIR, "agent-name-colon-rejected.png"),
        fullPage: false,
      });
    } finally {
      const list = await page.request
        .get(`${baseURL}/api/workspaces`)
        .then((r) => r.json() as Promise<{ workspaces: Array<{ id: string; name: string }> }>)
        .catch(() => ({ workspaces: [] as Array<{ id: string; name: string }> }));
      const claudius = list.workspaces.find((w) => w.name === "claudius");
      if (claudius) {
        await page.request.post(`${baseURL}/api/workspaces/${claudius.id}/select`).catch(() => {});
      }
      if (wsId) {
        await page.request.delete(`${baseURL}/api/workspaces/${wsId}`).catch(() => {});
      }
      rmSync(root, { recursive: true, force: true });
    }
  });
});
