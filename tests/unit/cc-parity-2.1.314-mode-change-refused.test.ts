import { afterEach, beforeEach, describe, expect, test } from "vitest";
import type { PermissionMode } from "@anthropic-ai/claude-agent-sdk";

import { Session, isTransportClosedError } from "@/lib/server/session";
import { openDb } from "@/lib/server/db";
import { pendingReminderCount } from "@/lib/server/system-reminders";
import type { ServerEvent } from "@/lib/shared/events";

import { makeTempHome, type TmpHome } from "./helpers/tmp-home";

/**
 * CC 2.1.314 — "[Cloud sessions] Fixed the permission mode picker staying on
 * Auto after a running cloud or Remote Control session refused the switch; it
 * now shows the mode in use and tells you". The engine answers a refused
 * `set_permission_mode` with an error control response and
 * `Query.setPermissionMode` rejects; `Session.setPermissionMode` used to drop
 * that and broadcast the requested mode anyway.
 */

const CWD = "/tmp/fake-session-mode-refused-cwd";

let tmp: TmpHome;

beforeEach(async () => {
  tmp = makeTempHome();
  await openDb(CWD);
});

afterEach(() => {
  tmp.restore();
});

type FakeQuery = {
  setPermissionMode: (mode: PermissionMode) => Promise<void>;
  supportedModels: () => Promise<unknown[]>;
};

type SessionInternals = Pick<Session, "id" | "setPermissionMode" | "getPermissionMode"> & {
  query: FakeQuery | null;
  buffer: ServerEvent[];
};

function makeSession(
  mode: PermissionMode,
  engine: (m: PermissionMode) => Promise<void>,
): SessionInternals {
  const session = new Session({ id: `mode-refused-${mode}`, cwd: CWD, permissionMode: mode }) as unknown as SessionInternals;
  session.query = { setPermissionMode: engine, supportedModels: async () => [] };
  return session;
}

function modeEvents(session: SessionInternals): PermissionMode[] {
  return session.buffer
    .filter((e): e is Extract<ServerEvent, { type: "mode_changed" }> => e.type === "mode_changed")
    .map((e) => e.mode);
}

const REFUSAL = "set_permission_mode:bypassPermissions rejected — disabled by settings";

describe("Session.setPermissionMode — the engine refuses the switch", () => {
  test("keeps the mode in use, broadcasts it, and reports the refusal", async () => {
    const session = makeSession("default", async () => {
      throw new Error(REFUSAL);
    });
    const result = await session.setPermissionMode("bypassPermissions");
    expect(result).toEqual({ mode: "default", refused: { requested: "bypassPermissions", reason: REFUSAL } });
    expect(session.getPermissionMode()).toBe("default");
    // Every tab's pill ends on the mode in use — never the requested one.
    expect(modeEvents(session)).toEqual(["default"]);
  });

  test("a refused switch out of auto queues no `Exited Auto Mode` reminder", async () => {
    const session = makeSession("auto", async () => {
      throw new Error("refused");
    });
    await session.setPermissionMode("default");
    expect(session.getPermissionMode()).toBe("auto");
    expect(pendingReminderCount(session)).toBe(0);
  });

  test("an accepted switch is unchanged: applied, broadcast, reminder queued", async () => {
    const seen: PermissionMode[] = [];
    const session = makeSession("auto", async (m) => {
      seen.push(m);
    });
    const result = await session.setPermissionMode("default");
    expect(result).toEqual({ mode: "default" });
    expect(seen).toEqual(["default"]);
    expect(modeEvents(session)).toEqual(["default"]);
    expect(pendingReminderCount(session)).toBe(1);
  });

  test("switches run one at a time: a refused one rolls back before the next applies", async () => {
    let rejectFirst: (e: Error) => void = () => {};
    const seen: PermissionMode[] = [];
    const session = makeSession("default", (m) => {
      seen.push(m);
      if (seen.length === 1) return new Promise<void>((_, reject) => (rejectFirst = reject));
      return Promise.resolve();
    });
    const first = session.setPermissionMode("bypassPermissions");
    const second = session.setPermissionMode("acceptEdits");
    await new Promise((r) => setTimeout(r, 0));
    // The second hasn't reached the engine while the first is in flight.
    expect(seen).toEqual(["bypassPermissions"]);
    rejectFirst(new Error("refused"));
    expect((await first).refused?.requested).toBe("bypassPermissions");
    expect(await second).toEqual({ mode: "acceptEdits" });
    expect(session.getPermissionMode()).toBe("acceptEdits");
    expect(modeEvents(session)).toEqual(["default", "acceptEdits"]);
  });

  test("two quick refused switches end on the mode the engine is really in", async () => {
    const session = makeSession("default", async () => {
      throw new Error("refused");
    });
    const a = session.setPermissionMode("auto");
    const b = session.setPermissionMode("bypassPermissions");
    expect((await a).mode).toBe("default");
    expect((await b).mode).toBe("default");
    expect(session.getPermissionMode()).toBe("default");
    expect(modeEvents(session)).toEqual(["default", "default"]);
  });

  test("a closed transport is not a refusal: the pick is kept for the restart", async () => {
    const session = makeSession("default", async () => {
      throw new Error("Query closed before response received");
    });
    const result = await session.setPermissionMode("acceptEdits");
    expect(result).toEqual({ mode: "acceptEdits" });
    expect(session.getPermissionMode()).toBe("acceptEdits");
  });
});

describe("isTransportClosedError", () => {
  test("SDK transport rejections vs engine refusals", () => {
    expect(isTransportClosedError("Query closed before response received")).toBe(true);
    expect(isTransportClosedError("ProcessTransport is not ready for writing")).toBe(true);
    expect(isTransportClosedError(REFUSAL)).toBe(false);
    expect(
      isTransportClosedError("set_permission_mode is not supported in this context (onSetPermissionMode callback not registered)"),
    ).toBe(false);
  });
});
