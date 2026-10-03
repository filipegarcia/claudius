import { promises as fs } from "node:fs";
import { homedir } from "node:os";
import { dirname, isAbsolute, join, relative, resolve } from "node:path";
import { assertWithin } from "./safe-path";

export type ClaudeMdScope = "user" | "project" | "project-claude" | "local";

export type ScopeFile = {
  scope: ClaudeMdScope;
  path: string;
  exists: boolean;
  content: string;
  /**
   * Set on the "project" scope when this file is AGENTS.md rather than
   * CLAUDE.md — Claude Code 2.1.277 ("Added AGENTS.md support: in a project
   * with no CLAUDE.md, Claude Code reads AGENTS.md instead") reads AGENTS.md
   * for project instructions when no CLAUDE.md exists. Claudius's own Memory
   * page mirrors that so it shows the same file the live agent session
   * actually reads, instead of an empty "Project" tab. Absent (not `false`)
   * for every other scope and for "project" when CLAUDE.md exists.
   */
  usingAgentsFallback?: boolean;
};

export type ResolvedSegment = {
  scope: ClaudeMdScope | "import";
  source: string;
  content: string;
  /** 0 = top-level, increases with @path import depth. */
  depth: number;
};

const MAX_IMPORT_HOPS = 5;

export function pathFor(scope: ClaudeMdScope, projectCwd: string): string {
  // assertWithin acts as the path-injection barrier on the projectCwd →
  // fs.* flow. The relative segment is always a constant string, so the
  // check is effectively a "this is inside the workspace" guard.
  if (scope === "user") return assertWithin(join(homedir(), ".claude"), "CLAUDE.md");
  if (scope === "project") return assertWithin(projectCwd, "CLAUDE.md");
  if (scope === "project-claude") return assertWithin(projectCwd, join(".claude", "CLAUDE.md"));
  return assertWithin(projectCwd, "CLAUDE.local.md");
}

/** AGENTS.md path for the project-scope fallback — same directory as CLAUDE.md. */
function agentsPathFor(projectCwd: string): string {
  return assertWithin(projectCwd, "AGENTS.md");
}

export async function readScope(scope: ClaudeMdScope, projectCwd: string): Promise<ScopeFile> {
  const path = pathFor(scope, projectCwd);
  try {
    const content = await fs.readFile(path, "utf8");
    return { scope, path, exists: true, content };
  } catch (err) {
    const e = err as NodeJS.ErrnoException;
    if (e.code !== "ENOENT") throw err;
  }
  if (scope !== "project") return { scope, path, exists: false, content: "" };
  // No CLAUDE.md — Claude Code 2.1.277's AGENTS.md fallback. Only the
  // "project" scope is ambiguous this way (user/project-claude/local all
  // have one canonical file); see the ScopeFile.usingAgentsFallback doc.
  const agentsPath = agentsPathFor(projectCwd);
  try {
    const content = await fs.readFile(agentsPath, "utf8");
    return { scope, path: agentsPath, exists: true, content, usingAgentsFallback: true };
  } catch (err) {
    const e = err as NodeJS.ErrnoException;
    if (e.code === "ENOENT") return { scope, path, exists: false, content: "" };
    throw err;
  }
}

/**
 * Which file a "project" scope write should target — mirrors `readScope`'s
 * fallback so a save lands wherever the editor's content actually came
 * from: CLAUDE.md when it already exists, AGENTS.md when it's the active
 * fallback (CLAUDE.md absent, AGENTS.md present), else CLAUDE.md as the
 * default target for a brand-new project (matches Claude Code's own
 * default — AGENTS.md is only read, never created, by the fallback).
 */
async function resolveProjectWritePath(projectCwd: string): Promise<string> {
  const claudePath = pathFor("project", projectCwd);
  try {
    await fs.access(claudePath);
    return claudePath;
  } catch {
    // fall through to the AGENTS.md check below
  }
  const agentsPath = agentsPathFor(projectCwd);
  try {
    await fs.access(agentsPath);
    return agentsPath;
  } catch {
    return claudePath;
  }
}

export async function writeScope(
  scope: ClaudeMdScope,
  projectCwd: string,
  content: string,
): Promise<{ path: string }> {
  const path =
    scope === "project" ? await resolveProjectWritePath(projectCwd) : pathFor(scope, projectCwd);
  await fs.mkdir(dirname(path), { recursive: true });
  await fs.writeFile(path, content, "utf8");
  return { path };
}

export async function readAllScopes(projectCwd: string): Promise<ScopeFile[]> {
  return Promise.all(
    (["user", "project", "project-claude", "local"] as ClaudeMdScope[]).map((s) =>
      readScope(s, projectCwd),
    ),
  );
}

/**
 * Resolves a CLAUDE.md, expanding `@path` import directives recursively. Imports
 * at the start of a line that match `@<path>` are replaced with the file's
 * content (max 5 hops, with cycle detection).
 *
 * Returns a flat list of segments — one per file inlined — so the UI can show
 * provenance.
 */
export async function resolveContent(
  content: string,
  baseDir: string,
  visited: Set<string> = new Set(),
  depth = 0,
): Promise<ResolvedSegment[]> {
  if (depth > MAX_IMPORT_HOPS) {
    return [
      {
        scope: "import",
        source: "(max import depth exceeded)",
        content: "",
        depth,
      },
    ];
  }

  // Split on @path lines while preserving in-order rendering.
  const segments: ResolvedSegment[] = [];
  const lines = content.split("\n");
  let buffer: string[] = [];
  const flush = (label: string) => {
    if (buffer.length === 0) return;
    segments.push({ scope: "import", source: label, content: buffer.join("\n"), depth });
    buffer = [];
  };

  for (const line of lines) {
    const m = /^@(\S+)\s*$/.exec(line.trim());
    if (m) {
      flush("(inline)");
      const importPath = m[1];
      const abs = isAbsolute(importPath) ? importPath : resolve(baseDir, importPath);
      if (visited.has(abs)) {
        segments.push({ scope: "import", source: `${importPath} (cycle)`, content: "", depth });
        continue;
      }
      try {
        const inner = await fs.readFile(abs, "utf8");
        visited.add(abs);
        const inlined = await resolveContent(inner, dirname(abs), visited, depth + 1);
        for (const s of inlined) {
          segments.push({ ...s, source: `@${importPath} → ${s.source}` });
        }
      } catch {
        segments.push({ scope: "import", source: `${importPath} (missing)`, content: "", depth });
      }
    } else {
      buffer.push(line);
    }
  }
  flush("(inline)");

  return segments;
}

export type ResolvedHierarchy = {
  cwd: string;
  scopes: Array<{ scope: ClaudeMdScope; path: string; exists: boolean; segments: ResolvedSegment[] }>;
  totalChars: number;
};

export async function resolveHierarchy(projectCwd: string): Promise<ResolvedHierarchy> {
  const order: ClaudeMdScope[] = ["user", "project", "project-claude", "local"];
  const scopes: ResolvedHierarchy["scopes"] = [];
  let totalChars = 0;
  for (const scope of order) {
    const file = await readScope(scope, projectCwd);
    if (!file.exists) {
      scopes.push({ scope, path: file.path, exists: false, segments: [] });
      continue;
    }
    const segments = await resolveContent(file.content, dirname(file.path));
    for (const s of segments) totalChars += s.content.length;
    scopes.push({ scope, path: file.path, exists: true, segments });
  }
  return { cwd: projectCwd, scopes, totalChars };
}

export function relativeFromHome(p: string): string {
  const h = homedir();
  if (p.startsWith(h + "/")) return "~/" + relative(h, p);
  return p;
}
