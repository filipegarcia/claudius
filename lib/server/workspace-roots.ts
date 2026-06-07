import { resolve } from "node:path";
import { getWorkspace, type Workspace } from "./workspaces-store";
import { readSettings } from "./settings";

/**
 * The set of root directories the Files browser surfaces for a workspace.
 *
 * Multi-root is the union of two stores that today flow into the agent
 * separately and never see each other:
 *
 *  1. `workspace.defaults.additionalDirectories` — set via the New-workspace
 *     form; passed to the SDK as `Options.additionalDirectories` at session
 *     create (see `lib/shared/session-defaults.ts`).
 *  2. `permissions.additionalDirectories` in **project-scope** `settings.json`
 *     — what `/add-dir` writes (see `app/[workspaceId]/page.tsx` and
 *     `app/api/settings/additional-dirs/route.ts`). The SDK reads these
 *     directly from settings.json.
 *
 * If the page read only (1), `/add-dir` would silently fail to add the
 * directory to the browser. Reading both — and de-duping in a deterministic
 * order so the `extra:<n>` id stays stable across calls — is the truthful
 * "what can the agent read" set.
 *
 * `extra:<n>` is opaque to the client: the index is allocated server-side
 * against this list and re-resolved on every request, so a removed dir
 * 404s rather than smuggling a forged base path through the route.
 */

export type WorkspaceRoot = {
  /** Stable selector. `primary` is the workspace cwd; others are `extra:<n>`. */
  id: string;
  /** Absolute, normalized path. */
  absPath: string;
  /**
   * Where this root came from. `primary` is `ws.rootPath`; `workspace` is the
   * workspace defaults list; `settings` is project-scope `settings.json`.
   * Surfaced to the client for tooltip / badge labels only — never used to
   * resolve a path.
   */
  source: "primary" | "workspace" | "settings";
};

/**
 * Build the full root list for `ws`. Order is stable:
 *
 *   primary → workspace defaults (in their declared order)
 *           → project-settings entries that aren't already covered.
 *
 * Dedup is by resolved absolute path so the same dir written to both stores
 * folds into one entry (the earlier `source` wins). Index is the position in
 * the returned array (so `extra:0` is the first extra, etc.).
 */
export async function listWorkspaceRoots(ws: Workspace): Promise<WorkspaceRoot[]> {
  const out: WorkspaceRoot[] = [];
  const seen = new Set<string>();
  const primary = resolve(ws.rootPath);
  out.push({ id: "primary", absPath: primary, source: "primary" });
  seen.add(primary);

  const fromWorkspace = ws.defaults?.additionalDirectories ?? [];
  for (const raw of fromWorkspace) {
    if (typeof raw !== "string" || !raw.trim()) continue;
    const abs = resolve(raw);
    if (seen.has(abs)) continue;
    seen.add(abs);
    out.push({ id: `extra:${out.length - 1}`, absPath: abs, source: "workspace" });
  }

  // Project-scope settings.json — what `/add-dir` writes. We swallow any read
  // error (missing dir, malformed file) and just return what we have so far;
  // the browser still works against the workspace-defined roots.
  try {
    const settings = await readSettings("project", primary);
    const fromSettings = Array.isArray(settings.permissions?.additionalDirectories)
      ? (settings.permissions?.additionalDirectories as string[])
      : [];
    for (const raw of fromSettings) {
      if (typeof raw !== "string" || !raw.trim()) continue;
      const abs = resolve(raw);
      if (seen.has(abs)) continue;
      seen.add(abs);
      out.push({ id: `extra:${out.length - 1}`, absPath: abs, source: "settings" });
    }
  } catch {
    // ignore; primary + workspace defaults still serve the page.
  }

  return out;
}

/**
 * Resolve a `?root=` selector to its trusted base path. Returns null when
 * `selector` is unknown — the route handler maps that to a 404.
 *
 * Default (undefined / empty) is `primary`, matching the pre-multi-root
 * behaviour so callers that don't pass a root keep working.
 */
export async function resolveWorkspaceRoot(
  workspaceId: string,
  selector: string | null | undefined,
): Promise<{ ws: Workspace; root: WorkspaceRoot } | null> {
  const ws = await getWorkspace(workspaceId);
  if (!ws) return null;
  const id = selector && selector.length > 0 ? selector : "primary";
  const roots = await listWorkspaceRoots(ws);
  const root = roots.find((r) => r.id === id);
  if (!root) return null;
  return { ws, root };
}
