"use client";

import { useEffect, useRef, useState } from "react";
import {
  AlertTriangle,
  Bot,
  Check,
  Circle,
  Eraser,
  Eye,
  GitBranch,
  Link as LinkIcon,
  Minimize2,
} from "lucide-react";
import type { PermissionMode } from "@anthropic-ai/claude-agent-sdk";
import { ModeSelector } from "./ModeSelector";
import { SessionPicker } from "./SessionPicker";
import { SessionNotifyMenu } from "./SessionNotifyMenu";
import { WorkspaceIcon } from "@/components/workspaces/WorkspaceIcon";
import { cn } from "@/lib/utils/cn";
import { worktreeBadge } from "@/lib/client/worktree";
import type { SessionInfo } from "@/lib/client/types";
import type { Workspace } from "@/lib/server/workspaces-store";
import {
  VERBOSE_LEVELS,
  verboseDescription,
  verboseLabel,
  type VerboseLevel,
} from "@/lib/shared/verbose";

type Props = {
  sessionId: string | null;
  ready: boolean;
  pending: boolean;
  permissionMode: PermissionMode;
  model: string | null;
  /** Main-thread agent name (SDK Options.agent), or null for the default agent. */
  mainAgent?: string | null;
  /**
   * Session root (the cwd the session was created with). Compared against
   * `agentCwd` to decide whether the agent has moved into a git worktree.
   */
  sessionRoot?: string | null;
  /**
   * The agent's *effective* working directory, tracked live from the SDK's
   * CwdChanged hook. When it differs from `sessionRoot` the agent is working
   * in a separate location (typically a git worktree) so its edits won't show
   * up in the user's current checkout — we surface a "worktree" badge.
   */
  agentCwd?: string | null;
  onModeChange: (m: PermissionMode) => void;
  sessions: SessionInfo[];
  onSwitchSession: (id: string) => void;
  onCreateNewSession: () => void;
  onRefreshSessions: () => void;
  contextPercent?: number;
  onOpenContext?: () => void;
  fastModeState?: "off" | "cooldown" | "on" | null;
  totalCostUsd?: number;
  outputTokens?: number;
  onOpenCost?: () => void;
  notificationsEnabled?: boolean;
  notificationsState?: "default" | "granted" | "denied" | "unsupported";
  onToggleNotifications?: () => void;
  /** Send `/compact` to the agent — frees context without losing the thread. */
  onCompact?: () => void;
  /** Clear the conversation — starts a fresh session, history is preserved on disk. */
  onClear?: () => void;
  /**
   * Chat verbosity — controls what shows up in the middle pane. The
   * right-side activity rail is unaffected. Wired through to a small
   * dropdown so the user can switch level without leaving the chat.
   */
  verbose?: VerboseLevel;
  /**
   * Persist a new verbose level (typically by patching the active workspace
   * via `useVerbose`). Omitting this hides the selector entirely.
   */
  onChangeVerbose?: (next: VerboseLevel) => void | Promise<void>;
  /**
   * Active workspace — surfaced as a leading icon + name in the status bar
   * so the user can tell which workspace they're inside without going to the
   * sidebar. Optional because the page may not have resolved a workspace
   * yet on first paint (useWorkspaces still loading).
   */
  workspace?: Workspace | null;
};

