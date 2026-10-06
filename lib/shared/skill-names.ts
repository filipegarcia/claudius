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
 */
export function skillMdName(
  frontmatter: Record<string, unknown> | null | undefined,
  folderName: string,
): string | null {
  const raw = frontmatter?.name;
  if (typeof raw !== "string") return null;
  const name = raw.trim();
  if (!name || name.normalize("NFC") === folderName.normalize("NFC")) return null;
  return name;
}
