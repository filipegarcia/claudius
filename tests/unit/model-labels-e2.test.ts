import { describe, expect, test } from "vitest";
import { PROBE_CANDIDATES } from "@/app/api/models/probe/route";
import { OPUS_OVERLOAD_NUDGE_SONNET_TARGET } from "@/components/chat/OpusOverloadNudgePanel";
import { MODEL_UNAVAILABLE_MESSAGE } from "@/lib/client/use-session";

/**
 * CC 2.1.257/2.1.284/2.1.219 (E2) — model lists/labels catch up to the current
 * generation: Sonnet 5.5 + Opus 5 pinned probe rows, Fable 5.1 labels, and the
 * Opus-overload nudge targets the `sonnet` alias (not a pinned id).
 */
describe("probe candidates (E2)", () => {
  const values = PROBE_CANDIDATES.map((c) => c.value);

  test("includes the Sonnet 5.5 and Opus 5 pins", () => {
    expect(values).toContain("claude-sonnet-5-5");
    expect(values).toContain("claude-opus-5");
  });

  test("keeps the existing current-default pins", () => {
    expect(values).toContain("claude-opus-5-5");
    expect(values).toContain("claude-fable-5-1");
  });
});

describe("current-gen labels (E2)", () => {
  test("the overload nudge targets the sonnet alias, not a pinned generation", () => {
    expect(OPUS_OVERLOAD_NUDGE_SONNET_TARGET).toBe("sonnet");
  });

  test("the model-unavailable copy names Fable 5.1, not the stale Fable 5", () => {
    expect(MODEL_UNAVAILABLE_MESSAGE).toContain("Fable 5.1");
    expect(MODEL_UNAVAILABLE_MESSAGE).not.toContain("Fable 5 ");
  });
});
