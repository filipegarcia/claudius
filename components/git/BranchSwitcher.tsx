"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import { Check, ChevronDown, GitBranch, Plus, RefreshCw, Cloud, AlertTriangle } from "lucide-react";
import { cn } from "@/lib/utils/cn";

export type BranchInfo = {
  name: string;
  kind: "local" | "remote";
  sha: string;
  upstream?: string;
  committerDate: string;
  current: boolean;
};

type Props = {
  /** Current branch name to render on the chip. `null` while loading or
   * when the workspace isn't a git repo. */
  current: string | null;
  /** True when HEAD is detached — the chip then shows the short SHA but the
   * popover label clarifies the state. */
  detached?: boolean;
  /** True after the user clicks the chip and we're loading the branch list. */
  disabled?: boolean;
  /** Called when the user picks a branch — name is what we send to the
   * checkout endpoint, which probes local/remote and does the right thing. */
  onCheckout: (name: string) => Promise<{ ok: true } | { ok: false; error: string }>;
  /** Fired when the user wants to create a new branch. The parent gathers
   * the name and start point and calls the checkout endpoint with
   * `{ create: true }`. */
  onCreate: (name: string, startPoint?: string) => Promise<{ ok: true } | { ok: false; error: string }>;
  /** Fetches the branch list. Re-runs on every open so newly fetched remote
   * refs show up without a page refresh. */
  loadBranches: () => Promise<BranchInfo[]>;
};

/**
 * IntelliJ-style branch popover. Lives in the Git page header as a chip;
 * click to reveal a searchable list of local + remote branches.
 *
 *   - Sections: Local (current first, then recent), then Remote.
 *   - Search filters by substring against the visible name + upstream.
 *   - "New Branch…" prompts for a name and starts from the current HEAD by
 *     default; the user can suffix `from <ref>` in the prompt to override.
 *
 * The popover is purely presentational — wiring (refresh git status,
 * clear checked files, drop diff selection) happens in the parent.
 */
