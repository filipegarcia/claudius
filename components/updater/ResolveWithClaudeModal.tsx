"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { AlertTriangle, CheckCircle2, Loader2, RefreshCw, Sparkles } from "lucide-react";
import { Overlay } from "@/components/overlays/Overlay";

type Phase = "running" | "applied" | "error" | "conflicts" | "skipped" | "no-update";

type ApplyBody = {
  kind?: string;
  reason?: string;
  message?: string;
  phase?: string;
  detail?: string;
};

type StatusBody = {
  state?: {
    status?: { kind?: string };
    conflicts?: unknown;
    recovery?: { phase?: string } | null;
    lastError?: string | null;
  };
};

const isOverloaded = (s: string) => /\b529\b|overloaded/i.test(s);

/**
 * In-place "Resolve with Claude" — replaces the old "spawn a workspace + prefill
 * a chat" flow. On open it auto-runs the SAME in-process resolution the updater
 * uses (`POST /api/updater/apply { allowCcMerge: true }` → heal conflict markers
 * via the SDK, then finish install/build/restart) and tails the updater log so
 * the user watches it happen live. No workspace, no copy-paste.
 *
 * Robustness lessons baked in:
 *   - Show the recent log TAIL on open (not just bytes appended after we
 *     connect), so when we attach to an apply that's already in flight the box
 *     isn't blank.
 *   - A Claude resolve can take minutes when Anthropic's API is busy (529
 *     retries with backoff) and emits no output meanwhile — so we never rely on
 *     the apply POST alone to detect completion. A status poll is the safety
 *     net: when the updater goes idle we settle from its recorded state.
 *   - Surface transient overload (529) with a clear message + Retry instead of
 *     an endless spinner.
 */
