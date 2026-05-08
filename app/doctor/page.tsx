"use client";

import { useCallback, useEffect, useState } from "react";
import Link from "next/link";
import { ArrowLeft, AlertTriangle, CheckCircle2, RefreshCw, Stethoscope, XCircle } from "lucide-react";
import { SideNav } from "@/components/nav/SideNav";
import { cn } from "@/lib/utils/cn";

type Check = { id: string; label: string; status: "ok" | "warn" | "fail"; detail?: string };
type Report = {
  runtime: { node: string; platform: string; arch: string };
  sdk: { version: string | null };
  checks: Check[];
};

export default function DoctorPage() {
  const [report, setReport] = useState<Report | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);

  const refresh = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const res = await fetch("/api/doctor");
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      setReport((await res.json()) as Report);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  return (
    <div className="flex h-full">
      <SideNav running={false} />
      <main className="flex h-full flex-1 flex-col overflow-hidden">
        <header className="flex h-9 shrink-0 items-center gap-3 border-b border-[var(--border)] bg-[var(--panel)] px-4 text-xs">
          <Link href="/" className="flex items-center gap-1 text-[var(--muted)] hover:text-[var(--foreground)]">
            <ArrowLeft className="h-3.5 w-3.5" /> Chat
          </Link>
          <span className="opacity-50">·</span>
          <Stethoscope className="h-3.5 w-3.5 text-[var(--muted)]" />
          <span className="font-medium">Doctor</span>
          {loading && <span className="text-[var(--muted)]">running checks…</span>}
          {error && <span className="text-red-400">{error}</span>}
          <button
            onClick={refresh}
            className="ml-auto flex items-center gap-1 rounded-md border border-[var(--border)] bg-[var(--panel-2)] px-2 py-0.5 hover:bg-[var(--panel)]"
          >
            <RefreshCw className="h-3 w-3" /> Re-run
          </button>
        </header>

        <div className="flex-1 overflow-y-auto scroll-thin">
          <div className="mx-auto max-w-3xl space-y-5 px-6 py-6">
            {report && (
              <>
                <section className="rounded-lg border border-[var(--border)] bg-[var(--panel)]/40 p-4 text-xs">
                  <div className="grid grid-cols-2 gap-2 sm:grid-cols-4">
                    <Stat label="Node" value={report.runtime.node} />
                    <Stat label="Platform" value={report.runtime.platform} />
                    <Stat label="Arch" value={report.runtime.arch} />
                    <Stat label="Agent SDK" value={report.sdk.version ?? "—"} />
                  </div>
                </section>

                <section>
                  <h2 className="mb-2 text-[11px] font-medium uppercase tracking-wide text-[var(--muted)]">
                    Checks
                  </h2>
                  <ul className="space-y-1.5">
                    {report.checks.map((c) => (
                      <li
                        key={c.id}
                        className={cn(
                          "flex items-start gap-3 rounded-md border px-3 py-2 text-xs",
                          c.status === "ok" && "border-emerald-500/30 bg-emerald-500/5",
                          c.status === "warn" && "border-amber-500/30 bg-amber-500/5",
                          c.status === "fail" && "border-red-500/30 bg-red-500/5",
                        )}
                      >
                        {c.status === "ok" && (
                          <CheckCircle2 className="mt-0.5 h-4 w-4 shrink-0 text-emerald-400" />
                        )}
                        {c.status === "warn" && (
                          <AlertTriangle className="mt-0.5 h-4 w-4 shrink-0 text-amber-400" />
                        )}
                        {c.status === "fail" && (
                          <XCircle className="mt-0.5 h-4 w-4 shrink-0 text-red-400" />
                        )}
                        <div className="min-w-0 flex-1">
                          <div className="font-medium">{c.label}</div>
                          {c.detail && (
                            <div className="mt-0.5 break-all font-mono text-[11px] text-[var(--muted)]">
                              {c.detail}
                            </div>
                          )}
                        </div>
                      </li>
                    ))}
                  </ul>
                </section>
              </>
            )}
          </div>
        </div>
      </main>
    </div>
  );
}

function Stat({ label, value }: { label: string; value: string }) {
  return (
    <div className="rounded-md border border-[var(--border)] bg-[var(--panel-2)]/40 px-3 py-2">
      <div className="text-[10px] uppercase tracking-wide text-[var(--muted)]">{label}</div>
      <div className="mt-0.5 font-mono">{value}</div>
    </div>
  );
}
