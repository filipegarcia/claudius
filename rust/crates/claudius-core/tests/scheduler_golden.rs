//! Scheduler parity (G07a): `scheduler_store` and `scheduler` replayed
//! against what `lib/server/scheduler-store.ts` and `lib/server/scheduler.ts`
//! did in `rust/scripts/scheduler-golden.mjs`.
//!
//! The replay runs on tokio's paused clock, with auto-advance held off by a
//! blocking task for the whole test, so only the steps move time: a clock
//! advance steps to each timer deadline in turn (the scheduler's timers
//! and the 5 s live-buffer linger), then waits for the scheduler to settle,
//! as the recorder's virtual timer queue did. Runs go to the fake CLI with
//! the recorded script, in a cwd per job, and the CLI's logs there (argv,
//! stdin) are compared too. After every step the result and the snapshot
//! (every file under `~/.claude`, the timers, in-flight jobs, live runs,
//! bus calls, subscriber events and CLI logs) must match the recording.
//!
//! The two recorded differences (`diff` on a step) are checked as such: a
//! lone surrogate reads as U+FFFD (and is written that way), and a job id
//! whose run files would land outside the schedule root is refused.
//!
//! The recording stubbed `process.pid` as [`REC_PID`] and `process.uptime()`
//! so each scenario's `processStartedAt` is its `procStart`. Here the
//! scheduler is told that `procStart`, and a `"pid"` of this process reads as
//! [`REC_PID`] (and the other way round when a run is seeded), so a recovery
//! pass has to leave the runs this process owns alone, and every run it
//! starts has to carry its own pid.

use std::collections::{BTreeMap, HashMap};
use std::path::{Path, PathBuf};
use std::sync::{Arc, Mutex, OnceLock};
use std::time::Duration;

use claudius_agent::js;
use claudius_core::cron::Zone;
use claudius_core::scheduler::{
    Clock, RunFinished, RunUnsubscribe, RunnerOptions, Scheduler, SchedulerConfig, TokioClock,
};
use claudius_core::scheduler_store::{JobPatch, JsValue, StoreError};
use serde_json::{Map, Value, json};

/// The fixture, with each lone-surrogate escape (which serde_json rejects)
/// read as U+FFFD, as `js::json_parse` reads one.
fn fixture() -> &'static Value {
    static F: OnceLock<Value> = OnceLock::new();
    F.get_or_init(|| {
        let text = fix_lone_surrogates(include_str!("fixtures/scheduler_golden.json"));
        serde_json::from_str(&text).unwrap()
    })
}

fn fix_lone_surrogates(text: &str) -> String {
    let hex = |i: usize| {
        text.get(i..i + 4)
            .and_then(|h| u16::from_str_radix(h, 16).ok())
    };
    let mut out = String::with_capacity(text.len());
    let mut i = 0;
    while i < text.len() {
        if text[i..].starts_with('\\') {
            if text[i + 1..].starts_with('u')
                && let Some(u) = hex(i + 2)
            {
                let paired = (0xD800..0xDC00).contains(&u)
                    && text[i + 6..].starts_with("\\u")
                    && hex(i + 8).is_some_and(|l| (0xDC00..0xE000).contains(&l));
                if paired {
                    out.push_str(&text[i..i + 12]);
                    i += 12;
                } else if (0xD800..0xE000).contains(&u) {
                    out.push_str("\\ufffd");
                    i += 6;
                } else {
                    out.push_str(&text[i..i + 6]);
                    i += 6;
                }
            } else {
                out.push_str(&text[i..i + 2]);
                i += 2;
            }
            continue;
        }
        let c = text[i..].chars().next().unwrap();
        out.push(c);
        i += c.len_utf8();
    }
    out
}

fn fake_cli() -> &'static PathBuf {
    static FAKE: OnceLock<PathBuf> = OnceLock::new();
    FAKE.get_or_init(|| {
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
        PathBuf::from(env!("CARGO_MANIFEST_DIR"))
            .join("../../target/debug/claudius-fake-claude")
            .canonicalize()
            .unwrap()
    })
}

fn utf16_cmp(a: &str, b: &str) -> std::cmp::Ordering {
    a.encode_utf16().cmp(b.encode_utf16())
}

/// Sleep in real time (the tokio clock is paused).
async fn real_sleep(ms: u64) {
    tokio::task::spawn_blocking(move || std::thread::sleep(Duration::from_millis(ms)))
        .await
        .unwrap();
}

/// `process.pid` as the recorder stubbed it: no process has it, so the
/// mapping can't hit a timestamp.
const REC_PID: u32 = 777_001;

/// This process's pid as the recording writes one.
fn our_pid() -> String {
    std::process::id().to_string()
}

