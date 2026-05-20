import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";

import { afterEach, beforeEach, describe, expect, test } from "vitest";

import {
  mergeDeep,
  resolve as resolveImport,
  startImport,
  validateBundle,
} from "@/lib/server/settings-import";
import { listWorkspaces, workspacesFile } from "@/lib/server/workspaces-store";
import type { SettingsBundle } from "@/lib/shared/settings-bundle";

import { makeTempHome, type TmpHome } from "./helpers/tmp-home";

/**
 * Covers the three responsibilities of `settings-import.ts`:
 *
 *   1. Bundle validation — rejects malformed payloads up front so the
 *      worker doesn't have to be defensive at every step.
 *   2. `mergeDeep` semantics — the only piece of "smart" logic that runs
 *      against the user's existing files, so it gets its own test.
 *   3. The pause/resolve loop — start with a missing rootPath, heal it,
 *      assert the workspace landed at the healed path.
 */

let tmp: TmpHome;

beforeEach(() => {
  tmp = makeTempHome();
  // Workspaces-store seeds a default workspace from process.cwd() on first
  // call. Pre-write an empty workspaces.json so we have a clean slate to
  // diff against in each test.
  mkdirSync(join(tmp.home, ".claude", ".claudius"), { recursive: true });
  writeFileSync(
    workspacesFile(),
    JSON.stringify({ version: 1, workspaces: [] }, null, 2),
    "utf8",
  );
});

afterEach(() => {
  tmp.restore();
});

// ── validateBundle ────────────────────────────────────────────────────────

describe("validateBundle", () => {
  test("accepts a minimal well-formed bundle", () => {
    const bundle: SettingsBundle = {
      version: 1,
      exportedAt: 1,
      exportedFrom: { hostname: "x", platform: "darwin" },
      system: {},
      workspaces: [],
    };
    expect(validateBundle(bundle)).toBe(true);
  });

  test("rejects wrong version", () => {
    expect(validateBundle({ version: 2, workspaces: [] })).toBe(false);
  });

  test("rejects missing workspaces array", () => {
    expect(validateBundle({ version: 1 })).toBe(false);
  });

  test("rejects workspace without id or rootPath", () => {
    expect(
      validateBundle({
        version: 1,
        workspaces: [{ meta: { id: "x" } }],
      }),
    ).toBe(false);
  });
});

// ── mergeDeep ────────────────────────────────────────────────────────────

describe("mergeDeep", () => {
  test("objects merge recursively, scalars import-wins", () => {
    const out = mergeDeep(
      { a: 1, nested: { x: 1, y: 2 } },
      { a: 2, nested: { y: 99, z: 3 } },
    );
    expect(out).toEqual({ a: 2, nested: { x: 1, y: 99, z: 3 } });
  });

  test("arrays union, target order preserved", () => {
    const out = mergeDeep(["a", "b"], ["b", "c"]);
    expect(out).toEqual(["a", "b", "c"]);
  });

  test("array of objects deduped by stable key", () => {
    const out = mergeDeep(
      [{ id: "a" }, { id: "b" }],
      [{ id: "b" }, { id: "c" }],
    );
    expect(out).toEqual([{ id: "a" }, { id: "b" }, { id: "c" }]);
  });

  test("null source does not wipe target value", () => {
    const out = mergeDeep<{ a: number | null }>({ a: 1 }, { a: null });
    expect(out).toEqual({ a: 1 });
  });
});

// ── Pause / resolve loop ─────────────────────────────────────────────────

