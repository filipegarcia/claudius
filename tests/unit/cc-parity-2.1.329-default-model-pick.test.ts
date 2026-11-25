import { afterEach, beforeEach, describe, expect, test } from "vitest";
import { promises as fs } from "node:fs";
import { join } from "node:path";
import { homedir } from "node:os";
import { Session } from "@/lib/server/session";
import { openDb } from "@/lib/server/db";
import { savedModelAfterPick } from "@/lib/shared/default-model-pick";
import { makeTempHome, type TmpHome } from "./helpers/tmp-home";

/**
 * CC 2.1.329 — "Fixed choosing Default in `/model` replacing your saved model
 * with your organization's default when the Default row already showed your
 * saved model".
 *
 * Picking the SDK's Default row (value `"default"`) wrote the literal
 * `"model": "default"` into ~/.claude/settings.json, so the next new session
 * ran whatever "default" resolved to past the saved model.
 */

const CATALOG = [
  { value: "default", resolvedModel: "claude-opus-5-5" },
  { value: "opus", resolvedModel: "claude-opus-5-5" },
  { value: "sonnet", resolvedModel: "claude-sonnet-5-5" },
  { value: "opus[1m]", resolvedModel: "claude-opus-5-5[1m]" },
];

describe("savedModelAfterPick", () => {
  test("Default keeps the saved model when the Default row showed it", () => {
    expect(savedModelAfterPick("default", "opus", CATALOG)).toBeNull();
    expect(savedModelAfterPick("default", "claude-opus-5-5", CATALOG)).toBeNull();
    expect(savedModelAfterPick("default", "Claude-Opus-5-5", CATALOG)).toBeNull();
  });

  test("Default otherwise deletes the key, never writing the literal", () => {
    expect(savedModelAfterPick("default", "sonnet", CATALOG)).toEqual({ model: undefined });
    expect(savedModelAfterPick("default", "opus[1m]", CATALOG)).toEqual({ model: undefined });
    expect(savedModelAfterPick("default", "sonnet", null)).toEqual({ model: undefined });
    // A literal left by the old code is cleaned up.
    expect(savedModelAfterPick("default", "default", CATALOG)).toEqual({ model: undefined });
    // Nothing saved: nothing to do.
    expect(savedModelAfterPick("default", undefined, CATALOG)).toBeNull();
  });

  test("an explicit pick is written; the same pick or clearing an empty key is a no-op", () => {
    expect(savedModelAfterPick("sonnet", "opus", CATALOG)).toEqual({ model: "sonnet" });
    expect(savedModelAfterPick("sonnet", undefined, CATALOG)).toEqual({ model: "sonnet" });
    expect(savedModelAfterPick("sonnet", "sonnet", CATALOG)).toBeNull();
    expect(savedModelAfterPick(undefined, "opus", CATALOG)).toEqual({ model: undefined });
    expect(savedModelAfterPick(undefined, undefined, CATALOG)).toBeNull();
  });
});

const CWD = "/tmp/fake-session-default-model-pick-cwd";

describe("Session.setModel('default') and ~/.claude/settings.json", () => {
  let tmp: TmpHome;
  beforeEach(async () => {
    tmp = makeTempHome();
    await openDb(CWD);
  });
  afterEach(() => tmp.restore());

  const settingsPath = () => join(homedir(), ".claude", "settings.json");
  async function writeUserSettings(obj: Record<string, unknown>) {
    await fs.mkdir(join(homedir(), ".claude"), { recursive: true });
    await fs.writeFile(settingsPath(), JSON.stringify(obj, null, 2));
  }
  async function readUserSettings(): Promise<Record<string, unknown>> {
    return JSON.parse(await fs.readFile(settingsPath(), "utf8")) as Record<string, unknown>;
  }

  function makeSession(models: typeof CATALOG) {
    const session = new Session({ id: "default-pick-test", cwd: CWD }) as unknown as {
      query: { setModel: (m?: string) => Promise<void>; supportedModels: () => Promise<typeof CATALOG> } | null;
      setModel: (model?: string, source?: "picker" | "chat_command") => Promise<{ ok: boolean }>;
    };
    session.query = { setModel: async () => {}, supportedModels: async () => models };
    return session;
  }

  test("the saved model stays when Default resolves to it", async () => {
    await writeUserSettings({ model: "opus", theme: "dark" });
    const session = makeSession(CATALOG);
    expect((await session.setModel("default", "picker")).ok).toBe(true);
    expect(await readUserSettings()).toEqual({ model: "opus", theme: "dark" });
  });

  test("the key is removed when Default resolves elsewhere — no literal \"default\"", async () => {
    await writeUserSettings({ model: "sonnet", theme: "dark" });
    const session = makeSession(CATALOG);
    expect((await session.setModel("default", "picker")).ok).toBe(true);
    expect(await readUserSettings()).toEqual({ theme: "dark" });
  });

  test("an explicit pick is still saved", async () => {
    await writeUserSettings({ model: "opus" });
    const session = makeSession(CATALOG);
    await session.setModel("sonnet", "picker");
    expect(await readUserSettings()).toEqual({ model: "sonnet" });
  });
});
