import { promises as fs } from "node:fs";
import { homedir } from "node:os";
import { basename, dirname, join } from "node:path";
import { randomUUID } from "node:crypto";

import type { CommitPrefixConfig } from "@/lib/shared/commit-prefix";
import type { WorkspaceNotificationPrefs } from "@/lib/shared/notifications";
import type { VerboseLevel } from "@/lib/shared/verbose";

export type IconLetter = { kind: "letter"; letter: string; color: string };
export type IconImage = { kind: "image"; ext: string };
export type Icon = IconLetter | IconImage;

/**
 * Per-workspace defaults that flow into new sessions started in this workspace.
 * Each field is optional; when absent the machine-level setting is used.
 * Wired through `/api/sessions` (POST) — see the merge that happens there.
 */
export type WorkspaceDefaults = {
  /** Default Claude model id, e.g. "claude-opus-4-7". */
  model?: string;
  /**
   * Fallback model id — SDK `Options.fallbackModel`. The SDK switches to this
   * when the primary model is unavailable or errors (e.g. overload,
   * model_not_found). Absent ⇒ no fallback. Per-session requests can override.
   */
  fallbackModel?: string;
  /**
   * Run shell commands in a sandbox (SDK `Options.sandbox`). When true, the
   * Session passes `{ enabled: true, autoAllowBashIfSandboxed: true,
   * failIfUnavailable: false }` — the last flag lets it degrade gracefully on
   * platforms without bubblewrap (macOS) instead of failing the query.
   * Absent/false ⇒ no sandbox.
   */
  sandboxEnabled?: boolean;
  /**
   * Enable the 1M-token context window beta (SDK `Options.betas` →
   * `context-1m-2025-08-07`). Sonnet 4/4.5 only; dramatically raises cost, so
   * it's off by default and gated behind an explicit opt-in. Absent/false ⇒
   * standard context window.
   */
  enable1mContext?: boolean;
  /**
   * Persist sessions to disk (SDK `Options.persistSession`). Defaults to true
   * (sessions saved under ~/.claude/projects and resumable). Set to `false` to
   * make every session in this workspace ephemeral — not written to disk and
   * not resumable. Absent/true ⇒ persisted (the SDK default).
   */
  persistSession?: boolean;
  /**
   * Extra instructions appended to Claude Code's default system prompt (SDK
   * `Options.systemPrompt` preset + `append`). Distinct from CLAUDE.md (which
   * is project content): this is steering ("always use TypeScript", house
   * style, etc.) applied to every session in the workspace. Absent/empty ⇒
   * the unmodified preset.
   */
  systemPromptAppend?: string;
  /**
   * Custom plan-mode workflow instructions (SDK `Options.planModeInstructions`).
   * When set and a session is in `plan` permission mode, this replaces the
   * default code-implementation workflow body in the plan-mode system reminder
   * (the CLI still wraps it with the read-only preamble + ExitPlanMode footer).
   * Absent/empty ⇒ the default plan workflow.
   */
  planModeInstructions?: string;
  /**
   * Default main-thread agent for new sessions — the SDK `--agent` flag
   * equivalent (Options.agent). Applies the named agent's system prompt, tool
   * restrictions, AND model to the main conversation, so when set it overrides
   * the `model` default above. Must name an agent that exists (a file under
   * .claude/agents or ~/.claude/agents). Empty/absent ⇒ the default agent.
   */
  agent?: string;
  /**
   * Default permission mode for new sessions. Mirrors the SDK's full
   * PermissionMode enum so any value the dropdown surfaces can be persisted.
   */
  permissionMode?:
    | "default"
    | "acceptEdits"
    | "auto"
    | "plan"
    | "dontAsk"
    | "bypassPermissions";
  /**
   * Hard spend cap (USD) for new sessions — the SDK `Options.maxBudgetUsd`.
   * When a session's cumulative cost exceeds this, the SDK stops the turn and
   * returns an `error_max_budget_usd` result. Absent ⇒ no cap. Per-session
   * requests can override.
   */
  maxBudgetUsd?: number;
  /** MCP server ids to autoload when sessions in this workspace start. */
  mcpServerIds?: string[];
  /** Auto-memory toggle override. */
  autoMemoryEnabled?: boolean;
  /** Globs excluded from CLAUDE.md resolution. */
  claudeMdExcludes?: string[];
  /** Extra directories to expose to the agent. */
  additionalDirectories?: string[];
  /**
   * Per-workspace browser-notification preferences. Drives the
   * NotificationBus's `enabledKinds` filter and the client's OS-notification
   * click behaviour. Absent ⇒ defaults defined in `lib/shared/notifications.ts`.
   */
  notifications?: WorkspaceNotificationPrefs;
  /**
   * Default chat verbosity for sessions opened in this workspace. Controls
   * how much of an assistant turn (tool calls, thinking, subagent blocks)
   * shows up in the middle chat pane — the right-side activity rail is
   * unaffected (it reads `toolHistory` directly). Absent ⇒ `"normal"`
   * (see `DEFAULT_VERBOSE` in `lib/shared/verbose.ts`). Users can override
   * per-session from the chat header; writing back updates this field so
   * the next session in the workspace inherits the new default.
   */
  verbose?: VerboseLevel;
};

