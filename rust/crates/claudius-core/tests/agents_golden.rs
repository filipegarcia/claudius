//! The agents port (G05), replayed against the TS recording in
//! `tests/fixtures/agents_golden.json` (`rust/scripts/agents-golden.mjs`):
//! - `yaml`: [`yaml::debug_report`] gives the `yaml` package's error and
//!   warning codes and `JSON.stringify(YAML.parse(src))` on every source;
//! - `collation`: [`collate::locale_compare`] sorts the names in the order
//!   `localeCompare` did and signs every sampled pair the same;
//! - `frontmatter`: [`agents::parse_frontmatter`] splits each text the same,
//!   down to the frontmatter's JSON and its string `name`;
//! - `files` / `db`: the module calls in order, between the same filesystem
//!   and SQL setups, with the same outcomes (thrown messages included where
//!   a route shows them), then the same files and table rows;
//! - `start`: a session started in a cwd set up the same way writes the same
//!   `agents` into its `initialize` request.
//!
//! The routes replay on the real binary in
//! `claudius-server/tests/agents_routes.rs`.

use std::collections::HashMap;
use std::os::unix::fs::PermissionsExt;
use std::path::{Path, PathBuf};
use std::sync::{Arc, Mutex, OnceLock};
use std::time::{Duration, SystemTime, UNIX_EPOCH};

use claudius_agent::js;
use claudius_core::agents::{self, AgentScope};
use claudius_core::session::{RuntimeOptions, SessionOptions};
use claudius_core::session_manager::SessionManager;
use claudius_core::{collate, db, db_agents, paths, yaml};
use regex::Regex;
use serde_json::{Value, json};

fn fixture() -> &'static Value {
    static F: OnceLock<Value> = OnceLock::new();
    F.get_or_init(|| serde_json::from_str(include_str!("fixtures/agents_golden.json")).unwrap())
}

struct Env {
    _root: tempfile::TempDir,
    fake: PathBuf,
}

/// One isolated `$HOME` + config dir per test binary, and the fake CLI built.
fn env() -> &'static Env {
    static E: OnceLock<Env> = OnceLock::new();
    E.get_or_init(|| {
        let root = tempfile::tempdir().unwrap();
        let home = root.path().join("home");
        let config = root.path().join("config");
        std::fs::create_dir_all(&home).unwrap();
        std::fs::create_dir_all(&config).unwrap();
        assert!(paths::set_home_override(home));
        assert!(paths::set_config_dir_override(config));
        let cargo = std::env::var("CARGO").unwrap_or_else(|_| "cargo".into());
        let st = std::process::Command::new(cargo)
            .args([
                "build",
                "-q",
                "-p",
                "claudius-agent",
                "--bin",
                "claudius-fake-claude",
            ])
            .current_dir(env!("CARGO_MANIFEST_DIR"))
            .status()
            .unwrap();
        assert!(st.success());
        Env {
            _root: root,
            fake: PathBuf::from(env!("CARGO_MANIFEST_DIR"))
                .join("../../target/debug/claudius-fake-claude"),
        }
    })
}

/// The sections that share `$HOME` run one at a time.
fn home_lock() -> std::sync::MutexGuard<'static, ()> {
    static L: Mutex<()> = Mutex::new(());
    L.lock().unwrap_or_else(|e| e.into_inner())
}

fn now_ms() -> u64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .unwrap()
        .as_millis() as u64
}

// ─── yaml ────────────────────────────────────────────────────────────────

/// The recorder's nesting sources.
fn deep(kind: &str, n: usize) -> String {
    match kind {
        "flow" => format!("a: {}x{}", "[".repeat(n), "]".repeat(n)),
        "blockMap" => (0..n)
            .map(|i| {
                format!(
                    "{}k{i}:{}",
                    "  ".repeat(i),
                    if i == n - 1 { " x" } else { "" }
                )
            })
            .collect::<Vec<_>>()
            .join("\n"),
        "blockSeq" => (0..n)
            .map(|i| format!("{}- {}", "  ".repeat(i), if i == n - 1 { "x" } else { "" }))
            .collect::<Vec<_>>()
            .join("\n"),
        k => panic!("deep {k}"),
    }
}

