import { promises as fs } from "node:fs";
import { homedir } from "node:os";
import { dirname, join, resolve, sep } from "node:path";
import { assertWithin } from "./safe-path";

export type AgentScope = "user" | "project";

export type AgentFile = {
  scope: AgentScope;
  name: string; // filename without .md
  path: string;
  frontmatter: Record<string, unknown>;
  body: string;
  raw: string;
};

export function agentsDir(scope: AgentScope, projectCwd: string): string {
  if (scope === "user") return join(homedir(), ".claude", "agents");
  return join(projectCwd, ".claude", "agents");
}

export function agentPath(scope: AgentScope, projectCwd: string, name: string): string {
  if (!/^[\w.\-]+$/.test(name)) throw new Error("invalid agent name");
  // assertWithin is the path-injection barrier — guarantees the resolved
  // path stays inside the scoped agents directory even if `name` somehow
  // got past the regex (defence-in-depth) and gives CodeQL a recognized
  // sanitizer on the projectCwd → fs.* flow.
  const dir = agentsDir(scope, projectCwd);
  return assertWithin(dir, `${name}.md`);
}

export async function listAgents(scope: AgentScope, projectCwd: string): Promise<AgentFile[]> {
  const dir = agentsDir(scope, projectCwd);
  let entries: string[];
  try {
    entries = await fs.readdir(dir);
  } catch (err) {
    const e = err as NodeJS.ErrnoException;
    if (e.code === "ENOENT") return [];
    throw err;
  }
  const out: AgentFile[] = [];
  for (const filename of entries) {
    if (!filename.endsWith(".md")) continue;
    const fullPath = join(dir, filename);
    try {
      const raw = await fs.readFile(fullPath, "utf8");
      const parsed = parseFrontmatter(raw);
      out.push({
        scope,
        name: filename.replace(/\.md$/, ""),
        path: fullPath,
        frontmatter: parsed.frontmatter,
        body: parsed.body,
        raw,
      });
    } catch {
      // skip unreadable
    }
  }
  out.sort((a, b) => a.name.localeCompare(b.name));
  return out;
}

export async function readAgent(scope: AgentScope, projectCwd: string, name: string): Promise<AgentFile | null> {
  const p = agentPath(scope, projectCwd, name);
  try {
    const raw = await fs.readFile(p, "utf8");
    const parsed = parseFrontmatter(raw);
    return { scope, name, path: p, frontmatter: parsed.frontmatter, body: parsed.body, raw };
  } catch (err) {
    const e = err as NodeJS.ErrnoException;
    if (e.code === "ENOENT") return null;
    throw err;
  }
}

export async function writeAgent(
  scope: AgentScope,
  projectCwd: string,
  name: string,
  raw: string,
): Promise<void> {
  if (!/^[\w.\-]+$/.test(name)) throw new Error("invalid agent name");
  // Inline path-injection barrier: resolve both sides and assert the
  // child path stays inside the scoped agents directory. CodeQL's
  // js/path-injection query only recognizes the sanitizer when it
  // appears at the fs.* call site itself, not when wrapped in a helper.
  const baseDir = resolve(agentsDir(scope, projectCwd));
  const p = resolve(baseDir, `${name}.md`);
  if (p !== baseDir && !p.startsWith(baseDir + sep)) {
    throw new Error("path escapes base directory");
  }
  await fs.mkdir(dirname(p), { recursive: true });
  await fs.writeFile(p, raw, "utf8");
}

export async function deleteAgent(scope: AgentScope, projectCwd: string, name: string): Promise<boolean> {
  const p = agentPath(scope, projectCwd, name);
  try {
    await fs.unlink(p);
    return true;
  } catch (err) {
    const e = err as NodeJS.ErrnoException;
    if (e.code === "ENOENT") return false;
    throw err;
  }
}

// ─── frontmatter parser ────────────────────────────────────────────────
//
// Minimal YAML subset supporting:
//   key: scalar
//   key: [a, b, c]
//   key:
//     - a
//     - b
// Everything between the leading `---` delimiters is the frontmatter; the
// rest is the body.

const FM_RE = /^---\r?\n([\s\S]*?)\r?\n---\r?\n?([\s\S]*)$/;

export function parseFrontmatter(raw: string): { frontmatter: Record<string, unknown>; body: string } {
  const m = FM_RE.exec(raw);
  if (!m) return { frontmatter: {}, body: raw };
  const fm: Record<string, unknown> = {};
  const lines = m[1].split(/\r?\n/);
  let currentKey: string | null = null;
  let currentList: string[] | null = null;
  for (const line of lines) {
    if (!line.trim()) continue;
    const listMatch = /^\s*-\s+(.+)$/.exec(line);
    if (listMatch && currentKey && currentList) {
      currentList.push(unquote(listMatch[1].trim()));
      continue;
    }
    const kv = /^([A-Za-z_][\w-]*)\s*:\s*(.*)$/.exec(line);
    if (!kv) continue;
    const key = kv[1];
    const valueRaw = kv[2].trim();
    if (currentKey && currentList) {
      fm[currentKey] = currentList;
      currentList = null;
    }
    if (valueRaw === "") {
      currentKey = key;
      currentList = [];
    } else if (valueRaw.startsWith("[") && valueRaw.endsWith("]")) {
      const inner = valueRaw.slice(1, -1);
      const items = inner.split(",").map((p) => unquote(p.trim())).filter(Boolean);
      fm[key] = items;
      currentKey = null;
      currentList = null;
    } else {
      fm[key] = parseScalar(valueRaw);
      currentKey = null;
      currentList = null;
    }
  }
  if (currentKey && currentList) fm[currentKey] = currentList;
  return { frontmatter: fm, body: m[2] };
}

function parseScalar(v: string): unknown {
  if (/^(true|false)$/i.test(v)) return v.toLowerCase() === "true";
  if (/^-?\d+(\.\d+)?$/.test(v)) return Number(v);
  return unquote(v);
}

function unquote(s: string): string {
  if ((s.startsWith('"') && s.endsWith('"')) || (s.startsWith("'") && s.endsWith("'"))) {
    return s.slice(1, -1);
  }
  return s;
}
