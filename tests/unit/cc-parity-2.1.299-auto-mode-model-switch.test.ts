import { afterEach, beforeEach, describe, expect, test } from "vitest";
import type { PermissionMode } from "@anthropic-ai/claude-agent-sdk";

import { Session } from "@/lib/server/session";
import { openDb } from "@/lib/server/db";
import { pendingReminderCount } from "@/lib/server/system-reminders";
import type { ServerEvent } from "@/lib/shared/events";
import {
  autoModeOffNoticeText,
  findModelInfo,
  shouldLeaveAutoForModel,
} from "@/lib/shared/permission-modes";

import { makeTempHome, type TmpHome } from "./helpers/tmp-home";

/**
 * CC 2.1.299 — "Fixed SDK and headless sessions staying in auto mode after
 * the host switched to a model that doesn't support auto mode". Claudius is
 * the host and owns the session's permission mode, so it leaves auto itself
 * when the new model's `supportedModels()` row says `supportsAutoMode: false`.
 */

describe("shouldLeaveAutoForModel", () => {
  test("leaves auto only when the model explicitly doesn't support it", () => {
    expect(shouldLeaveAutoForModel("auto", { supportsAutoMode: false })).toBe(true);
  });

  test("unknown capability (flag absent, or model not in the catalog) keeps auto", () => {
    expect(shouldLeaveAutoForModel("auto", {})).toBe(false);
    expect(shouldLeaveAutoForModel("auto", undefined)).toBe(false);
  });

  test("a model that supports auto keeps it", () => {
    expect(shouldLeaveAutoForModel("auto", { supportsAutoMode: true })).toBe(false);
  });

  test("non-auto modes are never touched", () => {
    const modes: PermissionMode[] = ["default", "acceptEdits", "plan", "dontAsk", "bypassPermissions"];
    for (const mode of modes) {
      expect(shouldLeaveAutoForModel(mode, { supportsAutoMode: false })).toBe(false);
    }
  });
});

describe("findModelInfo", () => {
  const models = [
    { value: "sonnet", resolvedModel: "claude-sonnet-5", displayName: "Sonnet 5" },
    { value: "claude-haiku-4-5", displayName: "Haiku 4.5" },
  ];

  test("matches the row's value or its resolvedModel", () => {
    expect(findModelInfo(models, "sonnet")?.displayName).toBe("Sonnet 5");
    expect(findModelInfo(models, "claude-sonnet-5")?.displayName).toBe("Sonnet 5");
    expect(findModelInfo(models, "claude-haiku-4-5")?.displayName).toBe("Haiku 4.5");
  });

  test("undefined for an unknown or missing id", () => {
    expect(findModelInfo(models, "claude-opus-9")).toBeUndefined();
    expect(findModelInfo(models, undefined)).toBeUndefined();
  });
});

test("autoModeOffNoticeText", () => {
  expect(autoModeOffNoticeText("Haiku 4.5")).toBe("Auto mode is off: Haiku 4.5 doesn't support auto mode.");
});

// ---------------------------------------------------------------------------
// Session wiring — fake `query`, same pattern as
// session-fast-mode-model-switch.test.ts.

const CWD = "/tmp/fake-session-auto-mode-cwd";

let tmp: TmpHome;

beforeEach(async () => {
  tmp = makeTempHome();
  await openDb(CWD);
});

afterEach(() => {
  tmp.restore();
});

type CatalogRow = { value: string; displayName: string; supportsAutoMode?: boolean };

type FakeQuery = {
  setModel: (model?: string) => Promise<void>;
  setPermissionMode: (mode: PermissionMode) => Promise<void>;
  supportedModels: () => Promise<CatalogRow[]>;
};

// `Session & {…}` collapses to `never` (its private `query`/`model` clash), so
// spell out the public surface under test plus the internals we poke.
type SessionInternals = Pick<Session, "id" | "setModel" | "setPermissionMode" | "getPermissionMode" | "getRebuildOpts"> & {
  model?: string;
  sdkModel?: string;
  query: FakeQuery | null;
  buffer: ServerEvent[];
};

const CATALOG: CatalogRow[] = [
  { value: "claude-sonnet-5", displayName: "Sonnet 5", supportsAutoMode: true },
  { value: "claude-haiku-4-5", displayName: "Haiku 4.5", supportsAutoMode: false },
  { value: "claude-legacy", displayName: "Legacy" },
];

function makeSession(
  mode: PermissionMode,
  model = "claude-sonnet-5",
): { session: SessionInternals; sdkModes: PermissionMode[] } {
  const sdkModes: PermissionMode[] = [];
  const session = new Session({ id: `auto-mode-${mode}`, cwd: CWD, permissionMode: mode }) as unknown as SessionInternals;
  session.model = model;
  session.query = {
    setModel: async () => {},
    setPermissionMode: async (m) => {
      sdkModes.push(m);
    },
    supportedModels: async () => CATALOG,
  };
  return { session, sdkModes };
}

function events<T extends ServerEvent["type"]>(session: SessionInternals, type: T) {
  return session.buffer.filter((e) => e.type === type) as Extract<ServerEvent, { type: T }>[];
}