/**
 * Defaults stamped onto every workspace at creation time (both the first-run
 * bootstrap workspace and ones created through the New-workspace form / API).
 *
 * Why a data-layer default rather than a resolution-time fallback: "by default
 * all workspaces" means a property carried by the workspace record, not a
 * forced runtime override. Merging it *under* any caller-supplied defaults
 * keeps an explicit choice winning, and — crucially — leaves existing
 * workspaces untouched (changing the merge fallback in `mergeSessionDefaults`
 * would silently flip every previously-created workspace to bypass, a
 * security-relevant surprise we don't want).
 *
 * Only `permissionMode` is pinned here: notifications already default to
 * "enabled, errors muted" via the `DEFAULT_ENABLED_KINDS` fallback in
 * `lib/shared/notifications.ts` (and `isKindEnabled` in `notification-bus.ts`),
 * so there's nothing to pin for them — writing an explicit `enabledKinds` would
 * only freeze new workspaces to today's set if that list ever changes.
 */
export const DEFAULT_WORKSPACE_DEFAULTS: WorkspaceDefaults = {
  permissionMode: "bypassPermissions",
};

/**
 * Distinguishes regular project workspaces from "customization" workspaces —
 * the latter point at a customization-mirror dir under
 * `~/.claude/.claudius/customizations/<id>/src/`. The UI shows a wand badge
 * and a banner when a customization workspace is active.
 *
 * Older `workspaces.json` files lack this key — treat absent as `"project"`.
 */
export type WorkspaceKind = "project" | "customization";

export type Workspace = {
  id: string;
  name: string;
  rootPath: string;
  icon: Icon;
  createdAt: number;
  updatedAt: number;
  lastOpenedAt?: number;
  /** Per-workspace defaults for new sessions. Older files lack this key. */
  defaults?: WorkspaceDefaults;
  /**
   * Branch-derived commit-message prefix. When set and matched, the git
   * page pre-fills the empty commit textarea with the rendered prefix.
   */
  commitPrefix?: CommitPrefixConfig;
  /** Workspace kind. Absent on older files = "project". */
  kind?: WorkspaceKind;
  /**
   * User-customized order of the SideNav rail tiles, keyed by `actionId`
   * (e.g. "nav.chat", "nav.git"). At render time the merge rule is:
   *
   *   1. Any item whose actionId appears in this array renders in the
   *      array's order at the top of the rail.
   *   2. Remaining items (new built-ins added in a later release, or
   *      tiles the user never reordered) follow in their default order.
   *   3. Stale ids — e.g. a customization-gated tile whose customization
   *      has since been reverted — are kept in this array but skipped at
   *      render. They reappear in the saved slot when the customization
   *      is re-published.
   *
   * Absent on older files = "no custom order, use the defaults."
   */
  navOrder?: string[];
};

type StoreShape = {
  version: 1;
  activeId?: string;
  workspaces: Workspace[];
};

