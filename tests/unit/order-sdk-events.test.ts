import { describe, expect, test } from "vitest";
import { orderSdkEventsChronologically } from "@/lib/server/session";
import type { ServerEvent } from "@/lib/shared/events";

/**
 * Defensive replay-window sort for the SSE subscribe path. The buffer is
 * append-only, normally chronological, but a `resyncFromDisk` race can
 * splice older events after newer ones. This helper restores chronological
 * order on `sdk` events while leaving non-sdk control-plane events
 * (ready / session_title / mode_changed) anchored where they were.
 */

function sdk(uuid: string, at?: number): ServerEvent {
  return {
    type: "sdk",
    message: { type: "assistant", uuid, message: { content: [] } },
    ...(typeof at === "number" ? { at } : {}),
  } as unknown as ServerEvent;
}

const READY: ServerEvent = { type: "ready", sessionId: "s1" } as ServerEvent;
const TITLE: ServerEvent = { type: "session_title", title: "hello" } as ServerEvent;

describe("orderSdkEventsChronologically", () => {
  test("empty / single-event slices return a copy unchanged", () => {
    expect(orderSdkEventsChronologically([])).toEqual([]);
    const one = [sdk("a", 1)];
    expect(orderSdkEventsChronologically(one)).toEqual(one);
  });

  test("returns a copy with same shape when already chronological", () => {
    const slice = [sdk("a", 1), sdk("b", 2), sdk("c", 3)];
    const out = orderSdkEventsChronologically(slice);
    expect(out.map((e) => (e as { message: { uuid: string } }).message.uuid)).toEqual([
      "a",
      "b",
      "c",
    ]);
  });

  test("reorders sdk events that landed out of order", () => {
    // Simulates the resyncFromDisk race: an older message gets appended to
    // the buffer after a newer one was already broadcast.
    const slice = [sdk("a", 10), sdk("c", 30), sdk("b", 20)];
    const out = orderSdkEventsChronologically(slice);
    expect(out.map((e) => (e as { message: { uuid: string } }).message.uuid)).toEqual([
      "a",
      "b",
      "c",
    ]);
  });

  test("non-sdk events stay anchored at their original buffer position", () => {
    // session_title and ready are control-plane events that mark a moment
    // in the session — they shouldn't be reshuffled by the SDK sort.
    const slice: ServerEvent[] = [
      sdk("a", 10),
      TITLE,
      sdk("c", 30),
      READY,
      sdk("b", 20),
    ];
    const out = orderSdkEventsChronologically(slice);
    // Original non-sdk slots (index 1 and 3) hold their event types;
    // sdk slots get reshuffled chronologically (a, b, c).
    expect(out[0].type).toBe("sdk");
    expect((out[0] as { message: { uuid: string } }).message.uuid).toBe("a");
    expect(out[1].type).toBe("session_title");
    expect(out[2].type).toBe("sdk");
    expect((out[2] as { message: { uuid: string } }).message.uuid).toBe("b");
    expect(out[3].type).toBe("ready");
    expect(out[4].type).toBe("sdk");
    expect((out[4] as { message: { uuid: string } }).message.uuid).toBe("c");
  });

  test("ties on `at` keep original sdk emission order (stable)", () => {
    const slice = [sdk("a", 100), sdk("b", 100), sdk("c", 100)];
    const out = orderSdkEventsChronologically(slice);
    expect(out.map((e) => (e as { message: { uuid: string } }).message.uuid)).toEqual([
      "a",
      "b",
      "c",
    ]);
  });

  test("sdk events without `at` sort to the head (treated as 0)", () => {
    // Edge-case safety net: every disk-replay and live broadcast site
    // stamps `at`, but if one ever slips through we want it surfaced at
    // the start of the slice (visible) rather than randomly interleaved.
    const slice = [sdk("dated", 5_000), sdk("undated")];
    const out = orderSdkEventsChronologically(slice);
    expect(out.map((e) => (e as { message: { uuid: string } }).message.uuid)).toEqual([
      "undated",
      "dated",
    ]);
  });
});
