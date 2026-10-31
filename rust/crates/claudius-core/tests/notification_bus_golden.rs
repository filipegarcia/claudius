//! Replays `fixtures/notification_bus_golden.json`, recorded from the real
//! `lib/server/notification-bus.ts` and the inbox half of
//! `lib/server/notifications-db.ts` by `rust/scripts/notification-bus-golden.mjs`.
//!
//! The scenarios run in order on one bus with the recorder's stubs: a
//! counting clock (`clock += tick` per read), a counter for the row ids and
//! manual timers, run by the `flush` steps. Each step checks what it
//! answered (`got`), what every subscriber received (`envs`), the rows it
//! left in each watched cwd's database (`rows`, as the recorder dumps them),
//! which handles the database cache holds (`cached`), and how many times the
//! clock and the id source were read (`clockAfter`, `idsAfter`).
//!
//! `pure` replays `isKindEnabled` and `mapEventToKind` called directly.

use std::collections::{BTreeMap, HashMap};
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::{Arc, LazyLock, Mutex};
use std::time::{Duration, UNIX_EPOCH};

use claudius_agent::js;
use claudius_core::db::{Mode, cached_db, open_db};
use claudius_core::notification_bus::{
    BusOptions, NotificationBus, NotificationSubscription, RecordContext, SessionEventOpts,
    StreamEvent, Timers, is_kind_enabled, map_event_to_kind,
};
use claudius_core::notifications_db::{self as ndb, ListOpts, NewNotification};
use claudius_core::{js_num, paths, workspaces};
use rusqlite::types::ValueRef;
use serde_json::{Map, Value, json};

fn fixture() -> Value {
    let path = PathBuf::from(env!("CARGO_MANIFEST_DIR"))
        .join("tests/fixtures/notification_bus_golden.json");
    // `js::json_parse`: the recording holds a lone surrogate (a cut through
    // an astral character), read as U+FFFD.
    js::json_parse(&std::fs::read_to_string(path).unwrap()).unwrap()
}

/// A private root for this binary; the home (the per-project databases and
/// workspaces.json) is `<root>/home`, as in the recorder.
static ROOT: LazyLock<tempfile::TempDir> = LazyLock::new(|| {
    let d = tempfile::tempdir().unwrap();
    let home = d.path().join("home");
    std::fs::create_dir_all(&home).unwrap();
    assert!(paths::set_home_override(home));
    d
});

/// The recorder's clock before the first step.
const BASE: f64 = 1_700_000_000_000.0;

fn root() -> &'static Path {
    ROOT.path()
}

/// Steps that can't match, with why. Matched on (scenario, step index).
const KNOWN: &[(&str, usize, &str)] = &[
    // A number bound into a TEXT column is stored as SQLite prints it, and
    // the SQLite bundled with rusqlite (3.50.2) prints some REALs with fewer
    // digits than better-sqlite3's (3.53.2): 1/3 is `0.333333333333333`
    // there, `0.33333333333333332` here; 2^53 + 2 `9.00719925474099e+15`,
    // `9007199254740994.0`.
    ("odd", 7, "rows: REAL to TEXT, 1/3"),
    ("odd", 11, "rows: REAL to TEXT, 2^53 + 2"),
    // A `firstLine` cut through a surrogate pair: TS stores the lone high
    // surrogate as the three bytes ED A0 BD (and reads them back as three
    // U+FFFD); a Rust string can't hold it, so U+FFFD is stored.
    ("odd", 81, "rows: the lone surrogate"),
    // The list reads the rows of #7, #11 and #81 back.
    ("odd", 143, "got: the rows above"),
];

// ───────────────────────── the recorder's world ─────────────────────────

const COLS: [&str; 11] = [
    "id",
    "session_id",
    "run_id",
    "job_id",
    "kind",
    "title",
    "body",
    "payload",
    "request_id",
    "created_at",
    "read_at",
];

fn rows_sql() -> String {
    let cols: Vec<String> = COLS
        .iter()
        .map(|c| {
            format!(
                "typeof({c}), CASE typeof({c}) WHEN 'integer' THEN CAST({c} AS TEXT) WHEN 'real' THEN {c} ELSE hex({c}) END"
            )
        })
        .collect();
    format!(
        "SELECT {} FROM notifications ORDER BY rowid",
        cols.join(", ")
    )
}

