import { promises as fs } from "node:fs";
import { join } from "node:path";
import { readScope, type ClaudeMdScope } from "./claudemd";
import { listSkills } from "./skills";
import { listDbAgents } from "./db-agents";
import { assertWithin, PathInjectionError } from "./safe-path";
import {
  findStalePromptPatterns,
  extractReferencedPaths,
  type PromptAuditMatch,
} from "@/lib/shared/prompt-audit";

/**
 * CC 2.1.283 parity — file discovery + fs-existence checks for the
 * `/doctor prompt-audit` report. The pure pattern-matching heuristics live in
 * `lib/shared/prompt-audit.ts`; this module owns everything that touches
 * disk: CLAUDE.md scopes (`lib/server/claudemd.ts`, same source
 * `claudeMdSizeChecks` in `app/api/doctor/route.ts` already reads), project
 * skills (`lib/server/skills.ts`), DB-backed agents
 * (`lib/server/db-agents.ts`), and file-based `.claude/commands/*.md` —
 * matching upstream's "CLAUDE.md files, skills, agents and commands" scope.
 *
 * Conservative scope decision: stale-path checking only runs against
 * CLAUDE.md content, not skills/agents/commands — CLAUDE.md is where
 * project-structure file references actually live; skill/agent/command
 * bodies mostly reference tool names and prose. See the cc-parity run-notes
 * "Risks / follow-ups" for the maximal alternative (checking all four
 * source kinds) that was considered and not taken this release.
 */

export type PromptAuditSourceKind = "claude-md" | "skill" | "agent" | "command";

export type PromptAuditSource = {
  kind: PromptAuditSourceKind;
  /** Scope name (claude-md), skill/agent name, or command filename. */
  name: string;
};

export type PromptAuditFinding = PromptAuditMatch & { source: PromptAuditSource };
export type PromptAuditStalePath = { source: PromptAuditSource; path: string };

export type PromptAuditReport = {
  findings: PromptAuditFinding[];
  stalePaths: PromptAuditStalePath[];
  /** True once at least one CLAUDE.md/skill/agent/command source was found. */
  hadSources: boolean;
};

const CLAUDE_MD_SCOPES: ClaudeMdScope[] = ["project", "project-claude", "local"];

async function pathReferenceExists(root: string, candidate: string): Promise<boolean> {
  try {
    // assertWithin is the path-injection barrier — `candidate` comes from
    // CLAUDE.md prose the user (or a cloned repo) wrote, not raw HTTP input,
    // but it still shouldn't be trusted to stay inside the workspace root.
    const resolved = assertWithin(root, candidate);
    await fs.access(resolved);
    return true;
  } catch (err) {
    // A reference that resolves outside the workspace isn't "stale" in the
    // sense this check cares about (a file that used to exist and got
    // deleted/renamed) — it's just not ours to judge. Only report a
    // within-workspace path that's actually missing.
    if (err instanceof PathInjectionError) return true;
    return false;
  }
}

async function listCommandFiles(cwd: string): Promise<{ name: string; body: string }[]> {
  const dir = join(cwd, ".claude", "commands");
  let entries: import("node:fs").Dirent[];
  try {
    entries = await fs.readdir(dir, { withFileTypes: true });
  } catch {
    return [];
  }
  const out: { name: string; body: string }[] = [];
  for (const entry of entries) {
    if (!entry.isFile() || !entry.name.toLowerCase().endsWith(".md")) continue;
    try {
      const resolved = assertWithin(dir, entry.name);
      out.push({ name: entry.name, body: await fs.readFile(resolved, "utf8") });
    } catch {
      // Unreadable or escaped the directory — skip silently, same
      // best-effort contract as `listSkills`' malformed-entry handling.
    }
  }
  return out;
}

export async function auditWorkspacePrompts(cwd: string): Promise<PromptAuditReport> {
  const sources: { source: PromptAuditSource; text: string }[] = [];

  for (const scope of CLAUDE_MD_SCOPES) {
    const f = await readScope(scope, cwd);
    if (f.exists && f.content.trim()) {
      sources.push({ source: { kind: "claude-md", name: scope }, text: f.content });
    }
  }

  try {
    const skills = await listSkills("project", cwd);
    for (const s of skills) {
      sources.push({ source: { kind: "skill", name: s.name }, text: s.raw });
    }
  } catch {
    // Best-effort — a skills-directory read failure shouldn't block the
    // rest of the audit.
  }

  try {
    const agents = await listDbAgents(cwd);
    for (const a of agents) {
      const text = [a.definition.description, a.definition.prompt].filter(Boolean).join("\n\n");
      if (text.trim()) sources.push({ source: { kind: "agent", name: a.name }, text });
    }
  } catch {
    // Best-effort, same reasoning as skills above.
  }

  for (const c of await listCommandFiles(cwd)) {
    sources.push({ source: { kind: "command", name: c.name }, text: c.body });
  }

  const findings: PromptAuditFinding[] = [];
  const stalePaths: PromptAuditStalePath[] = [];

  for (const { source, text } of sources) {
    for (const match of findStalePromptPatterns(text)) {
      findings.push({ ...match, source });
    }
    if (source.kind === "claude-md") {
      for (const p of extractReferencedPaths(text)) {
        if (!(await pathReferenceExists(cwd, p))) stalePaths.push({ source, path: p });
      }
    }
  }

  return { findings, stalePaths, hadSources: sources.length > 0 };
}
