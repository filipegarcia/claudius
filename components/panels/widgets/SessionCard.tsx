"use client";

import { useEffect, useRef, useState } from "react";
import { ChevronDown, CircuitBoard, Folder, Gauge, ShieldCheck, Workflow, Zap } from "lucide-react";
import type { PermissionMode } from "@anthropic-ai/claude-agent-sdk";
import type { SessionUsage } from "@/lib/client/types";
import { cn } from "@/lib/utils/cn";
import { fmtElapsedSec, fmtPath } from "./format";
import { ModelPicker } from "./ModelPicker";

type EffortLevel = "low" | "medium" | "high" | "xhigh" | "max" | "auto";

type Props = {
  sessionId: string | null;
  model: string | null;
  /**
   * Currently selected reasoning effort. Rendered as a small pill next to
   * the mode indicator. Defaults to `"auto"` when the session hasn't had
   * an explicit pick yet (adaptive thinking).
   */
  effort: EffortLevel;
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
  /**
   * Whether "ultracode" (Dynamic Workflows) is on. Rendered as a small badge
   * next to the effort pill when enabled.
   */
  ultracode?: boolean;
  /** Toggle ultracode (Dynamic Workflows). Surfaced in the picker on xhigh-capable models. */
  onChangeUltracode?: (enabled: boolean) => Promise<void> | void;
  /**
   * Whether "fast mode" is on. Rendered as a small amber badge next to the
   * ultracode badge when enabled.
   */
  fastMode?: boolean;
  /** Toggle fast mode. Surfaced in the picker on fast-capable models. */
  onChangeFast?: (enabled: boolean) => Promise<void> | void;
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
  effort,
  permissionMode,
  cwd,
  usage,
  historicalTurnCount,
  onOpenCost,
  onChangeModel,
  onChangeEffort,
  ultracode = false,
  onChangeUltracode,
  fastMode = false,
  onChangeFast,
}: Props) {
  // Use `usage.durationMs` when present (server-known); otherwise track
  // wall time from when we first saw a non-null sessionId. The "first
  // saw" is captured in `boundAt`, reset on unbind, refreshed on rebind.
  // Reset happens during render via the "store previous props" pattern
  // so the effect below only handles the impure `Date.now()` read.
  // https://react.dev/reference/react/useState#storing-information-from-previous-renders
  const [boundAt, setBoundAt] = useState<number | null>(null);
  const [lastSessionId, setLastSessionId] = useState(sessionId);
  if (lastSessionId !== sessionId) {
    setLastSessionId(sessionId);
    if (!sessionId) setBoundAt(null);
  }
  // `Date.now()` is impure so it can't be called during render; capture
  // it in an effect once a new sessionId is observed. Intentional sync
  // setState — this effect's only job is to seed `boundAt` once after
  // the render-phase reset above has cleared it. The setState fires
  // exactly when `boundAt` flips null → some-timestamp, then stays put.
  useEffect(() => {
    if (sessionId && boundAt === null) {
      // eslint-disable-next-line react-hooks/set-state-in-effect
      setBoundAt(Date.now());
    }
  }, [sessionId, boundAt]);

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
      {/* Header — the model name gets its own line so the status pills can't
          squeeze it (the old single-row layout truncated the model to
          "defa…" and wrapped "very high" onto two lines). The pills drop to a
          quieter second row below. Both the interactive (picker) and
          read-only branches render the same <CardHead>, so the two can't
          drift apart when one is edited. */}
      {pickerEnabled ? (
        <button
          ref={modelButtonRef}
          type="button"
          data-testid="model-picker-trigger"
          onClick={() => setPickerOpen((o) => !o)}
          aria-haspopup="dialog"
          aria-expanded={pickerOpen}
          className={cn(
            "block w-full rounded-t-md px-2 pb-1.5 pt-2 text-left text-[11px] transition",
            "hover:bg-[var(--panel-2)]/80",
            pickerOpen && "bg-[var(--panel-2)]/80",
          )}
        >
          <CardHead
            model={model}
            effort={effort}
            permissionMode={permissionMode}
            ultracode={ultracode}
            fastMode={fastMode}
            pickerOpen={pickerOpen}
          />
        </button>
      ) : (
        <div className="px-2 pb-1.5 pt-2 text-[11px]">
          <CardHead
            model={model}
            effort={effort}
            permissionMode={permissionMode}
            ultracode={ultracode}
            fastMode={fastMode}
          />
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
          ultracode={ultracode}
          onToggleUltracode={
            onChangeUltracode
              ? async (enabled) => {
                  await onChangeUltracode(enabled);
                  setPickerOpen(false);
                }
              : undefined
          }
          fastMode={fastMode}
          onToggleFast={
            onChangeFast
              ? async (enabled) => {
                  await onChangeFast(enabled);
                  setPickerOpen(false);
                }
              : undefined
          }
        />
      )}
    </div>
  );
}

