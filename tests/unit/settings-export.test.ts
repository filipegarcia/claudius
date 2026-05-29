import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";

import { afterEach, beforeEach, describe, expect, test } from "vitest";

import { buildExportBundle, suggestedFilename } from "@/lib/server/settings-export";
import { writeFakeWorkspace } from "./helpers/fake-workspace";
import { makeTempHome, type TmpHome } from "./helpers/tmp-home";

/**
 * The exporter is the easy half of the feature — it walks a known set of
 * paths and serializes whatever it finds. These tests pin its behavior on
 * the two interesting cases:
 *
 *   1. Empty machine (no user settings, no workspaces). The bundle still
 *      shapes correctly.
 *   2. Populated machine with system + per-workspace files, plus an icon
 *      on disk. Every piece round-trips into the bundle.
 *
 * The harder pieces — deep-merge semantics, hazard detection during import
 * — live in `settings-import.test.ts`.
 */

let tmp: TmpHome;

beforeEach(() => {
  tmp = makeTempHome();
});

afterEach(() => {
  tmp.restore();
});

describe("buildExportBundle", () => {
  test("empty machine emits a well-shaped bundle", async () => {
    const bundle = await buildExportBundle();
    expect(bundle.version).toBe(1);
    expect(typeof bundle.exportedAt).toBe("number");
    expect(bundle.exportedFrom.hostname).toBeTruthy();
    // updater settings always present (the file defaults are returned even
    // when nothing's on disk) — userSettings/customize/keybindings can be
    // omitted entirely.
    expect(bundle.system.updaterSettings).toBeDefined();
    // ensureBootstrap in workspaces-store will create one workspace from
    // process.cwd() on first call. We don't depend on the count here, but
    // it should be ≥ 1.
    expect(Array.isArray(bundle.workspaces)).toBe(true);
  });

  test("includes user settings, project settings, and icon bytes", async () => {
    // Populate ~/.claude/settings.json
    const claudeDir = join(tmp.home, ".claude");
    mkdirSync(claudeDir, { recursive: true });
    writeFileSync(
      join(claudeDir, "settings.json"),
      JSON.stringify({ model: "claude-opus-4-7", env: { FOO: "bar" } }),
      "utf8",
    );

    // Create a workspace WITH a real on-disk rootPath so project settings
    // can be written into <root>/.claude/settings.json.
    const wsRoot = join(tmp.home, "my-project");
    mkdirSync(join(wsRoot, ".claude"), { recursive: true });
    writeFileSync(
      join(wsRoot, ".claude", "settings.json"),
      JSON.stringify({ theme: "dark" }),
      "utf8",
    );
    writeFileSync(
      join(wsRoot, ".claude", "settings.local.json"),
      JSON.stringify({ statusLine: { type: "command", command: "/bin/echo hi" } }),
      "utf8",
    );

    const ws = writeFakeWorkspace({ rootPath: wsRoot });

    // Drop a fake icon file under workspace-icons/<id>.png.
    const iconsDir = join(tmp.home, ".claude", ".claudius", "workspace-icons");
    mkdirSync(iconsDir, { recursive: true });
    const iconBytes = Buffer.from([0x89, 0x50, 0x4e, 0x47]); // PNG magic
    writeFileSync(join(iconsDir, `${ws.id}.png`), iconBytes);

    const bundle = await buildExportBundle();

    expect(bundle.system.userSettings).toEqual({
      model: "claude-opus-4-7",
      env: { FOO: "bar" },
    });

    const bundled = bundle.workspaces.find((w) => w.meta.id === ws.id);
    expect(bundled).toBeDefined();
    expect(bundled!.meta.rootPath).toBe(wsRoot);
    expect(bundled!.projectSettings).toEqual({ theme: "dark" });
    expect(bundled!.localSettings).toEqual({
      statusLine: { type: "command", command: "/bin/echo hi" },
    });
    expect(bundled!.iconBytes?.ext).toBe("png");
    expect(Buffer.from(bundled!.iconBytes!.base64, "base64")).toEqual(iconBytes);
  });
});

describe("suggestedFilename", () => {
  test("uses the export timestamp", () => {
    const at = Date.UTC(2025, 3, 9, 12, 0, 0); // 2025-04-09
    expect(suggestedFilename(at)).toBe("claudius-backup-2025-04-09.json");
  });
});