// Resolved lazily so a test that sets `process.env.HOME` before exercising
// the store sees its tmpdir reflected in every path. Top-level `const`s
// would bake the real `homedir()` at module-load time, which fires before
// any test fixture has a chance to run.
function rootDir(): string {
  return join(homedir(), ".claude", ".claudius");
}
function workspacesPath(): string {
  return join(rootDir(), "workspaces.json");
}
/** Workspace-icon dir under the (lazily-resolved) claudius root. */
export function iconsDir(): string {
  return join(rootDir(), "workspace-icons");
}

const PALETTE = ["#d97757", "#5588dd", "#9d6cdd", "#2e9d8f", "#dd8e44", "#cc5577", "#33aabb", "#7d8a4c"];

function colorFor(id: string): string {
  let h = 0;
  for (let i = 0; i < id.length; i++) h = (h * 31 + id.charCodeAt(i)) >>> 0;
  return PALETTE[h % PALETTE.length];
}

export function defaultLetterIcon(name: string, id: string): IconLetter {
  const letter = (name.match(/\S/)?.[0] ?? "C").toUpperCase();
  return { kind: "letter", letter, color: colorFor(id) };
}

async function readShape(): Promise<StoreShape | null> {
  try {
    const buf = await fs.readFile(workspacesPath(), "utf8");
    const parsed = JSON.parse(buf) as StoreShape;
    if (parsed.version === 1 && Array.isArray(parsed.workspaces)) return parsed;
    return null;
  } catch (err) {
    const e = err as NodeJS.ErrnoException;
    if (e.code === "ENOENT") return null;
    throw err;
  }
}

async function writeShape(shape: StoreShape): Promise<void> {
  const file = workspacesPath();
  await fs.mkdir(rootDir(), { recursive: true });
  // Atomic write: temp file + rename, sidesteps partial-write corruption when
  // two processes race.
  const tmp = `${file}.${process.pid}.${Date.now()}.tmp`;
  await fs.writeFile(tmp, JSON.stringify(shape, null, 2) + "\n", "utf8");
  await fs.rename(tmp, file);
}

export async function ensureBootstrap(): Promise<StoreShape> {
  const existing = await readShape();
  if (existing && existing.workspaces.length > 0) return existing;
  // First-run: auto-create from process.cwd() basename.
  const cwd = process.cwd();
  const id = "wks_" + randomUUID().replace(/-/g, "").slice(0, 12);
  const name = basename(cwd) || "Workspace";
  const ws: Workspace = {
    id,
    name,
    rootPath: cwd,
    icon: defaultLetterIcon(name, id),
    createdAt: Date.now(),
    updatedAt: Date.now(),
    lastOpenedAt: Date.now(),
    defaults: { ...DEFAULT_WORKSPACE_DEFAULTS },
  };
  const shape: StoreShape = { version: 1, activeId: id, workspaces: [ws] };
  await writeShape(shape);
  return shape;
}

export async function listWorkspaces(): Promise<Workspace[]> {
  const shape = await ensureBootstrap();
  return shape.workspaces;
}

export async function getWorkspace(id: string): Promise<Workspace | null> {
  const shape = await ensureBootstrap();
  return shape.workspaces.find((w) => w.id === id) ?? null;
}

export async function createWorkspace(input: {
  name: string;
  rootPath: string;
  icon?: Icon;
  defaults?: WorkspaceDefaults;
}): Promise<Workspace> {
  const shape = await ensureBootstrap();
  const id = "wks_" + randomUUID().replace(/-/g, "").slice(0, 12);
  const icon = input.icon ?? defaultLetterIcon(input.name, id);
  // Stamp the workspace-level defaults *under* any caller-supplied ones so an
  // explicit choice (including the form's "(inherit)" → field omitted) still
  // wins per-field, while gaps fall back to DEFAULT_WORKSPACE_DEFAULTS. The
  // resulting object always has at least `permissionMode`, so — unlike before
  // — `defaults` is always present on new workspaces.
  const defaults: WorkspaceDefaults = { ...DEFAULT_WORKSPACE_DEFAULTS, ...(input.defaults ?? {}) };
  const ws: Workspace = {
    id,
    name: input.name,
    rootPath: input.rootPath,
    icon,
    createdAt: Date.now(),
    updatedAt: Date.now(),
    lastOpenedAt: Date.now(),
    defaults,
  };
  shape.workspaces.push(ws);
  await writeShape(shape);
  return ws;
}

