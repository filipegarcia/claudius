//! `lib/server/cost-overview.ts` + `lib/shared/cost-overview.ts` (D18b):
//! spend across every project and every account on this machine, the
//! Account page's overview (`GET /api/cost/overview`).
//!
//! It walks every `homedir()/.claude/projects/<dir>` (real directories
//! only), plus a profile's own `projects` dir under
//! `<accountsDir>/profiles/<id>/` when it is a real directory and not the
//! main one, merged by dir name. Each dir goes through the same rows, cache
//! and pricing as the Cost page ([`cost_aggregate`]), so a workspace's
//! numbers match its page, except that the `message.id:requestId` dedup is
//! global: a call replayed into another project counts once, for the oldest
//! file.
//!
//! A project is labelled with its workspace's name, else its cwd (`~` for
//! the home dir), else the dir name; the cwd is the workspace root or the
//! first non-empty string `cwd` in the first 64 KiB of one of the dir's
//! first 8 transcripts (remembered for the process once found). Accounts
//! come from each session's pin in the project's `.claudius.db` (read only,
//! and only when the cwd encodes back to the dir and the main tree has it),
//! else the profile whose `projects` dir holds it, else [`UNPINNED_ACCOUNT_KEY`].
//! A file whose rows sum to 0 counts for no project or account. Projects
//! and accounts are sorted most expensive first (V8's sort), days by
//! `localeCompare`.
//!
//! JS mirrored: a `null` workspace entry throws reading `rootPath`, and a
//! truthy non-string `rootPath` throws in `encodeProjectDir`; a pricing
//! override that throws fails the whole overview.

use std::collections::{HashMap, HashSet};
use std::sync::{Arc, LazyLock, Mutex};

use claudius_agent::js;
use indexmap::{IndexMap, IndexSet};
use serde_json::{Map, Value, json};

use crate::accounts::{self, AccountsStore};
use crate::asset_list::v8_sort;
use crate::cost_aggregate::{
    self as agg, Clock, FileSummary, Thrown, file_order, locale_order, row_usd,
    session_id_for_transcript, summarize_project_dir,
};
use crate::litellm_pricing::PricingTable;
use crate::{db_agents, js_num, js_string, node_fs, node_path, paths, session_accounts, settings};

/// `UNPINNED_ACCOUNT_KEY`: spend in sessions without a pinned profile.
pub const UNPINNED_ACCOUNT_KEY: &str = "_unpinned";

/// One `projects` dir holding a project, and the profile it belongs to.
struct Source {
    dir: String,
    profile_id: Option<String>,
}

/// `fs.realpath(p).catch(() => p)`.
fn realpath_or(p: &str) -> String {
    std::fs::canonicalize(p).map_or_else(|_| p.to_owned(), |r| r.to_string_lossy().into_owned())
}

/// `listProjectSources()`: project dirs by name, the main tree first.
fn list_project_sources(home: &str) -> IndexMap<String, Vec<Source>> {
    let mut out: IndexMap<String, Vec<Source>> = IndexMap::new();
    let mut add_root = |root: &str, profile_id: Option<&str>| {
        let Ok(entries) = node_fs::readdir_dirents(root) else {
            return;
        };
        for (name, kind) in entries {
            if !kind.is_dir() {
                continue; // a symlinked project dir isn't followed
            }
            out.entry(name.clone()).or_default().push(Source {
                dir: node_path::join(&[root, &name]),
                profile_id: profile_id.map(str::to_owned),
            });
        }
    };
    let main = node_path::join(&[home, ".claude", "projects"]);
    add_root(&main, None);
    let main_real = realpath_or(&main);
    let profiles_root = node_path::join(&[&accounts::accounts_dir(), "profiles"]);
    for (p, kind) in node_fs::readdir_dirents(&profiles_root).unwrap_or_default() {
        if !kind.is_dir() {
            continue;
        }
        let root = node_path::join(&[&profiles_root, &p, "projects"]);
        // Missing, or the usual symlink to the main tree.
        if !std::fs::symlink_metadata(&root).is_ok_and(|m| m.is_dir()) {
            continue;
        }
        if realpath_or(&root) == main_real {
            continue;
        }
        add_root(&root, Some(&p));
    }
    out
}

