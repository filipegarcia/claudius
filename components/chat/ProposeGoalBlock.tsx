"use client";

import { useMemo, useState } from "react";
import { CheckCircle2, ChevronDown, ChevronRight, Target } from "lucide-react";
import { cn } from "@/lib/utils/cn";

type Props = {
  input: Record<string, unknown>;
  result?: { content: string; isError?: boolean };
  /** Initial expand state; ultra-verbose passes true. Defaults to open while
   *  no result is in — the proposed condition is the thing to read. */
  defaultOpen?: boolean;
};

function str(v: unknown): string | undefined {
  return typeof v === "string" && v ? v : undefined;
}

function safeJsonObject(content: string | undefined): Record<string, unknown> | null {
  if (!content) return null;
  try {
    const o: unknown = JSON.parse(content);
    return o && typeof o === "object" ? (o as Record<string, unknown>) : null;
  } catch {
    return null;
  }
}

/**
 * Renders the SDK `ProposeGoal` tool call (SDK 0.3.227+). The agent proposes a
 * completion condition — verifiable from the conversation — that either goes to
 * the user for approval (`ask_user`, the default) or is set directly when the
 * user's own words already asked for that outcome. Distinct from Claudius's own
 * goal banner (driven by the `report_goal_achieved` MCP tool): this card is the
 * transcript record of the SDK-side proposal, not the banner state.
 */
export function ProposeGoalBlock({ input, result, defaultOpen }: Props) {
  const [open, setOpen] = useState(defaultOpen ?? !result);
  const [prevDefaultOpen, setPrevDefaultOpen] = useState(defaultOpen);
  if (prevDefaultOpen !== defaultOpen) {
    setPrevDefaultOpen(defaultOpen);
    if (defaultOpen !== undefined) setOpen(defaultOpen);
  }

  const output = useMemo(() => safeJsonObject(result?.content), [result?.content]);

  // Condition: prefer the SDK's echoed output, fall back to the input.
  const condition = str(output?.condition) ?? str(input.condition);

  // `askUser` (output) records what actually happened; before the result lands
  // we fall back to the requested `ask_user` (defaults to true per the SDK).
  const askUser =
    typeof output?.askUser === "boolean"
      ? (output.askUser as boolean)
      : typeof input.ask_user === "boolean"
        ? (input.ask_user as boolean)
        : true;

  const errored = result?.isError === true;
  const settled = !!result && !errored;

  // Chip state: before a result → "proposing"; after → asked-for-approval vs
  // set-directly; error surfaces plainly.
  const state: { label: string; tone: string } = errored
    ? { label: "error", tone: "border-red-400/30 bg-red-400/10 text-red-300" }
    : !result
      ? { label: "proposing", tone: "border-sky-400/30 bg-sky-400/10 text-sky-300" }
      : askUser
        ? {
            label: "awaiting approval",
            tone: "border-amber-400/30 bg-amber-400/10 text-amber-200",
          }
        : {
            label: "goal set",
            tone: "border-emerald-400/30 bg-emerald-400/10 text-emerald-300",
          };

  return (
    <div
      data-testid="propose-goal-block"
      data-goal-state={state.label.replace(/\s+/g, "-")}
      data-open={open ? "1" : "0"}
      className="my-2 rounded-lg border border-[var(--accent)]/30 bg-[var(--accent)]/5"
    >
      <button
        onClick={() => setOpen((o) => !o)}
        className="flex w-full min-w-0 items-center gap-2 px-3 py-1.5 text-left text-xs hover:bg-[var(--panel-2)]/40"
      >
        {open ? (
          <ChevronDown className="h-3.5 w-3.5 shrink-0 text-[var(--muted)]" />
        ) : (
          <ChevronRight className="h-3.5 w-3.5 shrink-0 text-[var(--muted)]" />
        )}
        <Target className="h-3.5 w-3.5 shrink-0 text-[var(--accent)]" />
        <span className="shrink-0 text-[var(--muted)]">Proposed goal</span>
        {condition && (
          <span className="min-w-0 shrink truncate whitespace-nowrap text-[11px] text-[var(--foreground)]/80">
            {condition}
          </span>
        )}
        <span className="ml-auto flex shrink-0 items-center gap-2 whitespace-nowrap">
          <span
            className={cn(
              "inline-flex items-center gap-1 rounded-md border px-1.5 py-0.5 text-[10px] font-medium",
              state.tone,
            )}
          >
            {settled && !askUser && <CheckCircle2 className="h-3 w-3" />}
            {state.label}
          </span>
        </span>
      </button>

      {open && (
        <div className="space-y-2 border-t border-[var(--accent)]/20 px-3 py-2">
          <div>
            <div className="mb-1 text-[10px] uppercase tracking-wide text-[var(--muted)]">
              Completion condition
            </div>
            {condition ? (
              <div className="whitespace-pre-wrap rounded bg-[var(--panel-2)] px-2 py-1.5 text-[11px] leading-5 text-[var(--foreground)]/90">
                {condition}
              </div>
            ) : (
              <p className="text-[11px] italic text-[var(--muted)]">Proposing a goal…</p>
            )}
          </div>

          <p className="text-[10px] text-[var(--muted)]/80">
            {errored
              ? "The proposal was rejected or failed."
              : !result
                ? askUser
                  ? "Awaiting your approval before this goal is set."
                  : "Setting this goal directly (you can clear it with /goal clear)."
                : askUser
                  ? "Sent for your approval — set it from the goal prompt above the composer."
                  : "Set directly from your earlier request — clear it any time with /goal clear."}
          </p>
        </div>
      )}
    </div>
  );
}
