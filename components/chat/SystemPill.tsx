"use client";

import {
  AlertTriangle,
  CheckCircle2,
  Clock,
  Cpu,
  GitMerge,
  Info,
  ShieldAlert,
  Webhook,
} from "lucide-react";
import type { SystemEntry } from "@/lib/client/types";

const KIND_META: Record<SystemEntry["kind"], { icon: typeof Info; tone: string }> = {
  init: { icon: Cpu, tone: "text-emerald-400" },
  hook_started: { icon: Webhook, tone: "text-sky-400" },
  hook_response: { icon: CheckCircle2, tone: "text-sky-400" },
  status: { icon: Clock, tone: "text-amber-400" },
  compact_boundary: { icon: GitMerge, tone: "text-violet-400" },
  rate_limit: { icon: AlertTriangle, tone: "text-amber-400" },
  api_retry: { icon: AlertTriangle, tone: "text-amber-400" },
  permission_denied: { icon: ShieldAlert, tone: "text-red-400" },
  info: { icon: Info, tone: "text-[var(--muted)]" },
};

export function SystemPill({ entry }: { entry: SystemEntry }) {
  const meta = KIND_META[entry.kind];
  const Icon = meta.icon;
  // Compact-boundary is a major thread-state transition (the SDK summarized
  // earlier turns into a single context block). Show it as a full-width
  // horizontal rule with the label centered so the user has a clear visual
  // break between pre- and post-compact content rather than a small inline
  // pill that gets lost among hook/status entries.
  if (entry.kind === "compact_boundary") {
    return (
      <div className="my-4 flex w-full items-center gap-3 text-[11px] text-[var(--muted)]">
        <div className="h-px flex-1 bg-[var(--border)]" />
        <div className="flex items-center gap-2 whitespace-nowrap">
          <Icon className={`h-3.5 w-3.5 ${meta.tone}`} />
          <span className="font-medium">{entry.label}</span>
          {entry.detail && <span className="opacity-70">— {entry.detail}</span>}
        </div>
        <div className="h-px flex-1 bg-[var(--border)]" />
      </div>
    );
  }
  return (
    <div className="my-1 flex items-center gap-2 text-[11px] text-[var(--muted)]">
      <Icon className={`h-3 w-3 ${meta.tone}`} />
      <span>{entry.label}</span>
      {entry.detail && <span className="opacity-70">— {entry.detail}</span>}
    </div>
  );
}
