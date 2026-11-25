"use client";

import { useEffect, useState } from "react";
import Link from "next/link";
import type { PermissionMode } from "@anthropic-ai/claude-agent-sdk";
import { worktreeBadge } from "@/lib/client/worktree";
import { Overlay } from "./Overlay";

type Props = {
  sessionId: string | null;
  cwd: string | null;
  model: string | null;
  permissionMode: PermissionMode;
  ready: boolean;
  pending: boolean;
  toolCount: number;
  agentCount: number;
  skillCount: number;
  slashCount: number;
  /** Main-thread agent this session runs as (SDK Options.agent), or null for the default. */
  mainAgent: string | null;
  /** Agent's live effective cwd — differs from `cwd` when it's working in a git worktree. */
  agentCwd: string | null;
  /**
   * Account-switcher profile this session runs under (carried on the SDK
   * `ready` event — see `SessionReadyEvent.account` / `Session.resolveAccountProfile`).
   * Null when no account is configured (SDK using the ambient environment).
   * Claude Code parity, 2.1.275: "the signed-in account ... /status shows it."
   */
  account: { label: string; driftFromActive?: { label: string } } | null;
  onClose: () => void;
};

/**
 * CC 2.1.327 parity — "Added a list in /status of broken agent, skill …
 * files, keybinding errors". Counts what `GET /api/doctor/files` reports
 * across every workspace — the same set /doctor's Config files section
 * lists, so the count always matches what "Open /doctor" shows.
 *
 * CC 2.1.328 — "Added a notice in /status … when an OpenTelemetry exporter
 * has no endpoint and its data would likely be lost". That notice comes
 * back as a `telemetry` problem; its text is shown under the count, as the
 * engine's /status shows it.
 */
function useConfigFileProblemCount(): { count: number; notices: string[] } | null {
  const [count, setCount] = useState<{ count: number; notices: string[] } | null>(null);
  useEffect(() => {
    const controller = new AbortController();
    fetch("/api/doctor/files", { signal: controller.signal })
      .then(async (res) => {
        if (!res.ok) throw new Error(`HTTP ${res.status}`);
        const data = (await res.json()) as { problems?: Array<{ kind?: unknown; reason?: unknown }> };
        const problems = Array.isArray(data.problems) ? data.problems : [];
        const notices = problems.flatMap((p) =>
          p && p.kind === "telemetry" && typeof p.reason === "string" ? [p.reason] : [],
        );
        setCount({ count: problems.length, notices });
      })
      .catch(() => {
        // Leave the row out rather than guess — /doctor still has the list.
      });
    return () => controller.abort();
  }, []);
  return count;
}

/**
 * Human-readable "kind" of the session — the browser analogue of Claude Code's
 * `/status` session-kind line. Every Claudius session is SDK-driven, so instead
 * of the TUI's interactive/print/sdk distinction we surface the launch context
 * that actually varies here: whether it runs as a named subagent, and whether
 * the agent has moved into a git worktree.
 */
function sessionKindLabel(mainAgent: string | null, cwd: string | null, agentCwd: string | null): string {
  const parts: string[] = [];
  parts.push(mainAgent ? `agent “${mainAgent}”` : "interactive");
  if (worktreeBadge(agentCwd, cwd)) parts.push("worktree");
  return parts.join(" · ");
}

export function StatusOverlay({
  sessionId,
  cwd,
  model,
  permissionMode,
  ready,
  pending,
  toolCount,
  agentCount,
  skillCount,
  slashCount,
  mainAgent,
  agentCwd,
  account,
  onClose,
}: Props) {
  const problems = useConfigFileProblemCount();
  const problemCount = problems?.count ?? null;
  return (
    <Overlay title="Session status" subtitle="/status" onClose={onClose} width={520}>
      <dl className="divide-y divide-[var(--border)] text-sm">
        <Row label="Session id" value={<code className="font-mono">{sessionId ?? "—"}</code>} />
        <Row
          label="Account"
          value={
            account ? (
              <span data-testid="status-account">
                {account.label}
                {account.driftFromActive && (
                  <span className="ml-1 text-[var(--muted)]">
                    (switched default to “{account.driftFromActive.label}”)
                  </span>
                )}
              </span>
            ) : (
              <span className="text-[var(--muted)]">ambient environment</span>
            )
          }
        />
        <Row label="Kind" value={sessionKindLabel(mainAgent, cwd, agentCwd)} />
        <Row label="State" value={!ready ? "starting" : pending ? "working" : "idle"} />
        <Row label="Model" value={<code className="font-mono">{model ?? "—"}</code>} />
        <Row label="Permission mode" value={<code className="font-mono">{permissionMode}</code>} />
        <Row label="Working directory" value={<code className="font-mono break-all">{cwd ?? "—"}</code>} />
        <Row
          label="Capabilities"
          value={`${toolCount} tools · ${slashCount} slash commands · ${agentCount} agents · ${skillCount} skills`}
        />
        {problemCount !== null && (
          <Row
            label="Problems"
            value={
              problemCount > 0 ? (
                <span data-testid="status-problems" className="text-amber-400">
                  {problemCount} {problemCount === 1 ? "problem" : "problems"}
                  <span className="text-[var(--muted)]"> · </span>
                  <Link
                    href="/doctor?section=config-files"
                    onClick={onClose}
                    data-testid="status-problems-link"
                    className="text-[var(--accent)] hover:underline"
                  >
                    Open /doctor
                  </Link>
                  {problems?.notices.map((n) => (
                    <span key={n} data-testid="status-notice" className="mt-1 block text-[var(--muted)]">
                      {n}
                    </span>
                  ))}
                </span>
              ) : (
                <span data-testid="status-problems" className="text-[var(--muted)]">
                  No problems
                </span>
              )
            }
          />
        )}
      </dl>
    </Overlay>
  );
}

function Row({ label, value }: { label: string; value: React.ReactNode }) {
  return (
    <div className="grid grid-cols-[140px_1fr] gap-3 px-4 py-2">
      <dt className="text-[11px] uppercase tracking-wide text-[var(--muted)]">{label}</dt>
      <dd className="text-xs">{value}</dd>
    </div>
  );
}
