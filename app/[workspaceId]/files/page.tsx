"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import Link from "next/link";
import { usePathname, useRouter, useSearchParams } from "next/navigation";
import {
  ArrowLeft,
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
import { useWorkspaces } from "@/lib/client/useWorkspaces";

type FileContent = {
  relPath: string;
  content: string;
  sizeBytes: number;
  modifiedMs: number;
};

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
  // list of matching files at any depth (server-side `?search=`).
  const [query, setQuery] = useState("");

  const wsId = active?.id ?? null;

  const onPick = useCallback(
    async (e: Entry) => {
      if (!wsId || e.kind !== "file") return;
      setError(null);
      try {
        const res = await fetch(
          `/api/workspaces/${wsId}/files?path=${encodeURIComponent(e.relPath)}`,
        );
        if (!res.ok) {
          const j = (await res.json().catch(() => ({}))) as { error?: string };
          throw new Error(j.error ?? `HTTP ${res.status}`);
        }
        const d = (await res.json()) as FileContent;
        setOpen(d);
        setDraft(d.content);
        setDirty(false);
        // Reflect the open file in the URL so it can be bookmarked / linked to
        // from chat. `replace` (not push) keeps the back button sane — each
        // file pick shouldn't add a history entry. The displayed path stays
        // the plain relPath; only the address bar carries the query.
        router.replace(`${pathname}?path=${encodeURIComponent(d.relPath)}`, { scroll: false });
      } catch (err) {
        setError(err instanceof Error ? err.message : String(err));
      }
    },
    [wsId, router, pathname],
  );

  // Deep-link: open the file named in `?path=` once the workspace is known.
  // One-shot via a ref so the URL updates `onPick` itself triggers (which
  // change `searchParams`) don't re-run this and fight the user's clicks.
  const didDeepLink = useRef(false);
  useEffect(() => {
    if (didDeepLink.current || !wsId) return;
    didDeepLink.current = true;
    const p = searchParams.get("path");
    if (p) {
      // The setState inside onPick is the deep-link data load itself, not an
      // effect chain — it runs once (ref-guarded) on first mount.
      // eslint-disable-next-line react-hooks/set-state-in-effect
      void onPick({ name: p.split("/").pop() ?? p, relPath: p, kind: "file" });
    }
  }, [wsId, searchParams, onPick]);

  async function onSave() {
    if (!wsId || !open) return;
    setBusy("save");
    setError(null);
    try {
      const res = await fetch(
        `/api/workspaces/${wsId}/files?path=${encodeURIComponent(open.relPath)}`,
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
        `/api/workspaces/${wsId}/files?path=${encodeURIComponent(open.relPath)}`,
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
    const next = prompt("New path (relative to workspace root):", open.relPath);
    if (!next || next === open.relPath) return;
    setBusy("rename");
    setError(null);
    try {
      const res = await fetch(
        `/api/workspaces/${wsId}/files?path=${encodeURIComponent(open.relPath)}&newPath=${encodeURIComponent(next)}`,
        { method: "PATCH" },
      );
      if (!res.ok) {
        const j = (await res.json().catch(() => ({}))) as { error?: string };
        throw new Error(j.error ?? `HTTP ${res.status}`);
      }
      setOpen({ ...open, relPath: next });
      router.replace(`${pathname}?path=${encodeURIComponent(next)}`, { scroll: false });
      setRefreshKey((k) => k + 1);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(null);
    }
  }

  async function onCreate(kind: "file" | "dir") {
    if (!wsId) return;
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
        `/api/workspaces/${wsId}/files?path=${encodeURIComponent(next)}&kind=${kind}`,
        { method: "POST" },
      );
      if (!res.ok) {
        const j = (await res.json().catch(() => ({}))) as { error?: string };
        throw new Error(j.error ?? `HTTP ${res.status}`);
      }
      setRefreshKey((k) => k + 1);
      if (kind === "file") {
        // Open the new file in the editor for immediate input.
        await onPick({ name: next.split("/").pop() ?? next, relPath: next, kind: "file" });
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
            ) : (
              <FileTree
                key={`${active.id}:${refreshKey}`}
                workspaceId={active.id}
                onPick={onPick}
                selectedPath={open?.relPath ?? searchParams.get("path")}
                query={query}
              />
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
                <textarea
                  value={draft}
                  onChange={(e) => {
                    setDraft(e.target.value);
                    setDirty(e.target.value !== open.content);
                  }}
                  spellCheck={false}
                  className="flex-1 resize-none bg-[var(--background)] p-4 font-mono text-xs leading-5 focus:outline-none scroll-thin"
                />
              </>
            )}
          </section>
        </div>
      </main>
    </div>
  );
}
