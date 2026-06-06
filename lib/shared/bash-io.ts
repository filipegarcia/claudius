/**
 * Pure helpers for the `!`-mode bash IO blocks (`<bash-input>`,
 * `<bash-stdout>`, `<bash-stderr>`). Kept in `lib/shared/` so the parser
 * is unit-testable from vitest without dragging React in via UserMessage,
 * and the server can reuse the matcher for any future "look back at the
 * last `!cmd` output" feature.
 */

/**
 * Matches one bash-IO block as emitted by `formatBashIOBlock` on the
 * server. Tolerates an optional `\n` between stdout and stderr — the
 * literal server output has none, but the JSONL serialiser sometimes
 * inserts one during reload deserialisation.
 *
 * Three capture groups: command (1), stdout (2), stderr (3).
 *
 * NB: the regex carries `/g` for callers that want to walk multiple blocks
 * via `exec` (e.g. `parseUserTextWithBashIO`). Reset `lastIndex` before
 * each use to avoid stateful surprises.
 */
export const BASH_IO_RE =
  /<bash-input>([\s\S]*?)<\/bash-input>\n?<bash-stdout>([\s\S]*?)<\/bash-stdout>\n?<bash-stderr>([\s\S]*?)<\/bash-stderr>/g;

export type BashIOSegment = {
  kind: "bash";
  command: string;
  stdout: string;
  stderr: string;
};
export type TextSegment = { kind: "text"; text: string };
export type Segment = BashIOSegment | TextSegment;

/**
 * Split a user-turn's raw text into bash-IO segments and plain text. Bash
 * blocks show up in two situations: (1) the live `!cmd` broadcast (whole
 * content is one block); (2) the JSONL replay of a user turn whose prefix
 * was queued by `pending-bash-output` ahead of the user's real text.
 *
 * Plain-text-only inputs collapse to a single `{kind:"text"}` segment so
 * the caller can use one render path either way. An empty input returns
 * an empty array.
 */
export function parseUserTextWithBashIO(raw: string): Segment[] {
  const segs: Segment[] = [];
  let cursor = 0;
  BASH_IO_RE.lastIndex = 0;
  for (let m: RegExpExecArray | null; (m = BASH_IO_RE.exec(raw)); ) {
    const start = m.index;
    if (start > cursor) {
      const before = raw.slice(cursor, start);
      if (before.length > 0) segs.push({ kind: "text", text: before });
    }
    segs.push({ kind: "bash", command: m[1], stdout: m[2], stderr: m[3] });
    cursor = start + m[0].length;
  }
  if (cursor < raw.length) {
    const tail = raw.slice(cursor);
    if (tail.length > 0) segs.push({ kind: "text", text: tail });
  }
  return segs;
}
