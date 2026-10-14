import { afterEach, beforeEach, describe, expect, test } from "vitest";

import { Session } from "@/lib/server/session";
import { openDb } from "@/lib/server/db";
import type { ServerEvent } from "@/lib/shared/events";
import { FAST_MODE_CREDITS_REJECTED_KEY, isFastModeCreditsRejectedNotice } from "@/lib/shared/fast-mode";

import { makeTempHome, type TmpHome } from "./helpers/tmp-home";

/**
 * CC 2.1.300 parity — "[VSCode] Fixed fast mode staying on after usage
 * credits ran out, which made each request be refused and re-sent; it now
 * turns off until you turn it back on, with an error notice".
 *
 * The engine emits `system/notification` with key `fast-mode-overage-rejected`
 * but leaves the session's fast flag on. The SDK host has to turn it off;
 * Claudius does that server-side so it happens even with no tab open.
 */

const CWD = "/tmp/fake-session-fast-mode-credits-cwd";

let tmp: TmpHome;

beforeEach(async () => {
  tmp = makeTempHome();
  await openDb(CWD);
});

afterEach(() => {
  tmp.restore();
});

const NOTICE = {
  type: "system",
  subtype: "notification",
  key: FAST_MODE_CREDITS_REJECTED_KEY,
  text: "Fast mode disabled · usage credits exhausted",
  priority: "immediate",
  color: "error",
  uuid: "n-1",
  session_id: "s",
};

describe("isFastModeCreditsRejectedNotice", () => {
  test("matches the engine's credits-rejected notification", () => {
    expect(isFastModeCreditsRejectedNotice(NOTICE)).toBe(true);
  });

  test("ignores other notifications and other system messages", () => {
    expect(isFastModeCreditsRejectedNotice({ ...NOTICE, key: "fast-mode-cooldown-started" })).toBe(false);
    expect(isFastModeCreditsRejectedNotice({ ...NOTICE, subtype: "informational" })).toBe(false);
    expect(isFastModeCreditsRejectedNotice({ ...NOTICE, type: "assistant" })).toBe(false);
    expect(isFastModeCreditsRejectedNotice(null)).toBe(false);
    expect(isFastModeCreditsRejectedNotice("fast-mode-overage-rejected")).toBe(false);
  });
});

type SessionInternals = {
  query: { applyFlagSettings: (s: Record<string, unknown>) => Promise<void> } | null;
  isReplayingTranscript: boolean;
  broadcast: (event: ServerEvent) => void;
};

function makeSession(calls: Array<Record<string, unknown>>): SessionInternals {
  const session = new Session({ id: "fast-mode-credits-test", cwd: CWD }) as unknown as SessionInternals;
  session.query = {
    applyFlagSettings: async (s) => {
      calls.push(s);
    },
  };
  return session;
}

describe("Session — fast mode credits rejection", () => {
  test("a live credits-rejected notice turns fast mode off", async () => {
    const calls: Array<Record<string, unknown>> = [];
    const session = makeSession(calls);
    session.broadcast({ type: "sdk", message: NOTICE } as unknown as ServerEvent);
    await Promise.resolve();
    expect(calls).toContainEqual({ fastMode: false });
  });

  test("a replayed notice does not (it may predate a re-enable)", async () => {
    const calls: Array<Record<string, unknown>> = [];
    const session = makeSession(calls);
    session.isReplayingTranscript = true;
    session.broadcast({ type: "sdk", message: NOTICE } as unknown as ServerEvent);
    await Promise.resolve();
    expect(calls).toEqual([]);
  });

  test("other notifications leave fast mode alone", async () => {
    const calls: Array<Record<string, unknown>> = [];
    const session = makeSession(calls);
    session.broadcast({
      type: "sdk",
      message: { ...NOTICE, key: "fast-mode-cooldown-started" },
    } as unknown as ServerEvent);
    await Promise.resolve();
    expect(calls).toEqual([]);
  });
});
