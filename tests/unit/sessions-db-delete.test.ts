import { afterEach, beforeEach, describe, expect, test } from "vitest";
import {
  deleteIndexedSession,
  getSessionTitle,
  listAllIndexedSessions,
  setSessionTitle,
} from "@/lib/server/sessions-db";
import { setSessionTitle as setLegacyTitle, getSessionTitle as getLegacyTitle, deleteSessionTitle } from "@/lib/server/session-titles";
import { openDb } from "@/lib/server/db";
import {
  getActiveTab,
  getOpenTabs,
  getPinnedTabs,
  removeSessionFromSavedTabs,
  setActiveTab,
  setOpenTabs,
  setPinnedTabs,
} from "@/lib/server/open-tabs-db";
import { createWorkspace } from "@/lib/server/workspaces-store";
import { isHistoryWorthyDbRow } from "@/lib/shared/session-history";

import { makeTempHome, type TmpHome } from "./helpers/tmp-home";

/**
 * CC 2.1.314 parity — "Fixed a rare case where a deleted session could
 * reappear in the resume list as an almost empty entry". `/api/sessions/all`
 * synthesizes a list entry for every titled `.claudius.db` row the SDK no
 * longer lists; deleting a session must remove that row (and the legacy
 * title, whose on-the-fly migration would re-insert it).
 */

let tmp: TmpHome;
const CWD_A = "/tmp/fake-claudius-delete-A";
const CWD_B = "/tmp/fake-claudius-delete-B";

beforeEach(async () => {
  tmp = makeTempHome();
  await openDb(CWD_A);
  await createWorkspace({ name: "delete-a", rootPath: CWD_A });
});

afterEach(() => {
  tmp.restore();
});

describe("deleteIndexedSession", () => {
  test("a renamed session's index row is a history-worthy stub until deleted", async () => {
    await setSessionTitle(CWD_A, "sess-1", "Release prep");
    const before = await listAllIndexedSessions(CWD_A);
    const row = before.find((r) => r.id === "sess-1");
    expect(row).toBeDefined();
    // The stub `/api/sessions/all` would rebuild after the JSONL is gone.
    expect(isHistoryWorthyDbRow(row!, () => false)).toBe(true);

    expect(await deleteIndexedSession("sess-1")).toBe(1);
    expect((await listAllIndexedSessions(CWD_A)).some((r) => r.id === "sess-1")).toBe(false);
  });

  test("leaves other sessions alone", async () => {
    await setSessionTitle(CWD_A, "sess-1", "Gone");
    await setSessionTitle(CWD_A, "sess-2", "Stays");
    await deleteIndexedSession("sess-1");
    expect(await getSessionTitle(CWD_A, "sess-2")).toBe("Stays");
  });

  test("never creates a DB for a workspace that has none", async () => {
    await createWorkspace({ name: "delete-b", rootPath: CWD_B });
    expect(await deleteIndexedSession("sess-unknown")).toBe(0);
    await expect(openDb(CWD_B, "readonly")).rejects.toThrow();
  });

  test("with the legacy title also dropped, a later title read can't re-insert the row", async () => {
    await setSessionTitle(CWD_A, "sess-1", "Legacy named");
    await setLegacyTitle("sess-1", "Legacy named");
    await deleteIndexedSession("sess-1");
    await deleteSessionTitle("sess-1");
    expect(await getLegacyTitle("sess-1")).toBeNull();
    // getSessionTitle's legacy-migration branch would have re-inserted it.
    expect(await getSessionTitle(CWD_A, "sess-1")).toBeNull();
    expect((await listAllIndexedSessions(CWD_A)).some((r) => r.id === "sess-1")).toBe(false);
  });
});

describe("removeSessionFromSavedTabs", () => {
  test("drops the id from open, pinned and active tabs, leaving the rest", async () => {
    await setOpenTabs(CWD_A, ["sess-1", "sess-2"]);
    await setPinnedTabs(CWD_A, ["sess-1"]);
    await setActiveTab(CWD_A, "sess-1");
    expect(await removeSessionFromSavedTabs("sess-1")).toBe(1);
    expect(await getOpenTabs(CWD_A)).toEqual(["sess-2"]);
    expect(await getPinnedTabs(CWD_A)).toEqual([]);
    expect(await getActiveTab(CWD_A)).toBeNull();
  });

  test("touches nothing when the id isn't in any saved strip", async () => {
    await setOpenTabs(CWD_A, ["sess-2"]);
    await setActiveTab(CWD_A, "sess-2");
    expect(await removeSessionFromSavedTabs("sess-1")).toBe(0);
    expect(await getOpenTabs(CWD_A)).toEqual(["sess-2"]);
    expect(await getActiveTab(CWD_A)).toBe("sess-2");
  });
});
