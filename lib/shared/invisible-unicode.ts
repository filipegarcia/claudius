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
 *  - Unicode tag characters (U+E0001, U+E0020 through U+E007F) - the block
 *    used to smuggle hidden text steganographically inside an otherwise
 *    normal string (each tag character mirrors a printable ASCII character
 *    but renders as nothing). NOTE: this same block is also how regional
 *    subdivision flag emoji are legitimately encoded (e.g. the Scotland and
 *    Texas flags) - a paste containing one collapses to the bare black-flag
 *    glyph and trips the "hidden characters" notice. Accepted trade-off:
 *    the changelog entry describes tag characters being removed
 *    unconditionally, and subdivision-flag emoji are rare enough in chat
 *    prompts that the anti-smuggling benefit wins. Revisit with a small
 *    allow-list of known flag tag-sequences if this bites a user.
 *  - Zero-width formatting characters with no visual footprint (zero-width
 *    space, word joiner, byte-order-mark / zero-width-no-break-space) that
 *    are a common copy-paste-from-the-web artifact.
 *  - Explicit bidi control characters (LRE/RLE/PDF/LRO/RLO, LRI/RLI/FSI/PDI)
 *    that can visually reorder surrounding text without appearing
 *    themselves - the "Trojan Source" class of attack.
 *
 * Deliberately does NOT strip:
 *  - the zero-width non-joiner - the same 2.1.280 release fixed the CLI's
 *    own invisible-character cleanup for stripping that character, which
 *    Persian and Arabic text rely on to attach a suffix (e.g. a plural) to
 *    a preceding Latin word or number.
 *  - the zero-width joiner - required to compose standard multi-codepoint
 *    emoji (e.g. the "woman technologist" or family sequences, or flags
 *    like the rainbow/trans flags) and Indic explicit conjuncts. An
 *    earlier draft of this file stripped it too, which silently split
 *    every such emoji apart and showed a false "hidden characters" notice
 *    on completely ordinary pastes - caught in review before shipping.
 *    Unlike the tag block, a lone joiner carries no smugglable content of
 *    its own, so the anti-steganography benefit of stripping it doesn't
 *    outweigh breaking ordinary emoji.
 *
 * Every entry below uses the code-point escape form (backslash, u, curly
 * braces) rather than the bare four-hex-digit form, even where both would
 * be valid JS syntax. A bare four-hex-digit unicode escape typed into some
 * tool pipelines gets silently decoded into the literal (invisible)
 * character before it reaches disk, which is exactly the failure this file
 * exists to detect in *user* input; the curly-brace form isn't recognized
 * by that decode path, so it survives as inspectable source text. (An
 * earlier draft used the bare form for exactly the characters this
 * comment warns about, and got corrupted into literal invisible bytes by
 * the tool pipeline that wrote it - caught in review before shipping.)
 */
const INVISIBLE_UNICODE_RE =
  /[\u{200B}\u{2060}\u{FEFF}\u{202A}-\u{202E}\u{2066}-\u{2069}\u{E0001}\u{E0020}-\u{E007F}]/gu;

/** The bidi-control subset of `INVISIBLE_UNICODE_RE` (LRE..RLO, LRI..PDI). */
const BIDI_CONTROL_RE = /^[\u{202A}-\u{202E}\u{2066}-\u{2069}]$/u;

/**
 * `bidiCount` is how many of the removed characters were bidi controls (CC
 * 2.1.316 — those always hold a prompt for review, see
 * `invisibleStripNeedsReview`). Existing callers that only read `cleaned` /
 * `removedCount` are unaffected.
 */
export function stripInvisibleUnicode(text: string): {
  cleaned: string;
  removedCount: number;
  bidiCount: number;
} {
  let removedCount = 0;
  let bidiCount = 0;
  const cleaned = text.replace(INVISIBLE_UNICODE_RE, (ch) => {
    removedCount += 1;
    if (BIDI_CONTROL_RE.test(ch)) bidiCount += 1;
    return "";
  });
  return { cleaned, removedCount, bidiCount };
}

/** Prompts the engine treats as a command to the CLI itself, not a message. */
const EXIT_WORDS = new Set(["exit", "quit", ":q", ":q!", ":wq", ":wq!"]);

