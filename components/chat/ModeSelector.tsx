"use client";

import { useEffect, useRef, useState } from "react";
import type { PermissionMode } from "@anthropic-ai/claude-agent-sdk";
import { ChevronDown, Shield, ShieldAlert, ShieldCheck, ShieldOff, ListChecks, Wand2 } from "lucide-react";
import { cn } from "@/lib/utils/cn";

export const PERMISSION_MODE_ORDER: PermissionMode[] = [
  "default",
  "acceptEdits",
  "auto",
  "plan",
  "dontAsk",
  "bypassPermissions",
];
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
};

export function ModeSelector({ mode, onChange }: Props) {
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLDivElement>(null);
  const meta = PERMISSION_MODE_META[mode];
  const Icon = meta.icon;

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
      <button
        onClick={() => setOpen((o) => !o)}
        className={cn(
          "flex items-center gap-1.5 rounded-md border border-[var(--border)] bg-[var(--panel-2)] px-2 py-1 text-xs",
          "hover:bg-[var(--panel)]",
        )}
        title="Permission mode (Shift+Tab to cycle)"
      >
        <Icon className={`h-3.5 w-3.5 ${meta.tone}`} />
        <span>{meta.label}</span>
        <ChevronDown className="h-3 w-3 opacity-60" />
      </button>
      {open && (
        <div className="absolute right-0 top-full z-30 mt-1 w-72 overflow-hidden rounded-lg border border-[var(--border)] bg-[var(--panel)] shadow-2xl">
          <div className="px-3 py-2 text-[10px] uppercase tracking-wide text-[var(--muted)]">
            Permission mode · Shift+Tab cycles
          </div>
          {ORDER.map((m) => {
            const mm = PERMISSION_MODE_META[m];
            const I = mm.icon;
            const active = m === mode;
            return (
              <button
                key={m}
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

export function nextPermissionMode(mode: PermissionMode): PermissionMode {
  const idx = ORDER.indexOf(mode);
  if (idx < 0) return "default";
  return ORDER[(idx + 1) % ORDER.length];
}
