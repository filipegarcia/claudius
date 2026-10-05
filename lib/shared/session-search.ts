/**
 * CC 2.1.287/2.1.288 (H1) — ranked session name search for the Sessions page.
 *
 * The list previously filtered in insertion order, so there was no "best match"
 * to open on Enter. This scores each session against the query (title matches
 * beat first-prompt/id matches, exact beats prefix beats substring) so the
 * caller can sort by score and open the top hit. A leading `n:` restricts the
 * search to names (title + first prompt), mirroring the CLI's `n:` filter.
 *
 * Pure + dependency-free so the parsing and scoring are unit-testable.
 */

export type SessionSearchFields = {
  customTitle?: string | null;
  claudiusTitle?: string | null;
  firstPrompt?: string | null;
  sessionId: string;
};

/** Parse a raw query: a leading `n:` (any case) means "names only". */
export function parseSessionQuery(raw: string): { text: string; namesOnly: boolean } {
  const trimmed = raw.trim();
  const m = /^n:\s*/i.exec(trimmed);
  if (m) return { text: trimmed.slice(m[0].length), namesOnly: true };
  return { text: trimmed, namesOnly: false };
}

// Score tiers (higher = better match), spaced so a title hit always outranks a
// body hit regardless of sub-tier.
const TITLE_EXACT = 100;
const TITLE_PREFIX = 80;
const TITLE_SUBSTR = 60;
const PROMPT_SUBSTR = 40;
const ID_SUBSTR = 20;

function titleScore(title: string | null | undefined, q: string): number {
  if (!title) return 0;
  const t = title.toLowerCase();
  if (t === q) return TITLE_EXACT;
  if (t.startsWith(q)) return TITLE_PREFIX;
  if (t.includes(q)) return TITLE_SUBSTR;
  return 0;
}

/**
 * Rank one session against a lowercased, non-empty query. Returns the best
 * matching tier's score, or `null` when nothing matches. With `namesOnly`, only
 * the title fields and first prompt are considered (not the session id).
 */
export function scoreSession(
  fields: SessionSearchFields,
  q: string,
  namesOnly = false,
): number | null {
  const title = Math.max(titleScore(fields.customTitle, q), titleScore(fields.claudiusTitle, q));
  if (title > 0) return title;
  if ((fields.firstPrompt ?? "").toLowerCase().includes(q)) return PROMPT_SUBSTR;
  if (!namesOnly && fields.sessionId.toLowerCase().includes(q)) return ID_SUBSTR;
  return null;
}
