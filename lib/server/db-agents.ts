import type { AgentDefinition } from "@anthropic-ai/claude-agent-sdk";
import { openDb } from "./db";

/**
 * DB-backed programmatic subagents (A-P3.8). Stored per-cwd in `.claudius.db`
 * (table `db_agents`) and fed to the SDK at session start via `Options.agents`
 * — distinct from the file-based `.claude/agents/*.md` agents the SDK loads
 * from disk. Programmatic agents win over same-named file agents.
 *
 * The full AgentDefinition is persisted as JSON; we validate the two required
 * fields (description, prompt) on write and on read-back so a malformed row
 * can never crash session start.
 */

export type DbAgentRow = {
  name: string;
  definition: AgentDefinition;
  updatedAt: number;
};

const NAME_RE = /^[\w.\-]+$/;

/** Throws on an invalid agent name (mirrors the file-agent name rule). */
export function assertValidAgentName(name: unknown): asserts name is string {
  if (typeof name !== "string" || !NAME_RE.test(name)) {
    throw new Error("invalid agent name");
  }
}

/**
 * Coerce arbitrary input into a valid AgentDefinition, or return null if it
 * can't be (missing/empty description or prompt). Pure — no DB access — so it's
 * unit-testable and reused for both the write path (reject bad input) and the
 * read path (skip a corrupt row rather than throw).
 *
 * Only the SDK-recognized fields are carried through; unknown keys are dropped
 * so a stored definition can't smuggle arbitrary data into Options.
 */
export function coerceAgentDefinition(input: unknown): AgentDefinition | null {
  if (!input || typeof input !== "object") return null;
  const o = input as Record<string, unknown>;
  const description = typeof o.description === "string" ? o.description.trim() : "";
  const prompt = typeof o.prompt === "string" ? o.prompt : "";
  if (!description || !prompt.trim()) return null;

  const def: AgentDefinition = { description, prompt };
  if (Array.isArray(o.tools)) def.tools = o.tools.filter((t): t is string => typeof t === "string");
  if (Array.isArray(o.disallowedTools))
    def.disallowedTools = o.disallowedTools.filter((t): t is string => typeof t === "string");
  if (Array.isArray(o.skills)) def.skills = o.skills.filter((s): s is string => typeof s === "string");
  if (typeof o.model === "string") def.model = o.model;
  if (typeof o.initialPrompt === "string") def.initialPrompt = o.initialPrompt;
  if (typeof o.maxTurns === "number") def.maxTurns = o.maxTurns;
  if (typeof o.background === "boolean") def.background = o.background;
  if (o.memory === "user" || o.memory === "project" || o.memory === "local") def.memory = o.memory;
  if (
    o.effort === "low" ||
    o.effort === "medium" ||
    o.effort === "high" ||
    o.effort === "xhigh" ||
    o.effort === "max" ||
    typeof o.effort === "number"
  )
    def.effort = o.effort as AgentDefinition["effort"];
  if (
    o.permissionMode === "default" ||
    o.permissionMode === "acceptEdits" ||
    o.permissionMode === "bypassPermissions" ||
    o.permissionMode === "plan" ||
    o.permissionMode === "dontAsk" ||
    o.permissionMode === "auto"
  )
    def.permissionMode = o.permissionMode;
  return def;
}

export async function listDbAgents(cwd: string): Promise<DbAgentRow[]> {
  const db = await openDb(cwd, "readonly").catch(() => null);
  if (!db) return [];
  let rows: { name: string; definition_json: string; updated_at: number }[];
  try {
    rows = db
      .prepare<[], { name: string; definition_json: string; updated_at: number }>(
        "SELECT name, definition_json, updated_at FROM db_agents ORDER BY name",
      )
      .all();
  } catch {
    // Table absent (migration not yet applied on this DB) — treat as empty.
    return [];
  }
  const out: DbAgentRow[] = [];
  for (const r of rows) {
    let parsed: unknown;
    try {
      parsed = JSON.parse(r.definition_json);
    } catch {
      continue; // skip corrupt JSON rather than crash
    }
    const def = coerceAgentDefinition(parsed);
    if (def) out.push({ name: r.name, definition: def, updatedAt: r.updated_at });
  }
  return out;
}

/**
 * Build the `Options.agents` map for a session from the DB rows. Returns
 * undefined when there are none, so the caller omits the option entirely and
 * the file-based agents path is unaffected.
 */
export async function loadDbAgentsForOptions(
  cwd: string,
): Promise<Record<string, AgentDefinition> | undefined> {
  const rows = await listDbAgents(cwd);
  if (rows.length === 0) return undefined;
  const map: Record<string, AgentDefinition> = {};
  for (const r of rows) map[r.name] = r.definition;
  return map;
}

export async function upsertDbAgent(
  cwd: string,
  name: string,
  definition: unknown,
): Promise<DbAgentRow> {
  assertValidAgentName(name);
  const def = coerceAgentDefinition(definition);
  if (!def) throw new Error("agent definition requires non-empty description and prompt");
  const db = await openDb(cwd);
  const updatedAt = Date.now();
  db.prepare(
    `INSERT INTO db_agents(name, definition_json, updated_at)
     VALUES (?, ?, ?)
     ON CONFLICT(name) DO UPDATE SET
       definition_json = excluded.definition_json,
       updated_at = excluded.updated_at`,
  ).run(name, JSON.stringify(def), updatedAt);
  return { name, definition: def, updatedAt };
}

export async function deleteDbAgent(cwd: string, name: string): Promise<boolean> {
  assertValidAgentName(name);
  const db = await openDb(cwd);
  const info = db.prepare("DELETE FROM db_agents WHERE name = ?").run(name);
  return info.changes > 0;
}
