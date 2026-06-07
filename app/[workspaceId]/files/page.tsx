"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import Link from "next/link";
import { usePathname, useRouter, useSearchParams } from "next/navigation";
import {
  ArrowLeft,
  ChevronDown,
  ChevronRight,
  FilePlus,
  FolderPlus,
  FolderTree as FolderTreeIcon,
  Pencil,
  Save,
  Search,
  Trash2,
  X,
} from "lucide-react";
import { SideNav } from "@/components/nav/SideNav";
import { FileTree, type Entry } from "@/components/files/FileTree";
import { HighlightedEditor } from "@/components/files/HighlightedEditor";
import { useWorkspaces } from "@/lib/client/useWorkspaces";

type FileContent = {
  /** Server-resolved root id (`primary` or `extra:<n>`). */
  root: string;
  relPath: string;
  content: string;
  sizeBytes: number;
  modifiedMs: number;
};

type WorkspaceRoot = {
  id: string;
  absPath: string;
  source: "primary" | "workspace" | "settings";
};

/**
 * Build the `?root=` query suffix. Empty for the primary root so the URL
 * stays clean for the common single-root case (and matches the API's
 * default behaviour when `?root=` is absent).
 */
function rootParam(root: string): string {
  return root === "primary" ? "" : `&root=${encodeURIComponent(root)}`;
}

