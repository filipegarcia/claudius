/**
 * CC 2.1.314 parity — "[VSCode] Fixed the voice dictation shortcut (Ctrl+D)
 * doing nothing under non-Latin keyboard layouts such as Russian, Greek or
 * Hebrew".
 *
 * A letter shortcut matched on `KeyboardEvent.key` never fires under such a
 * layout: Ctrl+C on a Russian layout reports `key === "с"` (Cyrillic). The
 * shortcut registry (`lib/client/shortcuts.ts`) already matches on
 * `event.code`; this is for the ad-hoc handlers that bypass it (Ctrl+C in
 * the composer, Cmd/Ctrl+F/G/S, …).
 *
 * Plain `event.code` would regress Dvorak / AZERTY / Colemak users, whose
 * Ctrl+C is wherever *their* C is. So: when the layout types a Latin letter,
 * trust `key` (mnemonic layouts keep working); only when it types something
 * else (Cyrillic, Greek, Hebrew, …) fall back to the physical key, as the CLI
 * and VS Code do.
 */
export function isLetterKey(e: { key: string; code: string; altKey?: boolean }, letter: string): boolean {
  const want = letter.toLowerCase();
  const typed = e.key.length === 1 ? e.key.toLowerCase() : "";
  if (/^[a-z]$/.test(typed)) return typed === want;
  // No physical-key fallback when Alt is down: on Windows AltGr arrives as
  // Ctrl+Alt, so AltGr+C typing "ć" (Polish) or "&" (Hungarian) must stay a
  // character, not become Ctrl+C. Nor during IME composition ("Process").
  if (e.altKey || e.key === "Process") return false;
  return e.code === `Key${want.toUpperCase()}`;
}

/**
 * CC 2.1.329 parity — "[VSCode] Fixed keys pressed while an input method (IME)
 * is composing moving focus on or declining a permission prompt, running menu
 * rows and closing dialogs", and "an input method's Enter … picking an
 * @-mentioned file".
 *
 * True while the key belongs to an IME composition (Japanese, Chinese,
 * Korean, …): Esc that cancels a conversion, Enter that commits it, arrows
 * that walk the candidates. `keyCode === 229` also covers Safari, which
 * fires compositionend before the committing keydown. A window or
 * capture-phase key listener should return on this before doing anything,
 * without `preventDefault`, so the IME keeps the key.
 */
export function isImeComposing(e: { isComposing?: boolean; keyCode?: number; key?: string }): boolean {
  return e.isComposing === true || e.keyCode === 229 || e.key === "Process";
}