/**
 * Shared header for both the interactive (picker) and read-only renders of
 * the card. Two rows: the model name on its own line (so it never truncates
 * just to make room for pills), and a quieter status row underneath. Kept as
 * `<span>` pills inside the parent `<button>` so the whole header stays a
 * single click target (no nested buttons).
 */
function CardHead({
  model,
  effort,
  permissionMode,
  ultracode,
  fastMode,
  pickerOpen,
}: {
  model: string | null;
  effort: EffortLevel;
  permissionMode: PermissionMode;
  ultracode: boolean;
  fastMode: boolean;
  /** When provided, renders the picker chevron and reflects its open state. */
  pickerOpen?: boolean;
}) {
  return (
    <>
      <div className="flex items-center gap-1.5">
        <CircuitBoard className="h-3 w-3 shrink-0 text-[var(--accent)]" />
        <span className="truncate font-mono">{shortModel(model)}</span>
        {pickerOpen !== undefined && (
          <ChevronDown
            className={cn(
              "ml-auto h-3 w-3 shrink-0 text-[var(--muted)] transition-transform",
              pickerOpen && "rotate-180",
            )}
          />
        )}
      </div>
      <div className="mt-1.5 flex flex-wrap items-center gap-1">
        <EffortPill effort={effort} />
        {ultracode && <UltracodeBadge />}
        {fastMode && <FastBadge />}
        <ModePill mode={permissionMode} />
      </div>
    </>
  );
}

function ModePill({ mode }: { mode: PermissionMode }) {
  // Only non-default permission postures carry color — `bypass` (red),
  // `plan` (violet), `acceptEdits` (emerald). The everyday `default` mode
  // stays muted so it doesn't compete with the genuinely attention-worthy
  // states. This is the single "loud" slot in the status row.
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
      className={`inline-flex shrink-0 items-center gap-1 whitespace-nowrap rounded border px-1.5 py-px text-[9px] ${tone}`}
    >
      <ShieldCheck className="h-2.5 w-2.5" />
      {MODE_LABEL[mode] ?? mode}
    </span>
  );
}

/**
 * "Ultracode" (Dynamic Workflows) badge. Only rendered when ultracode is on
 * — its presence is the signal, so there's no "off" state to show.
 */
function UltracodeBadge() {
  return (
    <span
      className="inline-flex shrink-0 items-center gap-1 whitespace-nowrap rounded border border-[var(--accent)]/40 bg-[var(--accent)]/10 px-1.5 py-px text-[9px] text-[var(--accent)]"
      title="Dynamic Workflows: xhigh effort + parallel subagents"
    >
      <Workflow className="h-2.5 w-2.5" />
      workflows
    </span>
  );
}

/**
 * "Fast mode" badge. Only rendered when fast mode is on — its presence is the
 * signal, so there's no "off" state to show. Amber to match the picker's fast
 * chip.
 */
function FastBadge() {
  return (
    <span
      className="inline-flex shrink-0 items-center gap-1 whitespace-nowrap rounded border border-amber-500/30 bg-amber-500/10 px-1.5 py-px text-[9px] text-amber-200"
      title="Fast mode: accelerated responses"
    >
      <Zap className="h-2.5 w-2.5" />
      fast
    </span>
  );
}

const EFFORT_LABEL: Record<EffortLevel, string> = {
  auto: "auto",
  low: "low",
  medium: "med",
  high: "high",
  xhigh: "very high",
  max: "max",
};

/**
 * Compact effort indicator. Effort is informational, not alarming, so it
 * uses one calm muted treatment rather than the ModelPicker's per-level
 * color scale — three saturated pills (effort + workflows + mode) all
 * fighting for attention is what made the card read as crowded. The label
 * ("very high", "max", …) still carries the level at a glance. Always
 * renders — even on models that don't support effort, "auto" is the honest
 * answer.
 */
function EffortPill({ effort }: { effort: EffortLevel }) {
  return (
    <span
      data-testid="session-card-effort-pill"
      data-effort={effort}
      title={`Reasoning effort: ${EFFORT_LABEL[effort]}`}
      className="inline-flex shrink-0 items-center gap-1 whitespace-nowrap rounded border border-[var(--border)] bg-[var(--panel)] px-1.5 py-px text-[9px] text-[var(--muted)]"
    >
      <Gauge className="h-2.5 w-2.5" />
      {EFFORT_LABEL[effort]}
    </span>
  );
}

function shortModel(m: string | null): string {
  if (!m) return "—";
  // trim "claude-" prefix and version suffixes for compactness
  return m.replace(/^claude-/, "").replace(/-\d{8}$/, "");
}
