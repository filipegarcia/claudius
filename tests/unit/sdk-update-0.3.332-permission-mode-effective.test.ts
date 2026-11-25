import { afterEach, beforeEach, describe, expect, test } from "vitest";
import type { PermissionMode } from "@anthropic-ai/claude-agent-sdk";

import { Session } from "@/lib/server/session";
import { openDb } from "@/lib/server/db";
import { pendingReminderCount } from "@/lib/server/system-reminders";
import type { ServerEvent } from "@/lib/shared/events";
import { modeChangeRefusedText } from "@/components/chat/ModeChangeRefusedNoticePanel";

import { makeTempHome, type TmpHome } from "./helpers/tmp-home";

/**
 * SDK 0.3.332 — "Changed `Query.setPermissionMode()` to resolve with `{ mode }`,
 * the mode now in effect, or `undefined`". The JSDoc: "not always the mode
 * asked for: record `mode`, not the argument". `Session.setPermissionMode`
 * used to throw the answer away, so the pill, every tab, the revive record
 * and the route's reply all carried the requested mode.
 */

const CWD = "/tmp/fake-session-mode-effective-cwd";

let tmp: TmpHome;

beforeEach(async () => {
  tmp = makeTempHome();
  await openDb(CWD);
});

afterEach(() => {
  tmp.restore();
});

type Answer = { mode?: PermissionMode } | undefined;
type FakeQuery = {
  setPermissionMode: (mode: PermissionMode) => Promise<Answer>;
  supportedModels: () => Promise<unknown[]>;
};
type SessionInternals = Pick<Session, "id" | "setPermissionMode" | "getPermissionMode"> & {
  query: FakeQuery | null;
  buffer: ServerEvent[];
};

function makeSession(mode: PermissionMode, engine: (m: PermissionMode) => Promise<Answer>): SessionInternals {
  const session = new Session({ id: `mode-effective-${mode}`, cwd: CWD, permissionMode: mode }) as unknown as SessionInternals;
  session.query = { setPermissionMode: engine, supportedModels: async () => [] };
  return session;
}

function modeEvents(session: SessionInternals): PermissionMode[] {
  return session.buffer
    .filter((e): e is Extract<ServerEvent, { type: "mode_changed" }> => e.type === "mode_changed")
    .map((e) => e.mode);
}

describe("Session.setPermissionMode — the engine answers with the mode in effect", () => {
  test("records, broadcasts and returns the engine's mode, and says it was substituted", async () => {
    const session = makeSession("default", async () => ({ mode: "acceptEdits" }));
    const result = await session.setPermissionMode("plan");
    expect(result).toEqual({ mode: "acceptEdits", substituted: { requested: "plan" } });
    expect(session.getPermissionMode()).toBe("acceptEdits");
    expect(modeEvents(session)).toEqual(["acceptEdits"]);
  });

  test("reminders follow the mode in effect: an auto switch that lands in default leaves auto", async () => {
    const session = makeSession("auto", async () => ({ mode: "auto" }));
    // Asked for plan, engine stayed in auto: no `Exited Auto Mode` reminder.
    await session.setPermissionMode("plan");
    expect(session.getPermissionMode()).toBe("auto");
    expect(pendingReminderCount(session)).toBe(0);
  });

  test("an answer that matches the request is a plain switch", async () => {
    const session = makeSession("default", async (m) => ({ mode: m }));
    expect(await session.setPermissionMode("acceptEdits")).toEqual({ mode: "acceptEdits" });
    expect(modeEvents(session)).toEqual(["acceptEdits"]);
  });

  test("an answer that names no mode (older engine) keeps the requested mode", async () => {
    const session = makeSession("default", async () => undefined);
    expect(await session.setPermissionMode("acceptEdits")).toEqual({ mode: "acceptEdits" });
    expect(session.getPermissionMode()).toBe("acceptEdits");
    const empty = makeSession("default", async () => ({}));
    expect(await empty.setPermissionMode("plan")).toEqual({ mode: "plan" });
  });
});

describe("modeChangeRefusedText", () => {
  test("refused and substituted switches read differently", () => {
    expect(modeChangeRefusedText("bypassPermissions", "default")).toMatch(/^Couldn't switch to .+: the session refused\. Still in .+\.$/);
    expect(modeChangeRefusedText("plan", "acceptEdits", "substituted")).toMatch(
      /^Asked for .+: the session switched to .+ instead\.$/,
    );
  });
});
