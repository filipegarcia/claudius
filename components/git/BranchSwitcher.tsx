"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  Check,
  ChevronDown,
  ChevronRight,
  GitBranch,
  Plus,
  RefreshCw,
  Cloud,
  AlertTriangle,
} from "lucide-react";
import { cn } from "@/lib/utils/cn";

export type BranchInfo = {
  name: string;
  kind: "local" | "remote";
  sha: string;
  upstream?: string;
  committerDate: string;
  current: boolean;
};

/** Discriminated outcome from any branch op handler. */
type OpResult = { ok: true } | { ok: false; error: string };

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
  onCheckout: (name: string) => Promise<OpResult>;
  /** Fired when the user wants to create a new branch. The parent gathers
   * the name and start point and calls the checkout endpoint with
   * `{ create: true }`. */
  onCreate: (name: string, startPoint?: string) => Promise<OpResult>;
  /** Merge `name` into the currently-checked-out branch (uses the
   * conflict-handoff plumbing on conflict). */
  onMerge: (name: string) => Promise<OpResult>;
  /** Rebase the current branch onto `name`. */
  onRebaseCurrentOnto: (name: string) => Promise<OpResult>;
  /** Switch to `branch` first, then rebase IT onto the previously-current
   * branch ("Checkout and Rebase onto current"). */
  onCheckoutAndRebase: (branch: string, onto: string) => Promise<OpResult>;
  /** `git branch -m <oldName> <newName>` — caller prompts for the new name. */
  onRename: (oldName: string, newName: string) => Promise<OpResult>;
  /** Local branch delete; force upgrades `-d` to `-D`. */
  onDeleteLocal: (name: string, force: boolean) => Promise<OpResult>;
  /** Remote branch delete (`git push origin --delete`). */
  onDeleteRemote: (name: string) => Promise<OpResult>;
  /** Read-only commit-log comparison dumped into the git console. */
  onCompare: (base: string, head: string) => Promise<OpResult>;
  /** `git diff <branch>` against the worktree, dumped into the git console. */
  onShowDiff: (name: string) => Promise<OpResult>;
  /** Triggered by the per-branch "Update" action — only renders on the
   * current branch. Same semantics as the header Pull (--ff-only). */
  onUpdate: () => Promise<OpResult>;
  /** Per-branch Push — only renders on the current branch. */
  onPush: () => Promise<OpResult>;
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
 *   - Each row has a kebab that opens a per-branch action submenu mirroring
 *     IntelliJ's right-click menu: checkout, rebase, merge, compare, rename,
 *     delete, etc. The available items depend on whether the row is the
 *     current branch, a local branch, or a remote-tracking ref.
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
  onMerge,
  onRebaseCurrentOnto,
  onCheckoutAndRebase,
  onRename,
  onDeleteLocal,
  onDeleteRemote,
  onCompare,
  onShowDiff,
  onUpdate,
  onPush,
  loadBranches,
}: Props) {
  const [open, setOpen] = useState(false);
  const [branches, setBranches] = useState<BranchInfo[]>([]);
  const [loading, setLoading] = useState(false);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [actionError, setActionError] = useState<string | null>(null);
  const [busyName, setBusyName] = useState<string | null>(null);
  const [filter, setFilter] = useState("");
  /**
   * Which row's submenu is open + the vertical offset (in px, relative to
   * the popover root) at which to render the right-side flyout. Null = none.
   * The key shape is `${kind}:${name}` for locals/remotes and `current:${name}`
   * for the highlighted current branch row.
   */
  const [menuFor, setMenuFor] = useState<{ key: string; top: number } | null>(null);
  const ref = useRef<HTMLDivElement>(null);
  const searchRef = useRef<HTMLInputElement>(null);
  // Popover container — used as the geometric origin for the right-side
  // submenu flyout, so its top offset is measured against this element.
  const popoverRef = useRef<HTMLDivElement>(null);
  // Scroll container — listening to its `scroll` event lets us close the
  // submenu when the row slides under it (which would otherwise leave the
  // flyout pointing at empty space).
  const listRef = useRef<HTMLDivElement>(null);

  // Refresh counter — bumping this triggers the fetch effect below.
  // Pattern A keeps setState out of the effect body.
  const [refetchTrigger, setRefetchTrigger] = useState(0);

  useEffect(() => {
    if (!open) return;
    let cancelled = false;
    loadBranches()
      .then((b) => {
        if (!cancelled) {
          setBranches(b);
          setLoadError(null);
        }
      })
      .catch((err: unknown) => {
        if (!cancelled) setLoadError(err instanceof Error ? err.message : String(err));
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [open, loadBranches, refetchTrigger]);

  const refresh = useCallback(() => {
    setLoading(true);
    setRefetchTrigger((n) => n + 1);
  }, []);

  // Reset filter / action-error and flip loading true the moment the
  // popover opens — "store previous props" pattern so the setState
  // runs in render, not inside the focus-effect below.
  // https://react.dev/reference/react/useState#storing-information-from-previous-renders
  const [wasOpen, setWasOpen] = useState(open);
  if (wasOpen !== open) {
    setWasOpen(open);
    if (open) {
      setLoading(true);
      setFilter("");
      setActionError(null);
      setMenuFor(null);
      setRefetchTrigger((n) => n + 1);
    } else {
      // Closing the popover always closes any open submenu so the next
      // open() starts from a clean slate.
      setMenuFor(null);
    }
  }

  // Close on outside click + Esc; focus the search box on open so the user
  // can start typing immediately, just like the IntelliJ popover.
  useEffect(() => {
    if (!open) return;
    const t = window.setTimeout(() => searchRef.current?.focus(), 0);
    function onClick(e: MouseEvent) {
      if (!ref.current?.contains(e.target as Node)) setOpen(false);
    }
    function onEsc(e: KeyboardEvent) {
      if (e.key === "Escape") {
        // Esc closes the submenu first, then the popover — matches macOS menu UX.
        if (menuFor) setMenuFor(null);
        else setOpen(false);
      }
    }
    window.addEventListener("mousedown", onClick);
    window.addEventListener("keydown", onEsc);
    return () => {
      window.clearTimeout(t);
      window.removeEventListener("mousedown", onClick);
      window.removeEventListener("keydown", onEsc);
    };
  }, [open, menuFor]);

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

  /**
   * Open (or close) the right-side submenu for a row. The caller passes the
   * row element so we can measure where to put the flyout — its `top` is
   * the row's offset relative to the popover root.
   */
  function toggleMenu(key: string, rowEl: HTMLElement | null) {
    setMenuFor((m) => {
      if (m?.key === key) return null;
      if (!rowEl || !popoverRef.current) return null;
      const rowRect = rowEl.getBoundingClientRect();
      const popRect = popoverRef.current.getBoundingClientRect();
      return { key, top: rowRect.top - popRect.top };
    });
  }

  /**
   * Run an op-result-returning handler with shared busy/error plumbing.
   * `closeOnOk` is the default — most actions succeed by changing the
   * world (checkout, merge, …) and the popover should dismiss. The few
   * read-only ones (compare, show-diff) opt out so the user can chain them.
   */
  async function runOp(
    key: string,
    fn: () => Promise<OpResult>,
    opts: { closeOnOk?: boolean } = {},
  ) {
    const closeOnOk = opts.closeOnOk !== false;
    setBusyName(key);
    setActionError(null);
    try {
      const r = await fn();
      if (r.ok) {
        if (closeOnOk) setOpen(false);
        else setMenuFor(null);
      } else {
        setActionError(r.error);
      }
    } finally {
      setBusyName(null);
    }
  }

  async function doCheckout(name: string) {
    await runOp(name, () => onCheckout(name));
  }

  async function doCreate(startPoint?: string) {
    // Cheap browser prompts keep the popover modest — a richer "From…" form
    // can land later. Default start point is current HEAD (omit startPoint).
    const promptLabel = startPoint
      ? `New branch name (starting from '${startPoint}'):`
      : "New branch name:";
    const name = window.prompt(promptLabel);
    if (!name) return;
    const trimmed = name.trim();
    if (!trimmed) return;
    await runOp(`__new__:${trimmed}`, () => onCreate(trimmed, startPoint));
  }

  async function doRename(oldName: string) {
    const next = window.prompt(`Rename branch '${oldName}' to:`, oldName);
    if (!next) return;
    const trimmed = next.trim();
    if (!trimmed || trimmed === oldName) return;
    await runOp(`__rename__:${oldName}`, () => onRename(oldName, trimmed));
  }

  async function doDeleteLocal(name: string) {
    if (!window.confirm(`Delete local branch '${name}'?`)) return;
    setBusyName(`__delete__:${name}`);
    setActionError(null);
    try {
      const r = await onDeleteLocal(name, false);
      if (r.ok) {
        setMenuFor(null);
        refresh();
        return;
      }
      // git branch -d refuses unmerged branches with "not fully merged".
      // Offer the force escape hatch inline so the user doesn't have to
      // drop to the console.
      if (/not fully merged|not yet been merged/i.test(r.error)) {
        if (
          window.confirm(
            `'${name}' is not fully merged. Force-delete anyway? Unmerged commits will be lost.`,
          )
        ) {
          const r2 = await onDeleteLocal(name, true);
          if (r2.ok) {
            setMenuFor(null);
            refresh();
            return;
          }
          setActionError(r2.error);
          return;
        }
        setActionError(r.error);
        return;
      }
      setActionError(r.error);
    } finally {
      setBusyName(null);
    }
  }

  async function doDeleteRemote(name: string) {
    if (
      !window.confirm(
        `Delete remote branch '${name}'? Runs \`git push --delete\` — this is published to the remote and cannot be undone here.`,
      )
    )
      return;
    await runOp(`__delete__:${name}`, () => onDeleteRemote(name));
    refresh();
  }

  /**
   * Look up the branch a menu key refers to. Returns `null` if the key
   * doesn't match any known branch (e.g. the row was filtered out while
   * the menu was open — the menu effect closes itself in that case).
   */
  function branchForKey(key: string): BranchInfo | null {
    const colon = key.indexOf(":");
    if (colon <= 0) return null;
    const tag = key.slice(0, colon);
    const name = key.slice(colon + 1);
    if (tag === "current") return branches.find((b) => b.current && b.name === name) ?? null;
    if (tag === "local") return branches.find((b) => b.kind === "local" && b.name === name) ?? null;
    if (tag === "remote") return branches.find((b) => b.kind === "remote" && b.name === name) ?? null;
    return null;
  }

  const activeMenuBranch = menuFor ? branchForKey(menuFor.key) : null;

  const chipLabel = current ?? "—";

  /**
   * Build the action list for a row given its kind + whether there's a
   * current branch to compare against. Render-time helper, not memoised —
   * the list is short and rebuilt only when the submenu opens.
   */
  function actionsFor(b: BranchInfo): Array<{
    label: string;
    disabled?: boolean;
    danger?: boolean;
    run: () => void | Promise<void>;
  }> {
    const cur = current ?? null;
    const isCur = b.current;
    const items: Array<{
      label: string;
      disabled?: boolean;
      danger?: boolean;
      run: () => void | Promise<void>;
    }> = [];
    items.push({
      label: "Checkout",
      disabled: isCur,
      run: () => void doCheckout(b.name),
    });
    items.push({
      label: `New Branch from '${b.name}'…`,
      run: () => void doCreate(b.name),
    });
    if (!isCur && cur) {
      items.push({
        label: `Checkout and Rebase onto '${cur}'`,
        run: () =>
          void runOp(`__cor__:${b.name}`, () => onCheckoutAndRebase(b.name, cur)),
      });
    }
    if (!isCur && cur) {
      items.push({
        label: `Compare with '${cur}'`,
        run: () =>
          void runOp(`__cmp__:${b.name}`, () => onCompare(cur, b.name), {
            closeOnOk: false,
          }),
      });
      items.push({
        label: "Show Diff with Working Tree",
        run: () =>
          void runOp(`__diff__:${b.name}`, () => onShowDiff(b.name), {
            closeOnOk: false,
          }),
      });
      items.push({
        label: `Rebase '${cur}' onto '${b.name}'`,
        run: () =>
          void runOp(`__rb__:${b.name}`, () => onRebaseCurrentOnto(b.name)),
      });
      items.push({
        label: `Merge '${b.name}' into '${cur}'`,
        run: () => void runOp(`__mg__:${b.name}`, () => onMerge(b.name)),
      });
    }
    if (isCur) {
      // Update/Push only make sense on the current branch — non-current
      // semantics are a scope trap (fetch into a non-checked-out local,
      // push without checkout, …). Cleanest version: current-branch only.
      items.push({
        label: "Update",
        run: () => void runOp(`__update__:${b.name}`, () => onUpdate()),
      });
      items.push({
        label: "Push…",
        run: () => void runOp(`__push__:${b.name}`, () => onPush()),
      });
    }
    if (b.kind === "local") {
      items.push({
        label: "Rename…",
        run: () => void doRename(b.name),
      });
      items.push({
        label: "Delete",
        danger: true,
        disabled: isCur,
        run: () => void doDeleteLocal(b.name),
      });
    } else {
      items.push({
        label: "Delete (remote)",
        danger: true,
        run: () => void doDeleteRemote(b.name),
      });
    }
    return items;
  }

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
          ref={popoverRef}
          data-testid="branch-switcher-popover"
          className="absolute left-0 top-full z-30 mt-1 w-80 overflow-visible rounded-lg border border-[var(--border)] bg-[var(--panel)] shadow-2xl"
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
          <div
            ref={listRef}
            // Closing the submenu on scroll keeps the flyout from drifting
            // away from its row — we anchor the flyout's `top` at open time
            // and don't track scroll updates. A close-on-scroll is the
            // cheapest answer that doesn't feel broken.
            onScroll={() => menuFor && setMenuFor(null)}
            className="max-h-80 overflow-y-auto scroll-thin"
          >
            {currentBranch && (
              <Section label="Current">
                <BranchRow
                  branch={currentBranch}
                  current
                  busy={busyName === currentBranch.name}
                  menuOpen={menuFor?.key === `current:${currentBranch.name}`}
                  onPick={() => void doCheckout(currentBranch.name)}
                  onToggleMenu={(rowEl) =>
                    toggleMenu(`current:${currentBranch.name}`, rowEl)
                  }
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
                      menuOpen={menuFor?.key === `local:${b.name}`}
                      onPick={() => void doCheckout(b.name)}
                      onToggleMenu={(rowEl) => toggleMenu(`local:${b.name}`, rowEl)}
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
                    menuOpen={menuFor?.key === `remote:${b.name}`}
                    onPick={() => void doCheckout(b.name)}
                    onToggleMenu={(rowEl) => toggleMenu(`remote:${b.name}`, rowEl)}
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
          {menuFor && activeMenuBranch && (
            <div
              // Flyout panel anchored to the right edge of the popover.
              // Lives at the popover root (NOT inside the scroll container)
              // — the popover itself has `overflow-visible`, so the flyout
              // can extend past the popover bounds without being clipped.
              // The `top` is computed at open time from the row's offset;
              // we close on scroll so the row and flyout stay aligned.
              style={{ top: menuFor.top }}
              className="absolute left-full z-40 ml-1 w-72 overflow-hidden rounded-lg border border-[var(--border)] bg-[var(--panel)] shadow-2xl"
              role="menu"
              data-testid={`branch-menu-${activeMenuBranch.kind}-${activeMenuBranch.name}`}
            >
              <div className="border-b border-[var(--border)] px-3 py-1.5 text-[10px] uppercase tracking-wide text-[var(--muted)]">
                <span className="font-mono normal-case tracking-normal text-[var(--foreground)]">
                  {activeMenuBranch.name}
                </span>
              </div>
              {actionsFor(activeMenuBranch).map((a, i) => (
                <button
                  key={`${a.label}:${i}`}
                  type="button"
                  role="menuitem"
                  disabled={Boolean(a.disabled || busyName)}
                  onClick={(e) => {
                    e.stopPropagation();
                    if (a.disabled || busyName) return;
                    void a.run();
                  }}
                  className={cn(
                    "flex w-full items-center justify-between px-3 py-1.5 text-left text-xs",
                    "hover:bg-[var(--panel-2)] disabled:opacity-40",
                    a.danger && "text-red-300 hover:bg-red-500/15",
                  )}
                >
                  <span className="truncate">{a.label}</span>
                </button>
              ))}
            </div>
          )}
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
  menuOpen,
  onPick,
  onToggleMenu,
}: {
  branch: BranchInfo;
  current?: boolean;
  busy?: boolean;
  menuOpen: boolean;
  onPick: () => void;
  /**
   * Toggles the right-side flyout. The HTMLElement is the row wrapper,
   * which the parent uses to compute the flyout's vertical offset.
   */
  onToggleMenu: (rowEl: HTMLElement | null) => void;
}) {
  const rowRef = useRef<HTMLDivElement>(null);
  return (
    <div
      ref={rowRef}
      className={cn(
        "group/row relative",
        current && "bg-[var(--panel-2)]/60",
        menuOpen && "bg-[var(--panel-2)]",
      )}
    >
      <div className="flex w-full items-center">
        <button
          type="button"
          onClick={onPick}
          disabled={busy}
          className={cn(
            "flex min-w-0 flex-1 items-center gap-2 px-3 py-1.5 text-left text-xs",
            "hover:bg-[var(--panel-2)] disabled:cursor-progress disabled:opacity-60",
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
            <span
              className="shrink-0 truncate font-mono text-[10px] text-[var(--muted)]"
              title={`tracks ${branch.upstream}`}
            >
              {branch.upstream}
            </span>
          )}
        </button>
        <button
          type="button"
          onClick={(e) => {
            e.stopPropagation();
            onToggleMenu(rowRef.current);
          }}
          // GitLab-style chevron: points right when collapsed. When the
          // submenu is open it stays "right" to read as a hint that the
          // flyout opens in that direction; the row's background also
          // highlights so the user can see which row's actions are showing.
          className={cn(
            "mr-1 flex h-5 w-5 shrink-0 items-center justify-center rounded text-[var(--muted)]",
            "hover:bg-[var(--panel)] hover:text-[var(--foreground)]",
            menuOpen && "text-[var(--foreground)]",
          )}
          title={menuOpen ? "Hide branch actions" : "Show branch actions"}
          aria-expanded={menuOpen}
          data-testid={`branch-actions-${branch.kind}-${branch.name}`}
        >
          <ChevronRight className="h-3 w-3" />
        </button>
      </div>
    </div>
  );
}
