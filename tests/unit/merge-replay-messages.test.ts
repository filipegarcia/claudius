import { describe, expect, test } from "vitest";
import { mergeReplayMessages } from "@/lib/client/merge-replay-messages";
import type { Message } from "@/lib/shared/community";

function msg(
  id: string,
  createdAt: number,
  extra: Partial<Message> = {},
): Message {
  return {
    id,
    roomSlug: "general",
    nick: "alice",
    body: `msg-${id}`,
    isAdmin: false,
    createdAt,
    deletedAt: null,
    ...extra,
  };
}

describe("mergeReplayMessages", () => {
  test("returns the incoming payload when prev is empty (initial mount)", () => {
    const incoming = [msg("a", 1), msg("b", 2)];
    expect(mergeReplayMessages([], incoming)).toEqual(incoming);
  });

  test("returns prev when incoming is empty (older chat-server with backfill)", () => {
    // The advisor's race scenario: a `loadOlder` fetch resolved first
    // and populated `prev`. An empty replay must NOT clobber it.
    const prev = [msg("a", 1), msg("b", 2)];
    expect(mergeReplayMessages(prev, [])).toEqual(prev);
  });

  test("returns an empty list when both are empty", () => {
    expect(mergeReplayMessages([], [])).toEqual([]);
  });

  test("server wins on overlapping ids (deleted-flip replay)", () => {
    // Client had a live message; an admin then soft-deleted it. The
    // server's replay carries the deleted version; the merge must
    // adopt the server's deletedAt rather than the stale live row.
    const stale = msg("a", 1, { body: "live body", deletedAt: null });
    const fresh = msg("a", 1, { body: "", deletedAt: 50 });
    const merged = mergeReplayMessages([stale], [fresh]);
    expect(merged).toEqual([fresh]);
    expect(merged[0]?.deletedAt).toBe(50);
  });

  test("preserves prev-only rows the server didn't repeat (reconnect edge)", () => {
    // Scenario: SSE dropped, then a live `message` arrived through the
    // new connection BEFORE replay landed. Replay omits that row (it's
    // newer than the server's recent window) — keep it.
    const newLive = msg("z", 100);
    const prev = [msg("a", 1), msg("b", 2), newLive];
    const incoming = [msg("a", 1), msg("b", 2)];
    const merged = mergeReplayMessages(prev, incoming);
    expect(merged).toEqual([msg("a", 1), msg("b", 2), newLive]);
  });

  test("merges and sorts by createdAt", () => {
    const prev = [msg("c", 30)];
    const incoming = [msg("a", 10), msg("b", 20)];
    const merged = mergeReplayMessages(prev, incoming);
    expect(merged.map((m) => m.id)).toEqual(["a", "b", "c"]);
  });

  test("uses id as a stable tiebreaker on equal createdAt", () => {
    const prev = [msg("z", 5)];
    const incoming = [msg("a", 5), msg("m", 5)];
    const merged = mergeReplayMessages(prev, incoming);
    expect(merged.map((m) => m.id)).toEqual(["a", "m", "z"]);
  });

  test("does not mutate the input arrays", () => {
    const prev = [msg("a", 1)];
    const incoming = [msg("b", 2)];
    const prevCopy = [...prev];
    const incomingCopy = [...incoming];
    mergeReplayMessages(prev, incoming);
    expect(prev).toEqual(prevCopy);
    expect(incoming).toEqual(incomingCopy);
  });
});
