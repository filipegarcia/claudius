import { describe, expect, test } from "vitest";
import { shouldBufferEvent } from "@/lib/server/session";
import type { ServerEvent } from "@/lib/shared/events";

/**
 * Regression coverage for the replay-buffer inclusion filter in
 * `lib/server/session.ts`'s `broadcast()`. Three kinds of event are
 * deliberately excluded from the 1000-event FIFO replay buffer:
 *
 * - `queue:updated` (a snapshot, replaying a stale one is wrong)
 * - `holder_changed` (always re-echoed fresh in `subscribe()`)
 * - SDK 0.3.206's `command_lifecycle` frames (uuid-stamped async-queue
 *   bookkeeping Claudius doesn't consume — would just crowd out real
 *   transcript history)
 *
 * Everything else — including ordinary `sdk` messages and any *other*
 * `system`-typed message — must still be buffered.
 */
describe("shouldBufferEvent", () => {
  test("excludes queue:updated snapshots", () => {
    const event = { type: "queue:updated", queue: [] } as unknown as ServerEvent;
    expect(shouldBufferEvent(event)).toBe(false);
  });

  test("excludes holder_changed", () => {
    const event = { type: "holder_changed", holderId: "x" } as unknown as ServerEvent;
    expect(shouldBufferEvent(event)).toBe(false);
  });

  test("excludes SDK command_lifecycle frames (new in 0.3.206)", () => {
    const event = {
      type: "sdk",
      message: { type: "command_lifecycle", uuid: "abc123", state: "completed" },
    } as unknown as ServerEvent;
    expect(shouldBufferEvent(event)).toBe(false);
  });

  test("excludes command_lifecycle regardless of reported state", () => {
    for (const state of ["queued", "started", "completed", "cancelled", "discarded"]) {
      const event = {
        type: "sdk",
        message: { type: "command_lifecycle", uuid: "abc123", state },
      } as unknown as ServerEvent;
      expect(shouldBufferEvent(event)).toBe(false);
    }
  });

  test("keeps ordinary sdk messages (assistant/user/result/system)", () => {
    for (const type of ["assistant", "user", "result", "system"]) {
      const event = { type: "sdk", message: { type, uuid: "x" } } as unknown as ServerEvent;
      expect(shouldBufferEvent(event)).toBe(true);
    }
  });

  test("keeps sdk messages with no message.type (defensive — don't over-match)", () => {
    const event = { type: "sdk", message: {} } as unknown as ServerEvent;
    expect(shouldBufferEvent(event)).toBe(true);
  });

  test("keeps non-sdk, non-excluded event types", () => {
    const event = { type: "cwd_changed", cwd: "/tmp" } as unknown as ServerEvent;
    expect(shouldBufferEvent(event)).toBe(true);
  });
});
