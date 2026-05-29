import { afterEach, beforeEach, describe, expect, test } from "vitest";

import {
  listSuggestedMessageUuids,
  recordSuggestedMessage,
} from "@/lib/server/suggested-messages-db";
import { openDb } from "@/lib/server/db";

import { makeTempHome, type TmpHome } from "./helpers/tmp-home";

/**
 * SQLite-backed coverage for the "auto-suggested message" provenance store —
 * the persistence that lets a suggestion-originated bubble keep its badge
 * across a reload (the SDK JSONL carries no such flag). Fresh tmp HOME per
 * test so migration 009 runs from scratch and the handle cache is isolated.
 */

const CWD = "/tmp/fake-suggested-cwd";

let tmp: TmpHome;

beforeEach(async () => {
  tmp = makeTempHome();
  // Pre-open so a migration error surfaces here, not inside a record call.
  await openDb(CWD);
});

afterEach(() => {
  tmp.restore();
});

describe("record + list roundtrip", () => {
  test("a recorded message uuid is returned for its session", async () => {
    await recordSuggestedMessage(CWD, {
      sessionId: "sess-A",
      messageUuid: "uuid-1",
      text: "run the smoke test",
    });
    expect(await listSuggestedMessageUuids(CWD, "sess-A")).toEqual(["uuid-1"]);
  });

  test("only the matching session's uuids come back", async () => {
    await recordSuggestedMessage(CWD, { sessionId: "sess-A", messageUuid: "a1", text: "x" });
    await recordSuggestedMessage(CWD, { sessionId: "sess-A", messageUuid: "a2", text: "y" });
    await recordSuggestedMessage(CWD, { sessionId: "sess-B", messageUuid: "b1", text: "z" });
    expect(new Set(await listSuggestedMessageUuids(CWD, "sess-A"))).toEqual(
      new Set(["a1", "a2"]),
    );
    expect(await listSuggestedMessageUuids(CWD, "sess-B")).toEqual(["b1"]);
  });

  test("re-recording the same (session, uuid) is idempotent (no duplicate row)", async () => {
    await recordSuggestedMessage(CWD, { sessionId: "s", messageUuid: "u", text: "first" });
    await recordSuggestedMessage(CWD, { sessionId: "s", messageUuid: "u", text: "second" });
    expect(await listSuggestedMessageUuids(CWD, "s")).toEqual(["u"]);
    const db = await openDb(CWD);
    const row = db
      .prepare<[string, string], { suggestion_text: string }>(
        "SELECT suggestion_text FROM suggested_messages WHERE session_id = ? AND message_uuid = ?",
      )
      .get("s", "u");
    // ON CONFLICT updates the stored text to the latest send.
    expect(row?.suggestion_text).toBe("second");
  });

  test("missing sessionId or messageUuid is a no-op (never writes a junk row)", async () => {
    await recordSuggestedMessage(CWD, { sessionId: "", messageUuid: "u", text: "x" });
    await recordSuggestedMessage(CWD, { sessionId: "s", messageUuid: "", text: "x" });
    expect(await listSuggestedMessageUuids(CWD, "s")).toEqual([]);
  });

  test("unknown session returns an empty list", async () => {
    expect(await listSuggestedMessageUuids(CWD, "never-seen")).toEqual([]);
  });
});
