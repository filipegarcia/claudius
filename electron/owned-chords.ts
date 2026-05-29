/**
 * Reserved-chord ownership for the main-process `before-input-event`
 * interceptor (Phase 3 of docs/electron-conversion/PLAN.md).
 *
 * Pure, dependency-free (no `electron` import) so the matching logic can
 * be unit-tested — `before-input-event` itself is NOT reachable from
 * Playwright (CDP-injected keys bypass it; only real OS input traverses
 * it), so this module is where the behavior is actually verified.
 *
 * The interceptor swallows the chords the app owns so Chromium's
 * built-ins don't fire alongside the OS-menu accelerator. The owned set
 * is keyed by the FULL chord — shift + alt + key token — NOT the bare
 * key: ⌘⇧→ (tab.next) must be swallowed, but ⌘→ (move-to-end-of-line in
 * the composer) must NOT, even though they share the "Right" key. `mod`
 * is implied: the caller only consults this when meta/control is already
 * held, and every owned chord is a CommandOrControl combo.
 */

/** Canonical key for the owned set: `"S:Right"`, `":T"`, `"SA:K"`, … */
export function chordKey(shift: boolean, alt: boolean, token: string): string {
  return `${shift ? "S" : ""}${alt ? "A" : ""}:${token}`;
}

/**
 * Map a `KeyboardEvent.code` to the accelerator token used in the owned
 * set (mirrors `codeToAcceleratorToken` in `lib/client/shortcuts.ts`,
 * limited to the codes the menu plausibly owns). `null` → not ownable.
 */
export function codeToOwnedToken(code: string): string | null {
  if (code.startsWith("Key")) return code.slice(3);
  if (code.startsWith("Digit")) return code.slice(5);
  switch (code) {
    case "ArrowLeft":
      return "Left";
    case "ArrowRight":
      return "Right";
    case "ArrowUp":
      return "Up";
    case "ArrowDown":
      return "Down";
    case "BracketLeft":
      return "[";
    case "BracketRight":
      return "]";
    case "Comma":
      return ",";
    case "Slash":
      return "/";
    case "Minus":
      return "-";
    case "Equal":
      return "=";
    default:
      return null;
  }
}

/**
 * Parse an Electron accelerator string into the chord key.
 * `"CommandOrControl+Shift+Right"` → `chordKey(true, false, "Right")`.
 * The `mod` segment is dropped (always implied for owned chords).
 */
export function acceleratorToChordKey(accel: string): string | null {
  const parts = accel.split("+").map((p) => p.trim());
  const token = parts.pop();
  if (!token) return null;
  let shift = false;
  let alt = false;
  for (const p of parts) {
    if (p === "Shift") shift = true;
    else if (p === "Alt" || p === "Option" || p === "AltGr") alt = true;
    // CommandOrControl / Command / Cmd / Control / Ctrl / Super → implied mod.
  }
  return chordKey(shift, alt, token);
}

/** Build the owned-chord set from a renderer-pushed accelerator map. */
export function ownedChordsFromAccelerators(
  accelerators: Record<string, string>,
): Set<string> {
  const out = new Set<string>();
  for (const accel of Object.values(accelerators)) {
    if (typeof accel !== "string" || !accel) continue;
    const key = acceleratorToChordKey(accel);
    if (key) out.add(key);
  }
  return out;
}

/**
 * Shipped defaults, used until the renderer's first `setAccelerators`
 * sync lands. Mirrors the `lib/client/shortcuts.ts` defaults for the
 * menu-dispatched actions.
 */
export const DEFAULT_OWNED_CHORDS: ReadonlySet<string> = new Set<string>([
  chordKey(false, false, "T"), // tab.new — ⌘T
  chordKey(false, false, "W"), // tab.close — ⌘W
  chordKey(true, false, "T"), // tab.reopen — ⌘⇧T
  chordKey(false, false, "9"), // tab.last — ⌘9
  chordKey(true, false, "Right"), // tab.next — ⌘⇧→
  chordKey(true, false, "Left"), // tab.prev — ⌘⇧←
  chordKey(false, false, "1"),
  chordKey(false, false, "2"),
  chordKey(false, false, "3"),
  chordKey(false, false, "4"),
  chordKey(false, false, "5"),
  chordKey(false, false, "6"),
  chordKey(false, false, "7"),
  chordKey(false, false, "8"), // tab.go1..8 — ⌘1..8
  chordKey(false, false, "K"), // nav.commandPalette — ⌘K
  chordKey(false, false, "B"), // nav.toggleSidebar — ⌘B
  chordKey(false, false, "/"), // nav.cheatsheet — ⌘/
  chordKey(false, false, ","), // app.preferences — ⌘,
  chordKey(false, false, "O"), // app.openWorkspace — ⌘O
]);

/**
 * Decide whether a (meta/control-modified) key event is an owned chord.
 * `event` is the subset of Electron's `before-input-event` `input` we
 * need; `code` is a `KeyboardEvent.code`. Returns false for keys with no
 * ownable token (so copy/paste, find, etc. fall through to Chromium).
 */
export function isOwnedChord(
  owned: ReadonlySet<string>,
  event: { code: string; shift: boolean; alt: boolean },
): boolean {
  const token = codeToOwnedToken(event.code);
  if (token == null) return false;
  return owned.has(chordKey(event.shift, event.alt, token));
}
