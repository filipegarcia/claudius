/**
 * CC 2.1.307 parity — "[VSCode] Fixed dictation failing behind a TLS-inspecting
 * proxy when `NODE_EXTRA_CA_CERTS` is set only in `~/.claude/settings.json`."
 *
 * Claudius opens its own WebSocket to the dictation endpoint from the Next.js
 * Node process (`lib/server/voice-stream.ts`). Node reads `NODE_EXTRA_CA_CERTS`
 * only from the real process environment, once, at startup. A value that lives
 * only in the user settings `env` block (where Claude Code users put it, and
 * where the engine honours it) therefore never reaches that socket, and the
 * TLS handshake against a corporate MITM proxy fails.
 *
 * This resolves the extra CA bundle to pass as `ca` on the socket:
 * - `NODE_EXTRA_CA_CERTS` in the real process env → `undefined`. Node already
 *   added it to the default trust store at startup, so we leave the socket
 *   alone.
 * - otherwise, `env.NODE_EXTRA_CA_CERTS` in **user** settings → the bundled
 *   roots plus that file's PEM. Passing `ca` *replaces* the default store, so
 *   the bundled roots must be included too.
 * - otherwise, or when the file can't be read → `undefined` (default trust).
 *
 * Only user scope is consulted, matching the changelog ("set only in
 * ~/.claude/settings.json"). A project-checked-in settings file must not be
 * able to add trust anchors for a socket that carries the user's OAuth token.
 */
import { promises as fs } from "node:fs";
import { homedir } from "node:os";
import { isAbsolute, resolve } from "node:path";
import { rootCertificates } from "node:tls";

import { readSettings } from "./settings";

export const EXTRA_CA_ENV = "NODE_EXTRA_CA_CERTS";

export interface ExtraCaDeps {
  processEnv?: Record<string, string | undefined>;
  /** Returns the user-scope settings `env` block (or undefined). */
  readUserSettingsEnv?: () => Promise<Record<string, unknown> | undefined>;
  readFile?: (path: string) => Promise<string>;
  home?: string;
  roots?: readonly string[];
}

async function defaultReadUserSettingsEnv(): Promise<Record<string, unknown> | undefined> {
  const s = (await readSettings("user", homedir())) as { env?: unknown };
  return s.env && typeof s.env === "object" ? (s.env as Record<string, unknown>) : undefined;
}

/**
 * Expand a leading `~/` and make the path absolute. A relative path is
 * resolved against the home directory, because the settings file it came
 * from lives there.
 */
export function expandCaPath(raw: string, home: string): string {
  const t = raw.trim();
  if (t === "~") return home;
  if (t.startsWith("~/")) return resolve(home, t.slice(2));
  return isAbsolute(t) ? resolve(t) : resolve(home, t);
}

/**
 * The `ca` array to pass to a TLS socket, or `undefined` to keep Node's default
 * trust store. Never throws. A missing or unreadable file logs a warning and
 * falls back to default trust, so dictation behaves exactly as before.
 */
export async function resolveExtraCaCerts(deps: ExtraCaDeps = {}): Promise<string[] | undefined> {
  const env = deps.processEnv ?? process.env;
  if (typeof env[EXTRA_CA_ENV] === "string" && env[EXTRA_CA_ENV]!.trim() !== "") {
    return undefined; // Node already loaded it into the default store at startup.
  }
  let settingsEnv: Record<string, unknown> | undefined;
  try {
    settingsEnv = await (deps.readUserSettingsEnv ?? defaultReadUserSettingsEnv)();
  } catch {
    return undefined; // unreadable / malformed settings → default trust
  }
  const raw = settingsEnv?.[EXTRA_CA_ENV];
  if (typeof raw !== "string" || raw.trim() === "") return undefined;

  const path = expandCaPath(raw, deps.home ?? homedir());
  let pem: string;
  try {
    pem = await (deps.readFile ?? ((p: string) => fs.readFile(p, "utf8")))(path);
  } catch (err) {
    console.warn(
      `[extra-ca-certs] ${EXTRA_CA_ENV} from user settings could not be read (${path}): ${
        err instanceof Error ? err.message : String(err)
      }`,
    );
    return undefined;
  }
  if (!pem.includes("-----BEGIN CERTIFICATE-----")) {
    console.warn(`[extra-ca-certs] ${path} has no PEM certificates — ignoring`);
    return undefined;
  }
  return [...(deps.roots ?? rootCertificates), pem];
}
