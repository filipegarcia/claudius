"use client";

import { useEffect, useState } from "react";
import { CircuitBoard, ShieldCheck, Folder } from "lucide-react";
import type { PermissionMode } from "@anthropic-ai/claude-agent-sdk";
import type { SessionUsage } from "@/lib/client/types";
import { fmtElapsedSec, fmtPath } from "./format";

type Props = {
  sessionId: string | null;
  model: string | null;
  permissionMode: PermissionMode;
  cwd: string | null;
  usage: SessionUsage | null;
  onOpenCost?: () => void;
};

const MODE_LABEL: Record<string, string> = {
  default: "default",
  acceptEdits: "accept edits",
  plan: "plan",
  bypassPermissions: "bypass",
};

export function SessionCard({ sessionId, model, permissionMode, cwd, usage, onOpenCost }: Props) {
  // Use `usage.durationMs` when present (server-known); otherwise track wall
  // time from when we first saw a non-null sessionId.
  const [boundAt, setBoundAt] = useState<number | null>(null);
  useEffect(() => {
    if (sessionId) setBoundAt((prev) => prev ?? Date.now());
    else setBoundAt(null);
  }, [sessionId]);

  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    const id = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(id);
  }, []);

  const elapsedSec = usage?.durationMs
    ? usage.durationMs / 1000
    : boundAt
      ? (now - boundAt) / 1000
      : 0;
  const turns = usage?.numTurns ?? 0;

  return (
    <button
      type="button"
      onClick={onOpenCost}
      className="mb-3 block w-full rounded-md border border-[var(--border)] bg-[var(--panel-2)]/40 p-2 text-left hover:bg-[var(--panel-2)]"
    >
      <div className="flex items-center gap-1.5 text-[11px]">
        <CircuitBoard className="h-3 w-3 text-[var(--accent)]" />
        <span className="truncate font-mono">{shortModel(model)}</span>
        <ModePill mode={permissionMode} />
      </div>
      {cwd && (
        <div
          className="mt-1 flex items-center gap-1 text-[10px] text-[var(--muted)]"
          title={cwd}
        >
          <Folder className="h-3 w-3 shrink-0" />
          <span className="truncate font-mono">{fmtPath(cwd, 32)}</span>
        </div>
      )}
      <div className="mt-1 flex gap-3 text-[10px] text-[var(--muted)]">
        <span>{turns} turn{turns === 1 ? "" : "s"}</span>
        <span>{fmtElapsedSec(elapsedSec)}</span>
      </div>
    </button>
  );
}

function ModePill({ mode }: { mode: PermissionMode }) {
  const tone =
    mode === "plan"
      ? "border-violet-500/30 bg-violet-500/15 text-violet-200"
      : mode === "bypassPermissions"
        ? "border-red-500/30 bg-red-500/10 text-red-200"
        : mode === "acceptEdits"
          ? "border-emerald-500/30 bg-emerald-500/10 text-emerald-200"
          : "border-[var(--border)] bg-[var(--panel)] text-[var(--muted)]";
  return (
    <span className={`ml-auto inline-flex items-center gap-1 rounded border px-1.5 py-px text-[9px] ${tone}`}>
      <ShieldCheck className="h-2.5 w-2.5" />
      {MODE_LABEL[mode] ?? mode}
    </span>
  );
}

function shortModel(m: string | null): string {
  if (!m) return "—";
  // trim "claude-" prefix and version suffixes for compactness
  return m.replace(/^claude-/, "").replace(/-\d{8}$/, "");
}
