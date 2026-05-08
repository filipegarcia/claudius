"use client";

import { useEffect, useState } from "react";
import { AlertTriangle, Save, Shield } from "lucide-react";
import { useLimits } from "@/lib/client/useLimits";

type Props = {
  cwd: string | null;
  /** Today's accumulated USD spend (from the project Cost data). */
  todaySpendUsd: number;
};

export function LimitsPanel({ cwd, todaySpendUsd }: Props) {
  const { state, loading, error, save } = useLimits(cwd);
  const [projectDailyUsd, setProjectDailyUsd] = useState<string>("");
  const [sessionUsd, setSessionUsd] = useState<string>("");
  const [saving, setSaving] = useState(false);
  const [savedTick, setSavedTick] = useState(0);

  // Hydrate inputs from server state when it lands.
  useEffect(() => {
    if (!state) return;
    setProjectDailyUsd(toInputStr(state.limits.projectDailyUsd));
    setSessionUsd(toInputStr(state.limits.sessionUsd));
  }, [state]);

  async function onSave() {
    setSaving(true);
    try {
      const ok = await save({
        projectDailyUsd: parseUsd(projectDailyUsd),
        sessionUsd: parseUsd(sessionUsd),
      });
      if (ok) setSavedTick((t) => t + 1);
    } finally {
      setSaving(false);
    }
  }

  if (cwd == null) {
    return (
      <div className="mx-auto max-w-2xl px-6 py-12 text-center text-sm text-[var(--muted)]">
        No active workspace.
      </div>
    );
  }

  const projectCap = state?.limits.projectDailyUsd ?? 0;
  const projectBreached = projectCap > 0 && todaySpendUsd >= projectCap;

  return (
    <div className="mx-auto max-w-2xl px-6 py-6">
      <header className="mb-4 flex items-center gap-2">
        <Shield className="h-4 w-4 text-[var(--accent)]" />
        <h2 className="text-base font-semibold">Spending limits</h2>
        {error && <span className="ml-auto text-xs text-red-400">{error}</span>}
      </header>

      <p className="mb-4 text-[12px] leading-5 text-[var(--muted)]">
        Caps are enforced client-side using the per-turn <code className="font-mono">total_cost_usd</code>
        the SDK already reports. They do not affect Anthropic-side billing or rate limits — for that, see
        your account dashboard.
      </p>

      {projectBreached && (
        <div className="mb-4 rounded-md border border-red-500/30 bg-red-500/10 px-3 py-2 text-xs text-red-300">
          <div className="flex items-center gap-1.5">
            <AlertTriangle className="h-3.5 w-3.5" />
            Project daily cap reached: ${todaySpendUsd.toFixed(2)} of ${projectCap.toFixed(2)}
          </div>
        </div>
      )}

      <section className="mb-5 rounded-lg border border-[var(--border)] bg-[var(--panel)]/40 p-4">
        <Field
          label="Project daily cap (USD)"
          hint="Soft warning at the project header; does not auto-pause sessions today."
        >
          <input
            value={projectDailyUsd}
            onChange={(e) => setProjectDailyUsd(e.target.value)}
            inputMode="decimal"
            placeholder="0 (disabled)"
            className="w-32 rounded-md border border-[var(--border)] bg-[var(--panel-2)] px-2 py-1 font-mono text-sm focus:outline-none"
          />
        </Field>

        <div className="my-3 border-t border-[var(--border)]/50" />

        <Field
          label="Per-session cap (USD)"
          hint="When a session's accumulated cost exceeds this, Send is disabled until you click Continue (override) on the chat banner."
        >
          <input
            value={sessionUsd}
            onChange={(e) => setSessionUsd(e.target.value)}
            inputMode="decimal"
            placeholder="0 (disabled)"
            className="w-32 rounded-md border border-[var(--border)] bg-[var(--panel-2)] px-2 py-1 font-mono text-sm focus:outline-none"
          />
        </Field>

        <div className="mt-4 flex items-center justify-end gap-2">
          {savedTick > 0 && <span className="text-[11px] text-emerald-400">Saved.</span>}
          <button
            onClick={onSave}
            disabled={saving || loading}
            className="flex items-center gap-1 rounded-md bg-[var(--accent)] px-3 py-1.5 text-xs text-white hover:opacity-90 disabled:opacity-40"
          >
            <Save className="h-3 w-3" /> {saving ? "Saving…" : "Save"}
          </button>
        </div>
      </section>

      <section>
        <h3 className="mb-2 text-[11px] font-medium uppercase tracking-wide text-[var(--muted)]">
          Audit log
        </h3>
        {state?.audit.length ? (
          <ul className="space-y-1 text-[11px]">
            {state.audit
              .slice()
              .reverse()
              .slice(0, 25)
              .map((ev, i) => (
                <li
                  key={`${ev.ts}-${i}`}
                  className="flex items-center gap-2 rounded-md border border-[var(--border)] bg-[var(--panel)]/30 px-2 py-1"
                >
                  <span className="font-mono text-[var(--muted)]">
                    {new Date(ev.ts).toLocaleString()}
                  </span>
                  <span
                    className={
                      ev.kind === "breach"
                        ? "rounded bg-amber-500/15 px-1.5 py-px text-amber-200"
                        : "rounded bg-emerald-500/15 px-1.5 py-px text-emerald-200"
                    }
                  >
                    {ev.kind}
                  </span>
                  <span className="text-[var(--muted)]">
                    {ev.scope}
                    {ev.target ? ` · ${ev.target.slice(0, 8)}…` : ""}
                  </span>
                  <span className="ml-auto font-mono">
                    ${ev.spentUsd.toFixed(3)} / ${ev.capUsd.toFixed(2)}
                  </span>
                </li>
              ))}
          </ul>
        ) : (
          <div className="rounded-md border border-[var(--border)] bg-[var(--panel)]/40 px-3 py-4 text-center text-[11px] text-[var(--muted)]">
            No breaches or overrides yet.
          </div>
        )}
      </section>
    </div>
  );
}

function Field({
  label,
  hint,
  children,
}: {
  label: string;
  hint?: string;
  children: React.ReactNode;
}) {
  return (
    <label className="block">
      <div className="mb-1 text-[11px] font-medium">{label}</div>
      {hint && <div className="mb-2 text-[10px] text-[var(--muted)]">{hint}</div>}
      {children}
    </label>
  );
}

function toInputStr(n: number | undefined | null): string {
  if (!n || !isFinite(n)) return "";
  return String(n);
}

function parseUsd(s: string): number {
  const v = parseFloat(s.trim());
  return isFinite(v) && v > 0 ? v : 0;
}