describe("startImport with missing rootPath pauses, heals, completes", () => {
  test("happy path", async () => {
    // The bundle wants a workspace at `/tmp/never-going-to-exist-xyz`.
    const bogusRoot = join(tmp.home, "does-not-exist");
    const bundle: SettingsBundle = {
      version: 1,
      exportedAt: 1,
      exportedFrom: { hostname: "src", platform: "darwin" },
      system: {},
      workspaces: [
        {
          meta: {
            id: "wks_imported",
            name: "Imported",
            rootPath: bogusRoot,
            icon: { kind: "letter", letter: "I", color: "#aabbcc" },
            createdAt: 100,
            updatedAt: 100,
          },
          projectSettings: { model: "claude-sonnet-4-6" },
        },
      ],
    };

    const first = await startImport(bundle);
    expect(first.state).toBe("paused");
    if (first.state !== "paused") return;
    expect(first.pause.kind).toBe("missing_root");
    expect(first.pause.wsIndex).toBe(0);

    // Heal: make a real directory and point the workspace at it.
    const healed = join(tmp.home, "imported-project");
    mkdirSync(healed, { recursive: true });

    const second = await resolveImport(first.importId, {
      wsIndex: 0,
      decision: { kind: "heal", newRootPath: healed },
    });
    expect(second.state).toBe("done");
    if (second.state !== "done") return;
    expect(second.processed).toBe(1);

    // Workspaces store now has the row at the healed rootPath, with the
    // bundle's name and a fresh id.
    const list = await listWorkspaces();
    const landed = list.find((w) => w.rootPath === healed);
    expect(landed).toBeDefined();
    expect(landed!.name).toBe("Imported");
    expect(landed!.icon).toEqual({ kind: "letter", letter: "I", color: "#aabbcc" });

    // Project settings made it into the healed dir.
    const written = JSON.parse(
      readFileSync(join(healed, ".claude", "settings.json"), "utf8"),
    );
    expect(written).toEqual({ model: "claude-sonnet-4-6" });

    // Log records the healed action.
    expect(second.log[0].action).toBe("healed");
  });

  test("skip decision drops the workspace, no row created", async () => {
    const bogusRoot = join(tmp.home, "skip-me");
    const bundle: SettingsBundle = {
      version: 1,
      exportedAt: 1,
      exportedFrom: { hostname: "src", platform: "darwin" },
      system: {},
      workspaces: [
        {
          meta: {
            id: "wks_skip",
            name: "Skip",
            rootPath: bogusRoot,
            icon: { kind: "letter", letter: "S", color: "#000" },
            createdAt: 1,
            updatedAt: 1,
          },
        },
      ],
    };

    const first = await startImport(bundle);
    expect(first.state).toBe("paused");
    if (first.state !== "paused") return;

    const second = await resolveImport(first.importId, {
      wsIndex: 0,
      decision: { kind: "skip" },
    });
    expect(second.state).toBe("done");

    const list = await listWorkspaces();
    expect(list.find((w) => w.name === "Skip")).toBeUndefined();
  });

  test("not_a_directory pauses, heal to a real directory succeeds", async () => {
    // Put a regular file where the workspace expects a directory.
    const filePath = join(tmp.home, "is-a-file");
    writeFileSync(filePath, "not a dir", "utf8");
    const bundle: SettingsBundle = {
      version: 1,
      exportedAt: 1,
      exportedFrom: { hostname: "src", platform: "darwin" },
      system: {},
      workspaces: [
        {
          meta: {
            id: "wks_notdir",
            name: "NotDir",
            rootPath: filePath,
            icon: { kind: "letter", letter: "N", color: "#000" },
            createdAt: 1,
            updatedAt: 1,
          },
        },
      ],
    };

    const first = await startImport(bundle);
    expect(first.state).toBe("paused");
    if (first.state !== "paused") return;
    expect(first.pause.kind).toBe("not_a_directory");

    const healed = join(tmp.home, "notdir-healed");
    mkdirSync(healed, { recursive: true });
    const second = await resolveImport(first.importId, {
      wsIndex: 0,
      decision: { kind: "heal", newRootPath: healed },
    });
    expect(second.state).toBe("done");

    const list = await listWorkspaces();
    expect(list.find((w) => w.rootPath === healed)?.name).toBe("NotDir");
  });

  test("path collision pauses then rename creates a fresh row", async () => {
    // Pre-seed a workspace at /tmp/.../shared so the incoming bundle
    // collides on rootPath, not id.
    const shared = join(tmp.home, "shared");
    mkdirSync(shared, { recursive: true });
    writeFileSync(
      workspacesFile(),
      JSON.stringify(
        {
          version: 1,
          activeId: "wks_local",
          workspaces: [
            {
              id: "wks_local",
              name: "Local",
              rootPath: shared,
              icon: { kind: "letter", letter: "L", color: "#000" },
              createdAt: 1,
              updatedAt: 1,
            },
          ],
        },
        null,
        2,
      ),
      "utf8",
    );

    const bundle: SettingsBundle = {
      version: 1,
      exportedAt: 1,
      exportedFrom: { hostname: "src", platform: "darwin" },
      system: {},
      workspaces: [
        {
          meta: {
            id: "wks_incoming",
            name: "Incoming",
            rootPath: shared,
            icon: { kind: "letter", letter: "I", color: "#fff" },
            createdAt: 1,
            updatedAt: 1,
          },
        },
      ],
    };

    const first = await startImport(bundle);
    expect(first.state).toBe("paused");
    if (first.state !== "paused") return;
    expect(first.pause.kind).toBe("path_collision");

    const second = await resolveImport(first.importId, {
      wsIndex: 0,
      decision: { kind: "rename", newName: "Incoming (renamed)" },
    });
    expect(second.state).toBe("done");

    const list = await listWorkspaces();
    expect(list.find((w) => w.name === "Local")).toBeDefined();
    const renamed = list.find((w) => w.name === "Incoming (renamed)");
    expect(renamed).toBeDefined();
    // Rename creates a new workspace — a fresh id, not "wks_incoming".
    expect(renamed!.id).not.toBe("wks_incoming");
  });

  test("system merge writes user settings and keybindings", async () => {
    // Note: updater settings live at `~/.claude/.claudius/updater.json` but
    // `updater/settings.ts` resolves that path at module-load time via a
    // top-level `const`. The unit test redirects HOME after the module has
    // already been imported by the test runner, so updater writes go to
    // whichever HOME was in effect first — not a sandbox we can assert
    // against here. The route + e2e spec cover that path against the live
    // dev server's per-run tempdir HOME.
    const bundle: SettingsBundle = {
      version: 1,
      exportedAt: 1,
      exportedFrom: { hostname: "src", platform: "darwin" },
      system: {
        userSettings: { model: "claude-opus-4-7", env: { FROM_BUNDLE: "yes" } },
        keybindings: { bindings: [{ key: "ctrl+q", command: "quit" }] },
      },
      workspaces: [],
    };

    const result = await startImport(bundle);
    expect(result.state).toBe("done");

    const userSettingsPath = join(tmp.home, ".claude", "settings.json");
    const userSettings = JSON.parse(readFileSync(userSettingsPath, "utf8"));
    expect(userSettings.model).toBe("claude-opus-4-7");
    expect(userSettings.env).toEqual({ FROM_BUNDLE: "yes" });

    const kbPath = join(tmp.home, ".claude", "keybindings.json");
    const kb = JSON.parse(readFileSync(kbPath, "utf8"));
    expect(kb.bindings).toContainEqual({ key: "ctrl+q", command: "quit" });
  });

  test("icon bytes are restored under the new workspace id", async () => {
    const healed = join(tmp.home, "with-icon");
    mkdirSync(healed, { recursive: true });
    const iconBytes = Buffer.from([0xff, 0xd8, 0xff, 0xe0]); // JPEG magic
    const bundle: SettingsBundle = {
      version: 1,
      exportedAt: 1,
      exportedFrom: { hostname: "src", platform: "darwin" },
      system: {},
      workspaces: [
        {
          meta: {
            id: "wks_iconic",
            name: "Iconic",
            rootPath: healed,
            icon: { kind: "image", ext: "jpg" },
            createdAt: 1,
            updatedAt: 1,
          },
          iconBytes: { ext: "jpg", base64: iconBytes.toString("base64") },
        },
      ],
    };

    const result = await startImport(bundle);
    expect(result.state).toBe("done");

    const list = await listWorkspaces();
    const row = list.find((w) => w.name === "Iconic");
    expect(row).toBeDefined();
    const iconPath = join(
      tmp.home,
      ".claude",
      ".claudius",
      "workspace-icons",
      `${row!.id}.jpg`,
    );
    expect(readFileSync(iconPath)).toEqual(iconBytes);
  });

  test("id collision pauses then overwrites in place", async () => {
    // Pre-seed an existing workspace with the same id the bundle uses.
    const existingRoot = join(tmp.home, "existing");
    mkdirSync(existingRoot, { recursive: true });
    writeFileSync(
      workspacesFile(),
      JSON.stringify(
        {
          version: 1,
          activeId: "wks_dup",
          workspaces: [
            {
              id: "wks_dup",
              name: "Existing",
              rootPath: existingRoot,
              icon: { kind: "letter", letter: "E", color: "#000" },
              createdAt: 1,
              updatedAt: 1,
            },
          ],
        },
        null,
        2,
      ),
      "utf8",
    );

    const bundle: SettingsBundle = {
      version: 1,
      exportedAt: 1,
      exportedFrom: { hostname: "src", platform: "darwin" },
      system: {},
      workspaces: [
        {
          meta: {
            id: "wks_dup",
            name: "From Bundle",
            rootPath: existingRoot,
            icon: { kind: "letter", letter: "B", color: "#ffffff" },
            createdAt: 5,
            updatedAt: 5,
          },
        },
      ],
    };

    const first = await startImport(bundle);
    expect(first.state).toBe("paused");
    if (first.state !== "paused") return;
    expect(first.pause.kind).toBe("id_collision");

    const second = await resolveImport(first.importId, {
      wsIndex: 0,
      decision: { kind: "overwrite" },
    });
    expect(second.state).toBe("done");

    const list = await listWorkspaces();
    // Same id, but the bundle's name took over.
    const row = list.find((w) => w.id === "wks_dup");
    expect(row).toBeDefined();
    expect(row!.name).toBe("From Bundle");
    expect(row!.icon).toEqual({ kind: "letter", letter: "B", color: "#ffffff" });
  });
});