/// `readHead(path, max)`: the first `max` bytes (one read) as UTF-8.
fn read_head(path: &str, max: usize) -> std::io::Result<String> {
    let f = std::fs::File::open(path)?;
    let mut buf = vec![0u8; max];
    #[cfg(unix)]
    let n = std::os::unix::fs::FileExt::read_at(&f, &mut buf, 0)?;
    #[cfg(not(unix))]
    let n = std::io::Read::read(&mut &f, &mut buf)?;
    Ok(String::from_utf8_lossy(&buf[..n]).into_owned())
}

/// `cwdMemo`: a project dir's cwd, once found.
static CWD_MEMO: LazyLock<Mutex<HashMap<String, String>>> = LazyLock::new(Default::default);

/// `transcriptCwd(key, dirs)`.
fn transcript_cwd(key: &str, dirs: &[&str]) -> Option<String> {
    if let Some(m) = CWD_MEMO.lock().unwrap().get(key) {
        return Some(m.clone());
    }
    for dir in dirs {
        let Ok(names) = node_fs::readdir(dir) else {
            continue;
        };
        for name in names.iter().filter(|n| n.ends_with(".jsonl")).take(8) {
            let Ok(head) = read_head(&node_path::join(&[dir, name]), 64 * 1024) else {
                continue;
            };
            for line in head.split('\n') {
                if !line.contains("\"cwd\"") {
                    continue;
                }
                let Ok(r) = db_agents::json_parse_js(line) else {
                    continue; // torn last line of the head, or not JSON
                };
                if let Some(cwd) = r
                    .as_object()
                    .and_then(|o| o.get("cwd"))
                    .and_then(db_agents::as_str)
                    .filter(|c| !c.is_empty())
                {
                    CWD_MEMO
                        .lock()
                        .unwrap()
                        .insert(key.to_owned(), cwd.to_owned());
                    return Some(cwd.to_owned());
                }
            }
        }
    }
    None
}

/// `displayPath(cwd)`.
fn display_path(cwd: &str, home: &str) -> String {
    if cwd == home {
        return "~".into();
    }
    match cwd.strip_prefix(&format!("{home}/")) {
        Some(rest) => format!("~/{rest}"),
        None => cwd.to_owned(),
    }
}

#[derive(Default)]
struct Acc {
    usd: f64,
    sessions: HashSet<String>,
    last: f64,
}

struct Meta {
    label: Value,
    cwd: Option<String>,
    workspace_id: Value,
}

struct Tagged {
    file: FileSummary,
    project: String,
    account: String,
    session_key: String,
    pricing: Option<Value>,
}

type DaySums = (f64, IndexMap<String, f64>, IndexMap<String, f64>);

/// `Math.max(a, b)` on the non-NaN `lastSeenMs`s.
fn max(a: f64, b: f64) -> f64 {
    if b > a { b } else { a }
}

fn object(m: &IndexMap<String, f64>) -> Value {
    Value::Object(m.iter().map(|(k, v)| (k.clone(), js_num(*v))).collect())
}

/// `key.slice(0, 12)` in UTF-16 units.
fn slice12(key: &str) -> String {
    let units = js_string::units(key);
    js_string::from_units(&units[..units.len().min(12)])
}

