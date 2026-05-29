import { promises as fs } from "node:fs";
import { homedir } from "node:os";
import { dirname, join, resolve, sep } from "node:path";
import { parse as parseYaml } from "yaml";
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
// Everything between the leading `---` delimiters is the frontmatter (parsed
// as YAML); the rest is the body. Backed by the `yaml` package rather than a
// hand-rolled subset so nested structures round-trip — notably the object
// form of an agent's `mcpServers` (e.g. `mcpServers:\n  srv:\n    command: x`),
// which the previous scalar+flat-list parser could not represent. Scalars,
// flow lists (`[a, b]`), and block lists still parse identically.

const FM_RE = /^---\r?\n([\s\S]*?)\r?\n---\r?\n?([\s\S]*)$/;

export function parseFrontmatter(raw: string): { frontmatter: Record<string, unknown>; body: string } {
  const m = FM_RE.exec(raw);
  if (!m) return { frontmatter: {}, body: raw };
  let frontmatter: Record<string, unknown> = {};
  try {
    // YAML 1.2 core schema (the `yaml` default): booleans/numbers/null parse
    // to their JS types; ISO date strings stay strings (no YAML-1.1 timestamp
    // coercion), so a `model:`/`description:` that looks date-ish is safe.
    const parsed = parseYaml(m[1]);
    if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
      frontmatter = parsed as Record<string, unknown>;
    }
  } catch {
    // Malformed YAML frontmatter falls back to empty — matching the prior
    // parser's tolerance — rather than throwing. The body is still returned
    // so the agent/skill prompt remains editable in the UI.
  }
  return { frontmatter, body: m[2] };
}
