/**
 * CC 2.1.217 — classify an SDK `system/informational` message's `level`
 * (`'info' | 'notice' | 'suggestion' | 'warning'`) for the chat transcript.
 *
 * - `info` is transcript-mode-only upstream, so it's `hidden` (no pill).
 * - `notice` / `suggestion` / `warning` render, each toning its pill (see
 *   `INFO_LEVEL_TONE` in `components/chat/SystemPill.tsx`) so a data-loss
 *   warning stops looking like routine info.
 * - any unknown level renders with no special tone (`infoLevel` undefined).
 *
 * Pure (no React/SDK import) so the reducer branch in `use-session.ts` is
 * unit-testable.
 */
export type InformationalLevel = "notice" | "suggestion" | "warning";

export function classifyInformationalLevel(level: string | undefined): {
  hidden: boolean;
  infoLevel?: InformationalLevel;
} {
  if (level === "info") return { hidden: true };
  if (level === "notice" || level === "suggestion" || level === "warning") {
    return { hidden: false, infoLevel: level };
  }
  return { hidden: false };
}
