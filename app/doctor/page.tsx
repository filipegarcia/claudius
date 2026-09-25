"use client";

import { useCallback, useEffect, useState } from "react";
// Same pattern as `app/customize/page.tsx`: data fetch lives inside the
// `useEffect`, keyed by a `refetchTrigger` counter. `refresh()` bumps the
// counter; `setState` happens in Promise callbacks (not sync in the effect
// body), which is what `react-hooks/set-state-in-effect` wants.
import Link from "next/link";
import { ArrowLeft, AlertTriangle, CheckCircle2, RefreshCw, Stethoscope, XCircle } from "lucide-react";
import { SideNav } from "@/components/nav/SideNav";
import { useClaudius } from "@/lib/client/useElectron";
import { cn } from "@/lib/utils/cn";

type Check = {
  id: string;
  label: string;
  status: "ok" | "warn" | "fail";
  detail?: string;
  fixable?: boolean;
  link?: { href: string; label: string };
  /** CC 2.1.283 parity — see `app/api/doctor/route.ts`'s `Check.category`. */
  category?: "prompt-audit";
};
type Report = {
  runtime: { node: string; platform: string; arch: string };
  sdk: { version: string | null };
  checks: Check[];
};

export default function DoctorPage() {
  const [report, setReport] = useState<Report | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const bridge = useClaudius();
  // `/doctor prompt-audit` (and `/checkup prompt-audit`) route here with
  // `?section=prompt-audit` — see `ChatSurface.tsx`'s `case "doctor":`.
  // Scroll the Prompt audit section into view once the report has loaded, so
  // the deep link lands somewhere visible instead of the page top. Reads
  // `window.location.search` directly rather than `useSearchParams()` —
  // `/doctor` is a static route (not nested under `[workspaceId]`), and a
  // static page calling `useSearchParams()` without a `<Suspense>` ancestor
  // fails `next build`'s missing-suspense-boundary check.
  useEffect(() => {
    if (!report) return;
    if (new URLSearchParams(window.location.search).get("section") !== "prompt-audit") return;
    document.getElementById("prompt-audit-section")?.scrollIntoView({ block: "start" });
  }, [report]);

  const [refetchTrigger, setRefetchTrigger] = useState(0);
  // Check id currently being fixed — disables its Fix button and shows a
  // spinner label while the POST is in flight. Cleared (success or failure)
  // once the fix request settles.
  const [fixingId, setFixingId] = useState<string | null>(null);
  const [fixError, setFixError] = useState<string | null>(null);

  useEffect(() => {
    const controller = new AbortController();

    fetch("/api/doctor", { signal: controller.signal })
      .then(async (res) => {
        if (!res.ok) throw new Error(`HTTP ${res.status}`);
        return (await res.json()) as Report;
      })
      .then((d) => {
        setReport(d);
        setError(null);
      })
      .catch((err: unknown) => {
        if (err instanceof DOMException && err.name === "AbortError") return;
        setError(err instanceof Error ? err.message : String(err));
      })
      .finally(() => {
        if (!controller.signal.aborted) setLoading(false);
      });

    return () => controller.abort();
  }, [refetchTrigger]);

  const refresh = useCallback(() => {
    setLoading(true);
    setRefetchTrigger((n) => n + 1);
  }, []);

  const fixCheck = useCallback(
    async (id: string) => {
      setFixingId(id);
      setFixError(null);
      try {
        const res = await fetch("/api/doctor/fix", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ id }),
        });
        const data = (await res.json()) as { ok: boolean; error?: string };
        if (!res.ok || !data.ok) throw new Error(data.error ?? `HTTP ${res.status}`);
        refresh();
      } catch (err) {
        setFixError(err instanceof Error ? err.message : String(err));
      } finally {
        setFixingId(null);
      }
    },
    [refresh],
  );

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
          {fixError && <span className="text-red-400">Fix failed: {fixError}</span>}
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

                {/* Phase 9 of docs/electron-conversion/PLAN.md —
                  * Electron-specific diagnostics shown only when the
                  * preload bridge is mounted. */}
                {bridge && <ElectronSection bridge={bridge} />}

                <section>
                  <h2 className="mb-2 text-[11px] font-medium uppercase tracking-wide text-[var(--muted)]">
                    Checks
                  </h2>
                  <ul className="space-y-1.5">
                    {report.checks
                      .filter((c) => c.category !== "prompt-audit")
                      .map((c) => (
                        <CheckRow key={c.id} check={c} fixingId={fixingId} onFix={fixCheck} />
                      ))}
                  </ul>
                </section>

                {/*
                  CC 2.1.283 parity — "/doctor prompt-audit" (also
                  "/checkup prompt-audit"): audits CLAUDE.md files, skills,
                  agents and commands for prompting patterns written for
                  older models. Own section (not folded into "Checks" above)
                  so the slash command's `?section=prompt-audit` deep link
                  has a stable, discoverable landing spot — see the
                  scroll-into-view effect above.
                */}
                <section id="prompt-audit-section" data-testid="doctor-prompt-audit-section">
                  <h2 className="mb-2 text-[11px] font-medium uppercase tracking-wide text-[var(--muted)]">
                    Prompt audit
                  </h2>
                  {(() => {
                    const promptAuditChecks = report.checks.filter((c) => c.category === "prompt-audit");
                    if (promptAuditChecks.length === 0) {
                      return (
                        <p className="text-[11px] text-[var(--muted)]">
                          No CLAUDE.md files, skills, agents, or commands found to audit yet.
                        </p>
                      );
                    }
                    return (
                      <ul className="space-y-1.5" data-testid="doctor-prompt-audit-list">
                        {promptAuditChecks.map((c) => (
                          <CheckRow key={c.id} check={c} fixingId={fixingId} onFix={fixCheck} />
                        ))}
                      </ul>
                    );
                  })()}
                </section>
              </>
            )}
          </div>
        </div>
      </main>
    </div>
  );
}

