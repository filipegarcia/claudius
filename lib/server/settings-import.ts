import { promises as fs } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { randomUUID } from "node:crypto";

import { writeSettings, readSettings, type ClaudeSettings } from "./settings";
import {
  createWorkspace,
  listWorkspaces,
  updateWorkspace,
  writeIcon,
  type Workspace,
} from "./workspaces-store";
import { setSettings as setCustomizeSettings } from "./customize-settings";
import { patchUpdaterSettings } from "./updater/settings";
import { readKeybindings, writeKeybindings } from "./keybindings";
import { assertAbsoluteUserPath, PathInjectionError } from "./safe-path";
import type {
  BundledWorkspace,
  ImportDecision,
  ImportLogEntry,
  ImportPause,
  ImportProgress,
  SettingsBundle,
} from "@/lib/shared/settings-bundle";

/**
 * Stateful, resumable import worker.
 *
 * The import is a four-step pipeline driven by `cursor`:
 *
 *   0. `!systemDone` — merge the four system files (user settings,
 *      customize-settings, updater settings, keybindings) into their
 *      targets, then set `systemDone = true`.
 *   1. `cursor === N` — process workspace `bundle.workspaces[N]`. Detect
 *      hazards (missing rootPath, id collision, path collision); on a hazard
 *      return `{ state: "paused", pause }` and stop. The caller's `resolve()`
 *      records a decision and advances.
 *   2. When `cursor === bundle.workspaces.length` — return `{ state: "done" }`.
 *
 * Session state is persisted to a JSON file under
 * `~/.claude/.claudius/imports/<importId>.json` so a browser refresh or a
 * crash mid-flow doesn't lose decisions. The session file is removed on
 * `done` (best-effort) and on explicit `cancelImport`.
 *
 * Merge strategy v1 is "deep-merge, import wins, arrays unioned". Workspace
 * `meta` is a shallow assign — its arrays (`navOrder`, `claudeMdExcludes`)
 * are atomic user choices, not things to union with whatever the target had.
 */

// ── Session shape ────────────────────────────────────────────────────────

type ImportSession = {
  importId: string;
  createdAt: number;
  bundle: SettingsBundle;
  /** Reserved for a future "replace" mode. v1 is always "merge". */
  mergeStrategy: "merge" | "replace";
  cursor: number;
  systemDone: boolean;
  /** Keyed by `bundle.workspaces[i].meta.id` so re-resolves overwrite cleanly. */
  decisions: Record<string, ImportDecision>;
  log: ImportLogEntry[];
};

// ── Paths ────────────────────────────────────────────────────────────────

function importsDir(): string {
  return join(homedir(), ".claude", ".claudius", "imports");
}

function sessionPath(importId: string): string {
  // `importId` is generated server-side (randomUUID), so we don't need
  // path-traversal guards here — but we still pin to `importsDir/` rather
  // than building an arbitrary string.
  return join(importsDir(), `${importId}.json`);
}

async function readSession(importId: string): Promise<ImportSession | null> {
  try {
    const raw = await fs.readFile(sessionPath(importId), "utf8");
    return JSON.parse(raw) as ImportSession;
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") return null;
    throw err;
  }
}

async function writeSession(session: ImportSession): Promise<void> {
  await fs.mkdir(importsDir(), { recursive: true });
  const file = sessionPath(session.importId);
  const tmp = `${file}.${process.pid}.${Date.now()}.tmp`;
  await fs.writeFile(tmp, JSON.stringify(session, null, 2) + "\n", "utf8");
  await fs.rename(tmp, file);
}

async function deleteSession(importId: string): Promise<void> {
  try {
    await fs.unlink(sessionPath(importId));
  } catch {
    // Already gone — fine.
  }
}

// ── Validation ───────────────────────────────────────────────────────────