/// `aggregateOverview()`, with `table` from `getPricingTable()`.
pub fn aggregate_overview(table: Arc<PricingTable>, clock: &Clock) -> Result<Value, Thrown> {
    let home = paths::home_dir().to_string_lossy().into_owned();
    let sources = list_project_sources(&home);
    let workspaces = crate::workspaces::list_raw().unwrap_or_default();
    let profiles = AccountsStore::from_env()
        .read_raw()
        .map(|s| s.profiles)
        .unwrap_or_default();
    let labels: HashMap<&str, &str> = profiles.iter().map(|p| (p.id(), p.label())).collect();
    // `workspaces.filter((w) => w.rootPath)`, then `encodeProjectDir` of each.
    let mut with_root = Vec::new();
    for w in &workspaces {
        match w {
            Value::Null => return Err("Cannot read properties of null (reading 'rootPath')".into()),
            Value::Object(m) if m.get("rootPath").is_some_and(js::truthy) => with_root.push(m),
            _ => {}
        }
    }
    let mut ws_by_dir: HashMap<String, (&str, &Map<String, Value>)> = HashMap::new();
    for m in with_root {
        let Some(root) = db_agents::as_str(&m["rootPath"]) else {
            return Err("absPath.replace is not a function".into());
        };
        ws_by_dir.insert(paths::encode_project_dir(root), (root, m));
    }

    let mut meta: IndexMap<String, Meta> = IndexMap::new();
    let mut tagged: Vec<Tagged> = Vec::new();
    let mut pricing_override_active = false;
    for (key, srcs) in &sources {
        let mut found: Vec<(&Source, Vec<FileSummary>)> = Vec::new();
        for src in srcs {
            let files: Vec<FileSummary> = summarize_project_dir(&src.dir, &clock.tz)?
                .unwrap_or_default()
                .into_iter()
                .filter(|f| !f.rows.is_empty())
                .collect();
            if !files.is_empty() {
                found.push((src, files));
            }
        }
        if found.is_empty() {
            continue; // no spend: skip the cwd lookup and the DB
        }
        let ws = ws_by_dir.get(key);
        let cwd = match ws {
            Some((root, _)) => Some((*root).to_owned()),
            None => {
                let dirs: Vec<&str> = srcs.iter().map(|s| s.dir.as_str()).collect();
                transcript_cwd(key, &dirs)
            }
        };
        let field = |k: &str| {
            ws.and_then(|(_, m)| m.get(k))
                .filter(|v| !v.is_null())
                .map(settings::plain)
        };
        meta.insert(
            key.clone(),
            Meta {
                label: field("name").unwrap_or_else(|| {
                    json!(
                        cwd.as_deref()
                            .map_or_else(|| key.clone(), |c| display_path(c, &home))
                    )
                }),
                cwd: cwd.clone(),
                workspace_id: field("id").unwrap_or(Value::Null),
            },
        );

        // The pins live in the project's `.claudius.db`, at `projectRoot(cwd)`.
        let mut pins = IndexMap::new();
        if let Some(c) = &cwd
            && paths::encode_project_dir(c) == *key
            && srcs.iter().any(|s| s.profile_id.is_none())
        {
            let mut ids: IndexSet<String> = IndexSet::new();
            for (src, files) in &found {
                for f in files {
                    ids.insert(session_id_for_transcript(&src.dir, &f.path));
                }
            }
            let pairs: Vec<(Option<&str>, &str)> = ids
                .iter()
                .map(|id| (Some(c.as_str()), id.as_str()))
                .collect();
            pins = session_accounts::get_session_accounts_by_cwd(&pairs).unwrap_or_default();
        }
        let pricing = agg::resolve_pricing(cwd.as_deref().unwrap_or(&home));
        if agg::has_override(pricing.as_ref())? {
            pricing_override_active = true;
        }

        let pin_cwd = cwd.as_deref().unwrap_or("null");
        for (src, files) in found {
            for file in files {
                let id = session_id_for_transcript(&src.dir, &file.path);
                let account = pins
                    .get(&format!("{pin_cwd}:{id}"))
                    .cloned()
                    .or_else(|| src.profile_id.clone())
                    .unwrap_or_else(|| UNPINNED_ACCOUNT_KEY.to_owned());
                tagged.push(Tagged {
                    file,
                    project: key.clone(),
                    account,
                    session_key: format!("{key}:{id}"),
                    pricing: pricing.clone(),
                });
            }
        }
    }

    // Oldest file first (then path), like `aggregate`.
    let mut order: Vec<usize> = (0..tagged.len()).collect();
    v8_sort(&mut order, |a, b| {
        file_order(&tagged[*a].file, &tagged[*b].file)
    });

    let mut dedup: HashSet<&str> = HashSet::new();
    let mut days: IndexMap<String, DaySums> = IndexMap::new();
    let mut by_project: IndexMap<String, Acc> = IndexMap::new();
    let mut by_account: IndexMap<String, Acc> = IndexMap::new();
    let mut total = 0.0;
    for &i in &order {
        let t = &tagged[i];
        let mut file_usd = 0.0;
        for row in &t.file.rows {
            if let Some(k) = &row.k
                && !dedup.insert(k)
            {
                continue;
            }
            let usd = row_usd(row, &table, t.pricing.as_ref())?;
            total += usd;
            file_usd += usd;
            let day = days.entry(row.d.clone()).or_default();
            day.0 += usd;
            *day.1.entry(t.project.clone()).or_insert(0.0) += usd;
            *day.2.entry(t.account.clone()).or_insert(0.0) += usd;
        }
        if file_usd == 0.0 {
            continue; // fully duplicated elsewhere (or free)
        }
        for (map, key) in [(&mut by_project, &t.project), (&mut by_account, &t.account)] {
            let acc = map.entry(key.clone()).or_default();
            acc.usd += file_usd;
            acc.sessions.insert(t.session_key.clone());
            acc.last = max(acc.last, t.file.last_seen_ms);
        }
    }

    let mut day_list: Vec<(String, DaySums)> = days.into_iter().collect();
    v8_sort(&mut day_list, |a, b| locale_order(&a.0, &b.0));

    let mut projects: Vec<(f64, Value)> = by_project
        .iter()
        .map(|(key, acc)| {
            let mut o = Map::new();
            match meta.get(key) {
                Some(m) => {
                    o.insert("key".into(), json!(key));
                    o.insert("label".into(), m.label.clone());
                    o.insert("cwd".into(), json!(m.cwd));
                    o.insert("workspaceId".into(), m.workspace_id.clone());
                }
                None => {
                    o.insert("key".into(), json!(key));
                    o.insert("label".into(), json!(key));
                    o.insert("cwd".into(), Value::Null);
                    o.insert("workspaceId".into(), Value::Null);
                }
            }
            o.insert("usd".into(), js_num(acc.usd));
            o.insert("sessions".into(), js_num(acc.sessions.len() as f64));
            o.insert("lastSeenMs".into(), js_num(acc.last));
            (acc.usd, Value::Object(o))
        })
        .collect();
    v8_sort(&mut projects, |a, b| b.0 - a.0);

    let mut accounts: Vec<(f64, Value)> = by_account
        .iter()
        .map(|(key, acc)| {
            let unpinned = key == UNPINNED_ACCOUNT_KEY;
            let label = if unpinned {
                Some("No profile")
            } else {
                labels.get(key.as_str()).copied()
            };
            let v = json!({
                "key": key,
                "label": label.map_or_else(|| format!("Removed account ({})", slice12(key)), str::to_owned),
                "accountId": if unpinned { Value::Null } else { json!(key) },
                "removed": !unpinned && label.is_none(),
                "usd": js_num(acc.usd),
                "sessions": js_num(acc.sessions.len() as f64),
                "lastSeenMs": js_num(acc.last),
            });
            (acc.usd, v)
        })
        .collect();
    v8_sort(&mut accounts, |a, b| b.0 - a.0);

    let (today, week, month) = agg::windows(day_list.iter().map(|(d, s)| (d.as_str(), s.0)), clock);
    Ok(json!({
        "generatedAt": js_num(clock.now_ms),
        "totalUsd": js_num(total),
        "todayUsd": js_num(today),
        "weekUsd": js_num(week),
        "monthUsd": js_num(month),
        "days": day_list.iter().map(|(date, (usd, p, a))| json!({
            "date": date,
            "usd": js_num(*usd),
            "byProject": object(p),
            "byAccount": object(a),
        })).collect::<Vec<_>>(),
        "projects": projects.into_iter().map(|(_, v)| v).collect::<Vec<_>>(),
        "accounts": accounts.into_iter().map(|(_, v)| v).collect::<Vec<_>>(),
        "accountsConfigured": profiles.len(),
        "pricingOverrideActive": pricing_override_active,
    }))
}
