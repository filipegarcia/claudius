import { describe, expect, test } from "vitest";
import { placeFailedSend, sendOutcome } from "@/lib/client/send-outcome";

/**
 * CC 2.1.299 — "[Remote Control] Fixed Remote Control sessions whose computer
 * can't be reached still appearing to send your messages; your text now stays
 * in the box". The composer clears on Send and puts the message back when the
 * parent reports it undelivered.
 */

describe("sendOutcome — backwards-compatible onSend result", () => {
  test("void / undefined / true mean delivered (pre-existing callers)", () => {
    expect(sendOutcome(undefined)).toBe(true);
    expect(sendOutcome(null)).toBe(true);
    expect(sendOutcome(true)).toBe(true);
  });

  test("an explicit false is a synchronous failure", () => {
    expect(sendOutcome(false)).toBe(false);
  });

  test("promises resolve to the delivery outcome", async () => {
    await expect(sendOutcome(Promise.resolve(true))).resolves.toBe(true);
    await expect(sendOutcome(Promise.resolve(undefined))).resolves.toBe(true);
    await expect(sendOutcome(Promise.resolve(false))).resolves.toBe(false);
  });

  test("a rejected promise counts as undelivered", async () => {
    await expect(sendOutcome(Promise.reject(new TypeError("Failed to fetch")))).resolves.toBe(false);
  });
});

describe("placeFailedSend", () => {
  const base = { originSessionId: "a", currentSessionId: "a", currentText: "", currentImageCount: 0 };

  test("same session, empty composer → restore text + images", () => {
    expect(placeFailedSend(base)).toBe("restore");
  });

  test("same session, user already typing → stash for ↑ instead of clobbering", () => {
    expect(placeFailedSend({ ...base, currentText: "next thought" })).toBe("stash");
    expect(placeFailedSend({ ...base, currentImageCount: 1 })).toBe("stash");
  });

  test("switched sessions meanwhile → save as the original session's draft", () => {
    expect(placeFailedSend({ ...base, currentSessionId: "b" })).toBe("save-to-origin");
    expect(placeFailedSend({ ...base, currentSessionId: null })).toBe("save-to-origin");
  });

  test("no origin session (fresh composer) → stays in this composer", () => {
    expect(placeFailedSend({ ...base, originSessionId: null, currentSessionId: null })).toBe("restore");
    expect(placeFailedSend({ ...base, originSessionId: null, currentSessionId: "b" })).toBe("restore");
  });
});
