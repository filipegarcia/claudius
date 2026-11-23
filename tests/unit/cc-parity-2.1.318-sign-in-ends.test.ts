import { describe, expect, test } from "vitest";

import { SIGN_IN_END_WARNING_WINDOW_MS, signInEndToWarn } from "@/lib/server/token-expiry";
import { Session } from "@/lib/server/session";
import type { ServerEvent } from "@/lib/shared/events";

/**
 * CC 2.1.318 parity — the SDK stamps when the stored claude.ai sign-in ends
 * on every `result` (`credential_expires_at`), and the engine warns (on `-p`
 * stderr, which Claudius's stream-json sessions never show) from 10 days out.
 * Claudius now warns once per session through the token-expiring banner with
 * `kind: "sign_in"`.
 */
const NOW = Date.parse("2026-11-09T12:00:00Z");
const DAY = 24 * 60 * 60 * 1000;

describe("signInEndToWarn", () => {
  test("inside 10 days → the instant to warn about", () => {
    const at = new Date(NOW + 4 * DAY).toISOString();
    expect(signInEndToWarn(at, NOW)).toBe(NOW + 4 * DAY);
    expect(signInEndToWarn(new Date(NOW + SIGN_IN_END_WARNING_WINDOW_MS).toISOString(), NOW)).toBe(
      NOW + SIGN_IN_END_WARNING_WINDOW_MS,
    );
  });

  test("further out, past, absent or garbage → null", () => {
    expect(signInEndToWarn(new Date(NOW + 11 * DAY).toISOString(), NOW)).toBeNull();
    expect(signInEndToWarn(new Date(NOW - DAY).toISOString(), NOW)).toBeNull();
    expect(signInEndToWarn(undefined, NOW)).toBeNull();
    expect(signInEndToWarn("", NOW)).toBeNull();
    expect(signInEndToWarn("not a date", NOW)).toBeNull();
    expect(signInEndToWarn(NOW + DAY, NOW)).toBeNull(); // must be the ISO string
  });

  test("the window is the engine's 10 days", () => {
    expect(SIGN_IN_END_WARNING_WINDOW_MS).toBe(10 * DAY);
  });
});

describe("Session.noteSignInEnding", () => {
  type Internals = {
    signInEndNudgeFired: boolean;
    isReplayingTranscript: boolean;
    broadcast: (ev: ServerEvent) => void;
    noteSignInEnding: (m: unknown) => void;
  };
  function fake(): { s: Internals; events: ServerEvent[] } {
    const events: ServerEvent[] = [];
    const s = {
      signInEndNudgeFired: false,
      isReplayingTranscript: false,
      broadcast: (ev: ServerEvent) => events.push(ev),
    } as unknown as Internals;
    s.noteSignInEnding = (Session.prototype as unknown as Internals).noteSignInEnding.bind(s);
    return { s, events };
  }
  const soon = () => new Date(Date.now() + 3 * DAY).toISOString();

  test("fires once with kind sign_in", () => {
    const { s, events } = fake();
    s.noteSignInEnding({ type: "result", credential_expires_at: soon() });
    s.noteSignInEnding({ type: "result", credential_expires_at: soon() });
    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({ type: "token_expiring_required", kind: "sign_in" });
  });

  test("silent without the field, and on transcript replay", () => {
    const a = fake();
    a.s.noteSignInEnding({ type: "result" });
    expect(a.events).toHaveLength(0);
    const b = fake();
    b.s.isReplayingTranscript = true;
    b.s.noteSignInEnding({ type: "result", credential_expires_at: soon() });
    expect(b.events).toHaveLength(0);
  });
});
