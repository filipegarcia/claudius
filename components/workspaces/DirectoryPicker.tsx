"use client";

import { useCallback, useEffect, useState } from "react";
import { ArrowUp, ChevronRight, Folder, Home, RefreshCw } from "lucide-react";
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
        {data && data.entries.length === 0 && !loading && (
          <div className="px-3 py-6 text-center text-xs text-[var(--muted)]">No subdirectories.</div>
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
