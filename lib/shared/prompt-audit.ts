/**
 * CC 2.1.283 parity — "Added `/doctor prompt-audit` (also `/checkup
 * prompt-audit`) to audit your CLAUDE.md files, skills, agents and commands
 * for prompting patterns written for older models" + the same release's
 * "Improved `prompt-audit` on Claude Code configuration: ... thinking
 * keywords that Claude Code documents are kept."
 *
 * Pure, deterministic heuristics — no fs, no model call. Kept side-effect-free
 * so the matching logic is unit-testable without touching disk;
 * `lib/server/prompt-audit.ts` does the file discovery (CLAUDE.md scopes,
 * skills, DB agents, `.claude/commands/*.md`) and calls into this module.
 * Same "deterministic heuristic, not an in-session model call" shape as the
 * existing `claudeMdSizeChecks` in `app/api/doctor/route.ts` (CC 2.1.206
 * parity) — this route is a fast session-less GET probe, so there's no
 * turn to spend on judgment calls the way upstream's in-session `/doctor`
 * can.
 *
 * Deliberately conservative on false positives: Claude Code's own documented
 * "thinking keywords" (think / think hard / think harder / megathink /
 * ultrathink / keep thinking) are extended-thinking budget triggers, NOT
 * stale prompting — this module must never flag a bare "think". Only
 * literal chain-of-thought SCAFFOLDING phrases ("think step by step",
 * "let's think this through carefully") and pre-reasoning-model persona
 * boilerplate ("you are a helpful AI assistant", "as an AI language model")
 * get flagged, plus references to retired Claude generations.
 */

export type PromptAuditPattern = "cot-scaffolding" | "legacy-persona" | "deprecated-model-ref";

export type PromptAuditMatch = {
  pattern: PromptAuditPattern;
  /** Human-readable description of why this pattern is flagged. */
  note: string;
  /** ~80-char snippet of the surrounding text, for the report. */
  snippet: string;
};

const PATTERNS: { pattern: PromptAuditPattern; re: RegExp; note: string }[] = [
  {
    pattern: "cot-scaffolding",
    // Explicit step-by-step / "think this through carefully" scaffolding —
    // NOT the bare "think" / "think hard" / "ultrathink" family CC's own
    // docs use as extended-thinking budget triggers. The lookahead-free
    // phrasing below only matches when "step by step" (or a close variant)
    // or "carefully" actually appears alongside "think"/"work through".
    re: /think\s+(?:about (?:this|it) )?step[- ]by[- ]step|let'?s think (?:this |it )?through carefully|work(?:ing)? through (?:this|it) step[- ]by[- ]step/gi,
    note: "chain-of-thought scaffolding — redundant with native extended thinking",
  },
  {
    // `\b` after every bare "AI" — without it, the case-insensitive `AI`
    // matches inside "aid"/"aide" ("as an ai" is a literal prefix of "as an
    // aid"), which would false-positive on ordinary prose.
    pattern: "legacy-persona",
    re: /you are (?:a |an )?(?:helpful|friendly|knowledgeable)\s+AI\b(?:\s+(?:assistant|language model))?|as an AI\b(?:\s+language model)?/gi,
    note: "pre-Claude assistant-persona boilerplate",
  },
  {
    pattern: "deprecated-model-ref",
    re: /\bclaude[- ](?:1|2|instant|3-(?:opus|sonnet|haiku))\b/gi,
    note: "reference to a retired Claude generation",
  },
];

function snippetAround(text: string, index: number, length: number): string {
  const start = Math.max(0, index - 20);
  const end = Math.min(text.length, index + length + 20);
  const prefix = start > 0 ? "…" : "";
  const suffix = end < text.length ? "…" : "";
  return `${prefix}${text.slice(start, end).replace(/\s+/g, " ").trim()}${suffix}`;
}

/** Scan `text` for stale, pre-reasoning-model prompting patterns. */
export function findStalePromptPatterns(text: string): PromptAuditMatch[] {
  if (!text) return [];
  const out: PromptAuditMatch[] = [];
  for (const { pattern, re, note } of PATTERNS) {
    re.lastIndex = 0;
    let m: RegExpExecArray | null;
    while ((m = re.exec(text))) {
      out.push({ pattern, note, snippet: snippetAround(text, m.index, m[0].length) });
      if (re.lastIndex === m.index) re.lastIndex++; // zero-width-match guard
    }
  }
  return out;
}

