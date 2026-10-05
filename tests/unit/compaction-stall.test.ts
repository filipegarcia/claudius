import { describe, expect, test } from "vitest";
import { COMPACTION_STALL_HINT_SEC, compactionStallHint } from "@/lib/shared/compaction-stall";

describe("compactionStallHint (CC 2.1.228 — C8)", () => {
  test("no hint before the threshold", () => {
    expect(compactionStallHint(0)).toBeNull();
    expect(compactionStallHint(COMPACTION_STALL_HINT_SEC - 1)).toBeNull();
  });

  test("shows the stall hint at and after the threshold", () => {
    expect(compactionStallHint(COMPACTION_STALL_HINT_SEC)).toMatch(/still compacting/i);
    expect(compactionStallHint(120)).toMatch(/longer to summarize/i);
  });

  test("threshold is 20s", () => {
    expect(COMPACTION_STALL_HINT_SEC).toBe(20);
  });
});
