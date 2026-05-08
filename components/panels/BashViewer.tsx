"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import { Copy, Terminal } from "lucide-react";
import { Overlay } from "@/components/overlays/Overlay";
import type { BackgroundBash, DisplayMessage } from "@/lib/client/types";
import { fmtElapsedSec } from "./widgets/format";

type Props = {
  bash: BackgroundBash;
  /** Top-level transcript — scanned for matching Bash / BashOutput tool_use blocks. */
  messages: DisplayMessage[];
  onClose: () => void;
};

/**
 * Captures every text-bearing tool_result attached to:
 *   - the launching Bash tool_use itself, and
 *   - any subsequent BashOutput tool_use whose `bash_id` input matches.
 * Stitched in transcript order, deduped by tool_use_id.
 *
 * v1 limitation: this surfaces what the agent has already pulled via
 * BashOutput. For a true "live tail" the agent would need to re-fetch — ask
 * Claude to "show new output of bash …" if you don't see recent lines.
 */
function collectBashOutput(bash: BackgroundBash, messages: DisplayMessage[]): string {
  const lines: string[] = [];
  for (const m of messages) {
    if (m.role !== "assistant") continue;
    for (const b of m.blocks) {
      if (b.kind !== "tool_use" || !b.result) continue;
      // Match the launching Bash by tool_use_id …
      if (b.id === bash.toolUseId) {
        lines.push(b.result.content);
        continue;
      }
      // … or any BashOutput whose bash_id input matches.
      if (b.name === "BashOutput") {
        const inputBashId = (b.input as { bash_id?: string }).bash_id;
        if (bash.bashId && inputBashId === bash.bashId) {
          lines.push(b.result.content);
        }
      }
    }
  }
  return lines.join("\n");
}

export function BashViewer({ bash, messages, onClose }: Props) {
  const out = useMemo(() => collectBashOutput(bash, messages), [bash, messages]);
  const preRef = useRef<HTMLPreElement>(null);
  const isNearBottomRef = useRef(true);
  const [copyTick, setCopyTick] = useState(0);
  const [now, setNow] = useState(() => Date.now());

  useEffect(() => {
    const id = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(id);
  }, []);

  // Auto-scroll only when the user is near the bottom — mirror the chat list.
  useEffect(() => {
    const el = preRef.current;
    if (!el) return;
    if (isNearBottomRef.current) el.scrollTop = el.scrollHeight;
  }, [out]);

  function onScroll() {
    const el = preRef.current;
    if (!el) return;
    isNearBottomRef.current = el.scrollHeight - el.scrollTop - el.clientHeight < 60;
  }

  async function onCopy() {
    try {
      await navigator.clipboard.writeText(out || "");
      setCopyTick((t) => t + 1);
    } catch {
      // ignore
    }
  }

  const elapsed = (now - bash.startedAt) / 1000;
  const status = bash.killed ? "killed" : "running";

  return (
    <Overlay
      title={
        <span className="flex items-center gap-1.5 font-mono">
          <Terminal className="h-3.5 w-3.5 text-[var(--accent)]" />
          {bash.command.length > 64 ? bash.command.slice(0, 64) + "…" : bash.command}
        </span>
      }
      subtitle={
        <span className="flex items-center gap-2">
          <span
            className={
              bash.killed
                ? "rounded bg-[var(--panel-2)] px-1.5 py-px text-[var(--muted)]"
                : "rounded bg-emerald-500/15 px-1.5 py-px text-emerald-200"
            }
          >
            {status}
          </span>
          <span>{fmtElapsedSec(elapsed)}</span>
          {bash.bashId && <span className="font-mono">id {bash.bashId}</span>}
        </span>
      }
      onClose={onClose}
      width={720}
    >
      <div className="px-4 py-2 text-[10px] text-[var(--muted)]">
        Output is captured from the agent&apos;s most recent BashOutput poll. Ask Claude to
        re-check the shell to see fresh lines.
      </div>
      <pre
        ref={preRef}
        onScroll={onScroll}
        className="max-h-[60vh] overflow-auto bg-[var(--background)] p-3 font-mono text-[11px] leading-4 whitespace-pre-wrap scroll-thin"
      >
        {out || "(no output captured yet)"}
      </pre>
      <div className="flex items-center gap-2 border-t border-[var(--border)] bg-[var(--panel-2)]/50 px-4 py-3">
        <button
          type="button"
          onClick={onCopy}
          className="flex items-center gap-1 rounded-md border border-[var(--border)] bg-[var(--panel)] px-3 py-1.5 text-xs hover:bg-[var(--panel-2)]"
        >
          <Copy className="h-3 w-3" /> {copyTick > 0 ? "Copied!" : "Copy output"}
        </button>
        <button
          type="button"
          onClick={onClose}
          className="ml-auto rounded-md border border-[var(--border)] bg-[var(--panel-2)] px-3 py-1.5 text-xs hover:bg-[var(--panel)]"
        >
          Close
        </button>
      </div>
    </Overlay>
  );
}
