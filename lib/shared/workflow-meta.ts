/**
 * Best-effort parser for a Workflow tool's `meta = { name, description, phases }`
 * literal, extracted from the raw `script` string.
 *
 * The Workflow tool contract guarantees `meta` is a PURE object literal (no
 * computed values, no interpolation) and that it appears at the very top of the
 * script — so this also works on a partially-streamed script (`__partial`),
 * where truncated values simply come back `undefined`. The parser is
 * quote-aware (handles `'`, `"`, backtick, and backslash escapes) rather than a
 * naive regex, so apostrophes inside descriptions don't derail it. It NEVER
 * throws: any malformed/foreign input yields an empty `{ phases: [] }`.
 */

export type WorkflowPhase = { title: string; detail?: string };

export type WorkflowMeta = {
  name?: string;
  description?: string;
  phases: WorkflowPhase[];
};

/** Read a quoted string literal starting at/after `from`, honoring escapes. */
function readString(src: string, from: number): { value: string; end: number } | null {
  let i = from;
  while (i < src.length && /\s/.test(src[i]!)) i++;
  const q = src[i];
  if (q !== "'" && q !== '"' && q !== "`") return null;
  i++;
  let out = "";
  for (; i < src.length; i++) {
    const c = src[i]!;
    if (c === "\\") {
      const next = src[i + 1];
      out += next === "n" ? "\n" : next === "t" ? "\t" : (next ?? "");
      i++;
      continue;
    }
    if (c === q) return { value: out, end: i + 1 };
    out += c;
  }
  return null; // unterminated — e.g. a value truncated mid-stream
}

/** Slice a balanced {…} or […] beginning at `openIdx`, skipping string bodies. */
function sliceBalanced(src: string, openIdx: number): string | null {
  const open = src[openIdx];
  const close = open === "{" ? "}" : open === "[" ? "]" : null;
  if (!close) return null;
  let depth = 0;
  let quote: string | null = null;
  for (let i = openIdx; i < src.length; i++) {
    const c = src[i]!;
    if (quote) {
      if (c === "\\") {
        i++;
        continue;
      }
      if (c === quote) quote = null;
      continue;
    }
    if (c === "'" || c === '"' || c === "`") {
      quote = c;
      continue;
    }
    if (c === open) depth++;
    else if (c === close) {
      depth--;
      if (depth === 0) return src.slice(openIdx, i + 1);
    }
  }
  return null; // unbalanced — still streaming
}

/** Find `<key>: "<string>"` at a property boundary and return the value. */
function extractStringField(objSrc: string, key: string): string | undefined {
  const re = new RegExp(`(?:^|[,{[\\s])${key}\\s*:\\s*`);
  const m = re.exec(objSrc);
  if (!m) return undefined;
  return readString(objSrc, m.index + m[0].length)?.value;
}

function parsePhases(metaSrc: string): WorkflowPhase[] {
  const m = /(?:^|[,{\s])phases\s*:\s*\[/.exec(metaSrc);
  if (!m) return [];
  const arrStart = metaSrc.indexOf("[", m.index);
  if (arrStart < 0) return [];
  const arrSrc = sliceBalanced(metaSrc, arrStart);
  if (!arrSrc) return [];
  const inner = arrSrc.slice(1, -1);
  const phases: WorkflowPhase[] = [];
  let i = 0;
  while (i < inner.length) {
    if (inner[i] === "{") {
      const objSrc = sliceBalanced(inner, i);
      if (!objSrc) break;
      const title = extractStringField(objSrc, "title");
      if (title) phases.push({ title, detail: extractStringField(objSrc, "detail") });
      i += objSrc.length;
    } else {
      i++;
    }
  }
  return phases;
}

export function parseWorkflowMeta(source: string | undefined | null): WorkflowMeta {
  if (!source || typeof source !== "string") return { phases: [] };
  try {
    const m = /export\s+const\s+meta\s*=\s*\{/.exec(source);
    if (!m) return { phases: [] };
    const braceIdx = source.indexOf("{", m.index);
    if (braceIdx < 0) return { phases: [] };
    // When the object is still streaming it won't balance — fall back to
    // scanning from the opening brace to end-of-string so we can still pull
    // whatever fields have arrived (name/description stream before phases).
    const metaSrc = sliceBalanced(source, braceIdx) ?? source.slice(braceIdx);
    return {
      name: extractStringField(metaSrc, "name"),
      description: extractStringField(metaSrc, "description"),
      phases: parsePhases(metaSrc),
    };
  } catch {
    return { phases: [] };
  }
}
