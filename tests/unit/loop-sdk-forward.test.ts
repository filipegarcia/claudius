import { describe, expect, test } from "vitest";
import { findSlashCommand } from "@/lib/shared/slash-commands";

/**
 * CC 2.1.248 — `/loop` must be SDK-forwarded so its arguments reach the SDK's
 * loop skill (`/loop <interval> <prompt>`, self-paced `/loop <prompt>`, bare
 * autonomous `/loop`). It used to be a `native` command routed to the Schedule
 * page, which dropped the arguments. `/schedule` stays native (just opens the
 * loops page).
 */
describe("/loop SDK forwarding (CC 2.1.248 — D1)", () => {
  test("/loop is classified as an SDK-forwarded command", () => {
    const cmd = findSlashCommand("loop");
    expect(cmd?.handler).toBe("sdk");
    expect(cmd?.argsHint).toBe("[interval] [prompt]");
  });

  test("/schedule stays native (opens the loops page)", () => {
    expect(findSlashCommand("schedule")?.handler).toBe("native");
  });
});
