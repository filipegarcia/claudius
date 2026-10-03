import { afterEach, beforeEach, describe, expect, test } from "vitest";

import { Session } from "@/lib/server/session";
import { openDb } from "@/lib/server/db";
import type { ServerEvent } from "@/lib/shared/events";

import { makeTempHome, type TmpHome } from "./helpers/tmp-home";

/**
 * CC 2.1.218 parity — "Added an announcement when fast mode changes as a
 * result of switching models via /config model=<x> or Remote Control".
 *
 * The SDK has no field correlating a `fast_mode_state` change back to a
 * model switch (see FastModeNoticePanel's scope note), so `Session.setModel`
 * derives the signal itself: it fetches the `supportedModels()` catalog and
 * compares `supportsFastMode` for the old vs. new model. This pins that
 * comparison down at the `model_changed` broadcast, independent of the SDK
 * process (a fake `query` stands in for the real one, same pattern as
 * session-tasks.test.ts / model-picker-route.test.ts).
 */

const CWD = "/tmp/fake-session-fast-mode-cwd";

let tmp: TmpHome;

beforeEach(async () => {
  tmp = makeTempHome();
  await openDb(CWD); // surface migration errors here, not mid-op
});

afterEach(() => {
  tmp.restore();
});

type FakeQuery = {
  setModel: (model?: string) => Promise<void>;
  supportedModels: () => Promise<Array<{ value: string; supportsFastMode?: boolean }>>;
};

type SessionInternals = {
  model?: string;
  query: FakeQuery | null;
  buffer: ServerEvent[];
  setModel: (
    model?: string,
    source?: "picker" | "chat_command",
  ) => Promise<{ ok: true; model?: string } | { ok: false; error: string; model?: string }>;
};

function makeSession(
  initialModel: string | undefined,
  models: Array<{ value: string; supportsFastMode?: boolean }>,
): SessionInternals {
  const session = new Session({ id: "fast-mode-test", cwd: CWD }) as unknown as SessionInternals;
  session.model = initialModel;
  session.query = {
    setModel: async () => {},
    supportedModels: async () => models,
  };
  return session;
}

function lastModelChanged(
  session: SessionInternals,
): { model?: string; fastModeNowSupported?: boolean } | undefined {
  return [...session.buffer].reverse().find((e) => (e as { type?: string }).type === "model_changed") as
    | { model?: string; fastModeNowSupported?: boolean }
    | undefined;
}

describe("Session.setModel — fast-mode capability change on model switch", () => {
  test("fastModeNowSupported=false when switching from a fast-capable to a non-fast model", async () => {
    const models = [
      { value: "claude-sonnet-4-6", supportsFastMode: true },
      { value: "claude-opus-4-7", supportsFastMode: false },
    ];
    const session = makeSession("claude-sonnet-4-6", models);
    await session.setModel("claude-opus-4-7", "picker");
    expect(lastModelChanged(session)?.fastModeNowSupported).toBe(false);
  });

  test("fastModeNowSupported=true when switching from a non-fast to a fast-capable model", async () => {
    const models = [
      { value: "claude-opus-4-7", supportsFastMode: false },
      { value: "claude-sonnet-4-6", supportsFastMode: true },
    ];
    const session = makeSession("claude-opus-4-7", models);
    await session.setModel("claude-sonnet-4-6", "picker");
    expect(lastModelChanged(session)?.fastModeNowSupported).toBe(true);
  });

  test("omits fastModeNowSupported when capability is unchanged", async () => {
    const models = [
      { value: "claude-sonnet-4-6", supportsFastMode: true },
      { value: "claude-sonnet-4-5", supportsFastMode: true },
    ];
    const session = makeSession("claude-sonnet-4-6", models);
    await session.setModel("claude-sonnet-4-5", "picker");
    const ev = lastModelChanged(session);
    expect(ev).toBeDefined();
    expect(ev && "fastModeNowSupported" in ev).toBe(false);
  });

  test("omits fastModeNowSupported when there is no previous model to compare (first pick)", async () => {
    const models = [{ value: "claude-sonnet-4-6", supportsFastMode: true }];
    const session = makeSession(undefined, models);
    await session.setModel("claude-sonnet-4-6", "picker");
    const ev = lastModelChanged(session);
    expect(ev).toBeDefined();
    expect(ev && "fastModeNowSupported" in ev).toBe(false);
  });

  test("omits fastModeNowSupported when supportedModels() rejects (best-effort, doesn't fail the switch)", async () => {
    const session = makeSession("claude-sonnet-4-6", []);
    session.query!.supportedModels = async () => {
      throw new Error("transport closed");
    };
    const result = await session.setModel("claude-opus-4-7", "picker");
    expect(result.ok).toBe(true);
    const ev = lastModelChanged(session);
    expect(ev).toBeDefined();
    expect(ev && "fastModeNowSupported" in ev).toBe(false);
  });
});