fn cell(v: ValueRef) -> Value {
    match v {
        ValueRef::Null => Value::Null,
        ValueRef::Integer(n) => json!(n),
        ValueRef::Real(f) => js_num(f),
        ValueRef::Text(t) => json!(String::from_utf8_lossy(t)),
        ValueRef::Blob(_) => panic!("the dump hexes blobs"),
    }
}

/// The recorder's `dump`: the rows on a read-only connection of its own;
/// null without a file, "dir" for a directory, `{threw}` when the read fails.
fn dump(cwd: &str) -> Value {
    let path = paths::db_path(cwd);
    if !path.exists() {
        return Value::Null;
    }
    if path.is_dir() {
        return json!("dir");
    }
    let read = || -> rusqlite::Result<Vec<Value>> {
        let c = rusqlite::Connection::open_with_flags(
            &path,
            rusqlite::OpenFlags::SQLITE_OPEN_READ_ONLY,
        )?;
        let mut st = c.prepare(&rows_sql())?;
        let rows = st.query_map([], |r| {
            (0..COLS.len())
                .map(|i| {
                    Ok(json!([
                        cell(r.get_ref(2 * i)?),
                        cell(r.get_ref(2 * i + 1)?)
                    ]))
                })
                .collect::<rusqlite::Result<Vec<Value>>>()
                .map(Value::Array)
        })?;
        rows.collect()
    };
    match read() {
        Ok(rows) => Value::Array(rows),
        Err(e) => json!({"threw": e.to_string()}),
    }
}

/// The recorder's `rowsDiff`.
fn rows_diff(before: Option<&Value>, after: &Value) -> Option<Value> {
    match (before, after) {
        (Some(Value::Array(b)), Value::Array(a)) => {
            let changed: Vec<Value> = a
                .iter()
                .enumerate()
                .filter(|(i, row)| b.get(*i) != Some(row))
                .map(|(i, row)| json!([i, row]))
                .collect();
            if changed.is_empty() && a.len() == b.len() {
                None
            } else {
                Some(json!({"len": a.len(), "changed": changed}))
            }
        }
        (Some(b), a) if js::stringify(b) == js::stringify(a) => None,
        _ => Some(after.clone()),
    }
}

fn run_sql(cwd: &str, sql: &str, fresh: bool) -> anyhow::Result<()> {
    if fresh {
        let path = paths::db_path(cwd);
        std::fs::create_dir_all(path.parent().unwrap())?;
        let c = rusqlite::Connection::open(path)?;
        c.pragma_update(None, "journal_mode", "WAL")?;
        c.execute_batch(sql)?;
    } else {
        open_db(cwd, Mode::ReadWrite)?.with(|c| c.execute_batch(sql))?;
    }
    Ok(())
}

fn write_ws(text: Option<&str>, mtime: u64) {
    let path = workspaces::workspaces_path();
    std::fs::create_dir_all(path.parent().unwrap()).unwrap();
    let Some(text) = text else {
        let _ = std::fs::remove_file(&path);
        return;
    };
    std::fs::write(&path, text).unwrap();
    let f = std::fs::File::options().write(true).open(&path).unwrap();
    f.set_modified(UNIX_EPOCH + Duration::from_secs(mtime))
        .unwrap();
}

fn s<'a>(v: &'a Value, k: &str) -> &'a str {
    v[k].as_str()
        .unwrap_or_else(|| panic!("{k} isn't a string: {v}"))
}

fn list_opts(v: &Value) -> ListOpts {
    ListOpts {
        limit: v["limit"].as_f64(),
        before: v["before"].as_f64(),
        unread_only: v["unreadOnly"] == true,
    }
}

fn opt_str(v: &Value) -> Option<String> {
    v.as_str().map(str::to_owned)
}

fn new_notification(v: &Value) -> NewNotification {
    NewNotification {
        id: opt_str(&v["id"]),
        session_id: opt_str(&v["sessionId"]),
        run_id: opt_str(&v["runId"]),
        job_id: opt_str(&v["jobId"]),
        kind: s(v, "kind").to_owned(),
        title: s(v, "title").to_owned(),
        body: v["body"].clone(),
        payload: v["payload"].as_object().cloned(),
        request_id: v["requestId"].clone(),
        created_at: v["createdAt"].as_f64(),
    }
}