/**
 * Cheap structural check on the uploaded bundle. We don't pull in a schema
 * library for this — the format is small and the consequences of a bad
 * bundle are caught downstream when individual writes fail. The check below
 * is the minimum the import loop relies on: a known version and a
 * workspaces array.
 */
export function validateBundle(input: unknown): input is SettingsBundle {
  if (!input || typeof input !== "object") return false;
  const b = input as Partial<SettingsBundle>;
  if (b.version !== 1) return false;
  if (!Array.isArray(b.workspaces)) return false;
  for (const w of b.workspaces) {
    if (!w || typeof w !== "object") return false;
    const meta = (w as BundledWorkspace).meta;
    if (!meta || typeof meta.id !== "string" || typeof meta.rootPath !== "string") {
      return false;
    }
  }
  return true;
}

// ── Deep-merge ───────────────────────────────────────────────────────────

/**
 * Deep-merge `source` into `target` with import-wins semantics:
 *   - plain objects → recursive merge
 *   - arrays → union by `JSON.stringify` identity, target first then new from source
 *   - everything else → source wins
 *
 * The "target first" array order is deliberate: existing entries keep their
 * relative position, new entries from the bundle land at the end. That
 * matches what users expect when re-importing into a populated machine —
 * their local additions don't get reshuffled.
 */
export function mergeDeep<T>(target: T, source: T): T {
  if (Array.isArray(target) && Array.isArray(source)) {
    const seen = new Set<string>();
    const out: unknown[] = [];
    for (const item of target) {
      const k = stableKey(item);
      if (!seen.has(k)) {
        seen.add(k);
        out.push(item);
      }
    }
    for (const item of source) {
      const k = stableKey(item);
      if (!seen.has(k)) {
        seen.add(k);
        out.push(item);
      }
    }
    return out as unknown as T;
  }
  if (isPlainObject(target) && isPlainObject(source)) {
    const out: Record<string, unknown> = { ...target };
    for (const [k, v] of Object.entries(source)) {
      if (k in out) {
        out[k] = mergeDeep(out[k], v);
      } else {
        out[k] = v;
      }
    }
    return out as unknown as T;
  }
  // null/undefined source — fall back to target so the user can't accidentally
  // wipe a key by sending `null` in the bundle. (The bundle is authored by
  // our own exporter; defensive nonetheless.)
  if (source === undefined || source === null) return target;
  return source;
}

