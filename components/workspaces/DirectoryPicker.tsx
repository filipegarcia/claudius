"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  ArrowUp,
  ChevronRight,
  Folder,
  FolderPlus,
  Home,
  Lock,
  RefreshCw,
} from "lucide-react";
import { Overlay } from "@/components/overlays/Overlay";
import { tccHeadsUpCopy, type TccCategory } from "@/lib/shared/tcc-protected";
import { cn } from "@/lib/utils/cn";

type ListingEntry = {
  name: string;
  path: string;
  /**
   * True for macOS TCC-protected children of `$HOME` (Desktop, Documents,
   * Downloads, Movies, Music, Pictures). The server only sets this on
   * darwin — see `lib/shared/tcc-protected.ts`. Used to render the lock
   * badge in the picker.
   */
  protected?: boolean;
};

type Listing = {
  path: string;
  parent: string | null;
  entries: ListingEntry[];
  home: string;
};

/**
 * Sentinel the server returns instead of a directory listing when the
 * caller tried to descend into a TCC-protected folder (Desktop /
 * Documents / Downloads / Movies / Music / Pictures) without the
 * `?ack=1` flag. We surface our own in-app heads-up modal first, then
 * retry with `?ack=1`. See `lib/shared/tcc-protected.ts` for why.
 */
type NeedsAck = {
  needsAck: true;
  category: TccCategory;
  path: string;
};

/**
 * Type guard so TS narrows correctly across the fetch-result branch.
 * Inline `"needsAck" in listing` checks would in principle narrow, but
 * the React-Compiler-friendly arrow chain below confuses the inferred
 * residual type — a dedicated predicate sidesteps that.
 */
function isNeedsAck(x: Listing | NeedsAck): x is NeedsAck {
  return "needsAck" in x && x.needsAck === true;
}

/**
 * localStorage key for acknowledged TCC categories. Versioned so we can
 * invalidate if the category list (or the rationale copy) ever
 * changes meaningfully. Persisted-forever per the product decision
 * captured in the implementation thread — once the user has seen the
 * heads-up for Desktop, we don't re-ask on subsequent picker opens.
 */
const TCC_ACK_STORAGE_KEY = "claudius.tcc.ack.v1";

function readAckedFromStorage(): Set<TccCategory> {
  if (typeof window === "undefined") return new Set();
  try {
    const raw = window.localStorage.getItem(TCC_ACK_STORAGE_KEY);
    if (!raw) return new Set();
    const parsed = JSON.parse(raw) as unknown;
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
      return new Set();
    }
    const out = new Set<TccCategory>();
    for (const [k, v] of Object.entries(parsed as Record<string, unknown>)) {
      if (v === true) out.add(k as TccCategory);
    }
    return out;
  } catch {
    return new Set();
  }
}

function persistAcked(set: Set<TccCategory>): void {
  if (typeof window === "undefined") return;
  try {
    const obj: Record<string, true> = {};
    for (const k of set) obj[k] = true;
    window.localStorage.setItem(TCC_ACK_STORAGE_KEY, JSON.stringify(obj));
  } catch {
    // localStorage may be unavailable (private mode, quota). Fail silently —
    // worst case we re-ask on the next session.
  }
}

/**
 * Fire a native OS notification mirroring the in-app heads-up so the user
 * notices it even when they're on a different screen / app. No-op when
 * not running in Electron, when the bridge isn't ready, or when the OS
 * has disabled notifications for the bundle. Per the project memory note,
 * unsigned dev Electron builds silently drop these (UNError 1) — the
 * in-app modal still carries the message.
 */