export async function updateWorkspace(id: string, patch: Partial<Workspace>): Promise<Workspace | null> {
  const shape = await ensureBootstrap();
  const idx = shape.workspaces.findIndex((w) => w.id === id);
  if (idx === -1) return null;
  const next = { ...shape.workspaces[idx], ...patch, id, updatedAt: Date.now() };
  shape.workspaces[idx] = next;
  await writeShape(shape);
  return next;
}

export async function deleteWorkspace(id: string): Promise<boolean> {
  const shape = await ensureBootstrap();
  const next = shape.workspaces.filter((w) => w.id !== id);
  if (next.length === shape.workspaces.length) return false;
  shape.workspaces = next;
  if (shape.activeId === id) shape.activeId = next[0]?.id;
  await writeShape(shape);
  // Best-effort: remove icon if any.
  try {
    const icons = await fs.readdir(iconsDir());
    for (const f of icons) {
      if (f.startsWith(id + ".")) await fs.unlink(join(iconsDir(), f)).catch(() => {});
    }
  } catch {
    // ignore
  }
  return true;
}

/**
 * Reorders the workspaces list to match `ids`. Rejects if `ids` is not a
 * permutation of the existing set (every existing id present, no extras).
 */
export async function reorderWorkspaces(ids: string[]): Promise<{ ok: true } | { ok: false; error: string }> {
  const shape = await ensureBootstrap();
  if (ids.length !== shape.workspaces.length) {
    return { ok: false, error: "ids length does not match" };
  }
  const have = new Set(shape.workspaces.map((w) => w.id));
  for (const id of ids) {
    if (!have.has(id)) return { ok: false, error: `unknown id ${id}` };
    have.delete(id);
  }
  if (have.size > 0) return { ok: false, error: "missing ids" };
  const byId = new Map(shape.workspaces.map((w) => [w.id, w]));
  shape.workspaces = ids.map((id) => byId.get(id) as Workspace);
  await writeShape(shape);
  return { ok: true };
}

export async function setActiveId(id: string | null): Promise<void> {
  const shape = await ensureBootstrap();
  if (id == null) {
    delete shape.activeId;
  } else {
    if (!shape.workspaces.some((w) => w.id === id)) return;
    shape.activeId = id;
    const idx = shape.workspaces.findIndex((w) => w.id === id);
    shape.workspaces[idx] = { ...shape.workspaces[idx], lastOpenedAt: Date.now() };
  }
  await writeShape(shape);
}

export async function getActiveIdHint(): Promise<string | null> {
  const shape = await ensureBootstrap();
  return shape.activeId ?? shape.workspaces[0]?.id ?? null;
}

export async function iconExt(id: string): Promise<string | null> {
  try {
    const entries = await fs.readdir(iconsDir());
    for (const f of entries) {
      if (f.startsWith(id + ".")) return f.slice(id.length + 1);
    }
  } catch {
    // ignore
  }
  return null;
}

export async function writeIcon(id: string, ext: string, bytes: Buffer): Promise<void> {
  await fs.mkdir(iconsDir(), { recursive: true });
  // Remove any prior icon for this id (different extension).
  try {
    const entries = await fs.readdir(iconsDir());
    for (const f of entries) {
      if (f.startsWith(id + ".")) await fs.unlink(join(iconsDir(), f)).catch(() => {});
    }
  } catch {
    // ignore
  }
  await fs.writeFile(join(iconsDir(), `${id}.${ext}`), bytes);
}

export async function readIcon(id: string): Promise<{ buf: Buffer; ext: string } | null> {
  const ext = await iconExt(id);
  if (!ext) return null;
  try {
    const buf = await fs.readFile(join(iconsDir(), `${id}.${ext}`));
    return { buf, ext };
  } catch {
    return null;
  }
}

export function workspacesFile(): string {
  return workspacesPath();
}

export function workspacesRoot(): string {
  return rootDir();
}

void dirname;
