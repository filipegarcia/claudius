/**
 * Unit coverage for the main-process reserved-chord matcher
 * (`electron/owned-chords.ts`).
 *
 * This is where the `before-input-event` behavior is actually verified:
 * the handler itself is unreachable from Playwright (CDP-injected keys
 * bypass it — only real OS input traverses it), so the swallow logic is
 * pulled into a pure module and exercised directly here. The regression
 * this guards: ⌘→ (composer line-nav) must NOT be swallowed while ⌘⇧→
 * (tab.next) must be.
 */
import { describe, expect, test } from "vitest";

import {
  acceleratorToChordKey,
  chordKey,
  codeToOwnedToken,
  DEFAULT_OWNED_CHORDS,
  isOwnedChord,
  ownedChordsFromAccelerators,
} from "../../electron/owned-chords";

describe("codeToOwnedToken", () => {
  test("maps letters, digits, arrows, punctuation", () => {
    expect(codeToOwnedToken("KeyT")).toBe("T");
    expect(codeToOwnedToken("Digit9")).toBe("9");
    expect(codeToOwnedToken("ArrowRight")).toBe("Right");
    expect(codeToOwnedToken("Slash")).toBe("/");
    expect(codeToOwnedToken("Comma")).toBe(",");
  });

  test("returns null for unownable codes (copy/find/etc. fall through)", () => {
    expect(codeToOwnedToken("KeyC")).toBe("C"); // ownable token...
    expect(codeToOwnedToken("F5")).toBeNull(); // ...but F-keys aren't
  });
});

describe("acceleratorToChordKey", () => {
  test("drops the mod segment and carries shift/alt", () => {
    expect(acceleratorToChordKey("CommandOrControl+Shift+Right")).toBe(
      chordKey(true, false, "Right"),
    );
    expect(acceleratorToChordKey("CommandOrControl+T")).toBe(chordKey(false, false, "T"));
    expect(acceleratorToChordKey("CommandOrControl+Alt+Shift+I")).toBe(
      chordKey(true, true, "I"),
    );
  });
});

describe("isOwnedChord — the line-nav regression guard", () => {
  test("⌘⇧→ (tab.next) is owned, but ⌘→ (line-nav) is NOT", () => {
    expect(isOwnedChord(DEFAULT_OWNED_CHORDS, { code: "ArrowRight", shift: true, alt: false })).toBe(
      true,
    );
    // The whole point of the chord-shaped match: same key, no shift → free.
    expect(
      isOwnedChord(DEFAULT_OWNED_CHORDS, { code: "ArrowRight", shift: false, alt: false }),
    ).toBe(false);
    expect(isOwnedChord(DEFAULT_OWNED_CHORDS, { code: "ArrowLeft", shift: false, alt: false })).toBe(
      false,
    );
  });

  test("⌘T / ⌘W / ⌘K are owned; ⌘C (copy) is not", () => {
    expect(isOwnedChord(DEFAULT_OWNED_CHORDS, { code: "KeyT", shift: false, alt: false })).toBe(true);
    expect(isOwnedChord(DEFAULT_OWNED_CHORDS, { code: "KeyW", shift: false, alt: false })).toBe(true);
    expect(isOwnedChord(DEFAULT_OWNED_CHORDS, { code: "KeyK", shift: false, alt: false })).toBe(true);
    expect(isOwnedChord(DEFAULT_OWNED_CHORDS, { code: "KeyC", shift: false, alt: false })).toBe(false);
  });

  test("a remap rewrites the owned set (and the old chord is freed)", () => {
    // User moves tab.next from ⌘⇧→ to ⌘⇧↑.
    const owned = ownedChordsFromAccelerators({
      "tab.next": "CommandOrControl+Shift+Up",
      "tab.new": "CommandOrControl+T",
    });
    expect(isOwnedChord(owned, { code: "ArrowUp", shift: true, alt: false })).toBe(true);
    // The old ⌘⇧→ is no longer swallowed — no dead key left behind.
    expect(isOwnedChord(owned, { code: "ArrowRight", shift: true, alt: false })).toBe(false);
    expect(isOwnedChord(owned, { code: "KeyT", shift: false, alt: false })).toBe(true);
  });

  test("ignores non-string accelerator values defensively", () => {
    const owned = ownedChordsFromAccelerators({
      "tab.new": "CommandOrControl+T",
      bogus: undefined as unknown as string,
    });
    expect(owned.has(chordKey(false, false, "T"))).toBe(true);
  });
});
