"use client";

import { useEffect, useRef, useState } from "react";
import type { PermissionMode } from "@anthropic-ai/claude-agent-sdk";
import { ChevronDown, Shield, ShieldAlert, ShieldCheck, ShieldOff, ListChecks, Wand2 } from "lucide-react";
import { cn } from "@/lib/utils/cn";
import { PERMISSION_MODE_ORDER, nextPermissionMode } from "@/lib/shared/permission-modes";

export { PERMISSION_MODE_ORDER, nextPermissionMode };
const ORDER = PERMISSION_MODE_ORDER;

export const PERMISSION_MODE_META: Record<PermissionMode, { label: string; description: string; icon: typeof Shield; tone: string }> = {
  default: {
    label: "Default",
    description: "Prompt for risky tools",
    icon: Shield,
    tone: "text-[var(--muted)]",
  },
  acceptEdits: {
    label: "Accept edits",
    description: "Auto-approve file edits, prompt for the rest",
    icon: ShieldCheck,
    tone: "text-emerald-400",
  },
  auto: {
    label: "Auto",
    description: "Auto-approve with background safety checks",
    icon: Wand2,
    tone: "text-sky-400",
  },
  plan: {
    label: "Plan",
    description: "Read-only — produce a plan, no tool side effects",
    icon: ListChecks,
    tone: "text-violet-400",
  },
  dontAsk: {
    label: "Don't ask",
    description: "Never prompt — auto-deny anything not pre-approved",
    icon: ShieldAlert,
    tone: "text-amber-400",
  },
  bypassPermissions: {
    label: "Bypass",
    description: "Never prompt — auto-allow everything (dangerous)",
    icon: ShieldOff,
    tone: "text-red-400",
  },
};

type Props = {
  mode: PermissionMode;
  onChange: (m: PermissionMode) => void;
  /**
   * Modes to hide from the dropdown entirely — currently only used for
   * `["auto"]` when the `disableAutoMode` setting is on (see
   * `useDisableAutoMode`). The active mode still renders normally in the
   * trigger button even if disabled, so a session already in a
   * since-disabled mode doesn't look broken; it just can't be re-selected.
   */
  disabledModes?: PermissionMode[];
};

export function ModeSelector({ mode, onChange, disabledModes }: Props) {
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLDivElement>(null);
  const meta = PERMISSION_MODE_META[mode];
  const Icon = meta.icon;
  const visibleOrder = disabledModes?.length
    ? ORDER.filter((m) => m === mode || !disabledModes.includes(m))
    : ORDER;

  // CC 2.1.210 parity: "Screen reader mode now announces permission mode
  // changes aloud when cycling modes with Shift+Tab." Claudius has the same
  // Shift+Tab cycle (see `nextPermissionMode`); rather than porting a
  // separate opt-in "screen reader mode" toggle, this announces via a
  // standard `aria-live` region always — it's silent for sighted users and
  // read automatically by whatever assistive tech is already running, no
  // discovery step required. Fires regardless of whether the mode changed
  // via Shift+Tab or a dropdown click, since both are "the mode changed"
  // from the user's perspective.
  //
  // `prevModeRef` is seeded with a lazy initializer (runs exactly once, on
  // the very first render — unaffected by React 18 Strict Mode's
  // mount→cleanup→mount double-invoke of effects) rather than a boolean
  // "have we mounted yet" latch in the effect body. A latch flips to `true`
  // on the double-invoked mount's first pass and stays `true` for the
  // second pass, which then misreads its own re-run as a real change and
  // announces the *initial* mode on load — this compare-against-last-seen
  // form is idempotent under that double-invoke instead.
  const [announcement, setAnnouncement] = useState("");
  const prevModeRef = useRef(mode);
  useEffect(() => {
    if (prevModeRef.current === mode) return;
    prevModeRef.current = mode;
    setAnnouncement(`Permission mode: ${meta.label} — ${meta.description}`);
  }, [mode, meta.label, meta.description]);

  useEffect(() => {
    if (!open) return;
    function onClick(e: MouseEvent) {
      if (!ref.current?.contains(e.target as Node)) setOpen(false);
    }
    function onEsc(e: KeyboardEvent) {
      if (e.key === "Escape") setOpen(false);
    }
    window.addEventListener("mousedown", onClick);
    window.addEventListener("keydown", onEsc);
    return () => {
      window.removeEventListener("mousedown", onClick);
      window.removeEventListener("keydown", onEsc);
    };
  }, [open]);

  return (
    <div ref={ref} className="relative">
      {/* Visually hidden — announces mode changes to screen readers without
          affecting sighted layout. `role="status"` + `aria-live="polite"`
          waits for the current speech/focus to finish before reading. */}
      <span
        data-testid="mode-selector-announcement"
        role="status"
        aria-live="polite"
        className="sr-only"
      >
        {announcement}
      </span>
      <button
        data-testid="mode-selector-trigger"
        onClick={() => setOpen((o) => !o)}
        className={cn(
          "flex items-center gap-1.5 rounded-md border border-[var(--border)] bg-[var(--panel-2)] px-2 py-1 text-xs",
          "hover:bg-[var(--panel)]",
        )}
        // Include the active mode + description in the tooltip — the visible
        // label collapses on narrow chat-area widths (icon-only) so the title
        // is the user's textual fallback. The keyboard hint stays appended.
        title={`Permission mode: ${meta.label} — ${meta.description}\nShift+Tab to cycle`}
      >
        <Icon className={`h-3.5 w-3.5 ${meta.tone}`} />
        {/* Collapse the mode label ("Default" / "Accept edits" / "Bypass"…)
            to icon-only when the StatusLine container is below ~768px. This
            button is rendered inside StatusLine's `@container/statusline`
            named ancestor, so the variant resolves against the chat-area
            width (not the viewport) — which is what we want, since the
            chat area shrinks when the right activity rail is open. Without
            this, "Bypass" was the chip that overflowed and clipped at the
            window edge on narrow Electron windows. The button's title
            ("Permission mode (Shift+Tab to cycle)") plus the dropdown
            preserve the full label when the user needs it. */}
        <span className="hidden @3xl/statusline:inline">{meta.label}</span>
        <ChevronDown className="h-3 w-3 opacity-60" />
      </button>
      {open && (
        <div className="absolute right-0 top-full z-30 mt-1 w-72 overflow-hidden rounded-lg border border-[var(--border)] bg-[var(--panel)] shadow-2xl">
          <div className="px-3 py-2 text-[10px] uppercase tracking-wide text-[var(--muted)]">
            Permission mode · Shift+Tab cycles
          </div>
          {visibleOrder.map((m) => {
            const mm = PERMISSION_MODE_META[m];
            const I = mm.icon;
            const active = m === mode;
            return (
              <button
                key={m}
                data-testid={`mode-selector-option-${m}`}
                onClick={() => {
                  onChange(m);
                  setOpen(false);
                }}
                className={cn(
                  "flex w-full items-start gap-2 px-3 py-2 text-left text-xs",
                  "hover:bg-[var(--panel-2)]",
                  active && "bg-[var(--panel-2)]",
                )}
              >
                <I className={`mt-0.5 h-3.5 w-3.5 shrink-0 ${mm.tone}`} />
                <div className="min-w-0 flex-1">
                  <div className="font-medium">{mm.label}</div>
                  <div className="text-[var(--muted)]">{mm.description}</div>
                </div>
                {active && <span className="text-[10px] text-[var(--accent)]">●</span>}
              </button>
            );
          })}
        </div>
      )}
    </div>
  );
}

