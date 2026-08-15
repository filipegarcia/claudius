"use client";

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
  onClose: () => void;
};

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
  onClose,
}: Props) {
  return (
    <Overlay title="Session status" subtitle="/status" onClose={onClose} width={520}>
      <dl className="divide-y divide-[var(--border)] text-sm">
        <Row label="Session id" value={<code className="font-mono">{sessionId ?? "—"}</code>} />
        <Row label="Kind" value={sessionKindLabel(mainAgent, cwd, agentCwd)} />
        <Row label="State" value={!ready ? "starting" : pending ? "working" : "idle"} />
        <Row label="Model" value={<code className="font-mono">{model ?? "—"}</code>} />
        <Row label="Permission mode" value={<code className="font-mono">{permissionMode}</code>} />
        <Row label="Working directory" value={<code className="font-mono break-all">{cwd ?? "—"}</code>} />
        <Row
          label="Capabilities"
          value={`${toolCount} tools · ${slashCount} slash commands · ${agentCount} agents · ${skillCount} skills`}
        />
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
