"use client";

/**
 * Client plumbing for the "What's new" window and the /release-notes history.
 *
 *  - `useReleaseNotes()` — the bundled release history (lib/shared/release-notes.ts),
 *    fetched once per page load and shared by every consumer.
 *  - last-seen version in localStorage — per install, like the rest of the UI
 *    state (the desktop app keeps a stable origin port across launches). If
 *    the origin ever changes, the store reads as empty, which
 *    `decideWhatsNew` treats as a first run: quiet, never a stale popup.
 *  - `openWhatsNew()` — fired by the version label, the Help menu
 *    (`app.whatsNew`) and the /release-notes page; the window in
 *    app/layout.tsx listens.
 */
import { useEffect, useState } from "react";
import {
  RELEASE_NOTES_URL,
  isVersion,
  laterVersion,
  parseReleaseNotes,
  type ReleaseNote,
} from "@/lib/shared/release-notes";

const LAST_SEEN_KEY = "claudius.whatsNew.lastSeen";
const OPEN_EVENT = "claudius:whats-new:open";

let notesPromise: Promise<ReleaseNote[]> | null = null;

/** Fetch + parse the bundled history once; a failure is retried next call. */
export function loadReleaseNotes(): Promise<ReleaseNote[]> {
  if (!notesPromise) {
    const p = fetch(RELEASE_NOTES_URL).then(async (res) => {
      // 404 = this build shipped without notes (shallow CI clone, non-git tree).
      if (!res.ok) throw new Error(`release notes: HTTP ${res.status}`);
      return parseReleaseNotes(await res.json());
    });
    p.catch(() => {
      if (notesPromise === p) notesPromise = null;
    });
    notesPromise = p;
  }
  return notesPromise;
}

export type ReleaseNotesState =
  | { kind: "loading" }
  | { kind: "ready"; notes: ReleaseNote[] }
  | { kind: "unavailable" };

export function useReleaseNotes(enabled = true): ReleaseNotesState {
  const [state, setState] = useState<ReleaseNotesState>({ kind: "loading" });
  useEffect(() => {
    if (!enabled) return;
    let live = true;
    loadReleaseNotes()
      .then((notes) => live && setState({ kind: "ready", notes }))
      .catch(() => live && setState({ kind: "unavailable" }));
    return () => {
      live = false;
    };
  }, [enabled]);
  return state;
}

export function readLastSeenVersion(): string | null {
  try {
    const v = window.localStorage.getItem(LAST_SEEN_KEY);
    return isVersion(v) ? v : null;
  } catch {
    return null;
  }
}

/** Record `version` as seen. Never moves backwards (see `laterVersion`). */
export function rememberSeenVersion(version: string): void {
  try {
    window.localStorage.setItem(LAST_SEEN_KEY, laterVersion(readLastSeenVersion(), version));
  } catch {
    // Private mode / quota — worst case the window shows again next launch.
  }
}

export function openWhatsNew(): void {
  window.dispatchEvent(new Event(OPEN_EVENT));
}

export function onOpenWhatsNew(cb: () => void): () => void {
  window.addEventListener(OPEN_EVENT, cb);
  return () => window.removeEventListener(OPEN_EVENT, cb);
}
