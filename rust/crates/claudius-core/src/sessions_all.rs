//! `GET /api/sessions/all` (`app/api/sessions/all/route.ts`), with the
//! account join of `lib/server/session-accounts.ts` and sessions-db.ts
//! `getSessionAccountsByCwd`.
//!
//! The listing is the SDK's ([`sessions_store::list`], `limit` passed on)
//! plus an entry for every `sessions` row whose id it didn't return
//! (`{sessionId, summary: title ?? "", lastModified: last_seen_at ||
//! updated_at || created_at || 0, cwd}`), from `dir`'s database or from
//! every workspace's ([`sessions_db::list_all_indexed_sessions`]). Each
//! entry with a Claudius title ([`sessions_db::get_session_titles_by_cwd_cells`],
//! the `{cwd}:{id}` key, else `*:{id}`) gets `claudiusTitle`. Then V8's
//! sort on `lastModified` (as `-` coerces it), JS `slice(0, limit)`, and
//! the account pin of each kept entry (`accountId`, `accountLabel`; a
//! deleted profile reads `Removed account`), with `accountsConfigured` the
//! number of profiles.
//!
//! Row cells stay as better-sqlite3 hands them to JS: a BLOB id is a
//! `Buffer` (`{"type":"Buffer","data":[…]}`, keyed by its UTF-8 text), a
//! NULL id `null`, a TEXT stamp a string. A throw from the rows or the
//! titles is the route's 500 (`Err` here); the account join is best effort
//! and never fails the listing. Nothing here reads the live sessions: the
//! TS route doesn't either.
//!
//! S30 ports `session-accounts.ts` as its own module for the Cost page;
//! this join is kept private here because it takes the DB-only rows' ids as
//! JS values, not strings.

use std::collections::{HashMap, HashSet};

use claudius_agent::js;
use indexmap::IndexMap;
use serde_json::{Map, Value, json};

use crate::accounts::AccountsStore;
use crate::asset_list::{Cell, v8_sort};
use crate::db::{Mode, open_db};
use crate::session_history;
use crate::sessions_db::{self, SessionRow};
use crate::sessions_store::{self, SessionInfo};

/// One listed session as the route holds it.
#[derive(Clone)]
struct Entry {
    json: Map<String, Value>,
    /// `s.sessionId`.
    id: Cell,
    /// `s.cwd` when truthy, as a template literal prints it.
    cwd: Option<String>,
    /// `s.lastModified ?? 0` as `-` coerces it.
    last_modified: f64,
}

impl Entry {
    fn from_info(info: &SessionInfo) -> Entry {
        let json = match serde_json::to_value(info) {
            Ok(Value::Object(m)) => m,
            _ => Map::new(),
        };
        Entry {
            json,
            id: Cell::Text(info.session_id.clone()),
            cwd: info.cwd.clone().filter(|c| !c.is_empty()),
            last_modified: info.last_modified as f64,
        }
    }

    /// The entry synthesized for a DB-only row.
    fn from_row(row: SessionRow) -> Entry {
        let last_modified = [row.last_seen_at, row.updated_at, row.created_at]
            .into_iter()
            .find(Cell::truthy)
            .unwrap_or(Cell::Num(0.0));
        let summary = match row.title {
            Cell::Null => Value::String(String::new()),
            t => t.to_json(),
        };
        let mut json = Map::new();
        json.insert("sessionId".into(), row.id.to_json());
        json.insert("summary".into(), summary);
        json.insert("lastModified".into(), last_modified.to_json());
        json.insert("cwd".into(), row.cwd.to_json());
        Entry {
            json,
            cwd: row.cwd.truthy().then(|| row.cwd.to_js_string()),
            id: row.id,
            last_modified: last_modified.to_number(),
        }
    }
}

/// `Number(searchParams.get("limit") || "200") || 200`.
pub fn limit_param(raw: Option<&str>) -> f64 {
    let n = js::to_number(raw.filter(|s| !s.is_empty()).unwrap_or("200"));
    if n.is_nan() || n == 0.0 { 200.0 } else { n }
}

/// The end `slice(0, end)` stops at, for a JS number `end`.
fn slice_end(len: usize, end: f64) -> usize {
    let n = if end.is_nan() { 0.0 } else { end.trunc() };
    let len = len as f64;
    (if n < 0.0 {
        (len + n).max(0.0)
    } else {
        n.min(len)
    }) as usize
}