// Backtick-quoted, path-shaped tokens — the convention this repo's own
// CLAUDE.md / AGENTS.md files use for file references (e.g. `lib/server/
// session.ts`). Requires at least one `/` and a short extension so plain
// backtick-quoted identifiers, flags, or code symbols don't false-positive.
const PATH_TOKEN_RE = /`([\w.\-]+(?:\/[\w.\-]+)+\.[A-Za-z0-9]{1,8})`/g;

/**
 * Extract candidate file-path references from prose. Existence is checked
 * by the caller (server-side, against the workspace root) — this module
 * stays fs-free so it's unit-testable in isolation.
 */
export function extractReferencedPaths(text: string): string[] {
  if (!text) return [];
  const out = new Set<string>();
  let m: RegExpExecArray | null;
  PATH_TOKEN_RE.lastIndex = 0;
  while ((m = PATH_TOKEN_RE.exec(text))) {
    out.add(m[1]);
  }
  return [...out];
}

// CC 2.1.283 (H3) — backtick-quoted slash-command references (`/name` or
// `/name args`). Matching only the backtick form is what keeps `/api/...`
// paths and `/usr/...` prose from false-flagging: after the command name the
// next char must be a space or the closing backtick, so `/api/x` (next char
// `/`) and `/dir:x` (next char `:`) never match. Names are lowercase-led.
const COMMAND_REF_RE = /`\/([a-z][\w-]*)(?: [^`]*)?`/g;

/**
 * Extract backtick-quoted `/command` references from prose (without the
 * leading slash). Namespaced (`/dir:x`), MCP (`/mcp__…`) and path-shaped refs
 * are intentionally excluded — they can't be validated without a live session.
 * The caller validates the rest against the known-command set.
 */
export function extractReferencedCommands(text: string): string[] {
  if (!text) return [];
  const out = new Set<string>();
  COMMAND_REF_RE.lastIndex = 0;
  let m: RegExpExecArray | null;
  while ((m = COMMAND_REF_RE.exec(text))) {
    const name = m[1];
    if (name.startsWith("mcp__")) continue; // MCP prompt, not a slash command
    out.add(name);
  }
  return [...out];
}

// CC 2.1.283 (H3) — directive polarity. `must` is positive only when not
// "must not". Each class is matched per sentence; a sentence carrying both
// classes is ambiguous and skipped.
const POSITIVE_DIRECTIVE_RE = /\balways\b|\bmust\b(?! not)|\bonly use\b/i;
const NEGATIVE_DIRECTIVE_RE = /\bnever\b|\bdon'?t\b|\bdo not\b|\bmust not\b|\bavoid\b/i;
const BACKTICK_TOKEN_RE = /`([^`]+)`/g;

export type InstructionContradiction = {
  /** The backtick token given opposite directives across files. */
  token: string;
  /** The conflicting source ids (opaque to this module; the caller supplies them). */
  sources: string[];
};

/**
 * CC 2.1.283 (H3) — detect instruction files that give a backtick-quoted token
 * directly opposite directives. Deliberately conservative to avoid prose
 * noise: only backtick tokens count; polarity is scoped per sentence (split on
 * `.`, `;`, newline); a sentence with BOTH polarities is skipped as ambiguous;
 * and only *cross-source* conflicts are flagged (the same token with opposite
 * polarity in two different files), matching upstream's "contradicting
 * instruction *files*". Pure so it's unit-testable without disk.
 */
export function findInstructionContradictions(
  sources: { id: string; text: string }[],
): InstructionContradiction[] {
  const byToken = new Map<string, { pos: Set<string>; neg: Set<string> }>();
  for (const { id, text } of sources) {
    if (!text) continue;
    for (const sentence of text.split(/[.;\n]/)) {
      const pos = POSITIVE_DIRECTIVE_RE.test(sentence);
      const neg = NEGATIVE_DIRECTIVE_RE.test(sentence);
      if (pos === neg) continue; // neither, or both (ambiguous)
      BACKTICK_TOKEN_RE.lastIndex = 0;
      let m: RegExpExecArray | null;
      while ((m = BACKTICK_TOKEN_RE.exec(sentence))) {
        const token = m[1].trim();
        if (!token) continue;
        const entry = byToken.get(token) ?? { pos: new Set<string>(), neg: new Set<string>() };
        (pos ? entry.pos : entry.neg).add(id);
        byToken.set(token, entry);
      }
    }
  }
  const out: InstructionContradiction[] = [];
  for (const [token, { pos, neg }] of byToken) {
    // Cross-file: at least one positive source and one DIFFERENT negative source.
    const conflict = [...pos].some((p) => [...neg].some((n) => n !== p));
    if (conflict) {
      out.push({ token, sources: [...new Set([...pos, ...neg])].sort() });
    }
  }
  return out;
}
