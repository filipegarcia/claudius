import { afterEach, beforeEach, describe, expect, test } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  readSettings,
  updateAutoMode,
  updatePermissionRuleList,
  updateSkillOverride,
  withSettingsFileLock,
  withSettingsLock,
  writeSettings,
} from "@/lib/server/settings";
import { setEnabled } from "@/lib/server/plugins";
import { addGroup } from "@/lib/server/hooks";
import { upsertServer } from "@/lib/server/mcp";

import { makeTempHome, type TmpHome } from "./helpers/tmp-home";

/**
 * CC 2.1.330 — "Fixed changes to user settings being lost when several Claude
 * Code processes saved them at the same time". Claudius's own writers were each
 * an unlocked read → change → write, so saves landing together each read the
 * same old file and the later write dropped the earlier change.
 */
let tmp: TmpHome;
let cwd: string;

beforeEach(() => {
  tmp = makeTempHome();
  cwd = mkdtempSync(join(tmpdir(), "claudius-settings-lock-"));
});

afterEach(() => {
  tmp.restore();
  rmSync(cwd, { recursive: true, force: true });
});

const N = 12;

describe("settings writes landing together keep every change (2.1.330)", () => {
  test("concurrent permission-rule adds on one file all survive", async () => {
    await Promise.all(
      Array.from({ length: N }, (_, i) => updatePermissionRuleList("project", cwd, "allow", { add: [`Bash(echo ${i})`] })),
    );
    const allow = (await readSettings("project", cwd)).permissions?.allow ?? [];
    expect([...allow].sort()).toEqual(Array.from({ length: N }, (_, i) => `Bash(echo ${i})`).sort());
  });

  test("different writers to the same file keep each other's keys", async () => {
    await Promise.all([
      ...Array.from({ length: N }, (_, i) => updateSkillOverride(cwd, `skill-${i}`, "off")),
      ...Array.from({ length: N }, (_, i) => setEnabled("project", cwd, `plugin-${i}@market`, true)),
      ...Array.from({ length: 4 }, (_, i) =>
        addGroup("project", cwd, "PreToolUse", { matcher: `Tool${i}`, hooks: [{ type: "command", command: "true" }] }),
      ),
    ]);
    const s = await readSettings("project", cwd);
    expect(Object.keys(s.skillOverrides ?? {})).toHaveLength(N);
    expect(Object.keys((s.enabledPlugins as Record<string, unknown>) ?? {})).toHaveLength(N);
    expect(((s.hooks as Record<string, unknown[]>) ?? {}).PreToolUse).toHaveLength(4);
  });

  test("an MCP add and an auto-mode save to user settings keep both (shared lock, no deadlock)", async () => {
    await Promise.all([
      ...Array.from({ length: 6 }, (_, i) => upsertServer("user", cwd, `srv-${i}`, { command: "true" })),
      ...Array.from({ length: 6 }, (_, i) => updateAutoMode(cwd, { allow: [`rule ${i}`] })),
    ]);
    const s = await readSettings("user", cwd);
    expect(Object.keys((s.mcpServers as Record<string, unknown>) ?? {})).toHaveLength(6);
    expect(s.autoMode).toBeDefined();
  });

  test("the lock is re-entrant: a nested hold of the same file runs straight through", async () => {
    const result = await withSettingsLock("project", cwd, async () => {
      // Would deadlock on a non-re-entrant chain.
      await updatePermissionRuleList("project", cwd, "deny", { add: ["Read(./secret)"] });
      return withSettingsLock("project", cwd, async () => (await readSettings("project", cwd)).permissions?.deny);
    });
    expect(result).toEqual(["Read(./secret)"]);
  });

  test("a writer that throws releases the lock for the next one", async () => {
    const file = join(cwd, "lock-key");
    await expect(withSettingsFileLock(file, async () => Promise.reject(new Error("boom")))).rejects.toThrow("boom");
    await expect(withSettingsFileLock(file, async () => "next")).resolves.toBe("next");
  });

  test("a held file still serializes callers outside the holder", async () => {
    const order: string[] = [];
    let release!: () => void;
    const gate = new Promise<void>((r) => (release = r));
    const first = withSettingsLock("local", cwd, async () => {
      order.push("first:start");
      await gate;
      await writeSettings("local", cwd, { model: "a" });
      order.push("first:end");
    });
    const second = withSettingsLock("local", cwd, async () => {
      order.push("second");
    });
    await new Promise((r) => setTimeout(r, 10));
    release();
    await Promise.all([first, second]);
    expect(order).toEqual(["first:start", "first:end", "second"]);
  });
});
