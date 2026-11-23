//! `auto_memory.rs` and `rules.rs` (G08), replayed against what
//! `rust/scripts/memory-golden.mjs` recorded from the real
//! `lib/server/auto-memory.ts`, `lib/server/rules.ts` and session.ts
//! (`tests/fixtures/memory_golden.json`):
//! - `pure`: every pure export on the recorded inputs;
//! - `notify`: `notifyMemoryUpdate` on sessions with seeded Read paths, the
//!   reminders TS's `takePendingReminders` returned. Replayed through the
//!   queue, and on a live `Session` with the fake CLI, where the paths are
//!   seeded by a turn that Reads them and the reminders lead the next turn;
//! - `modules`: each scenario's calls in order on a fresh world (temp
//!   root, `$ROOT/home` as the home dir, the recorded clock as `now`),
//!   checking each result or thrown error (name, code, message) and every
//!   watched path the call changed (kind, mode, text or bytes, symlink
//!   target), then the whole tree at the end. A scenario tagged with an OS
//!   runs only there; one that needs enforced permissions only where a
//!   `chmod 0` directory is unreadable.
#![cfg(unix)]

#[path = "../../claudius-agent/tests/support/test_bins.rs"]
mod test_bins;

use std::collections::{BTreeMap, HashMap};
use std::os::unix::fs::PermissionsExt;
use std::path::PathBuf;
use std::sync::{Arc, OnceLock};
use std::time::Duration;

use claudius_agent::js;
use claudius_core::auto_memory::{
    self as am, MemoryOp, MemoryUpdate, Outcome, PatchMemoryInput, Thrown, WriteMemoryInput,
};
use claudius_core::paths;
use claudius_core::reminders::ReminderQueue;
use claudius_core::rules::{self, RuleScope};
use claudius_core::session::{RuntimeOptions, SendOptions, Session, SessionOptions, Subscription};
use claudius_core::session_manager::SessionManager;
use serde_json::{Map, Value, json};

fn fixture() -> &'static Value {
    static F: OnceLock<Value> = OnceLock::new();
    F.get_or_init(|| serde_json::from_str(include_str!("fixtures/memory_golden.json")).unwrap())
}

/// `$ROOT` / `$EROOT` (its `encodeProjectDir`) for one root.
struct Ph {
    root: String,
    eroot: String,
}

impl Ph {
    fn new(root: &str) -> Ph {
        Ph {
            root: root.to_owned(),
            eroot: am::encode_project_dir(root),
        }
    }

    fn abs(&self, s: &str) -> String {
        s.replace("$EROOT", &self.eroot)
            .replace("$ROOT", &self.root)
    }

    fn rel(&self, s: &str) -> String {
        s.replace(&self.eroot, "$EROOT")
            .replace(&self.root, "$ROOT")
    }

    fn deep(v: &Value, f: &dyn Fn(&str) -> String) -> Value {
        match v {
            Value::String(s) => Value::String(f(s)),
            Value::Array(a) => Value::Array(a.iter().map(|x| Ph::deep(x, f)).collect()),
            Value::Object(m) => Value::Object(
                m.iter()
                    .map(|(k, x)| (f(k), Ph::deep(x, f)))
                    .collect::<Map<String, Value>>(),
            ),
            v => v.clone(),
        }
    }

    fn deep_abs(&self, v: &Value) -> Value {
        Ph::deep(v, &|s| self.abs(s))
    }

    fn deep_rel(&self, v: &Value) -> Value {
        Ph::deep(v, &|s| self.rel(s))
    }

    fn home(&self) -> String {
        format!("{}/home", self.root)
    }
}

fn str_of(v: &Value) -> &str {
    v.as_str().unwrap_or_else(|| panic!("not a string: {v}"))
}

fn updates_of(v: &Value) -> Vec<MemoryUpdate> {
    v.as_array()
        .unwrap()
        .iter()
        .map(|u| MemoryUpdate {
            op: MemoryOp::parse(str_of(&u["op"])).unwrap(),
            path: str_of(&u["path"]).to_owned(),
        })
        .collect()
}

fn strings(v: &Value) -> Vec<String> {
    v.as_array()
        .unwrap()
        .iter()
        .map(|s| str_of(s).to_owned())
        .collect()
}

