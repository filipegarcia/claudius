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

export function stripInvisibleUnicode(text: string): { cleaned: string; removedCount: number } {
  let removedCount = 0;
  const cleaned = text.replace(INVISIBLE_UNICODE_RE, () => {
    removedCount += 1;
    return "";
  });
  return { cleaned, removedCount };
}