fn rows_json(rows: anyhow::Result<Vec<ndb::NotificationRow>>) -> Value {
    match rows {
        Ok(rows) => Value::Array(rows.iter().map(|r| r.to_json()).collect()),
        Err(e) => threw(&e),
    }
}

fn threw(e: &anyhow::Error) -> Value {
    json!({"threw": e.to_string()})
}

fn result<T>(r: anyhow::Result<T>, f: impl FnOnce(T) -> Value) -> Value {
    r.map_or_else(|e| threw(&e), f)
}

/// `Object.entries` of a per-session map, as an object again: `stringify`
/// prints its keys in JS order.
fn entries_object(entries: &Value) -> Value {
    let mut m = Map::new();
    for e in entries.as_array().unwrap() {
        m.insert(e[0].as_str().unwrap().to_owned(), e[1].clone());
    }
    Value::Object(m)
}

/// The replay's stubs, shared with the bus's closures.
struct World {
    clock: Mutex<(f64, f64)>,
    ids: AtomicU64,
}

fn uuid(n: u64) -> String {
    format!("00000000-0000-4000-a000-{n:012}")
}

struct Replay {
    world: Arc<World>,
    bus: NotificationBus,
    subs: Vec<Option<NotificationSubscription>>,
}

impl Replay {
    fn new() -> Replay {
        let world = Arc::new(World {
            clock: Mutex::new((BASE, 0.0)),
            ids: AtomicU64::new(0),
        });
        let (w1, w2) = (world.clone(), world.clone());
        let bus = NotificationBus::new(BusOptions {
            clock: Arc::new(move || {
                let mut c = w1.clock.lock().unwrap();
                c.0 += c.1;
                c.0
            }),
            new_id: Arc::new(move || uuid(w2.ids.fetch_add(1, Ordering::SeqCst) + 1)),
            timers: Timers::Manual,
        });
        Replay {
            world,
            bus,
            subs: Vec::new(),
        }
    }

