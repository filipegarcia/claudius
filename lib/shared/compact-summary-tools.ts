/**
 * CC 2.1.304 — "Added the names of the tools called earlier to the compaction
 * summary in the transcript view (Ctrl+O)".
 *
 * The 2.1.304 engine writes the names into the compact-summary text itself, as
 * one tag line before `Summary:`:
 *
 *   <tools-used-before-summary>Bash, Edit, Read</tools-used-before-summary>
 *
 * The tag is always written, and is empty when no tools ran. The names carry
 * over across repeated compactions. Only the terminal rewrites the tag for
 * display ("Tools called before this summary: …"); SDK hosts get it raw. This
 * splits it out so Claudius's "show summary" view can show the names as a line
 * of their own, without the raw tag. Text from an older engine, with no tag,
 * comes back unchanged.
 *
 * Pure, dependency-free, and shared so it can be unit-tested.
 */

// Fixed pattern (no user input reaches a RegExp constructor). Not anchored to
// the start: the engine may put a marker line before the summary preamble.
const TOOLS_TAG = /<tools-used-before-summary>([^<]*)<\/tools-used-before-summary>[ \t]*\r?\n?/;

export type CompactSummaryParts = {
  /** Tool names in the engine's order, de-duplicated; empty when none ran. */
  tools: string[];
  /** The summary text with the tag line removed. */
  body: string;
};

export function splitCompactSummaryTools(text: string): CompactSummaryParts {
  const m = TOOLS_TAG.exec(text);
  if (!m) return { tools: [], body: text };
  const tools = Array.from(
    new Set(
      m[1]
        .split(",")
        .map((s) => s.trim())
        .filter(Boolean),
    ),
  );
  const body = text.slice(0, m.index) + text.slice(m.index + m[0].length);
  return { tools, body };
}
