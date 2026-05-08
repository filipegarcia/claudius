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
  return (
    <div className="my-1 flex items-center gap-2 text-[11px] text-[var(--muted)]">
      <Icon className={`h-3 w-3 ${meta.tone}`} />
      <span>{entry.label}</span>
      {entry.detail && <span className="opacity-70">— {entry.detail}</span>}
    </div>
  );
}
