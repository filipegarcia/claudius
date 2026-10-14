import { describe, expect, test } from "vitest";
import {
  KEEPALIVE_BODY_LIMIT,
  buildDraftFlushRequest,
  flushPendingDraft,
  utf8ByteLength,
  type PendingDraft,
} from "@/lib/client/pending-draft";

/**
 * CC 2.1.299 — "[VSCode] Fixed an unsent prompt and its attachments being
 * lost when switching to another session and back". The composer's debounced
 * draft save used to be cancelled by the session switch; the pending edit is
 * now flushed to the session it was recorded for.
 */

const draft = (over: Partial<PendingDraft> = {}): PendingDraft => ({
  sessionId: "sess-a",
  text: "half-typed prompt",
  images: [],
  ...over,
});

describe("buildDraftFlushRequest", () => {
  test("nothing pending → no request", () => {
    expect(buildDraftFlushRequest(null, { unloading: false })).toBeNull();
    expect(buildDraftFlushRequest(draft({ sessionId: "" }), { unloading: false })).toBeNull();
  });

  test("PUTs text + images to the PREVIOUS session's draft row", () => {
    const img = { id: "i1", ordinal: 1, data: "aGVsbG8=", mediaType: "image/png" };
    const req = buildDraftFlushRequest(draft({ images: [img] }), { unloading: false })!;
    expect(req.url).toBe("/api/sessions/sess-a/prompt-draft");
    expect(req.init.method).toBe("PUT");
    expect(JSON.parse(req.init.body as string)).toEqual({ text: "half-typed prompt", images: [img] });
  });

  test("a cleared draft still flushes (empty text overwrites the stale row)", () => {
    const req = buildDraftFlushRequest(draft({ text: "" }), { unloading: false })!;
    expect(JSON.parse(req.init.body as string)).toEqual({ text: "", images: [] });
  });

  test("session switch (not unloading) is a plain fetch", () => {
    expect(buildDraftFlushRequest(draft(), { unloading: false })!.init.keepalive).toBeUndefined();
  });

  test("unloading uses keepalive only when the body fits the quota", () => {
    expect(buildDraftFlushRequest(draft(), { unloading: true })!.init.keepalive).toBe(true);
    const big = { id: "i1", ordinal: 1, data: "x".repeat(KEEPALIVE_BODY_LIMIT), mediaType: "image/png" };
    const req = buildDraftFlushRequest(draft({ images: [big] }), { unloading: true })!;
    expect(req.init.keepalive).toBeUndefined();
  });

  test("quota is measured in UTF-8 bytes, not UTF-16 code units", () => {
    expect(utf8ByteLength("é")).toBe(2);
    expect(utf8ByteLength("😀")).toBe(4);
    // ~21k three-byte chars: under the limit by length, over it by bytes.
    const text = "€".repeat(Math.ceil(KEEPALIVE_BODY_LIMIT / 3) + 10);
    expect(text.length).toBeLessThan(KEEPALIVE_BODY_LIMIT);
    expect(buildDraftFlushRequest(draft({ text }), { unloading: true })!.init.keepalive).toBeUndefined();
  });
});

describe("flushPendingDraft", () => {
  test("sends once and clears the ref", () => {
    const ref = { current: draft() as PendingDraft | null };
    const calls: string[] = [];
    const fake = (url: string) => {
      calls.push(url);
      return Promise.resolve();
    };
    expect(flushPendingDraft(ref, { unloading: false }, fake)).toBe(true);
    expect(ref.current).toBeNull();
    // A second cleanup (e.g. unmount right after a switch) is a no-op.
    expect(flushPendingDraft(ref, { unloading: false }, fake)).toBe(false);
    expect(calls).toEqual(["/api/sessions/sess-a/prompt-draft"]);
  });

  test("a rejected or throwing fetch is swallowed", async () => {
    const ref = { current: draft() as PendingDraft | null };
    expect(flushPendingDraft(ref, { unloading: false }, () => Promise.reject(new Error("offline")))).toBe(true);
    const ref2 = { current: draft() as PendingDraft | null };
    expect(
      flushPendingDraft(ref2, { unloading: true }, () => {
        throw new TypeError("keepalive quota");
      }),
    ).toBe(true);
    await Promise.resolve();
  });
});
