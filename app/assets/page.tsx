"use client";

import { useEffect, useState } from "react";
import Link from "next/link";
import { ArrowLeft, Image as ImageIcon, RefreshCw, Search } from "lucide-react";
import { SideNav } from "@/components/nav/SideNav";
import { ScopeToggle } from "@/components/nav/ScopeToggle";
import { FileGrid } from "@/components/files/FileGrid";
import { FileDetail } from "@/components/files/FileDetail";
import { useAssets } from "@/lib/client/useAssets";
import type { AssetRow, Scope, TypeFilter } from "@/lib/server/asset-list";
import { cn } from "@/lib/utils/cn";

export default function AssetsPage() {
  const [cwd, setCwd] = useState<string | null>(null);
  const [scope, setScope] = useState<Scope>("project");
  const [type, setType] = useState<TypeFilter>("all");
  const [q, setQ] = useState("");
  const [active, setActive] = useState<AssetRow | null>(null);

  useEffect(() => {
    fetch("/api/sessions")
      .then((r) => r.json())
      .then((arr: Array<{ cwd?: string }>) => setCwd(arr?.[0]?.cwd ?? ""))
      .catch(() => setCwd(""));
  }, []);

  const { items, loading, error, refresh, loadMore, hasMore } = useAssets({ cwd, scope, type, q });

  return (
    <div className="flex h-full">
      <SideNav running={false} />
      <main className="flex h-full flex-1 flex-col overflow-hidden">
        <header className="flex h-9 shrink-0 items-center gap-3 border-b border-[var(--border)] bg-[var(--panel)] px-4 text-xs">
          <Link href="/" className="flex items-center gap-1 text-[var(--muted)] hover:text-[var(--foreground)]">
            <ArrowLeft className="h-3.5 w-3.5" /> Chat
          </Link>
          <span className="opacity-50">·</span>
          <ImageIcon className="h-3.5 w-3.5 text-[var(--muted)]" />
          <span className="font-medium">Assets</span>
          <ScopeToggle
            value={scope === "project" ? "workspace" : "account"}
            onChange={(s) => setScope(s === "workspace" ? "project" : "account")}
          />
          <span className="text-[var(--muted)]">({items.length})</span>
          {loading && <span className="text-[var(--muted)]">loading…</span>}
          {error && <span className="text-red-400">{error}</span>}
          <button
            onClick={() => refresh(true)}
            title="Re-scan project JSONLs and refresh"
            className="ml-auto flex items-center gap-1 rounded-md border border-[var(--border)] bg-[var(--panel-2)] px-2 py-0.5 hover:bg-[var(--panel)]"
          >
            <RefreshCw className="h-3 w-3" /> Re-index
          </button>
        </header>

        <div className="flex flex-wrap items-center gap-2 border-b border-[var(--border)] bg-[var(--panel)]/40 px-4 py-2 text-xs">
          {(["all", "image", "file"] as TypeFilter[]).map((t) => (
            <button
              key={t}
              onClick={() => setType(t)}
              className={cn(
                "rounded-md border border-[var(--border)] px-2 py-1",
                type === t
                  ? "bg-[var(--panel-2)]"
                  : "bg-[var(--panel)] text-[var(--muted)] hover:text-[var(--foreground)]",
              )}
            >
              {t}
            </button>
          ))}
          <div className="ml-auto flex items-center gap-1.5 rounded-md border border-[var(--border)] bg-[var(--panel-2)] px-2 py-0.5">
            <Search className="h-3 w-3 text-[var(--muted)]" />
            <input
              value={q}
              onChange={(e) => setQ(e.target.value)}
              placeholder="hash prefix or session id"
              className="w-56 bg-transparent focus:outline-none"
            />
          </div>
        </div>

        {scope === "account" && (
          <div className="border-b border-[var(--border)] bg-[var(--panel)]/30 px-4 py-1.5 text-[11px] text-[var(--muted)]">
            Local to this machine. Nothing is uploaded — these are the files Claudius has indexed
            from <code className="font-mono">~/.claude/projects/</code>.
          </div>
        )}

        <div className="flex-1 overflow-y-auto scroll-thin">
          <div className="mx-auto max-w-6xl px-4 py-4">
            <FileGrid items={items} cwd={cwd ?? ""} onSelect={setActive} />
            {hasMore && (
              <div className="mt-4 flex justify-center">
                <button
                  onClick={loadMore}
                  className="rounded-md border border-[var(--border)] bg-[var(--panel-2)] px-3 py-1.5 text-xs hover:bg-[var(--panel)]"
                >
                  Load more
                </button>
              </div>
            )}
          </div>
        </div>
      </main>

      {active && cwd != null && (
        <FileDetail
          asset={active}
          cwd={cwd}
          onClose={() => setActive(null)}
          onDeleted={() => void refresh()}
        />
      )}
    </div>
  );
}