    fn now(&self) -> impl Fn() -> f64 + '_ {
        || {
            let mut c = self.world.clock.lock().unwrap();
            c.0 += c.1;
            c.0
        }
    }

    fn new_id(&self) -> impl Fn() -> String + '_ {
        || uuid(self.world.ids.fetch_add(1, Ordering::SeqCst) + 1)
    }

    fn step(&mut self, st: &Value) -> Value {
        let bus = &self.bus;
        let cwd = || s(st, "cwd");
        let ws = || s(st, "ws");
        let ids = || -> Vec<String> {
            st["ids"]
                .as_array()
                .unwrap()
                .iter()
                .map(|v| v.as_str().unwrap().to_owned())
                .collect()
        };
        match s(st, "op") {
            "ws" => {
                write_ws(st["text"].as_str(), st["mtime"].as_u64().unwrap());
                Value::Null
            }
            "clock" => {
                *self.world.clock.lock().unwrap() =
                    (st["clock"].as_f64().unwrap(), st["tick"].as_f64().unwrap());
                Value::Null
            }
            "sql" => result(run_sql(cwd(), s(st, "sql"), st["fresh"] == true), |()| {
                Value::Null
            }),
            "dir" => {
                std::fs::create_dir_all(paths::db_path(cwd())).unwrap();
                Value::Null
            }
            "chmod" => {
                use std::os::unix::fs::PermissionsExt;
                let mode = st["mode"].as_u64().unwrap() as u32;
                std::fs::set_permissions(
                    paths::db_path(cwd()),
                    std::fs::Permissions::from_mode(mode),
                )
                .unwrap();
                Value::Null
            }
            "flush" => json!(bus.run_timers()),
            "reset" => {
                bus.reset_for_tests();
                Value::Null
            }
            "sub" => {
                self.subs.push(Some(bus.subscribe()));
                Value::Null
            }
            "unsub" => {
                self.subs[st["index"].as_u64().unwrap() as usize] = None;
                Value::Null
            }
            "record" => {
                let o = &st["opts"];
                bus.record_session_event(
                    cwd(),
                    s(st, "sid"),
                    &st["event"],
                    SessionEventOpts {
                        has_subscribers: o["hasSubscribers"].as_bool(),
                        session_title: opt_str(&o["sessionTitle"]),
                        has_active_background_work: o["hasActiveBackgroundWork"].as_bool(),
                    },
                );
                Value::Null
            }
            "sched" => {
                bus.record_scheduler_event(cwd(), s(st, "runId"), s(st, "jobId"), &st["event"]);
                Value::Null
            }
            "input" => {
                match st["at"].as_f64() {
                    Some(at) => bus.mark_user_input_at(s(st, "sid"), at),
                    None => bus.mark_user_input(s(st, "sid")),
                }
                Value::Null
            }
            "list" => rows_json(bus.list(ws(), &list_opts(&st["opts"]))),
            "across" => rows_json(bus.list_across_workspaces(&list_opts(&st["opts"]))),
            "read" => result(bus.mark_read(ws(), &ids()), |n| json!(n)),
            "readAll" => result(bus.mark_all_read(ws()), |n| json!(n)),
            "bySession" => result(bus.mark_read_by_session(ws(), s(st, "sid")), |n| json!(n)),
            "byKind" => result(bus.mark_read_by_kind(ws(), s(st, "kind")), |n| json!(n)),
            "byRequest" => {
                bus.mark_read_by_request_id(cwd(), s(st, "rid"));
                Value::Null
            }
            "sweep" => {
                bus.sweep_orphaned_actionable_for_session(cwd(), s(st, "sid"));
                Value::Null
            }
            "state" => result(bus.get_workspace_state(ws()), |o| {
                o.map_or(Value::Null, |s| s.to_json())
            }),
            "states" => result(bus.get_all_workspace_states(), |m| {
                let sorted: BTreeMap<String, Value> =
                    m.into_iter().map(|(k, v)| (k, v.to_json())).collect();
                Value::Array(sorted.into_iter().map(|(k, v)| json!([k, v])).collect())
            }),
            "db.insert" => result(
                ndb::insert_notification(
                    cwd(),
                    ws(),
                    &new_notification(&st["input"]),
                    &self.now(),
                    &self.new_id(),
                ),
                |r| r.map_or(Value::Null, |r| r.to_json()),
            ),
            "db.list" => rows_json(ndb::list_notifications(
                cwd(),
                ws(),
                &list_opts(&st["opts"]),
            )),
            "db.count" => result(ndb::unread_count(cwd()), |n| json!(n)),
            "db.perSession" => result(ndb::unread_counts_by_session(cwd()), Value::Object),
            "db.get" => result(ndb::get_notification(cwd(), ws(), s(st, "id")), |r| {
                r.map_or(Value::Null, |r| r.to_json())
            }),
            "db.read" => result(ndb::mark_read(cwd(), &ids(), &self.now()), |n| json!(n)),
            "db.readAll" => result(ndb::mark_all_read(cwd(), &self.now()), |n| json!(n)),
            "db.byKind" => result(
                ndb::mark_read_by_kind(cwd(), s(st, "kind"), &self.now()),
                |n| json!(n),
            ),
            "db.bySession" => result(
                ndb::mark_read_by_session(cwd(), s(st, "sid"), &self.now()),
                |n| json!(n),
            ),
            "db.actionable" => result(
                ndb::mark_read_actionable_by_session(cwd(), s(st, "sid"), &self.now()),
                |n| json!(n),
            ),
            "db.byRequest" => result(
                ndb::mark_read_by_request_id(cwd(), s(st, "rid"), &self.now()),
                Value::Array,
            ),
            other => panic!("unknown op {other}"),
        }
    }

    /// What each subscriber received since the last step.
    fn envs(&mut self) -> Value {
        Value::Array(
            self.subs
                .iter_mut()
                .map(|sub| {
                    let mut got = Vec::new();
                    if let Some(sub) = sub {
                        while let Ok(ev) = sub.rx.try_recv() {
                            got.push(ev.to_json());
                        }
                    }
                    Value::Array(got)
                })
                .collect(),
        )
    }
}

/// The temp root as the recorder writes it.
fn rooted(v: &Value) -> String {
    js::stringify(v).replace(&*root().to_string_lossy(), "$ROOT")
}

