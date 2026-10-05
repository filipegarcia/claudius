import { describe, expect, test } from "vitest";
import { clearPendingMessages } from "@/lib/client/clear-pending";
import type { DisplayMessage } from "@/lib/client/types";

const msg = (uuid: string, pending?: boolean): DisplayMessage => ({
  uuid,
  role: "user",
  blocks: [{ kind: "text", text: uuid }],
  ...(pending ? { pending: true } : {}),
});

describe("clearPendingMessages (CC 2.1.275 — B10)", () => {
  test("clears the pending flag on user messages", () => {
    const out = clearPendingMessages([msg("a", true), msg("b")]);
    expect(out[0].pending).toBe(false);
    expect(out[1].pending).toBeUndefined();
  });

  test("returns the SAME reference when nothing is pending (no re-render)", () => {
    const input = [msg("a"), msg("b")];
    expect(clearPendingMessages(input)).toBe(input);
  });
});