#[test]
fn yaml_parses_like_the_package() {
    let cases = fixture()["yaml"].as_array().unwrap();
    assert!(cases.len() > 2000, "{} cases", cases.len());
    let mut bad = Vec::new();
    for (i, c) in cases.iter().enumerate() {
        let src = match &c[0] {
            Value::String(s) => s.clone(),
            d => deep(
                d["deep"].as_str().unwrap(),
                d["n"].as_u64().unwrap() as usize,
            ),
        };
        let mut got = yaml::debug_report(&src);
        if let Some(j) = got["result"].get("json").cloned() {
            got["result"] = json!({ "json": js::stringify(&j) });
        }
        let want =
            json!({ "errors": c[1], "warnings": c[2], "multipleDocs": c[3], "result": c[4] });
        let mut cmp = got.clone();
        for k in ["errors", "warnings", "multipleDocs"] {
            if want[k].is_null() {
                cmp[k] = Value::Null;
            }
        }
        if cmp != want {
            bad.push(format!(
                "#{i} {:?}\n  ts:   {want}\n  rust: {cmp}",
                src.chars().take(120).collect::<String>()
            ));
        }
    }
    assert!(
        bad.is_empty(),
        "{} of {} differ:\n{}",
        bad.len(),
        cases.len(),
        bad.join("\n")
    );
}

// ─── collation ───────────────────────────────────────────────────────────

#[test]
fn names_sort_like_locale_compare() {
    let c = &fixture()["collation"];
    let names: Vec<&str> = c["names"]
        .as_array()
        .unwrap()
        .iter()
        .map(|n| n.as_str().unwrap())
        .collect();
    let mut order: Vec<usize> = (0..names.len()).collect();
    order.sort_by(|a, b| collate::locale_compare(names[*a], names[*b]));
    let want: Vec<usize> = c["order"]
        .as_array()
        .unwrap()
        .iter()
        .map(|i| i.as_u64().unwrap() as usize)
        .collect();
    if order != want {
        let at = order.iter().zip(&want).position(|(a, b)| a != b).unwrap();
        panic!(
            "order differs at {at}: rust {:?} vs ts {:?}",
            names[order[at]], names[want[at]]
        );
    }
    for p in c["pairs"].as_array().unwrap() {
        let (i, j) = (
            p[0].as_u64().unwrap() as usize,
            p[1].as_u64().unwrap() as usize,
        );
        let got = collate::locale_compare(names[i], names[j]) as i64;
        assert_eq!(
            got,
            p[2].as_i64().unwrap(),
            "{:?} vs {:?}",
            names[i],
            names[j]
        );
    }
}

// ─── frontmatter ─────────────────────────────────────────────────────────

#[test]
fn frontmatter_splits_like_ts() {
    for c in fixture()["frontmatter"].as_array().unwrap() {
        let raw = c["raw"].as_str().unwrap();
        let p = agents::parse_frontmatter(raw);
        let fm = p
            .frontmatter
            .json
            .as_ref()
            .map_or("circular".to_owned(), js::stringify);
        assert_eq!(
            fm,
            c["frontmatter"].as_str().unwrap(),
            "{raw:?}: frontmatter"
        );
        let name = p.frontmatter.name.map(|u| String::from_utf16(&u).unwrap());
        assert_eq!(name.as_deref(), c["name"].as_str(), "{raw:?}: name");
        assert_eq!(p.body, c["body"].as_str().unwrap(), "{raw:?}: body");
    }
}

// ─── shared ──────────────────────────────────────────────────────────────

