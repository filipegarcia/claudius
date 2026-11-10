import { ExternalLink } from "lucide-react";
import { ChangelogGroups } from "@/components/updater/ChangelogGroups";
import type { ReleaseNote } from "@/lib/shared/release-notes";

function formatReleaseDate(iso: string): string {
  const d = new Date(iso);
  return Number.isNaN(d.getTime())
    ? ""
    : d.toLocaleDateString(undefined, { year: "numeric", month: "short", day: "numeric" });
}

/**
 * One release in the "What's new" window / the /release-notes history: tag,
 * date, the grouped user-facing changes, and how many internal commits were
 * left out. Client-rendered only (both consumers load the notes after mount),
 * so the locale-dependent date can't cause a hydration mismatch.
 */
export function ReleaseNoteSection({ note, current }: { note: ReleaseNote; current: boolean }) {
  const hidden = note.total - note.shown;
  return (
    <section className="flex flex-col gap-2" data-testid="release-note" data-tag={note.tag}>
      <header className="flex items-baseline gap-2">
        <span className="font-mono text-xs font-medium">{note.tag}</span>
        {current && (
          <span className="rounded-full border border-[var(--accent)]/40 bg-[var(--accent)]/10 px-1.5 text-[10px] leading-4 text-[var(--accent)]">
            this version
          </span>
        )}
        <span className="text-[11px] text-[var(--muted)]">{formatReleaseDate(note.date)}</span>
        <a
          href={note.compareUrl}
          target="_blank"
          rel="noreferrer"
          title={`Every commit in ${note.tag} on GitHub`}
          className="ml-auto inline-flex items-center gap-1 text-[11px] text-[var(--muted)] hover:text-[var(--accent)]"
        >
          Diff <ExternalLink className="h-3 w-3" />
        </a>
      </header>
      {note.shown === 0 ? (
        <div className="text-xs text-[var(--muted)]">Maintenance release — internal changes only.</div>
      ) : (
        <div className="flex flex-col gap-3">
          <ChangelogGroups groups={note.groups} />
        </div>
      )}
      {note.shown > 0 && hidden > 0 && (
        <div className="text-[11px] text-[var(--muted)]">
          +{hidden} internal {hidden === 1 ? "change" : "changes"}
        </div>
      )}
    </section>
  );
}