fn threw_json(t: &Thrown) -> Value {
    json!({"name": t.name(), "code": t.code(), "message": t.message()})
}

// ───────────────────────────────── pure ─────────────────────────────────

/// A JSON value's text, numbers as JS prints them (an integral f64 and an
/// integer compare equal).
fn text(v: &Value) -> String {
    js::stringify(v)
}

#[test]
fn pure_exports_match_the_ts() {
    let ph = Ph::new("/golden/root");
    let home = ph.home();
    let pure = &fixture()["pure"];
    let mut n = 0;
    for (section, cases) in pure.as_object().unwrap() {
        for case in cases.as_array().unwrap() {
            n += 1;
            let args = ph.deep_abs(&case[0]);
            let a = |i: usize| str_of(&args[i]);
            let got: Value = match section.as_str() {
                "encodeProjectDir" => json!(am::encode_project_dir(a(0))),
                "autoMemoryDir" => json!(am::auto_memory_dir(&home, a(0))),
                "isValidMemoryFilename" => json!(am::is_valid_memory_filename(a(0))),
                "isValidRuleFilename" => json!(rules::is_valid_rule_filename(a(0))),
                "yamlScalar" => json!(am::yaml_scalar(a(0))),
                "parseMemoryFrontmatter" => {
                    am::parse_memory_frontmatter(a(0)).map_or(Value::Null, |p| p.to_json())
                }
                "measureMemoryIndexLoadedBytes" => {
                    json!(am::measure_memory_index_loaded_bytes(a(0)))
                }
                "memoryUpdateReminderBody" => {
                    let in_context = strings(&args[1]);
                    let in_context: Vec<&str> = in_context.iter().map(String::as_str).collect();
                    json!(am::memory_update_reminder_body(
                        &updates_of(&args[0]),
                        &in_context
                    ))
                }
                "rulesDir" => {
                    let scope = RuleScope::parse(a(0)).unwrap();
                    match rules::rules_dir(&home, scope, args[1].as_str()) {
                        Ok(d) => json!(d),
                        Err(t) => json!({"threw": threw_json(&t)}),
                    }
                }
                other => panic!("unknown section {other}"),
            };
            let got = ph.deep_rel(&got);
            assert_eq!(text(&got), text(&case[1]), "{section} {}", case[0]);
        }
    }
    assert_eq!(n, 244, "pure cases");
}

// ──────────────────────────────── notify ────────────────────────────────

#[test]
fn notify_queues_the_ts_reminders() {
    let cases = fixture()["notify"].as_array().unwrap();
    assert_eq!(cases.len(), 14);
    for (i, case) in cases.iter().enumerate() {
        let reads = strings(&case["reads"]);
        let mut queue = ReminderQueue::default();
        for call in case["calls"].as_array().unwrap() {
            if let Some(body) = am::memory_update_reminder(&updates_of(call), &reads) {
                queue.push(&body);
            }
        }
        assert_eq!(
            queue.take().as_deref(),
            case["reminder"].as_str(),
            "notify case {i}"
        );
    }
}

/// One isolated `$HOME` + config dir per test binary, and the fake CLI built.
fn fake() -> &'static PathBuf {
    static E: OnceLock<(tempfile::TempDir, PathBuf)> = OnceLock::new();
    &E.get_or_init(|| {
        let root = tempfile::tempdir().unwrap();
        let home = root.path().join("home");
        let config = root.path().join("config");
        std::fs::create_dir_all(&home).unwrap();
        std::fs::create_dir_all(&config).unwrap();
        assert!(paths::set_home_override(home));
        assert!(paths::set_config_dir_override(config));
        let bin = test_bins::fake_claude();
        (root, bin)
    })
    .1
}

async fn next(sub: &mut Subscription) -> Value {
    tokio::time::timeout(Duration::from_secs(20), sub.recv())
        .await
        .expect("event timeout")
        .expect("stream closed")
}

async fn turn(s: &Session, sub: &mut Subscription, text: &str) {
    s.send_input(text, &[], SendOptions::default());
    while !matches!(next(sub).await, e if e["type"] == "turn_status" && e["status"] == "running") {}
    while !matches!(next(sub).await, e if e["type"] == "turn_status" && e["status"] == "idle") {}
}