function notifyTccHeadsUp(category: TccCategory): void {
  if (typeof window === "undefined") return;
  const bridge = window.claudius;
  if (!bridge?.notifications?.show) return;
  const copy = tccHeadsUpCopy(category);
  try {
    bridge.notifications.show({
      title: copy.title,
      body: copy.body,
    });
  } catch {
    // Notification bridge is best-effort — never let it break navigation.
  }
}

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
  // seeds the first fetch via the effect below. `navTick` exists so a
  // forced retry (e.g. after the user acks a TCC heads-up) can re-fire
  // the effect even when the target string is unchanged from the prior
  // attempt — React skips the effect when only same-value re-sets fire.
  const [target, setTarget] = useState<string | undefined>(initialPath);
  const [navTick, setNavTick] = useState(0);

  // ── TCC heads-up state ────────────────────────────────────────────
  // `acked` lives in component state so a confirm reflects immediately
  // (no re-read race). We rehydrate it from localStorage at mount via
  // the lazy initializer — `readAckedFromStorage` itself guards SSR by
  // checking `typeof window`, so it's safe to call during hydration.
  const [acked, setAcked] = useState<Set<TccCategory>>(() => readAckedFromStorage());
  // `pendingTcc` is the path the user tried to navigate to that the
  // server flagged as needing acknowledgment. While set, the in-app
  // modal is open; Continue marks the category acked and re-fires the
  // fetch with `?ack=1`; Cancel reverts to the previous listing.
  const [pendingTcc, setPendingTcc] = useState<NeedsAck | null>(null);

  // Categories the user has already confirmed get fetched with `ack=1`
  // automatically so the server doesn't bounce us with a needsAck. The
  // effect below consults this via the closure on `acked`.
  const ackedRef = useRef(acked);
  useEffect(() => {
    ackedRef.current = acked;
  }, [acked]);

  // Retry the current fetch with `ack=1`. Bumping `navTick` forces the
  // effect to re-run even when the target string is identical to the
  // prior attempt (React would otherwise skip the effect for a
  // same-value setState). Same-target retry happens after a needsAck
  // bounce when the user just confirmed the TCC heads-up. Declared
  // BEFORE the fetch effect so the effect's closure can reference it
  // without a use-before-decl violation.
  const retryWithAck = useCallback((path: string) => {
    setTarget(path);
    setNavTick((t) => t + 1);
  }, []);

  useEffect(() => {
    const controller = new AbortController();
    const params = new URLSearchParams();
    if (target) params.set("path", target);
    // Best-effort: if we know `target` lives under a TCC category we've
    // already acked, send `ack=1` up-front to skip the needsAck round
    // trip. We can't categorize without the home root yet on the very
    // first fetch; for follow-up fetches `data.home` is available so we
    // do the check below before issuing the request.
    const home = data?.home;
    if (target && home) {
      const cat = categorizeFromHome(target, home);
      if (cat && ackedRef.current.has(cat)) params.set("ack", "1");
    }

    fetch(`/api/fs/dirs?${params}`, { signal: controller.signal })
      .then(async (res) => {
        if (!res.ok) {
          const e = (await res.json().catch(() => ({}))) as { error?: string };
          throw new Error(e.error ?? `HTTP ${res.status}`);
        }
        return (await res.json()) as Listing | NeedsAck;
      })
      .then((listing) => {
        // `needsAck` sentinel: server refuses to read this path until
        // the user has acknowledged. If they already acked the category
        // somewhere this fetch raced ahead of, retry transparently;
        // otherwise raise the modal and stay on the previous listing.
        if (isNeedsAck(listing)) {
          if (ackedRef.current.has(listing.category)) {
            // Already acked — retry with the ack flag set. Mark the
            // current request done so the spinner clears; the retry
            // effect will fire when we mutate `target` below. We use a
            // dedicated re-set on `target` to retrigger this same
            // effect rather than fan out to a parallel fetcher.
            void retryWithAck(listing.path);
            return;
          }
          setPendingTcc(listing);
          return;
        }
        setData(listing);
        setError(null);
        setPendingTcc(null);
      })
      .catch((err: unknown) => {
        if (err instanceof DOMException && err.name === "AbortError") return;
        setError(err instanceof Error ? err.message : String(err));
      })
      .finally(() => {
        if (!controller.signal.aborted) setLoading(false);
      });

    return () => controller.abort();
    // `data?.home` is intentionally NOT a dep — we read it via closure
    // only as a fast-path for the up-front ack hint, and we don't want
    // a home-only change to retrigger a fetch. `navTick` IS a dep so
    // retryWithAck can re-fire the effect even when `target` is the
    // same string as before.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [target, navTick]);

  // Keep the surface API the same — callers still hand us a path string.
  // We depend on `data` (not `data?.home`) so React Compiler's inferred
  // dep matches the manual list — the body really only reads `data?.home`,
  // but the broader dep is fine since `data` only changes on navigation.
  const load = useCallback(
    (next?: string) => {
      // Intercept descent into a protected category we haven't yet
      // acked. Without this, the click would fire a fetch, the server
      // would bounce us with `needsAck`, and the modal would still go
      // up — but doing the check here avoids the round trip and keeps
      // the spinner from flashing while the user reads the modal.
      if (next && data?.home) {
        const cat = categorizeFromHome(next, data.home);
        if (cat && !acked.has(cat)) {
          setPendingTcc({ needsAck: true, category: cat, path: next });
          return;
        }
      }
      setLoading(true);
      setTarget(next);
    },
    [acked, data],
  );

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

  // Fire the OS notification once per modal-raise so a user on another
  // screen knows the picker is waiting on them. Effect-driven so the
  // notification matches the modal lifecycle exactly — not the click
  // that opened it (which we couldn't observe from here cleanly).
  useEffect(() => {
    if (pendingTcc) notifyTccHeadsUp(pendingTcc.category);
  }, [pendingTcc]);

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
                title={
                  e.protected
                    ? "macOS-protected — Claudius will ask before reading this folder"
                    : undefined
                }
                data-testid={e.protected ? "directory-picker-protected-entry" : undefined}
              >
                <Folder className="h-3.5 w-3.5 text-[var(--accent)]" />
                <span className="font-mono">{e.name}</span>
                {e.protected && (
                  <span className="ml-auto flex items-center gap-1 text-[10px] text-[var(--muted)]">
                    <Lock className="h-3 w-3" />
                    macOS-protected
                  </span>
                )}
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
      {pendingTcc && (
        <TccHeadsUpModal
          category={pendingTcc.category}
          onCancel={() => setPendingTcc(null)}
          onContinue={() => {
            // Persist the acknowledgment FIRST so the retry's effect
            // closure (which reads `ackedRef.current`) sees it. Mutating
            // ackedRef inline keeps the retry from racing the React
            // setState commit.
            const next = new Set(acked);
            next.add(pendingTcc.category);
            ackedRef.current = next;
            setAcked(next);
            persistAcked(next);
            const path = pendingTcc.path;
            setPendingTcc(null);
            setLoading(true);
            void retryWithAck(path);
          }}
        />
      )}
    </Overlay>
  );
}

