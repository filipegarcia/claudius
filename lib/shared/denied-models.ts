/**
 * CC 2.1.283 — a managed `deniedModels` entry blocks a model; the model picker
 * must not re-list it via Claudius's own ALWAYS_SHOWN_ALIASES. This matches a
 * model id/alias against the `deniedModels` list using `availableModelsMatch`
 * semantics (default "prefix"): an exact id match, a prefix extension
 * ("claude-opus-5" denies "claude-opus-5-5"), or a bare family-alias name
 * ("opus" denies the opus family and the "opus" alias). Pure, for unit tests.
 */
export function isModelDeniedByManaged(
  value: string,
  deniedModels: string[] | undefined,
  match: "prefix" | "exact" = "prefix",
): boolean {
  if (!deniedModels || deniedModels.length === 0) return false;
  const v = value.toLowerCase();
  return deniedModels.some((raw) => {
    const d = raw.trim().toLowerCase();
    if (!d) return false;
    if (v === d) return true;
    // A bare family alias ("opus", "fable") denies that family's ids and alias.
    if (/^[a-z]+$/.test(d) && (v === d || v.includes(`-${d}-`) || v.endsWith(`-${d}`) || v.startsWith(`${d}-`))) {
      return true;
    }
    // Prefix mode: a model-id entry also denies ids that extend it.
    if (match === "prefix" && v.startsWith(`${d}-`)) return true;
    return false;
  });
}