/// The content of the last user message the CLI got.
fn last_user_content(log: &std::path::Path) -> String {
    std::fs::read_to_string(log)
        .unwrap_or_default()
        .lines()
        .filter_map(|l| serde_json::from_str::<Value>(l).ok())
        .rfind(|m| m["type"] == "user")
        .and_then(|m| m["message"]["content"].as_str().map(str::to_owned))
        .expect("a user message")
}

/// A case on a live session: a turn whose assistant Reads the case's paths
/// (an empty one can't be seeded that way, and never shows in a reminder),
/// the calls, then the probe turn, which must carry what TS queued.
async fn notify_live(i: usize, case: &Value) {
    let cwd = tempfile::tempdir().unwrap();
    let log = cwd.path().join("stdin.log");
    let mut env: HashMap<String, String> = HashMap::new();
    env.insert("PATH".into(), std::env::var("PATH").unwrap_or_default());
    env.insert("FAKE_CLAUDE_LOG".into(), log.display().to_string());
    let opts = SessionOptions {
        cwd: Some(cwd.path().canonicalize().unwrap().display().to_string()),
        runtime: RuntimeOptions {
            claude_bin: Some(fake().clone()),
            env_override: Some(env),
        },
        ..Default::default()
    };
    let mgr = Arc::new(SessionManager::default());
    let s = mgr.create(opts).await.expect("create");
    let mut sub = s.subscribe(None, None);
    let reads: Vec<Value> = strings(&case["reads"])
        .into_iter()
        .filter(|p| !p.is_empty())
        .enumerate()
        .map(|(n, p)| {
            json!({"type": "tool_use", "id": format!("toolu_read_{n}"), "name": "Read",
                   "input": {"file_path": p}})
        })
        .collect();
    let seed = json!([{"type": "assistant", "message": {"role": "assistant", "content": reads}}]);
    turn(&s, &mut sub, &format!("script:{seed}")).await;
    for call in case["calls"].as_array().unwrap() {
        s.notify_memory_update(&updates_of(call));
    }
    turn(&s, &mut sub, "probe").await;
    let reminder = case["reminder"].as_str().unwrap_or("");
    assert_eq!(
        last_user_content(&log),
        format!("{reminder}probe"),
        "notify case {i}: the next turn"
    );
    turn(&s, &mut sub, "again").await;
    assert_eq!(last_user_content(&log), "again", "notify case {i}: drained");
    s.end().await;
}

#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
async fn notify_reaches_the_next_turn_of_a_live_session() {
    let cases: Vec<(usize, &Value)> = fixture()["notify"]
        .as_array()
        .unwrap()
        .iter()
        .enumerate()
        .collect();
    for chunk in cases.chunks(7) {
        futures::future::join_all(chunk.iter().map(|(i, c)| notify_live(*i, c))).await;
    }
}

// ──────────────────────────────── modules ────────────────────────────────

/// A fresh world under a temp root.
struct World {
    _dir: tempfile::TempDir,
    ph: Ph,
}

impl World {
    fn new(layout: &Value) -> World {
        let dir = tempfile::tempdir().unwrap();
        let root = dir.path().canonicalize().unwrap().display().to_string();
        assert!(
            root.bytes()
                .all(|b| b.is_ascii_alphanumeric() || b"_./-".contains(&b)),
            "placeholders are swapped textually: {root}"
        );
        let w = World {
            _dir: dir,
            ph: Ph::new(&root),
        };
        for d in layout["dirs"].as_array().unwrap() {
            std::fs::create_dir_all(w.path(str_of(d))).unwrap();
        }
        for f in layout["files"].as_array().unwrap() {
            let p = w.path(str_of(&f[0]));
            std::fs::create_dir_all(p.parent().unwrap()).unwrap();
            std::fs::write(p, w.ph.abs(str_of(&f[1]))).unwrap();
        }
        w
    }

    fn path(&self, rel: &str) -> PathBuf {
        PathBuf::from(format!("{}/{}", self.ph.root, self.ph.abs(rel)))
    }
}

