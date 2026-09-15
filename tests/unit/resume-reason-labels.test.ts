import { describe, expect, test } from "vitest";
import { RESUME_REASON_LABELS } from "@/lib/client/use-session";

/**
 * SDK 0.3.269 — `resume_reason` on the result message is either the host's
 * `CLAUDE_CODE_RESUME_REASON` (host_draining / checkpoint_restore /
 * container_recreated) or the SDK's own `interrupted_turn` fallback when the
 * host didn't set one. `RESUME_REASON_LABELS` maps each known value to the
 * friendly copy the resumed-turn `SystemEntry` pill shows (see
 * `use-session.ts`'s `msg.type === "result"` handler). Unknown values fall
 * back to the raw string at the call site, not tested here — this only pins
 * the known-value catalog so a future rename doesn't silently blank the pill.
 */
describe("RESUME_REASON_LABELS", () => {
  test("covers every reason value the SDK documents", () => {
    expect(RESUME_REASON_LABELS.interrupted_turn).toBeTruthy();
    expect(RESUME_REASON_LABELS.host_draining).toBeTruthy();
    expect(RESUME_REASON_LABELS.checkpoint_restore).toBeTruthy();
    expect(RESUME_REASON_LABELS.container_recreated).toBeTruthy();
  });

  test("every label is a non-empty, lowercase-leading clause (fits '... because <label>' phrasing)", () => {
    for (const label of Object.values(RESUME_REASON_LABELS)) {
      expect(label.length).toBeGreaterThan(0);
      expect(label[0]).toBe(label[0].toLowerCase());
    }
  });
});
