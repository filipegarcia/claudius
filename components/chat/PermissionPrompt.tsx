"use client";

import { useEffect, useState } from "react";
import { ChevronDown, ChevronRight, Shield } from "lucide-react";
import type { PermissionDecision, PermissionRequestEvent } from "@/lib/shared/events";

type Props = {
  request: PermissionRequestEvent;
  onResolve: (decision: PermissionDecision) => void;
};

export function PermissionPrompt({ request, onResolve }: Props) {
  const [showDeny, setShowDeny] = useState(false);
  const [feedback, setFeedback] = useState("");
  const [showInput, setShowInput] = useState(false);

  const summary = request.title ?? `Claude wants to use ${request.displayName ?? request.toolName}`;

  useEffect(() => {
    function onKey(e: KeyboardEvent) {
      if (e.key === "Escape") onResolve({ kind: "deny" });
    }
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onResolve]);

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/60 backdrop-blur-sm" data-permission-modal>
      <div className="w-[min(620px,92vw)] overflow-hidden rounded-xl border border-[var(--border)] bg-[var(--panel)] shadow-2xl">
        <div className="flex items-start gap-3 border-b border-[var(--border)] px-4 py-3">
          <div className="mt-0.5 flex h-7 w-7 items-center justify-center rounded-md bg-[var(--accent)]/15 text-[var(--accent)]">
            <Shield className="h-3.5 w-3.5" />
          </div>
          <div className="min-w-0 flex-1">
            <div className="text-[11px] uppercase tracking-wide text-[var(--muted)]">Permission required</div>
            <div className="mt-0.5 text-sm font-medium">{summary}</div>
            {request.description && (
              <div className="mt-1 text-xs text-[var(--muted)]">{request.description}</div>
            )}
          </div>
        </div>

        <div className="px-4 py-3">
          <button
            onClick={() => setShowInput((s) => !s)}
            className="mb-2 flex items-center gap-1.5 text-[10px] uppercase tracking-wide text-[var(--muted)] hover:text-[var(--foreground)]"
          >
            {showInput ? <ChevronDown className="h-3 w-3" /> : <ChevronRight className="h-3 w-3" />}
            Tool input — {request.toolName}
          </button>
          {showInput && (
            <pre className="max-h-60 overflow-auto rounded bg-[var(--panel-2)] p-2 font-mono text-xs whitespace-pre-wrap scroll-thin">
              {JSON.stringify(request.input, null, 2)}
            </pre>
          )}
        </div>

        <div className="flex flex-wrap items-center gap-2 border-t border-[var(--border)] bg-[var(--panel-2)]/50 px-4 py-3">
          <button
            onClick={() => onResolve({ kind: "allow_once" })}
            className="rounded-md bg-[var(--accent)] px-3 py-1.5 text-sm text-white hover:opacity-90"
          >
            Allow once
          </button>
          <button
            onClick={() => onResolve({ kind: "allow_always_session" })}
            className="rounded-md border border-[var(--border)] bg-[var(--panel)] px-3 py-1.5 text-sm hover:bg-[var(--panel-2)]"
            title="Allow this tool for the rest of this session"
          >
            Always (session)
          </button>
          <button
            onClick={() => onResolve({ kind: "allow_always_save", destination: "projectSettings" })}
            className="rounded-md border border-[var(--border)] bg-[var(--panel)] px-3 py-1.5 text-sm hover:bg-[var(--panel-2)]"
            title="Save an allow rule to .claude/settings.json"
          >
            Always (project)
          </button>
          <button
            onClick={() => onResolve({ kind: "allow_always_save", destination: "userSettings" })}
            className="rounded-md border border-[var(--border)] bg-[var(--panel)] px-3 py-1.5 text-sm hover:bg-[var(--panel-2)]"
            title="Save an allow rule to ~/.claude/settings.json"
          >
            Always (user)
          </button>
          <div className="ml-auto flex items-center gap-2">
            <button
              onClick={() => setShowDeny((s) => !s)}
              className="rounded-md border border-red-500/40 bg-red-500/10 px-3 py-1.5 text-sm text-red-300 hover:bg-red-500/20"
            >
              {showDeny ? "Cancel deny" : "Deny…"}
            </button>
          </div>
        </div>

        {showDeny && (
          <div className="border-t border-[var(--border)] bg-[var(--panel)]/60 px-4 py-3">
            <label className="mb-1 block text-[10px] uppercase tracking-wide text-[var(--muted)]">
              Optional feedback for Claude
            </label>
            <textarea
              autoFocus
              value={feedback}
              onChange={(e) => setFeedback(e.target.value)}
              placeholder="Why are you denying this? (sent back to Claude as the deny message)"
              rows={2}
              className="w-full resize-none rounded-md border border-[var(--border)] bg-[var(--panel-2)] p-2 text-xs focus:border-[var(--accent)]/60 focus:outline-none"
            />
            <div className="mt-2 flex justify-end gap-2">
              <button
                onClick={() => onResolve({ kind: "deny" })}
                className="rounded-md border border-[var(--border)] bg-[var(--panel)] px-3 py-1.5 text-xs hover:bg-[var(--panel-2)]"
              >
                Deny without feedback
              </button>
              <button
                onClick={() => onResolve({ kind: "deny", message: feedback || undefined })}
                className="rounded-md bg-red-500/90 px-3 py-1.5 text-xs text-white hover:bg-red-500"
              >
                Deny with feedback
              </button>
            </div>
          </div>
        )}
      </div>
    </div>
  );
}