/// A scenario's world: the paths, the scheduler(s) and what the recorder
/// kept beside them.
struct World {
    root: String,
    fake: String,
    proc_start: f64,
    claude: PathBuf,
    sched_root: PathBuf,
    cwds: PathBuf,
    env: HashMap<String, String>,
    zone: Zone,
    clock: Arc<TokioClock>,
    ids: Arc<Mutex<HashMap<String, u64>>>,
    bus: Arc<Mutex<Vec<Value>>>,
    sched: Arc<Scheduler>,
    /// Schedulers replaced by `newScheduler` (they live on, as in TS).
    old: Vec<Arc<Scheduler>>,
    /// cwd -> how many gate marks its CLI must have logged.
    parked: BTreeMap<String, usize>,
    gates: HashMap<String, usize>,
    subs: Vec<(String, Arc<Mutex<Vec<Value>>>)>,
    unsubs: HashMap<String, RunUnsubscribe>,
    /// Unsubscribes of names subscribed again (TS just loses them).
    lost: Vec<RunUnsubscribe>,
    /// cwd -> a `startRun` whose turn is parked there.
    pending: HashMap<String, tokio::task::JoinHandle<Result<Option<String>, StoreError>>>,
}

impl World {
    fn scheduler(&self) -> Arc<Scheduler> {
        let ids = self.ids.clone();
        let bus = self.bus.clone();
        Scheduler::new(SchedulerConfig {
            root: self.sched_root.clone(),
            clock: self.clock.clone(),
            zone: self.zone,
            run_id: Arc::new(move |id: &JsValue| {
                let k = js::to_string(id.as_ref());
                let mut ids = ids.lock().unwrap();
                let n = ids.entry(k.clone()).or_insert(0);
                *n += 1;
                format!("{k}#{n}")
            }),
            runner: RunnerOptions {
                claude_bin: Some(fake_cli().clone()),
                env: Some(self.env.clone()),
            },
            process_started_at: self.proc_start,
            on_run_finished: Some(Arc::new(move |f: RunFinished| {
                let mut m = Map::new();
                if let Some(cwd) = f.cwd {
                    m.insert("cwd".into(), cwd);
                }
                m.insert("runId".into(), json!(f.run_id));
                if let Some(id) = f.job_id {
                    m.insert("jobId".into(), id);
                }
                m.insert("event".into(), f.event);
                bus.lock().unwrap().push(Value::Object(m));
            })),
        })
    }

    fn norm(&self, v: Value) -> Value {
        match v {
            Value::String(s) => Value::String(
                s.replace(&self.fake, "$FAKE")
                    .replace(&self.root, "$TMP")
                    // A run's own pid, as the recording stubbed it. Keyed on
                    // the field so no other number can match.
                    .replace(
                        &format!("\"pid\":{}", our_pid()),
                        &format!("\"pid\":{REC_PID}"),
                    ),
            ),
            Value::Array(a) => Value::Array(a.into_iter().map(|v| self.norm(v)).collect()),
            Value::Object(o) => Value::Object(
                o.into_iter()
                    .map(|(k, v)| {
                        let ours = k == "pid" && v.as_f64() == Some(f64::from(std::process::id()));
                        let v = if ours { json!(REC_PID) } else { self.norm(v) };
                        (k, v)
                    })
                    .collect(),
            ),
            v => v,
        }
    }

    /// A step's input as the JS value: `{"$undefined": true}` is
    /// `undefined` (an object member with it is left out), `$TMP` the root.
    fn denorm(&self, v: &Value) -> JsValue {
        Some(match v {
            Value::Object(o) if o.get("$undefined") == Some(&json!(true)) => return None,
            Value::String(s) => Value::String(
                s.replace("$TMP", &self.root)
                    // A seeded run of this process's.
                    .replace(
                        &format!("\"pid\":{REC_PID}"),
                        &format!("\"pid\":{}", our_pid()),
                    ),
            ),
            Value::Array(a) => Value::Array(
                a.iter()
                    .map(|v| self.denorm(v).unwrap_or(Value::Null))
                    .collect(),
            ),
            Value::Object(o) => Value::Object(
                o.iter()
                    .filter_map(|(k, v)| Some((k.clone(), self.denorm(v)?)))
                    .collect(),
            ),
            v => v.clone(),
        })
    }

    fn thrown(&self, e: &StoreError) -> Value {
        let mut m = Map::new();
        m.insert("name".into(), json!(e.name()));
        m.insert("message".into(), self.norm(json!(e.message())));
        if let Some(code) = e.code() {
            m.insert("code".into(), json!(code));
        }
        json!({ "throws": m })
    }

    fn result<T>(&self, r: Result<T, StoreError>, ok: impl FnOnce(T) -> Value) -> Value {
        match r {
            Ok(v) => match ok(v) {
                Value::String(s) if s == "$undefined" => json!({"ok": "$undefined"}),
                v => json!({ "ok": self.norm(v) }),
            },
            Err(e) => self.thrown(&e),
        }
    }