export function ResolveWithClaudeModal({
  onClose,
  onDone,
}: {
  onClose: () => void;
  onDone?: () => void;
}) {
  const [log, setLog] = useState("");
  const [phase, setPhase] = useState<Phase>("running");
  const [detail, setDetail] = useState("");
  const offsetRef = useRef(0);
  const logTimer = useRef<ReturnType<typeof setInterval> | null>(null);
  const statusTimer = useRef<ReturnType<typeof setInterval> | null>(null);
  const finishedRef = useRef(false);
  const runningRef = useRef(false);
  const sawApplyingRef = useRef(false);
  const cancelledRef = useRef(false);
  const logBoxRef = useRef<HTMLDivElement | null>(null);

  const stopTimers = useCallback(() => {
    if (logTimer.current) clearInterval(logTimer.current);
    if (statusTimer.current) clearInterval(statusTimer.current);
    logTimer.current = null;
    statusTimer.current = null;
  }, []);

  const pollLog = useCallback(async () => {
    try {
      const r = await fetch(`/api/updater/log?offset=${offsetRef.current}`);
      if (!r.ok) return;
      const j = (await r.json()) as { size?: number; content?: string };
      if (typeof j.content === "string" && j.content.length > 0) {
        offsetRef.current = typeof j.size === "number" ? j.size : offsetRef.current;
        if (!cancelledRef.current) setLog((prev) => prev + j.content);
      }
    } catch {
      // transient (server restarting mid-apply) — next tick retries
    }
  }, []);

  const settle = useCallback(
    (next: Phase, text: string) => {
      if (finishedRef.current) return;
      finishedRef.current = true;
      runningRef.current = false;
      stopTimers();
      void pollLog(); // final flush
      setPhase(next);
      setDetail(text);
      onDone?.();
    },
    [onDone, pollLog, stopTimers],
  );

  const finishFromApply = useCallback(
    (body: ApplyBody) => {
      switch (body.kind) {
        case "applied":
          settle("applied", "Update applied. Claudius is restarting to finish…");
          break;
        case "conflicts": {
          const d = body.detail || "";
          settle(
            "conflicts",
            isOverloaded(d)
              ? "Claude's API was busy (529 Overloaded) — couldn't finish. This is temporary; click Retry in a moment."
              : d || "Some conflicts need a closer look — see the log below.",
          );
          break;
        }
        case "skipped":
          settle("skipped", body.reason || "Nothing to do.");
          break;
        case "no-update":
          settle("no-update", "Already up to date.");
          break;
        default: {
          const m = `${body.phase ? `${body.phase}: ` : ""}${body.message || "The update didn't finish."}`;
          settle("error", isOverloaded(m) ? `${m} — this is a temporary API overload; click Retry.` : m);
        }
      }
    },
    [settle],
  );

  // Safety net: if the apply POST is slow/wedged, settle from the updater's
  // recorded state once it goes idle (having been seen applying).
  const pollStatus = useCallback(async () => {
    try {
      const r = await fetch("/api/updater/status");
      if (!r.ok) return;
      const j = (await r.json()) as StatusBody;
      const st = j.state;
      const kind = st?.status?.kind;
      if (kind === "applying" || kind === "checking" || kind === "restarting") {
        sawApplyingRef.current = true;
      }
      if (finishedRef.current || !sawApplyingRef.current) return;
      if (kind === "idle") {
        if (st?.conflicts) {
          const d = typeof st.lastError === "string" ? st.lastError : "";
          settle(
            "conflicts",
            isOverloaded(d)
              ? "Claude's API was busy (529 Overloaded) — couldn't finish. Temporary; click Retry."
              : "Some conflicts need a closer look — see the log below.",
          );
        } else if (st?.recovery || (st?.lastError && st.lastError.length > 0)) {
          const d = st?.lastError || "The update didn't finish.";
          settle("error", isOverloaded(d) ? `${d} — temporary API overload; click Retry.` : d);
        } else {
          settle("applied", "Update applied.");
        }
      }
    } catch {
      // server may be restarting after a successful apply — treat a later
      // recovery as applied via the POST-reject path instead.
    }
  }, [settle]);

  const start = useCallback(async () => {
    if (runningRef.current) return;
    runningRef.current = true;
    finishedRef.current = false;
    sawApplyingRef.current = false;
    setPhase("running");
    setDetail("");
    setLog("");

    // Show the recent tail (not just new bytes) so attaching to an in-flight
    // apply isn't a blank box.
    try {
      const r0 = await fetch("/api/updater/log");
      const j0 = (await r0.json()) as { size?: number };
      const size = typeof j0.size === "number" ? j0.size : 0;
      offsetRef.current = Math.max(0, size - 4000);
    } catch {
      offsetRef.current = 0;
    }
    if (cancelledRef.current) return;

    logTimer.current = setInterval(() => void pollLog(), 600);
    statusTimer.current = setInterval(() => void pollStatus(), 1500);
    void pollLog();

    // If an apply is already running, attach (the status poll settles it);
    // otherwise kick one off.
    let alreadyApplying = false;
    try {
      const r = await fetch("/api/updater/status");
      const j = (await r.json()) as StatusBody;
      alreadyApplying = j.state?.status?.kind === "applying";
      if (alreadyApplying) sawApplyingRef.current = true;
    } catch {
      // ignore — fall through to triggering
    }
    if (alreadyApplying || cancelledRef.current) return;

    try {
      const res = await fetch("/api/updater/apply", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ allowCcMerge: true }),
      });
      const body = (await res.json()) as ApplyBody;
      if (cancelledRef.current) return;
      finishFromApply(body);
    } catch {
      if (cancelledRef.current) return;
      // Dropped — almost always a successful apply SIGTERM'ing the server to
      // restart. Treat as applied/restarting.
      settle("applied", "Update applied. Claudius is restarting to finish…");
    }
  }, [finishFromApply, pollLog, pollStatus, settle]);

  useEffect(() => {
    cancelledRef.current = false;
    void start();
    return () => {
      cancelledRef.current = true;
      stopTimers();
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  useEffect(() => {
    const el = logBoxRef.current;
    if (el) el.scrollTop = el.scrollHeight;
  }, [log]);

  const lines = log.split("\n").filter((l) => l.trim().length > 0);
  const canRetry = phase === "error" || phase === "conflicts" || phase === "skipped";

  return (
    <Overlay title="Resolve with Claude" subtitle="Self-update" width={680} onClose={onClose}>
      <div className="flex flex-col gap-3 p-4" data-testid="updater-resolve-modal">
        <StatusRow phase={phase} detail={detail} />

        <div
          ref={logBoxRef}
          data-testid="updater-resolve-log"
          className="h-64 overflow-auto rounded-lg border border-[var(--border)] bg-[var(--panel-2)] p-2 font-mono text-[11px] leading-relaxed scroll-thin"
        >
          {lines.length === 0 ? (
            <div className="text-[var(--muted)]">
              {phase === "running"
                ? "Working… resolving conflicts and finishing the update. This can take a few minutes, especially if Claude's API is busy."
                : "No output."}
            </div>
          ) : (
            lines.map((line, i) => <LogLine key={i} line={line} />)
          )}
        </div>

        <div className="flex items-center justify-end gap-2">
          {canRetry && (
            <button
              onClick={() => void start()}
              data-testid="updater-resolve-retry"
              className="flex items-center gap-1 rounded-md border border-[var(--border)] px-3 py-1 text-xs hover:bg-[var(--panel-2)]"
            >
              <RefreshCw className="h-3 w-3" />
              Retry
            </button>
          )}
          {phase === "running" ? (
            <button
              onClick={onClose}
              data-testid="updater-resolve-background"
              className="rounded-md border border-[var(--border)] px-3 py-1 text-xs text-[var(--muted)] hover:bg-[var(--panel-2)]"
              title="Keep resolving in the background — progress continues and the banner updates when it finishes."
            >
              Run in background
            </button>
          ) : (
            <button
              onClick={onClose}
              data-testid="updater-resolve-close"
              className="rounded-md border border-[var(--border)] px-3 py-1 text-xs hover:bg-[var(--panel-2)]"
            >
              Close
            </button>
          )}
        </div>
      </div>
    </Overlay>
  );
}

function StatusRow({ phase, detail }: { phase: Phase; detail: string }) {
  const map: Record<Phase, { icon: React.ReactNode; label: string; tone: string }> = {
    running: {
      icon: <Loader2 className="h-4 w-4 animate-spin text-[var(--accent)]" />,
      label: "Resolving with Claude…",
      tone: "text-[var(--foreground)]",
    },
    applied: {
      icon: <CheckCircle2 className="h-4 w-4 text-emerald-400" />,
      label: "Update applied",
      tone: "text-emerald-300",
    },
    "no-update": {
      icon: <CheckCircle2 className="h-4 w-4 text-emerald-400" />,
      label: "Up to date",
      tone: "text-emerald-300",
    },
    conflicts: {
      icon: <AlertTriangle className="h-4 w-4 text-amber-400" />,
      label: "Needs a closer look",
      tone: "text-amber-300",
    },
    skipped: {
      icon: <Sparkles className="h-4 w-4 text-[var(--muted)]" />,
      label: "Skipped",
      tone: "text-[var(--muted)]",
    },
    error: {
      icon: <AlertTriangle className="h-4 w-4 text-red-400" />,
      label: "Update didn't finish",
      tone: "text-red-300",
    },
  };
  const s = map[phase];
  return (
    <div className="flex items-start gap-2 text-xs" data-testid={`updater-resolve-status-${phase}`}>
      <div className="mt-0.5 shrink-0">{s.icon}</div>
      <div className="min-w-0">
        <div className={`font-medium ${s.tone}`}>{s.label}</div>
        {detail ? <div className="mt-0.5 break-words text-[var(--muted)]">{detail}</div> : null}
      </div>
    </div>
  );
}

function LogLine({ line }: { line: string }) {
  const isClaude = line.startsWith("[claude]");
  const isErr = /\/err\]/.test(line) || /\berror\b/i.test(line);
  const isHeader = line.startsWith("===");
  const cls = isHeader
    ? "text-[var(--accent)]"
    : isClaude
      ? "text-[var(--foreground)]"
      : isErr
        ? "text-red-300/90"
        : "text-[var(--muted)]";
  return <div className={`whitespace-pre-wrap break-words ${cls}`}>{line}</div>;
}
