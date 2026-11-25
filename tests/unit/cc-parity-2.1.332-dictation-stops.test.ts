import { describe, expect, test } from "vitest";

import {
  describeVoiceSelfStop,
  VOICE_HIDDEN_STOP_MS,
  VOICE_TEXT_KEPT,
} from "@/lib/shared/voice-stop-notice";

/**
 * CC 2.1.332 parity — "Changed tap-mode voice dictation to … stop and say why
 * when you edit it, a panel covers it, or the connection or a separate
 * recorder program is lost" and "[VSCode] Changed voice dictation to stop, and
 * say why, when the microphone stops sending audio or the panel stays
 * hidden". Pins the copy for the three new stops.
 */
describe("describeVoiceSelfStop — CC 2.1.332 stops", () => {
  test("an edit while dictating", () => {
    expect(describeVoiceSelfStop({ kind: "edited" })).toBe(
      `Dictation stopped because you edited the message. ${VOICE_TEXT_KEPT}`,
    );
  });

  test("the microphone track ended", () => {
    expect(describeVoiceSelfStop({ kind: "mic-ended" })).toBe(
      `Dictation stopped — the microphone stopped sending audio. ${VOICE_TEXT_KEPT}`,
    );
  });

  test("Claudius stayed hidden", () => {
    expect(VOICE_HIDDEN_STOP_MS).toBe(30_000);
    expect(describeVoiceSelfStop({ kind: "hidden" })).toBe(
      `Dictation stopped — Claudius was hidden for 30 seconds. ${VOICE_TEXT_KEPT}`,
    );
  });

  test("every new notice says the text so far is kept", () => {
    for (const kind of ["edited", "mic-ended", "hidden"] as const) {
      expect(describeVoiceSelfStop({ kind }).endsWith(VOICE_TEXT_KEPT)).toBe(true);
    }
  });
});