export function StatusLine({
  sessionId,
  ready,
  pending,
  permissionMode,
  model,
  mainAgent,
  sessionRoot,
  agentCwd,
  onModeChange,
  sessions,
  onSwitchSession,
  onCreateNewSession,
  onRefreshSessions,
  contextPercent,
  onOpenContext,
  fastModeState,
  totalCostUsd,
  outputTokens,
  onOpenCost,
  notificationsEnabled,
  notificationsState,
  onToggleNotifications,
  onCompact,
  onClear,
  verbose,
  onChangeVerbose,
  workspace,
}: Props) {
  const status = !ready ? "starting" : pending ? "working" : "idle";
  const color =
    status === "starting"
      ? "text-amber-400"
      : status === "working"
      ? "text-[var(--accent)]"
      : "text-emerald-400";

  const ctx = typeof contextPercent === "number" ? Math.round(contextPercent) : null;
  const ctxLevel: "ok" | "warn" | "danger" =
    ctx == null ? "ok" : ctx >= 90 ? "danger" : ctx >= 75 ? "warn" : "ok";

  const busy = status !== "idle";

  // The agent has wandered out of the session's root dir — almost always into
  // a git worktree Claude Code spun up to isolate edits. Surface it so the
  // user doesn't go looking for changes in their main checkout that aren't
  // there. `worktreeBadge` returns null (no badge) when the paths are missing
  // or equal-once-normalized, so the gate and the label can't disagree.
  const worktreeLabel = worktreeBadge(agentCwd, sessionRoot);

  return (
    <div className="flex h-9 items-center gap-3 border-b border-[var(--border)] bg-[var(--panel)] px-4 text-xs text-[var(--muted)]">
      {workspace && (
        <>
          {/* Workspace breadcrumb. The icon + name anchor the rest of the
              status line (session, model, mode) to a parent context — handy
              when several workspaces are open in different windows. Title
              attribute carries the rootPath so the user can confirm which
              folder this workspace points at without leaving the chat. */}
          <span
            data-testid="status-line-workspace"
            data-workspace-id={workspace.id}
            title={`Workspace: ${workspace.name}\n${workspace.rootPath}`}
            // `min-w-0` lets the truncate actually clip — without it the
            // flex item refuses to shrink below its intrinsic content size
            // and pushes the right-hand chip cluster off-screen on narrow
            // viewports. `max-w` keeps long names from monopolising the bar
            // even when there's room.
            className="flex min-w-0 max-w-[10rem] items-center gap-1.5 sm:max-w-[14rem]"
          >
            <WorkspaceIcon workspace={workspace} size={16} />
            <span className="truncate text-[var(--foreground)]">{workspace.name}</span>
          </span>
          <span className="opacity-50">·</span>
        </>
      )}
      <span
        data-testid="status-line-dot"
        data-status={status}
        className="relative inline-flex h-2.5 w-2.5 items-center justify-center"
        aria-hidden
      >
        {busy && (
          <span
            className={cn("absolute inline-flex h-full w-full animate-ping rounded-full opacity-60", color)}
            style={{ backgroundColor: "currentColor" }}
          />
        )}
        <Circle
          className={cn("relative h-2.5 w-2.5", color, busy && "animate-pulse")}
          fill="currentColor"
          stroke="none"
        />
      </span>
      <SessionPicker
        current={sessionId}
        sessions={sessions}
        onSwitch={onSwitchSession}
        onCreateNew={onCreateNewSession}
        onRefresh={onRefreshSessions}
      />
      {worktreeLabel && (
        <span
          data-testid="status-line-worktree"
          title={`Agent is working in a git worktree, not your current checkout:\n${agentCwd}\n\nEdits made here won't appear in your main working tree until the worktree is merged or removed.`}
          className="flex items-center gap-1 rounded border border-amber-500/40 bg-amber-500/10 px-1.5 py-0.5 font-mono text-[10px] text-amber-200"
        >
          <GitBranch className="h-3 w-3" />
          <span className="max-w-[12rem] truncate">{worktreeLabel}</span>
        </span>
      )}
      <span className="opacity-50">·</span>
      {/*
        Render the capitalized string in JS, not via CSS `capitalize`, so
        `textContent` matches what users see. The e2e specs in
        tests/e2e/turn-status.spec.ts assert with `toHaveText("Idle")` —
        CSS-only capitalization leaves the DOM text "idle" and the
        assertion fails.
      */}
      <span data-testid="status-line-text">{status.charAt(0).toUpperCase() + status.slice(1)}</span>
      {model && (
        <>
          <span className="opacity-50">·</span>
          <span className="font-mono opacity-80">{model}</span>
        </>
      )}
      {mainAgent && (
        <>
          <span className="opacity-50">·</span>
          <span
            title={`Main-thread agent: ${mainAgent} (its system prompt, tools, and model apply)`}
            className="flex items-center gap-1 rounded border border-[var(--border)] bg-[var(--panel-2)] px-1 py-0.5 font-mono text-[10px] opacity-80"
          >
            <Bot className="h-3 w-3" />
            {mainAgent}
          </span>
        </>
      )}
      {/* `shrink-0` on the cluster pairs with `min-w-0` on the workspace
          breadcrumb above — the breadcrumb is the only thing that should
          give up width when the bar gets narrow. */}
      <div className="ml-auto flex shrink-0 items-center gap-2">
        {(typeof totalCostUsd === "number" && totalCostUsd > 0) || (typeof outputTokens === "number" && outputTokens > 0) ? (
          <button
            onClick={onOpenCost}
            title="Session cost & usage"
            className="rounded-md border border-[var(--border)] bg-[var(--panel-2)] px-1.5 py-0.5 font-mono text-[10px] hover:bg-[var(--panel)]"
          >
            {typeof totalCostUsd === "number" && totalCostUsd > 0
              ? `$${totalCostUsd < 0.01 ? totalCostUsd.toFixed(4) : totalCostUsd.toFixed(3)}`
              : "—"}
            {typeof outputTokens === "number" && outputTokens > 0 && (
              <span className="ml-1 opacity-70">
                {outputTokens >= 1000 ? `${(outputTokens / 1000).toFixed(1)}K` : outputTokens} tok
              </span>
            )}
          </button>
        ) : null}
        {fastModeState && fastModeState !== "off" && (
          <span
            className={cn(
              "rounded-md border px-1.5 py-0.5 font-mono text-[10px]",
              fastModeState === "on"
                ? "border-amber-500/40 bg-amber-500/10 text-amber-200"
                : "border-[var(--border)] bg-[var(--panel-2)] text-[var(--muted)]",
            )}
            title={fastModeState === "on" ? "Fast mode active" : "Fast mode cooling down"}
          >
            ⚡ {fastModeState}
          </span>
        )}
        {ctx != null && (
          <button
            onClick={onOpenContext}
            className={cn(
              "flex items-center gap-1 rounded-md border px-1.5 py-0.5 font-mono text-[10px] transition",
              ctxLevel === "ok" && "border-[var(--border)] bg-[var(--panel-2)] hover:bg-[var(--panel)]",
              ctxLevel === "warn" && "border-amber-500/40 bg-amber-500/10 text-amber-200 hover:bg-amber-500/20",
              ctxLevel === "danger" && "border-red-500/40 bg-red-500/10 text-red-200 hover:bg-red-500/20",
            )}
            title={
              ctxLevel === "danger"
                ? "Context near full — consider /compact"
                : ctxLevel === "warn"
                ? "Context filling up"
                : "Context window"
            }
          >
            {ctxLevel !== "ok" && <AlertTriangle className="h-3 w-3" />}
            {ctx}%
          </button>
        )}
        {onCompact && (
          <button
            onClick={onCompact}
            disabled={!ready || pending === true}
            title="Compact this session — summarize prior turns to free up context"
            className="flex items-center gap-1 rounded-md border border-[var(--border)] bg-[var(--panel-2)] px-1.5 py-0.5 hover:bg-[var(--panel)] disabled:opacity-40"
          >
            <Minimize2 className="h-3 w-3" />
            {/* Below md the icon stands on its own — the `title` still
                carries the full tooltip. */}
            <span className="hidden text-[10px] md:inline">Compact</span>
          </button>
        )}
        {onClear && (
          <button
            onClick={onClear}
            title="Clear — start a new session. Prior session is preserved on disk."
            className="flex items-center gap-1 rounded-md border border-[var(--border)] bg-[var(--panel-2)] px-1.5 py-0.5 hover:bg-[var(--panel)]"
          >
            <Eraser className="h-3 w-3" />
            <span className="hidden text-[10px] md:inline">Clear</span>
          </button>
        )}
        {notificationsState && onToggleNotifications && (
          <SessionNotifyMenu
            sessionId={sessionId}
            permissionState={notificationsState}
            workspaceEnabled={!!notificationsEnabled}
            onToggleWorkspace={onToggleNotifications}
          />
        )}
        <ShareButton sessionId={sessionId} />
        {verbose && onChangeVerbose && (
          <VerboseSelector value={verbose} onChange={onChangeVerbose} />
        )}
        <ModeSelector mode={permissionMode} onChange={onModeChange} />
      </div>
    </div>
  );
}

