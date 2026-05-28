import { afterEach, beforeEach, describe, expect, test } from "vitest";

import {
  DEFAULT_WORKSPACE_DEFAULTS,
  createWorkspace,
  ensureBootstrap,
  getWorkspace,
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

  test("ensureBootstrap stamps bypassPermissions on the first-run workspace", async () => {
    const shape = await ensureBootstrap();
    expect(shape.workspaces).toHaveLength(1);
    expect(shape.workspaces[0].defaults?.permissionMode).toBe("bypassPermissions");
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
