import { frontmatterError, listAgents } from "./agents";
import { listSkills } from "./skills";
import { keybindingsPath, readKeybindings } from "./keybindings";

/**
 * CC 2.1.327 parity — "Added a list in /status of broken agent, skill,
 * command and output style files, keybinding errors, …".
 *
 * Covers only what Claudius parses itself: agent `.md` and skill `SKILL.md`
 * frontmatter (user + project scope, via the same `listAgents`/`listSkills`
 * the Agents and Skills pages use) and `~/.claude/keybindings.json`. Command
 * files are read only as plain text by the prompt audit (no frontmatter
 * parse), and Claudius has no output-style file reader, so neither is
 * checked. Sandbox availability, hook matchers and ignored permission
 * settings are engine knowledge Claudius can't compute.
 *
 * Shared by `GET /api/doctor` (the "Config files" section) and the light
 * `GET /api/doctor/files` the /status overlay polls, so the two never
 * disagree about what counts as a problem.
 */

export type ConfigFileKind = "agent" | "skill" | "keybindings";

export type ConfigFileProblem = {
  kind: ConfigFileKind;
  scope: "user" | "project";
  /** Agent/skill name, or "keybindings.json". */
  name: string;
  path: string;
  reason: string;
  /** Set for project-scope files: the workspace whose `.claude/` holds it. */
  workspace?: { id: string; name: string };
};

export type ConfigFileWorkspace = { id: string; name: string; rootPath: string };

/** Agent and skill files in one scope whose frontmatter won't parse. */
export async function scopeFileProblems(
  scope: "user" | "project",
  projectCwd: string,
  workspace?: { id: string; name: string },
): Promise<ConfigFileProblem[]> {
  const out: ConfigFileProblem[] = [];
  // Each lister rethrows non-ENOENT readdir errors (EACCES, ENOTDIR) — one
  // unreadable directory must not take the whole report down.
  const agents = await listAgents(scope, projectCwd).catch(() => []);
  for (const a of agents) {
    const reason = frontmatterError(a.raw);
    if (reason) out.push({ kind: "agent", scope, name: a.name, path: a.path, reason, workspace });
  }
  const skills = await listSkills(scope, projectCwd).catch(() => []);
  for (const s of skills) {
    const reason = frontmatterError(s.raw);
    if (reason) out.push({ kind: "skill", scope, name: s.name, path: s.path, reason, workspace });
  }
  return out;
}

/** `~/.claude/keybindings.json` problem, or null when it's fine or absent. */
export async function keybindingsProblem(): Promise<ConfigFileProblem | null> {
  try {
    const { path, exists, data } = await readKeybindings();
    if (!exists) return null;
    if (data === null || typeof data !== "object" || Array.isArray(data)) {
      return { kind: "keybindings", scope: "user", name: "keybindings.json", path, reason: "Expected a JSON object" };
    }
    return null;
  } catch (err) {
    const reason = (err instanceof Error ? err.message : String(err)).split("\n")[0].trim() || "Unreadable file";
    return { kind: "keybindings", scope: "user", name: "keybindings.json", path: keybindingsPath(), reason };
  }
}

/**
 * Every problem across the user scope, keybindings.json, and the project
 * scope of each given workspace. Deduped by path — a workspace rooted at
 * `$HOME` has the same `.claude/agents` as the user scope.
 */
export async function listConfigFileProblems(workspaces: ConfigFileWorkspace[]): Promise<ConfigFileProblem[]> {
  const all: ConfigFileProblem[] = [];
  // User-scope dirs ignore the cwd argument.
  all.push(...(await scopeFileProblems("user", "")));
  const kb = await keybindingsProblem();
  if (kb) all.push(kb);
  for (const ws of workspaces) {
    all.push(...(await scopeFileProblems("project", ws.rootPath, { id: ws.id, name: ws.name })));
  }
  const seen = new Set<string>();
  return all.filter((p) => (seen.has(p.path) ? false : (seen.add(p.path), true)));
}

export type ConfigFileCheck = {
  id: string;
  label: string;
  status: "ok" | "warn";
  detail: string;
  link?: { href: string; label: string };
  category: "config-files";
};

function problemLink(p: ConfigFileProblem): { href: string; label: string } {
  if (p.kind === "keybindings") return { href: "/keybindings", label: "Open Keybindings" };
  const page = p.kind === "agent" ? "agents" : "skills";
  const label = p.kind === "agent" ? "Open Agents" : "Open Skills";
  return { href: p.workspace ? `/${p.workspace.id}/${page}` : `/${page}`, label };
}

/**
 * Doctor checks for a problem list: one warn per broken file, plus an ok
 * row for whichever of "Agent and skill files" / "keybindings.json" is clean
 * so the section never looks empty.
 */
export function configFileChecks(problems: ConfigFileProblem[]): ConfigFileCheck[] {
  const checks: ConfigFileCheck[] = problems.map((p) => {
    const where = p.workspace ? p.workspace.name : "user";
    const what = p.kind === "agent" ? "Broken agent" : p.kind === "skill" ? "Broken skill" : "Broken keybindings.json";
    return {
      id: `config-file:${p.kind}:${p.workspace?.id ?? "user"}:${p.name}`,
      label: p.kind === "keybindings" ? what : `${what} — ${p.name} (${where})`,
      status: "warn",
      detail: `${p.path} — ${p.reason}`,
      link: problemLink(p),
      category: "config-files",
    };
  });
  if (!problems.some((p) => p.kind !== "keybindings")) {
    checks.push({
      id: "config-file:agents-skills",
      label: "Agent and skill files",
      status: "ok",
      detail: "No broken agent or skill files found.",
      category: "config-files",
    });
  }
  if (!problems.some((p) => p.kind === "keybindings")) {
    checks.push({
      id: "config-file:keybindings",
      label: "keybindings.json",
      status: "ok",
      detail: "No keybinding errors found.",
      category: "config-files",
    });
  }
  return checks;
}
