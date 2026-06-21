"use client";

/**
 * First-run (and re-testable) macOS file-permission priming modal.
 *
 * Claudius embeds Claude Code, which may read files anywhere you point a
 * workspace. macOS gates Desktop/Documents/Downloads/Pictures/Music/Movies
 * behind a per-folder TCC consent prompt that otherwise fires at random,
 * mid-session, with no context. This modal explains that and — on the
 * user's say-so — asks the Electron main process to touch each folder once
 * so all the OS prompts appear here, now, where the user understands them.
 *
 * Reused by:
 *  - `components/chrome/FilePermissionsGate.tsx` (shown once on first launch)
 *  - `components/settings/FilePermissionsSection.tsx` (re-open / re-test)
 *
 * Pure UI: all native work goes through `window.claudius.permission.*`.
 */
import { useState } from "react";
import { Check, FolderLock, Loader2, X } from "lucide-react";
import { Overlay } from "@/components/overlays/Overlay";
import { useClaudius } from "@/lib/client/useElectron";
import type { FilePermissionScanResult } from "@/lib/shared/electron";

type Props = {
  onClose: () => void;
};

type Phase = "intro" | "scanning" | "done";

export function FilePermissionsModal({ onClose }: Props) {
  const bridge = useClaudius();
  const [phase, setPhase] = useState<Phase>("intro");
  const [results, setResults] = useState<FilePermissionScanResult[] | null>(null);

  async function handleAllow() {
    if (!bridge) return;
    setPhase("scanning");
    const res = await bridge.permission.runScan();
    setResults(res);
    setPhase("done");
  }

  return (
    <Overlay
      title="File access for Claude Code"
      subtitle="Permissions"
      onClose={onClose}
      width={520}
    >
      <div className="space-y-4 p-4 text-sm">
        <div className="flex items-start gap-3">
          <FolderLock className="mt-0.5 h-5 w-5 shrink-0 text-[var(--accent)]" />
          <div className="space-y-2 text-[var(--muted)]">
            <p>
              Claudius runs <span className="text-[var(--foreground)]">Claude Code</span>,
              which reads and writes files in whatever project folder you open. On macOS,
              the system asks permission the first time anything touches your{" "}
              <span className="text-[var(--foreground)]">Desktop, Documents, Downloads,
              Pictures, Music,</span> or <span className="text-[var(--foreground)]">Movies</span>{" "}
              folders.
            </p>
            <p>
              Those prompts normally appear at random, mid-task. Click{" "}
              <span className="text-[var(--foreground)]">Allow &amp; set up</span> and Claudius
              will touch each folder once now, so you can answer all the macOS prompts up
              front instead of being surprised later. Your files stay on your machine.
            </p>
          </div>
        </div>

        {phase === "done" && results && (
          <ul className="space-y-1 rounded-lg border border-[var(--border)] bg-[var(--panel-2)]/40 p-3">
            {results.length === 0 && (
              <li className="text-[12px] text-[var(--muted)]">
                Nothing to set up — this isn&apos;t macOS, so there are no Files &amp; Folders
                prompts to front-load.
              </li>
            )}
            {results.map((r) => (
              <li key={r.category} className="flex items-center gap-2 text-[12px]">
                {r.ok ? (
                  <Check className="h-3.5 w-3.5 text-emerald-500" />
                ) : (
                  <X className="h-3.5 w-3.5 text-red-500" />
                )}
                <span className="text-[var(--foreground)]">{r.category}</span>
                {!r.ok && (
                  <span className="truncate text-[var(--muted)]">
                    — not granted{r.error ? ` (${r.error})` : ""}
                  </span>
                )}
              </li>
            ))}
          </ul>
        )}

        {phase === "done" && (
          <p className="text-[12px] text-[var(--muted)]">
            You can change these anytime in System Settings → Privacy &amp; Security →
            Files and Folders.
          </p>
        )}

        {!bridge && (
          <p className="rounded-md border border-[var(--border)] bg-[var(--panel-2)]/40 p-2 text-[12px] text-[var(--muted)]">
            File-permission setup only applies to the Claudius desktop app.
          </p>
        )}

        <div className="flex flex-wrap items-center justify-end gap-2 pt-1">
          {phase === "done" ? (
            <button
              onClick={onClose}
              className="rounded-md bg-[var(--accent)] px-3 py-1.5 text-[13px] font-medium text-white hover:opacity-90"
            >
              Done
            </button>
          ) : (
            <>
              <button
                onClick={onClose}
                disabled={phase === "scanning"}
                className="rounded-md border border-[var(--border)] px-3 py-1.5 text-[13px] hover:bg-[var(--panel-2)] disabled:opacity-50"
              >
                Not now
              </button>
              <button
                onClick={handleAllow}
                disabled={!bridge || phase === "scanning"}
                className="inline-flex items-center gap-1.5 rounded-md bg-[var(--accent)] px-3 py-1.5 text-[13px] font-medium text-white hover:opacity-90 disabled:opacity-50"
              >
                {phase === "scanning" && <Loader2 className="h-3.5 w-3.5 animate-spin" />}
                Allow &amp; set up
              </button>
            </>
          )}
        </div>
      </div>
    </Overlay>
  );
}