/**
 * Single check row — shared by the general "Checks" list and the
 * CC 2.1.283 "Prompt audit" section so both render identically (icon by
 * status, Fix/Review-in-Memory affordance) without duplicating the JSX.
 */
function CheckRow({
  check: c,
  fixingId,
  onFix,
}: {
  check: Check;
  fixingId: string | null;
  onFix: (id: string) => void;
}) {
  return (
    <li
      className={cn(
        "flex items-start gap-3 rounded-md border px-3 py-2 text-xs",
        c.status === "ok" && "border-emerald-500/30 bg-emerald-500/5",
        c.status === "warn" && "border-amber-500/30 bg-amber-500/5",
        c.status === "fail" && "border-red-500/30 bg-red-500/5",
      )}
    >
      {c.status === "ok" && <CheckCircle2 className="mt-0.5 h-4 w-4 shrink-0 text-emerald-400" />}
      {c.status === "warn" && <AlertTriangle className="mt-0.5 h-4 w-4 shrink-0 text-amber-400" />}
      {c.status === "fail" && <XCircle className="mt-0.5 h-4 w-4 shrink-0 text-red-400" />}
      <div className="min-w-0 flex-1">
        <div className="font-medium">{c.label}</div>
        {c.detail && (
          <div className="mt-0.5 break-all font-mono text-[11px] text-[var(--muted)]">{c.detail}</div>
        )}
      </div>
      {c.fixable && c.status !== "ok" && (
        <button
          onClick={() => onFix(c.id)}
          disabled={fixingId === c.id}
          data-testid={`doctor-fix-${c.id}`}
          title={`Create the missing directory for "${c.label}"`}
          className="shrink-0 rounded-md border border-[var(--border)] bg-[var(--panel-2)] px-2 py-0.5 text-[11px] hover:bg-[var(--panel)] disabled:opacity-50"
        >
          {fixingId === c.id ? "Fixing…" : "Fix"}
        </button>
      )}
      {c.link && c.status !== "ok" && (
        <Link
          href={c.link.href}
          data-testid={`doctor-link-${c.id}`}
          className="shrink-0 rounded-md border border-[var(--border)] bg-[var(--panel-2)] px-2 py-0.5 text-[11px] hover:bg-[var(--panel)]"
        >
          {c.link.label}
        </Link>
      )}
    </li>
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

/**
 * Electron-specific stats — surfaced only when the preload bridge is
 * mounted. Helps users (and us!) verify the packaged build is using
 * the expected Electron/Chromium version and that the IPC contract is
 * the one the renderer expects.
 *
 * Phase 9 of docs/electron-conversion/PLAN.md.
 */
function ElectronSection({
  bridge,
}: {
  bridge: NonNullable<Window["claudius"]>;
}) {
  // `process.versions` is gated by sandbox; the bridge surface does
  // not expose it. So we surface what the bridge knows and let the
  // user click through to the official "About Claudius" menu entry
  // for full version info.
  return (
    <section className="rounded-lg border border-[var(--accent)]/30 bg-[var(--accent)]/5 p-4 text-xs">
      <h2 className="mb-2 text-[11px] font-medium uppercase tracking-wide text-[var(--muted)]">
        Electron
      </h2>
      <div className="grid grid-cols-2 gap-2 sm:grid-cols-4">
        <Stat label="Runtime" value="Electron" />
        <Stat label="Platform" value={bridge.platform} />
        <Stat label="Bridge" value={`v${bridge.bridgeVersion}`} />
        <Stat label="Dock badge" value={bridge.platform === "darwin" ? "supported" : bridge.platform === "win32" ? "overlay icon" : "best-effort"} />
      </div>
      <p className="mt-2 text-[11px] text-[var(--muted)]">
        For full Electron / Chromium / Node versions, see Help → About
        Claudius in the app menu. The web build does not render this
        section.
      </p>
    </section>
  );
}
