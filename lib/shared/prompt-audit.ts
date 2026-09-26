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
