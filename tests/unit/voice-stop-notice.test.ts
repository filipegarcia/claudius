import { describe, expect, it } from "vitest";

import {
  VOICE_TEXT_KEPT,
  describeVoiceSelfStop,
  parseVoiceCloseFrame,
} from "@/lib/shared/voice-stop-notice";

describe("describeVoiceSelfStop (CC 2.1.307 mic notice)", () => {
  it("always says the text so far is kept", () => {
    for (const stop of [
      { kind: "gone" } as const,
      { kind: "close", code: 1000, reason: "" } as const,
      { kind: "close", code: 1000, reason: "max duration reached" } as const,
      { kind: "close", code: 1006, reason: null } as const,
      { kind: "close", code: null, reason: "idle-timeout" } as const,
    ]) {
      expect(describeVoiceSelfStop(stop).endsWith(VOICE_TEXT_KEPT)).toBe(true);
    }
  });

  it("explains the proxy idle timeout", () => {
    expect(describeVoiceSelfStop({ kind: "close", code: null, reason: "idle-timeout" })).toContain(
      "no audio reached the transcription service for 30 seconds",
    );
  });

  it("echoes the service's reason on a normal closure", () => {
    expect(describeVoiceSelfStop({ kind: "close", code: 1000, reason: "max duration reached" })).toBe(
      `Dictation stopped by the transcription service: max duration reached. ${VOICE_TEXT_KEPT}`,
    );
  });

  it("falls back to a generic line when there is no reason", () => {
    expect(describeVoiceSelfStop({ kind: "close", code: 1000, reason: "" })).toContain(
      "the transcription service ended the session",
    );
    expect(describeVoiceSelfStop({ kind: "gone" })).toContain("the transcription session ended");
  });

  it("names the code for an abnormal closure", () => {
    expect(describeVoiceSelfStop({ kind: "close", code: 1006, reason: null })).toContain("closed (1006)");
    expect(describeVoiceSelfStop({ kind: "close", code: 1011, reason: "boom" })).toContain("closed (1011: boom)");
  });

  it("flattens control characters and caps long reasons", () => {
    const out = describeVoiceSelfStop({ kind: "close", code: 1000, reason: "a\nb\u0007c" });
    expect(out).toContain("a b c");
    const long = describeVoiceSelfStop({ kind: "close", code: 1000, reason: "x".repeat(500) });
    expect(long).toContain("…");
    expect(long.length).toBeLessThan(250);
  });
});

describe("parseVoiceCloseFrame", () => {
  it("reads code + reason", () => {
    expect(parseVoiceCloseFrame('{"code":1000,"reason":"done"}')).toEqual({ code: 1000, reason: "done" });
  });
  it("tolerates null code (idle reaper frame)", () => {
    expect(parseVoiceCloseFrame('{"code":null,"reason":"idle-timeout"}')).toEqual({
      code: null,
      reason: "idle-timeout",
    });
  });
  it("tolerates junk", () => {
    expect(parseVoiceCloseFrame("not json")).toEqual({ code: null, reason: null });
    expect(parseVoiceCloseFrame(undefined)).toEqual({ code: null, reason: null });
    expect(parseVoiceCloseFrame('{"code":"1000"}')).toEqual({ code: null, reason: null });
  });
});
