/**
 * Parser for the `TaskList` SDK tool's result text. The shape is one entry
 * per line:
 *
 *     #1 [completed] Add shared advisor constants module
 *     #2 [in_progress] Plumb advisorModel through use-session.ts
 *
 * `#${id}` is whatever id the SDK assigned (typically numeric, but we accept
 * any non-whitespace token so a future SDK that switches to slugs doesn't
 * silently break the rail). The bracketed status is one of
 * `pending` / `in_progress` / `completed` (we don't whitelist — pass the
 * verbatim string through, same way the TaskUpdate observer does).
 *
 * Why this exists: after `clearTodos()` nulls `latestTodosSnapshot` (manual
 * clear, the auto-`"completed"` clear on stop-reason "completed", or the
 * `"stale"` auto-clear after TODOS_AUTO_CLEAR_MS), subsequent `TaskUpdate`
 * tool_use events are silently dropped because their observer at
 * `lib/server/session.ts:5544` is gated on a non-null snapshot. The model
 * (and the SDK's own task store) still hold the tasks, but the rail shows
 * (0) forever — see the bug surfaced in session a31d05a5 where the user
 * asked "update the task todos please, mark the ones that are done", the
 * model called `TaskList` + 15 `TaskUpdate`s, and the rail stayed empty.
 *
 * Wiring this parser into both the server-side observer in
 * `captureSnapshotState` and the client-side observer in `use-session.ts`
 * makes the rail self-healing: any `TaskList` call refreshes the snapshot
 * from the SDK's authoritative state.
 *
 * Return contract:
 *   - non-empty match → the parsed array (caller replaces the snapshot).
 *   - empty input string → `[]` (caller wipes the snapshot — the SDK store
 *     is empty, so the rail should be too).
 *   - non-empty input that doesn't match the expected shape → `null`
 *     (caller leaves the snapshot alone; a future SDK output change should
 *     fail open, not nuke the user's view).
 */
export type ParsedTaskListEntry = {
  id: string;
  content: string;
  status: string;
};

/**
 * Match a single TaskList line: `#<id> [<status>] <subject>`. The id is any
 * non-whitespace run so a future SDK that switches from numeric ids to slugs
 * doesn't silently start dropping entries. The status is bracketed and the
 * subject is the rest of the line; we trim both to absorb any incidental
 * whitespace the SDK might emit.
 *
 * The subject is `\S.*` (not `.+`) on purpose: anchoring it to a non-space
 * first char removes the overlap between the preceding `\s+` separator and a
 * `.+` that could ALSO match those spaces. That overlap is an ambiguous
 * adjacent-quantifier "pump" — CodeQL `js/polynomial-redos` flagged it as
 * quadratic-time backtracking on lines with long runs of whitespace. With
 * `\S.*` the whitespace split is deterministic (one way to match), so the
 * regex is linear. The captured subject is `.trim()`ed by the caller anyway,
 * so this only drops whitespace-only "subjects" (already meaningless).
 */
const TASK_LIST_LINE_RE = /^#(\S+)\s+\[([^\]]+)\]\s+(\S.*)$/;

export function parseTaskListResult(text: string | null | undefined): ParsedTaskListEntry[] | null {
  if (text == null) return null;
  // Trim outer whitespace so a result that's purely whitespace is treated
  // the same as the empty string (wipe). Inner whitespace inside individual
  // lines is preserved — TaskUpdate inputs would have done the same.
  const trimmed = text.trim();
  if (trimmed === "") return [];

  const lines = trimmed.split("\n");
  const parsed: ParsedTaskListEntry[] = [];
  for (const line of lines) {
    const m = TASK_LIST_LINE_RE.exec(line.trim());
    if (!m) continue;
    parsed.push({ id: m[1], content: m[3].trim(), status: m[2].trim() });
  }
  // Non-empty input with zero matches → unknown shape. Fail open (return
  // null so callers don't replace the snapshot) instead of wiping — better
  // to keep a stale list than to drop everything if the SDK output format
  // shifts under us.
  if (parsed.length === 0) return null;
  return parsed;
}