/// chmod every directory under `p` back to 0755, so it can be removed.
fn open_up(p: &std::path::Path) {
    let Ok(meta) = std::fs::symlink_metadata(p) else {
        return;
    };
    if !meta.is_dir() {
        return;
    }
    if std::fs::set_permissions(p, std::fs::Permissions::from_mode(0o755)).is_err() {
        return;
    }
    for e in std::fs::read_dir(p).unwrap() {
        open_up(&e.unwrap().path());
    }
}

/// The recorder's setup ops.
fn apply(w: &World, op: &Value) {
    let p = w.path(str_of(&op["path"]));
    match str_of(&op["op"]) {
        "write" => {
            std::fs::create_dir_all(p.parent().unwrap()).unwrap();
            let bytes: Vec<u8> = match op.get("bytes") {
                Some(b) => b
                    .as_array()
                    .unwrap()
                    .iter()
                    .map(|n| n.as_u64().unwrap() as u8)
                    .collect(),
                None => w.ph.abs(str_of(&op["text"])).into_bytes(),
            };
            std::fs::write(p, bytes).unwrap();
        }
        "mkdir" => std::fs::create_dir_all(p).unwrap(),
        "rm" => {
            open_up(&p);
            match std::fs::symlink_metadata(&p) {
                Ok(m) if m.is_dir() => std::fs::remove_dir_all(&p).unwrap(),
                Ok(_) => std::fs::remove_file(&p).unwrap(),
                Err(_) => {}
            }
        }
        "symlink" => {
            std::fs::create_dir_all(p.parent().unwrap()).unwrap();
            std::os::unix::fs::symlink(w.ph.abs(str_of(&op["target"])), p).unwrap();
        }
        "chmod" => std::fs::set_permissions(
            p,
            std::fs::Permissions::from_mode(op["mode"].as_u64().unwrap() as u32),
        )
        .unwrap(),
        "mtime" => set_mtime_ns(&p, str_of(&op["ns"]).parse().unwrap()),
        other => panic!("unknown op {other}"),
    }
}

/// `utimesSync(p, t, t)` to the nanosecond the recorder read back.
pub fn set_mtime_ns(p: &std::path::Path, ns: i128) {
    use std::os::unix::ffi::OsStrExt;
    let c = std::ffi::CString::new(p.as_os_str().as_bytes()).unwrap();
    let ts = libc::timespec {
        tv_sec: ns.div_euclid(1_000_000_000) as libc::time_t,
        tv_nsec: ns.rem_euclid(1_000_000_000) as _,
    };
    let times = [ts, ts];
    let rc = unsafe { libc::utimensat(libc::AT_FDCWD, c.as_ptr(), times.as_ptr(), 0) };
    assert_eq!(rc, 0, "utimensat {}", p.display());
}

/// JS's default `sort()`: by UTF-16 code units.
fn js_sort(v: &mut [String]) {
    v.sort_by(|a, b| a.encode_utf16().cmp(b.encode_utf16()));
}

/// The watched roots besides each project's memory dir.
fn watch() -> Vec<String> {
    let uni = "caf\u{e9} x\u{1f600}";
    [
        "home/.claude/rules",
        "project",
        "ws",
        "ws-extra",
        "untrusted",
        "outside",
        "nowhere",
        uni,
        "long",
    ]
    .iter()
    .map(|s| s.to_string())
    .collect()
}

/// The recorder's `snapshot()`: every watched path, keyed with placeholders.
fn snapshot(w: &World) -> BTreeMap<String, Value> {
    let mut snap = BTreeMap::new();
    let mut projects: Vec<String> = std::fs::read_dir(w.path("home/.claude/projects"))
        .map(|rd| {
            rd.map(|e| e.unwrap().file_name().into_string().unwrap())
                .collect()
        })
        .unwrap_or_default();
    js_sort(&mut projects);
    for p in projects {
        let rel = if p == "memory" {
            "home/.claude/projects/memory".to_owned()
        } else {
            format!("home/.claude/projects/{}/memory", w.ph.rel(&p))
        };
        visit(w, &rel, &mut snap);
    }
    for rel in watch() {
        visit(w, &rel, &mut snap);
    }
    snap
}

