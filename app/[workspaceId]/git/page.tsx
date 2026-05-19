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
import {
  ChangesList,
  isPartialStage,
  type DiffSelection,
  type GroupKey,
} from "@/components/git/ChangesList";
import { DiffViewer } from "@/components/git/DiffViewer";
import { FileEditor } from "@/components/git/FileEditor";
import { CommitBox } from "@/components/git/CommitBox";
import { BranchSwitcher, type BranchInfo } from "@/components/git/BranchSwitcher";
import { GitConsole, type GitConsoleEntry } from "@/components/git/GitConsole";
import { useWorkspaces } from "@/lib/client/useWorkspaces";
import { useGitStatus } from "@/lib/client/useGitStatus";
import { renderCommitPrefix } from "@/lib/shared/commit-prefix";
import { cn } from "@/lib/utils/cn";

type DiffPayload = { diff: string; binary: boolean };

/**
 * Git subcommands that can change the working tree, index, HEAD, or refs —
 * i.e. things that should trigger a status refresh after they run in the
 * console. Read-only commands (`log`, `diff`, `status`, `show`, `blame`,
 * `branch -v`, …) are deliberately omitted: refreshing on those churns the
 * file list under the user's cursor for no reason.
 *
 * Subcommand alone is checked — flag-based reads like `git branch -d <x>`
 * still trigger a refresh because `branch` is in the set. False positives
 * (an extra status call) are cheap; false negatives (stale file list after
 * a real change) are confusing.
 */
const MUTATING_GIT_SUBCOMMANDS = new Set([
  "add",
  "am",
  "apply",
  "branch", // create/delete/rename
  "checkout",
  "cherry-pick",
  "clean",
  "clone", // unlikely in-workspace but harmless
  "commit",
  "fetch",
  "merge",
  "mv",
  "pull",
  "push", // doesn't touch local state, but the badge counts change
  "rebase",
  "reset",
  "restore",
  "revert",
  "rm",
  "stash",
  "submodule",
  "switch",
  "tag",
  "worktree",
]);

/** Mirror of server's DEFAULT_TIMEOUT_MS in `lib/server/shell.ts`, in seconds. */
const SHELL_TIMEOUT_SEC = 120;

/**
 * Squash a raw git stderr (which may include the multi-line output of a
 * pre-commit hook) down to a single one-liner suitable for an inline error
 * banner. The full text still goes to the console via `pushConsoleEntry`;
 * this is for the short version returned to UI callers like CommitBox and
 * BranchSwitcher whose error rows can't absorb 10KB of lint output.
 */
