"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import {
  ArrowLeft,
  GitBranch,
  RefreshCw,
  Plus,
  Minus,
  Undo2,
  AlertTriangle,
  ArrowDownToLine,
  ArrowUpFromLine,
  CloudDownload,
  Sparkles,
} from "lucide-react";
import { SideNav } from "@/components/nav/SideNav";
import { ChangesList, type DiffSelection, type GroupKey } from "@/components/git/ChangesList";
import { DiffViewer } from "@/components/git/DiffViewer";
import { CommitBox } from "@/components/git/CommitBox";
import { BranchSwitcher, type BranchInfo } from "@/components/git/BranchSwitcher";
import { useWorkspaces } from "@/lib/client/useWorkspaces";
import { useGitStatus } from "@/lib/client/useGitStatus";
import { renderCommitPrefix } from "@/lib/shared/commit-prefix";

type DiffPayload = { diff: string; binary: boolean };

export default function GitPage() {
  const { items, activeId } = useWorkspaces();
  const active = items.find((w) => w.id === activeId);
  const wsId = active?.id ?? null;
  const router = useRouter();

  const { data, error: statusError, loading: statusLoading, refresh } = useGitStatus(wsId);

  // IntelliJ-style: rows have checkboxes, not just radios. The selection set
  // is the "what will get committed" set; ChangesList drives this.
  const [checked, setChecked] = useState<Set<string>>(new Set());
  const [selected, setSelected] = useState<DiffSelection | null>(null);
  const [diff, setDiff] = useState<DiffPayload | null>(null);
  const [diffLoading, setDiffLoading] = useState(false);
  const [diffError, setDiffError] = useState<string | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const [opError, setOpError] = useState<string | null>(null);
  const [collapsedGroups, setCollapsedGroups] = useState<Record<GroupKey, boolean>>({
    staged: false,
    unstaged: false,
    untracked: false,
  });

  // Drag-handle on the seam between the changes list and the diff pane.
  // Width persists in localStorage so the user's preferred size sticks
  // across reloads. Default matches the old hard-coded `w-80` (320px).
  const PANEL_WIDTH_KEY = "claudius.git.changesPanelWidth";
  const MIN_PANEL_WIDTH = 200;
  const MAX_PANEL_WIDTH = 720;
  const DEFAULT_PANEL_WIDTH = 320;
  const [panelWidth, setPanelWidth] = useState<number>(() => {
    if (typeof window === "undefined") return DEFAULT_PANEL_WIDTH;
    const raw = window.localStorage.getItem(PANEL_WIDTH_KEY);
    if (!raw) return DEFAULT_PANEL_WIDTH;
    const n = Number(raw);
    if (!Number.isFinite(n)) return DEFAULT_PANEL_WIDTH;
    return Math.min(MAX_PANEL_WIDTH, Math.max(MIN_PANEL_WIDTH, n));
  });
  const panelDragRef = useRef<{ startX: number; startW: number } | null>(null);
  const onPanelDragStart = (e: React.PointerEvent<HTMLDivElement>) => {
    e.preventDefault();
    panelDragRef.current = { startX: e.clientX, startW: panelWidth };
    e.currentTarget.setPointerCapture(e.pointerId);
  };
  const onPanelDragMove = (e: React.PointerEvent<HTMLDivElement>) => {
    const drag = panelDragRef.current;
    if (!drag) return;
    const next = Math.min(
      MAX_PANEL_WIDTH,
      Math.max(MIN_PANEL_WIDTH, drag.startW + (e.clientX - drag.startX)),
    );
    setPanelWidth(next);
  };
  const onPanelDragEnd = (e: React.PointerEvent<HTMLDivElement>) => {
    if (!panelDragRef.current) return;
    panelDragRef.current = null;
    e.currentTarget.releasePointerCapture(e.pointerId);
    if (typeof window !== "undefined") {
      window.localStorage.setItem(PANEL_WIDTH_KEY, String(panelWidth));
    }
  };
  const onPanelDragDoubleClick = () => {
    setPanelWidth(DEFAULT_PANEL_WIDTH);
    if (typeof window !== "undefined") {
      window.localStorage.setItem(PANEL_WIDTH_KEY, String(DEFAULT_PANEL_WIDTH));
    }
  };

  // Persisted commit-message draft. Loaded from /api/.../commit-draft on
  // mount (or on workspace switch) and threaded into CommitBox so the
  // generated message survives leaving and coming back.
  const [draftMessage, setDraftMessage] = useState<string>("");
  useEffect(() => {
    if (!wsId) {
      setDraftMessage("");
      return;
    }
    let cancelled = false;
    (async () => {
      try {
        const res = await fetch(`/api/workspaces/${wsId}/git/commit-draft`);
        if (!res.ok) return;
        const j = (await res.json().catch(() => ({}))) as { message?: string | null };
        if (!cancelled) setDraftMessage(j.message ?? "");
      } catch {
        // non-fatal; box opens empty
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [wsId]);

  const onPersistDraft = useCallback(
    async (message: string) => {
      if (!wsId) return;
      try {
        await fetch(`/api/workspaces/${wsId}/git/commit-draft`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ message }),
        });
        setDraftMessage(message);
      } catch {
        // non-fatal
      }
    },
    [wsId],
  );

  const onClearDraft = useCallback(async () => {
    if (!wsId) return;
    try {
      await fetch(`/api/workspaces/${wsId}/git/commit-draft`, { method: "DELETE" });
      setDraftMessage("");
    } catch {
      // non-fatal
    }
  }, [wsId]);

  // Keep `checked` in sync with the file list — drop stale entries when files
  // disappear (e.g. after a commit), but preserve user choices across a
  // routine status refresh.
  useEffect(() => {
    if (!data) return;
    const present = new Set(data.files.map((f) => f.path));
    setChecked((prev) => {
      let changed = false;
      const next = new Set<string>();
      for (const p of prev) {
        if (present.has(p)) next.add(p);
        else changed = true;
      }
      return changed ? next : prev;
    });
    // If selected file is no longer present, drop the diff view.
    setSelected((prev) => (prev && present.has(prev.path) ? prev : null));
  }, [data]);

  // Pull diff text whenever the selection changes.
  useEffect(() => {
    if (!wsId || !selected) {
      setDiff(null);
      return;
    }
    const ac = new AbortController();
    setDiffLoading(true);
    setDiffError(null);
    fetch(
      `/api/workspaces/${wsId}/git/diff?path=${encodeURIComponent(selected.path)}&mode=${selected.mode}`,
      { signal: ac.signal },
    )
      .then(async (res) => {
        if (!res.ok) {
          const j = (await res.json().catch(() => ({}))) as { error?: string };
          throw new Error(j.error ?? `HTTP ${res.status}`);
        }
        return (await res.json()) as DiffPayload;
      })
      .then((p) => setDiff(p))
      .catch((err) => {
        if ((err as { name?: string }).name === "AbortError") return;
        setDiffError(err instanceof Error ? err.message : String(err));
      })
      .finally(() => setDiffLoading(false));
    return () => ac.abort();
  }, [wsId, selected]);

  const onToggleCheck = useCallback((path: string, next: boolean) => {
    setChecked((prev) => {
      const out = new Set(prev);
      if (next) out.add(path);
      else out.delete(path);
      return out;
    });
  }, []);

  const onToggleAll = useCallback(
    (next: boolean) => {
      if (!data) return;
      if (next) setChecked(new Set(data.files.map((f) => f.path)));
      else setChecked(new Set());
    },
    [data],
  );

  const onToggleGroup = useCallback((g: GroupKey) => {
    setCollapsedGroups((prev) => ({ ...prev, [g]: !prev[g] }));
  }, []);

  /**
   * Push without a confirmation prompt. Used by the "Generate, Commit & Push"
   * button, which already asked once before kicking off the chain — adding
   * a second confirm here would be noise. Errors are returned to the caller
   * rather than rendered into the page-level `opError` bar, because the
   * combo button reports failures in its own inline error area.
   */
  async function runPushSilent(): Promise<{ ok: true } | { ok: false; error: string }> {
    if (!wsId) return { ok: false, error: "no workspace" };
    setBusy("push");
    try {
      const res = await fetch(`/api/workspaces/${wsId}/git/remote`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ op: "push" }),
      });
      if (!res.ok) {
        const j = (await res.json().catch(() => ({}))) as { error?: string };
        return { ok: false, error: j.error ?? `HTTP ${res.status}` };
      }
      await refresh();
      return { ok: true };
    } catch (err) {
      return { ok: false, error: err instanceof Error ? err.message : String(err) };
    } finally {
      setBusy(null);
    }
  }

  /**
   * Pull with merge; if conflicts surface, hand off to a fresh Claude Code
   * session pre-loaded with the conflict list. Unlike the plain Pull button
   * (`--ff-only`), this variant tolerates a real merge so Claude has
   * something to resolve.
   *
   * Pre-flight: refuses if the working tree is dirty. `git pull` would
   * refuse too, but our error here is friendlier than the raw stderr.
   *
   * Post-conflict navigation depends on the *active workspace* being set
   * correctly at navigation time — the new chat session resolves its cwd
   * from the cookie/active hint. Since this button only renders inside the
   * Git page (which only renders for an active workspace), that holds.
   */
  async function runPullWithClaude() {
    if (!wsId) return;
    if ((data?.files.length ?? 0) > 0) {
      setOpError(
        "Pull refused: you have local changes. Commit, stash, or rollback first.",
      );
      return;
    }
    const target = branchLabel ?? "current branch";
    if (
      !confirm(
        `Pull and merge upstream into ${target}? If conflicts arise, Claude Code will open in a new chat to resolve them.`,
      )
    )
      return;
    setBusy("pull");
    setOpError(null);
    try {
      const res = await fetch(`/api/workspaces/${wsId}/git/pull-merge`, {
        method: "POST",
      });
      if (res.ok) {
        await refresh();
        return;
      }
      const body = (await res.json().catch(() => ({}))) as {
        kind?: string;
        conflicts?: string[];
        message?: string;
        output?: string;
        error?: string;
      };
      if (body.kind === "conflicts" && Array.isArray(body.conflicts) && body.conflicts.length > 0) {
        // We deliberately do NOT abort the merge — the working tree is
        // mid-merge and Claude will resolve in place. The user finalizes
        // via the existing Commit flow once Claude has staged the fixes.
        await refresh();
        const fileLines = body.conflicts.map((p) => `- ${p}`).join("\n");
        const prompt = [
          `I just ran \`git pull\` in this workspace and there are merge conflicts in the following file(s):`,
          "",
          fileLines,
          "",
          "Please resolve them. For each file:",
          "  1. Read the file and find the conflict markers (<<<<<<<, =======, >>>>>>>).",
          "  2. Decide which side to keep — or how to combine — based on the intent of each change.",
          "  3. Remove the conflict markers and write the resolved content back.",
          "  4. Run `git add <file>` to mark it as resolved.",
          "",
          "Important constraints:",
          "  - Do NOT run `git merge --abort` or otherwise revert the pull.",
          "  - Do NOT run `git commit`. I will review the staged resolution and commit it myself in the Git UI.",
          "  - Stop once every conflicted file has been staged.",
        ].join("\n");
        if (
          confirm(
            `Open Claude Code to resolve ${body.conflicts.length} conflict${body.conflicts.length === 1 ? "" : "s"}?`,
          )
        ) {
          router.push(`/?new=1&prompt=${encodeURIComponent(prompt)}`);
        }
        return;
      }
      const message = body.message ?? body.error ?? `HTTP ${res.status}`;
      setOpError(message);
    } catch (err) {
      setOpError(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(null);
    }
  }

  async function runRemote(op: "fetch" | "pull" | "push") {
    if (!wsId) return;
    if (op === "push") {
      const ahead = data?.ahead ?? 0;
      const target = branchLabel ?? "current branch";
      const detail = ahead > 0 ? ` (${ahead} commit${ahead === 1 ? "" : "s"} ahead)` : "";
      if (!confirm(`Push ${target}${detail} to remote?`)) return;
    } else if (op === "pull") {
      const target = branchLabel ?? "current branch";
      if (!confirm(`Pull --ff-only into ${target}? This aborts on non-fast-forward.`)) return;
    }
    setBusy(op);
    setOpError(null);
    try {
      const res = await fetch(`/api/workspaces/${wsId}/git/remote`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ op }),
      });
      if (!res.ok) {
        const j = (await res.json().catch(() => ({}))) as { error?: string };
        throw new Error(j.error ?? `HTTP ${res.status}`);
      }
      await refresh();
    } catch (err) {
      setOpError(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(null);
    }
  }

  async function runStage(op: "stage" | "unstage" | "discard") {
    if (!wsId) return;
    const paths = Array.from(checked);
    if (paths.length === 0) {
      setOpError("Select at least one file first.");
      return;
    }
    if (op === "discard") {
      const msg = `Discard local changes in ${paths.length} file${paths.length === 1 ? "" : "s"}? This cannot be undone.`;
      if (!confirm(msg)) return;
    }
    setBusy(op);
    setOpError(null);
    try {
      const res = await fetch(`/api/workspaces/${wsId}/git/stage`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ paths, op }),
      });
      if (!res.ok) {
        const j = (await res.json().catch(() => ({}))) as { error?: string };
        throw new Error(j.error ?? `HTTP ${res.status}`);
      }
      await refresh();
    } catch (err) {
      setOpError(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(null);
    }
  }

  async function onGenerateMessage() {
    if (!wsId) return { ok: false as const, error: "no workspace" };
    const paths = Array.from(checked);
    if (paths.length === 0) return { ok: false as const, error: "select at least one file" };
    try {
      const res = await fetch(`/api/workspaces/${wsId}/git/commit-message`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ paths }),
      });
      const j = (await res.json().catch(() => ({}))) as { message?: string; error?: string };
      if (!res.ok) return { ok: false as const, error: j.error ?? `HTTP ${res.status}` };
      if (!j.message) return { ok: false as const, error: "empty response" };
      return { ok: true as const, message: j.message };
    } catch (err) {
      return { ok: false as const, error: err instanceof Error ? err.message : String(err) };
    }
  }

  async function onCommit(message: string) {
    if (!wsId) return { ok: false as const, error: "no workspace" };
    const paths = Array.from(checked);
    if (paths.length === 0) return { ok: false as const, error: "select at least one file" };
    setBusy("commit");
    try {
      const res = await fetch(`/api/workspaces/${wsId}/git/commit`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ message, stagePaths: paths }),
      });
      if (!res.ok) {
        const j = (await res.json().catch(() => ({}))) as { error?: string };
        return { ok: false as const, error: j.error ?? `HTTP ${res.status}` };
      }
      setChecked(new Set());
      setSelected(null);
      await refresh();
      return { ok: true as const };
    } finally {
      setBusy(null);
    }
  }

  const branchLabel = useMemo(() => {
    if (!data) return null;
    if (!data.isRepo) return null;
    if (data.branch) return data.branch;
    if (data.head) return `${data.head} (detached)`;
    return null;
  }, [data]);

  // Branch switcher wiring. The list endpoint is cheap (`git for-each-ref`),
  // so we re-fetch on every popover open rather than maintaining a cache —
  // keeps the list honest after fetch/checkout/etc.
  const loadBranches = useCallback(async (): Promise<BranchInfo[]> => {
    if (!wsId) return [];
    const res = await fetch(`/api/workspaces/${wsId}/git/branches`);
    if (!res.ok) {
      const j = (await res.json().catch(() => ({}))) as { error?: string };
      throw new Error(j.error ?? `HTTP ${res.status}`);
    }
    const j = (await res.json()) as { branches?: BranchInfo[] };
    return j.branches ?? [];
  }, [wsId]);

  const onCheckoutBranch = useCallback(
    async (name: string): Promise<{ ok: true } | { ok: false; error: string }> => {
      if (!wsId) return { ok: false, error: "no workspace" };
      // Block checkout while another op is in flight — committing to a half-
      // staged state across a branch switch is a great way to lose work.
      if (busy) return { ok: false, error: `busy: ${busy}` };
      setBusy("checkout");
      setOpError(null);
      try {
        const res = await fetch(`/api/workspaces/${wsId}/git/checkout`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ name }),
        });
        if (!res.ok) {
          const j = (await res.json().catch(() => ({}))) as { error?: string };
          return { ok: false, error: j.error ?? `HTTP ${res.status}` };
        }
        // File paths may not survive into the new branch — drop the diff
        // selection and the staging checkmarks. Then refresh git status so
        // branch label + changes list both repaint.
        setChecked(new Set());
        setSelected(null);
        await refresh();
        return { ok: true };
      } finally {
        setBusy(null);
      }
    },
    [wsId, busy, refresh],
  );

  const onCreateBranch = useCallback(
    async (
      name: string,
      startPoint?: string,
    ): Promise<{ ok: true } | { ok: false; error: string }> => {
      if (!wsId) return { ok: false, error: "no workspace" };
      if (busy) return { ok: false, error: `busy: ${busy}` };
      setBusy("checkout");
      setOpError(null);
      try {
        const res = await fetch(`/api/workspaces/${wsId}/git/checkout`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ name, create: true, startPoint }),
        });
        if (!res.ok) {
          const j = (await res.json().catch(() => ({}))) as { error?: string };
          return { ok: false, error: j.error ?? `HTTP ${res.status}` };
        }
        setChecked(new Set());
        setSelected(null);
        await refresh();
        return { ok: true };
      } finally {
        setBusy(null);
      }
    },
    [wsId, busy, refresh],
  );

  // Cheap pure call — no useMemo needed, React Compiler memoizes downstream.
  const commitPrefix = data?.isRepo
    ? renderCommitPrefix(data.branch ?? null, active?.commitPrefix)
    : null;

  const aheadBehind = useMemo(() => {
    if (!data || !data.isRepo) return null;
    const a = data.ahead ?? 0;
    const b = data.behind ?? 0;
    if (!a && !b) return null;
    return `↑${a} ↓${b}`;
  }, [data]);

  return (
    <div className="flex h-full">
      <SideNav running={false} />
      <main data-pane-name="git-main" className="flex h-full flex-1 flex-col overflow-hidden">
        <header className="flex h-9 shrink-0 items-center gap-3 border-b border-[var(--border)] bg-[var(--panel)] px-4 text-xs">
          <Link href="/" className="flex items-center gap-1 text-[var(--muted)] hover:text-[var(--foreground)]">
            <ArrowLeft className="h-3.5 w-3.5" /> Chat
          </Link>
          <span className="opacity-50">·</span>
          <GitBranch className="h-3.5 w-3.5 text-[var(--muted)]" />
          <span className="font-medium">Git</span>
          {active && <span className="font-mono text-[var(--muted)]">{active.rootPath}</span>}
          {data?.isRepo && (
            <>
              <span className="opacity-50">·</span>
              <BranchSwitcher
                current={branchLabel}
                detached={!data.branch && Boolean(data.head)}
                disabled={busy != null}
                loadBranches={loadBranches}
                onCheckout={onCheckoutBranch}
                onCreate={onCreateBranch}
              />
            </>
          )}
          {aheadBehind && (
            <span className="rounded bg-[var(--panel-2)] px-1.5 py-0.5 font-mono text-[10px] text-[var(--muted)]">
              {aheadBehind}
            </span>
          )}
          <div className="ml-auto flex items-center gap-1">
            <button
              type="button"
              onClick={() => void runRemote("fetch")}
              disabled={!wsId || busy != null || !data?.isRepo}
              title="git fetch --all --prune"
              className="flex h-6 items-center gap-1 rounded px-1.5 text-[var(--muted)] hover:bg-[var(--panel-2)] hover:text-[var(--foreground)] disabled:opacity-40"
            >
              <CloudDownload className="h-3 w-3" />
              <span className="text-[11px]">{busy === "fetch" ? "Fetching…" : "Fetch"}</span>
            </button>
            <button
              type="button"
              onClick={() => void runRemote("pull")}
              disabled={!wsId || busy != null || !data?.isRepo}
              title="git pull --ff-only"
              className="flex h-6 items-center gap-1 rounded px-1.5 text-[var(--muted)] hover:bg-[var(--panel-2)] hover:text-[var(--foreground)] disabled:opacity-40"
            >
              <ArrowDownToLine className="h-3 w-3" />
              <span className="text-[11px]">{busy === "pull" ? "Pulling…" : "Pull"}</span>
            </button>
            <button
              type="button"
              onClick={() => void runPullWithClaude()}
              disabled={!wsId || busy != null || !data?.isRepo}
              title="git pull (merge). On conflicts, opens Claude Code to resolve."
              data-testid="pull-with-claude-button"
              className="flex h-6 items-center gap-1 rounded px-1.5 text-[var(--muted)] hover:bg-[var(--panel-2)] hover:text-[var(--foreground)] disabled:opacity-40"
            >
              <Sparkles className="h-3 w-3" />
              <ArrowDownToLine className="h-3 w-3" />
              <span className="text-[11px]">
                {busy === "pull" ? "Pulling…" : "Pull + resolve"}
              </span>
            </button>
            <button
              type="button"
              onClick={() => void runRemote("push")}
              disabled={!wsId || busy != null || !data?.isRepo}
              title="git push (auto-set-upstream when needed)"
              className="flex h-6 items-center gap-1 rounded px-1.5 text-[var(--muted)] hover:bg-[var(--panel-2)] hover:text-[var(--foreground)] disabled:opacity-40"
            >
              <ArrowUpFromLine className="h-3 w-3" />
              <span className="text-[11px]">{busy === "push" ? "Pushing…" : "Push"}</span>
            </button>
            <span className="mx-1 h-3 w-px bg-[var(--border)]" aria-hidden />
            <button
              type="button"
              onClick={() => void runStage("stage")}
              disabled={!wsId || busy != null || checked.size === 0}
              title="Stage selected"
              className="flex h-6 items-center gap-1 rounded px-1.5 text-[var(--muted)] hover:bg-[var(--panel-2)] hover:text-[var(--foreground)] disabled:opacity-40"
            >
              <Plus className="h-3 w-3" />
              <span className="text-[11px]">Stage</span>
            </button>
            <button
              type="button"
              onClick={() => void runStage("unstage")}
              disabled={!wsId || busy != null || checked.size === 0}
              title="Unstage selected"
              className="flex h-6 items-center gap-1 rounded px-1.5 text-[var(--muted)] hover:bg-[var(--panel-2)] hover:text-[var(--foreground)] disabled:opacity-40"
            >
              <Minus className="h-3 w-3" />
              <span className="text-[11px]">Unstage</span>
            </button>
            <button
              type="button"
              onClick={() => void runStage("discard")}
              disabled={!wsId || busy != null || checked.size === 0}
              title="Discard local changes (rollback)"
              className="flex h-6 items-center gap-1 rounded px-1.5 text-red-300 hover:bg-red-500/15 disabled:opacity-40"
            >
              <Undo2 className="h-3 w-3" />
              <span className="text-[11px]">Rollback</span>
            </button>
            <button
              type="button"
              onClick={() => void refresh()}
              disabled={!wsId || statusLoading}
              title="Refresh"
              className="flex h-6 w-6 items-center justify-center rounded text-[var(--muted)] hover:bg-[var(--panel-2)] hover:text-[var(--foreground)] disabled:opacity-40"
            >
              <RefreshCw className={statusLoading ? "h-3.5 w-3.5 animate-spin" : "h-3.5 w-3.5"} />
            </button>
          </div>
        </header>
        {(statusError || opError) && (
          <div className="flex items-center gap-2 border-b border-red-500/30 bg-red-500/10 px-3 py-1 text-[11px] text-red-300">
            <AlertTriangle className="h-3 w-3" />
            <span>{statusError ?? opError}</span>
          </div>
        )}
        <div className="flex flex-1 overflow-hidden">
          <aside
            className="flex shrink-0 flex-col border-r border-[var(--border)]"
            style={{ width: panelWidth }}
          >
            <div className="flex-1 overflow-y-auto scroll-thin">
              {!active ? (
                <div className="px-4 py-12 text-center text-sm text-[var(--muted)]">No active workspace.</div>
              ) : !data ? (
                <div className="px-4 py-12 text-center text-sm text-[var(--muted)]">Loading…</div>
              ) : !data.isRepo ? (
                <div className="px-4 py-12 text-center text-sm text-[var(--muted)]">
                  This workspace isn&apos;t a git repository.
                </div>
              ) : (
                <ChangesList
                  files={data.files}
                  selected={selected}
                  onSelect={setSelected}
                  checked={checked}
                  onToggleCheck={onToggleCheck}
                  onToggleAll={onToggleAll}
                  collapsedGroups={collapsedGroups}
                  onToggleGroup={onToggleGroup}
                  onRefresh={() => void refresh()}
                  refreshing={statusLoading}
                />
              )}
            </div>
            <CommitBox
              checkedCount={checked.size}
              busy={busy === "commit"}
              branchLabel={branchLabel}
              onCommit={onCommit}
              onGenerate={onGenerateMessage}
              onPush={runPushSilent}
              initialMessage={draftMessage}
              draftKey={wsId ?? ""}
              onPersistDraft={onPersistDraft}
              onClearDraft={onClearDraft}
              prefix={commitPrefix}
            />
          </aside>
          {/* Drag handle: grab to resize, double-click to reset to default. */}
          <div
            role="separator"
            aria-orientation="vertical"
            aria-label="Resize changes panel"
            data-testid="git-panel-resizer"
            onPointerDown={onPanelDragStart}
            onPointerMove={onPanelDragMove}
            onPointerUp={onPanelDragEnd}
            onPointerCancel={onPanelDragEnd}
            onDoubleClick={onPanelDragDoubleClick}
            className="group relative w-1 shrink-0 cursor-col-resize select-none bg-transparent hover:bg-[var(--accent)]/30"
          >
            {/* Wider invisible hit-target so the handle is easy to grab even
                when the visible seam is 1px wide. */}
            <span className="absolute inset-y-0 -left-1 -right-1" />
          </div>
          <section className="flex flex-1 flex-col overflow-hidden">
            {!selected ? (
              <div className="flex flex-1 items-center justify-center text-sm text-[var(--muted)]">
                Pick a changed file to see the diff.
              </div>
            ) : (
              <>
                <div className="flex h-9 shrink-0 items-center gap-2 border-b border-[var(--border)] bg-[var(--panel-2)]/40 px-3 text-xs">
                  <span className="truncate font-mono">{selected.path}</span>
                  <span className="rounded bg-[var(--panel)] px-1.5 py-0.5 text-[10px] text-[var(--muted)]">
                    {selected.mode === "staged"
                      ? "Staged · HEAD → index"
                      : selected.mode === "untracked"
                      ? "Untracked · /dev/null → working"
                      : "Unstaged · index → working"}
                  </span>
                </div>
                <DiffViewer
                  diff={diff?.diff ?? ""}
                  binary={diff?.binary ?? false}
                  loading={diffLoading}
                  error={diffError}
                />
              </>
            )}
          </section>
        </div>
      </main>
    </div>
  );
}