/**
 * Verbose level dropdown — sits in the StatusLine chip cluster next to
 * ModeSelector. Visual pattern matches the SessionPicker / SessionNotifyMenu:
 * trigger button + outside-click + Esc closes the popover.
 *
 * Levels live in `lib/shared/verbose.ts`. The button label uses the
 * label-only form ("Normal", "Compact", "Verbose") rather than icons-only
 * so first-time users can tell what the chip controls without hovering.
 */
function VerboseSelector({
  value,
  onChange,
}: {
  value: VerboseLevel;
  onChange: (next: VerboseLevel) => void | Promise<void>;
}) {
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLDivElement | null>(null);

  // Outside click + Esc dismissal. Reused pattern across StatusLine bits.
  useEffect(() => {
    if (!open) return;
    function onDown(e: MouseEvent) {
      if (!ref.current?.contains(e.target as Node)) setOpen(false);
    }
    function onKey(e: KeyboardEvent) {
      if (e.key === "Escape") setOpen(false);
    }
    window.addEventListener("mousedown", onDown);
    window.addEventListener("keydown", onKey);
    return () => {
      window.removeEventListener("mousedown", onDown);
      window.removeEventListener("keydown", onKey);
    };
  }, [open]);

  return (
    <div ref={ref} className="relative">
      <button
        type="button"
        data-testid="verbose-selector"
        data-verbose-level={value}
        onClick={() => setOpen((o) => !o)}
        title={`Verbosity: ${verboseLabel(value)}\n${verboseDescription(value)}`}
        className={cn(
          "flex items-center gap-1 rounded-md border border-[var(--border)] bg-[var(--panel-2)] px-1.5 py-0.5 hover:bg-[var(--panel)]",
          open && "bg-[var(--panel)]",
        )}
      >
        <Eye className="h-3 w-3" />
        <span className="text-[10px]">{verboseLabel(value)}</span>
      </button>
      {open && (
        <div
          data-testid="verbose-selector-menu"
          className="absolute right-0 top-full z-20 mt-1 w-64 overflow-hidden rounded-md border border-[var(--border)] bg-[var(--panel)] shadow-2xl"
        >
          <div className="border-b border-[var(--border)] px-3 py-1.5 text-[10px] uppercase tracking-wide text-[var(--muted)]">
            Chat verbosity
          </div>
          <ul>
            {VERBOSE_LEVELS.map((lvl) => {
              const active = lvl === value;
              return (
                <li key={lvl}>
                  <button
                    type="button"
                    data-testid={`verbose-option-${lvl}`}
                    onClick={() => {
                      setOpen(false);
                      if (lvl !== value) void onChange(lvl);
                    }}
                    className={cn(
                      "flex w-full items-start gap-2 px-3 py-2 text-left text-[11px] hover:bg-[var(--panel-2)]",
                      active && "bg-[var(--panel-2)]",
                    )}
                  >
                    <Check
                      className={cn(
                        "mt-0.5 h-3 w-3 shrink-0",
                        active ? "text-[var(--accent)]" : "opacity-0",
                      )}
                    />
                    <div className="min-w-0">
                      <div className="font-medium text-[var(--foreground)]">
                        {verboseLabel(lvl)}
                      </div>
                      <div className="text-[10px] text-[var(--muted)]">
                        {verboseDescription(lvl)}
                      </div>
                    </div>
                  </button>
                </li>
              );
            })}
          </ul>
          <div className="border-t border-[var(--border)] px-3 py-1.5 text-[9.5px] text-[var(--muted)]">
            The right-side activity rail always shows every tool call,
            regardless of level. Saved per workspace.
          </div>
        </div>
      )}
    </div>
  );
}

function ShareButton({ sessionId }: { sessionId: string | null }) {
  const [copied, setCopied] = useState(false);
  if (!sessionId) return null;
  const command = `claude --dangerously-skip-permissions --resume ${sessionId}`;
  return (
    <button
      onClick={async () => {
        try {
          await navigator.clipboard.writeText(command);
          setCopied(true);
          setTimeout(() => setCopied(false), 1500);
        } catch {
          // ignore
        }
      }}
      title={`Copy resume command: ${command}`}
      className="flex items-center gap-1 rounded-md border border-[var(--border)] bg-[var(--panel-2)] px-1.5 py-0.5 hover:bg-[var(--panel)]"
    >
      {copied ? <Check className="h-3 w-3 text-emerald-400" /> : <LinkIcon className="h-3 w-3" />}
      {/* Label collapses below md so the right cluster fits alongside the
          Compact / Clear / Verbose / Mode pills on narrow viewports. The
          title attribute keeps the URL discoverable as a tooltip. */}
      <span className="hidden text-[10px] md:inline">{copied ? "Copied" : "Copy resume"}</span>
    </button>
  );
}
