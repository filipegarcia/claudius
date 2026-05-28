import { afterEach, beforeEach, describe, expect, test } from "vitest";

import { insertFeedback, listFeedback } from "@/lib/server/feedback-store";
import { openDb } from "@/lib/server/db";

import { makeTempHome, type TmpHome } from "./helpers/tmp-home";

/**
 * SQLite-backed coverage for the feedback store. Each test gets a fresh tmp
 * HOME so migration 008 runs from scratch against an empty `feedback` table.
 */

const CWD = "/tmp/fake-feedback-cwd";

let tmp: TmpHome;

beforeEach(async () => {
  tmp = makeTempHome();
  await openDb(CWD); // surface migration errors here, not mid-op
});

afterEach(() => {
  tmp.restore();
});

describe("feedback-store roundtrip", () => {
  test("inserts and lists newest-first", async () => {
    await insertFeedback(CWD, {
      id: "fb-1",
      sessionId: "sess-1",
      rating: "up",
      comment: "love it",
      surface: "claudius",
      forwarded: true,
      createdAt: 1000,
    });
    await insertFeedback(CWD, {
      id: "fb-2",
      sessionId: "sess-1",
      rating: "down",
      comment: "needs work",
      surface: "claudius",
      forwarded: false,
      createdAt: 2000,
    });

    const rows = await listFeedback(CWD);
    expect(rows).toHaveLength(2);
    // Newest first.
    expect(rows[0]).toMatchObject({
      id: "fb-2",
      rating: "down",
      comment: "needs work",
      forwarded: false,
    });
    expect(rows[1]).toMatchObject({
      id: "fb-1",
      rating: "up",
      comment: "love it",
      forwarded: true,
    });
  });

  test("persists null rating and forwarded flag faithfully", async () => {
    await insertFeedback(CWD, {
      id: "fb-3",
      sessionId: null,
      rating: null,
      comment: "just a note",
      surface: null,
      forwarded: false,
      createdAt: 3000,
    });

    const rows = await listFeedback(CWD);
    expect(rows).toHaveLength(1);
    expect(rows[0].rating).toBeNull();
    expect(rows[0].forwarded).toBe(false);
    expect(rows[0].comment).toBe("just a note");
  });

  test("honors the limit", async () => {
    for (let i = 0; i < 5; i++) {
      await insertFeedback(CWD, {
        id: `fb-${i}`,
        comment: `c${i}`,
        forwarded: false,
        createdAt: 100 + i,
      });
    }
    const rows = await listFeedback(CWD, 2);
    expect(rows).toHaveLength(2);
    // Newest two.
    expect(rows.map((r) => r.id)).toEqual(["fb-4", "fb-3"]);
  });
});