export default function FilesPage() {
  const { items, activeId } = useWorkspaces();
  const active = items.find((w) => w.id === activeId);
  const router = useRouter();
  const pathname = usePathname();
  const searchParams = useSearchParams();
  const [open, setOpen] = useState<FileContent | null>(null);
  const [draft, setDraft] = useState<string>("");
  const [dirty, setDirty] = useState(false);
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [refreshKey, setRefreshKey] = useState(0);
  // Recursive filename search — when non-empty, FileTree switches to a flat
  // list of matching files at any depth (server-side `?search=`). The same
  // query is fanned out to every root so a hit in an additional dir is
  // findable without first having to expand its group.
  const [query, setQuery] = useState("");
  // Multi-root state: the deduped union of workspace.defaults.additionalDirectories
  // and project-scope `settings.permissions.additionalDirectories` (what `/add-dir`
  // writes), sourced server-side from /api/workspaces/:id/roots so the indices
  // map to the same absolute paths the files API will resolve later. `null`
  // while loading; an empty extras list (just primary) is just the array of one.
  const [roots, setRoots] = useState<WorkspaceRoot[] | null>(null);
  // Which root groups are expanded in the sidebar. Default: primary open,
  // extras collapsed (extras are typically less-used dependency dirs that
  // would otherwise crowd the tree on first paint).
  const [openGroups, setOpenGroups] = useState<Record<string, boolean>>({ primary: true });

  const wsId = active?.id ?? null;

  // Reset the cached roots whenever wsId changes — "store previous props"
  // pattern so the setState happens in render (not inside the fetch effect),
  // satisfying react-hooks/set-state-in-effect. The follow-up fetch then
  // refills the slot for the new workspace.
  const [lastWsId, setLastWsId] = useState<string | null>(wsId);
  if (lastWsId !== wsId) {
    setLastWsId(wsId);
    setRoots(null);
  }

  // Fetch the root list whenever the active workspace changes. Plain effect
  // (no React.cache / SWR) — this is a small response and only fires on
  // workspace switch / mount.
  useEffect(() => {
    if (!wsId) return;
    let cancelled = false;
    fetch(`/api/workspaces/${wsId}/roots`)
      .then((r) => (r.ok ? r.json() : Promise.reject(new Error(`HTTP ${r.status}`))))
      .then((d: { roots?: WorkspaceRoot[] }) => {
        if (!cancelled) setRoots(Array.isArray(d.roots) ? d.roots : []);
      })
      .catch(() => {
        // Soft-fail to a single primary entry from the workspace record so
        // the page still works if /roots flakes — extras just won't show.
        if (!cancelled && active) {
          setRoots([{ id: "primary", absPath: active.rootPath, source: "primary" }]);
        }
      });
    return () => {
      cancelled = true;
    };
  }, [wsId, active, refreshKey]);

  const extraRoots = useMemo(() => (roots ?? []).filter((r) => r.id !== "primary"), [roots]);

  const onPick = useCallback(
    async (e: Entry, rootId: string) => {
      if (!wsId || e.kind !== "file") return;
      setError(null);
      try {
        const res = await fetch(
          `/api/workspaces/${wsId}/files?path=${encodeURIComponent(e.relPath)}${rootParam(rootId)}`,
        );
        if (!res.ok) {
          const j = (await res.json().catch(() => ({}))) as { error?: string };
          throw new Error(j.error ?? `HTTP ${res.status}`);
        }
        // GET responses include the server-resolved rootId so a stale
        // `extra:<n>` selector (root removed since the sidebar last
        // refreshed) won't smuggle the wrong base into our open-file ref.
        const d = (await res.json()) as FileContent & { rootId?: string };
        const ref: FileContent = {
          root: typeof d.rootId === "string" ? d.rootId : rootId,
          relPath: d.relPath,
          content: d.content,
          sizeBytes: d.sizeBytes,
          modifiedMs: d.modifiedMs,
        };
        setOpen(ref);
        setDraft(ref.content);
        setDirty(false);
        // Reflect the open file in the URL so it can be bookmarked / linked to
        // from chat. `replace` (not push) keeps the back button sane — each
        // file pick shouldn't add a history entry. Omit `root` for the primary
        // root so single-root URLs stay clean and backward-compatible with
        // pre-multi-root deep links.
        const rootQ = ref.root === "primary" ? "" : `&root=${encodeURIComponent(ref.root)}`;
        router.replace(`${pathname}?path=${encodeURIComponent(ref.relPath)}${rootQ}`, {
          scroll: false,
        });
      } catch (err) {
        setError(err instanceof Error ? err.message : String(err));
      }
    },
    [wsId, router, pathname],
  );

  // Deep-link: open the file named in `?path=` (and optional `?root=`) once
  // the workspace is known. One-shot via a ref so the URL updates `onPick`
  // itself triggers (which change `searchParams`) don't re-run this and
  // fight the user's clicks.
  const didDeepLink = useRef(false);
  useEffect(() => {
    if (didDeepLink.current || !wsId) return;
    didDeepLink.current = true;
    const p = searchParams.get("path");
    const r = searchParams.get("root") ?? "primary";
    if (p) {
      // The setState inside onPick is the deep-link data load itself, not an
      // effect chain — it runs once (ref-guarded) on first mount.
      // eslint-disable-next-line react-hooks/set-state-in-effect
      void onPick({ name: p.split("/").pop() ?? p, relPath: p, kind: "file" }, r);
      // Auto-expand the group the deep-linked file lives in so it's visible
      // in the sidebar without an extra click.
      if (r !== "primary") {
        setOpenGroups((g) => ({ ...g, [r]: true }));
      }
    }
  }, [wsId, searchParams, onPick]);

  async function onSave() {
    if (!wsId || !open) return;
    setBusy("save");
    setError(null);
    try {
      const res = await fetch(
        `/api/workspaces/${wsId}/files?path=${encodeURIComponent(open.relPath)}${rootParam(open.root)}`,
        { method: "PUT", body: draft },
      );
      if (!res.ok) {
        const j = (await res.json().catch(() => ({}))) as { error?: string };
        throw new Error(j.error ?? `HTTP ${res.status}`);
      }
      setDirty(false);
      setRefreshKey((k) => k + 1);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(null);
    }
  }

  async function onDelete() {
    if (!wsId || !open) return;
    if (!confirm(`Delete ${open.relPath}? This cannot be undone.`)) return;
    setBusy("delete");
    setError(null);
    try {
      const res = await fetch(
        `/api/workspaces/${wsId}/files?path=${encodeURIComponent(open.relPath)}${rootParam(open.root)}`,
        { method: "DELETE" },
      );
      if (!res.ok) {
        const j = (await res.json().catch(() => ({}))) as { error?: string };
        throw new Error(j.error ?? `HTTP ${res.status}`);
      }
      setOpen(null);
      setDraft("");
      setDirty(false);
      setRefreshKey((k) => k + 1);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(null);
    }
  }

  async function onRename() {
    if (!wsId || !open) return;
    // Rename is scoped to the file's own root — moving between roots would
    // need copy+delete (the server enforces a single-root rename too).
    const next = prompt("New path (relative to its root):", open.relPath);
    if (!next || next === open.relPath) return;
    setBusy("rename");
    setError(null);
    try {
      const res = await fetch(
        `/api/workspaces/${wsId}/files?path=${encodeURIComponent(open.relPath)}&newPath=${encodeURIComponent(next)}${rootParam(open.root)}`,
        { method: "PATCH" },
      );
      if (!res.ok) {
        const j = (await res.json().catch(() => ({}))) as { error?: string };
        throw new Error(j.error ?? `HTTP ${res.status}`);
      }
      setOpen({ ...open, relPath: next });
      const rootQ = open.root === "primary" ? "" : `&root=${encodeURIComponent(open.root)}`;
      router.replace(`${pathname}?path=${encodeURIComponent(next)}${rootQ}`, { scroll: false });
      setRefreshKey((k) => k + 1);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(null);
    }
  }

  async function onCreate(kind: "file" | "dir") {
    if (!wsId) return;
    // Create lands in the currently-open file's root when there is one, else
    // in the primary root. That's the surface a user usually expects: "new
    // file next to the one I'm looking at" without an extra picker. To create
    // in a specific empty extra root, open any file inside it first (or use
    // the agent — same code path).
    const targetRoot = open?.root ?? "primary";
    const baseHint = open?.relPath.replace(/[^/]*$/, "") ?? "";
    const next = prompt(
      kind === "dir" ? "New folder path:" : "New file path:",
      baseHint + (kind === "dir" ? "newdir" : "untitled.md"),
    );
    if (!next) return;
    setBusy("create");
    setError(null);
    try {
      const res = await fetch(
        `/api/workspaces/${wsId}/files?path=${encodeURIComponent(next)}&kind=${kind}${rootParam(targetRoot)}`,
        { method: "POST" },
      );
      if (!res.ok) {
        const j = (await res.json().catch(() => ({}))) as { error?: string };
        throw new Error(j.error ?? `HTTP ${res.status}`);
      }
      setRefreshKey((k) => k + 1);
      if (kind === "file") {
        // Open the new file in the editor for immediate input.
        await onPick(
          { name: next.split("/").pop() ?? next, relPath: next, kind: "file" },
          targetRoot,
        );
      }
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(null);
    }
  }

  return (
    <div className="flex h-full">
      <SideNav running={false} />
      <main data-pane-name="files-main" className="flex h-full flex-1 flex-col overflow-hidden">
        <header className="flex h-9 shrink-0 items-center gap-3 border-b border-[var(--border)] bg-[var(--panel)] px-4 text-xs">
          <Link href="/" className="flex items-center gap-1 text-[var(--muted)] hover:text-[var(--foreground)]">
            <ArrowLeft className="h-3.5 w-3.5" /> Chat
          </Link>
          <span className="opacity-50">·</span>
          <FolderTreeIcon className="h-3.5 w-3.5 text-[var(--muted)]" />
          <span className="font-medium">Files</span>
          {active && (
            <span className="max-w-[240px] truncate font-mono text-[var(--muted)]">{active.rootPath}</span>
          )}
          {extraRoots.length > 0 && (
            <span
              title={extraRoots.map((r) => r.absPath).join("\n")}
              className="rounded-md border border-[var(--border)] bg-[var(--panel-2)] px-1.5 py-px text-[10px] tabular-nums text-[var(--muted)]"
            >
              +{extraRoots.length} root{extraRoots.length === 1 ? "" : "s"}
            </span>
          )}
          <div className="flex-1 px-3">
            <div className="relative mx-auto max-w-md">
              <Search className="pointer-events-none absolute left-2.5 top-1/2 h-3.5 w-3.5 -translate-y-1/2 text-[var(--muted)]" />
              <input
                value={query}
                onChange={(e) => setQuery(e.target.value)}
                disabled={!wsId}
                placeholder="Search files (incl. nested folders)"
                aria-label="Search files"
                className="w-full rounded-md border border-[var(--border)] bg-[var(--panel-2)] py-1 pl-8 pr-7 text-xs focus:outline-none disabled:opacity-40"
              />
              {query && (
                <button
                  onClick={() => setQuery("")}
                  title="Clear search"
                  aria-label="Clear search"
                  className="absolute right-1.5 top-1/2 flex h-5 w-5 -translate-y-1/2 items-center justify-center rounded text-[var(--muted)] hover:text-[var(--foreground)]"
                >
                  <X className="h-3 w-3" />
                </button>
              )}
            </div>
          </div>
          <div className="flex items-center gap-1">
            <button
              type="button"
              onClick={() => onCreate("file")}
              disabled={!wsId || busy === "create"}
              title="New file"
              className="flex h-6 w-6 items-center justify-center rounded text-[var(--muted)] hover:bg-[var(--panel-2)] hover:text-[var(--foreground)] disabled:opacity-40"
            >
              <FilePlus className="h-3.5 w-3.5" />
            </button>
            <button
              type="button"
              onClick={() => onCreate("dir")}
              disabled={!wsId || busy === "create"}
              title="New folder"
              className="flex h-6 w-6 items-center justify-center rounded text-[var(--muted)] hover:bg-[var(--panel-2)] hover:text-[var(--foreground)] disabled:opacity-40"
            >
              <FolderPlus className="h-3.5 w-3.5" />
            </button>
          </div>
        </header>
        {error && (
          <div className="border-b border-red-500/30 bg-red-500/10 px-3 py-1 text-[11px] text-red-300">
            {error}
          </div>
        )}
        <div className="flex flex-1 overflow-hidden">
          <aside className="w-80 shrink-0 overflow-y-auto border-r border-[var(--border)] scroll-thin">
            {!active ? (
              <div className="px-4 py-12 text-center text-sm text-[var(--muted)]">
                No active workspace.
              </div>
            ) : extraRoots.length === 0 ? (
              // Single-root fallback: render the primary FileTree without
              // group chrome. Preserves the pre-multi-root shape for the
              // common case (no `additionalDirectories` defined).
              <FileTree
                key={`${active.id}:primary:${refreshKey}`}
                workspaceId={active.id}
                onPick={(e) => onPick(e, "primary")}
                selectedPath={
                  open?.root === "primary"
                    ? open.relPath
                    : !open && (searchParams.get("root") ?? "primary") === "primary"
                      ? searchParams.get("path")
                      : null
                }
                query={query}
              />
            ) : (
              <ul className="py-1">
                {(roots ?? []).map((r) => {
                  // Force every group open while searching so a match in an
                  // additional dir doesn't hide behind a collapsed chevron.
                  // (When the query clears, we fall back to the user's
                  // toggled state so their explicit collapses persist.)
                  const isOpen = query.trim() ? true : openGroups[r.id] ?? false;
                  const label =
                    r.source === "primary"
                      ? "Workspace root"
                      : r.absPath.split("/").filter(Boolean).pop() ?? r.absPath;
                  const sourceBadge =
                    r.source === "settings" ? "settings.json" : r.source === "workspace" ? "defaults" : null;
                  // Mirror which root the open file lives in so the FileTree
                  // for *that* group highlights it; the others get `null`
                  // (no selection bleed across roots).
                  const selected =
                    open?.root === r.id
                      ? open.relPath
                      : !open && (searchParams.get("root") ?? "primary") === r.id
                        ? searchParams.get("path")
                        : null;
                  return (
                    <li key={r.id} className="border-b border-[var(--border)] last:border-b-0">
                      <button
                        type="button"
                        onClick={() => setOpenGroups((g) => ({ ...g, [r.id]: !isOpen }))}
                        title={r.absPath}
                        className="flex w-full items-center gap-1 px-2 py-1 text-left text-[11px] hover:bg-[var(--panel-2)]"
                      >
                        {isOpen ? (
                          <ChevronDown className="h-3 w-3 shrink-0 text-[var(--muted)]" />
                        ) : (
                          <ChevronRight className="h-3 w-3 shrink-0 text-[var(--muted)]" />
                        )}
                        <span className="min-w-0 flex-1 truncate font-medium">{label}</span>
                        {sourceBadge && (
                          <span className="shrink-0 rounded bg-[var(--panel-2)] px-1 py-px text-[9px] uppercase tracking-wide text-[var(--muted)]">
                            {sourceBadge}
                          </span>
                        )}
                      </button>
                      {isOpen && (
                        <div className="pb-1">
                          <FileTree
                            key={`${active.id}:${r.id}:${refreshKey}`}
                            workspaceId={active.id}
                            root={r.id}
                            onPick={(e) => onPick(e, r.id)}
                            selectedPath={selected}
                            query={query}
                          />
                        </div>
                      )}
                    </li>
                  );
                })}
              </ul>
            )}
          </aside>
          <section className="flex flex-1 flex-col overflow-hidden">
            {!open ? (
              <div className="flex flex-1 items-center justify-center text-sm text-[var(--muted)]">
                Pick a file to view or edit.
              </div>
            ) : (
              <>
                <div className="flex h-9 shrink-0 items-center gap-2 border-b border-[var(--border)] bg-[var(--panel-2)]/40 px-3 text-xs">
                  {open.root !== "primary" && (
                    <span
                      title={
                        roots?.find((r) => r.id === open.root)?.absPath ?? "additional directory"
                      }
                      className="shrink-0 rounded bg-[var(--panel-2)] px-1 py-px text-[9px] uppercase tracking-wide text-[var(--muted)]"
                    >
                      extra
                    </span>
                  )}
                  <span className="truncate font-mono">{open.relPath}</span>
                  {dirty && <span className="text-amber-400">●</span>}
                  <button
                    type="button"
                    onClick={onRename}
                    disabled={busy != null}
                    title="Rename / move"
                    className="ml-auto flex h-6 w-6 items-center justify-center rounded text-[var(--muted)] hover:bg-[var(--panel-2)] hover:text-[var(--foreground)] disabled:opacity-40"
                  >
                    <Pencil className="h-3.5 w-3.5" />
                  </button>
                  <button
                    type="button"
                    onClick={onDelete}
                    disabled={busy != null}
                    title="Delete"
                    className="flex h-6 w-6 items-center justify-center rounded text-red-300 hover:bg-red-500/20 disabled:opacity-40"
                  >
                    <Trash2 className="h-3.5 w-3.5" />
                  </button>
                  <button
                    type="button"
                    onClick={onSave}
                    disabled={!dirty || busy != null}
                    className="flex items-center gap-1 rounded-md bg-[var(--accent)] px-2 py-0.5 text-[11px] text-white hover:opacity-90 disabled:opacity-40"
                  >
                    <Save className="h-3 w-3" /> {busy === "save" ? "Saving…" : "Save"}
                  </button>
                </div>
                <div className="flex-1 overflow-hidden">
                  <HighlightedEditor
                    path={open.relPath}
                    value={draft}
                    onChange={(next) => {
                      setDraft(next);
                      setDirty(next !== open.content);
                    }}
                    onKeyDown={(e) => {
                      // ⌘S / Ctrl+S to save — matches the FileEditor on /git
                      // so the muscle memory carries over between the two views.
                      if (
                        (e.metaKey || e.ctrlKey) &&
                        !e.shiftKey &&
                        !e.altKey &&
                        e.key.toLowerCase() === "s"
                      ) {
                        e.preventDefault();
                        void onSave();
                      }
                    }}
                  />
                </div>
              </>
            )}
          </section>
        </div>
      </main>
    </div>
  );
}
