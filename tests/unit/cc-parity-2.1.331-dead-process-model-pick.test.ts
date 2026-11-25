import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";

import { openDb } from "@/lib/server/db";
import { Session } from "@/lib/server/session";
import { listIndexedSessions } from "@/lib/server/sessions-db";

import { makeTempHome, type TmpHome } from "./helpers/tmp-home";

/**
 * CC 2.1.331 — "[VSCode] Fixed a model pick being ignored for the next
 * message when Claude's process had ended or was still starting".
 *
 * Once a session's SDK process has exited, `query.setModel` rejects with a
 * transport error ("ProcessTransport is not ready for writing", "Query closed
 * before response received"). `Session.setModel` used to return `ok: false`
 * before recording the pick, so the picker reverted with a cryptic toast and
 * the restart the next send triggers came back on the old model. A dead
 * transport isn't a refusal: the pick is now kept (and persisted) so
 * `getRebuildOpts` carries it into the restart. A real refusal from a live
 * engine still fails the switch.
 */

const CWD = "/tmp/claudius-cc-parity-331-model-pick";

let tmp: TmpHome;

beforeEach(async () => {
  tmp = makeTempHome();
  await openDb(CWD);
});

afterEach(() => {
  tmp.restore();
});

type FakeQuery = {
  setModel: (m?: string) => Promise<void>;
  supportedModels: () => Promise<unknown[]>;
};

function makeSession(id: string, query: FakeQuery): Session {
  const session = new Session({ id, cwd: CWD, model: "claude-sonnet-4-6" });
  (session as unknown as { query: FakeQuery }).query = query;
  return session;
}

describe("Session.setModel on an ended process (CC 2.1.331)", () => {
  test("a transport-closed rejection keeps the pick for the restart", async () => {
    const supportedModels = vi.fn(async () => []);
    const session = makeSession("s-dead", {
      setModel: () => Promise.reject(new Error("ProcessTransport is not ready for writing")),
      supportedModels,
    });

    const res = await session.setModel("claude-opus-4-7");

    expect(res.ok).toBe(true);
    expect(session.getRebuildOpts().model).toBe("claude-opus-4-7");
    // The catalog fetch is skipped: a gone transport can't answer it.
    expect(supportedModels).not.toHaveBeenCalled();
    const row = (await listIndexedSessions(CWD)).find((r) => r.id === "s-dead");
    expect(row?.model).toBe("claude-opus-4-7");
  });

  test("'Query closed before response received' counts as a gone transport too", async () => {
    const session = makeSession("s-closed", {
      setModel: () => Promise.reject(new Error("Query closed before response received")),
      supportedModels: async () => [],
    });

    const res = await session.setModel("claude-opus-4-7");

    expect(res.ok).toBe(true);
    expect(session.getRebuildOpts().model).toBe("claude-opus-4-7");
  });

  test("a live engine's refusal still fails the switch and leaves the model alone", async () => {
    const session = makeSession("s-live", {
      setModel: () => Promise.reject(new Error("Model claude-opus-4-7 is not available for this account")),
      supportedModels: async () => [],
    });

    const res = await session.setModel("claude-opus-4-7");

    expect(res).toEqual({
      ok: false,
      error: "Model claude-opus-4-7 is not available for this account",
      model: "claude-sonnet-4-6",
    });
    expect(session.getRebuildOpts().model).toBe("claude-sonnet-4-6");
  });
});