/**
 * In-app heads-up shown BEFORE we issue the request that would trigger
 * macOS's own TCC permission dialog. Stacked above the picker's overlay
 * via z-index so its backdrop click doesn't bubble through to the
 * picker's own onClose. Continue records the user's acknowledgment in
 * localStorage and re-fires the fetch with `?ack=1`; Cancel dismisses
 * the prompt and leaves the picker on its previous listing.
 */
function TccHeadsUpModal({
  category,
  onCancel,
  onContinue,
}: {
  category: TccCategory;
  onCancel: () => void;
  onContinue: () => void;
}) {
  const copy = useMemo(() => tccHeadsUpCopy(category), [category]);
  useEffect(() => {
    function onKey(e: KeyboardEvent) {
      if (e.key === "Escape") onCancel();
      if (e.key === "Enter") onContinue();
    }
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onCancel, onContinue]);

  return (
    <div
      className="fixed inset-0 z-[60] flex items-start justify-center bg-black/70 px-4 pt-[14vh] backdrop-blur-sm"
      onClick={onCancel}
      data-testid="tcc-heads-up-modal"
    >
      <div
        onClick={(e) => e.stopPropagation()}
        className="w-[min(440px,92vw)] rounded-xl border border-[var(--border)] bg-[var(--panel)] shadow-2xl"
      >
        <div className="flex items-start gap-3 px-4 py-4">
          <Lock className="mt-0.5 h-5 w-5 shrink-0 text-[var(--accent)]" />
          <div className="min-w-0">
            <div className="text-sm font-medium">{copy.title}</div>
            <p className="mt-1.5 text-xs leading-relaxed text-[var(--muted)]">{copy.body}</p>
            <p className="mt-2 text-[11px] leading-relaxed text-[var(--muted)]/80">
              You can revoke access later in <span className="font-mono">System Settings → Privacy &amp; Security → Files and Folders</span>.
            </p>
          </div>
        </div>
        <div className="flex items-center justify-end gap-2 border-t border-[var(--border)] bg-[var(--panel-2)]/40 px-4 py-3">
          <button
            onClick={onCancel}
            className="rounded-md border border-[var(--border)] bg-[var(--panel-2)] px-3 py-1.5 text-xs hover:bg-[var(--panel)]"
            data-testid="tcc-heads-up-cancel"
          >
            Cancel
          </button>
          <button
            onClick={onContinue}
            className="rounded-md bg-[var(--accent)] px-3 py-1.5 text-xs text-white hover:opacity-90"
            data-testid="tcc-heads-up-continue"
            autoFocus
          >
            Continue
          </button>
        </div>
      </div>
    </div>
  );
}

/**
 * Client-side equivalent of `categorizeTccPath` from the shared module,
 * skipping the platform check. The server only marks entries
 * `protected: true` on darwin, so by the time this function sees a
 * "is this under a TCC category" question, the answer is only useful
 * when the runtime is darwin anyway — and we want non-darwin browsers
 * (rare but real, e.g. the dev next server hit from a Linux box) to
 * defer entirely to the server's `needsAck` signal, never showing the
 * modal prematurely.
 *
 * Returns the category name if `absPath` is `$HOME/<Cat>` or below,
 * otherwise `null`.
 */
function categorizeFromHome(absPath: string, home: string): TccCategory | null {
  if (!absPath || !home) return null;
  const normHome = home.endsWith("/") ? home.slice(0, -1) : home;
  const prefix = normHome + "/";
  if (!absPath.startsWith(prefix)) return null;
  const tail = absPath.slice(prefix.length);
  const firstSeg = tail.split("/")[0];
  if (!firstSeg) return null;
  const CATS: readonly TccCategory[] = [
    "Desktop",
    "Documents",
    "Downloads",
    "Movies",
    "Music",
    "Pictures",
  ];
  return (CATS as readonly string[]).includes(firstSeg) ? (firstSeg as TccCategory) : null;
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
