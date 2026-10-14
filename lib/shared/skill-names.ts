/**
 * CC 2.1.299 parity — "Changed skill and command loading: one whose file or
 * folder name has hidden, direction-changing or blank-like characters, < or >,
 * is no longer offered until renamed; such a name: is ignored".
 *
 * Mirrors the bundled 2.1.299 engine's name rule (its `wMo` / `Rj` / `g4`
 * predicates, extracted from the SDK's `claude` binary). Every regex below is
 * a transcription of the engine's, written with code-point escapes (backslash,
 * u, curly braces) so no invisible character ever sits literally in the source
 * — see the note in `invisible-unicode.ts` on why the bare four-hex form is
 * avoided.
 */

/** The engine's own wording, verbatim, for the "not offered" refusal. */
export const ENGINE_NAME_RULE_MESSAGE =
  "a name may not hold hidden, direction-changing or blank-like characters, < or >, or be over 256 characters";

/** Engine cap, in UTF-16 code units (it compares `name.length`). */
export const MAX_ENGINE_NAME_LENGTH = 256;

/**
 * Hidden / direction-changing characters: every control (Cc — which covers
 * the engine's separate `\x00-\x1f\x7f-\x9f` check), format (Cf — bidi
 * overrides, zero-width space, BOM, …), surrogate, private-use and unassigned
 * code point, the line/paragraph separators, anything Unicode marks
 * Default_Ignorable (Hangul fillers U+3164/U+115F/U+1160/U+FFA0, the combining
 * grapheme joiner U+034F, Khmer U+17B4/U+17B5, variation selectors, …) and
 * the blank Braille pattern U+2800. Plus `<` and `>`.
 */
const HIDDEN_OR_ANGLE_RE =
  /[\p{Cc}\p{Cf}\p{Cs}\p{Co}\p{Cn}\u{2028}\u{2029}\p{Default_Ignorable_Code_Point}\u{2800}<>]/u;

/**
 * Blank-like: any space separator other than the plain space (no-break space,
 * ideographic space, en/em spaces, …), the object replacement character and a
 * handful of format-like symbols, or a leading / trailing space.
 */
const BLANK_LIKE_RE = /(?! )\p{Zs}|[\u{FFFC}\u{1D159}\u{13441}\u{13442}\u{16FE4}]|^ | $/u;

/**
 * Mark abuse (the "Zalgo" shapes): a combining mark (or Hangul medial/final
 * jamo) not attached to a letter, digit or mark; a run of nine or more; a
 * doubled dot on a soft-dotted letter; a mark on dotless i/j; or a
 * script-specific mark stacked on a Latin/Common base.
 */
const MARK = String.raw`[\p{M}\u{1160}-\u{11FF}\u{D7B0}-\u{D7FF}]`;
const MARK_ABUSE_RE = new RegExp(
  [
    String.raw`(?<![\p{L}\p{N}\p{M}])${MARK}`,
    `${MARK}{9}`,
    String.raw`\p{Soft_Dotted}\p{M}*\u{0307}`,
    String.raw`[\u{0131}\u{0237}]\p{M}`,
    String.raw`(?<=[\p{sc=Latin}\p{sc=Common}]${MARK}*)(?!\p{sc=Inherited})${MARK}`,
  ].join("|"),
  "u",
);

/** Skill / command names only: no space next to a `:` and no edge `:`. */
const COLON_SPACING_RE = /(?:^|:) | (?::|$)|^:|:$/;

/**
 * The engine's base rule (`wMo`) — what a SKILL.md `name:` must pass to be
 * shown. Non-empty, at most 256 UTF-16 code units, no hidden /
 * direction-changing / blank-like characters, no `<` `>`, no double space, no
 * misplaced or piled-up combining marks.
 */
export function isEngineShownName(name: string): boolean {
  return (
    name.length > 0 &&
    name.length <= MAX_ENGINE_NAME_LENGTH &&
    !HIDDEN_OR_ANGLE_RE.test(name) &&
    !BLANK_LIKE_RE.test(name) &&
    !name.includes("  ") &&
    !MARK_ABUSE_RE.test(name)
  );
}

/**
 * Whether the 2.1.299 engine offers a skill / command under this name (its
 * `Rj`): the base rule plus no space beside a `:` and no leading/trailing `:`.
 * A skill folder that fails this still loads from disk in Claudius — so it can
 * be found and deleted — but Claude is never offered it until it's renamed.
 */
export function isEngineOfferableName(name: string): boolean {
  return isEngineShownName(name) && !COLON_SPACING_RE.test(name);
}

/** The engine tests the display name with `&lt;` / `&gt;` folded back to `<`. */
function frontmatterNameShown(raw: string): boolean {
  return isEngineShownName(raw.replace(/&[lg]t;/g, "<"));
}

/**
 * CC 2.1.290 parity — "Fixed skills not being found when asked for by the
 * name in SKILL.md when their folder has a different name (for example a
 * non-English name): the skill listing now shows both names."
 *
 * A skill's identity on disk is its folder, but Claude also finds it by the
 * `name` in its SKILL.md frontmatter. Returns that name when it is a non-empty
 * string that differs from the folder name — the case where the Skills page
 * should show both. Compared after NFC normalization: macOS can hand back a
 * folder name in decomposed form (`e` + U+0301) while the frontmatter holds
 * the composed `é`, and those are the same name.
 *
 * CC 2.1.299 — a `name:` the engine refuses is ignored (the skill keeps its
 * folder name), so it's not presented as a second name; see
 * `ignoredSkillMdName`.
 */
export function skillMdName(
  frontmatter: Record<string, unknown> | null | undefined,
  folderName: string,
): string | null {
  const raw = frontmatter?.name;
  if (typeof raw !== "string") return null;
  const name = raw.trim();
  if (!name || name.normalize("NFC") === folderName.normalize("NFC")) return null;
  if (!frontmatterNameShown(raw)) return null;
  return name;
}

/**
 * CC 2.1.299 — the SKILL.md `name:` when the engine ignores it ("such a name:
 * is ignored"), so the Skills page can say so instead of listing it as an
 * alias. `null` when there's no name or it passes the rule.
 */
export function ignoredSkillMdName(
  frontmatter: Record<string, unknown> | null | undefined,
): string | null {
  const raw = frontmatter?.name;
  if (typeof raw !== "string" || !raw.trim()) return null;
  return frontmatterNameShown(raw) ? null : raw;
}
