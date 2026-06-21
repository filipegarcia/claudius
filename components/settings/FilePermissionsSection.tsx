"use client";

import { useState } from "react";
import { FolderLock } from "lucide-react";
import { FilePermissionsModal } from "@/components/onboarding/FilePermissionsModal";
import { useClaudius } from "@/lib/client/useElectron";

/**
 * Settings entry for the macOS file-permission priming flow. Lets the user
 * re-open the first-run modal and re-run the scan to test that the OS
 * Files & Folders prompts fire (or to confirm access is already granted).
 *
 * Desktop-app only — the underlying `window.claudius.permission.*` bridge
 * doesn't exist in the browser build, so we show a muted note there.
 */
export function FilePermissionsSection() {
  const bridge = useClaudius();
  const [open, setOpen] = useState(false);

  return (
    <section className="rounded-lg border border-[var(--border)] bg-[var(--panel)]/40 p-4">
      <div className="flex items-start gap-2">
        <FolderLock className="mt-px h-3.5 w-3.5 text-[var(--accent)]" />
        <div>
          <h2 className="text-sm font-medium">File permissions (macOS)</h2>
          <p className="mt-0.5 text-[11px] text-[var(--muted)]">
            Claudius runs Claude Code, which reads files in the projects you open. macOS
            asks permission the first time anything touches your Desktop, Documents,
            Downloads, Pictures, Music, or Movies folders. Run setup to front-load those
            prompts instead of hitting them at random mid-session.
          </p>
        </div>
      </div>

      {bridge ? (
        <div className="mt-3 flex flex-wrap items-center gap-2">
          <button
            onClick={() => setOpen(true)}
            className="rounded-md border border-[var(--border)] bg-[var(--panel-2)]/40 px-3 py-1.5 text-xs font-medium hover:bg-[var(--panel-2)]"
            data-testid="file-permissions-open"
          >
            Open permissions setup
          </button>
          <span className="text-[11px] text-[var(--muted)]">
            Manage grants in System Settings → Privacy &amp; Security → Files and Folders.
          </span>
        </div>
      ) : (
        <p className="mt-3 rounded-md border border-[var(--border)] bg-[var(--panel-2)]/40 p-2 text-[11px] text-[var(--muted)]">
          Only applies to the Claudius desktop app.
        </p>
      )}

      {open && <FilePermissionsModal onClose={() => setOpen(false)} />}
    </section>
  );
}
