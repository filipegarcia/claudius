/**
 * CC 2.1.327 parity — "Improved transcript search to find text in edits and
 * written files."
 *
 * The find bar (`TranscriptSearch`) only searches rendered DOM text, and the
 * file-mutating tool cards are collapsed by default with their input shown as
 * an escaped JSON dump. These helpers name the text an Edit / MultiEdit /
 * Write / NotebookEdit call carries, so the card can render it as plain text
 * and open itself while the find query matches it.
 */

/** Tools whose input carries file text the find bar should reach. */
export const FILE_EDIT_TOOLS: ReadonlySet<string> = new Set(["Edit", "MultiEdit", "Write", "NotebookEdit"]);

export type ToolInputTextField = {
  /** Input key the text came from (`edit 2 · new_string` for MultiEdit). */
  label: string;
  text: string;
};

function str(v: unknown): string | null {
  return typeof v === "string" ? v : null;
}

/**
 * The searchable text fields of a file-mutating tool's input, in display
 * order. Empty for any other tool, and for fields that aren't strings (a
 * NotebookEdit delete has no `new_source`).
 */
export function toolInputTextFields(name: string, input: Record<string, unknown>): ToolInputTextField[] {
  if (!FILE_EDIT_TOOLS.has(name)) return [];
  const out: ToolInputTextField[] = [];
  const push = (label: string, v: unknown) => {
    const s = str(v);
    if (s !== null) out.push({ label, text: s });
  };
  switch (name) {
    case "Edit":
      push("old_string", input.old_string);
      push("new_string", input.new_string);
      break;
    case "MultiEdit": {
      const edits = Array.isArray(input.edits) ? input.edits : [];
      edits.forEach((e, i) => {
        if (!e || typeof e !== "object") return;
        const edit = e as Record<string, unknown>;
        push(`edit ${i + 1} · old_string`, edit.old_string);
        push(`edit ${i + 1} · new_string`, edit.new_string);
      });
      break;
    }
    case "Write":
      push("content", input.content);
      break;
    case "NotebookEdit":
      push("new_source", input.new_source);
      break;
  }
  return out;
}

/** Input keys rendered as text blocks, so the leftover JSON doesn't repeat them. */
export function toolInputTextKeys(name: string): readonly string[] {
  switch (name) {
    case "Edit":
      return ["old_string", "new_string"];
    case "MultiEdit":
      return ["edits"];
    case "Write":
      return ["content"];
    case "NotebookEdit":
      return ["new_source"];
    default:
      return [];
  }
}

/**
 * Whether the find query occurs in one of the tool's text fields. Literal
 * substring, case-insensitive unless `matchCase` — the same semantics as the
 * find bar's DOM scan. The query is not trimmed, matching the bar.
 */
export function toolInputMatches(
  name: string,
  input: Record<string, unknown>,
  query: string,
  matchCase: boolean,
): boolean {
  if (!query) return false;
  const needle = matchCase ? query : query.toLowerCase();
  return toolInputTextFields(name, input).some(({ text }) =>
    (matchCase ? text : text.toLowerCase()).includes(needle),
  );
}
