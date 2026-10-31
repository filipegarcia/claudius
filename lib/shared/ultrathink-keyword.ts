/**
 * CC 2.1.311 parity — "Changed the `ultrathink` rainbow to appear only where
 * the keyword can raise effort, and not when the word is quoted or part of a
 * file path."
 *
 * The 2.1.311 engine finds the keyword with a quote- and path-aware scanner
 * (the bundled CLI's `da(text, "ultrathink")`, shared with `ultraplan` /
 * `ultrareview`), and only that scanner gates the per-turn "deeper reasoning"
 * reminder. Claudius reimplements the TUI's prose-keyword reminder itself
 * (`ultrathinkReminderBody` in `lib/server/session.ts`), so it carries a
 * faithful port of that scanner:
 *
 *  - a prompt that starts with `/` (a slash command or a bare path) never
 *    matches;
 *  - text inside a quoted / bracketed span — backticks, `"…"`, `'…'`,
 *    `(…)`, `[…]`, `{…}` and `<tag…>` — is skipped. A `'` only opens a span
 *    when it isn't preceded by a word character, and only closes one when it
 *    isn't followed by one, so the apostrophe in `don't` neither opens nor
 *    closes a span;
 *  - a match touching `/`, `\` or `-` on either side, followed by `?`, or
 *    followed by `.` plus a word character (`ultrathink.md`), is part of a
 *    path, flag or file name and is skipped.
 *
 * Pure (no Node, no DOM) so it's unit-testable and usable from either side.
 */

/** Opener → closer pairs that delimit a span the keyword is ignored in. */
const SPAN_CLOSERS: Readonly<Record<string, string>> = {
  "`": "`",
  '"': '"',
  "<": ">",
  "{": "}",
  "[": "]",
  "(": ")",
  "'": "'",
};

export interface KeywordMatch {
  /** The matched text, original casing. */
  word: string;
  /** Inclusive start index in the scanned text. */
  start: number;
  /** Exclusive end index. */
  end: number;
}

const isWordChar = (ch: string | undefined): boolean => !!ch && /[\p{L}\p{N}_]/u.test(ch);

/**
 * Every occurrence of `keyword` in `text` that counts as the user typing the
 * keyword (not quoting it, not naming a file). `keyword` must be a plain
 * lowercase identifier — it is interpolated into a RegExp and is only ever
 * one of this module's constants, never user input.
 */
export function findKeyword(text: string, keyword: string): KeywordMatch[] {
  if (!text.toLowerCase().includes(keyword)) return [];
  if (text.startsWith("/")) return [];

  // Pass 1 — quoted / bracketed spans.
  const spans: Array<{ start: number; end: number }> = [];
  let opener: string | null = null;
  let spanStart = 0;
  for (let i = 0; i < text.length; i++) {
    const ch = text[i];
    if (opener) {
      // A nested `[` restarts the bracket span (`[[x]]` → the inner one).
      if (opener === "[" && ch === "[") {
        spanStart = i;
        continue;
      }
      if (ch !== SPAN_CLOSERS[opener]) continue;
      if (opener === "'" && isWordChar(text[i + 1])) continue;
      spans.push({ start: spanStart, end: i + 1 });
      opener = null;
    } else if (
      (ch === "<" && i + 1 < text.length && /[a-zA-Z/]/.test(text[i + 1])) ||
      (ch === "'" && !isWordChar(text[i - 1])) ||
      (ch !== "<" && ch !== "'" && Object.hasOwn(SPAN_CLOSERS, ch))
    ) {
      opener = ch;
      spanStart = i;
    }
  }

  // Pass 2 — whole-word matches outside those spans and not part of a path.
  // Spans come out sorted and non-overlapping and matches in ascending
  // order, so one forward pointer replaces a per-match scan (which was
  // quadratic on long prompts — this runs behind an HTTP route).
  const out: KeywordMatch[] = [];
  let si = 0;
  for (const m of text.matchAll(new RegExp(`\\b${keyword}\\b`, "gi"))) {
    const start = m.index;
    const end = start + m[0].length;
    while (si < spans.length && spans[si].end <= start) si++;
    if (si < spans.length && start >= spans[si].start) continue;
    const before = text[start - 1];
    const after = text[end];
    if (before === "/" || before === "\\" || before === "-") continue;
    if (after === "/" || after === "\\" || after === "-" || after === "?") continue;
    if (after === "." && isWordChar(text[end + 1])) continue;
    out.push({ word: m[0], start, end });
  }
  return out;
}