    fn marks(&self, cwd: &str) -> usize {
        std::fs::read_to_string(self.cwds.join(cwd).join("events.jsonl"))
            .map(|t| t.split('\n').filter(|l| *l == r#"{"mark":"gate"}"#).count())
            .unwrap_or(0)
    }

    fn all_schedulers(&self) -> impl Iterator<Item = &Arc<Scheduler>> {
        self.old.iter().chain([&self.sched])
    }

    /// The recorder's `settle()`: no fire in progress but the parked ones,
    /// each parked CLI at its gate with its run's first events out, and no
    /// timer or linger left that is due.
    fn quiet(&self) -> bool {
        let now = self.clock.now_ms();
        let parked = self.parked.len();
        let mut fires = 0;
        let mut live = Vec::new();
        for s in self.all_schedulers() {
            let d = s.debug_state();
            fires += d.fires;
            if d.timers.iter().any(|(_, due, fired)| !fired && *due <= now)
                || d.live
                    .iter()
                    .any(|l| l.linger_until.is_some_and(|u| u <= now))
            {
                return false;
            }
            live.extend(d.live.into_iter().filter(|l| !l.done));
        }
        fires == parked
            && self.parked.iter().all(|(cwd, n)| self.marks(cwd) >= *n)
            && live.len() == parked
            && live.iter().all(|l| l.events >= 2)
    }

    async fn settle(&self) {
        let start = std::time::Instant::now();
        loop {
            real_sleep(3).await;
            if self.quiet() {
                real_sleep(3).await;
                if self.quiet() {
                    return;
                }
            }
            assert!(
                start.elapsed() < Duration::from_secs(60),
                "settle timed out: {:?}",
                self.sched.debug_state()
            );
        }
    }

    async fn move_clock_to(&self, to: f64) {
        let now = self.clock.now_ms();
        if to > now {
            tokio::time::advance(Duration::from_millis((to - now) as u64)).await;
        }
        assert_eq!(self.clock.now_ms(), to.max(now));
    }

    /// The recorder's `advanceTo`: each deadline up to `target` in turn,
    /// settling after each, then `target`.
    async fn advance_to(&self, target: f64) {
        loop {
            let next = self
                .all_schedulers()
                .flat_map(|s| {
                    let d = s.debug_state();
                    let timers = d.timers.into_iter().filter(|t| !t.2).map(|t| t.1);
                    let lingers = d.live.into_iter().filter_map(|l| l.linger_until);
                    timers.chain(lingers).collect::<Vec<_>>()
                })
                .reduce(f64::min);
            match next {
                Some(t) if t <= target => {
                    self.move_clock_to(t).await;
                    self.settle().await;
                }
                _ => break,
            }
        }
        self.move_clock_to(target).await;
    }

    fn id(&self, step: &Value) -> JsValue {
        Some(step["id"].clone())
    }

    /// One step; `None` for the steps the recorder records no result for.
    async fn step(&mut self, step: &Value) -> Option<Value> {
        let sched = self.sched.clone();
        let store = sched.store();
        let undef = |_| json!("$undefined");
        Some(match step["op"].as_str().unwrap() {
            "writeFile" => {
                let p = self.sched_root.join(step["path"].as_str().unwrap());
                std::fs::create_dir_all(p.parent().unwrap()).unwrap();
                let bytes = match step["hex"].as_str() {
                    Some(h) => (0..h.len())
                        .step_by(2)
                        .map(|i| u8::from_str_radix(&h[i..i + 2], 16).unwrap())
                        .collect(),
                    None => self
                        .denorm(&step["text"])
                        .unwrap()
                        .as_str()
                        .unwrap()
                        .as_bytes()
                        .to_vec(),
                };
                std::fs::write(p, bytes).unwrap();
                return None;
            }
            "mkdir" => {
                std::fs::create_dir_all(self.sched_root.join(step["path"].as_str().unwrap()))
                    .unwrap();
                return None;
            }
            "rm" => {
                let p = self.sched_root.join(step["path"].as_str().unwrap());
                if p.is_dir() {
                    std::fs::remove_dir_all(p).unwrap();
                } else {
                    let _ = std::fs::remove_file(p);
                }
                return None;
            }
            "listJobs" => self.result(store.list_jobs(), Value::Array),
            "getJob" => self.result(store.get_job(&self.denorm(&step["id"])), |j| {
                j.unwrap_or(Value::Null)
            }),
            "saveJob" => self.result(store.save_job(self.denorm(&step["job"]).unwrap()), undef),
            "patchJob" => {
                let patch: JobPatch = step["patch"]
                    .as_object()
                    .unwrap()
                    .iter()
                    .map(|(k, v)| (k.clone(), self.denorm(v)))
                    .collect();
                self.result(store.patch_job(&self.denorm(&step["id"]), &patch), |j| {
                    j.unwrap_or(Value::Null)
                })
            }
            "deleteJob" => self.result(store.delete_job(&self.denorm(&step["id"])), |b| json!(b)),
            "appendRun" => {
                self.result(store.append_run(&self.denorm(&step["run"]).unwrap()), undef)
            }
            "appendMany" => {
                let r = (0..step["count"].as_u64().unwrap()).try_for_each(|i| {
                    store.append_run(&json!({
                        "id": format!("m{i}"),
                        "jobId": step["jobId"],
                        "startedAt": i,
                        "status": "success",
                    }))
                });
                self.result(r, undef)
            }
            "updateRun" => {
                self.result(store.update_run(&self.denorm(&step["run"]).unwrap()), undef)
            }
            "listRuns" => {
                let limit = match &step["limit"] {
                    Value::Null => 50.0,
                    Value::String(s) => js::to_number(s),
                    v => v.as_f64().unwrap(),
                };
                self.result(store.list_runs(&self.id(step), limit), Value::Array)
            }
            "boot" => self.result(self.sched.boot(), undef),
            "arm" => {
                let job = self.denorm(&step["job"]).unwrap();
                self.result(self.sched.arm(&job), undef)
            }
            "armStored" => {
                let r = store
                    .get_job(&self.id(step))
                    .and_then(|j| self.sched.arm(&j.unwrap_or(Value::Null)));
                self.result(r, undef)
            }
            "disarm" => {
                self.sched.disarm(&self.id(step));
                json!({"ok": "$undefined"})
            }
            "schedDeleteJob" => {
                self.sched.delete_job(&self.id(step));
                json!({"ok": "$undefined"})
            }
            "runNow" => {
                let sched = self.sched.clone();
                let r = sched.run_now(&self.denorm(&step["id"])).await;
                self.result(r, |id| match id {
                    Some(id) => json!({ "runId": id }),
                    None => Value::Null,
                })
            }
            // A run-now left at its gate; `release` records what it gave.
            "startRun" => {
                let cwd = step["cwd"].as_str().unwrap().to_owned();
                let n = self.gates.entry(cwd.clone()).or_insert(0);
                *n += 1;
                self.parked.insert(cwd.clone(), *n);
                let sched = self.sched.clone();
                let id = self.denorm(&step["id"]);
                self.pending
                    .insert(cwd, tokio::spawn(async move { sched.run_now(&id).await }));
                return None;
            }
            "mkdirCwd" => {
                std::fs::create_dir_all(self.cwds.join(step["cwd"].as_str().unwrap())).unwrap();
                return None;
            }
            "rmCwd" => {
                let _ = std::fs::remove_dir_all(self.cwds.join(step["cwd"].as_str().unwrap()));
                return None;
            }
            "advanceTo" => {
                for cwd in step["park"].as_array().into_iter().flatten() {
                    let cwd = cwd.as_str().unwrap().to_owned();
                    let n = self.gates.entry(cwd.clone()).or_insert(0);
                    *n += 1;
                    self.parked.insert(cwd, *n);
                }
                self.advance_to(step["at"].as_f64().unwrap()).await;
                return None;
            }
            "release" => {
                let cwd = step["cwd"].as_str().unwrap();
                let gate = self.cwds.join(cwd).join("release");
                std::fs::write(&gate, "").unwrap();
                self.parked.remove(cwd);
                self.settle().await;
                std::fs::remove_file(gate).unwrap();
                match self.pending.remove(cwd) {
                    None => return None,
                    Some(run) => self.result(run.await.unwrap(), |id| match id {
                        Some(id) => json!({ "runId": id }),
                        None => Value::Null,
                    }),
                }
            }
            "subscribe" => {
                let name = step["as"].as_str().unwrap().to_owned();
                let list = Arc::new(Mutex::new(Vec::new()));
                match self.subs.iter_mut().find(|(n, _)| *n == name) {
                    Some(entry) => entry.1 = list.clone(),
                    None => self.subs.push((name.clone(), list.clone())),
                }
                let unsub = self.sched.subscribe_run(
                    step["run"].as_str().unwrap(),
                    Arc::new(move |ev: &Value| list.lock().unwrap().push(ev.clone())),
                );
                if let Some(old) = self.unsubs.insert(name, unsub) {
                    self.lost.push(old);
                }
                return None;
            }
            "unsubscribe" => {
                self.unsubs
                    .remove(step["as"].as_str().unwrap())
                    .unwrap()
                    .unsubscribe();
                return None;
            }
            "isRunLive" => json!({ "ok": self.sched.is_run_live(step["run"].as_str().unwrap()) }),
            "isRunAttached" => {
                json!({ "ok": self.sched.is_run_attached(step["run"].as_str().unwrap()) })
            }
            "newScheduler" => {
                let fresh = self.scheduler();
                self.old.push(std::mem::replace(&mut self.sched, fresh));
                return None;
            }
            op => panic!("unknown op {op}"),
        })
    }

    /// Every file and directory under `~/.claude` (`[path, text | {hex} |
    /// null]`), keyed by path.
    fn files(&self) -> BTreeMap<String, String> {
        fn walk(w: &World, dir: &Path, rel: &str, out: &mut BTreeMap<String, String>) {
            let Ok(rd) = std::fs::read_dir(dir) else {
                return;
            };
            let mut names: Vec<String> = rd
                .map(|e| e.unwrap().file_name().into_string().unwrap())
                .collect();
            names.sort_by(|a, b| utf16_cmp(a, b));
            for name in names {
                let p = dir.join(&name);
                let r = if rel.is_empty() {
                    name.clone()
                } else {
                    format!("{rel}/{name}")
                };
                if std::fs::metadata(&p).unwrap().is_dir() {
                    out.insert(format!("{r}/"), "null".into());
                    walk(w, &p, &r, out);
                } else {
                    let bytes = std::fs::read(&p).unwrap();
                    let v = match String::from_utf8(bytes) {
                        Ok(text) => json!(text),
                        Err(e) => {
                            let hex: String =
                                e.as_bytes().iter().map(|b| format!("{b:02x}")).collect();
                            json!({ "hex": hex })
                        }
                    };
                    out.insert(r, js::stringify(&w.norm(v)));
                }
            }
        }
        let mut out = BTreeMap::new();
        walk(self, &self.claude, "", &mut out);
        out
    }

    /// Each cwd's CLI logs: `{cwd, argv?, stdin?}` with `request_id`s as
    /// `$ID<n>`, keyed by cwd.
    fn cli(&self) -> BTreeMap<String, String> {
        let mut out = BTreeMap::new();
        let mut names: Vec<String> = std::fs::read_dir(&self.cwds)
            .unwrap()
            .map(|e| e.unwrap().file_name().into_string().unwrap())
            .collect();
        names.sort_by(|a, b| utf16_cmp(a, b));
        for name in names {
            let dir = self.cwds.join(&name);
            let mut entry = Map::new();
            entry.insert("cwd".into(), json!(name));
            if let Ok(t) = std::fs::read_to_string(dir.join("argv.json")) {
                entry.insert("argv".into(), serde_json::from_str(&t).unwrap());
            }
            if let Ok(t) = std::fs::read_to_string(dir.join("stdin.log")) {
                let mut ids: HashMap<String, String> = HashMap::new();
                let lines: Vec<Value> = t
                    .split('\n')
                    .filter(|l| !l.is_empty())
                    .map(|l| {
                        let mut m: Value = serde_json::from_str(l).unwrap();
                        if let Some(rid) = m.get("request_id").and_then(Value::as_str) {
                            let n = ids.len();
                            let alias = ids
                                .entry(rid.to_owned())
                                .or_insert_with(|| format!("$ID{n}"))
                                .clone();
                            m["request_id"] = json!(alias);
                        }
                        m
                    })
                    .collect();
                entry.insert("stdin".into(), Value::Array(lines));
            }
            out.insert(name, js::stringify(&self.norm(Value::Object(entry))));
        }
        out
    }

    /// The snapshot's other parts: timers, in-flight jobs, live runs, bus
    /// calls and subscriber events.
    fn state(&self) -> Map<String, Value> {
        let d = self.sched.debug_state();
        let mut timers = d.timers;
        timers.sort_by(|a, b| utf16_cmp(&a.0, &b.0));
        let mut in_flight = d.in_flight;
        in_flight.sort_by(|a, b| utf16_cmp(a, b));
        let mut live = d.live;
        live.sort_by(|a, b| utf16_cmp(&a.run_id, &b.run_id));
        let mut bus: Vec<String> = self
            .bus
            .lock()
            .unwrap()
            .iter()
            .map(|b| js::stringify(&self.norm(b.clone())))
            .collect();
        bus.sort_by(|a, b| utf16_cmp(a, b));
        let mut m = Map::new();
        m.insert(
            "timers".into(),
            Value::Array(
                timers
                    .into_iter()
                    .map(|(k, due, fired)| json!([k, due as i64, fired]))
                    .collect(),
            ),
        );
        m.insert("inFlight".into(), json!(in_flight));
        m.insert(
            "live".into(),
            Value::Array(
                live.into_iter()
                    .map(|l| json!([l.run_id, l.events, l.done, l.subscribers]))
                    .collect(),
            ),
        );
        m.insert(
            "bus".into(),
            Value::Array(
                bus.iter()
                    .map(|t| serde_json::from_str(t).unwrap())
                    .collect(),
            ),
        );
        m.insert(
            "subs".into(),
            Value::Object(
                self.subs
                    .iter()
                    .map(|(n, l)| {
                        (
                            n.clone(),
                            self.norm(Value::Array(l.lock().unwrap().clone())),
                        )
                    })
                    .collect(),
            ),
        );
        m
    }
}

/// The recorder's `{set, del}` applied to a path -> JSON-text map.
fn apply(map: &mut BTreeMap<String, String>, diff: &Value, keep: impl Fn(&str) -> bool) {
    for e in diff["set"].as_array().unwrap() {
        let k = e[0].as_str().unwrap();
        if keep(k) {
            map.insert(k.to_owned(), js::stringify(&e[1]));
        }
    }
    for k in diff["del"].as_array().unwrap() {
        map.remove(k.as_str().unwrap());
    }
}

/// Paths the `escape` difference keeps Rust from writing.
fn escaped(path: &str) -> bool {
    path.starts_with("claudius/escape")
}

#[tokio::test(start_paused = true)]
async fn the_scheduler_matches_the_golden() {
    // Real I/O (the CLI's pipes, the polls here) must never move the clock:
    // a blocking task inhibits auto-advance while it runs.
    let (hold, held) = std::sync::mpsc::channel::<()>();
    let inhibitor = tokio::task::spawn_blocking(move || {
        let _ = held.recv();
    });

    let f = fixture();
    let tmp = tempfile::tempdir().unwrap();
    let root = tmp.path().canonicalize().unwrap();
    let home = root.join("home");
    std::fs::create_dir_all(&home).unwrap();
    let script = root.join("script.json");
    std::fs::write(&script, js::stringify(&f["script"])).unwrap();
    let env: HashMap<String, String> = [
        ("PATH", std::env::var("PATH").unwrap_or_default()),
        ("HOME", home.display().to_string()),
        ("TZ", f["tz"].as_str().unwrap().to_owned()),
        ("FAKE_CLAUDE_SCRIPT", script.display().to_string()),
        ("FAKE_CLAUDE_ARGV", "argv.json".into()),
        ("FAKE_CLAUDE_LOG", "stdin.log".into()),
        ("FAKE_CLAUDE_EVENTS", "events.jsonl".into()),
    ]
    .into_iter()
    .map(|(k, v)| (k.to_owned(), v))
    .collect();
    let zone = Zone::named(f["tz"].as_str().unwrap()).unwrap();

    assert_eq!(f["pid"].as_u64(), Some(u64::from(REC_PID)));
    let scenarios = f["scenarios"].as_array().unwrap();
    assert!(scenarios.len() >= 20);
    let mut steps_run = 0;
    for sc in scenarios {
        let name = sc["name"].as_str().unwrap();
        let claude = home.join(".claude");
        let cwds = root.join("cwd");
        let _ = std::fs::remove_dir_all(&claude);
        let _ = std::fs::remove_dir_all(&cwds);
        std::fs::create_dir_all(&cwds).unwrap();
        for c in sc["cwds"].as_array().unwrap() {
            std::fs::create_dir(cwds.join(c.as_str().unwrap())).unwrap();
        }
        let clock = Arc::new(TokioClock::new(sc["base"].as_f64().unwrap()));
        let mut w = World {
            root: root.display().to_string(),
            fake: fake_cli().display().to_string(),
            proc_start: sc["procStart"].as_f64().unwrap(),
            sched_root: claude.join("claudius").join("schedule"),
            claude,
            cwds,
            env: env.clone(),
            zone,
            clock,
            ids: Arc::default(),
            bus: Arc::default(),
            // Replaced right below, once `w` can build one.
            sched: Scheduler::new(SchedulerConfig {
                root: root.join("unused"),
                ..SchedulerConfig::default()
            }),
            old: Vec::new(),
            parked: BTreeMap::new(),
            gates: HashMap::new(),
            subs: Vec::new(),
            unsubs: HashMap::new(),
            lost: Vec::new(),
            pending: HashMap::new(),
        };
        w.sched = w.scheduler();

        let mut want_files = BTreeMap::new();
        let mut want_cli = BTreeMap::new();
        let mut want_state: Option<Map<String, Value>> = None;
        for (i, step) in sc["steps"].as_array().unwrap().iter().enumerate() {
            let at = format!("{name} step {i} ({})", step["op"]);
            let diff = step["diff"].as_str();
            let got = w.step(step).await;
            w.settle().await;
            steps_run += 1;

            // The result.
            match (diff, step["op"].as_str().unwrap()) {
                (Some("escape"), "appendRun") => assert_eq!(
                    got,
                    Some(json!({"throws": {
                        "name": "Error",
                        "message": "job id escapes the schedule root: ../../escape",
                    }})),
                    "{at}"
                ),
                (Some("escape"), "listRuns") => assert_eq!(got, Some(json!({"ok": []})), "{at}"),
                _ => assert_eq!(
                    got.as_ref().map(js::stringify),
                    step.get("result").map(js::stringify),
                    "{at}"
                ),
            }

            // The snapshot: what the recording last saw, updated by this
            // step's when it recorded one.
            if let Some(snap) = step.get("snap") {
                let mut files = snap["files"].clone();
                if diff == Some("lone surrogate") {
                    for e in files["set"].as_array_mut().unwrap() {
                        if let Some(t) = e[1].as_str() {
                            e[1] = json!(t.replace("\\ud800", "\u{fffd}"));
                        }
                    }
                }
                apply(&mut want_files, &files, |p| !escaped(p));
                apply(&mut want_cli, &snap["cli"], |_| true);
                let mut state = snap.as_object().unwrap().clone();
                state.remove("files");
                state.remove("cli");
                want_state = Some(state);
            }
            let got_files = w.files();
            assert!(!got_files.keys().any(|p| escaped(p)), "{at}");
            assert_eq!(got_files, want_files, "{at}: files");
            assert_eq!(w.cli(), want_cli, "{at}: CLI logs");
            let got_state = w.state();
            // The first step always records one.
            let want_state = want_state.as_ref().unwrap();
            for (k, want) in want_state {
                assert_eq!(
                    js::stringify(&got_state[k]),
                    js::stringify(want),
                    "{at}: {k}"
                );
            }
        }
        assert!(w.parked.is_empty(), "{name}: parked runs left");
        assert!(w.pending.is_empty(), "{name}: run-nows left at a gate");
        for s in w.all_schedulers() {
            assert_eq!(s.debug_state().fires, 0, "{name}: runs left in flight");
            s.shutdown().await;
        }
    }
    assert!(steps_run >= 300, "{steps_run} steps");
    drop(hold);
    inhibitor.await.unwrap();
}

#[test]
fn lone_surrogate_escapes_read_as_replacement_characters() {
    assert_eq!(
        fix_lone_surrogates(r#"["\ud800x", "\\ud800", "\ud83d\ude00", "\udc00", "\u00e9"]"#),
        r#"["\ufffdx", "\\ud800", "\ud83d\ude00", "\ufffd", "\u00e9"]"#
    );
}

/// A [`TokioClock`] running `behind` ms late: a timer then wakes that much
/// before its slot by this clock (a wall clock that drifted from the
/// monotonic one the timers use).
struct LateClock {
    inner: TokioClock,
    behind: std::sync::atomic::AtomicU64,
}

impl Clock for LateClock {
    fn now_ms(&self) -> f64 {
        self.inner.now_ms() - self.behind.load(std::sync::atomic::Ordering::SeqCst) as f64
    }
}

/// A store root with one job per `(id, prompt)`, every five minutes.
fn seed_jobs(root: &Path, cwd: &Path, jobs: &[(&str, &str)]) -> PathBuf {
    let sched_root = root.join("schedule");
    std::fs::create_dir_all(&sched_root).unwrap();
    let jobs: Vec<Value> = jobs
        .iter()
        .map(|(id, prompt)| {
            json!({"id": id, "name": id, "cron": "*/5 * * * *", "prompt": prompt,
                "cwd": cwd, "enabled": true, "createdAt": 1, "updatedAt": 1})
        })
        .collect();
    std::fs::write(
        sched_root.join("jobs.json"),
        js::stringify_pretty(&json!({ "jobs": jobs })) + "\n",
    )
    .unwrap();
    sched_root
}

const T0: f64 = 1_793_106_120_000.0; // 2026-10-27T13:02:00Z
const SLOT: f64 = 1_793_106_300_000.0; // 13:05

#[tokio::test(start_paused = true)]
async fn a_timer_that_wakes_up_to_250_ms_early_still_fires() {
    let (hold, held) = std::sync::mpsc::channel::<()>();
    let inhibitor = tokio::task::spawn_blocking(move || {
        let _ = held.recv();
    });
    for (behind, fires) in [(0, true), (250, true), (251, false)] {
        let tmp = tempfile::tempdir().unwrap();
        let root = tmp.path().canonicalize().unwrap();
        let sched_root = seed_jobs(&root, &root, &[("e", "p")]);
        let clock = Arc::new(LateClock {
            inner: TokioClock::new(T0),
            behind: Default::default(),
        });
        let sched = Scheduler::new(SchedulerConfig {
            root: sched_root.clone(),
            clock: clock.clone(),
            zone: Zone::named("America/New_York").unwrap(),
            // A run fails to launch right away: enough to see it happened.
            runner: RunnerOptions {
                claude_bin: Some(root.join("no-such-claude")),
                env: Some(HashMap::new()),
            },
            ..SchedulerConfig::default()
        });
        sched.boot().unwrap();
        assert_eq!(
            sched.debug_state().timers,
            vec![("\"e\"".into(), SLOT, false)]
        );
        clock
            .behind
            .store(behind, std::sync::atomic::Ordering::SeqCst);
        tokio::time::advance(Duration::from_millis((SLOT - T0) as u64)).await;
        let runs = sched_root.join("jobs/e/runs.jsonl");
        let start = std::time::Instant::now();
        loop {
            real_sleep(3).await;
            let d = sched.debug_state();
            let settled = d.fires == 0 && d.timers.iter().all(|t| t.1 > clock.now_ms() || t.2);
            if settled && (!fires || runs.exists()) {
                break;
            }
            assert!(start.elapsed() < Duration::from_secs(20), "{behind}: {d:?}");
        }
        let d = sched.debug_state();
        if fires {
            let text = std::fs::read_to_string(&runs).unwrap();
            assert!(text.contains(r#""status":"error""#), "{behind}: {text}");
        } else {
            // Re-armed for the same slot, `behind` ms out by this clock.
            assert!(!runs.exists(), "{behind}");
            let due = clock.now_ms() + behind as f64;
            assert_eq!(d.timers, vec![("\"e\"".into(), due, false)], "{behind}");
        }
        sched.shutdown().await;
    }
    drop(hold);
    inhibitor.await.unwrap();
}

/// With the default config, a run is stamped with this process's pid (the
/// golden replay compares the recorder's stand-in against this one).
#[tokio::test(start_paused = true)]
async fn a_run_records_this_process_s_pid() {
    let (hold, held) = std::sync::mpsc::channel::<()>();
    let inhibitor = tokio::task::spawn_blocking(move || {
        let _ = held.recv();
    });
    let tmp = tempfile::tempdir().unwrap();
    let root = tmp.path().canonicalize().unwrap();
    let sched_root = seed_jobs(&root, &root, &[("p", "p")]);
    let sched = Scheduler::new(SchedulerConfig {
        root: sched_root.clone(),
        clock: Arc::new(TokioClock::new(T0)),
        zone: Zone::named("America/New_York").unwrap(),
        // A CLI that can't launch: the run still records.
        runner: RunnerOptions {
            claude_bin: Some(root.join("no-such-claude")),
            env: Some(HashMap::new()),
        },
        ..SchedulerConfig::default()
    });
    // The default process start is in the past, so an unstamped run that
    // started before this process counts as interrupted.
    assert!(claudius_core::scheduler::process_started_ms() <= claudius_core::now_ms() as f64);
    sched.run_now(&Some(json!("p"))).await.unwrap().unwrap();
    let runs = std::fs::read_to_string(sched_root.join("jobs/p/runs.jsonl")).unwrap();
    let rec: Value = serde_json::from_str(runs.trim()).unwrap();
    assert_eq!(rec["pid"], json!(std::process::id()), "{rec}");
    sched.shutdown().await;
    drop(hold);
    inhibitor.await.unwrap();
}

#[tokio::test(start_paused = true)]
async fn shutdown_ends_the_runs_in_flight_and_stops_the_timers() {
    let (hold, held) = std::sync::mpsc::channel::<()>();
    let inhibitor = tokio::task::spawn_blocking(move || {
        let _ = held.recv();
    });
    let tmp = tempfile::tempdir().unwrap();
    let root = tmp.path().canonicalize().unwrap();
    let cwd = root.join("cwd");
    std::fs::create_dir(&cwd).unwrap();
    let script = root.join("script.json");
    std::fs::write(&script, js::stringify(&fixture()["script"])).unwrap();
    let sched_root = seed_jobs(&root, &cwd, &[("g", "[gate] G"), ("h", "[plain] H")]);
    let env: HashMap<String, String> = [
        ("PATH", std::env::var("PATH").unwrap_or_default()),
        ("FAKE_CLAUDE_SCRIPT", script.display().to_string()),
        ("FAKE_CLAUDE_EVENTS", "events.jsonl".into()),
    ]
    .into_iter()
    .map(|(k, v)| (k.to_owned(), v))
    .collect();
    let sched = Scheduler::new(SchedulerConfig {
        root: sched_root.clone(),
        clock: Arc::new(TokioClock::new(T0)),
        zone: Zone::named("America/New_York").unwrap(),
        run_id: Arc::new(|id: &JsValue| format!("{}#1", js::to_string(id.as_ref()))),
        runner: RunnerOptions {
            claude_bin: Some(fake_cli().clone()),
            env: Some(env),
        },
        on_run_finished: None,
        process_started_at: T0,
    });
    sched.boot().unwrap();
    assert_eq!(sched.debug_state().timers.len(), 2);

    let run = tokio::spawn({
        let sched = sched.clone();
        async move { sched.run_now(&Some(json!("g"))).await }
    });
    let start = std::time::Instant::now();
    while !std::fs::read_to_string(cwd.join("events.jsonl")).is_ok_and(|t| t.contains("gate")) {
        real_sleep(3).await;
        assert!(
            start.elapsed() < Duration::from_secs(20),
            "the run never got going"
        );
    }
    assert!(sched.is_run_live("g#1"));

    sched.shutdown().await;
    // The run ended (its CLI closed) and was recorded before shutdown returned.
    assert_eq!(sched.debug_state().fires, 0);
    let runs = std::fs::read_to_string(sched_root.join("jobs/g/runs.jsonl")).unwrap();
    let rec: Value = serde_json::from_str(runs.trim()).unwrap();
    assert_eq!(rec["status"], "error", "{rec}");
    assert_eq!(rec["note"], "Operation aborted", "{rec}");
    assert_eq!(run.await.unwrap().unwrap().as_deref(), Some("g#1"));
    assert!(!sched.is_run_live("g#1"));

    // No timers, and none set from now on: the slot passes with no run.
    assert!(sched.debug_state().timers.is_empty());
    let h = sched.store().get_job(&Some(json!("h"))).unwrap().unwrap();
    sched.arm(&h).unwrap();
    assert!(sched.debug_state().timers.is_empty());
    tokio::time::advance(Duration::from_millis((SLOT - T0) as u64 + 1000)).await;
    real_sleep(50).await;
    assert!(!sched_root.join("jobs/h").exists());
    drop(hold);
    inhibitor.await.unwrap();
}
