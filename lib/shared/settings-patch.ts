/**
 * CC 2.1.323 parity — "Fixed a setting saved in a running session undoing a
 * hand edit made to settings.json moments earlier".
 *
 * Claudius's Settings page used to PUT the whole draft it loaded with the
 * page, and the server wrote it over the file as-is. A key edited by hand,
 * or by the CLI, after the page loaded was put back to its old value, and a
 * file deleted meanwhile came back with all its old contents. The page now
 * sends only the top-level keys the user changed, and the server applies
 * them to a fresh read of the file (read-merge-write, like every other
 * Claudius settings writer).
 *
 * Granularity is the top-level key. A nested object the user edited
 * (`permissions`, `env`, …) is replaced as a whole, so a hand edit inside
 * that same object can still be lost. Keys the user didn't touch always keep
 * whatever the file holds now.
 */

export type SettingsPatch = { set: Record<string, unknown>; unset: string[] };

function same(a: unknown, b: unknown): boolean {
  return JSON.stringify(a) === JSON.stringify(b);
}

/** The top-level keys that differ between `baseline` and `next`. */
export function diffSettings(
  baseline: Record<string, unknown>,
  next: Record<string, unknown>,
): SettingsPatch {
  const set: Record<string, unknown> = {};
  const unset: string[] = [];
  for (const [k, v] of Object.entries(next)) {
    if (v === undefined) continue;
    if (!Object.hasOwn(baseline, k) || !same(baseline[k], v)) set[k] = v;
  }
  for (const k of Object.keys(baseline)) {
    if (!Object.hasOwn(next, k) || next[k] === undefined) unset.push(k);
  }
  return { set, unset };
}

export function isEmptyPatch(p: SettingsPatch): boolean {
  return Object.keys(p.set).length === 0 && p.unset.length === 0;
}

/** Apply `patch` to `current` (a fresh read), returning a new object. */
export function applySettingsPatch<T extends Record<string, unknown>>(current: T, patch: SettingsPatch): T {
  const out: Record<string, unknown> = { ...current };
  for (const [k, v] of Object.entries(patch.set)) {
    if (k === "__proto__" || k === "constructor" || k === "prototype") continue;
    out[k] = v;
  }
  for (const k of patch.unset) delete out[k];
  return out as T;
}

/** Validate an untrusted request body's `patch`. */
export function parseSettingsPatch(raw: unknown): SettingsPatch | null {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return null;
  const r = raw as { set?: unknown; unset?: unknown };
  const set = r.set ?? {};
  const unset = r.unset ?? [];
  if (!set || typeof set !== "object" || Array.isArray(set)) return null;
  if (!Array.isArray(unset) || !unset.every((k) => typeof k === "string")) return null;
  return { set: set as Record<string, unknown>, unset: unset as string[] };
}

/**
 * Apply an add/remove delta to a rule list (from a fresh read), keeping the
 * file's order and any rule added there since the page loaded.
 */
export function applyRuleDelta(
  current: readonly string[] | undefined,
  delta: { add?: readonly string[]; remove?: readonly string[] },
): string[] {
  const remove = new Set(delta.remove ?? []);
  const out = (current ?? []).filter((r) => !remove.has(r));
  for (const r of delta.add ?? []) if (!out.includes(r)) out.push(r);
  return out;
}