/**
 * True when `text` carries a live `ultrathink`. `pastes` are the large pastes
 * the composer recorded for this prompt (`inline_pastes`): Claude Code scans
 * the prompt *before* paste expansion, where those are `[Pasted text #N]`
 * placeholders, so a keyword that only appears inside pasted text doesn't
 * count — and quotes, backticks or a leading `/` inside a paste don't open
 * spans that hide a keyword the user typed. Mirrored by collapsing each paste
 * back to a placeholder before scanning.
 *
 * `pastes` comes from a request body, so non-string entries are ignored
 * (a non-string has no usable `length`, and searching for it could loop).
 */
export function hasUltrathinkKeyword(text: string, pastes: readonly unknown[] = []): boolean {
  if (!text.toLowerCase().includes("ultrathink")) return false;
  let scan = text;
  for (const p of pastes) {
    if (typeof p !== "string" || p.length === 0) continue;
    scan = scan.split(p).join("[Pasted text]");
  }
  return findKeyword(scan, "ultrathink").length > 0;
}

/**
 * CC 2.1.316 parity — "Added CLAUDE_CODE_DISABLE_ULTRATHINK, which turns the
 * ultrathink keyword off".
 *
 * The engine's gate is `!process.env.CLAUDE_CODE_DISABLE_ULTRATHINK && …`, so
 * ANY non-empty value turns the keyword off — `"1"`, but also `"0"` and
 * `"false"`. Only an unset or empty variable leaves it on. Claudius injects
 * its own per-turn ultrathink reminder (`ultrathinkReminderBody` in
 * `lib/server/session.ts`), so the session reads the same variable — from the
 * env it hands the engine plus the settings `env` blocks — through this
 * helper and skips the reminder when it's set.
 */
export function isUltrathinkDisabled(env: Readonly<Record<string, unknown>>): boolean {
  const v = env.CLAUDE_CODE_DISABLE_ULTRATHINK;
  return typeof v === "string" && v.length > 0;
}

/**
 * `isUltrathinkDisabled` over the env the engine actually ends up with: the
 * query env with each settings scope's `env` block applied on top, in order
 * (user < project < local — later scopes win, so a local `""` re-enables a
 * user-scope `"1"`). A layer whose `env` isn't an object adds nothing.
 */
export function isUltrathinkDisabledFor(
  queryEnv: Readonly<Record<string, unknown>>,
  settingsLayers: readonly unknown[] = [],
): boolean {
  const merged: Record<string, unknown> = { ...queryEnv };
  for (const layer of settingsLayers) {
    const layerEnv = layer && typeof layer === "object" ? (layer as { env?: unknown }).env : undefined;
    if (layerEnv && typeof layerEnv === "object") Object.assign(merged, layerEnv);
  }
  return isUltrathinkDisabled(merged);
}

/**
 * The scopes `resolveUltrathinkDisabled` reads after the user layer, in
 * precedence order (later wins).
 */
export const ULTRATHINK_SETTINGS_SCOPES = ["project", "local"] as const;

/**
 * Session-start resolution of `CLAUDE_CODE_DISABLE_ULTRATHINK` (what
 * `Session.start()` stores in `ultrathinkDisabled`). The engine reads the
 * variable from its own env: the query env we hand it with each settings
 * scope's `env` block applied on top (user < project < local). Restricted
 * sessions ignore settings files engine-side (CC 2.1.248), so there only the
 * query env counts and no scope is read. A scope whose read rejects adds
 * nothing. `readScope` is injected so this stays pure (and testable) —
 * the session passes `readSettings(scope, cwd)`.
 */
export async function resolveUltrathinkDisabled({
  queryEnv,
  restricted,
  userSettings,
  readScope,
}: {
  queryEnv: Readonly<Record<string, unknown>>;
  restricted: boolean;
  userSettings: unknown;
  readScope: (scope: (typeof ULTRATHINK_SETTINGS_SCOPES)[number]) => Promise<unknown>;
}): Promise<boolean> {
  if (restricted) return isUltrathinkDisabledFor(queryEnv);
  const scoped = await Promise.all(
    ULTRATHINK_SETTINGS_SCOPES.map((scope) => {
      try {
        return Promise.resolve(readScope(scope)).catch(() => ({}));
      } catch {
        return Promise.resolve({});
      }
    }),
  );
  return isUltrathinkDisabledFor(queryEnv, [userSettings, ...scoped]);
}