/// Placeholder ↔ path, as the recorder writes them.
struct Places(Vec<(&'static str, String)>);

impl Places {
    fn place(&self, s: &str) -> String {
        self.0
            .iter()
            .fold(s.to_owned(), |t, (k, v)| t.replace(v.as_str(), k))
    }
    fn unplace(&self, s: &str) -> String {
        self.0
            .iter()
            .fold(s.to_owned(), |t, (k, v)| t.replace(k, v))
    }
}

fn unhex(hex: &str) -> Vec<u8> {
    (0..hex.len())
        .step_by(2)
        .map(|i| u8::from_str_radix(&hex[i..i + 2], 16).unwrap())
        .collect()
}

fn hex(b: &[u8]) -> String {
    b.iter().map(|x| format!("{x:02x}")).collect()
}

/// One recorded filesystem setup.
fn fs_action(pl: &Places, a: &Value) {
    let path = |i: usize| PathBuf::from(pl.unplace(a[i].as_str().unwrap()));
    match a[0].as_str().unwrap() {
        "mkdir" => std::fs::create_dir_all(path(1)).unwrap(),
        "write" => std::fs::write(path(1), unhex(a[2].as_str().unwrap())).unwrap(),
        "chmod" => {
            let mode = a[2].as_u64().unwrap() as u32;
            std::fs::set_permissions(path(1), std::fs::Permissions::from_mode(mode)).unwrap();
        }
        "symlink" => std::os::unix::fs::symlink(path(2), path(1)).unwrap(),
        "rm" => {
            let p = path(1);
            let _ = std::fs::remove_dir_all(&p).or_else(|_| std::fs::remove_file(&p));
        }
        op => panic!("fs op {op}"),
    }
}

/// The recorder's `tree(dir)`: every entry under the placeholder path `dir`.
fn tree(pl: &Places, dir: &str) -> Vec<Value> {
    fn walk(pl: &Places, d: &Path, rel: &str, out: &mut Vec<Value>) {
        let Ok(rd) = std::fs::read_dir(d) else { return };
        let mut names: Vec<String> = rd
            .flatten()
            .map(|e| e.file_name().into_string().unwrap())
            .collect();
        names.sort_by(|a, b| a.encode_utf16().cmp(b.encode_utf16()));
        for n in names {
            let p = d.join(&n);
            let r = format!("{rel}/{n}");
            let md = std::fs::symlink_metadata(&p).unwrap();
            if md.file_type().is_symlink() {
                let target = std::fs::read_link(&p).unwrap().display().to_string();
                out.push(json!(["l", r, pl.place(&target)]));
            } else if md.is_dir() {
                out.push(json!(["d", r]));
                walk(pl, &p, &r, out);
            } else {
                out.push(json!(["f", r, hex(&std::fs::read(&p).unwrap())]));
            }
        }
    }
    let mut out = Vec::new();
    walk(pl, Path::new(&pl.unplace(dir)), dir, &mut out);
    out
}

/// `"updatedAt"` values stamped at `now` (between `from` and the end) as
/// the recorder writes its pinned clock: `"$NOW"`.
fn nowed(s: &str, from: u64) -> String {
    static RE: OnceLock<Regex> = OnceLock::new();
    let re = RE.get_or_init(|| Regex::new(r#""updatedAt":(\d{13})"#).unwrap());
    let to = now_ms();
    re.replace_all(s, |c: &regex::Captures| {
        let n: u64 = c[1].parse().unwrap();
        if (from..=to).contains(&n) {
            r#""updatedAt":"$NOW""#.to_owned()
        } else {
            c[0].to_owned()
        }
    })
    .into_owned()
}

fn run_sql(cwd: &str, sql: &str) {
    let p = paths::db_path(cwd);
    std::fs::create_dir_all(p.parent().unwrap()).unwrap();
    let c = rusqlite::Connection::open(&p).unwrap();
    c.execute_batch(sql).unwrap();
}

/// `quote()` of each column, by rowid; a `$NOW`-window stamp as `"$NOW"`.
fn db_rows(cwd: &str, from: u64) -> Vec<Value> {
    let c = rusqlite::Connection::open_with_flags(
        paths::db_path(cwd),
        rusqlite::OpenFlags::SQLITE_OPEN_READ_ONLY,
    )
    .unwrap();
    let mut st = c
        .prepare("SELECT quote(name), quote(definition_json), quote(updated_at) FROM db_agents ORDER BY rowid")
        .unwrap();
    let to = now_ms();
    let text = |r: &rusqlite::Row, i: usize| match r.get_ref(i).unwrap() {
        rusqlite::types::ValueRef::Text(t) => String::from_utf8_lossy(t).into_owned(),
        v => panic!("quote() gave {v:?}"),
    };
    st.query_map([], |r| {
        let u = text(r, 2);
        let u = if u.parse::<u64>().is_ok_and(|n| (from..=to).contains(&n)) {
            "$NOW".to_owned()
        } else {
            u
        };
        Ok(json!([text(r, 0), text(r, 1), u]))
    })
    .unwrap()
    .map(Result::unwrap)
    .collect()
}

fn scope(v: &Value) -> AgentScope {
    AgentScope::parse(v.as_str().unwrap()).unwrap()
}

// ─── files ───────────────────────────────────────────────────────────────

fn file_step(pl: &Places, step: &Value) -> Value {
    let cwd = step["cwd"]
        .as_str()
        .map(|c| pl.unplace(c))
        .unwrap_or_default();
    let name = || step["name"].as_str().unwrap();
    let files = |r: Result<Vec<agents::AgentFile>, agents::Thrown>| match r {
        Err(_) => json!({ "threw": true }),
        Ok(list) => match list
            .iter()
            .map(agents::AgentFile::to_json)
            .collect::<Option<Vec<_>>>()
        {
            Some(v) => json!(pl.place(&js::stringify(&Value::Array(v)))),
            None => json!("circular"),
        },
    };
    match step["op"].as_str().unwrap() {
        "fs" => {
            for a in step["actions"].as_array().unwrap() {
                fs_action(pl, a);
            }
            Value::Null
        }
        "dir" => json!(pl.place(&agents::agents_dir(scope(&step["scope"]), &cwd))),
        "path" => match agents::agent_path(scope(&step["scope"]), &cwd, name()) {
            Ok(p) => json!(pl.place(&p)),
            Err(e) => json!({ "threw": pl.place(&e.0) }),
        },
        "write" => {
            let n = db_agents::json_parse(name()).unwrap();
            match agents::write_agent(
                scope(&step["scope"]),
                &cwd,
                &n,
                step["raw"].as_str().unwrap(),
            ) {
                Ok(()) => json!("ok"),
                Err(m) => json!({ "threw": pl.place(&m) }),
            }
        }
        "read" => match agents::read_agent(scope(&step["scope"]), &cwd, name()) {
            Err(_) => json!({ "threw": true }),
            Ok(None) => Value::Null,
            Ok(Some(f)) => f
                .to_json()
                .map_or(json!("circular"), |v| json!(pl.place(&js::stringify(&v)))),
        },
        "list" => files(agents::list_agents(scope(&step["scope"]), &cwd)),
        "delete" => match agents::delete_agent(scope(&step["scope"]), &cwd, name()) {
            Ok(b) => json!(b),
            Err(_) => json!({ "threw": true }),
        },
        op => panic!("op {op}"),
    }
}

fn files_section() {
    let fx = &fixture()["files"];
    let root = tempfile::tempdir().unwrap();
    let cwd = root.path().canonicalize().unwrap().join("fproj");
    std::fs::create_dir(&cwd).unwrap();
    let pl = Places(vec![
        ("$CWD", cwd.display().to_string()),
        ("$HOME", paths::home_dir().display().to_string()),
    ]);
    for (i, step) in fx["steps"].as_array().unwrap().iter().enumerate() {
        let got = file_step(&pl, step);
        assert_eq!(got, step["result"], "files step {i}: {step}");
    }
    let mut got = tree(&pl, "$CWD");
    got.extend(tree(&pl, "$HOME/.claude"));
    assert_eq!(Value::Array(got), fx["tree"], "files tree");
    let _ = std::fs::remove_dir_all(paths::home_dir().join(".claude"));
}

// ─── db ──────────────────────────────────────────────────────────────────

fn db_step(pl: &Places, step: &Value, from: u64) -> Value {
    let cwd = pl.unplace(step["cwd"].as_str().unwrap());
    let parse = |k: &str| db_agents::json_parse(step[k].as_str().unwrap()).unwrap();
    match step["op"].as_str().unwrap() {
        "sql" => {
            run_sql(&cwd, step["sql"].as_str().unwrap());
            Value::Null
        }
        "list" => json!(nowed(
            &pl.place(&js::stringify(&Value::Array(db_agents::list_db_agents(
                &cwd
            )))),
            from
        )),
        "load" => db_agents::load_db_agents_for_options(&cwd)
            .map_or(Value::Null, |m| json!(js::stringify(&m))),
        "upsert" => {
            let def = step["definition"].as_str().map(|_| parse("definition"));
            match db_agents::upsert_db_agent(&cwd, &parse("name"), def.as_ref()) {
                Ok(row) => json!(nowed(&js::stringify(&row), from)),
                Err(m) => json!({ "threw": pl.place(&m) }),
            }
        }
        "delete" => match db_agents::delete_db_agent(&cwd, step["name"].as_str().unwrap()) {
            Ok(b) => json!(b),
            Err(m) => json!({ "threw": pl.place(&m) }),
        },
        op => panic!("op {op}"),
    }
}

fn db_section() {
    let fx = &fixture()["db"];
    for c in fx["names"].as_array().unwrap() {
        let v = db_agents::json_parse(c["name"].as_str().unwrap()).unwrap();
        assert_eq!(json!(db_agents::is_valid_agent_name(&v)), c["valid"], "{c}");
        assert_eq!(
            db_agents::assert_valid_agent_name(&v)
                .err()
                .map_or(Value::Null, |m| json!(m)),
            c["asserted"],
            "{c}"
        );
    }
    for c in fx["coerce"].as_array().unwrap() {
        let v = db_agents::json_parse(c["input"].as_str().unwrap()).unwrap();
        let got = db_agents::coerce_agent_definition(Some(&v))
            .map_or(Value::Null, |d| json!(js::stringify(&d)));
        assert_eq!(got, c["output"], "coerce {}", c["input"]);
    }
    let root = tempfile::tempdir().unwrap();
    let cwd = root.path().canonicalize().unwrap().join("fproj");
    let pl = Places(vec![
        ("$CWD", cwd.display().to_string()),
        ("$HOME", paths::home_dir().display().to_string()),
    ]);
    let from = now_ms();
    for (i, step) in fx["steps"].as_array().unwrap().iter().enumerate() {
        assert_eq!(
            db_step(&pl, step, from),
            step["result"],
            "db step {i}: {step}"
        );
    }
    assert_eq!(
        Value::Array(db_rows(&pl.unplace("$CWD/db"), from)),
        fx["rows"],
        "db rows"
    );
    assert_eq!(
        Value::Array(db_rows(&pl.unplace("$CWD/foreign"), from)),
        fx["foreignRows"],
        "foreign rows"
    );
}

#[test]
fn file_and_db_agents_behave_like_ts() {
    env();
    let _home = home_lock();
    files_section();
    db_section();
}

// ─── session start ───────────────────────────────────────────────────────

async fn initialize_line(log: &Path) -> String {
    for _ in 0..1000 {
        let text = std::fs::read_to_string(log).unwrap_or_default();
        if let Some(l) = text.lines().find(|l| {
            serde_json::from_str::<Value>(l).is_ok_and(|m| m["request"]["subtype"] == "initialize")
        }) {
            return l.to_owned();
        }
        tokio::time::sleep(Duration::from_millis(10)).await;
    }
    panic!("no initialize in {}", log.display());
}

#[test]
fn db_agents_reach_the_initialize_request() {
    let fake = env().fake.clone();
    // Sessions write under `$HOME` too.
    let _home = home_lock();
    tokio::runtime::Builder::new_multi_thread()
        .worker_threads(4)
        .enable_all()
        .build()
        .unwrap()
        .block_on(start_cases(fake));
}

async fn start_cases(fake: PathBuf) {
    let cases = fixture()["start"].as_array().unwrap();
    assert!(cases.len() >= 4);
    for c in cases {
        let name = c["name"].as_str().unwrap();
        let dir = tempfile::tempdir().unwrap();
        let cwd = dir.path().canonicalize().unwrap().display().to_string();
        if c["db"] == true {
            db::open_db(&cwd, db::Mode::ReadWrite).unwrap();
        }
        for u in c["upserts"].as_array().unwrap() {
            let n = db_agents::json_parse(u[0].as_str().unwrap()).unwrap();
            let d = db_agents::json_parse(u[1].as_str().unwrap()).unwrap();
            db_agents::upsert_db_agent(&cwd, &n, Some(&d)).unwrap();
        }
        if let Some(sql) = c["sql"].as_str() {
            run_sql(&cwd, sql);
        }
        let log = dir.path().join("stdin.log");
        let mut vars: HashMap<String, String> = HashMap::new();
        vars.insert("PATH".into(), std::env::var("PATH").unwrap_or_default());
        vars.insert("FAKE_CLAUDE_LOG".into(), log.display().to_string());
        let mgr = Arc::new(SessionManager::default());
        let s = mgr
            .create(SessionOptions {
                cwd: Some(cwd.clone()),
                runtime: RuntimeOptions {
                    claude_bin: Some(fake.clone()),
                    env_override: Some(vars),
                },
                ..Default::default()
            })
            .await
            .expect("create");
        let line = initialize_line(&log).await;
        let req: Value = serde_json::from_str(&line).unwrap();
        let got = req["request"].get("agents").map(js::stringify);
        assert_eq!(got.as_deref(), c["agents"].as_str(), "{name}");
        if let Some(a) = c["agents"].as_str() {
            assert!(
                line.contains(&format!("\"agents\":{a}")),
                "{name}: written as {line}"
            );
        }
        mgr.remove(&s.id).await;
    }
}