describe("Session.setModel — leaves auto on a model without auto-mode support", () => {
  test("auto → default, SDK told, mode_changed before model_changed carrying the display name", async () => {
    const { session, sdkModes } = makeSession("auto");
    const result = await session.setModel("claude-haiku-4-5", "picker");
    expect(result.ok).toBe(true);
    expect(session.getPermissionMode()).toBe("default");
    expect(sdkModes).toEqual(["default"]);

    const modeIdx = session.buffer.findIndex((e) => e.type === "mode_changed");
    const modelIdx = session.buffer.findIndex((e) => e.type === "model_changed");
    expect(modeIdx).toBeGreaterThanOrEqual(0);
    expect(modeIdx).toBeLessThan(modelIdx);
    expect(events(session, "model_changed").at(-1)?.autoModeOffFor).toBe("Haiku 4.5");
    // `getRebuildOpts()` (restart / thinking-replay recovery) follows.
    expect(session.getRebuildOpts().permissionMode).toBe("default");
  });

  test("does not queue the user-Shift+Tab `Exited Auto Mode` reminder", async () => {
    const { session } = makeSession("auto");
    await session.setModel("claude-haiku-4-5", "picker");
    expect(pendingReminderCount(session)).toBe(0);
  });

  test("a model that supports auto, or one with unknown support, keeps auto", async () => {
    for (const model of ["claude-sonnet-5", "claude-legacy", "claude-not-in-catalog"]) {
      const { session } = makeSession("auto", "claude-haiku-4-5");
      await session.setModel(model, "picker");
      expect(session.getPermissionMode()).toBe("auto");
      expect(events(session, "model_changed").at(-1)).not.toHaveProperty("autoModeOffFor");
    }
  });

  test("non-auto sessions are untouched", async () => {
    const { session, sdkModes } = makeSession("acceptEdits");
    await session.setModel("claude-haiku-4-5", "picker");
    expect(session.getPermissionMode()).toBe("acceptEdits");
    expect(sdkModes).toEqual([]);
    expect(events(session, "model_changed").at(-1)).not.toHaveProperty("autoModeOffFor");
  });

  test("a reset to the default model is checked against the SDK-resolved model", async () => {
    const { session, sdkModes } = makeSession("auto");
    session.model = undefined;
    session.sdkModel = "claude-haiku-4-5";
    await session.setModel(undefined, "picker");
    expect(session.getPermissionMode()).toBe("default");
    expect(sdkModes).toEqual(["default"]);
    expect(events(session, "model_changed").at(-1)?.autoModeOffFor).toBe("Haiku 4.5");
  });

  test("a failed catalog fetch leaves the mode alone and doesn't fail the switch", async () => {
    const { session } = makeSession("auto");
    session.query!.supportedModels = async () => {
      throw new Error("transport closed");
    };
    const result = await session.setModel("claude-haiku-4-5", "picker");
    expect(result.ok).toBe(true);
    expect(session.getPermissionMode()).toBe("auto");
  });
});

describe("Session.setPermissionMode — can't re-enter auto on an unsupported model", () => {
  test("a later request for auto (e.g. the wake-POST reconciler's workspace default) is coerced to default", async () => {
    const { session, sdkModes } = makeSession("default", "claude-haiku-4-5");
    await session.setPermissionMode("auto");
    expect(session.getPermissionMode()).toBe("default");
    expect(sdkModes).toEqual(["default"]);
  });

  test("auto is still allowed on a supporting or unknown model", async () => {
    for (const model of ["claude-sonnet-5", "claude-legacy"]) {
      const { session } = makeSession("default", model);
      await session.setPermissionMode("auto");
      expect(session.getPermissionMode()).toBe("auto");
    }
  });

  test("with no explicit model, the SDK-resolved model is checked", async () => {
    const { session } = makeSession("default");
    session.model = undefined;
    session.sdkModel = "claude-haiku-4-5";
    await session.setPermissionMode("auto");
    expect(session.getPermissionMode()).toBe("default");
  });

  test("a switch to an unsupported model while the auto request awaits the catalog still leaves auto", async () => {
    const { session, sdkModes } = makeSession("default", "claude-sonnet-5");
    let release: () => void = () => {};
    let fetched: () => void = () => {};
    const firstFetch = new Promise<void>((r) => (fetched = r));
    let calls = 0;
    session.query!.supportedModels = () => {
      calls += 1;
      if (calls > 1) return Promise.resolve(CATALOG);
      fetched();
      return new Promise((r) => (release = () => r(CATALOG)));
    };
    const pending = session.setPermissionMode("auto");
    await firstFetch; // the auto check is now looking up claude-sonnet-5
    await session.setModel("claude-haiku-4-5", "picker"); // mode isn't auto yet: no-op
    expect(session.getPermissionMode()).toBe("default");
    release();
    await pending;
    expect(session.getPermissionMode()).toBe("default");
    expect(sdkModes).toEqual(["auto", "default"]);
    expect(events(session, "mode_changed").at(-1)?.mode).toBe("default");
  });

  test("a user-initiated exit from auto still queues the reminder", async () => {
    const { session } = makeSession("auto");
    await session.setPermissionMode("default");
    expect(pendingReminderCount(session)).toBe(1);
  });
});
