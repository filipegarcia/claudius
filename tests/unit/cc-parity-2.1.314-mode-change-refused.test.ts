import { afterEach, beforeEach, describe, expect, test } from "vitest";
import type { PermissionMode } from "@anthropic-ai/claude-agent-sdk";

import { Session } from "@/lib/server/session";
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

type SessionInternals = Pick<Session, "setPermissionMode" | "getPermissionMode"> & {
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

  test("a later switch that lands during the refused one's await is not rolled back", async () => {
    let rejectFirst: (e: Error) => void = () => {};
    let calls = 0;
    const session = makeSession("default", (m) => {
      calls++;
      if (calls === 1) return new Promise<void>((_, reject) => (rejectFirst = reject));
      void m;
      return Promise.resolve();
    });
    const first = session.setPermissionMode("bypassPermissions");
    // Let the first call reach the engine await, then switch again.
    await new Promise((r) => setTimeout(r, 0));
    await session.setPermissionMode("acceptEdits");
    rejectFirst(new Error("refused"));
    const r1 = await first;
    expect(r1.refused?.requested).toBe("bypassPermissions");
    expect(session.getPermissionMode()).toBe("acceptEdits");
    expect(r1.mode).toBe("acceptEdits");
  });
});
