import { describe, expect, test } from "vitest";
import {
  BOOT_FORCE_KEY,
  BOOT_MARKER_KEY,
  BOOT_MARKER_TTL_MS,
  clearBootAttempt,
  consumeForcedResume,
  markBootAttempt,
  shouldSkipResume,
} from "@/lib/client/boot-guard";

/**
 * CC 2.1.301 ([VSCode] "Fixed a conversation that crashes or freezes the
 * panel being reopened on every reload").
 */
function mem(): Storage {
  const m = new Map<string, string>();
  return {
    get length() {
      return m.size;
    },
    clear: () => m.clear(),
    getItem: (k) => (m.has(k) ? m.get(k)! : null),
    key: (i) => Array.from(m.keys())[i] ?? null,
    removeItem: (k) => void m.delete(k),
    setItem: (k, v) => void m.set(k, String(v)),
  };
}

describe("boot crash-loop guard", () => {
  test("a boot that finished leaves nothing behind", () => {
    const s = mem();
    markBootAttempt("abc", s, 1000);
    clearBootAttempt(s);
    expect(shouldSkipResume("abc", s, 2000)).toBe(false);
  });

  test("a boot that never finished makes the next boot skip that session", () => {
    const s = mem();
    markBootAttempt("abc", s, 1000, 1);
    expect(shouldSkipResume("abc", s, 2000, false, 2)).toBe(true);
  });

  test("a marker from this same page load (Strict Mode re-run, remount) never counts", () => {
    const s = mem();
    markBootAttempt("abc", s, 1000, 7);
    expect(shouldSkipResume("abc", s, 2000, false, 7)).toBe(false);
  });

  test("only the same session is skipped", () => {
    const s = mem();
    markBootAttempt("abc", s, 1000);
    expect(shouldSkipResume("other", s, 2000)).toBe(false);
  });

  test("an old marker (tab closed mid-load long ago) is ignored", () => {
    const s = mem();
    markBootAttempt("abc", s, 0);
    expect(shouldSkipResume("abc", s, BOOT_MARKER_TTL_MS + 1)).toBe(false);
  });

  test("Open anyway wins, once", () => {
    const s = mem();
    markBootAttempt("abc", s, 1000, 1);
    const ss = mem();
    ss.setItem(BOOT_FORCE_KEY, "abc");
    expect(consumeForcedResume("abc", ss)).toBe(true);
    expect(shouldSkipResume("abc", s, 2000, true, 2)).toBe(false);
    expect(consumeForcedResume("abc", ss)).toBe(false);
  });

  test("a corrupt marker is ignored", () => {
    const s = mem();
    s.setItem(BOOT_MARKER_KEY, "{not json");
    expect(shouldSkipResume("abc", s, 2000)).toBe(false);
  });
});
