/**
 * Minimal JSON syntax-highlighting tokenizer — CC 2.1.259/2.1.260 parity for
 * `/workflows`' "JSON outcomes are pretty-printed with syntax colors and
 * real line breaks." Claudius's `WorkflowBlock.tsx` already gets real line
 * breaks for free from `JSON.stringify(value, null, 2)`; this fills the
 * "syntax colors" gap.
 *
 * Deliberately hand-rolled rather than pulling in a dependency
 * (`react-json-view`, `shiki`, etc.) — see the rejected-alternative note in
 * `.claudius/cc-parity/run-notes/2.1.260.md`. The values passing through
 * here are small, already-parsed JSON blobs (tool args, a Workflow run's
 * result payload), not arbitrary source code that would need a real
 * grammar.
 */

export type JsonTokenType = "key" | "string" | "number" | "boolean" | "null" | "punct";

export type JsonToken = { text: string; type: JsonTokenType };

/**
 * Tokenizes a `JSON.stringify(value, null, 2)`-style pretty-printed string
 * into typed runs for syntax-highlighted rendering. Everything that isn't a
 * string/number/boolean/null literal (braces, brackets, commas, colons,
 * indentation, newlines) is grouped into `"punct"` runs and rendered
 * verbatim, so whitespace and line breaks are preserved exactly.
 *
 * The regex is a fixed literal (not built from external input — this isn't
 * a `js/regex-injection` sink) and matches the standard "JSON string /
 * number / literal" grammar; each alternative consumes at least one
 * character per step, so it stays linear-time even on adversarial input
 * (no nested quantifiers over the same class).
 */
const TOKEN_RE =
  /("(?:\\u[0-9a-fA-F]{4}|\\.|[^\\"])*"(\s*:)?)|\btrue\b|\bfalse\b|\bnull\b|-?\d+(?:\.\d+)?(?:[eE][+-]?\d+)?/g;

export function tokenizeJsonPretty(pretty: string): JsonToken[] {
  const tokens: JsonToken[] = [];
  let lastIndex = 0;
  let m: RegExpExecArray | null;
  TOKEN_RE.lastIndex = 0;
  while ((m = TOKEN_RE.exec(pretty)) !== null) {
    if (m.index > lastIndex) {
      tokens.push({ text: pretty.slice(lastIndex, m.index), type: "punct" });
    }
    const text = m[0];
    let type: JsonTokenType;
    if (text.startsWith('"')) {
      type = /:\s*$/.test(text) ? "key" : "string";
    } else if (text === "true" || text === "false") {
      type = "boolean";
    } else if (text === "null") {
      type = "null";
    } else {
      type = "number";
    }
    tokens.push({ text, type });
    lastIndex = TOKEN_RE.lastIndex;
  }
  if (lastIndex < pretty.length) {
    tokens.push({ text: pretty.slice(lastIndex), type: "punct" });
  }
  return tokens;
}

/** Pretty-print + tokenize a value in one step. Falls back to `String(value)` if it isn't JSON-serializable. */
export function tokenizeJsonValue(value: unknown): JsonToken[] {
  let pretty: string;
  try {
    pretty = JSON.stringify(value, null, 2) ?? String(value);
  } catch {
    pretty = String(value);
  }
  return tokenizeJsonPretty(pretty);
}
