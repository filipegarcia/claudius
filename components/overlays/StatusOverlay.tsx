"use client";

import type { PermissionMode } from "@anthropic-ai/claude-agent-sdk";
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
  onClose: () => void;
};

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
  onClose,
}: Props) {
  return (
    <Overlay title="Session status" subtitle="/status" onClose={onClose} width={520}>
      <dl className="divide-y divide-[var(--border)] text-sm">
        <Row label="Session id" value={<code className="font-mono">{sessionId ?? "—"}</code>} />
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