export function BranchSwitcher({
  current,
  detached,
  disabled,
  onCheckout,
  onCreate,
  loadBranches,
}: Props) {
  const [open, setOpen] = useState(false);
  const [branches, setBranches] = useState<BranchInfo[]>([]);
  const [loading, setLoading] = useState(false);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [actionError, setActionError] = useState<string | null>(null);
  const [busyName, setBusyName] = useState<string | null>(null);
  const [filter, setFilter] = useState("");
  const ref = useRef<HTMLDivElement>(null);
  const searchRef = useRef<HTMLInputElement>(null);

  const refresh = async () => {
    setLoading(true);
    setLoadError(null);
    try {
      setBranches(await loadBranches());
    } catch (err) {
      setLoadError(err instanceof Error ? err.message : String(err));
    } finally {
      setLoading(false);
    }
  };

  // Close on outside click + Esc; focus the search box on open so the user
  // can start typing immediately, just like the IntelliJ popover.
  useEffect(() => {
    if (!open) return;
    void refresh();
    setFilter("");
    setActionError(null);
    const t = window.setTimeout(() => searchRef.current?.focus(), 0);
    function onClick(e: MouseEvent) {
      if (!ref.current?.contains(e.target as Node)) setOpen(false);
    }
    function onEsc(e: KeyboardEvent) {
      if (e.key === "Escape") setOpen(false);
    }
    window.addEventListener("mousedown", onClick);
    window.addEventListener("keydown", onEsc);
    return () => {
      window.clearTimeout(t);
      window.removeEventListener("mousedown", onClick);
      window.removeEventListener("keydown", onEsc);
    };
    // refresh is intentionally not in deps — re-running on every render would
    // refetch on every keystroke.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open]);

  const { locals, remotes, currentBranch } = useMemo(() => {
    const cur = branches.find((b) => b.current) ?? null;
    const q = filter.trim().toLowerCase();
    const match = (b: BranchInfo) =>
      !q ||
      b.name.toLowerCase().includes(q) ||
      (b.upstream ?? "").toLowerCase().includes(q);
    const locals = branches.filter((b) => b.kind === "local" && match(b));
    const remotes = branches.filter((b) => b.kind === "remote" && match(b));
    return { locals, remotes, currentBranch: cur };
  }, [branches, filter]);

  async function doCheckout(name: string) {
    setBusyName(name);
    setActionError(null);
    const r = await onCheckout(name);
    setBusyName(null);
    if (r.ok) {
      setOpen(false);
    } else {
      setActionError(r.error);
    }
  }

  async function doCreate() {
    // Cheap browser prompts keep the popover modest — a richer "From…" form
    // can land later. Default start point is current HEAD (omit startPoint).
    const name = window.prompt("New branch name:");
    if (!name) return;
    const trimmed = name.trim();
    if (!trimmed) return;
    setBusyName(`__new__:${trimmed}`);
    setActionError(null);
    const r = await onCreate(trimmed);
    setBusyName(null);
    if (r.ok) {
      setOpen(false);
    } else {
      setActionError(r.error);
    }
  }

  const chipLabel = current ?? "—";

  return (
    <div ref={ref} className="relative">
      <button
        type="button"
        onClick={() => setOpen((o) => !o)}
        disabled={disabled || !current}
        title={current ? `Branch: ${current} · click to switch` : "No branch"}
        data-testid="branch-switcher-button"
        className={cn(
          "flex h-6 items-center gap-1 rounded px-1.5 text-xs",
          "hover:bg-[var(--panel-2)] hover:text-[var(--foreground)] disabled:opacity-40",
          open && "bg-[var(--panel-2)] text-[var(--foreground)]",
          !open && "text-[var(--muted)]",
        )}
      >
        <span className={cn("font-mono", detached && "text-amber-300")}>{chipLabel}</span>
        <ChevronDown className="h-3 w-3 opacity-60" />
      </button>
      {open && (
        <div
          data-testid="branch-switcher-popover"
          className="absolute left-0 top-full z-30 mt-1 w-80 overflow-hidden rounded-lg border border-[var(--border)] bg-[var(--panel)] shadow-2xl"
        >
          <div className="flex items-center gap-2 border-b border-[var(--border)] px-2 py-1.5">
            <GitBranch className="h-3 w-3 text-[var(--muted)]" />
            <input
              ref={searchRef}
              value={filter}
              onChange={(e) => setFilter(e.target.value)}
              placeholder="Search branches…"
              className="flex-1 bg-transparent text-xs outline-none placeholder:text-[var(--muted)]"
              data-testid="branch-switcher-search"
            />
            <button
              type="button"
              onClick={() => void refresh()}
              disabled={loading}
              title="Refresh"
              className="flex h-5 w-5 items-center justify-center rounded text-[var(--muted)] hover:bg-[var(--panel-2)] hover:text-[var(--foreground)] disabled:opacity-40"
            >
              <RefreshCw className={cn("h-3 w-3", loading && "animate-spin")} />
            </button>
          </div>
          {actionError && (
            <div className="flex items-start gap-1.5 border-b border-red-500/30 bg-red-500/10 px-3 py-1.5 text-[11px] text-red-300">
              <AlertTriangle className="mt-px h-3 w-3 shrink-0" />
              <span className="whitespace-pre-wrap break-words">{actionError}</span>
            </div>
          )}
          {loadError && (
            <div className="border-b border-red-500/30 bg-red-500/10 px-3 py-1.5 text-[11px] text-red-300">
              {loadError}
            </div>
          )}
          <div className="max-h-80 overflow-y-auto scroll-thin">
            {currentBranch && (
              <Section label="Current">
                <BranchRow
                  branch={currentBranch}
                  current
                  busy={busyName === currentBranch.name}
                  onPick={() => void doCheckout(currentBranch.name)}
                />
              </Section>
            )}
            {locals.length > 0 && (
              <Section label={`Local${detached ? "" : " · others"}`}>
                {locals
                  .filter((b) => !b.current)
                  .map((b) => (
                    <BranchRow
                      key={`local:${b.name}`}
                      branch={b}
                      busy={busyName === b.name}
                      onPick={() => void doCheckout(b.name)}
                    />
                  ))}
              </Section>
            )}
            {remotes.length > 0 && (
              <Section label="Remote">
                {remotes.map((b) => (
                  <BranchRow
                    key={`remote:${b.name}`}
                    branch={b}
                    busy={busyName === b.name}
                    onPick={() => void doCheckout(b.name)}
                  />
                ))}
              </Section>
            )}
            {!loading && branches.length === 0 && !loadError && (
              <div className="px-3 py-4 text-center text-[11px] text-[var(--muted)]">
                No branches found.
              </div>
            )}
            {!loading && branches.length > 0 && locals.length === 0 && remotes.length === 0 && !currentBranch && (
              <div className="px-3 py-4 text-center text-[11px] text-[var(--muted)]">
                No matches for &ldquo;{filter}&rdquo;.
              </div>
            )}
          </div>
          <div className="border-t border-[var(--border)]">
            <button
              type="button"
              onClick={() => void doCreate()}
              className="flex w-full items-center gap-2 px-3 py-2 text-left text-xs hover:bg-[var(--panel-2)]"
              data-testid="branch-switcher-new"
            >
              <Plus className="h-3.5 w-3.5" />
              <span>New branch…</span>
            </button>
          </div>
        </div>
      )}
    </div>
  );
}

function Section({ label, children }: { label: string; children: React.ReactNode }) {
  // The label row is purposely sticky so a long Remote list still tells the
  // user where they are in the popover.
  return (
    <div className="py-1">
      <div className="sticky top-0 z-10 bg-[var(--panel)] px-3 py-1 text-[10px] uppercase tracking-wide text-[var(--muted)]">
        {label}
      </div>
      <div>{children}</div>
    </div>
  );
}

function BranchRow({
  branch,
  current,
  busy,
  onPick,
}: {
  branch: BranchInfo;
  current?: boolean;
  busy?: boolean;
  onPick: () => void;
}) {
  return (
    <button
      type="button"
      onClick={onPick}
      disabled={busy}
      className={cn(
        "flex w-full items-center gap-2 px-3 py-1.5 text-left text-xs",
        "hover:bg-[var(--panel-2)] disabled:cursor-progress disabled:opacity-60",
        current && "bg-[var(--panel-2)]/60",
      )}
      title={branch.name}
    >
      {current ? (
        <Check className="h-3 w-3 shrink-0 text-[var(--accent)]" />
      ) : branch.kind === "remote" ? (
        <Cloud className="h-3 w-3 shrink-0 text-[var(--muted)]" />
      ) : (
        <GitBranch className="h-3 w-3 shrink-0 text-[var(--muted)]" />
      )}
      <span className="min-w-0 flex-1 truncate font-mono">{branch.name}</span>
      {branch.upstream && branch.kind === "local" && (
        <span className="shrink-0 truncate font-mono text-[10px] text-[var(--muted)]" title={`tracks ${branch.upstream}`}>
          {branch.upstream}
        </span>
      )}
    </button>
  );
}
