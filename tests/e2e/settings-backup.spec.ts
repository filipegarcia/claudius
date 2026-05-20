import { mkdtempSync, rmSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { test, expect } from "../helpers/test";
import type { ImportProgress, SettingsBundle } from "@/lib/shared/settings-bundle";

/**
 * Round-trips the export → import flow via the public API endpoints. We
 * skip the file-input UI dance (Playwright doesn't easily fake `<input
 * type=file>` against `multipart/form-data` parsers without test-specific
 * scaffolding) and POST JSON directly. That still exercises every code path
 * in `settings-import.ts`, which is where the interesting logic lives.
 *
 * The flow:
 *   1. GET /api/settings/export → grab the bundle for the dev workspace.
 *   2. Mutate the bundle so the first workspace's rootPath points at a
 *      directory that does NOT exist on the test box.
 *   3. POST the mutated bundle → expect a `paused` response with
 *      `kind: "missing_root"`.
 *   4. mkdir a real heal target, POST a `heal` decision → expect `done`.
 *   5. Confirm the new workspace landed at the healed path via
 *      `GET /api/workspaces`.
 */
test.describe("Settings backup — export/import round-trip", () => {
  test("missing rootPath pauses, heal advances to done", async ({ request, baseURL }) => {
    // 1. Export.
    const exportRes = await request.get(`${baseURL}/api/settings/export`);
    expect(exportRes.ok()).toBeTruthy();
    const bundle = (await exportRes.json()) as SettingsBundle;
    expect(bundle.version).toBe(1);
    expect(bundle.workspaces.length).toBeGreaterThan(0);

    // 2. Build a fresh bundle with a single workspace pointing at a
    //    definitely-missing path. We don't import the original bundle
    //    verbatim — that would race with the dev server's own workspaces
    //    and pollute the index for later specs. A standalone bundle keeps
    //    the test surface tight.
    const tmpRoot = mkdtempSync(join(tmpdir(), "claudius-backup-spec-"));
    const bogusRoot = join(tmpRoot, "missing-on-purpose");
    const healedRoot = join(tmpRoot, "healed-target");
    mkdirSync(healedRoot, { recursive: true });
    // Unique marker so we can distinguish this row in `GET /api/workspaces`
    // without colliding with whatever the dev workspace is named.
    const marker = `imported-${Date.now().toString(36)}`;
    const mutated: SettingsBundle = {
      ...bundle,
      // Drop system blobs — irrelevant to the round-trip we're asserting.
      system: {},
      workspaces: [
        {
          meta: {
            id: `wks_e2e_${Date.now().toString(36)}`,
            name: marker,
            rootPath: bogusRoot,
            icon: { kind: "letter", letter: "E", color: "#abcdef" },
            createdAt: Date.now(),
            updatedAt: Date.now(),
          },
          projectSettings: { outputStyle: "concise" },
        },
      ],
    };

    try {
      // 3. Start import → paused.
      const startRes = await request.post(`${baseURL}/api/settings/import`, {
        data: mutated,
        headers: { "Content-Type": "application/json" },
      });
      expect(startRes.ok()).toBeTruthy();
      const start = (await startRes.json()) as ImportProgress;
      expect(start.state).toBe("paused");
      if (start.state !== "paused") return;
      expect(start.pause.kind).toBe("missing_root");

      // 4. Heal → done.
      const resolveRes = await request.post(
        `${baseURL}/api/settings/import/${start.importId}/resolve`,
        {
          data: {
            wsIndex: start.pause.wsIndex,
            decision: { kind: "heal", newRootPath: healedRoot },
          },
          headers: { "Content-Type": "application/json" },
        },
      );
      expect(resolveRes.ok()).toBeTruthy();
      const done = (await resolveRes.json()) as ImportProgress;
      expect(done.state).toBe("done");

      // 5. Workspace list now contains our healed row at the healed path.
      const listRes = await request.get(`${baseURL}/api/workspaces`);
      expect(listRes.ok()).toBeTruthy();
      const { workspaces } = (await listRes.json()) as {
        workspaces: Array<{ id: string; name: string; rootPath: string }>;
      };
      const landed = workspaces.find((w) => w.name === marker);
      expect(landed, "healed workspace should appear in /api/workspaces").toBeTruthy();
      expect(landed!.rootPath).toBe(healedRoot);

      // Clean up the workspace row so later specs don't see leftovers.
      await request.delete(`${baseURL}/api/workspaces/${landed!.id}`).catch(() => {});
    } finally {
      try {
        rmSync(tmpRoot, { recursive: true, force: true });
      } catch {
        // best-effort
      }
    }
  });
});
