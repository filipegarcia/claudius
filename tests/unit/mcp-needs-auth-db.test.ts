import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";

import { makeTempHome, type TmpHome } from "./helpers/tmp-home";

// Wrap the real `openDb` in a spy so one test can force it to reject —
// every other test still gets the real per-cwd SQLite behavior.
vi.mock("@/lib/server/db", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/server/db")>();
  return { ...actual, openDb: vi.fn(actual.openDb) };
});

const { syncNeedsAuthNotifications } = await import("@/lib/server/mcp-needs-auth-db");
const { openDb } = await import("@/lib/server/db");

/**
 * SQLite-backed coverage for the MCP needs-auth "announce once" dedup
 * (CC 2.1.268 parity — "announce each server once instead of at every
 * launch"). Each test gets a fresh tmp HOME so migration 021 runs from
 * scratch.
 */

const CWD = "/tmp/fake-mcp-needs-auth-cwd";

let tmp: TmpHome;

beforeEach(async () => {
  tmp = makeTempHome();
  await openDb(CWD); // surface migration errors here, not mid-op
});

afterEach(() => {
  tmp.restore();
});

describe("syncNeedsAuthNotifications", () => {
  test("announces a server the first time, then suppresses it on repeat checks", async () => {
    const first = await syncNeedsAuthNotifications(CWD, ["github"]);
    expect(first).toEqual(["github"]);

    const second = await syncNeedsAuthNotifications(CWD, ["github"]);
    expect(second).toEqual([]);
  });

  test("only announces the newly-needs-auth server when another was already announced", async () => {
    await syncNeedsAuthNotifications(CWD, ["github"]);

    const result = await syncNeedsAuthNotifications(CWD, ["github", "linear"]);
    expect(result).toEqual(["linear"]);
  });

  test("re-announces a server after it leaves and re-enters needs-auth", async () => {
    await syncNeedsAuthNotifications(CWD, ["github"]);

    // The server authenticated — no longer needs-auth. The flag should clear.
    const cleared = await syncNeedsAuthNotifications(CWD, []);
    expect(cleared).toEqual([]);

    // Later the token expires again — this is a new episode, so it
    // should announce again instead of staying silent forever.
    const reAnnounced = await syncNeedsAuthNotifications(CWD, ["github"]);
    expect(reAnnounced).toEqual(["github"]);
  });

  test("fails open (treats every server as unannounced) when the DB can't be opened", async () => {
    vi.mocked(openDb).mockRejectedValueOnce(new Error("disk full"));
    const result = await syncNeedsAuthNotifications(CWD, ["github"]);
    expect(result).toEqual(["github"]);
  });
});
