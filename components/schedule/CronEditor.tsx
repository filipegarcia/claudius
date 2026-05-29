"use client";

import { useMemo } from "react";
import { CRON_PRESETS, describeCron, nextFires, validateCron } from "@/lib/shared/cron";
import { cn } from "@/lib/utils/cn";

type Props = {
  value: string;
  onChange: (cron: string) => void;
};

export function CronEditor({ value, onChange }: Props) {
  const validation = useMemo(() => validateCron(value), [value]);
  const description = validation.ok ? describeCron(validation.cron) : null;
  const previews = validation.ok ? nextFires(validation.cron, 5) : [];

  return (
    <div className="space-y-2">
      <input
        value={value}
        onChange={(e) => onChange(e.target.value)}
        placeholder="*/5 * * * *"
        spellCheck={false}
        className={cn(
          "w-full rounded-md border bg-[var(--panel-2)] px-2 py-1.5 font-mono text-sm focus:outline-none",
          validation.ok ? "border-[var(--border)]" : "border-amber-500/50",
        )}
      />
      <div className="flex flex-wrap gap-1.5">
        {CRON_PRESETS.map((p) => (
          <button
            key={p.cron}
            type="button"
            onClick={() => onChange(p.cron)}
            className={cn(
              "rounded-md border px-2 py-0.5 text-[10px] font-mono",
              value.trim() === p.cron
                ? "border-[var(--accent)] bg-[var(--panel)]"
                : "border-[var(--border)] bg-[var(--panel-2)] hover:bg-[var(--panel)]",
            )}
          >
            {p.label}
          </button>
        ))}
      </div>
      {validation.ok ? (
        <>
          <div className="text-[11px] text-[var(--muted)]">{description}</div>
          <div className="rounded-md border border-[var(--border)] bg-[var(--panel)]/40 p-2">
            <div className="mb-1 text-[10px] uppercase tracking-wide text-[var(--muted)]">Next 5 fires (local)</div>
            <ul className="space-y-0.5 text-[11px]">
              {previews.map((d, i) => (
                <li key={i} className="font-mono text-[var(--foreground)]">
                  {d.toLocaleString()}
                </li>
              ))}
            </ul>
          </div>
        </>
      ) : (
        <div className="rounded-md border border-amber-500/30 bg-amber-500/10 px-2 py-1 text-[11px] text-amber-200">
          {validation.error}
        </div>
      )}
      <div className="text-[10px] text-[var(--muted)]">
        Five-field expression — minute hour day-of-month month day-of-week. No seconds field.
      </div>
    </div>
  );
}
