"use client";

import { useState } from "react";
import { AlertTriangle, Bell, BellOff, Check, Circle, Eraser, Link as LinkIcon, Minimize2 } from "lucide-react";
import type { PermissionMode } from "@anthropic-ai/claude-agent-sdk";
import { ModeSelector } from "./ModeSelector";
import { SessionPicker } from "./SessionPicker";
import { cn } from "@/lib/utils/cn";
import type { SessionInfo } from "@/lib/client/types";

type Props = {
  sessionId: string | null;
  ready: boolean;
  pending: boolean;
  permissionMode: PermissionMode;
  model: string | null;
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
};

export function StatusLine({
  sessionId,
  ready,
  pending,
  permissionMode,
  model,
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

  return (
    <div className="flex h-9 items-center gap-3 border-b border-[var(--border)] bg-[var(--panel)] px-4 text-xs text-[var(--muted)]">
      <Circle className={`h-2.5 w-2.5 ${color}`} fill="currentColor" stroke="none" />
      <SessionPicker
        current={sessionId}
        sessions={sessions}
        onSwitch={onSwitchSession}
        onCreateNew={onCreateNewSession}
        onRefresh={onRefreshSessions}
      />
      <span className="opacity-50">·</span>
      <span className="capitalize">{status}</span>
      {model && (
        <>
          <span className="opacity-50">·</span>
          <span className="font-mono opacity-80">{model}</span>
        </>
      )}
      <div className="ml-auto flex items-center gap-2">
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
            <span className="text-[10px]">Compact</span>
          </button>
        )}
        {onClear && (
          <button
            onClick={onClear}
            title="Clear — start a new session. Prior session is preserved on disk."
            className="flex items-center gap-1 rounded-md border border-[var(--border)] bg-[var(--panel-2)] px-1.5 py-0.5 hover:bg-[var(--panel)]"
          >
            <Eraser className="h-3 w-3" />
            <span className="text-[10px]">Clear</span>
          </button>
        )}
        {notificationsState && notificationsState !== "unsupported" && onToggleNotifications && (
          <button
            onClick={onToggleNotifications}
            title={
              notificationsState === "denied"
                ? "Notifications denied — change in browser settings"
                : notificationsEnabled
                ? "Notifications on — click to disable"
                : "Enable notifications"
            }
            className="rounded-md border border-[var(--border)] bg-[var(--panel-2)] px-1.5 py-0.5 hover:bg-[var(--panel)]"
          >
            {notificationsEnabled && notificationsState === "granted" ? (
              <Bell className="h-3 w-3 text-emerald-400" />
            ) : (
              <BellOff className="h-3 w-3 text-[var(--muted)]" />
            )}
          </button>
        )}
        <ShareButton sessionId={sessionId} />
        <ModeSelector mode={permissionMode} onChange={onModeChange} />
        <span className="font-mono text-[10px] opacity-60">claudius v0</span>
      </div>
    </div>
  );
}

function ShareButton({ sessionId }: { sessionId: string | null }) {
  const [copied, setCopied] = useState(false);
  if (!sessionId) return null;
  const url = typeof window === "undefined" ? "" : `${window.location.origin}/?session=${sessionId}`;
  return (
    <button
      onClick={async () => {
        try {
          await navigator.clipboard.writeText(url);
          setCopied(true);
          setTimeout(() => setCopied(false), 1500);
        } catch {
          // ignore
        }
      }}
      title={url || "Copy session link"}
      className="flex items-center gap-1 rounded-md border border-[var(--border)] bg-[var(--panel-2)] px-1.5 py-0.5 hover:bg-[var(--panel)]"
    >
      {copied ? <Check className="h-3 w-3 text-emerald-400" /> : <LinkIcon className="h-3 w-3" />}
      <span className="text-[10px]">{copied ? "Copied" : "Share"}</span>
    </button>
  );
}