fn visit(w: &World, rel: &str, snap: &mut BTreeMap<String, Value>) {
    if snap.contains_key(rel) {
        return;
    }
    let abs = w.path(rel);
    let Ok(meta) = std::fs::symlink_metadata(&abs) else {
        return;
    };
    let mode = meta.permissions().mode() & 0o777;
    if meta.file_type().is_symlink() {
        let target = std::fs::read_link(&abs).unwrap().display().to_string();
        snap.insert(
            rel.into(),
            json!({"kind": "symlink", "target": w.ph.rel(&target)}),
        );
    } else if meta.is_dir() {
        let mut entry = json!({"kind": "dir", "mode": mode});
        let names = match std::fs::read_dir(&abs) {
            Ok(rd) => {
                let mut names: Vec<String> = rd
                    .map(|e| e.unwrap().file_name().into_string().unwrap())
                    .collect();
                js_sort(&mut names);
                names
            }
            Err(_) => {
                entry["unreadable"] = json!(true);
                Vec::new()
            }
        };
        snap.insert(rel.into(), entry);
        for n in names {
            visit(w, &format!("{rel}/{}", w.ph.rel(&n)), snap);
        }
    } else {
        let entry = match std::fs::read(&abs) {
            Err(_) => json!({"kind": "file", "mode": mode, "unreadable": true}),
            Ok(bytes) => match String::from_utf8(bytes) {
                Ok(text) => json!({"kind": "file", "mode": mode, "text": w.ph.rel(&text)}),
                Err(e) => json!({"kind": "file", "mode": mode, "bytes": e.into_bytes()}),
            },
        };
        snap.insert(rel.into(), entry);
    }
}

/// The recorder's `changes`: each path whose entry differs, with its new
/// entry (`null` once gone), in JS sort order.
fn changes(before: &BTreeMap<String, Value>, after: &BTreeMap<String, Value>) -> Value {
    let mut keys: Vec<String> = before.keys().chain(after.keys()).cloned().collect();
    js_sort(&mut keys);
    keys.dedup();
    Value::Array(
        keys.into_iter()
            .filter(|k| before.get(k) != after.get(k))
            .map(|k| {
                let v = after.get(&k).cloned().unwrap_or(Value::Null);
                json!([k, v])
            })
            .collect(),
    )
}

fn snapshot_json(snap: BTreeMap<String, Value>) -> Value {
    Value::Object(snap.into_iter().collect())
}

/// An `{ ok, … }` result as `JSON.stringify` sees it.
fn outcome_json<T>(o: Outcome<T>, ok: impl FnOnce(T) -> Value) -> Result<Value, Thrown> {
    match o? {
        Ok(v) => {
            let mut m = Map::new();
            m.insert("ok".into(), json!(true));
            if let Value::Object(fields) = ok(v) {
                m.extend(fields);
            }
            Ok(Value::Object(m))
        }
        Err(r) => Ok(json!({"ok": false, "status": r.status, "error": r.error})),
    }
}

fn list_json(files: Vec<am::MemoryFile>) -> Value {
    Value::Array(files.iter().map(am::MemoryFile::to_json).collect())
}