/// The route's 200 body `{sessions, accountsConfigured}` for `dir` (`""` is
/// none) and `limit` ([`limit_param`]), or the message of what it catches.
///
/// `is_live` is `(id) => sessionManager.get(id) !== undefined`: CC 2.1.309
/// drops a DB-only row with no title unless its session is still open
/// ([`session_history`]).
pub fn list_all(
    dir: Option<&str>,
    limit: f64,
    is_live: &dyn Fn(&str) -> bool,
) -> Result<Value, String> {
    let dir = dir.filter(|d| !d.is_empty());
    let sessions = sessions_store::list(dir, Some(limit), None);
    let sdk_ids: HashSet<&str> = sessions.iter().map(|s| s.session_id.as_str()).collect();
    let rows = sessions_db::list_all_indexed_sessions(dir).map_err(|e| e.to_string())?;
    let mut entries: Vec<Entry> = sessions.iter().map(Entry::from_info).collect();
    for row in rows {
        if matches!(&row.id, Cell::Text(id) if sdk_ids.contains(id.as_str())) {
            continue;
        }
        // CC 2.1.309: an abandoned new tab leaves an untitled row and no
        // transcript; history keeps it only while it is open. A truthy
        // non-string title throws, which the route answers as its 500.
        match session_history::is_history_worthy_db_row(
            session_history::title_of(&row.title),
            || session_history::id_is_live(&row.id, is_live),
        ) {
            Ok(true) => {}
            Ok(false) => continue,
            Err(msg) => return Err(msg.to_owned()),
        }
        entries.push(Entry::from_row(row));
    }

    let titles = {
        let pairs: Vec<(Option<&str>, &Cell)> =
            entries.iter().map(|e| (e.cwd.as_deref(), &e.id)).collect();
        sessions_db::get_session_titles_by_cwd_cells(&pairs).map_err(|e| e.to_string())?
    };
    for e in &mut entries {
        let id = e.id.to_js_string();
        let title = e
            .cwd
            .as_ref()
            .and_then(|cwd| titles.get(&format!("{cwd}:{id}")))
            .or_else(|| titles.get(&format!("*:{id}")));
        if let Some(t) = title {
            e.json
                .insert("claudiusTitle".into(), Value::String(t.clone()));
        }
    }

    v8_sort(&mut entries, |a, b| b.last_modified - a.last_modified);
    entries.truncate(slice_end(entries.len(), limit));

    let (by_key, accounts_configured) = {
        let pairs: Vec<(Option<&str>, &Cell)> =
            entries.iter().map(|e| (e.cwd.as_deref(), &e.id)).collect();
        resolve_session_accounts(&pairs)
    };
    let sessions: Vec<Value> = entries
        .into_iter()
        .map(|mut e| {
            if let Some((id, label)) =
                lookup_session_account(&by_key, e.cwd.as_deref(), &e.id.to_js_string())
            {
                e.json.insert("accountId".into(), Value::String(id.clone()));
                e.json
                    .insert("accountLabel".into(), Value::String(label.clone()));
            }
            Value::Object(e.json)
        })
        .collect();
    Ok(json!({"sessions": sessions, "accountsConfigured": accounts_configured}))
}

/// `{accountId, accountLabel}` by title-style key.
type AccountRefs = IndexMap<String, (String, String)>;

/// `resolveSessionAccounts(pairs)`: no pairs, or any failure (a `null`
/// workspace entry, an `accounts.json` that can't be read or parsed), is an
/// empty map and 0. A profile id listed twice is labelled by its last entry
/// and counted twice.
fn resolve_session_accounts(pairs: &[(Option<&str>, &Cell)]) -> (AccountRefs, usize) {
    if pairs.is_empty() {
        return (IndexMap::new(), 0);
    }
    // `Promise.all`: both run whatever the other does.
    let pins = get_session_accounts_by_cwd(pairs);
    let accounts = AccountsStore::from_env().read_raw();
    let (Ok(pins), Ok(accounts)) = (pins, accounts) else {
        return (IndexMap::new(), 0);
    };
    let labels: HashMap<&str, &str> = accounts
        .profiles
        .iter()
        .map(|p| (p.id(), p.label()))
        .collect();
    let by_key = pins
        .into_iter()
        .map(|(key, id)| {
            let label = labels
                .get(id.as_str())
                .copied()
                .unwrap_or("Removed account");
            let label = label.to_owned();
            (key, (id, label))
        })
        .collect();
    (by_key, accounts.profiles.len())
}

/// `lookupSessionAccount`: the `{cwd}:{id}` entry (truthy cwd), else `*:{id}`.
fn lookup_session_account<'a>(
    by_key: &'a AccountRefs,
    cwd: Option<&str>,
    id: &str,
) -> Option<&'a (String, String)> {
    cwd.and_then(|c| by_key.get(&format!("{c}:{id}")))
        .or_else(|| by_key.get(&format!("*:{id}")))
}

