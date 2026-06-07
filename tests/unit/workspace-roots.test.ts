import { promises as fs } from "node:fs";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, test } from "vitest";

import { createWorkspace } from "@/lib/server/workspaces-store";
import { listWorkspaceRoots, resolveWorkspaceRoot } from "@/lib/server/workspace-roots";
import { makeTempHome, type TmpHome } from "./helpers/tmp-home";

/**
 * Pins the contract that drives the /api/workspaces/:id/files multi-root
 * surface. The list is the union of:
 *   1. workspace.defaults.additionalDirectories (set via the workspace form)
 *   2. project-scope settings.permissions.additionalDirectories (what
 *      `/add-dir` writes)
 *
 * The Files page treats the returned ids as opaque selectors — the index
 * has to be stable across calls, and dedupes by resolved absolute path so
 * the same dir written to both stores only shows once.
 */
describe("workspace-roots union", () => {
  let home: TmpHome;
  let projectRoot: string;

  beforeEach(async () => {
    home = makeTempHome();
    projectRoot = join(home.home, "project");
    await fs.mkdir(projectRoot, { recursive: true });
  });
  afterEach(() => {
    home.restore();
  });

  test("lists only the primary root when no extras are configured", async () => {
    const ws = await createWorkspace({ name: "Proj", rootPath: projectRoot });
    const roots = await listWorkspaceRoots(ws);
    expect(roots).toEqual([{ id: "primary", absPath: projectRoot, source: "primary" }]);
  });

  test("appends workspace defaults extras after primary, indexed from 0", async () => {
    const a = join(home.home, "a");
    const b = join(home.home, "b");
    const ws = await createWorkspace({
      name: "Proj",
      rootPath: projectRoot,
      defaults: { additionalDirectories: [a, b] },
    });
    const roots = await listWorkspaceRoots(ws);
    expect(roots.map((r) => r.id)).toEqual(["primary", "extra:0", "extra:1"]);
    expect(roots.map((r) => r.source)).toEqual(["primary", "workspace", "workspace"]);
    expect(roots[1].absPath).toBe(a);
    expect(roots[2].absPath).toBe(b);
  });

  test("appends project-scope settings extras after the workspace ones", async () => {
    const a = join(home.home, "a");
    const b = join(home.home, "b");
    const ws = await createWorkspace({
      name: "Proj",
      rootPath: projectRoot,
      defaults: { additionalDirectories: [a] },
    });
    // Mimic what `/add-dir` writes to project-scope settings.json.
    const settingsDir = join(projectRoot, ".claude");
    await fs.mkdir(settingsDir, { recursive: true });
    await fs.writeFile(
      join(settingsDir, "settings.json"),
      JSON.stringify({ permissions: { additionalDirectories: [b] } }),
    );

    const roots = await listWorkspaceRoots(ws);
    expect(roots.map((r) => r.id)).toEqual(["primary", "extra:0", "extra:1"]);
    expect(roots.map((r) => r.source)).toEqual(["primary", "workspace", "settings"]);
    expect(roots[1].absPath).toBe(a);
    expect(roots[2].absPath).toBe(b);
  });

  test("dedupes by resolved absolute path so the same dir from both stores collapses", async () => {
    const dup = join(home.home, "shared");
    const ws = await createWorkspace({
      name: "Proj",
      rootPath: projectRoot,
      defaults: { additionalDirectories: [dup] },
    });
    const settingsDir = join(projectRoot, ".claude");
    await fs.mkdir(settingsDir, { recursive: true });
    await fs.writeFile(
      join(settingsDir, "settings.json"),
      JSON.stringify({ permissions: { additionalDirectories: [dup] } }),
    );

    const roots = await listWorkspaceRoots(ws);
    // The earlier source (workspace defaults) wins — `extra:0` stays the
    // workspace-defined one, settings.json's duplicate vanishes.
    expect(roots).toHaveLength(2);
    expect(roots[1]).toEqual({ id: "extra:0", absPath: dup, source: "workspace" });
  });

  test("the primary cwd shadows an extras entry that points at the same dir", async () => {
    const ws = await createWorkspace({
      name: "Proj",
      rootPath: projectRoot,
      defaults: { additionalDirectories: [projectRoot] },
    });
    const roots = await listWorkspaceRoots(ws);
    expect(roots).toHaveLength(1);
    expect(roots[0].source).toBe("primary");
  });

  test("resolveWorkspaceRoot defaults missing selector to primary", async () => {
    const ws = await createWorkspace({ name: "Proj", rootPath: projectRoot });
    const r1 = await resolveWorkspaceRoot(ws.id, null);
    const r2 = await resolveWorkspaceRoot(ws.id, "");
    const r3 = await resolveWorkspaceRoot(ws.id, undefined);
    expect(r1?.root.id).toBe("primary");
    expect(r2?.root.id).toBe("primary");
    expect(r3?.root.id).toBe("primary");
  });

  test("resolveWorkspaceRoot returns null for an out-of-range extra selector", async () => {
    const ws = await createWorkspace({
      name: "Proj",
      rootPath: projectRoot,
      defaults: { additionalDirectories: [join(home.home, "a")] },
    });
    expect(await resolveWorkspaceRoot(ws.id, "extra:0")).not.toBeNull();
    expect(await resolveWorkspaceRoot(ws.id, "extra:99")).toBeNull();
    expect(await resolveWorkspaceRoot(ws.id, "garbage")).toBeNull();
  });

  test("resolveWorkspaceRoot returns null when the workspace itself is unknown", async () => {
    expect(await resolveWorkspaceRoot("ws_does_not_exist", "primary")).toBeNull();
  });
});
