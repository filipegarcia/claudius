import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";

import { makeTempHome, type TmpHome } from "./helpers/tmp-home";

// Wrap the real `openDb` in a spy so one test can force it to reject —
// every other test still gets the real per-cwd SQLite behavior.
vi.mock("@/lib/server/db", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/server/db")>();
  return { ...actual, openDb: vi.fn(actual.openDb) };
});

const { syncDisconnectedNotifications } = await import("@/lib/server/mcp-disconnected-db");
const { openDb } = await import("@/lib/server/db");

/**
 * SQLite-backed coverage for the MCP disconnected "announce once" dedup
 * (CC 2.1.273 parity — "Added a notification when an MCP server disconnects
 * mid-session and automatic reconnection gives up, pointing at /mcp").
 * Mirrors `mcp-needs-auth-db.test.ts` exactly; each test gets a fresh tmp
 * HOME so migration 023 runs from scratch.
 */

const CWD = "/tmp/fake-mcp-disconnected-cwd";

let tmp: TmpHome;

beforeEach(async () => {
  tmp = makeTempHome();
  await openDb(CWD); // surface migration errors here, not mid-op
});

afterEach(() => {
  tmp.restore();
});

describe("syncDisconnectedNotifications", () => {
  test("announces a server the first time, then suppresses it on repeat checks", async () => {
    const first = await syncDisconnectedNotifications(CWD, ["github"]);
    expect(first).toEqual(["github"]);

    const second = await syncDisconnectedNotifications(CWD, ["github"]);
    expect(second).toEqual([]);
  });

  test("only announces the newly-failed server when another was already announced", async () => {
    await syncDisconnectedNotifications(CWD, ["github"]);

    const result = await syncDisconnectedNotifications(CWD, ["github", "linear"]);
    expect(result).toEqual(["linear"]);
  });

  test("re-announces a server after it recovers and disconnects again", async () => {
    await syncDisconnectedNotifications(CWD, ["github"]);

    // The server reconnected — no longer failed. The flag should clear.
    const cleared = await syncDisconnectedNotifications(CWD, []);
    expect(cleared).toEqual([]);

    // Later it disconnects again — this is a new episode, so it should
    // announce again instead of staying silent forever.
    const reAnnounced = await syncDisconnectedNotifications(CWD, ["github"]);
    expect(reAnnounced).toEqual(["github"]);
  });

  test("fails open (treats every server as unannounced) when the DB can't be opened", async () => {
    vi.mocked(openDb).mockRejectedValueOnce(new Error("disk full"));
    const result = await syncDisconnectedNotifications(CWD, ["github"]);
    expect(result).toEqual(["github"]);
  });
});
