import { describe, expect, test } from "vitest";
import {
  TRAILING_BUBBLE_SUFFIX,
  forkFailedMessage,
  forkableUuid,
  trailingBubbleUuid,
} from "@/lib/shared/forkable-uuid";

/**
 * CC 2.1.295 parity — Rewind / fork must target the JSONL record backing a
 * bubble, not the reducer's display-only `:trailing` id (CC 2.1.285
 * trailing-text bubble), or the SDK answers "Message not found in session".
 */

const U = "6f1c2a7e-0b5d-4c3e-9f8a-1d2e3f4a5b6c";

describe("trailingBubbleUuid", () => {
  test("appends the :trailing suffix", () => {
    expect(trailingBubbleUuid(U)).toBe(`${U}:trailing`);
    expect(TRAILING_BUBBLE_SUFFIX).toBe(":trailing");
  });
});

describe("forkableUuid", () => {
  test("passes plain record uuids through unchanged", () => {
    expect(forkableUuid(U)).toBe(U);
  });

  test("strips the trailing-bubble suffix back to the record uuid", () => {
    expect(forkableUuid(`${U}:trailing`)).toBe(U);
  });

  test("round-trips with trailingBubbleUuid", () => {
    expect(forkableUuid(trailingBubbleUuid(U))).toBe(U);
  });

  test("is idempotent", () => {
    expect(forkableUuid(forkableUuid(trailingBubbleUuid(U)))).toBe(U);
  });

  test("only strips a terminal suffix", () => {
    expect(forkableUuid(`${U}:trailing-x`)).toBe(`${U}:trailing-x`);
    expect(forkableUuid(`a:trailing:b`)).toBe("a:trailing:b");
  });

  test("leaves system-entry derived ids alone", () => {
    expect(forkableUuid(`${U}-resumed`)).toBe(`${U}-resumed`);
    expect(forkableUuid(`${U}-reminder-0`)).toBe(`${U}-reminder-0`);
  });
});

describe("forkFailedMessage", () => {
  test("prefixes the server reason", () => {
    expect(forkFailedMessage("Message not found in session")).toBe(
      "Couldn't fork from here: Message not found in session",
    );
  });
});
