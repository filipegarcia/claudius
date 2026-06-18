"use client";

import { useEffect, useRef, useState } from "react";
import {
  AlertTriangle,
  Bot,
  Check,
  Circle,
  Eraser,
  Eye,
  Focus,
  GitBranch,
  Link as LinkIcon,
  Minimize2,
} from "lucide-react";
import type { PermissionMode } from "@anthropic-ai/claude-agent-sdk";
import { ModeSelector } from "./ModeSelector";
import { SessionPicker } from "./SessionPicker";
import { SessionNotifyMenu } from "./SessionNotifyMenu";
import { WorkspaceIcon } from "@/components/workspaces/WorkspaceIcon";
import { useWorkspaces } from "@/lib/client/useWorkspaces";
import type { FocusLevel } from "@/lib/client/useFocusMode";
import { cn } from "@/lib/utils/cn";
import { worktreeBadge } from "@/lib/client/worktree";
import type { SessionInfo } from "@/lib/client/types";
import type { Workspace } from "@/lib/server/workspaces-store";
import { modelDeprecationDate } from "@/lib/shared/model-deprecations";
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
  /**
   * Callback to live-switch the main-thread agent (SDK 0.3.161+). When provided,
   * the agent badge becomes an interactive picker that lets the user switch to any
   * available agent or reset to the default. When omitted the badge is read-only
   * (as it was before this release).
   */
  onPickAgent?: (name: string | null) => Promise<void> | void;
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
  /**
   * Focus level (see `useFocusMode`). "focus"/"zen" hide the side rails and
   * force ultra-compact chat; "zen" additionally collapses the StatusLine to
   * just the toggle below. The toggle button highlights while active.
   */
  focusLevel?: FocusLevel;
  /** Advance the focus level (off → focus → zen → off). Omitting hides the toggle. */
  onCycleFocus?: () => void;
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
  onPickAgent,
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
  focusLevel = "off",
  onCycleFocus,
}: Props) {
  // Zen mode collapses the StatusLine to just the focus toggle.
  const zen = focusLevel === "zen";
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
    // `@container/statusline` lets the right-cluster labels collapse based on
    // THIS row's width (i.e. the chat-area pane width) rather than the
    // viewport. With the side rails open, the viewport can be 1280px while
    // the chat area is only ~700–900px — viewport breakpoints fire too late
    // and the cluster ("Compact", "Clear", "Copy resume", "Normal", "Bypass")
    // overflows the row and bleeds over the right activity panel. Named
    // container (`/statusline`) so child components (ModeSelector,
    // VerboseSelector) anchor unambiguously to this row even when other
    // `@container` ancestors get added later.
    //
    // `clip-path` is a backstop for the case where even icon-only items
    // can't fit the chat-area width (very narrow Electron windows). It
    // clips horizontally at the row's box (so the rightmost item — the
    // ModeSelector shield — can't bleed over the right activity panel)
    // but extends the clip region ±100vh vertically so the trigger
    // dropdowns (which open downward via `top-full`) keep painting in
    // full. `overflow-hidden` would clip the dropdowns too; clip-path
    // with directional insets lets us clip one axis only.
    // `z-20` lifts the whole status-line stacking context above the chat
    // content that follows it as siblings (RecapBanner / GoalBanner /
    // TodosBanner / MessageList — all at z=auto under `<main>`). Without it,
    // the `[clip-path:inset(...)]` below creates a stacking context that
    // *traps* the SessionPicker dropdown's internal `z-30` inside the status
    // line, so MessageList — being a later sibling in DOM order — paints over
    // the dropdown and makes its body look transparent. The other dropdowns
    // (ModelPicker, etc.) escape via `position: fixed`; SessionPicker uses
    // `absolute`, hence it relied on this lift to be visible.
    <div className="@container/statusline relative z-20 flex h-9 items-center gap-3 border-b border-[var(--border)] bg-[var(--panel)] px-4 text-xs text-[var(--muted)] [clip-path:inset(-100vh_0_-100vh_0)]">
      {workspace && (
        <>
          {/* Workspace breadcrumb. The icon + name anchor the rest of the
              status line (session, model, mode) to a parent context — handy
              when several workspaces are open in different windows. It's also
              a switcher: with the left SideNav hidden (focus mode), this is
              the way to change workspaces from the chat. */}
          <WorkspaceChip workspace={workspace} />
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
      <span
        data-testid="status-line-text"
        className="whitespace-nowrap"
      >
        {status.charAt(0).toUpperCase() + status.slice(1)}
      </span>
      {model && (
        <>
          <span className="opacity-50">·</span>
          {/* Deprecation chip: when the active model is on the SDK's EOL
              list (mirrored in `lib/shared/model-deprecations.ts`) we
              promote the model label to an amber warning pill with an
              AlertTriangle, matching the worktree/context chip pattern.
              Title carries the EOL date so the user can plan a migration
              before requests start fallback-swapping. */}
          {(() => {
            const eol = modelDeprecationDate(model);
            if (eol) {
              return (
                <span
                  data-testid="status-line-model-deprecated"
                  data-model={model}
                  title={`Model ${model} reaches end-of-life on ${eol}. Switch to a current model to avoid an automatic fallback.`}
                  className="flex items-center gap-1 rounded border border-amber-500/40 bg-amber-500/10 px-1.5 py-0.5 font-mono text-[10px] text-amber-200"
                >
                  <AlertTriangle className="h-3 w-3" />
                  <span className="max-w-[14rem] truncate">{model}</span>
                </span>
              );
            }
            // `truncate` (overflow:hidden + text-overflow:ellipsis +
            // white-space:nowrap) collapses long model ids like
            // `claude-opus-4-7` into a single line at narrow widths instead
            // of wrapping at the hyphens (each `-` is a flex-pressure break
            // opportunity). `max-w` caps the badge so the chips beside it
            // stay visible; `title` keeps the full id discoverable on
            // hover, matching the deprecation chip above.
            return (
              <span
                title={model}
                className="max-w-[10rem] truncate font-mono opacity-80 sm:max-w-[14rem]"
              >
                {model}
              </span>
            );
          })()}
        </>
      )}
      {/* Agent pill: interactive when onPickAgent is provided (always visible so
          the user can switch back after resetting to the default agent);
          read-only static badge when onPickAgent is absent.

          When mainAgent is null and onPickAgent is provided, the AgentPicker
          shows a "Default" label so the user can see the current state and
          click to switch to a named agent. When mainAgent is null and there is
          no picker, we omit the pill entirely (original behaviour). */}
      {(mainAgent || onPickAgent) && (
        <>
          <span className="opacity-50">·</span>
          {onPickAgent ? (
            <AgentPicker
              sessionId={sessionId}
              currentAgent={mainAgent ?? null}
              onPick={onPickAgent}
            />
          ) : mainAgent ? (
            <span
              data-testid="status-line-agent"
              title={`Main-thread agent: ${mainAgent} (its system prompt, tools, and model apply)`}
              className="flex items-center gap-1 rounded border border-[var(--border)] bg-[var(--panel-2)] px-1 py-0.5 font-mono text-[10px] opacity-80"
            >
              <Bot className="h-3 w-3 shrink-0" />
              <span className="max-w-[8rem] truncate">{mainAgent}</span>
            </span>
          ) : null}
        </>
      )}
      {/* `shrink-0` on the cluster pairs with `min-w-0` on the workspace
          breadcrumb above — the breadcrumb is the only thing that should
          give up width when the bar gets narrow. */}
      <div className="ml-auto flex shrink-0 items-center gap-2">
        {/* Every control except the focus toggle is hidden in zen mode. */}
        {!zen && (
        <>
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
            data-testid="status-line-fast"
            data-fast-state={fastModeState}
            className={cn(
              "flex items-center gap-1 rounded-md border px-1.5 py-0.5 font-mono text-[10px]",
              fastModeState === "on"
                ? "border-amber-500/40 bg-amber-500/10 text-amber-200"
                : "border-[var(--border)] bg-[var(--panel-2)] text-[var(--muted)]",
            )}
            // Mirror the TUI's `Draws from usage credits` confirmation so the
            // higher-rate billing is visible at a glance whenever fast mode
            // is active — same copy as the ModelPicker toggle sublabel.
            title={
              fastModeState === "on"
                ? "Fast mode active — draws from usage credits"
                : "Fast mode cooling down"
            }
          >
            <span>⚡ {fastModeState}</span>
            {fastModeState === "on" && (
              // Container query — see "Compact" label above for the rationale.
              <span className="hidden text-[9px] opacity-80 @3xl/statusline:inline">· credits</span>
            )}
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
            {/* Below the @3xl threshold (≈768px of CHAT-AREA width — the
                StatusLine row is the named container) the icon stands on its
                own; the `title` carries the full tooltip. Viewport `md:` was
                too eager: at a 1280px window with both rails open the chat
                area is ~936px and labels still fit, but at narrower windows
                the cluster overflowed the row and bled over the right
                activity panel. */}
            <span className="hidden text-[10px] @3xl/statusline:inline">Compact</span>
          </button>
        )}
        {onClear && (
          <button
            onClick={onClear}
            title="Clear — start a new session. Prior session is preserved on disk."
            className="flex items-center gap-1 rounded-md border border-[var(--border)] bg-[var(--panel-2)] px-1.5 py-0.5 hover:bg-[var(--panel)]"
          >
            <Eraser className="h-3 w-3" />
            {/* See "Compact" label above for the @2xl/statusline rationale. */}
            <span className="hidden text-[10px] @3xl/statusline:inline">Clear</span>
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
        </>
        )}
        {onCycleFocus && (
          <button
            type="button"
            data-testid="focus-toggle"
            data-focus-level={focusLevel}
            aria-pressed={focusLevel !== "off"}
            onClick={onCycleFocus}
            title={
              focusLevel === "off"
                ? "Focus mode — hide the nav rail & activity panel and switch chat to ultra-compact (⌘.)"
                : focusLevel === "focus"
                ? "Zen mode — also hide the workspace rail and every other header control (⌘.)"
                : "Exit Zen mode — restore the full UI and your chat verbosity (⌘.)"
            }
            className={cn(
              "flex items-center gap-1 rounded-md border px-1.5 py-0.5",
              focusLevel !== "off"
                ? "border-[var(--accent)]/50 bg-[var(--accent)]/15 text-[var(--accent)]"
                : "border-[var(--border)] bg-[var(--panel-2)] hover:bg-[var(--panel)]",
            )}
          >
            <Focus className="h-3 w-3" />
            {/* In zen the label always shows (it's the only control left);
                otherwise it collapses with the row like its neighbours — see
                the "Compact" label above for the @3xl/statusline rationale. */}
            <span className={cn("text-[10px]", zen ? "inline" : "hidden @3xl/statusline:inline")}>
              {zen ? "Zen Mode" : "Focus"}
            </span>
          </button>
        )}
        {!zen && verbose && onChangeVerbose && (
          <VerboseSelector value={verbose} onChange={onChangeVerbose} />
        )}
        {!zen && <ModeSelector mode={permissionMode} onChange={onModeChange} />}
      </div>
    </div>
  );
}

/**
 * Workspace breadcrumb that doubles as a switcher. The trigger shows the
 * active workspace's icon + name (the read-only breadcrumb it replaces); the
 * popover lists every workspace so the user can switch without the left
 * SideNav — which focus mode hides. Switching reuses `useWorkspaces().select`,
 * the same path WorkspaceSwitcher uses (POST /select + full-document load so
 * the SDK child process restarts in the new cwd). We land on "/workspace" to
 * mirror WorkspaceSwitcher's letter-switch target.
 *
 * Visual pattern matches VerboseSelector / SessionPicker: trigger + outside
 * click + Esc closes the popover.
 */
function WorkspaceChip({ workspace }: { workspace: Workspace }) {
  const { items, activeId, select } = useWorkspaces();
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLDivElement | null>(null);

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
    <div ref={ref} className="relative flex min-w-0">
      <button
        type="button"
        data-testid="status-line-workspace"
        data-workspace-id={workspace.id}
        onClick={() => setOpen((o) => !o)}
        title={`Workspace: ${workspace.name}\n${workspace.rootPath}\n\nClick to switch workspace.`}
        // `min-w-0` lets the truncate actually clip — without it the flex item
        // refuses to shrink below its intrinsic content size and pushes the
        // right-hand chip cluster off-screen on narrow viewports. `max-w`
        // keeps long names from monopolising the bar even when there's room.
        className={cn(
          "flex min-w-0 max-w-[10rem] items-center gap-1.5 rounded-md px-1 py-0.5 hover:bg-[var(--panel-2)] sm:max-w-[14rem]",
          open && "bg-[var(--panel-2)]",
        )}
      >
        <WorkspaceIcon workspace={workspace} size={16} />
        <span className="truncate text-[var(--foreground)]">{workspace.name}</span>
      </button>
      {open && (
        <div
          data-testid="status-line-workspace-menu"
          className="absolute left-0 top-full z-30 mt-1 max-h-80 w-64 overflow-y-auto rounded-md border border-[var(--border)] bg-[var(--panel)] shadow-2xl"
        >
          <div className="border-b border-[var(--border)] px-3 py-1.5 text-[10px] uppercase tracking-wide text-[var(--muted)]">
            Switch workspace
          </div>
          <ul>
            {items.map((w) => {
              const active = w.id === (activeId ?? workspace.id);
              return (
                <li key={w.id}>
                  <button
                    type="button"
                    data-testid={`status-line-workspace-option-${w.id}`}
                    onClick={() => {
                      setOpen(false);
                      if (!active) void select(w.id, "/workspace");
                    }}
                    className={cn(
                      "flex w-full items-center gap-2 px-3 py-2 text-left text-[11px] hover:bg-[var(--panel-2)]",
                      active && "bg-[var(--panel-2)]",
                    )}
                  >
                    <Check
                      className={cn(
                        "h-3 w-3 shrink-0",
                        active ? "text-[var(--accent)]" : "opacity-0",
                      )}
                    />
                    <WorkspaceIcon workspace={w} size={16} />
                    <span className="min-w-0 truncate text-[var(--foreground)]">{w.name}</span>
                  </button>
                </li>
              );
            })}
          </ul>
        </div>
      )}
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
        {/* Collapse the verbosity label to icon-only when the StatusLine row
            (the named `@container/statusline` ancestor) is below ~768px —
            same threshold as the Compact / Clear / Copy resume labels
            above. Previously this label rendered unconditionally, so on a
            narrow chat-area it (plus the ModeSelector label) was what
            pushed the right cluster off the row. The `title` on the
            button still carries the full label + description. */}
        <span className="hidden text-[10px] @3xl/statusline:inline">{verboseLabel(value)}</span>
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

/** Agent info shape, mirroring AgentInfo from the SDK (no direct import to keep client bundles lean). */
type AgentEntry = { name: string; description?: string; model?: string };

/**
 * Clickable agent badge that opens a mini dropdown for switching the
 * main-thread agent (SDK 0.3.161+). Shows the currently active agent name
 * and, on click, lists all agents available for this session plus a
 * "General purpose (default)" reset option.
 *
 * The agent list is fetched lazily — only when the dropdown opens for the
 * first time — from `GET /api/sessions/[id]/agents`, which is the same
 * endpoint the `@`-mention picker uses for subagent invocation.
 */
function AgentPicker({
  sessionId,
  currentAgent,
  onPick,
}: {
  sessionId: string | null;
  currentAgent: string | null;
  onPick: (name: string | null) => Promise<void> | void;
}) {
  const [open, setOpen] = useState(false);
  // null = not yet fetched (shows loading spinner when open); array = fetched.
  const [agents, setAgents] = useState<AgentEntry[] | null>(null);
  const ref = useRef<HTMLDivElement | null>(null);

  // Outside-click + Esc dismissal.
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

  // Fetch agent list lazily on first open. Pattern mirrors AtMentionPicker:
  // setState calls live in the async .then (not the effect body) so the rule
  // react-hooks/set-state-in-effect is satisfied.
  useEffect(() => {
    if (!open || agents !== null || !sessionId) return;
    let cancelled = false;
    fetch(`/api/sessions/${encodeURIComponent(sessionId)}/agents`)
      .then((r) => (r.ok ? r.json() : null))
      .then((d: { agents?: AgentEntry[] } | null) => {
        if (!cancelled) setAgents(d?.agents ?? []);
      })
      .catch(() => {
        if (!cancelled) setAgents([]);
      });
    return () => {
      cancelled = true;
    };
  }, [open, agents, sessionId]);

  return (
    <div ref={ref} className="relative">
      <button
        type="button"
        data-testid="status-line-agent"
        data-agent={currentAgent ?? ""}
        onClick={() => setOpen((o) => !o)}
        title={
          currentAgent
            ? `Main-thread agent: ${currentAgent} (its system prompt, tools, and model apply). Click to switch.`
            : "Running as the default general-purpose agent. Click to switch to a named agent."
        }
        className={cn(
          "flex items-center gap-1 rounded border border-[var(--border)] bg-[var(--panel-2)] px-1 py-0.5 font-mono text-[10px]",
          currentAgent ? "opacity-80" : "opacity-50",
          "hover:opacity-100 hover:bg-[var(--panel)]",
          open && "opacity-100 bg-[var(--panel)]",
        )}
      >
        <Bot className="h-3 w-3 shrink-0" />
        {/* Truncate long agent names instead of wrapping at hyphens/dashes
            when the row is squeezed. */}
        <span className="max-w-[8rem] truncate">{currentAgent ?? "Default"}</span>
      </button>
      {open && (
        <div
          data-testid="agent-picker-menu"
          className="absolute left-0 top-full z-30 mt-1 w-64 overflow-hidden rounded-md border border-[var(--border)] bg-[var(--panel)] shadow-2xl"
        >
          <div className="border-b border-[var(--border)] px-3 py-1.5 text-[10px] uppercase tracking-wide text-[var(--muted)]">
            Switch main-thread agent
          </div>
          {/* Reset-to-default entry */}
          <button
            type="button"
            data-testid="agent-picker-default"
            onClick={() => {
              setOpen(false);
              void onPick(null);
            }}
            className={cn(
              "flex w-full items-start gap-2 px-3 py-2 text-left text-[11px] hover:bg-[var(--panel-2)]",
              currentAgent === null && "bg-[var(--panel-2)]",
            )}
          >
            <Check
              className={cn(
                "mt-0.5 h-3 w-3 shrink-0",
                currentAgent === null ? "text-[var(--accent)]" : "opacity-0",
              )}
            />
            <div className="min-w-0">
              <div className="font-medium text-[var(--foreground)]">General purpose (default)</div>
              <div className="text-[10px] text-[var(--muted)]">Reset to the default Claude Code agent</div>
            </div>
          </button>
          {agents === null && (
            <div className="px-3 py-2 text-[10px] text-[var(--muted)]">Loading agents…</div>
          )}
          {agents !== null &&
            agents.map((a) => (
              <button
                key={a.name}
                type="button"
                data-testid={`agent-picker-option-${a.name}`}
                onClick={() => {
                  setOpen(false);
                  void onPick(a.name);
                }}
                className={cn(
                  "flex w-full items-start gap-2 px-3 py-2 text-left text-[11px] hover:bg-[var(--panel-2)]",
                  currentAgent === a.name && "bg-[var(--panel-2)]",
                )}
              >
                <Check
                  className={cn(
                    "mt-0.5 h-3 w-3 shrink-0",
                    currentAgent === a.name ? "text-[var(--accent)]" : "opacity-0",
                  )}
                />
                <div className="min-w-0">
                  <div className="font-medium text-[var(--foreground)]">{a.name}</div>
                  {a.description && (
                    <div className="truncate text-[10px] text-[var(--muted)]">{a.description}</div>
                  )}
                  {a.model && (
                    <div className="text-[10px] text-[var(--muted)] opacity-70 font-mono">{a.model}</div>
                  )}
                </div>
              </button>
            ))}
          {agents !== null && agents.length === 0 && (
            <div className="px-3 py-2 text-[10px] text-[var(--muted)]">
              No additional agents found for this session.
            </div>
          )}
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
      {/* Label collapses when this button's container (the StatusLine row)
          falls below ~672px so the right cluster fits alongside the Compact
          / Clear / Verbose / Mode pills. Container query (not viewport `md:`)
          because the chat-area width depends on whether the side rails are
          open — viewport-based hiding fires too late and the cluster
          overflowed. Title attribute keeps the URL discoverable as a
          tooltip. */}
      <span className="hidden text-[10px] @3xl/statusline:inline">{copied ? "Copied" : "Copy resume"}</span>
    </button>
  );
}
