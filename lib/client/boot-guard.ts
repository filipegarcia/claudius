/**
 * CC 2.1.301 ([VSCode] "Fixed a conversation that crashes or freezes the
 * panel being reopened on every reload").
 *
 * On page load Claudius resumes `?session=` or the last-active tab. If that
 * conversation crashes the page (a render throw reaching `global-error.tsx`,
 * whose only action reloads) or freezes the tab, every reload resumed it
 * again — a loop with no way out short of hand-editing the URL.
 *
 * The guard: before the boot resumes a session it writes a marker; once that
 * session's history has replayed AND the result committed to the screen
 * (`clearBootAttempt`, called from an effect, so a render crash never reaches
 * it), the marker is removed. If the next boot finds a marker still naming
 * the session it's about to resume, the previous boot never finished — it
 * opens a fresh session instead and the chat shows a notice with
 * "Open anyway".
 *
 * Pure apart from the `Storage` it's handed, so it's unit-testable.
 */

export const BOOT_MARKER_KEY = "claudius:boot-pending";
/** sessionStorage key: the user chose "Open anyway" for this id. */
export const BOOT_FORCE_KEY = "claudius:boot-force";
/**
 * A marker older than this is ignored: a tab closed mid-load hours ago isn't
 * a crash loop. Generous enough to cover a user waiting out a frozen tab.
 */
export const BOOT_MARKER_TTL_MS = 30 * 60 * 1000;

/**
 * Which page load wrote a marker. A marker from the *current* load never
 * counts: React Strict Mode runs the boot effect twice, and a chat remount
 * after client-side navigation re-runs it — neither is a crash loop.
 * `performance.timeOrigin` is fixed for the life of a document and differs
 * on every load.
 */
export function currentPageLoad(): number {
  return typeof performance !== "undefined" ? performance.timeOrigin : 0;
}

type Marker = { id: string; at: number; load?: number };

function readMarker(storage: Pick<Storage, "getItem">): Marker | null {
  try {
    const raw = storage.getItem(BOOT_MARKER_KEY);
    if (!raw) return null;
    const m = JSON.parse(raw) as Partial<Marker>;
    return typeof m.id === "string" && typeof m.at === "number"
      ? { id: m.id, at: m.at, ...(typeof m.load === "number" ? { load: m.load } : {}) }
      : null;
  } catch {
    return null;
  }
}

/**
 * Whether the boot should skip resuming `id` because an earlier page load
 * that resumed it never finished. `forced` (from "Open anyway") always wins,
 * and a marker written by this same page load (`load`) is ignored.
 */
export function shouldSkipResume(
  id: string,
  storage: Pick<Storage, "getItem">,
  now: number,
  forced = false,
  load = currentPageLoad(),
): boolean {
  if (forced) return false;
  const m = readMarker(storage);
  return !!m && m.id === id && m.load !== load && now - m.at < BOOT_MARKER_TTL_MS;
}

/** Record that this page load is about to resume `id`. */
export function markBootAttempt(
  id: string,
  storage: Pick<Storage, "setItem">,
  now: number,
  load = currentPageLoad(),
): void {
  try {
    storage.setItem(BOOT_MARKER_KEY, JSON.stringify({ id, at: now, load }));
  } catch {
    // Storage full / disabled — the guard is best-effort.
  }
}

/** The resumed session rendered: this boot finished. */
export function clearBootAttempt(storage: Pick<Storage, "removeItem">): void {
  try {
    storage.removeItem(BOOT_MARKER_KEY);
  } catch {
    // ignore
  }
}

/** Read-and-consume the "Open anyway" flag for `id`. */
export function consumeForcedResume(id: string, storage: Pick<Storage, "getItem" | "removeItem">): boolean {
  try {
    if (storage.getItem(BOOT_FORCE_KEY) !== id) return false;
    storage.removeItem(BOOT_FORCE_KEY);
    return true;
  } catch {
    return false;
  }
}
