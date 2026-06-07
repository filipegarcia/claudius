import { readAccountsRaw } from "./accounts-store";
import { readClaudeGlobalOauthAccount } from "./claude-global-config";

/**
 * Resolve the name shown in the splash greeting ("Good evening, <name>")
 * when the workspace doesn't carry a user-typed override.
 *
 * Policy (matches the user spec):
 *   - 2+ accounts configured → use the ACTIVE profile's `label`. With
 *     multiple accounts the label is what distinguishes them in the
 *     switcher ("Work Max", "Personal Pro"), so it's also the most
 *     meaningful name to show on the splash.
 *   - 0 or 1 accounts → prefer the OAuth `displayName` from the global
 *     `~/.claude.json` (the real human name Claude Code populated at
 *     /login). Falls back to the single account's label if the global
 *     config has nothing — or null when neither source has anything.
 *
 * Returns the FIRST WORD only so "Good evening, Filipe Garcia" doesn't
 * read awkwardly. Callers wanting the raw name can call the underlying
 * stores directly.
 *
 * All reads are best-effort: an unreadable accounts.json or .claude.json
 * just falls through to the next branch / null, never throws.
 */
export async function resolveSplashFallbackName(): Promise<string | null> {
  const accounts = await readAccountsRaw().catch(() => null);
  if (accounts && accounts.profiles.length >= 2) {
    const active = accounts.profiles.find((p) => p.id === accounts.activeProfileId);
    return firstWord(active?.label);
  }
  const global = await readClaudeGlobalOauthAccount().catch(() => null);
  if (global?.displayName) return firstWord(global.displayName);
  if (accounts && accounts.profiles.length === 1) {
    return firstWord(accounts.profiles[0].label);
  }
  return null;
}

function firstWord(s: string | undefined | null): string | null {
  if (!s) return null;
  const trimmed = s.trim();
  if (!trimmed) return null;
  return trimmed.split(/\s+/)[0] ?? null;
}
