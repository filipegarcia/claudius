/**
 * CC 2.1.332 — "[VSCode] Fixed `spinnerVerbs` from Claude Code user and
 * managed settings being ignored".
 *
 * The setting is `{ mode: "append" | "replace", verbs: string[] }`. The engine
 * uses `verbs` alone for "replace" (falling back to its defaults when the list
 * is empty) and `[...defaults, ...verbs]` for "append". Claudius's working row
 * has one default line, "Claude is working…", which stands in for the
 * engine's default verb list: "append" keeps it in the pool, "replace" leaves
 * it out.
 */
export type SpinnerVerbs = {
  /** Configured verbs, trimmed, empties dropped. Never empty. */
  verbs: string[];
  /** "append": the default line stays in the pool. */
  includeDefault: boolean;
};

/** Read a `spinnerVerbs` settings value; undefined when unset, malformed, or empty. */
export function normalizeSpinnerVerbs(setting: unknown): SpinnerVerbs | undefined {
  if (!setting || typeof setting !== "object") return undefined;
  const { mode, verbs } = setting as { mode?: unknown; verbs?: unknown };
  if ((mode !== "append" && mode !== "replace") || !Array.isArray(verbs)) return undefined;
  const clean = verbs
    .filter((v): v is string => typeof v === "string")
    .map((v) => v.trim())
    .filter((v) => v !== "");
  if (clean.length === 0) return undefined;
  return { verbs: clean, includeDefault: mode === "append" };
}

/**
 * Pick the working row's verb for a roll in [0, 1) (the caller's
 * `Math.random()`). Null means the default "Claude is working…" line.
 */
export function pickSpinnerVerb(spinnerVerbs: SpinnerVerbs | null | undefined, roll: number): string | null {
  if (!spinnerVerbs || spinnerVerbs.verbs.length === 0) return null;
  const pool = spinnerVerbs.verbs.length + (spinnerVerbs.includeDefault ? 1 : 0);
  const i = Math.min(pool - 1, Math.max(0, Math.floor(roll * pool)));
  return i < spinnerVerbs.verbs.length ? spinnerVerbs.verbs[i]! : null;
}
