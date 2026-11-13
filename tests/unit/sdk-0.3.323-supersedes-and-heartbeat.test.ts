import { describe, expect, test } from "vitest";
import {
  evictSupersededFromRecord,
  evictSupersededMessages,
  supersededUuidsOf,
} from "@/lib/client/evict-superseded";
import { isHookHeartbeatToolProgress } from "@/lib/client/use-session";
import { GOAL_MCP_SERVER_NAME, withGoalMcpServer, withoutGoalMcpServer } from "@/lib/server/mcp-in-process";
import type { DisplayMessage } from "@/lib/client/types";

const msg = (uuid: string, folded: string[] = []): DisplayMessage => ({
  uuid,
  role: "assistant",
  blocks: [],
  foldedSdkUuids: new Set(folded),
});

describe("SDK 0.3.323 supersedes eviction", () => {
  test("supersededUuidsOf reads string uuids only", () => {
    expect(supersededUuidsOf({})).toBeNull();
    expect(supersededUuidsOf({ supersedes: [] })).toBeNull();
    expect([...supersededUuidsOf({ supersedes: ["a", 3, "", "b"] })!]).toEqual(["a", "b"]);
  });

  test("evicts by bubble uuid or folded wrapper uuid, keeps the rest", () => {
    const list = [msg("m1", ["w1"]), msg("m2", ["w2"]), msg("m3")];
    const out = evictSupersededMessages(list, new Set(["w2", "m3"]));
    expect(out.map((m) => m.uuid)).toEqual(["m1"]);
  });

  test("returns the same array when nothing matches", () => {
    const list = [msg("m1")];
    expect(evictSupersededMessages(list, new Set(["zzz"]))).toBe(list);
  });

  test("record variant filters subagent transcripts and preserves identity when unchanged", () => {
    const rec = { t1: [msg("a", ["w"])], t2: [msg("b")] };
    expect(evictSupersededFromRecord(rec, new Set(["nope"]))).toBe(rec);
    const out = evictSupersededFromRecord(rec, new Set(["w"]));
    expect(out.t1).toEqual([]);
    expect(out.t2).toBe(rec.t2);
  });
});

describe("SDK 0.3.323 hook heartbeat tool_progress", () => {
  test("recognises hook- ids only", () => {
    expect(isHookHeartbeatToolProgress({ tool_use_id: "hook-abc" })).toBe(true);
    expect(isHookHeartbeatToolProgress({ tool_use_id: "toolu_01" })).toBe(false);
    expect(isHookHeartbeatToolProgress({})).toBe(false);
  });
});

describe("in-process MCP server preservation across setMcpServers", () => {
  test("goal server is always added and wins a name clash", () => {
    const out = withGoalMcpServer({ a: 1, [GOAL_MCP_SERVER_NAME]: 2 }, 9);
    expect(out).toEqual({ a: 1, [GOAL_MCP_SERVER_NAME]: 9 });
  });
  test("goal server is hidden from add/remove deltas", () => {
    expect(withoutGoalMcpServer(["x", GOAL_MCP_SERVER_NAME])).toEqual(["x"]);
  });
});
