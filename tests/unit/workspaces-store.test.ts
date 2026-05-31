import { promises as fs } from "node:fs";
import { dirname, basename } from "node:path";
import { afterEach, beforeEach, describe, expect, test } from "vitest";

import {
  DEFAULT_WORKSPACE_DEFAULTS,
  createWorkspace,
  ensureBootstrap,
  getWorkspace,
  workspacesFile,
} from "@/lib/server/workspaces-store";
import { makeTempHome, type TmpHome } from "./helpers/tmp-home";

/**
 * Pins the workspace-creation defaults. The product rule is "by default all
 * workspaces bypass permissions, with notifications on and errors muted."
 *
 * Bypass-permissions is the only piece enforced at the data layer (here):
 * notifications-on / errors-muted already fall out of the `DEFAULT_ENABLED_KINDS`
 * fallback — covered by `notification-bus.pure.test.ts` — so these tests assert
 * that we *don't* pin notification prefs onto new workspaces (so the fallback
 * keeps applying) while we *do* pin `permissionMode`.
 *
 * The merge contract is "default under caller", matching `mergeSessionDefaults`:
 * an explicit per-field choice wins; absent fields fall back to the default.
 */
describe("workspace creation defaults", () => {
  let home: TmpHome;

  beforeEach(() => {
    home = makeTempHome();
  });
  afterEach(() => {
    home.restore();
  });

  test("the pinned default is bypassPermissions and nothing else", () => {
    // If this changes, the comment in workspaces-store.ts and the rationale
    // in the tests below need revisiting — hence an exact-match assertion.
    expect(DEFAULT_WORKSPACE_DEFAULTS).toEqual({ permissionMode: "bypassPermissions" });
  });

  test("ensureBootstrap no longer auto-seeds a workspace on first run", async () => {
    // First-run is now a zero-workspace state — the app routes to /welcome
    // rather than booting into a bogus "claudius" workspace pointed at the
    // source checkout. So bootstrap returns an empty shape, not a seeded one.
    const shape = await ensureBootstrap();
    expect(shape.workspaces).toHaveLength(0);
    expect(shape.activeId).toBeUndefined();
  });

  test("createWorkspace with no defaults still gets bypassPermissions", async () => {
    const ws = await createWorkspace({ name: "Proj", rootPath: "/tmp/proj-a" });
    expect(ws.defaults?.permissionMode).toBe("bypassPermissions");

    // …and it round-trips through the store, not just the return value.
    const fetched = await getWorkspace(ws.id);
    expect(fetched?.defaults?.permissionMode).toBe("bypassPermissions");
  });

  test("an explicit permissionMode wins over the default (default under caller)", async () => {
    const ws = await createWorkspace({
      name: "Planner",
      rootPath: "/tmp/proj-b",
      defaults: { permissionMode: "plan" },
    });
    expect(ws.defaults?.permissionMode).toBe("plan");
  });

  test("caller defaults merge alongside the pinned default", async () => {
    const ws = await createWorkspace({
      name: "Modelled",
      rootPath: "/tmp/proj-c",
      defaults: { model: "claude-opus-4-7" },
    });
    // Caller field is kept…
    expect(ws.defaults?.model).toBe("claude-opus-4-7");
    // …and the gap is filled by the pinned default.
    expect(ws.defaults?.permissionMode).toBe("bypassPermissions");
  });

  test("notification prefs are NOT pinned, so the on/errors-muted fallback applies", async () => {
    // Leaving `notifications` absent is deliberate: `isKindEnabled` falls back
    // to DEFAULT_ENABLED_KINDS (notifications on, session_error off). Pinning a
    // kind list here would freeze new workspaces to today's set.
    const ws = await createWorkspace({ name: "Quiet", rootPath: "/tmp/proj-d" });
    expect(ws.defaults?.notifications).toBeUndefined();
  });
});

/**
 * Auto-backup contract: every write of workspaces.json snapshots the prior
 * contents next to it. Pinned so a future refactor can't silently drop the
 * safety net — the original loss that motivated it (2026-05-30 `bun test`
 * clobber) had no on-disk recovery path.
 */
describe("workspaces.json auto-backup", () => {
  let home: TmpHome;

  beforeEach(() => {
    home = makeTempHome();
  });
  afterEach(() => {
    home.restore();
  });

  test("a write snapshots the prior file contents into a .bak.<stamp>", async () => {
    // First write: nothing to snapshot.
    await createWorkspace({ name: "First", rootPath: "/tmp/proj-first" });
    const file = workspacesFile();
    const after1 = await fs.readFile(file, "utf8");

    // Second write: the prior contents must now appear in a sibling .bak file.
    await createWorkspace({ name: "Second", rootPath: "/tmp/proj-second" });
    const dir = dirname(file);
    const base = basename(file);
    const entries = await fs.readdir(dir);
    const baks = entries.filter((e) => e.startsWith(`${base}.bak.`));
    expect(baks.length).toBeGreaterThanOrEqual(1);

    // The newest backup matches what the file looked like before the 2nd write.
    const newest = baks.sort().at(-1);
    expect(newest).toBeDefined();
    const backed = await fs.readFile(`${dir}/${newest}`, "utf8");
    expect(backed).toBe(after1);
  });
});
