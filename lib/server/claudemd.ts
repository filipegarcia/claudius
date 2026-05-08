import { promises as fs } from "node:fs";
import { homedir } from "node:os";
import { dirname, isAbsolute, join, relative, resolve } from "node:path";

export type ClaudeMdScope = "user" | "project" | "project-claude" | "local";

export type ScopeFile = {
  scope: ClaudeMdScope;
  path: string;
  exists: boolean;
  content: string;
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
  if (scope === "user") return join(homedir(), ".claude", "CLAUDE.md");
  if (scope === "project") return join(projectCwd, "CLAUDE.md");
  if (scope === "project-claude") return join(projectCwd, ".claude", "CLAUDE.md");
  return join(projectCwd, "CLAUDE.local.md");
}

export async function readScope(scope: ClaudeMdScope, projectCwd: string): Promise<ScopeFile> {
  const path = pathFor(scope, projectCwd);
  try {
    const content = await fs.readFile(path, "utf8");
    return { scope, path, exists: true, content };
  } catch (err) {
    const e = err as NodeJS.ErrnoException;
    if (e.code === "ENOENT") return { scope, path, exists: false, content: "" };
    throw err;
  }
}

export async function writeScope(
  scope: ClaudeMdScope,
  projectCwd: string,
  content: string,
): Promise<void> {
  const path = pathFor(scope, projectCwd);
  await fs.mkdir(dirname(path), { recursive: true });
  await fs.writeFile(path, content, "utf8");
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
