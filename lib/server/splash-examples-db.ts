import { openDb } from "./db";

/**
 * Per-workspace splash-screen suggestion chips.
 *
 * The chat splash (rendered when the transcript is empty — see
 * `components/chat/MessageList.tsx`) shows a small grid of clickable example
 * prompts. Users wanted to curate that list per project: a Rails repo wants
 * different starter prompts from a Next.js one.
 *
 * Storage lives in the per-cwd `ui_state` key/value table (migration v3),
 * so workspace scoping is implicit — the DB file is already keyed by cwd.
 * The persisted value is a JSON array of strings.
 *
 * Semantics:
 *   - row missing → caller falls back to the built-in defaults.
 *   - row present (even an empty array) → user has explicitly curated the
 *     list. Empty means "show no chips," which is intentional, not a bug.
 *
 * Sanitization caps each chip at SPLASH_EXAMPLE_MAX_LEN chars and the list
 * at SPLASH_EXAMPLES_MAX entries so a runaway client can't bloat the row.
 */

const KEY = "splash_examples";
const NAME_KEY = "splash_display_name";

export const SPLASH_EXAMPLE_MAX_LEN = 240;
export const SPLASH_EXAMPLES_MAX = 12;
export const SPLASH_DISPLAY_NAME_MAX_LEN = 60;

export const DEFAULT_SPLASH_EXAMPLES = [
  "Check for security vulnerabilities in the latest git commit",
  "Improve test coverage",
  "Find TODO comments in the codebase",
  "Find performance bottlenecks and suggest fixes",
];

export type SplashExamplesPayload = {
  /** The list to render. Defaults to {@link DEFAULT_SPLASH_EXAMPLES} when no
   *  row has been saved yet. */
  examples: string[];
  /** True when the user has explicitly saved a list (even an empty one). */
  customized: boolean;
};

export async function getSplashExamples(cwd: string): Promise<SplashExamplesPayload> {
  const db = await openDb(cwd, "readonly").catch(() => null);
  if (!db) return { examples: DEFAULT_SPLASH_EXAMPLES, customized: false };
  let row: { value: string } | undefined;
  try {
    row = db
      .prepare<[string], { value: string } | undefined>(
        "SELECT value FROM ui_state WHERE key = ?",
      )
      .get(KEY);
  } catch {
    // Table missing (very old DB on which v3 hasn't run yet).
    return { examples: DEFAULT_SPLASH_EXAMPLES, customized: false };
  }
  if (!row?.value) return { examples: DEFAULT_SPLASH_EXAMPLES, customized: false };
  try {
    const parsed = JSON.parse(row.value) as unknown;
    if (!Array.isArray(parsed)) {
      return { examples: DEFAULT_SPLASH_EXAMPLES, customized: false };
    }
    const examples = parsed
      .filter((x): x is string => typeof x === "string")
      .map((x) => x.trim())
      .filter((x) => x.length > 0)
      .slice(0, SPLASH_EXAMPLES_MAX);
    return { examples, customized: true };
  } catch {
    return { examples: DEFAULT_SPLASH_EXAMPLES, customized: false };
  }
}

export async function setSplashExamples(cwd: string, examples: string[]): Promise<string[]> {
  // Sanitize: drop non-strings, trim, drop blanks, cap per-entry length, cap
  // list length. The cleaned list is what we persist AND what we return so
  // the client can reconcile its local state without a follow-up GET.
  const cleaned: string[] = [];
  for (const raw of examples) {
    if (typeof raw !== "string") continue;
    const v = raw.trim().slice(0, SPLASH_EXAMPLE_MAX_LEN);
    if (!v) continue;
    cleaned.push(v);
    if (cleaned.length >= SPLASH_EXAMPLES_MAX) break;
  }
  const db = await openDb(cwd);
  db.prepare(
    `INSERT INTO ui_state(key, value) VALUES(?, ?)
     ON CONFLICT(key) DO UPDATE SET value = excluded.value`,
  ).run(KEY, JSON.stringify(cleaned));
  return cleaned;
}

export async function resetSplashExamples(cwd: string): Promise<void> {
  const db = await openDb(cwd);
  db.prepare("DELETE FROM ui_state WHERE key = ?").run(KEY);
}

/**
 * Per-workspace display-name override for the splash greeting. When set,
 * the splash shows "Good evening, <override>" instead of falling through
 * to the active account label / `~/.claude.json` displayName.
 *
 * Empty string ⇒ no override; we delete the row instead of storing "" so
 * "never customized" and "user cleared the field" collapse to the same
 * on-disk state.
 */
export async function getSplashDisplayName(cwd: string): Promise<string | null> {
  const db = await openDb(cwd, "readonly").catch(() => null);
  if (!db) return null;
  let row: { value: string } | undefined;
  try {
    row = db
      .prepare<[string], { value: string } | undefined>(
        "SELECT value FROM ui_state WHERE key = ?",
      )
      .get(NAME_KEY);
  } catch {
    return null;
  }
  if (!row?.value) return null;
  try {
    const parsed = JSON.parse(row.value) as unknown;
    if (typeof parsed !== "string") return null;
    const trimmed = parsed.trim();
    return trimmed ? trimmed.slice(0, SPLASH_DISPLAY_NAME_MAX_LEN) : null;
  } catch {
    return null;
  }
}

export async function setSplashDisplayName(
  cwd: string,
  name: string | null,
): Promise<string | null> {
  const db = await openDb(cwd);
  if (name === null) {
    db.prepare("DELETE FROM ui_state WHERE key = ?").run(NAME_KEY);
    return null;
  }
  const clean = name.trim().slice(0, SPLASH_DISPLAY_NAME_MAX_LEN);
  if (!clean) {
    // Empty string ⇒ remove the row so subsequent GETs fall through to
    // the account-derived fallback rather than overriding it with "".
    db.prepare("DELETE FROM ui_state WHERE key = ?").run(NAME_KEY);
    return null;
  }
  db.prepare(
    `INSERT INTO ui_state(key, value) VALUES(?, ?)
     ON CONFLICT(key) DO UPDATE SET value = excluded.value`,
  ).run(NAME_KEY, JSON.stringify(clean));
  return clean;
}