function summarizeGitError(input: string): string {
  const cleaned = input
    .replace(/^git [\w-]+(?: [\w-]+)* exited -?\d+:\s*/, "")
    .trim();
  const first =
    cleaned
      .split(/\r?\n/)
      .map((l) => l.trim())
      .find((l) => l.length > 0) ?? cleaned;
  return first.length > 200 ? `${first.slice(0, 200)}…` : first;
}

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
  /**
   * Right-pane layout: false = unified editor (IntelliJ "Current version"
   * style — the editor IS the diff view), true = side-by-side (old left,
   * current right). Defaults to split view because it matches the IntelliJ
   * workflow the page is modeled after. Persisted to localStorage so the
   * user's explicit preference (either direction) sticks across reloads.
   */
  const SPLIT_MODE_KEY = "claudius.git.splitMode";
  const [splitMode, setSplitMode] = useState<boolean>(() => {
    // SSR fall-through and first-time visitors get the new default (split).
    // Existing entries are respected so users who explicitly toggled to
    // unified ("0") aren't surprised by a flip on the next reload.
    if (typeof window === "undefined") return true;
    const stored = window.localStorage.getItem(SPLIT_MODE_KEY);
    if (stored == null) return true;
    return stored === "1";
  });
  useEffect(() => {
    if (typeof window === "undefined") return;
    window.localStorage.setItem(SPLIT_MODE_KEY, splitMode ? "1" : "0");
  }, [splitMode]);

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

  // Console state — IntelliJ-style bottom panel that captures the output of
  // every git operation triggered from this page. Keeps the error banner
  // short (just the first line) so a 10KB hook failure doesn't blow out the
  // layout; the full text lives here, scrollable.
  const CONSOLE_OPEN_KEY = "claudius.git.consoleOpen";
  const CONSOLE_HEIGHT_KEY = "claudius.git.consoleHeight";
  const CONSOLE_MIN = 80;
  const CONSOLE_MAX = 600;
  const CONSOLE_DEFAULT = 200;
  const CONSOLE_MAX_ENTRIES = 200;
  const CONSOLE_MAX_OUTPUT_CHARS = 8000;
  const [consoleEntries, setConsoleEntries] = useState<GitConsoleEntry[]>([]);
  const [consoleOpen, setConsoleOpen] = useState<boolean>(() => {
    if (typeof window === "undefined") return false;
    return window.localStorage.getItem(CONSOLE_OPEN_KEY) === "1";
  });
  const [consoleHeight, setConsoleHeight] = useState<number>(() => {
    if (typeof window === "undefined") return CONSOLE_DEFAULT;
    const raw = window.localStorage.getItem(CONSOLE_HEIGHT_KEY);
    if (!raw) return CONSOLE_DEFAULT;
    const n = Number(raw);
    if (!Number.isFinite(n)) return CONSOLE_DEFAULT;
    return Math.min(CONSOLE_MAX, Math.max(CONSOLE_MIN, n));
  });
  useEffect(() => {
    if (typeof window === "undefined") return;
    window.localStorage.setItem(CONSOLE_OPEN_KEY, consoleOpen ? "1" : "0");
  }, [consoleOpen]);
  useEffect(() => {
    if (typeof window === "undefined") return;
    window.localStorage.setItem(CONSOLE_HEIGHT_KEY, String(consoleHeight));
  }, [consoleHeight]);

  const consoleCwd = active?.rootPath ?? null;

  /**
   * Push an entry into the console. Three responsibilities:
   *  - strip the `git <verb> exited <code>: ` prefix that `GitFailure`
   *    formats into stderr — the row already labels the command, so we'd
   *    otherwise double-print it on every error.
   *  - cap output length so one 10KB lint failure doesn't tank the panel.
   *  - auto-open on error so the user notices.
   */
  // Kept memoized: this is consumed as a `useCallback` dependency by
  // `onCheckoutBranch` and `onCreateBranch`. Letting the compiler skip
  // optimization here is preferable to dropping the wrapper, which would
  // recreate those downstream callbacks (and anything bound through them)
  // on every render. The compiler reports it can't preserve the memo
  // because `consoleCwd` "may be mutated later" — but in practice it's
  // derived from props each render and only changes when the workspace
  // does. Suppressing keeps the existing semantics intact.
  const pushConsoleEntry = useCallback(
    // eslint-disable-next-line react-hooks/preserve-manual-memoization
    (input: { command: string; status: "ok" | "error" | "info"; output: string }) => {
      const cleaned = input.output
        // Drop the prefix added by GitFailure ("git commit exited 1: …").
        .replace(/^git [\w-]+(?: [\w-]+)* exited -?\d+:\s*/, "")
        .trimEnd();
      const capped =
        cleaned.length > CONSOLE_MAX_OUTPUT_CHARS
          ? cleaned.slice(0, CONSOLE_MAX_OUTPUT_CHARS) +
            `\n… ${cleaned.length - CONSOLE_MAX_OUTPUT_CHARS} more chars omitted`
          : cleaned;
      const entry: GitConsoleEntry = {
        id: `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
        timestamp: Date.now(),
        cwd: consoleCwd,
        command: input.command,
        status: input.status,
        output: capped,
      };
      setConsoleEntries((prev) =>
        prev.length >= CONSOLE_MAX_ENTRIES
          ? [...prev.slice(prev.length - CONSOLE_MAX_ENTRIES + 1), entry]
          : [...prev, entry],
      );
      if (input.status === "error") setConsoleOpen(true);
    },
    // eslint-disable-next-line react-hooks/preserve-manual-memoization
    [consoleCwd],
  );

  // Persisted commit-message draft. Loaded from /api/.../commit-draft on
  // mount (or on workspace switch) and threaded into CommitBox so the
  // generated message survives leaving and coming back.
  //
  // The "no workspace" reset is done render-phase via the "store previous
  // props" pattern so we don't fire setState synchronously inside the
  // effect body (React 19 prefers this — see
  // https://react.dev/reference/react/useState#storing-information-from-previous-renders).
  // The effect itself only runs the fetch when there *is* a workspace,
  // and pushes its result through `.then` / `.catch` callbacks so no
  // setState happens in the effect body either.
  const [draftMessage, setDraftMessage] = useState<string>("");
  const [lastDraftWsId, setLastDraftWsId] = useState<string | null>(wsId);
  if (lastDraftWsId !== wsId) {
    setLastDraftWsId(wsId);
    setDraftMessage("");
  }
  useEffect(() => {
    if (!wsId) return;
    const controller = new AbortController();
    fetch(`/api/workspaces/${wsId}/git/commit-draft`, { signal: controller.signal })
      .then(async (res) => {
        if (!res.ok) return null;
        return (await res.json().catch(() => ({}))) as { message?: string | null };
      })
      .then((j) => {
        if (!j) return;
        setDraftMessage(j.message ?? "");
      })
      .catch((err: unknown) => {
        if (err instanceof DOMException && err.name === "AbortError") return;
        // non-fatal; box opens empty
      });
    return () => controller.abort();
  }, [wsId]);

  const onPersistDraft = async (message: string) => {
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
  };

  const onClearDraft = async () => {
    if (!wsId) return;
    try {
      await fetch(`/api/workspaces/${wsId}/git/commit-draft`, { method: "DELETE" });
      setDraftMessage("");
    } catch {
      // non-fatal
    }
  };

  // Keep `checked` in sync with the file list — drop stale entries when files
  // disappear (e.g. after a commit), but preserve user choices across a
  // routine status refresh. Done render-phase via the "store previous props"
  // pattern (keyed on `data` identity) rather than a `useEffect`, so we don't
  // fire setState synchronously inside an effect body.
  // https://react.dev/reference/react/useState#storing-information-from-previous-renders
  const [lastData, setLastData] = useState(data);
  if (lastData !== data) {
    setLastData(data);
    if (data) {
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
    }
  }

  // Pull diff text whenever the selection changes. The synchronous setup
  // (reset the previous diff/error, flip loading on) runs render-phase via
  // the "store previous props" pattern so we don't fire setState
  // synchronously inside the effect body. The effect itself only kicks off
  // the async fetch, and all of *its* setStates run inside `.then` /
  // `.catch` / `.finally` callbacks. The `AbortController` cleanup is what
  // guarantees race-safety when the user rapidly clicks between files.
  // https://react.dev/reference/react/useState#storing-information-from-previous-renders
  const diffKey = wsId && selected ? `${wsId}|${selected.path}|${selected.mode}` : "";
  const [lastDiffKey, setLastDiffKey] = useState(diffKey);
  if (lastDiffKey !== diffKey) {
    setLastDiffKey(diffKey);
    setDiff(null);
    setDiffError(null);
    setDiffLoading(Boolean(diffKey));
  }
  useEffect(() => {
    if (!wsId || !selected) return;
    const ac = new AbortController();
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
      .catch((err: unknown) => {
        if (err instanceof DOMException && err.name === "AbortError") return;
        setDiffError(err instanceof Error ? err.message : String(err));
      })
      .finally(() => {
        if (!ac.signal.aborted) setDiffLoading(false);
      });
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
        const raw = j.error ?? `HTTP ${res.status}`;
        pushConsoleEntry({ command: "git push", status: "error", output: raw });
        return { ok: false, error: summarizeGitError(raw) };
      }
      const j = (await res.json().catch(() => ({}))) as { output?: string };
      pushConsoleEntry({ command: "git push", status: "ok", output: j.output ?? "" });
      await refresh();
      return { ok: true };
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      pushConsoleEntry({ command: "git push", status: "error", output: msg });
      return { ok: false, error: summarizeGitError(msg) };
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
        const j = (await res.json().catch(() => ({}))) as { output?: string };
        pushConsoleEntry({
          command: "git pull (merge)",
          status: "ok",
          output: j.output ?? "",
        });
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
        pushConsoleEntry({
          command: "git pull (merge)",
          status: "error",
          output: `Conflicts in ${body.conflicts.length} file(s):\n${body.conflicts.map((p) => `  ${p}`).join("\n")}${body.output ? `\n\n${body.output}` : ""}`,
        });
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
      pushConsoleEntry({
        command: "git pull (merge)",
        status: "error",
        output: body.output ? `${message}\n\n${body.output}` : message,
      });
      setOpError(message);
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      pushConsoleEntry({ command: "git pull (merge)", status: "error", output: msg });
      setOpError(msg);
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
        const msg = j.error ?? `HTTP ${res.status}`;
        pushConsoleEntry({ command: `git ${op}`, status: "error", output: msg });
        throw new Error(msg);
      }
      const j = (await res.json().catch(() => ({}))) as { output?: string };
      pushConsoleEntry({ command: `git ${op}`, status: "ok", output: j.output ?? "" });
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
        const msg = j.error ?? `HTTP ${res.status}`;
        pushConsoleEntry({ command: `git ${op}`, status: "error", output: msg });
        throw new Error(msg);
      }
      // Stage/unstage successes are noisy and produce no output — skip those.
      // Discard (destructive) gets a confirmation entry so the action is
      // traceable when the user wonders where their changes went.
      if (op === "discard") {
        pushConsoleEntry({
          command: "git discard",
          status: "ok",
          output: `Discarded changes in ${paths.length} file${paths.length === 1 ? "" : "s"}:\n${paths.map((p) => `  ${p}`).join("\n")}`,
        });
      }
      await refresh();
    } catch (err) {
      setOpError(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(null);
    }
  }

  /**
   * Per-row delete: routes the single path through the same `discard` op as
   * the bulk Rollback button. For untracked files that's an `rm`; for tracked
   * files it restores HEAD (i.e. removes the change from the list). We track
   * `deletingPath` separately from `busy` so other actions (commit, stage,
   * push) don't get globally disabled by a per-row spinner — but we still
   * gate against `busy` so the user can't fire a delete on top of a commit.
   */
  const [deletingPath, setDeletingPath] = useState<string | null>(null);
  // Kept memoized: this is consumed as a `useEffect` dependency by the
  // Delete-key shortcut below. Identity matters there — dropping the
  // wrapper would re-attach the window `keydown` listener on every
  // render, which is both wasteful and racy (a Delete keystroke landing
  // between teardown and re-attach would be lost). The compiler can't
  // preserve the memo because most of the deps "may be mutated later",
  // but they're all derived state we explicitly want to capture.
  /**
   * Per-row REVERT — restores a tracked file to its HEAD content (or, for
   * untracked rows, deletes it via `clean -fd`, which is what the `discard`
   * op does on the unbucketed path). No confirm prompt; the user explicitly
   * asked for this to feel "git-level," not "modal-level."
   *
   * Naming: this used to be `runDeleteSingle` but the trash-icon split now
   * has a separate `runRemoveSingle` for actual deletion. Splitting the
   * names makes it harder to wire the wrong one to the wrong button.
   */
  const runRevertSingle = useCallback(
    // eslint-disable-next-line react-hooks/preserve-manual-memoization
    async (path: string) => {
      if (!wsId) return;
      if (busy || deletingPath) return;
      setDeletingPath(path);
      setOpError(null);
      try {
        const res = await fetch(`/api/workspaces/${wsId}/git/stage`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ paths: [path], op: "discard" }),
        });
        if (!res.ok) {
          const j = (await res.json().catch(() => ({}))) as { error?: string };
          const msg = j.error ?? `HTTP ${res.status}`;
          pushConsoleEntry({
            command: `git discard ${path}`,
            status: "error",
            output: msg,
          });
          throw new Error(msg);
        }
        pushConsoleEntry({
          command: "git discard",
          status: "ok",
          output: `Reverted: ${path}`,
        });
        await refresh();
      } catch (err) {
        setOpError(err instanceof Error ? err.message : String(err));
      } finally {
        setDeletingPath(null);
      }
    },
    // eslint-disable-next-line react-hooks/preserve-manual-memoization
    [wsId, busy, deletingPath, refresh, pushConsoleEntry],
  );

  /**
   * Per-row DELETE — actually removes the file. For tracked files we run
   * `git rm -f` (deletion is staged, ready to commit); for untracked we
   * `fs.unlink`. Both are unrecoverable from the UI, so this one DOES
   * confirm — the friction is appropriate for "the file is going away."
   */
  const runRemoveSingle = useCallback(
    // eslint-disable-next-line react-hooks/preserve-manual-memoization
    async (path: string) => {
      if (!wsId) return;
      if (busy || deletingPath) return;
      const file = data?.files.find((f) => f.path === path);
      const isUntracked = file?.untracked ?? false;
      const msg = isUntracked
        ? `Delete ${path} from disk? This cannot be undone.`
        : `Delete ${path}? Runs \`git rm\` — stages the deletion, ready to commit.`;
      if (!confirm(msg)) return;
      setDeletingPath(path);
      setOpError(null);
      try {
        const res = await fetch(`/api/workspaces/${wsId}/git/stage`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ paths: [path], op: "remove" }),
        });
        if (!res.ok) {
          const j = (await res.json().catch(() => ({}))) as { error?: string };
          const errMsg = j.error ?? `HTTP ${res.status}`;
          pushConsoleEntry({
            command: `git remove ${path}`,
            status: "error",
            output: errMsg,
          });
          throw new Error(errMsg);
        }
        pushConsoleEntry({
          command: "git remove",
          status: "ok",
          output: isUntracked ? `Deleted untracked file: ${path}` : `git rm: ${path}`,
        });
        await refresh();
      } catch (err) {
        setOpError(err instanceof Error ? err.message : String(err));
      } finally {
        setDeletingPath(null);
      }
    },
    // eslint-disable-next-line react-hooks/preserve-manual-memoization
    [wsId, busy, deletingPath, data, refresh, pushConsoleEntry],
  );

  // Delete-key shortcut: when a file is selected and the focus isn't in an
  // editable element (commit box, branch popover, etc.), Delete or Backspace
  // routes through the same per-row DELETE as the trash icon (not revert —
  // Delete-key conventionally means "remove the thing," and runRemoveSingle
  // also shows a confirm prompt so accidental presses are recoverable).
  useEffect(() => {
    if (!selected) return;
    const sel = selected;
    function onKey(e: KeyboardEvent) {
      if (e.key !== "Delete" && e.key !== "Backspace") return;
      if (e.metaKey || e.ctrlKey || e.altKey || e.shiftKey) return;
      const target = e.target as HTMLElement | null;
      if (target) {
        const tag = target.tagName;
        if (tag === "INPUT" || tag === "TEXTAREA" || tag === "SELECT") return;
        if (target.isContentEditable) return;
      }
      e.preventDefault();
      void runRemoveSingle(sel.path);
    }
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [selected, runRemoveSingle]);

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
        const raw = j.error ?? `HTTP ${res.status}`;
        pushConsoleEntry({ command: "git commit", status: "error", output: raw });
        // Return a short one-liner — CommitBox renders this inline in a
        // fixed-width column where a 10KB hook stderr would balloon the box.
        return { ok: false as const, error: summarizeGitError(raw) };
      }
      const j = (await res.json().catch(() => ({}))) as { sha?: string; subject?: string };
      const sha = (j.sha ?? "").slice(0, 7);
      pushConsoleEntry({
        command: "git commit",
        status: "ok",
        output: sha ? `[${sha}] ${j.subject ?? ""}` : (j.subject ?? ""),
      });
      setChecked(new Set());
      setSelected(null);
      await refresh();
      return { ok: true as const };
    } finally {
      setBusy(null);
    }
  }

  /**
   * Run an arbitrary shell command typed into the console prompt. Handed
   * straight to bash on the server (`execShellCommand`), so pipes,
   * redirects, command chaining, env-var expansion, etc. all work.
   *
   * Status mapping:
   *   - exitCode 0      → "ok"
   *   - signal non-null → "error" + a timeout hint (we SIGTERM at the
   *                       SHELL_TIMEOUT_SEC mark)
   *   - other non-zero  → "error"
   *
   * Refresh policy: we only re-pull git status when the command's first
   * token is `git` and its subcommand is in `MUTATING_GIT_SUBCOMMANDS`.
   * Arbitrary commands could touch tracked files (a Makefile target, a
   * `bun run codegen`, etc.) but the console can't reliably detect that
   * — auto-refreshing on every command churns the file list under the
   * user's cursor. The header's Refresh button is right there if needed.
   */
  const runConsoleCommand = useCallback(
    async (rawCommand: string) => {
      if (!wsId) return;
      const trimmed = rawCommand.trim();
      // Cheap whitespace tokenizer just to detect a `git <subcommand>`
      // prefix for refresh-eligibility. This intentionally doesn't honour
      // quoting — a user who writes `"git" merge x` is on their own; the
      // failure mode is "no auto refresh," not a crash.
      const [first, second] = trimmed.split(/\s+/);
      const mutatesGit =
        first === "git" && second != null && MUTATING_GIT_SUBCOMMANDS.has(second);
      try {
        const res = await fetch(`/api/workspaces/${wsId}/shell`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ command: trimmed }),
        });
        if (!res.ok) {
          const j = (await res.json().catch(() => ({}))) as { error?: string };
          pushConsoleEntry({
            command: trimmed,
            status: "error",
            output: j.error ?? `HTTP ${res.status}`,
          });
          return;
        }
        const j = (await res.json()) as {
          stdout?: string;
          stderr?: string;
          truncated?: boolean;
          exitCode?: number;
          signal?: string | null;
        };
        const out = [j.stdout ?? "", j.stderr ?? ""].filter((s) => s).join("\n").trimEnd();
        const timedOut = j.signal != null;
        const banner =
          (timedOut ? `(timed out after ${SHELL_TIMEOUT_SEC}s — killed by ${j.signal})\n` : "") +
          (j.truncated ? `(output truncated — ran past the 16 MB cap)\n` : "");
        pushConsoleEntry({
          command: trimmed,
          status: j.exitCode === 0 ? "ok" : "error",
          output:
            banner + (out || (j.exitCode === 0 ? "(no output)" : `exit ${j.exitCode}`)),
        });
      } catch (err) {
        pushConsoleEntry({
          command: trimmed,
          status: "error",
          output: err instanceof Error ? err.message : String(err),
        });
      } finally {
        if (mutatesGit) await refresh();
      }
    },
    [wsId, refresh, pushConsoleEntry],
  );

  const branchLabel = (() => {
    if (!data) return null;
    if (!data.isRepo) return null;
    if (data.branch) return data.branch;
    if (data.head) return `${data.head} (detached)`;
    return null;
  })();

  // Branch switcher wiring. The list endpoint is cheap (`git for-each-ref`),
  // so we re-fetch on every popover open rather than maintaining a cache —
  // keeps the list honest after fetch/checkout/etc.
  const loadBranches = async (): Promise<BranchInfo[]> => {
    if (!wsId) return [];
    const res = await fetch(`/api/workspaces/${wsId}/git/branches`);
    if (!res.ok) {
      const j = (await res.json().catch(() => ({}))) as { error?: string };
      throw new Error(j.error ?? `HTTP ${res.status}`);
    }
    const j = (await res.json()) as { branches?: BranchInfo[] };
    return j.branches ?? [];
  };

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
          const raw = j.error ?? `HTTP ${res.status}`;
          pushConsoleEntry({
            command: `git checkout ${name}`,
            status: "error",
            output: raw,
          });
          return { ok: false, error: summarizeGitError(raw) };
        }
        pushConsoleEntry({
          command: `git checkout ${name}`,
          status: "ok",
          output: `Switched to branch '${name}'`,
        });
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
    [wsId, busy, refresh, pushConsoleEntry],
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
          const raw = j.error ?? `HTTP ${res.status}`;
          pushConsoleEntry({
            command: `git checkout -b ${name}`,
            status: "error",
            output: raw,
          });
          return { ok: false, error: summarizeGitError(raw) };
        }
        pushConsoleEntry({
          command: `git checkout -b ${name}`,
          status: "ok",
          output: startPoint
            ? `Created and switched to '${name}' from '${startPoint}'`
            : `Created and switched to '${name}'`,
        });
        setChecked(new Set());
        setSelected(null);
        await refresh();
        return { ok: true };
      } finally {
        setBusy(null);
      }
    },
    [wsId, busy, refresh, pushConsoleEntry],
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

  const aheadCount = data?.isRepo ? data.ahead ?? 0 : 0;
  const behindCount = data?.isRepo ? data.behind ?? 0 : 0;

  /**
   * Does the *selected* file need a diff-mode toggle? True for partial-stage
   * (`AM` / `MM` / `MD` / …) and for `AD` (the latter is hidden from the
   * list but reachable if something else routes selection to it — defensive).
   * Lifted out of the JSX so we don't run `data.files.find` on every render
   * of the diff pane, and so the JSX stays scannable.
   */
  const selectedNeedsModeToggle = useMemo(() => {
    if (!selected || selected.mode === "untracked" || !data) return false;
    const f = data.files.find((x) => x.path === selected.path);
    if (!f) return false;
    const isAD = f.index === "A" && f.worktree === "D";
    return isPartialStage(f) || isAD;
  }, [selected, data]);

  /**
   * Is the selected file editable? False when the file no longer exists
   * on disk — a `D` worktree status means there's nothing for the editor
   * to load. (`AD` files are already filtered out by groupFiles, so we
   * only have to gate on plain `D` here.) The right pane falls back to a
   * read-only diff for these.
   */
  const selectedCanEdit = useMemo(() => {
    if (!selected || !data) return false;
    const f = data.files.find((x) => x.path === selected.path);
    if (!f) return false;
    if (f.worktree === "D") return false;
    return true;
  }, [selected, data]);

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
              title={
                behindCount > 0
                  ? `git pull --ff-only · ${behindCount} commit${behindCount === 1 ? "" : "s"} behind`
                  : "git pull --ff-only"
              }
              className="flex h-6 items-center gap-1 rounded px-1.5 text-[var(--muted)] hover:bg-[var(--panel-2)] hover:text-[var(--foreground)] disabled:opacity-40"
            >
              <ArrowDownToLine className="h-3 w-3" />
              <span className="text-[11px]">{busy === "pull" ? "Pulling…" : "Pull"}</span>
              {behindCount > 0 && (
                <span
                  data-testid="pull-badge"
                  className="ml-0.5 inline-flex min-w-[14px] items-center justify-center rounded-full bg-[var(--accent)]/20 px-1 font-mono text-[10px] leading-none text-[var(--accent)]"
                >
                  {behindCount}
                </span>
              )}
            </button>
            <button
              type="button"
              onClick={() => void runPullWithClaude()}
              disabled={!wsId || busy != null || !data?.isRepo}
              title={
                behindCount > 0
                  ? `git pull (merge) · ${behindCount} commit${behindCount === 1 ? "" : "s"} behind. On conflicts, opens Claude Code to resolve.`
                  : "git pull (merge). On conflicts, opens Claude Code to resolve."
              }
              data-testid="pull-with-claude-button"
              className="flex h-6 items-center gap-1 rounded px-1.5 text-[var(--muted)] hover:bg-[var(--panel-2)] hover:text-[var(--foreground)] disabled:opacity-40"
            >
              <Sparkles className="h-3 w-3" />
              <ArrowDownToLine className="h-3 w-3" />
              <span className="text-[11px]">
                {busy === "pull" ? "Pulling…" : "Pull + resolve"}
              </span>
              {behindCount > 0 && (
                <span
                  data-testid="pull-resolve-badge"
                  className="ml-0.5 inline-flex min-w-[14px] items-center justify-center rounded-full bg-[var(--accent)]/20 px-1 font-mono text-[10px] leading-none text-[var(--accent)]"
                >
                  {behindCount}
                </span>
              )}
            </button>
            <button
              type="button"
              onClick={() => void runRemote("push")}
              disabled={!wsId || busy != null || !data?.isRepo}
              title={
                aheadCount > 0
                  ? `git push · ${aheadCount} commit${aheadCount === 1 ? "" : "s"} ahead`
                  : "git push (auto-set-upstream when needed)"
              }
              className="flex h-6 items-center gap-1 rounded px-1.5 text-[var(--muted)] hover:bg-[var(--panel-2)] hover:text-[var(--foreground)] disabled:opacity-40"
            >
              <ArrowUpFromLine className="h-3 w-3" />
              <span className="text-[11px]">{busy === "push" ? "Pushing…" : "Push"}</span>
              {aheadCount > 0 && (
                <span
                  data-testid="push-badge"
                  className="ml-0.5 inline-flex min-w-[14px] items-center justify-center rounded-full bg-[var(--accent)]/20 px-1 font-mono text-[10px] leading-none text-[var(--accent)]"
                >
                  {aheadCount}
                </span>
              )}
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
            <AlertTriangle className="h-3 w-3 shrink-0" />
            {/* Show only the first line so a 10KB hook failure doesn't blow
                up the banner; the full output lives in the console below. */}
            <span className="min-w-0 flex-1 truncate font-mono">
              {(statusError ?? opError ?? "").split("\n")[0]}
            </span>
            <button
              type="button"
              onClick={() => setConsoleOpen(true)}
              className="shrink-0 underline-offset-2 hover:underline"
            >
              View in console →
            </button>
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
                  // Two distinct per-row actions:
                  //   - onRevert  → drops local changes (Undo2, tracked rows only)
                  //   - onRemove  → deletes the file (Trash2, all rows)
                  onRevert={(p) => void runRevertSingle(p)}
                  onRemove={(p) => void runRemoveSingle(p)}
                  deletingPath={deletingPath}
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
          <section className="flex min-w-0 flex-1 flex-col overflow-hidden">
            {!selected ? (
              <div className="flex flex-1 items-center justify-center text-sm text-[var(--muted)]">
                Pick a changed file to see the diff.
              </div>
            ) : (
              <>
                <div className="flex h-9 shrink-0 items-center gap-2 border-b border-[var(--border)] bg-[var(--panel-2)]/40 px-3 text-xs">
                  <span className="truncate font-mono">{selected.path}</span>
                  {/* Partial-stage toggle. Without it the user couldn't
                      reach the unstaged side of an `AM` / `MM` file, since
                      groupFiles routes each file to exactly one group. The
                      toggle still applies in editor mode — switching it
                      re-fetches the diff against a different base, which
                      changes which lines are highlighted as additions. */}
                  {selectedNeedsModeToggle ? (
                    <div
                      role="tablist"
                      aria-label="Diff view"
                      data-testid="diff-mode-toggle"
                      className="flex overflow-hidden rounded border border-[var(--border)] bg-[var(--panel)] text-[10px]"
                    >
                      <button
                        type="button"
                        role="tab"
                        aria-selected={selected.mode === "staged"}
                        onClick={() => setSelected({ path: selected.path, mode: "staged" })}
                        className={cn(
                          "px-2 py-0.5",
                          selected.mode === "staged"
                            ? "bg-[var(--accent)]/20 text-[var(--foreground)]"
                            : "text-[var(--muted)] hover:bg-[var(--panel-2)]",
                        )}
                      >
                        Staged · HEAD → index
                      </button>
                      <button
                        type="button"
                        role="tab"
                        aria-selected={selected.mode === "worktree"}
                        onClick={() => setSelected({ path: selected.path, mode: "worktree" })}
                        className={cn(
                          "border-l border-[var(--border)] px-2 py-0.5",
                          selected.mode === "worktree"
                            ? "bg-[var(--accent)]/20 text-[var(--foreground)]"
                            : "text-[var(--muted)] hover:bg-[var(--panel-2)]",
                        )}
                      >
                        Unstaged · index → working
                      </button>
                    </div>
                  ) : (
                    <span className="rounded bg-[var(--panel)] px-1.5 py-0.5 text-[10px] text-[var(--muted)]">
                      {selected.mode === "staged"
                        ? "Staged · HEAD → index"
                        : selected.mode === "untracked"
                          ? "Untracked · /dev/null → working"
                          : "Unstaged · index → working"}
                    </span>
                  )}
                  {/*
                    Unified / Side-by-side layout toggle. Mirrors IntelliJ's
                    "viewer" picker. Disabled for untracked files (no old
                    version to put on the left pane) and pushed to the
                    right of the header so the file path and diff-mode
                    label stay anchored to the left.
                  */}
                  <div
                    role="tablist"
                    aria-label="Right-pane layout"
                    data-testid="diff-layout-toggle"
                    className="ml-auto flex overflow-hidden rounded border border-[var(--border)] bg-[var(--panel)] text-[10px]"
                  >
                    <button
                      type="button"
                      role="tab"
                      aria-selected={!splitMode}
                      onClick={() => setSplitMode(false)}
                      title="Unified — single editable panel with diff highlights"
                      className={cn(
                        "px-2 py-0.5",
                        !splitMode
                          ? "bg-[var(--accent)]/20 text-[var(--foreground)]"
                          : "text-[var(--muted)] hover:bg-[var(--panel-2)]",
                      )}
                    >
                      Unified
                    </button>
                    <button
                      type="button"
                      role="tab"
                      aria-selected={splitMode}
                      onClick={() => setSplitMode(true)}
                      disabled={selected.mode === "untracked"}
                      title={
                        selected.mode === "untracked"
                          ? "Untracked files have no old version to compare"
                          : "Side-by-side — old left, current right"
                      }
                      className={cn(
                        "border-l border-[var(--border)] px-2 py-0.5",
                        splitMode
                          ? "bg-[var(--accent)]/20 text-[var(--foreground)]"
                          : "text-[var(--muted)] hover:bg-[var(--panel-2)]",
                        "disabled:opacity-40 disabled:hover:bg-transparent",
                      )}
                    >
                      Split
                    </button>
                  </div>
                </div>
                {/*
                  IntelliJ-style merged view: the editor IS the diff.
                  Added lines get a green stripe in the editable buffer;
                  no separate "Diff" mode. Falls back to the read-only
                  unified diff view only when the file isn't on disk
                  (worktree=D) — there's nothing to load into an editor
                  in that case.
                */}
                {selectedCanEdit && wsId ? (
                  <FileEditor
                    wsId={wsId}
                    relPath={selected.path}
                    diff={diff?.diff ?? ""}
                    // Split is disabled for untracked files — they have no
                    // "old" version to put on the left side. The toggle in
                    // the header reflects this; passing `split={false}`
                    // here keeps FileEditor itself unaware of the rule.
                    split={splitMode && selected.mode !== "untracked"}
                    mode={selected.mode}
                    // After a save the worktree changed — refresh git
                    // status so the changes list mirrors the new state
                    // (file may have moved out of the list entirely if
                    // the user's edits restored it to its HEAD content).
                    onSaved={() => void refresh()}
                  />
                ) : (
                  <DiffViewer
                    diff={diff?.diff ?? ""}
                    binary={diff?.binary ?? false}
                    loading={diffLoading}
                    error={diffError}
                  />
                )}
              </>
            )}
          </section>
        </div>
        <GitConsole
          entries={consoleEntries}
          open={consoleOpen}
          onOpenChange={setConsoleOpen}
          height={consoleHeight}
          onHeightChange={setConsoleHeight}
          onClear={() => setConsoleEntries([])}
          // Prompt is available whenever there's an active workspace —
          // shell commands work fine in non-repo directories too (`ls`,
          // `bun run lint`, `mkdir`, …). Only the git-mutating refresh
          // heuristic is gated on `data.isRepo` (see runConsoleCommand).
          onRunCommand={wsId ? runConsoleCommand : undefined}
          // Soft-disable while another button-driven op (commit, push,
          // pull, …) is in flight so console-typed commands don't
          // interleave with them.
          promptDisabled={busy != null}
        />
      </main>
    </div>
  );
}
