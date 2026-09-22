/**
 * Strip invisible Unicode formatting / tag characters from prompt text
 * (Claude Code 2.1.280 [VSCode] parity: "invisible Unicode formatting and
 * tag characters are removed from pasted text with a notice, and from
 * anything else before it is sent"). Claudius reimplements this in the
 * composer itself (`PromptInput.tsx`) rather than inheriting it from the
 * SDK, since prompt text never round-trips through the bundled CLI before
 * the user sees it.
 *
 * Covers three invisible-injection-shaped ranges:
 *  - Unicode tag characters (U+E0001, U+E0020–U+E007F) — the block used to
 *    smuggle hidden text steganographically inside an otherwise normal
 *    string (each tag character mirrors a printable ASCII character but
 *    renders as nothing).
 *  - Zero-width formatting characters (ZWSP, ZWJ, word joiner, BOM/ZWNBSP)
 *    that have no visual footprint and are a common copy-paste-from-the-web
 *    artifact.
 *  - Explicit bidi control characters (LRE/RLE/PDF/LRO/RLO, LRI/RLI/FSI/PDI)
 *    that can visually reorder surrounding text without appearing themselves.
 *
 * Deliberately does NOT strip U+200C (zero-width non-joiner) — the same
 * 2.1.280 release fixed the CLI's own invisible-character cleanup for
 * stripping that character, which Persian and Arabic text rely on to
 * attach a suffix (e.g. a plural) to a preceding Latin word or number.
 */
const INVISIBLE_UNICODE_RE =
  /[​‍⁠﻿‪-‮⁦-⁩\u{E0001}\u{E0020}-\u{E007F}]/gu;

export function containsInvisibleUnicode(text: string): boolean {
  // Reset lastIndex isn't needed — .test() on a /g regex used exactly once
  // per call site here, but guard anyway since the const is module-scoped.
  INVISIBLE_UNICODE_RE.lastIndex = 0;
  return INVISIBLE_UNICODE_RE.test(text);
}

export function stripInvisibleUnicode(text: string): { cleaned: string; removedCount: number } {
  let removedCount = 0;
  const cleaned = text.replace(INVISIBLE_UNICODE_RE, () => {
    removedCount += 1;
    return "";
  });
  return { cleaned, removedCount };
}
