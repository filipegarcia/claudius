// SDK 0.3.325 — `invalid_config_file` on the zeroed error result that carries
// `startup_failure_reason: "config_file_invalid"`: the config file that did not
// parse and its backup, as separate fields. The SDK says to read paths from
// here and never from the text of `errors`. Pure so it is unit-testable.

export type InvalidConfigFile = {
  path: string;
  isGlobal: boolean;
  backupSearched: boolean;
  backupPath?: string;
};

const MAX_PATH_LEN = 300;

function cleanPath(s: string): string {
  // Paths are untrusted text: strip control + bidi characters, bound length.
  const cleaned = s.replace(/[\u0000-\u001f\u007f-\u009f‎‏‪-‮⁦-⁩]/g, "");
  return cleaned.length > MAX_PATH_LEN ? `${cleaned.slice(0, MAX_PATH_LEN)}…` : cleaned;
}

/** Defensively normalize the raw `invalid_config_file` object; `undefined` if unusable. */
export function parseInvalidConfigFile(v: unknown): InvalidConfigFile | undefined {
  if (!v || typeof v !== "object") return undefined;
  const o = v as Record<string, unknown>;
  if (typeof o.path !== "string" || o.path.length === 0) return undefined;
  return {
    path: o.path,
    isGlobal: o.is_global === true,
    backupSearched: o.backup_searched === true,
    ...(typeof o.backup_path === "string" && o.backup_path.length > 0
      ? { backupPath: o.backup_path }
      : {}),
  };
}

/**
 * Extra sentence(s) appended to the "Session failed to start" error for a
 * `config_file_invalid` failure: which file is broken and, for the global
 * config, whether a backup was found. Returns "" when the field is absent.
 */
export function describeInvalidConfigFile(raw: unknown): string {
  const f = parseInvalidConfigFile(raw);
  if (!f) return "";
  let out = ` The file is ${cleanPath(f.path)}.`;
  if (f.backupPath) {
    out += ` A backup is at ${cleanPath(f.backupPath)} — check that it parses before copying it over the broken file.`;
  } else if (f.isGlobal && f.backupSearched) {
    out += " No backup of it was found.";
  }
  return out;
}
