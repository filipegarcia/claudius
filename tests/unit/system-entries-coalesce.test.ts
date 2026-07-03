import { describe, expect, test } from "vitest";
import { appendCoalescedSystemEntry } from "@/lib/client/system-entries";
import type { SystemEntry } from "@/lib/client/types";

/**
 * Pin down the `init` / `status` pill coalescing that keeps an API-retry /
 * opus-overload storm from stacking dozens of identical "Session ready" /
 * "Status: requesting" pills in the transcript. The reducer folds a run of
 * identical emissions (same kind + label + anchor) onto one pill carrying a
 * `×N` count, while preserving genuinely distinct emissions that carry a
 * different anchor.
 */

function entry(over: Partial<SystemEntry> = {}): SystemEntry {
  return {
    uuid: "u",
    afterMessageUuid: "anchor-1",
    kind: "status",
    label: "Status: requesting",
    ...over,
  };
}

describe("appendCoalescedSystemEntry", () => {
  test("collapses N identical emissions into one entry with count === N", () => {
    let list: SystemEntry[] = [];
    for (let i = 0; i < 45; i++) {
      // Each emission is a genuinely distinct SDK event (unique uuid) but
      // shares kind + label + anchor, as during a thrash where no assistant
      // output advances the anchor.
      list = appendCoalescedSystemEntry(list, entry({ uuid: `u${i}` }));
    }
    expect(list).toHaveLength(1);
    expect(list[0].count).toBe(45);
    // The first emission's uuid is the one that survives (anchor stays put).
    expect(list[0].uuid).toBe("u0");
  });

  test("a single emission leaves count undefined (no badge rendered)", () => {
    const list = appendCoalescedSystemEntry([], entry());
    expect(list).toHaveLength(1);
    expect(list[0].count).toBeUndefined();
  });

  test("same kind + label but a DIFFERENT anchor gets its own pill (no false merge)", () => {
    // e.g. a genuine post-`/compact` re-init lands after new assistant output,
    // so it anchors to a newer message and must not fold into the earlier run.
    let list = appendCoalescedSystemEntry([], entry({ afterMessageUuid: "anchor-1" }));
    list = appendCoalescedSystemEntry(list, entry({ afterMessageUuid: "anchor-1" }));
    list = appendCoalescedSystemEntry(list, entry({ afterMessageUuid: "anchor-2" }));
    expect(list).toHaveLength(2);
    expect(list[0].count).toBe(2);
    expect(list[0].afterMessageUuid).toBe("anchor-1");
    expect(list[1].count).toBeUndefined();
    expect(list[1].afterMessageUuid).toBe("anchor-2");
  });

  test("different kind or label at the same anchor do not merge", () => {
    let list = appendCoalescedSystemEntry([], entry({ kind: "status", label: "Status: requesting" }));
    list = appendCoalescedSystemEntry(list, entry({ kind: "status", label: "Status: sending" }));
    list = appendCoalescedSystemEntry(list, entry({ kind: "init", label: "Session ready · x" }));
    expect(list).toHaveLength(3);
    expect(list.every((e) => e.count === undefined)).toBe(true);
  });

  test("does not mutate the previous array (returns a new list)", () => {
    const prev = [entry()];
    const next = appendCoalescedSystemEntry(prev, entry({ uuid: "u2" }));
    expect(next).not.toBe(prev);
    expect(prev[0].count).toBeUndefined();
  });
});
