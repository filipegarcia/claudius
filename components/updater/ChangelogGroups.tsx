import type { ChangelogGroup } from "@/lib/shared/release-changelog";

/**
 * The "New / Fixes / Improvements" lists of one changelog. Shared by the
 * pre-download update modal, the post-update "What's new" window and the
 * /release-notes history so an entry reads the same everywhere.
 */
export function ChangelogGroups({ groups }: { groups: ChangelogGroup[] }) {
  return (
    <>
      {groups.map((g) => (
        <section key={g.key}>
          <div className="mb-1 text-[11px] font-medium uppercase tracking-wide text-[var(--muted)]">
            {g.title}
          </div>
          <ul className="flex flex-col gap-1">
            {g.entries.map((e) => (
              <li key={e.sha} className="flex items-baseline gap-2 text-xs leading-relaxed">
                <span className="mt-[0.45em] h-1 w-1 shrink-0 self-start rounded-full bg-[var(--muted)]" />
                <span className="min-w-0">
                  {e.scope && (
                    <span className="mr-1.5 rounded bg-[var(--panel-2)] px-1 py-px font-mono text-[10px] text-[var(--muted)]">
                      {e.scope}
                    </span>
                  )}
                  {e.text}
                </span>
              </li>
            ))}
          </ul>
        </section>
      ))}
    </>
  );
}
