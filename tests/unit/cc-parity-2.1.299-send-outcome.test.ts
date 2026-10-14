import { describe, expect, test } from "vitest";
import { mergeIntoDraft, placeFailedSend, sendFailedNotice, sendOutcome } from "@/lib/client/send-outcome";

/**
 * CC 2.1.299 — "[Remote Control] Fixed Remote Control sessions whose computer
 * can't be reached still appearing to send your messages; your text now stays
 * in the box". The composer clears on Send and puts the message back when the
 * parent reports it undelivered.
 */

describe("sendOutcome — backwards-compatible onSend result", () => {
  test("void / undefined / true / { ok: true } mean delivered (pre-existing callers)", () => {
    expect(sendOutcome(undefined)).toEqual({ ok: true });
    expect(sendOutcome(null)).toEqual({ ok: true });
    expect(sendOutcome(true)).toEqual({ ok: true });
    expect(sendOutcome({ ok: true })).toEqual({ ok: true });
  });

  test("an explicit false is a synchronous failure with no known reason", () => {
    expect(sendOutcome(false)).toEqual({ ok: false, error: "unknown" });
  });

  test("a SendResult failure passes its reason through", () => {
    expect(sendOutcome({ ok: false, error: "http 404" })).toEqual({ ok: false, error: "http 404" });
    expect(sendOutcome({ ok: false, error: "" })).toEqual({ ok: false, error: "unknown" });
  });

  test("promises resolve to the delivery outcome", async () => {
    await expect(sendOutcome(Promise.resolve(true))).resolves.toEqual({ ok: true });
    await expect(sendOutcome(Promise.resolve(undefined))).resolves.toEqual({ ok: true });
    await expect(sendOutcome(Promise.resolve({ ok: true }))).resolves.toEqual({ ok: true });
    await expect(sendOutcome(Promise.resolve(false))).resolves.toEqual({ ok: false, error: "unknown" });
    await expect(sendOutcome(Promise.resolve({ ok: false, error: "network" }))).resolves.toEqual({
      ok: false,
      error: "network",
    });
  });

  test("a rejected promise counts as undelivered", async () => {
    await expect(sendOutcome(Promise.reject(new TypeError("Failed to fetch")))).resolves.toEqual({
      ok: false,
      error: "unknown",
    });
  });
});

describe("sendFailedNotice — copy matches the failure", () => {
  test("only a network failure blames the connection", () => {
    expect(sendFailedNotice("network", "restore")).toBe("Couldn't reach Claudius — your message is back in the box.");
    expect(sendFailedNotice("network", "stash")).toMatch(/^Couldn't reach Claudius/);
  });

  test("http / no-session / unknown failures get neutral copy", () => {
    for (const error of ["http 404", "http 400", "no session", "unknown"]) {
      expect(sendFailedNotice(error, "restore")).toBe("Message not sent — it's back in the box.");
      expect(sendFailedNotice(error, "stash")).not.toMatch(/reach/);
    }
  });

  test("the stash hint points at ↑ on an empty box, not at clearing", () => {
    expect(sendFailedNotice("network", "stash")).toContain("Press ↑ in an empty box");
    expect(sendFailedNotice("http 500", "stash")).toContain("press ↑ in an empty box");
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

describe("mergeIntoDraft — save-to-origin appends instead of overwriting", () => {
  const img = (id: string, ordinal: number) => ({ id, ordinal, data: "x", mediaType: "image/png" });

  test("empty origin draft → just the sent message", () => {
    const sent = { text: "hello [Image #1]", images: [img("s1", 1)] };
    expect(mergeIntoDraft({ text: "", images: [] }, sent)).toBe(sent);
  });

  test("text-only drafts are joined with a newline", () => {
    expect(mergeIntoDraft({ text: "newer draft", images: [] }, { text: "failed send", images: [] })).toEqual({
      text: "newer draft\nfailed send",
      images: [],
    });
  });

  test("sent images are renumbered past the draft's, tokens rewritten to match", () => {
    const merged = mergeIntoDraft(
      { text: "draft [Image #1] [Image #2]", images: [img("d1", 1), img("d2", 2)] },
      { text: "sent [Image #1]", images: [img("s1", 1)] },
    );
    expect(merged.text).toBe("draft [Image #1] [Image #2]\nsent [Image #3]");
    expect(merged.images.map((i) => [i.id, i.ordinal])).toEqual([
      ["d1", 1],
      ["d2", 2],
      ["s1", 3],
    ]);
  });

  test("a draft with only images still merges (no leading newline)", () => {
    const merged = mergeIntoDraft({ text: "", images: [img("d1", 1)] }, { text: "sent", images: [] });
    expect(merged).toEqual({ text: "sent", images: [img("d1", 1)] });
  });
});
