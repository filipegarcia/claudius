import { findModelEntry } from "./model-id";

type CatalogRow = { value: string; resolvedModel?: string };

/**
 * CC 2.1.329 — "Fixed choosing Default in `/model` replacing your saved model
 * with your organization's default when the Default row already showed your
 * saved model".
 *
 * What a model pick does to the user-settings `model` key (Claudius makes
 * every pick the default for new sessions, as the CLI's `/model` does):
 * `{ model }` to write it (`undefined` deletes the key), or null to leave
 * the file alone.
 *
 * The SDK's Default row arrives as the value `"default"`. Claudius used to
 * write that literal, which the engine resolves past the saved model to the
 * organization's default. Now:
 *  - when the Default row (the session catalog's `default` entry) resolves to
 *    the model the saved setting names, the saved model stays — that's what
 *    the row showed;
 *  - otherwise the key is deleted, as the CLI's `/config` does
 *    (`e === "default" ? null : e`). With no catalog to compare against, the
 *    key is deleted too — the same effect the literal had.
 */
export function savedModelAfterPick(
  pick: string | undefined,
  saved: string | undefined,
  catalog?: readonly CatalogRow[] | null,
): { model: string | undefined } | null {
  if (pick !== "default") {
    const desired = pick || undefined;
    return saved === desired ? null : { model: desired };
  }
  if (!saved) return null;
  const defaultId = catalog?.find((m) => m.value === "default")?.resolvedModel;
  if (defaultId) {
    // The saved setting may be an alias (`sonnet`) or an id; resolve it
    // through its own catalog row, never through the Default row itself.
    const row = findModelEntry(catalog?.filter((m) => m.value !== "default"), saved);
    const savedId = row?.resolvedModel ?? saved;
    if (savedId.trim().toLowerCase() === defaultId.trim().toLowerCase()) return null;
  }
  return { model: undefined };
}
