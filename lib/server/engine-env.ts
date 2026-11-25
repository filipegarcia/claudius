import { readSettings } from "./settings";

/**
 * The env a session's engine sees: Claudius's process env (what
 * `buildQueryEnv` forwards) with the user-scope `settings.env` applied on
 * top, as the engine applies it. Project and local scopes are left out.
 * Best-effort: an unreadable settings file leaves the process env alone.
 *
 * Used by the doctor checks that port engine rules over env vars — the
 * OpenTelemetry no-endpoint notice (CC 2.1.328) and the API connectivity
 * test (CC 2.1.331).
 */
export async function engineEnv(): Promise<Record<string, string | undefined>> {
  let userEnv: Record<string, string> = {};
  try {
    const env = (await readSettings("user", "")).env;
    if (env && typeof env === "object") userEnv = env as Record<string, string>;
  } catch {
    // fall through with the process env alone
  }
  return { ...process.env, ...userEnv };
}