function isPlainObject(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

/**
 * Cheap stable serialization for array-dedup. Recurses through plain objects
 * with sorted keys so `{a:1,b:2}` and `{b:2,a:1}` hash to the same string.
 */
function stableKey(v: unknown): string {
  if (Array.isArray(v)) return "[" + v.map(stableKey).join(",") + "]";
  if (isPlainObject(v)) {
    const keys = Object.keys(v).sort();
    return "{" + keys.map((k) => JSON.stringify(k) + ":" + stableKey(v[k])).join(",") + "}";
  }
  return JSON.stringify(v) ?? "null";
}

// ── System merge ─────────────────────────────────────────────────────────

async function mergeSystem(bundle: SettingsBundle): Promise<void> {
  const sys = bundle.system;

  if (sys.userSettings) {
    const current = await readSettings("user", process.cwd());
    const next = mergeDeep<ClaudeSettings>(current, sys.userSettings);
    await writeSettings("user", process.cwd(), next);
  }

  if (sys.customizeSettings) {
    // customize-settings has its own getter that defaults the prompt; passing
    // the import's autoFixPrompt as a patch is enough — `setSettings` deep-clones
    // on top of the current state.
    await setCustomizeSettings({ autoFixPrompt: sys.customizeSettings.autoFixPrompt });
  }

  if (sys.updaterSettings) {
    await patchUpdaterSettings({
      mode: sys.updaterSettings.mode,
      remote: sys.updaterSettings.remote,
      branch: sys.updaterSettings.branch,
      intervalHours: sys.updaterSettings.intervalHours,
    });
  }

  if (sys.keybindings) {
    // Keybindings file may already exist on the target. Treat the file as a
    // bag of top-level keys plus a `bindings` array (the only known shape),
    // and union the array via `mergeDeep`.
    const { data: current } = await readKeybindings();
    const next = mergeDeep(current, sys.keybindings);
    await writeKeybindings(next);
  }
}

// ── Hazard detection + workspace commit ──────────────────────────────────

type Hazard =
  | { kind: "missing_root" }
  | { kind: "not_a_directory"; rootPath: string }
  | { kind: "id_collision"; existing: Workspace }
  | { kind: "path_collision"; existing: Workspace };

async function detectHazard(
  incoming: Workspace,
  resolvedRootPath: string,
  existing: Workspace[],
): Promise<Hazard | null> {
  // Collisions checked first — they're cheap and the heal answer for a
  // missing rootPath might point AT a colliding workspace, which we still
  // want to surface.
  const idHit = existing.find((w) => w.id === incoming.id);
  if (idHit) return { kind: "id_collision", existing: idHit };
  const pathHit = existing.find((w) => w.rootPath === resolvedRootPath);
  if (pathHit) return { kind: "path_collision", existing: pathHit };
  try {
    const stat = await fs.stat(resolvedRootPath);
    if (!stat.isDirectory()) return { kind: "not_a_directory", rootPath: resolvedRootPath };
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") return { kind: "missing_root" };
    throw err;
  }
  return null;
}

/**
 * Create or update the workspace, restore its icon, and write project/local
 * settings into the (now-known-good) rootPath. Caller is responsible for
 * appending the resulting log entry.
 */
async function commitWorkspace(
  ws: BundledWorkspace,
  rootPath: string,
  collision: "create" | "update" | "rename",
  renameTo?: string,
): Promise<ImportLogEntry> {
  const { meta } = ws;
  const name = renameTo ?? meta.name;
  // Strip transient/identity fields from the meta payload before persisting:
  // `id` is set by the store on create, `createdAt`/`updatedAt` are
  // bookkeeping the store manages itself, and we already pass `name`,
  // `rootPath`, `icon`, `defaults` through dedicated args.
  const carryOver: Partial<Workspace> = {
    commitPrefix: meta.commitPrefix,
    kind: meta.kind,
    navOrder: meta.navOrder,
  };

  let id: string;
  let action: ImportLogEntry["action"];
  if (collision === "update") {
    // Overwrite: target the existing id. Update what changed; rootPath gets
    // the healed path; name + defaults + icon come from the bundle.
    const existing = (await listWorkspaces()).find(
      (w) => w.id === meta.id || w.rootPath === rootPath,
    );
    if (!existing) {
      // Race: the row disappeared between hazard detection and commit. Fall
      // through to create-new with the bundle's id-shape semantics.
      const created = await createWorkspace({
        name,
        rootPath,
        icon: meta.icon,
        defaults: meta.defaults,
      });
      id = created.id;
      action = "created";
    } else {
      await updateWorkspace(existing.id, {
        name,
        rootPath,
        icon: meta.icon,
        defaults: meta.defaults,
        ...carryOver,
      });
      id = existing.id;
      action = "updated";
    }
  } else {
    const created = await createWorkspace({
      name,
      rootPath,
      icon: meta.icon,
      defaults: meta.defaults,
    });
    id = created.id;
    action = collision === "rename" ? "renamed" : "created";
    if (Object.values(carryOver).some((v) => v !== undefined)) {
      await updateWorkspace(id, carryOver);
    }
  }

  // Restore icon bytes (if any) under the *new* id. Letter icons need no
  // file — they're regenerated from `meta.icon` on next render when nothing
  // is on disk.
  if (ws.iconBytes) {
    try {
      await writeIcon(id, ws.iconBytes.ext, Buffer.from(ws.iconBytes.base64, "base64"));
    } catch {
      // Icon restoration is best-effort. A failure shouldn't sink the whole
      // workspace — the letter fallback kicks in next render.
    }
  }

  // Now write per-workspace settings INTO the healed rootPath. Empty objects
  // in the bundle were already filtered out by the exporter, but check again
  // defensively so we don't create empty `.claude/settings.json` files.
  if (ws.projectSettings && Object.keys(ws.projectSettings).length > 0) {
    const current = await readSettings("project", rootPath);
    await writeSettings("project", rootPath, mergeDeep(current, ws.projectSettings));
  }
  if (ws.localSettings && Object.keys(ws.localSettings).length > 0) {
    const current = await readSettings("local", rootPath);
    await writeSettings("local", rootPath, mergeDeep(current, ws.localSettings));
  }

  return {
    wsIndex: -1, // filled by the caller — it knows the index
    workspaceId: id,
    action,
    note: rootPath !== meta.rootPath ? `rootPath rewritten to ${rootPath}` : undefined,
  };
}

// ── Public API ───────────────────────────────────────────────────────────

export async function startImport(bundle: SettingsBundle): Promise<ImportProgress> {
  const importId = "imp_" + randomUUID().replace(/-/g, "").slice(0, 16);
  const session: ImportSession = {
    importId,
    createdAt: Date.now(),
    bundle,
    mergeStrategy: "merge",
    cursor: 0,
    systemDone: false,
    decisions: {},
    log: [],
  };
  await writeSession(session);
  return advance(importId);
}

export async function getImportProgress(importId: string): Promise<ImportProgress | null> {
  const session = await readSession(importId);
  if (!session) return null;
  // No reactive work — just summarize. Useful for the UI re-fetching on
  // refresh; the next user action calls `advance` directly.
  if (session.cursor >= session.bundle.workspaces.length && session.systemDone) {
    return {
      state: "done",
      importId,
      processed: session.cursor,
      total: session.bundle.workspaces.length,
      log: session.log,
    };
  }
  // We don't know whether the next step would pause without running the
  // worker. Run it — `advance` is idempotent up to the next hazard.
  //
  // ⚠️ This makes `GET /api/settings/import/:id` side-effecting (it can
  // commit system merges as it walks forward). That's intentional: the
  // route exists to "re-attach" a heal dialog after a refresh, and the
  // intermediate writes are all idempotent (deep-merge of the same data).
  // Don't add an opportunistic prefetch against this endpoint without
  // accounting for the re-apply.
  return advance(importId);
}

export async function cancelImport(importId: string): Promise<void> {
  await deleteSession(importId);
}

export async function resolve(
  importId: string,
  input: { wsIndex: number; decision: ImportDecision },
): Promise<ImportProgress> {
  const session = await readSession(importId);
  if (!session) {
    return {
      state: "error",
      importId,
      error: "import session not found",
      log: [],
    };
  }
  const ws = session.bundle.workspaces[input.wsIndex];
  if (!ws) {
    return {
      state: "error",
      importId,
      error: `invalid wsIndex ${input.wsIndex}`,
      log: session.log,
    };
  }
  // Validate heal/rename payloads up front so a malformed decision doesn't
  // poison the session file.
  if (input.decision.kind === "heal") {
    try {
      assertAbsoluteUserPath(input.decision.newRootPath);
    } catch (err) {
      if (err instanceof PathInjectionError) {
        return { state: "error", importId, error: err.message, log: session.log };
      }
      throw err;
    }
  }
  if (input.decision.kind === "rename" && !input.decision.newName.trim()) {
    return { state: "error", importId, error: "newName required", log: session.log };
  }
  session.decisions[ws.meta.id] = input.decision;
  await writeSession(session);
  return advance(importId);
}

/**
 * Worker loop — processes pending steps until it either pauses on a hazard
 * or runs out of workspaces. Always re-reads the session from disk first so
 * concurrent `resolve` calls don't trample each other.
 */
async function advance(importId: string): Promise<ImportProgress> {
  const session = await readSession(importId);
  if (!session) {
    return { state: "error", importId, error: "import session not found", log: [] };
  }

  try {
    if (!session.systemDone) {
      await mergeSystem(session.bundle);
      session.systemDone = true;
      await writeSession(session);
    }

    while (session.cursor < session.bundle.workspaces.length) {
      const wsIndex = session.cursor;
      const ws = session.bundle.workspaces[wsIndex];
      const decision = session.decisions[ws.meta.id];

      // Apply skip decisions immediately — they bypass hazard detection.
      if (decision?.kind === "skip") {
        session.log.push({
          wsIndex,
          workspaceId: ws.meta.id,
          action: "skipped",
        });
        session.cursor += 1;
        await writeSession(session);
        continue;
      }

      // Resolve the effective rootPath: a `heal` decision overrides the
      // bundle's rootPath. Run through `assertAbsoluteUserPath` to normalize
      // (and barricade the fs.* calls below).
      const requestedRoot =
        decision?.kind === "heal" ? decision.newRootPath : ws.meta.rootPath;
      let rootPath: string;
      try {
        rootPath = assertAbsoluteUserPath(requestedRoot);
      } catch (err) {
        if (err instanceof PathInjectionError) {
          return {
            state: "error",
            importId,
            error: `${err.message} (workspace ${ws.meta.name})`,
            log: session.log,
          };
        }
        throw err;
      }

      const existing = await listWorkspaces();
      const hazard = await detectHazard(ws.meta, rootPath, existing);

      // If the user already answered for this workspace, treat the matching
      // decision as the go-ahead and commit. Otherwise pause.
      if (hazard) {
        if (decision?.kind === "overwrite") {
          // Overwrite both id_collision and path_collision: write through
          // the existing row.
          const entry = await commitWorkspace(ws, rootPath, "update");
          entry.wsIndex = wsIndex;
          session.log.push(entry);
          session.cursor += 1;
          await writeSession(session);
          continue;
        }
        if (decision?.kind === "rename") {
          const entry = await commitWorkspace(ws, rootPath, "rename", decision.newName);
          entry.wsIndex = wsIndex;
          session.log.push(entry);
          session.cursor += 1;
          await writeSession(session);
          continue;
        }
        // No matching decision — pause.
        return {
          state: "paused",
          importId,
          processed: session.cursor,
          total: session.bundle.workspaces.length,
          pause: shapePause(hazard, wsIndex, ws.meta),
          log: session.log,
        };
      }

      // No hazard — create new workspace.
      const entry = await commitWorkspace(ws, rootPath, "create");
      entry.wsIndex = wsIndex;
      if (decision?.kind === "heal") {
        entry.action = "healed";
      }
      session.log.push(entry);
      session.cursor += 1;
      await writeSession(session);
    }

    // All workspaces done.
    const done: ImportProgress = {
      state: "done",
      importId,
      processed: session.cursor,
      total: session.bundle.workspaces.length,
      log: session.log,
    };
    await deleteSession(importId);
    return done;
  } catch (err) {
    return {
      state: "error",
      importId,
      error: err instanceof Error ? err.message : String(err),
      log: session.log,
    };
  }
}

function shapePause(hazard: Hazard, wsIndex: number, workspace: Workspace): ImportPause {
  switch (hazard.kind) {
    case "missing_root":
      return { kind: "missing_root", wsIndex, workspace };
    case "not_a_directory":
      return { kind: "not_a_directory", wsIndex, workspace, rootPath: hazard.rootPath };
    case "id_collision":
      return { kind: "id_collision", wsIndex, incoming: workspace, existing: hazard.existing };
    case "path_collision":
      return { kind: "path_collision", wsIndex, incoming: workspace, existing: hazard.existing };
  }
}

// Re-export so tests can poke the dir without importing node:path themselves.
export { importsDir as importSessionsDir };