#[test]
fn scenarios_replay_the_ts() {
    let _ = root();
    let _g = WS_LOCK.lock().unwrap_or_else(|e| e.into_inner());
    let fx = fixture();
    assert_eq!(fx["base"], js_num(BASE));
    let mut r = Replay::new();
    let mut failures = vec![];
    let mut total = 0;
    let mut known_hit = vec![];
    for sc in fx["scenarios"].as_array().unwrap() {
        let name = s(sc, "name");
        r.bus.reset_for_tests();
        r.world.ids.store(0, Ordering::SeqCst);
        assert!(r.bus.run_timers().is_empty());
        r.subs.clear();
        for _ in 0..sc["subs"].as_u64().unwrap() {
            r.subs.push(Some(r.bus.subscribe()));
        }
        let watch: Vec<&str> = sc["watch"]
            .as_array()
            .unwrap()
            .iter()
            .map(|v| v.as_str().unwrap())
            .collect();
        let mut last_rows: HashMap<&str, Value> = HashMap::new();
        let mut last_cached: HashMap<&str, Value> = HashMap::new();
        for (i, st) in sc["steps"].as_array().unwrap().iter().enumerate() {
            total += 1;
            let got = r.step(st);
            let envs = r.envs();
            let mut rows = Map::new();
            let mut cached = Map::new();
            for cwd in &watch {
                let now = dump(cwd);
                if let Some(d) = rows_diff(last_rows.get(cwd), &now) {
                    rows.insert((*cwd).to_owned(), d);
                }
                last_rows.insert(cwd, now);
                let c = json!([
                    cached_db(cwd, Mode::ReadWrite).is_some(),
                    cached_db(cwd, Mode::ReadOnly).is_some()
                ]);
                if last_cached.get(cwd) != Some(&c) {
                    cached.insert((*cwd).to_owned(), c.clone());
                }
                last_cached.insert(cwd, c);
            }
            let (clock_after, ids_after) = (
                r.world.clock.lock().unwrap().0,
                r.world.ids.load(Ordering::SeqCst),
            );
            // `Object.entries` in the recorder: compared as objects.
            let want_got = if s(st, "op") == "db.perSession" && st["got"].is_array() {
                entries_object(&st["got"])
            } else {
                st["got"].clone()
            };
            let mut diffs = vec![];
            let mut check = |what: &str, want: &Value, got: &Value| {
                let (w, g) = (rooted(want), rooted(got));
                if w != g {
                    diffs.push(format!("  {what}\n    want {w}\n    got  {g}"));
                }
            };
            check("got", &want_got, &got);
            check("envs", &st["envs"], &envs);
            check(
                "rows",
                st.get("rows").unwrap_or(&json!({})),
                &Value::Object(rows),
            );
            check(
                "cached",
                st.get("cached").unwrap_or(&json!({})),
                &Value::Object(cached),
            );
            check("clockAfter", &st["clockAfter"], &js_num(clock_after));
            check("idsAfter", &st["idsAfter"], &json!(ids_after));
            if diffs.is_empty() {
                continue;
            }
            if KNOWN.iter().any(|(n, k, _)| *n == name && *k == i) {
                known_hit.push((name, i));
                continue;
            }
            let mut op = st.as_object().unwrap().clone();
            for k in ["got", "envs", "rows", "cached", "clockAfter", "idsAfter"] {
                op.remove(k);
            }
            failures.push(format!(
                "{name} #{i} {}\n{}",
                js::stringify(&Value::Object(op)),
                diffs.join("\n")
            ));
        }
    }
    assert!(
        failures.is_empty(),
        "{} of {total} steps differ:\n{}",
        failures.len(),
        failures.join("\n")
    );
    for (n, k, why) in KNOWN {
        assert!(
            known_hit.contains(&(*n, *k)),
            "known difference {n} #{k} ({why}) now matches: drop it"
        );
    }
    assert!(total >= 600, "{total} steps");
}

fn record_context(v: &Value) -> RecordContext {
    RecordContext {
        cwd: s(v, "cwd").to_owned(),
        session_id: opt_str(&v["sessionId"]),
        run_id: opt_str(&v["runId"]),
        job_id: opt_str(&v["jobId"]),
        session_title: opt_str(&v["sessionTitle"]),
        has_subscribers: v["hasSubscribers"].as_bool(),
        has_active_background_work: v["hasActiveBackgroundWork"].as_bool(),
    }
}

