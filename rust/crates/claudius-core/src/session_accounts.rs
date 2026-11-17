//! `lib/server/session-accounts.ts` (`resolveSessionAccounts`,
//! `lookupSessionAccount`) and sessions-db.ts `getSessionAccountsByCwd`:
//! which account profile each listed session is pinned to (S30), for the
//! listing surfaces (the sessions page's `/api/sessions/all`, the Cost
//! page's per-session table) that show sessions no longer live.
//!
//! The pin is the `accountProfileId` of the session's state bag
//! ([`crate::account_pinning`]), read with SQLite's `json_extract`; the label
//! comes from the account store. A pinned profile that was deleted still
//! reports its id, labelled `Removed account`. Keys follow
//! `getSessionTitlesByCwd`: `<cwd>:<id>` for a pair with a cwd, `*:<id>` for
//! one without (looked up in every workspace's database).
//!
//! Not wired yet: both TS callers (`/api/sessions/all`, D19, and the Cost
//! route's `cost-aggregate.ts`, D18) are still served by Next.

use claudius_agent::js;
use indexmap::IndexMap;
use rusqlite::types::ValueRef;
use serde_json::{Value, json};

use crate::accounts::AccountsStore;
use crate::db::{Mode, open_db};
use crate::sessions_db::js_string;
use crate::sql_text::{self, JsText};

/// `SessionAccountRef`: `{ accountId, accountLabel }`.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct SessionAccountRef {
    pub account_id: String,
    pub account_label: String,
}

impl SessionAccountRef {
    pub fn to_json(&self) -> Value {
        json!({"accountId": self.account_id, "accountLabel": self.account_label})
    }
}

/// The label of a pin whose profile is gone.
pub const REMOVED_ACCOUNT: &str = "Removed account";

/// `getSessionAccountsByCwd(pairs)`: the pinned profile id per key, in the
/// order found. Pairs with an empty id are skipped. Each cwd's database is
/// probed read-only (one that won't open is passed over); cwd-less ids are
/// then looked up in every workspace's database in store order, the first
/// pin winning, until none is missing. Only a non-empty text pin counts (a
/// JSON object or array pin reads as its JSON text, as `json_extract` gives
/// it). A chunk whose query fails (a malformed state, no `sessions` table)
/// is skipped. Fails only where TS throws: on a `null` workspace entry.
pub fn get_session_accounts_by_cwd(
    pairs: &[(Option<&str>, &str)],
) -> anyhow::Result<IndexMap<String, String>> {
    let mut by_cwd: IndexMap<&str, Vec<&str>> = IndexMap::new();
    let mut no_cwd: Vec<&str> = Vec::new();
    for &(cwd, id) in pairs {
        if id.is_empty() {
            continue;
        }
        match cwd.filter(|c| !c.is_empty()) {
            Some(cwd) => by_cwd.entry(cwd).or_default().push(id),
            None => no_cwd.push(id),
        }
    }
    let mut out = IndexMap::new();
    for (cwd, ids) in &by_cwd {
        probe_accounts(cwd, ids, &mut out, false);
    }
    if !no_cwd.is_empty() {
        let workspaces = crate::workspaces::list_raw().unwrap_or_default();
        for ws in &workspaces {
            let root = match ws {
                Value::Null => anyhow::bail!("Cannot read properties of null (reading 'rootPath')"),
                Value::Object(m) => m.get("rootPath").filter(|v| js::truthy(v)),
                _ => None,
            };
            let Some(root) = root else { continue };
            let still_missing: Vec<&str> = no_cwd
                .iter()
                .filter(|id| !out.contains_key(&format!("*:{id}")))
                .copied()
                .collect();
            if still_missing.is_empty() {
                break;
            }
            // `openDb` rejects a non-string root, which the probe catches.
            if let Some(root) = root.as_str() {
                probe_accounts(root, &still_missing, &mut out, true);
            }
        }
    }
    Ok(out)
}

