import { getSessionAccountsByCwd } from "@/lib/server/sessions-db";
import { readAccountsRaw } from "@/lib/server/accounts-store";

/**
 * Resolve "which account profile is this session pinned to?" for a batch of
 * sessions, as a client-safe `{ accountId, accountLabel }` pair.
 *
 * Joins two stores that deliberately live apart: the pin (per-project
 * `.claudius.db`, `sessions.state.accountProfileId`) and the profile
 * registry (system-global `~/.claude/.claudius/accounts.json`). Every
 * listing surface needs exactly this join, so it lives here rather than
 * being re-derived in each route.
 *
 * Two deliberate behaviors:
 *
 *  - **A deleted profile still reports its id.** The pin outlives the
 *    profile — `resolveAccountProfile()` only re-pins when the session is
 *    next started. Rather than dropping the row (which would read as "no
 *    account" — indistinguishable from an unpinned session) we return the
 *    id with a `Removed account` label so the UI can still say "this thread
 *    was on something that no longer exists".
 *
 *  - **`accountsConfigured` is returned alongside.** The UI only shows the
 *    badge when more than one profile exists — with a single account the
 *    answer is never ambiguous and the badge is pure noise. Callers get the
 *    count from the same read instead of a second round-trip to
 *    `/api/accounts`.
 *
 * Best-effort: any failure yields an empty map and a zero count, so a
 * listing never 500s over a decoration.
 */
export type SessionAccountRef = { accountId: string; accountLabel: string };

export async function resolveSessionAccounts(
  pairs: ReadonlyArray<{ cwd: string | undefined; id: string }>,
): Promise<{ byKey: Map<string, SessionAccountRef>; accountsConfigured: number }> {
  const empty = { byKey: new Map<string, SessionAccountRef>(), accountsConfigured: 0 };
  if (pairs.length === 0) return empty;
  try {
    const [pins, accounts] = await Promise.all([
      getSessionAccountsByCwd(pairs),
      readAccountsRaw(),
    ]);
    const labels = new Map(accounts.profiles.map((p) => [p.id, p.label]));
    const byKey = new Map<string, SessionAccountRef>();
    for (const [key, accountId] of pins) {
      byKey.set(key, {
        accountId,
        accountLabel: labels.get(accountId) ?? "Removed account",
      });
    }
    return { byKey, accountsConfigured: accounts.profiles.length };
  } catch {
    return empty;
  }
}

/**
 * Two-key probe matching `resolveSessionAccounts`' key scheme: prefer the
 * cwd-scoped entry, fall back to the cwd-less fan-out entry. Callers already
 * do this by hand for titles; this keeps the account lookup from drifting.
 */
export function lookupSessionAccount(
  byKey: Map<string, SessionAccountRef>,
  cwd: string | undefined,
  id: string,
): SessionAccountRef | undefined {
  return (cwd ? byKey.get(`${cwd}:${id}`) : undefined) ?? byKey.get(`*:${id}`);
}
