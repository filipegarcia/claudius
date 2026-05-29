"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { ArrowUp, ChevronRight, Folder, FolderPlus, Home, RefreshCw } from "lucide-react";
import { Overlay } from "@/components/overlays/Overlay";
import { cn } from "@/lib/utils/cn";

type Listing = {
  path: string;
  parent: string | null;
  entries: { name: string; path: string }[];
  home: string;
};

type Props = {
  initialPath?: string;
  onCancel: () => void;
  onPick: (path: string) => void;
};

export function DirectoryPicker({ initialPath, onCancel, onPick }: Props) {
  const [data, setData] = useState<Listing | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  // The directory we want to fetch is a tuple of (initialPath, manual
  // navigation target). We track navigation as state; `initialPath` only
  // seeds the first fetch via the effect below.
  const [target, setTarget] = useState<string | undefined>(initialPath);

  useEffect(() => {
    const controller = new AbortController();
    const params = new URLSearchParams();
    if (target) params.set("path", target);

    fetch(`/api/fs/dirs?${params}`, { signal: controller.signal })
      .then(async (res) => {
        if (!res.ok) {
          const e = (await res.json().catch(() => ({}))) as { error?: string };
          throw new Error(e.error ?? `HTTP ${res.status}`);
        }
        return (await res.json()) as Listing;
      })
      .then((listing) => {
        setData(listing);
        setError(null);
      })
      .catch((err: unknown) => {
        if (err instanceof DOMException && err.name === "AbortError") return;
        setError(err instanceof Error ? err.message : String(err));
      })
      .finally(() => {
        if (!controller.signal.aborted) setLoading(false);
      });

    return () => controller.abort();
  }, [target]);

  // Keep the surface API the same — callers still hand us a path string.
  const load = useCallback((next?: string) => {
    setLoading(true);
    setTarget(next);
  }, []);

  // ── Create-folder state ────────────────────────────────────────────────
  // When the user clicks the "New folder" button we reveal an inline input
  // row at the top of the entries list. Esc cancels; Enter (or the ✓
  // button) POSTs to /api/fs/dirs and navigates into the new directory so
  // the user can immediately "Pick this folder" on it.
  const [creating, setCreating] = useState(false);
  const [newName, setNewName] = useState("");
  const [createError, setCreateError] = useState<string | null>(null);
  const [createBusy, setCreateBusy] = useState(false);
  const nameInputRef = useRef<HTMLInputElement | null>(null);

  // Focus the input as soon as we enter create mode so the user can start
  // typing without an extra click. Pure DOM call — no state writes here, so
  // the effect can't cause a cascading render (state resets live in the
  // open/cancel handlers below).
  useEffect(() => {
    if (!creating) return;
    nameInputRef.current?.focus();
    nameInputRef.current?.select();
  }, [creating]);

  const openCreate = useCallback(() => {
    // Pair the mode toggle with its state resets in a single render —
    // React batches these together, no useEffect dance.
    setNewName("");
    setCreateError(null);
    setCreating(true);
  }, []);

  // Cancelling the create row should be cheap and reversible.
  const cancelCreate = useCallback(() => {
    if (createBusy) return;
    setCreating(false);
    setNewName("");
    setCreateError(null);
  }, [createBusy]);

  const submitCreate = useCallback(async () => {
    if (createBusy) return;
    const name = newName.trim();
    if (!name) {
      setCreateError("Name is required");
      return;
    }
    // Same client-side guard the server enforces — fail fast without a
    // round-trip and keep the error message close to the input.
    if (/[/\\\0]/.test(name) || name === "." || name === "..") {
      setCreateError("Invalid folder name");
      return;
    }
    if (!data) return;
    setCreateBusy(true);
    setCreateError(null);
    try {
      const res = await fetch("/api/fs/dirs", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ parent: data.path, name }),
      });
      if (!res.ok) {
        const body = (await res.json().catch(() => ({}))) as { error?: string };
        throw new Error(body.error ?? `HTTP ${res.status}`);
      }
      const out = (await res.json()) as { path: string };
      setCreating(false);
      // Drop the user inside the freshly created folder — typical intent
      // when someone clicks "New folder" in a picker is to pick that
      // folder, so navigating into it positions "Pick this folder" on it.
      load(out.path);
    } catch (err) {
      setCreateError(err instanceof Error ? err.message : String(err));
    } finally {
      setCreateBusy(false);
    }
  }, [createBusy, newName, data, load]);

  const crumbs = data ? splitCrumbs(data.path) : [];

  return (
    <Overlay title="Pick a folder" subtitle={data?.path ?? "…"} onClose={onCancel} width={620}>
      <div className="flex items-center gap-1 border-b border-[var(--border)] bg-[var(--panel-2)]/40 px-3 py-2">
        <button
          onClick={() => data && load(data.home)}
          title="Home"
          className="flex h-7 w-7 items-center justify-center rounded-md text-[var(--muted)] hover:bg-[var(--panel)] hover:text-[var(--foreground)]"
        >
          <Home className="h-3.5 w-3.5" />
        </button>
        <button
          onClick={() => data?.parent && load(data.parent)}
          disabled={!data?.parent}
          title="Up"
          className="flex h-7 w-7 items-center justify-center rounded-md text-[var(--muted)] hover:bg-[var(--panel)] hover:text-[var(--foreground)] disabled:opacity-40"
        >
          <ArrowUp className="h-3.5 w-3.5" />
        </button>
        <button
          onClick={() => data && load(data.path)}
          title="Refresh"
          className="flex h-7 w-7 items-center justify-center rounded-md text-[var(--muted)] hover:bg-[var(--panel)] hover:text-[var(--foreground)]"
        >
          <RefreshCw className="h-3.5 w-3.5" />
        </button>
        <button
          onClick={openCreate}
          disabled={!data || creating}
          title="New folder here"
          data-testid="directory-picker-new-folder"
          className="flex h-7 w-7 items-center justify-center rounded-md text-[var(--muted)] hover:bg-[var(--panel)] hover:text-[var(--foreground)] disabled:opacity-40"
        >
          <FolderPlus className="h-3.5 w-3.5" />
        </button>
        <div className="ml-2 flex flex-1 flex-wrap items-center gap-0.5 overflow-x-auto whitespace-nowrap text-xs scroll-thin">
          {crumbs.map((c) => (
            <button
              key={c.path}
              onClick={() => load(c.path)}
              className="rounded px-1 py-0.5 font-mono text-[11px] text-[var(--muted)] hover:bg-[var(--panel)] hover:text-[var(--foreground)]"
            >
              {c.label}
            </button>
          )).flatMap((node, i, arr) =>
            i < arr.length - 1 ? [node, <ChevronRight key={"sep" + i} className="h-3 w-3 opacity-40" />] : [node],
          )}
        </div>
      </div>
      <div className="max-h-[55vh] overflow-y-auto scroll-thin">
        {loading && <div className="px-3 py-3 text-xs text-[var(--muted)]">Loading…</div>}
        {error && (
          <div className="m-3 rounded-md border border-red-500/30 bg-red-500/10 px-3 py-2 text-xs text-red-300">
            {error}
          </div>
        )}
        {data && data.entries.length === 0 && !loading && !creating && (
          <div className="px-3 py-6 text-center text-xs text-[var(--muted)]">No subdirectories.</div>
        )}
        {creating && (
          <div
            data-testid="directory-picker-create-row"
            className="flex items-center gap-2 border-b border-[var(--border)] bg-[var(--panel-2)]/40 px-3 py-2"
          >
            <FolderPlus className="h-3.5 w-3.5 shrink-0 text-[var(--accent)]" />
            <input
              ref={nameInputRef}
              value={newName}
              onChange={(e) => {
                setNewName(e.target.value);
                if (createError) setCreateError(null);
              }}
              onKeyDown={(e) => {
                if (e.key === "Enter") {
                  e.preventDefault();
                  void submitCreate();
                } else if (e.key === "Escape") {
                  e.preventDefault();
                  cancelCreate();
                }
              }}
              placeholder="Folder name"
              data-testid="directory-picker-new-folder-name"
              disabled={createBusy}
              className="flex-1 rounded-sm border border-[var(--border)] bg-[var(--panel)] px-2 py-1 font-mono text-xs text-[var(--foreground)] outline-none focus:border-[var(--accent)] disabled:opacity-60"
            />
            <button
              onClick={() => void submitCreate()}
              disabled={createBusy || !newName.trim()}
              className="rounded-md bg-[var(--accent)] px-2.5 py-1 text-[11px] text-white hover:opacity-90 disabled:opacity-40"
            >
              {createBusy ? "Creating…" : "Create"}
            </button>
            <button
              onClick={cancelCreate}
              disabled={createBusy}
              className="rounded-md border border-[var(--border)] bg-[var(--panel-2)] px-2.5 py-1 text-[11px] hover:bg-[var(--panel)] disabled:opacity-40"
            >
              Cancel
            </button>
          </div>
        )}
        {createError && (
          <div className="mx-3 mt-2 rounded-md border border-red-500/30 bg-red-500/10 px-3 py-2 text-xs text-red-300">
            {createError}
          </div>
        )}
        <ul>
          {data?.entries.map((e) => (
            <li key={e.path}>
              <button
                onClick={() => load(e.path)}
                onDoubleClick={() => onPick(e.path)}
                className={cn(
                  "flex w-full items-center gap-2 px-3 py-1.5 text-left text-xs",
                  "hover:bg-[var(--panel-2)]",
                )}
              >
                <Folder className="h-3.5 w-3.5 text-[var(--accent)]" />
                <span className="font-mono">{e.name}</span>
              </button>
            </li>
          ))}
        </ul>
      </div>
      <div className="flex items-center gap-2 border-t border-[var(--border)] bg-[var(--panel-2)]/50 px-4 py-3">
        <span className="truncate font-mono text-[11px] text-[var(--muted)]">
          {data?.path ?? ""}
        </span>
        <button
          onClick={onCancel}
          className="ml-auto rounded-md border border-[var(--border)] bg-[var(--panel-2)] px-3 py-1.5 text-xs hover:bg-[var(--panel)]"
        >
          Cancel
        </button>
        <button
          onClick={() => data && onPick(data.path)}
          disabled={!data}
          className="rounded-md bg-[var(--accent)] px-3 py-1.5 text-xs text-white hover:opacity-90 disabled:opacity-40"
        >
          Pick this folder
        </button>
      </div>
    </Overlay>
  );
}

function splitCrumbs(path: string): { label: string; path: string }[] {
  if (path === "/") return [{ label: "/", path: "/" }];
  const parts = path.split("/");
  const out: { label: string; path: string }[] = [{ label: "/", path: "/" }];
  let cur = "";
  for (const p of parts) {
    if (!p) continue;
    cur += "/" + p;
    out.push({ label: p, path: cur });
  }
  return out;
}