#[test]
fn pure_functions_replay_the_ts() {
    let fx = fixture();
    let cases = fx["pure"].as_array().unwrap();
    let mut failures = vec![];
    for (i, c) in cases.iter().enumerate() {
        let got = match s(c, "fn") {
            "kindEnabled" => match is_kind_enabled(s(c, "kind"), c.get("prefs")) {
                Ok(b) => json!(b),
                Err(e) => json!({"threw": e.0}),
            },
            "map" => {
                let inputs: HashMap<String, f64> = c["inputs"]
                    .as_array()
                    .unwrap()
                    .iter()
                    .map(|p| (p[0].as_str().unwrap().to_owned(), p[1].as_f64().unwrap()))
                    .collect();
                match map_event_to_kind(&c["event"], &record_context(&c["ctx"]), &inputs) {
                    Ok(m) => m.map_or(Value::Null, |m| m.to_json()),
                    Err(e) => json!({"threw": e.0}),
                }
            }
            other => panic!("fn {other}"),
        };
        if js::stringify(&got) != js::stringify(&c["got"]) {
            failures.push(format!(
                "#{i} {}\n  want {}\n  got  {}",
                js::stringify(c),
                js::stringify(&c["got"]),
                js::stringify(&got)
            ));
        }
    }
    assert!(failures.is_empty(), "{}", failures.join("\n"));
    assert!(cases.len() >= 250, "{} cases", cases.len());
}

// ───────────────────────── beyond the golden ─────────────────────────

fn write_workspaces(list: Value) {
    // A fresh mtime each time: the bus caches the cwd map on it.
    static MTIME: AtomicU64 = AtomicU64::new(5_000_000);
    let mtime = MTIME.fetch_add(10, Ordering::SeqCst);
    write_ws(
        Some(&js::stringify(&json!({"version": 1, "workspaces": list}))),
        mtime,
    );
}

/// Serializes the tests below: they share workspaces.json.
static WS_LOCK: Mutex<()> = Mutex::new(());

/// The default timers: the flush runs a moment later on its own (a thread
/// outside a runtime, a task inside one), and the calls before it fold into
/// one `state` event.
#[test]
fn auto_timers_flush_and_coalesce() {
    let _ = root();
    let _g = WS_LOCK.lock().unwrap_or_else(|e| e.into_inner());
    let cwd = "/g/extra/auto";
    write_workspaces(json!([{"id": "wks_auto", "rootPath": cwd}]));
    let bus = NotificationBus::default();
    let mut sub = bus.subscribe();
    let turn = json!({"type": "turn_status", "status": "idle"});
    bus.record_session_event(cwd, "s1", &turn, SessionEventOpts::default());
    bus.record_session_event(cwd, "s1", &turn, SessionEventOpts::default());
    let got = sub.rx.blocking_recv().unwrap();
    assert!(
        matches!(&got, StreamEvent::State(s) if s.version == 1 && s.workspace_id == "wks_auto" && s.total_unread == 0),
        "{got:?}"
    );
    let rt = tokio::runtime::Builder::new_current_thread()
        .enable_time()
        .build()
        .unwrap();
    rt.block_on(async {
        let perm = json!({"type": "permission_request", "requestId": "auto-1", "toolName": "Bash"});
        bus.record_session_event(cwd, "s1", &perm, SessionEventOpts::default());
        bus.record_session_event(cwd, "s1", &turn, SessionEventOpts::default());
        let note = sub.recv().await.unwrap();
        assert!(matches!(&note, StreamEvent::Notification(r) if r.body == json!("Bash")));
        let state = sub.recv().await.unwrap();
        assert!(
            matches!(&state, StreamEvent::State(s) if s.version == 2 && s.total_unread == 1),
            "{state:?}"
        );
        tokio::time::sleep(Duration::from_millis(20)).await;
        assert!(sub.rx.try_recv().is_err(), "one state event for both calls");
    });
}