/// `getSessionAccountsByCwd(pairs)`: each pair's pinned profile id, keyed as
/// [`sessions_db::get_session_titles_by_cwd_cells`] keys titles (no legacy
/// file). Throws only on a `null` workspace entry.
fn get_session_accounts_by_cwd(
    pairs: &[(Option<&str>, &Cell)],
) -> anyhow::Result<IndexMap<String, String>> {
    let mut by_cwd: IndexMap<&str, Vec<&Cell>> = IndexMap::new();
    let mut no_cwd: Vec<&Cell> = Vec::new();
    for &(cwd, id) in pairs {
        if !id.truthy() {
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
            let still_missing: Vec<&Cell> = no_cwd
                .iter()
                .filter(|id| !out.contains_key(&format!("*:{}", id.to_js_string())))
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

/// `probeCwdAccounts`: `state.accountProfileId` for `ids` in chunks of 500
/// on the read-only handle. A chunk whose query fails (a `state` that
/// isn't JSON) is skipped whole; only a non-empty string pin counts (an
/// object pin is its JSON text); the first pin per key wins.
fn probe_accounts(cwd: &str, ids: &[&Cell], out: &mut IndexMap<String, String>, unkeyed: bool) {
    let Ok(db) = open_db(cwd, Mode::ReadOnly) else {
        return;
    };
    for chunk in ids.chunks(500) {
        let sql = format!(
            "SELECT id, json_extract(state, '$.accountProfileId') AS account
               FROM sessions
              WHERE json_extract(state, '$.accountProfileId') IS NOT NULL
                AND id IN ({})",
            vec!["?"; chunk.len()].join(",")
        );
        let rows = db.with(|c| {
            let mut st = c.prepare(&sql)?;
            let rows = st.query_map(rusqlite::params_from_iter(chunk.iter()), |r| {
                Ok((Cell::read(r.get_ref(0)?), Cell::read(r.get_ref(1)?)))
            })?;
            rows.collect::<rusqlite::Result<Vec<_>>>()
        });
        let Ok(rows) = rows else { continue };
        for (id, account) in rows {
            let Cell::Text(account) = account else {
                continue;
            };
            if account.is_empty() {
                continue;
            }
            let key = if unkeyed {
                format!("*:{}", id.to_js_string())
            } else {
                format!("{cwd}:{}", id.to_js_string())
            };
            out.entry(key).or_insert(account);
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn limit_reads_like_number_or_200() {
        for (raw, want) in [
            (None, 200.0),
            (Some(""), 200.0),
            (Some("0"), 200.0),
            (Some("abc"), 200.0),
            (Some("0x2"), 2.0),
            (Some(" 3 "), 3.0),
            (Some("-2"), -2.0),
            (Some("2.5"), 2.5),
            (Some("1e1"), 10.0),
        ] {
            assert_eq!(limit_param(raw), want, "{raw:?}");
        }
        assert_eq!(limit_param(Some("Infinity")), f64::INFINITY);
    }

    #[test]
    fn slice_end_is_js_slice() {
        assert_eq!(slice_end(5, 2.0), 2);
        assert_eq!(slice_end(5, 2.9), 2);
        assert_eq!(slice_end(5, 9.0), 5);
        assert_eq!(slice_end(5, -2.0), 3);
        assert_eq!(slice_end(5, -2.5), 3);
        assert_eq!(slice_end(5, -9.0), 0);
        assert_eq!(slice_end(5, f64::INFINITY), 5);
        assert_eq!(slice_end(5, f64::NEG_INFINITY), 0);
        assert_eq!(slice_end(0, 3.0), 0);
    }

    #[test]
    fn synthetic_entries_take_the_first_truthy_stamp() {
        let row = |seen: Cell, updated: Cell, created: Cell, title: Cell| SessionRow {
            id: Cell::Text("x".into()),
            cwd: Cell::Text("/w".into()),
            title,
            model: Cell::Null,
            created_at: created,
            updated_at: updated,
            last_seen_at: seen,
        };
        let e = Entry::from_row(row(
            Cell::Num(0.0),
            Cell::Text(String::new()),
            Cell::Num(7.0),
            Cell::Null,
        ));
        assert_eq!(
            js::stringify(&Value::Object(e.json)),
            r#"{"sessionId":"x","summary":"","lastModified":7,"cwd":"/w"}"#
        );
        let e = Entry::from_row(row(
            Cell::Blob(b"12".to_vec()),
            Cell::Num(1.0),
            Cell::Num(1.0),
            Cell::Text("t".into()),
        ));
        assert_eq!(e.last_modified, 12.0);
        let e = Entry::from_row(row(Cell::Null, Cell::Null, Cell::Null, Cell::Null));
        assert_eq!(e.json["lastModified"], json!(0));
        assert_eq!(e.last_modified, 0.0);
    }

    #[test]
    fn account_lookup_prefers_the_cwd_key() {
        let mut by_key = AccountRefs::new();
        by_key.insert("/w:a".into(), ("p1".into(), "One".into()));
        by_key.insert("*:a".into(), ("p2".into(), "Two".into()));
        by_key.insert("*:b".into(), ("p3".into(), "Three".into()));
        let id = |cwd, id| lookup_session_account(&by_key, cwd, id).map(|r| r.0.as_str());
        assert_eq!(id(Some("/w"), "a"), Some("p1"));
        assert_eq!(id(None, "a"), Some("p2"));
        assert_eq!(id(Some("/other"), "a"), Some("p2"));
        assert_eq!(id(Some("/w"), "b"), Some("p3"));
        assert_eq!(id(Some("/w"), "c"), None);
    }
}
