import { afterEach, beforeEach, describe, expect, test } from "vitest";
import {
  getSessionTitle,
  retitleIndexedSession,
  setSessionTitle,
} from "@/lib/server/sessions-db";
import { openDb } from "@/lib/server/db";
import { createWorkspace } from "@/lib/server/workspaces-store";

import { makeTempHome, type TmpHome } from "./helpers/tmp-home";

/**
 * CC 2.1.309 parity — a rename made without a live session (the non-live
 * branch of `/api/sessions/rename`) must update the sessions-index title,
 * because every title reader prefers it over the JSONL `customTitle`.
 */

let tmp: TmpHome;
const CWD_A = "/tmp/fake-claudius-retitle-A";
const CWD_B = "/tmp/fake-claudius-retitle-B";

beforeEach(async () => {
  tmp = makeTempHome();
  await openDb(CWD_A);
  await createWorkspace({ name: "retitle-a", rootPath: CWD_A });
});

afterEach(() => {
  tmp.restore();
});

describe("retitleIndexedSession", () => {
  test("replaces a stale (generated) index title in a known workspace", async () => {
    await setSessionTitle(CWD_A, "sess-1", "Fix flaky login test (generated)");
    const n = await retitleIndexedSession("sess-1", "  Release prep  ");
    expect(n).toBe(1);
    expect(await getSessionTitle(CWD_A, "sess-1")).toBe("Release prep");
  });

  test("never creates a row or a DB for a session that isn't indexed", async () => {
    await createWorkspace({ name: "retitle-b", rootPath: CWD_B });
    const n = await retitleIndexedSession("sess-unknown", "Anything");
    expect(n).toBe(0);
    expect(await getSessionTitle(CWD_A, "sess-unknown")).toBeNull();
    // Workspace B never had a DB — the read-only probe must not have
    // created one (a read-only open of a missing DB file throws).
    await expect(openDb(CWD_B, "readonly")).rejects.toThrow();
  });

  test("ignores a blank title", async () => {
    await setSessionTitle(CWD_A, "sess-1", "Keep me");
    expect(await retitleIndexedSession("sess-1", "   ")).toBe(0);
    expect(await getSessionTitle(CWD_A, "sess-1")).toBe("Keep me");
  });
});
