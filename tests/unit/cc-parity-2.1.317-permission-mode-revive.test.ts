import { afterEach, beforeEach, describe, expect, test } from "vitest";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { PermissionMode, PermissionResult } from "@anthropic-ai/claude-agent-sdk";

import { encodeProjectDir } from "@/lib/server/auto-memory";
import { openDb } from "@/lib/server/db";
import { Session } from "@/lib/server/session";
import {
  lastRecordedPermissionModeAt,
  persistedPermissionMode,
  resumePermissionMode,
} from "@/lib/server/session-resume";
import { getSessionState, mergeSessionState } from "@/lib/server/sessions-db";
import {
  permissionModeRecord,
  pickRecordedPermissionMode,
  readPermissionModeRecord,
} from "@/lib/shared/permission-mode-record";

import { makeTempHome, type TmpHome } from "./helpers/tmp-home";

/**
 * CC 2.1.317 — "Fixed a background session sometimes losing a just-made
 * change of permission mode when it was upgraded or retired".
 *
 * An SDK host's mode switch never reaches the transcript (the engine writes a
 * `permission-mode` line only for the terminal UI), so a switch with no prompt
 * after it was lost when the idle reaper retired the session or Claudius
 * restarted. `Session` now records each committed switch in the state bag,
 * and a revive uses the newer of that record and the transcript's last stamp.
 */

const CWD = "/tmp/claudius-cc-parity-317-mode-revive";
const T0 = Date.parse("2026-11-03T10:00:00.000Z");

let tmp: TmpHome;

beforeEach(async () => {
  tmp = makeTempHome();
  await openDb(CWD);
});

afterEach(() => {
  tmp.restore();
});

function writeTranscript(id: string, entries: object[]): void {
  const dir = join(tmp.home, ".claude", "projects", encodeProjectDir(CWD));
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, `${id}.jsonl`), entries.map((e) => JSON.stringify(e)).join("\n") + "\n");
}

const prompt = (mode: string, at: number | null) => ({
  type: "user",
  permissionMode: mode,
  message: { role: "user", content: "hi" },
  ...(at === null ? {} : { timestamp: new Date(at).toISOString() }),
});

describe("pickRecordedPermissionMode", () => {
  test("a switch persisted after the last prompt wins", () => {
    expect(pickRecordedPermissionMode({ mode: "default", at: T0 }, { mode: "plan", at: T0 + 1 })).toBe("plan");
  });

  test("a prompt sent after the persisted switch wins", () => {
    expect(pickRecordedPermissionMode({ mode: "plan", at: T0 + 1 }, { mode: "default", at: T0 })).toBe("plan");
    expect(pickRecordedPermissionMode({ mode: "default", at: T0 + 1 }, { mode: "plan", at: T0 })).toBe("default");
  });

  test("the transcript wins a tie and an undated stamp", () => {
    expect(pickRecordedPermissionMode({ mode: "default", at: T0 }, { mode: "plan", at: T0 })).toBe("default");
    expect(pickRecordedPermissionMode({ mode: "default", at: null }, { mode: "plan", at: T0 })).toBe("default");
  });

  test("either side alone is used; nothing recorded is null", () => {
    expect(pickRecordedPermissionMode(null, { mode: "plan", at: T0 })).toBe("plan");
    expect(pickRecordedPermissionMode({ mode: "acceptEdits", at: T0 }, null)).toBe("acceptEdits");
    expect(pickRecordedPermissionMode(null, null)).toBeNull();
  });
});

describe("permissionModeRecord / readPermissionModeRecord", () => {
  test("round-trips, and ignores malformed bags", () => {
    expect(readPermissionModeRecord(permissionModeRecord("plan", T0))).toEqual({ mode: "plan", at: T0 });
    expect(readPermissionModeRecord({})).toBeNull();
    expect(readPermissionModeRecord({ permissionMode: "plan" })).toBeNull();
    expect(readPermissionModeRecord({ permissionMode: "plan", permissionModeAt: "x" })).toBeNull();
    expect(readPermissionModeRecord({ permissionMode: "", permissionModeAt: T0 })).toBeNull();
  });
});

describe("lastRecordedPermissionModeAt", () => {
  test("returns the last stamp's mode and timestamp", async () => {
    writeTranscript("s-dated", [prompt("plan", T0), { type: "assistant" }, prompt("default", T0 + 5)]);
    expect(await lastRecordedPermissionModeAt("s-dated", CWD)).toEqual({ mode: "default", at: T0 + 5 });
  });

  test("an undated permission-mode line inherits the newest timestamp before it", async () => {
    writeTranscript("s-undated", [
      prompt("default", T0 + 5),
      { type: "permission-mode", permissionMode: "acceptEdits", sessionId: "s-undated" },
    ]);
    expect(await lastRecordedPermissionModeAt("s-undated", CWD)).toEqual({ mode: "acceptEdits", at: T0 + 5 });
  });

  test("a transcript with no timestamps reports at: null", async () => {
    writeTranscript("s-legacy", [prompt("plan", null)]);
    expect(await lastRecordedPermissionModeAt("s-legacy", CWD)).toEqual({ mode: "plan", at: null });
  });
});