/// `probeCwdAccounts(cwd, ids, out, {unkeyed})`, in chunks of 500 ids on the
/// read-only handle; the first pin per key wins.
fn probe_accounts(cwd: &str, ids: &[&str], out: &mut IndexMap<String, String>, unkeyed: bool) {
    let Ok(db) = open_db(cwd, Mode::ReadOnly) else {
        return;
    };
    for chunk in ids.chunks(500) {
        let placeholders = vec!["?"; chunk.len()].join(",");
        let sql = format!(
            "SELECT id, json_extract(state, '$.accountProfileId') AS account
               FROM sessions
              WHERE json_extract(state, '$.accountProfileId') IS NOT NULL
                AND id IN ({placeholders})"
        );
        let rows = db.with(|c| {
            let mut stmt = c.prepare(&sql)?;
            let ids = rusqlite::params_from_iter(chunk.iter().map(JsText::new));
            let rows = stmt.query_map(ids, |r| {
                // The key holds `String(r.id)`. In a foreign table whose `id`
                // column is numeric, `IN` matches the text ids by affinity,
                // and better-sqlite3 reads the id back as a double, printed
                // as JS does (`7`, `2.5`, `1e+21`; `07` finds the row but
                // keys it as `7`). TEXT decodes as better-sqlite3 reads it.
                let id = match r.get_ref(0)? {
                    ValueRef::Text(_) => sql_text::get::<String, _>(r, 0)?,
                    v => js_string(v),
                };
                Ok((id, text_pin(r.get_ref(1)?)))
            })?;
            rows.collect::<rusqlite::Result<Vec<_>>>()
        });
        let Ok(rows) = rows else { continue };
        for (id, account) in rows {
            let Some(account) = account else { continue };
            let key = if unkeyed {
                format!("*:{id}")
            } else {
                format!("{cwd}:{id}")
            };
            out.entry(key).or_insert(account);
        }
    }
}

/// `typeof r.account === "string" && r.account`.
fn text_pin(v: ValueRef) -> Option<String> {
    match v {
        ValueRef::Text(t) if !t.is_empty() => Some(String::from_utf8_lossy(t).into_owned()),
        _ => None,
    }
}

/// `resolveSessionAccounts(pairs)`: each pinned key with its profile's
/// label (the last profile of that id; `Removed account` when none is
/// left), and how many profiles the store holds. Any failure (the store
/// can't be read, a `null` workspace entry) gives nothing and 0, so a
/// listing never fails over it.
pub fn resolve_session_accounts(
    store: &AccountsStore,
    pairs: &[(Option<&str>, &str)],
) -> (IndexMap<String, SessionAccountRef>, usize) {
    if pairs.is_empty() {
        return (IndexMap::new(), 0);
    }
    let (Ok(pins), Ok(accounts)) = (get_session_accounts_by_cwd(pairs), store.read_raw()) else {
        return (IndexMap::new(), 0);
    };
    let labels: std::collections::HashMap<&str, &str> = accounts
        .profiles
        .iter()
        .map(|p| (p.id(), p.label()))
        .collect();
    let by_key = pins
        .into_iter()
        .map(|(key, account_id)| {
            let account_label = labels
                .get(account_id.as_str())
                .map_or(REMOVED_ACCOUNT, |l| l)
                .to_owned();
            (
                key,
                SessionAccountRef {
                    account_id,
                    account_label,
                },
            )
        })
        .collect();
    (by_key, accounts.profiles.len())
}

/// `lookupSessionAccount(byKey, cwd, id)`: the cwd's entry when there is a
/// cwd, else (or failing that) the cwd-less one.
pub fn lookup_session_account<'a>(
    by_key: &'a IndexMap<String, SessionAccountRef>,
    cwd: Option<&str>,
    id: &str,
) -> Option<&'a SessionAccountRef> {
    cwd.filter(|c| !c.is_empty())
        .and_then(|c| by_key.get(&format!("{c}:{id}")))
        .or_else(|| by_key.get(&format!("*:{id}")))
}
