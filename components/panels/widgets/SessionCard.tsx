"use client";

import { useEffect, useRef, useState } from "react";
import { ChevronDown, CircuitBoard, ShieldCheck, Folder } from "lucide-react";
import type { PermissionMode } from "@anthropic-ai/claude-agent-sdk";
import type { SessionUsage } from "@/lib/client/types";
import { cn } from "@/lib/utils/cn";
import { fmtElapsedSec, fmtPath } from "./format";
import { ModelPicker } from "./ModelPicker";

type EffortLevel = "low" | "medium" | "high" | "xhigh" | "max" | "auto";

type Props = {
  sessionId: string | null;
  model: string | null;
  permissionMode: PermissionMode;
  cwd: string | null;
  usage: SessionUsage | null;
  /**
   * Fallback turn count derived from the message transcript, used when
   * `usage` is null. SDK `result` events (which carry `numTurns`) aren't
   * persisted in the JSONL — so a freshly-resumed session shows 0 turns
   * until a new turn lands. Counting assistant messages we already
   * received via replay is at least directionally correct.
   */
  historicalTurnCount?: number;
  onOpenCost?: () => void;
  /** Change the active model. Hides the picker trigger entirely when omitted. */
  onChangeModel?: (modelValue: string) => Promise<void> | void;
  /** Change reasoning/effort level. Required alongside onChangeModel to show the effort chips. */
  onChangeEffort?: (level: EffortLevel) => Promise<void> | void;
};

const MODE_LABEL: Record<string, string> = {
  default: "default",
  acceptEdits: "accept edits",
  plan: "plan",
  bypassPermissions: "bypass",
};

export function SessionCard({
  sessionId,
  model,
  permissionMode,
  cwd,
  usage,
  historicalTurnCount,
  onOpenCost,
  onChangeModel,
  onChangeEffort,
}: Props) {
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
  const turns = usage?.numTurns ?? historicalTurnCount ?? 0;

  const pickerEnabled = !!onChangeModel;
  const [pickerOpen, setPickerOpen] = useState(false);
  const modelButtonRef = useRef<HTMLButtonElement>(null);

  return (
    <div className="relative mb-3 rounded-md border border-[var(--border)] bg-[var(--panel-2)]/40">
      {/* Top row — model + mode pill. Clickable when the picker is wired up,
          otherwise just a static label so the existing read-only flow doesn't
          regress. */}
      {pickerEnabled ? (
        <button
          ref={modelButtonRef}
          type="button"
          data-testid="model-picker-trigger"
          onClick={() => setPickerOpen((o) => !o)}
          aria-haspopup="dialog"
          aria-expanded={pickerOpen}
          className={cn(
            "flex w-full items-center gap-1.5 rounded-t-md px-2 pb-1.5 pt-2 text-left text-[11px] transition",
            "hover:bg-[var(--panel-2)]/80",
            pickerOpen && "bg-[var(--panel-2)]/80",
          )}
        >
          <CircuitBoard className="h-3 w-3 text-[var(--accent)]" />
          <span className="truncate font-mono">{shortModel(model)}</span>
          <ChevronDown
            className={cn(
              "h-3 w-3 text-[var(--muted)] transition-transform",
              pickerOpen && "rotate-180",
            )}
          />
          <ModePill mode={permissionMode} />
        </button>
      ) : (
        <div className="flex w-full items-center gap-1.5 px-2 pb-1.5 pt-2 text-[11px]">
          <CircuitBoard className="h-3 w-3 text-[var(--accent)]" />
          <span className="truncate font-mono">{shortModel(model)}</span>
          <ModePill mode={permissionMode} />
        </div>
      )}

      {/* CWD + metrics row. Whole strip is the cost-overlay trigger so the
          user has a big click target for the most common drill-down. */}
      <button
        type="button"
        onClick={onOpenCost}
        className="block w-full rounded-b-md px-2 pb-2 pt-0 text-left transition hover:bg-[var(--panel-2)]/60"
      >
        {cwd && (
          <div
            className="flex items-center gap-1 text-[10px] text-[var(--muted)]"
            title={cwd}
          >
            <Folder className="h-3 w-3 shrink-0" />
            <span className="truncate font-mono">{fmtPath(cwd, 32)}</span>
          </div>
        )}
        <div className={cn("flex gap-3 text-[10px] text-[var(--muted)]", cwd && "mt-1")}>
          <span>
            {turns} turn{turns === 1 ? "" : "s"}
          </span>
          <span>{fmtElapsedSec(elapsedSec)}</span>
        </div>
      </button>

      {pickerOpen && pickerEnabled && (
        <ModelPicker
          sessionId={sessionId}
          currentModel={model}
          anchorRef={modelButtonRef}
          onClose={() => setPickerOpen(false)}
          onPickModel={async (value) => {
            await onChangeModel?.(value);
            // Keep the picker open so the user can also pick an effort
            // level for the freshly-selected model. They close it via
            // click-outside / Escape, matching the dropdown convention.
          }}
          onPickEffort={async (level) => {
            await onChangeEffort?.(level);
            setPickerOpen(false);
          }}
        />
      )}
    </div>
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
    <span
      className={`ml-auto inline-flex items-center gap-1 rounded border px-1.5 py-px text-[9px] ${tone}`}
    >
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