/// A receiver closed while its subscription lives is pruned at the next
/// fan-out.
#[test]
fn a_closed_receiver_is_pruned() {
    let _ = root();
    let _g = WS_LOCK.lock().unwrap_or_else(|e| e.into_inner());
    let cwd = "/g/extra/closed";
    write_workspaces(json!([{"id": "wks_closed", "rootPath": cwd}]));
    let bus = NotificationBus::new(BusOptions {
        timers: Timers::Manual,
        ..BusOptions::default()
    });
    let mut closed = bus.subscribe();
    let mut open = bus.subscribe();
    closed.rx.close();
    assert_eq!(bus.subscriber_count(), 2);
    let turn = json!({"type": "turn_status", "status": "idle"});
    bus.record_session_event(cwd, "s1", &turn, SessionEventOpts::default());
    assert!(bus.run_timers().is_empty());
    assert!(matches!(open.rx.try_recv(), Ok(StreamEvent::State(_))));
    assert_eq!(bus.subscriber_count(), 1);
    drop(closed);
    assert_eq!(bus.subscriber_count(), 1);
}

/// Dropping a subscription unsubscribes it; a reset closes every receiver.
#[test]
fn subscriptions_end_on_drop_and_reset() {
    let bus = NotificationBus::new(BusOptions {
        timers: Timers::Manual,
        ..BusOptions::default()
    });
    let a = bus.subscribe();
    let mut b = bus.subscribe();
    assert_eq!(bus.subscriber_count(), 2);
    drop(a);
    assert_eq!(bus.subscriber_count(), 1);
    bus.reset_for_tests();
    assert_eq!(bus.subscriber_count(), 0);
    assert!(matches!(
        b.rx.try_recv(),
        Err(tokio::sync::mpsc::error::TryRecvError::Disconnected)
    ));
    // Dropping a subscription from before the reset leaves new ones alone.
    let _c = bus.subscribe();
    drop(b);
    assert_eq!(bus.subscriber_count(), 1);
}

/// `getAllWorkspaceStates` keys follow the workspace list (TS's follow its
/// reads settling; the golden compares them sorted), a repeated id keeping
/// its first place and the last snapshot.
#[test]
fn all_states_keep_workspace_order() {
    let _ = root();
    let _g = WS_LOCK.lock().unwrap_or_else(|e| e.into_inner());
    write_workspaces(json!([
        {"id": "wks_z", "rootPath": "/g/extra/z"},
        {"id": "wks_a", "rootPath": "/g/extra/a"},
        {"id": "wks_z", "rootPath": "/g/extra/z2"},
        {"id": 5, "rootPath": "/g/extra/n"},
    ]));
    let bus = NotificationBus::new(BusOptions {
        timers: Timers::Manual,
        ..BusOptions::default()
    });
    let all = bus.get_all_workspace_states().unwrap();
    let keys: Vec<&str> = all.keys().map(String::as_str).collect();
    assert_eq!(keys, ["wks_z", "wks_a"]);
    assert_eq!(all["wks_z"].version, 2);
    assert_eq!(all["wks_a"].version, 1);
    assert_eq!(
        bus.get_workspace_state("wks_z").unwrap().unwrap().version,
        3
    );
    assert!(bus.get_workspace_state("5").unwrap().is_none());
}

/// `if (opts.before)`: a NaN cursor (`Number("x")` from a query string) is no
/// cursor.
#[test]
fn a_nan_cursor_is_none() {
    let _ = root();
    let cwd = "/g/extra/nan";
    for (i, t) in [10.0, 20.0, 30.0].into_iter().enumerate() {
        let input = NewNotification {
            id: Some(format!("n{i}")),
            kind: "session_error".into(),
            title: "t".into(),
            created_at: Some(t),
            ..NewNotification::default()
        };
        ndb::insert_notification(cwd, "w", &input, &|| 0.0, &|| "x".into()).unwrap();
    }
    let ids = |before| {
        let opts = ListOpts {
            before,
            ..ListOpts::default()
        };
        ndb::list_notifications(cwd, "w", &opts)
            .unwrap()
            .iter()
            .map(|r| r.id.as_str().unwrap().to_owned())
            .collect::<Vec<_>>()
    };
    assert_eq!(ids(None), ["n2", "n1", "n0"]);
    assert_eq!(ids(Some(f64::NAN)), ids(None));
    assert_eq!(ids(Some(25.0)), ["n1", "n0"]);
}