describe("resumePermissionMode — a reaped or restarted session", () => {
  test("the repro: switched to plan after the last prompt, then reaped → revives in plan", async () => {
    writeTranscript("s-repro", [prompt("default", T0)]);
    await mergeSessionState(CWD, "s-repro", permissionModeRecord("plan", T0 + 60_000));
    expect(await resumePermissionMode("s-repro", CWD, "default")).toBe("plan");
  });

  test("the reverse: plan accepted (acceptEdits) after the last plan-mode prompt → not plan", async () => {
    writeTranscript("s-accepted", [prompt("plan", T0)]);
    await mergeSessionState(CWD, "s-accepted", permissionModeRecord("acceptEdits", T0 + 60_000));
    expect(await resumePermissionMode("s-accepted", CWD, "default")).toBe("default");
  });

  test("a switch older than the last prompt loses to the prompt's stamp", async () => {
    writeTranscript("s-older", [prompt("default", T0 + 60_000)]);
    await mergeSessionState(CWD, "s-older", permissionModeRecord("plan", T0));
    expect(await resumePermissionMode("s-older", CWD, "acceptEdits")).toBe("acceptEdits");
  });

  test("nothing persisted keeps the 2.1.292 transcript-only behaviour", async () => {
    writeTranscript("s-plain", [prompt("plan", T0)]);
    expect(await resumePermissionMode("s-plain", CWD, "default")).toBe("plan");
  });

  test("only plan is carried over — a newer persisted bypass still falls back", async () => {
    writeTranscript("s-bypass", [prompt("default", T0)]);
    await mergeSessionState(CWD, "s-bypass", permissionModeRecord("bypassPermissions", T0 + 60_000));
    expect(await resumePermissionMode("s-bypass", CWD, "default")).toBe("default");
    expect(await resumePermissionMode("s-bypass", CWD, undefined)).toBeUndefined();
  });

  test("a switch persisted before the session's first prompt (no transcript yet) still counts", async () => {
    await mergeSessionState(CWD, "s-nofile", permissionModeRecord("plan", T0));
    expect(await persistedPermissionMode("s-nofile", CWD)).toEqual({ mode: "plan", at: T0 });
    expect(await resumePermissionMode("s-nofile", CWD, "default")).toBe("plan");
  });
});

type SessionInternals = Pick<Session, "id" | "setPermissionMode" | "getPermissionMode" | "resolvePlan"> & {
  query: { setPermissionMode: (m: PermissionMode) => Promise<void>; supportedModels: () => Promise<unknown[]> } | null;
  pendingPlans: Map<string, { requestId: string; toolUseId: string; plan: string; resolve: (r: PermissionResult) => void }>;
};

function makeSession(id: string, mode: PermissionMode, engine: (m: PermissionMode) => Promise<void> = async () => {}): SessionInternals {
  const session = new Session({ id, cwd: CWD, permissionMode: mode }) as unknown as SessionInternals;
  session.query = { setPermissionMode: engine, supportedModels: async () => [] };
  return session;
}

/** `mergeSessionState` is fire-and-forget from Session; wait for it to land. */
async function settledState(id: string, key: string): Promise<Record<string, unknown>> {
  for (let i = 0; i < 50; i++) {
    const state = await getSessionState(CWD, id);
    if (key in state) return state;
    await new Promise((r) => setTimeout(r, 10));
  }
  return getSessionState(CWD, id);
}

describe("Session records committed mode switches", () => {
  test("an accepted switch is persisted with a timestamp", async () => {
    const session = makeSession("s-switch", "default");
    const before = Date.now();
    await session.setPermissionMode("plan");
    const record = readPermissionModeRecord(await settledState("s-switch", "permissionMode"));
    expect(record?.mode).toBe("plan");
    expect(record!.at).toBeGreaterThanOrEqual(before);
  });

  test("a switch the engine refuses is not persisted", async () => {
    const session = makeSession("s-refused", "default", async () => {
      throw new Error("set_permission_mode:bypassPermissions rejected — disabled by settings");
    });
    await session.setPermissionMode("bypassPermissions");
    expect(session.getPermissionMode()).toBe("default");
    await new Promise((r) => setTimeout(r, 50));
    expect(readPermissionModeRecord(await getSessionState(CWD, "s-refused"))).toBeNull();
  });

  test("accepting a plan records acceptEdits alongside the prior plan", async () => {
    const session = makeSession("s-plan", "plan");
    let result: PermissionResult | undefined;
    session.pendingPlans.set("req-1", {
      requestId: "req-1",
      toolUseId: "tool-1",
      plan: "1. do the thing",
      resolve: (r) => {
        result = r;
      },
    });
    expect(await session.resolvePlan("req-1", { kind: "accept" })).toBe(true);
    expect(result?.behavior).toBe("allow");
    const state = await settledState("s-plan", "permissionMode");
    expect(readPermissionModeRecord(state)?.mode).toBe("acceptEdits");
    expect(state.priorPlan).toBe("1. do the thing");
  });

  test("end to end: switch to plan with no prompt after it, then a revive keeps plan", async () => {
    writeTranscript("s-e2e", [prompt("default", Date.now() - 60_000)]);
    const session = makeSession("s-e2e", "default");
    await session.setPermissionMode("plan");
    await settledState("s-e2e", "permissionMode");
    // The session is not in the manager's map — as after the reaper or a restart.
    expect(await resumePermissionMode("s-e2e", CWD, "default")).toBe("plan");
  });
});