/**
 * CC 2.1.316 parity — "Fixed prompts containing invisible characters needing
 * a second Enter to send; plain prompts now send cleaned on the first Enter,
 * and commands still wait for review".
 *
 * Whether a prompt that had invisible characters stripped must be put back
 * for review instead of being sent cleaned. Mirrors the engine's rule: hold
 * when nothing is left to send, when a bidi control was removed (it could
 * have been reordering what the user saw - the "Trojan Source" case), or when
 * the cleaned text is a command (`/slash`, `!bash`, or an exit word) rather
 * than a message to Claude. `cleaned` is the text after
 * `stripInvisibleUnicode`; `bidiCount` is its `bidiCount`.
 */
export function invisibleStripNeedsReview(cleaned: string, bidiCount: number): boolean {
  const trimmed = cleaned.trim();
  return trimmed === "" || bidiCount > 0 || /^[/!]/.test(trimmed) || EXIT_WORDS.has(trimmed);
}

/**
 * CC 2.1.316 — carry `{start, end}` offset ranges into `text` across
 * `stripInvisibleUnicode(text)`, so ranges recorded against the composer's
 * raw text (the large-paste ranges) still point at the same characters in
 * the cleaned text that is actually sent. An offset inside a removed
 * character lands where it was; a range that collapses to nothing is dropped.
 */
export function rebaseRangesThroughStrip<R extends { start: number; end: number }>(
  ranges: R[],
  text: string,
): R[] {
  const removed: Array<{ index: number; length: number }> = [];
  for (const m of text.matchAll(INVISIBLE_UNICODE_RE)) {
    removed.push({ index: m.index, length: m[0].length });
  }
  if (removed.length === 0) return ranges;
  const map = (offset: number): number => {
    let shift = 0;
    for (const r of removed) {
      if (r.index >= offset) break;
      shift += Math.min(r.length, offset - r.index);
    }
    return offset - shift;
  };
  const out: R[] = [];
  for (const r of ranges) {
    const start = map(r.start);
    const end = map(r.end);
    if (end > start) out.push({ ...r, start, end });
  }
  return out;
}

/**
 * CC 2.1.211 — render invisible / bidi-override characters as a visible
 * `‹U+XXXX›` token instead of leaving them to act on the display. Used where
 * we must show untrusted text that the user is about to authorise (the
 * permission prompt's tool input) and therefore must NOT strip — the point
 * is to make a Trojan-Source / zero-width payload *visible*, not to silently
 * remove it. Same character set as `stripInvisibleUnicode`. `count` is how
 * many were surfaced, so the caller can flag the input.
 */
export function visualizeInvisibleUnicode(text: string): { visualized: string; count: number } {
  return visualizeMatches(text, INVISIBLE_UNICODE_RE);
}

/**
 * CC 2.1.299 — the wider set of characters the engine's name rule treats as
 * hidden, direction-changing or blank-like (see `lib/shared/skill-names.ts`):
 * every control / format / surrogate / private-use / unassigned code point,
 * U+2028/U+2029, anything Default_Ignorable (Hangul fillers, the combining
 * grapheme joiner, variation selectors, …), the blank Braille pattern, every
 * space separator other than the plain space, and the object replacement
 * character and its format-like kin. Kept separate from
 * `INVISIBLE_UNICODE_RE` so the composer and permission prompt keep their
 * narrower, emoji-safe set.
 */
const HIDDEN_NAME_CHAR_RE =
  /[\p{Cc}\p{Cf}\p{Cs}\p{Co}\p{Cn}\u{2028}\u{2029}\p{Default_Ignorable_Code_Point}\u{2800}\u{FFFC}\u{1D159}\u{13441}\u{13442}\u{16FE4}]|(?! )\p{Zs}/gu;

/**
 * CC 2.1.299 — render a skill / command name with every character the engine
 * refuses as hidden or blank-like shown as the same `‹U+XXXX›` token, so a
 * "not offered" name is legible (a folder called `deploy` + U+3164 otherwise
 * looks exactly like `deploy`).
 */
export function visualizeHiddenNameUnicode(text: string): { visualized: string; count: number } {
  return visualizeMatches(text, HIDDEN_NAME_CHAR_RE);
}

function visualizeMatches(text: string, re: RegExp): { visualized: string; count: number } {
  let count = 0;
  const visualized = text.replace(re, (ch) => {
    count += 1;
    const cp = (ch.codePointAt(0) ?? 0).toString(16).toUpperCase().padStart(4, "0");
    return `‹U+${cp}›`;
  });
  return { visualized, count };
}
