import { afterEach, beforeEach, describe, expect, test } from "vitest";

import { getSessionState, mergeSessionState } from "@/lib/server/sessions-db";
import { openDb } from "@/lib/server/db";

import { makeTempHome, type TmpHome } from "./helpers/tmp-home";

/**
 * Unit coverage for the per-session JSON state bag (migration 013). The bag
 * is opaque on purpose — upcoming parity features patch their own keys
 * (last-seen-date, turn counters, …) via `mergeSessionState`. We just pin
 * down the round-trip + shallow-merge semantics here.
 */

let tmp: TmpHome;
const CWD = "/tmp/fake-claudius-state-workspace";

beforeEach(async () => {
  tmp = makeTempHome();
  await openDb(CWD);
});

afterEach(() => {
  tmp.restore();
});

describe("session state accessors", () => {
  test("unset state reads as empty object", async () => {
    const s = await getSessionState(CWD, "sess-1");
    expect(s).toEqual({});
  });

  test("merge then get round-trips the patch (creates the row)", async () => {
    await mergeSessionState(CWD, "sess-1", { lastSeenDate: "2026-05-31" });
    const s = await getSessionState(CWD, "sess-1");
    expect(s).toEqual({ lastSeenDate: "2026-05-31" });
  });

  test("merge is shallow — new keys add, existing keys overwrite, others survive", async () => {
    await mergeSessionState(CWD, "sess-1", { a: 1, b: 2 });
    await mergeSessionState(CWD, "sess-1", { b: 22, c: 3 });
    const s = await getSessionState(CWD, "sess-1");
    expect(s).toEqual({ a: 1, b: 22, c: 3 });
  });

  test("state is isolated per session id", async () => {
    await mergeSessionState(CWD, "sess-a", { x: "A" });
    await mergeSessionState(CWD, "sess-b", { x: "B" });
    expect(await getSessionState(CWD, "sess-a")).toEqual({ x: "A" });
    expect(await getSessionState(CWD, "sess-b")).toEqual({ x: "B" });
  });
});