/// One recorded call, its arguments made absolute.
fn call(home: &str, args: &[Value], now: i64) -> Result<Value, Thrown> {
    let s = |i: usize| str_of(&args[i]);
    let cwd_at = |i: usize| args.get(i).and_then(Value::as_str);
    let scope = || RuleScope::parse(s(1)).unwrap();
    match s(0) {
        "listAutoMemory" => Ok(list_json(am::list_auto_memory(home, s(1))?)),
        "readMemoryFile" => Ok(json!(am::read_memory_file(home, s(1), s(2))?)),
        "writeMemoryFile" => {
            let i = &args[2];
            let input = WriteMemoryInput {
                filename: str_of(&i["filename"]).into(),
                type_: str_of(&i["type"]).into(),
                name: str_of(&i["name"]).into(),
                description: str_of(&i["description"]).into(),
                body: str_of(&i["body"]).into(),
            };
            outcome_json(
                am::write_memory_file(home, s(1), &input, now),
                |w| json!({"name": w.name, "path": w.path}),
            )
        }
        "patchMemoryFile" => {
            let i = &args[2];
            let input = PatchMemoryInput {
                filename: str_of(&i["filename"]).into(),
                description: i.get("description").cloned(),
                type_: i.get("type").cloned(),
                body: i.get("body").cloned(),
            };
            outcome_json(
                am::patch_memory_file(home, s(1), &input, now),
                |p| json!({"path": p.path, "parsed": p.parsed}),
            )
        }
        "deleteMemoryFile" => {
            outcome_json(am::delete_memory_file(home, s(1), s(2)), |()| json!({}))
        }
        "appendMemoryIndex" => outcome_json(
            am::append_memory_index(home, s(1), s(2), s(3), s(4)),
            |()| json!({}),
        ),
        "listRules" => Ok(list_json(rules::list_rules(home, scope(), cwd_at(2))?)),
        "readRule" => Ok(json!(rules::read_rule(home, scope(), s(2), cwd_at(3))?)),
        "writeRule" => {
            let overwrite = args.get(5).and_then(Value::as_bool).unwrap_or(false);
            outcome_json(
                rules::write_rule(home, scope(), s(2), s(3), cwd_at(4), overwrite),
                |w| json!({"name": w.name, "path": w.path}),
            )
        }
        "deleteRule" => outcome_json(rules::delete_rule(home, scope(), s(2), cwd_at(3)), |()| {
            json!({})
        }),
        other => panic!("unknown call {other}"),
    }
}

/// Whether this disk enforces permissions (not root).
fn perm_enforced() -> bool {
    let d = tempfile::tempdir().unwrap();
    let p = d.path().join("probe");
    std::fs::create_dir(&p).unwrap();
    std::fs::set_permissions(&p, std::fs::Permissions::from_mode(0o0)).unwrap();
    let enforced = std::fs::read_dir(&p).is_err();
    std::fs::set_permissions(&p, std::fs::Permissions::from_mode(0o755)).unwrap();
    enforced
}

fn host_platform() -> &'static str {
    if cfg!(target_os = "macos") {
        "darwin"
    } else {
        std::env::consts::OS
    }
}

#[test]
fn module_scenarios_match_the_ts() {
    // The recorder ran under umask 022.
    unsafe { libc::umask(0o022) };
    let fx = fixture();
    let perm = perm_enforced();
    let (mut ran, mut calls) = (0, 0);
    for sc in fx["modules"].as_array().unwrap() {
        let name = str_of(&sc["name"]);
        if sc["skipped"] == true {
            continue;
        }
        if let Some(os) = sc["os"].as_str()
            && os != host_platform()
        {
            continue;
        }
        if strings(&sc["needs"]).iter().any(|n| n == "perm") && !perm {
            continue;
        }
        ran += 1;
        let w = World::new(&fx["world"]);
        let home = w.ph.home();
        for (i, step) in sc["steps"].as_array().unwrap().iter().enumerate() {
            if let Some(ops) = step.get("setup") {
                for op in ops.as_array().unwrap() {
                    apply(&w, op);
                }
                continue;
            }
            calls += 1;
            let args = w.ph.deep_abs(&step["call"]);
            let before = snapshot(&w);
            let got = call(
                &home,
                args.as_array().unwrap(),
                step["now"].as_i64().unwrap(),
            );
            let got = match got {
                Ok(v) => json!({"result": w.ph.deep_rel(&v)}),
                Err(t) => json!({"threw": w.ph.deep_rel(&threw_json(&t))}),
            };
            let want = match step.get("threw") {
                Some(t) => json!({ "threw": t }),
                None => json!({"result": step["result"]}),
            };
            assert_eq!(text(&got), text(&want), "{name} step {i}: {}", step["call"]);
            assert_eq!(
                changes(&before, &snapshot(&w)),
                step["changes"],
                "{name} step {i}: {} changed",
                step["call"]
            );
        }
        assert_eq!(
            snapshot_json(snapshot(&w)),
            sc["final"],
            "{name}: the tree at the end"
        );
        open_up(std::path::Path::new(&w.ph.root));
    }
    let skipped_os = if host_platform() == "darwin" { 0 } else { 2 };
    let skipped_perm = if perm { 0 } else { 2 };
    assert_eq!(ran, 14 - skipped_os - skipped_perm, "scenarios run");
    assert!(calls >= 200, "{calls} calls");
}
