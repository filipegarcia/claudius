"use client";

import { useCallback, useEffect, useState } from "react";
import { useRouter } from "next/navigation";
import { Loader2 } from "lucide-react";
import { Overlay } from "@/components/overlays/Overlay";
import { ReleaseNoteSection } from "@/components/updater/ReleaseNoteSection";
import { useElectronAction } from "@/lib/client/useElectron";
import {
  loadReleaseNotes,
  onOpenWhatsNew,
  readLastSeenVersion,
  rememberSeenVersion,
} from "@/lib/client/whats-new";
import {
  GITHUB_RELEASES_URL,
  compareVersions,
  decideWhatsNew,
  releasesInRange,
} from "@/lib/shared/release-notes";
import type { ReleaseNote } from "@/lib/shared/release-notes";
import { CLAUDIUS_VERSION, CLAUDIUS_VERSION_DISPLAY } from "@/lib/shared/version";

/**
 * The small floating "What's new" window.
 *
 * Opens by itself on the first launch after an update and lists every release
 * since the version the user last saw — skip five updates, read all five.
 * Releases with no user-facing changes are folded into a one-line count, and
 * if NOTHING user-facing changed it doesn't open at all.
 *
 * It's also one click away at any time (the rail's version label, Help → What's
 * New, the /release-notes page), listing the most recent releases.
 *
 * Auto-open is production-only: a `next dev` checkout's version moves every
 * time new release tags are fetched, and a popup per `git pull` is noise.
 * The data is the release history bundled into the build — see
 * lib/shared/release-notes.ts.
 */

/** How many releases the manually opened window lists before "All release notes". */
const RECENT_LIMIT = 8;

type View = {
  /** Set when auto-opened after an update: the version updated from. */
  since: string | null;
  status: "loading" | "ready" | "unavailable";
  releases: ReleaseNote[];
  /** Maintenance-only releases folded out of `releases`. */
  maintenance: number;
};

export function WhatsNewWindow() {
  const router = useRouter();
  const [view, setView] = useState<View | null>(null);

  // ── Auto-open after an update ──────────────────────────────────────────
  useEffect(() => {
    if (process.env.NODE_ENV !== "production") return;
    const decision = decideWhatsNew(readLastSeenVersion(), CLAUDIUS_VERSION);
    if (decision.kind === "first-run") {
      rememberSeenVersion(CLAUDIUS_VERSION);
      return;
    }
    if (decision.kind !== "show") return;
    let live = true;
    loadReleaseNotes()
      .then((notes) => {
        if (!live) return;
        // Seen as soon as it's shown (not on dismiss), so a second window or
        // a reload doesn't pop it again. It's reopenable from the version label.
        rememberSeenVersion(CLAUDIUS_VERSION);
        const missed = releasesInRange(notes, decision.since, CLAUDIUS_VERSION);
        const visible = missed.filter((n) => n.shown > 0);
        if (visible.length === 0) return;
        setView((v) =>
          v ?? {
            since: decision.since,
            status: "ready",
            releases: visible,
            maintenance: missed.length - visible.length,
          },
        );
      })
      // Notes missing / unreadable: leave last-seen alone and retry next launch.
      .catch(() => {});
    return () => {
      live = false;
    };
  }, []);

  // ── Manual open ────────────────────────────────────────────────────────
  const openRecent = useCallback(() => {
    setView((v) => v ?? { since: null, status: "loading", releases: [], maintenance: 0 });
    loadReleaseNotes()
      .then((notes) => {
        const releases = releasesInRange(notes, null, CLAUDIUS_VERSION)
          .filter((n) => n.shown > 0)
          .slice(0, RECENT_LIMIT);
        setView((v) => (v && v.status === "loading" ? { ...v, status: "ready", releases } : v));
      })
      .catch(() =>
        setView((v) => (v && v.status === "loading" ? { ...v, status: "unavailable" } : v)),
      );
  }, []);
  useEffect(() => onOpenWhatsNew(openRecent), [openRecent]);
  useElectronAction("app.whatsNew", openRecent);

  if (!view) return null;
  const close = () => setView(null);
  const count = view.releases.length + view.maintenance;
  const currentTag = `v${CLAUDIUS_VERSION}`;

  return (
    <Overlay
      title="What's new"
      subtitle={`Claudius ${CLAUDIUS_VERSION_DISPLAY}`}
      width={520}
      // A small floating window, not a modal: the app stays usable and the
      // header drags it aside.
      backdrop={false}
      draggable
      onClose={close}
    >
      <div className="flex flex-col gap-3 p-4" data-testid="whats-new-window">
        {view.since && (
          <div className="text-xs text-[var(--muted)]" data-testid="whats-new-since">
            Updated from v{view.since.replace(/^v/, "")}
            {count > 1 && ` · ${count} releases since`}
          </div>
        )}

        {view.status === "loading" && (
          <div className="flex items-center gap-2 text-xs text-[var(--muted)]">
            <Loader2 className="h-3.5 w-3.5 animate-spin" /> Loading release notes…
          </div>
        )}
        {view.status === "unavailable" && (
          <div className="text-xs text-[var(--muted)]">
            This build doesn&apos;t include release notes.{" "}
            <a
              href={GITHUB_RELEASES_URL}
              target="_blank"
              rel="noreferrer"
              className="text-[var(--accent)] hover:underline"
            >
              See releases on GitHub
            </a>
          </div>
        )}
        {view.status === "ready" && view.releases.length === 0 && (
          <div className="text-xs text-[var(--muted)]">No user-facing changes recorded yet.</div>
        )}

        {view.releases.length > 0 && (
          <div
            className="scroll-thin -mr-2 flex max-h-[55vh] flex-col gap-5 overflow-y-auto pr-2"
            data-testid="whats-new-releases"
          >
            {view.releases.map((note) => (
              <ReleaseNoteSection
                key={note.tag}
                note={note}
                current={compareVersions(note.tag, currentTag) === 0}
              />
            ))}
          </div>
        )}

        {view.maintenance > 0 && (
          <div className="text-[11px] text-[var(--muted)]">
            +{view.maintenance} maintenance {view.maintenance === 1 ? "release" : "releases"} with
            internal changes only
          </div>
        )}

        <div className="flex items-center justify-between gap-2 border-t border-[var(--border)] pt-3">
          <button
            onClick={() => {
              close();
              router.push("/release-notes");
            }}
            data-testid="whats-new-all"
            className="text-xs text-[var(--accent)] hover:underline"
          >
            All release notes
          </button>
          <button
            onClick={close}
            data-testid="whats-new-dismiss"
            className="rounded border border-[var(--accent)]/40 bg-[var(--accent)]/15 px-3 py-1.5 text-xs font-medium hover:bg-[var(--accent)]/25"
          >
            Got it
          </button>
        </div>
      </div>
    </Overlay>
  );
}
