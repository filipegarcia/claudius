import { describe, expect, test } from "vitest";
import { sortMessagesByChronology } from "@/lib/client/use-session";
import type { DisplayMessage } from "@/lib/client/types";

/**
 * Regression coverage for the chronological sort applied at the `useSession`
 * hook boundary. The user-visible symptom this guards against: messages
 * rendering in the wrong order after a session subscribe / pagination race
 * (the most acute report — NEW assistant bubble pinned above an OLD user
 * prompt — would not survive a chronological sort, so this test pins down
 * the invariant).
 */

function user(uuid: string, at?: number): DisplayMessage {
  return {
    uuid,
    role: "user",
    blocks: [{ kind: "text", text: `prompt ${uuid}` }],
    ...(typeof at === "number" ? { createdAt: at } : {}),
  };
}

function assistant(uuid: string, at?: number): DisplayMessage {
  return {
    uuid,
    role: "assistant",
    blocks: [{ kind: "text", text: `reply ${uuid}` }],
    ...(typeof at === "number" ? { createdAt: at } : {}),
  };
}

describe("sortMessagesByChronology", () => {
  test("returns the same reference for empty / single-message arrays", () => {
    const empty: DisplayMessage[] = [];
    expect(sortMessagesByChronology(empty)).toBe(empty);
    const one = [user("u1", 1000)];
    expect(sortMessagesByChronology(one)).toBe(one);
  });

  test("returns the same reference when input is already chronological", () => {
    const arr = [user("u1", 1000), assistant("a1", 1001), user("u2", 2000), assistant("a2", 2001)];
    expect(sortMessagesByChronology(arr)).toBe(arr);
  });

  test("reorders a NEW turn that landed before an OLD turn", () => {
    // Mirrors the user-reported bug: a 9:37 PM turn (user + assistant)
    // sits at the head of the array, with the May 15 turn appended after.
    const NEW_AT = 1_700_000_000_000;
    const OLD_AT = NEW_AT - 86_400_000 * 2; // two days earlier
    const arr = [
      user("u-new", NEW_AT),
      assistant("a-new", NEW_AT + 1),
      user("u-old", OLD_AT),
      assistant("a-old", OLD_AT + 1),
    ];
    const sorted = sortMessagesByChronology(arr);
    expect(sorted.map((m) => m.uuid)).toEqual(["u-old", "a-old", "u-new", "a-new"]);
  });

  test("carries forward createdAt for assistants without a timestamp", () => {
    // Mirrors the post-fix steady state where assistants ride on their
    // turn's user timestamp via server-side / synthesizeOlder carry-forward
    // — except the safety net here also handles a hypothetical transient
    // assistant placeholder that slipped through without a stamp.
    const T1 = 1_000;
    const T2 = 5_000;
    const arr = [
      user("u1", T1),
      assistant("a1a"), // no createdAt → inherit T1
      assistant("a1b"), // no createdAt → still T1
      user("u2", T2),
      assistant("a2"), // no createdAt → inherit T2
    ];
    const sorted = sortMessagesByChronology(arr);
    expect(sorted.map((m) => m.uuid)).toEqual(["u1", "a1a", "a1b", "u2", "a2"]);
  });

  test("ties keep original array order (stable sort)", () => {
    const T = 1_000;
    const arr = [user("u1", T), assistant("a1", T), assistant("a2", T)];
    const sorted = sortMessagesByChronology(arr);
    expect(sorted.map((m) => m.uuid)).toEqual(["u1", "a1", "a2"]);
  });

  test("all-undefined createdAt: returns original order, no shuffle", () => {
    const arr = [user("u1"), assistant("a1"), user("u2"), assistant("a2")];
    const sorted = sortMessagesByChronology(arr);
    expect(sorted.map((m) => m.uuid)).toEqual(["u1", "a1", "u2", "a2"]);
    // Returned reference is the same — no work needed.
    expect(sorted).toBe(arr);
  });

  test("snapshot fallback inserted ahead of a newer assistant gets re-sorted", () => {
    // Simulates the fa8b63d failure case the chronological-insert addressed:
    // the session_snapshot's user prompt prepends to the array head even
    // though the SSE replay already delivered a newer assistant. The sort
    // here pushes the snapshot user back into chronological position.
    const arr = [
      user("u-old-prepended", 1_000), // session_snapshot front-injected
      user("u-newer", 5_000),
      assistant("a-newer", 5_001),
    ];
    const sorted = sortMessagesByChronology(arr);
    expect(sorted.map((m) => m.uuid)).toEqual(["u-old-prepended", "u-newer", "a-newer"]);
  });

  test("paginated older page prepended to a streaming tail stays chronological", () => {
    // Simulates loadOlder fetching a page from May 15 while the live tail
    // is mid-stream. Both halves are individually ordered; the concatenation
    // is also ordered. This is the happy path — assert no churn.
    const OLD = 1_000;
    const NEW = 9_000;
    const arr = [
      user("u-old", OLD),
      assistant("a-old", OLD + 1),
      user("u-new", NEW),
      assistant("a-new", NEW + 1),
    ];
    expect(sortMessagesByChronology(arr)).toBe(arr);
  });
});
