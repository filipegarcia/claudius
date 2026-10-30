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
export function isLetterKey(e: { key: string; code: string }, letter: string): boolean {
  const want = letter.toLowerCase();
  const typed = e.key.length === 1 ? e.key.toLowerCase() : "";
  if (/^[a-z]$/.test(typed)) return typed === want;
  return e.code === `Key${want.toUpperCase()}`;
}
