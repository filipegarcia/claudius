//! `/api/schedule` GET/POST, `/api/schedule/:id` GET/PATCH/DELETE,
//! `:id/run-now` POST and `:id/runs` GET (G07b) against the real binary.
//!
//! The golden replay runs each group recorded from the TS handlers
//! (`claudius-core/tests/fixtures/schedule_routes_golden.json`, by
//! `rust/scripts/schedule-routes-golden.mjs`) on its own world and its own
//! server (`CLAUDIUS_SCHEDULER=1`, the fake CLI, `TZ=America/New_York`),
//! seeded before the spawn since the server boots its scheduler before it
//! listens, as `instrumentation.ts` does. After boot and after each step it
//! compares what the recording does: the response (status, content type,
//! body text), every file under `~/.claude/claudius`, each world dir's CLI
//! logs, and the scheduler's timers, which the server logs as it arms and
//! disarms them (`claudius::scheduler=debug`) and the test replays.
//!
//! The recording stubbed `process.pid` as [`REC_PID`], so a `"pid"` of the
//! server's process reads as that: a run it starts has to carry its own pid,
//! and the interrupted-run recovery at boot has to leave the same seeded
//! runs alone (one stamped with pid 1, alive and not ours).
//!
//! The recording ran on a virtual clock and counted ids; the server runs on
//! the real ones. So a recorded time that is a step's clock (`<t0> + 1000 *
//! k`, boot is k = 0) must be a whole number of ms within the time the
//! replay spent on that step; a recorded id `00000000-0000-4000-8000-<n>`
//! must be a v4 UUID, the same one wherever it shows up again (and in the
//! URLs that name it); a recorded `nextRunAt` must be the same slot of its
//! cron from now; and a timer is due 24 h after it was armed (each armed
//! cron is years away), armed within the step its recorded due time names.
//! Everything else is compared as text, and JSON text must be what
//! `JSON.stringify` writes for it.
//!
//! The rest checks who answers: only a server that runs the scheduler (G07c's
//! run stream too), so a job is armed, re-armed and run by the one scheduler
//! that's running; else Next does (or, without one, nobody). Since G07d the
//! scheduler is on unless `CLAUDIUS_SCHEDULER=0`, which those tests set.
//! G07c's `session-loops` (+ `cancel`) are answered here either way.

mod common;

use std::collections::{BTreeMap, BTreeSet, HashMap};
use std::io::{Read, Write};
use std::net::{Shutdown, TcpListener, TcpStream};
use std::path::{Path, PathBuf};
use std::process::{Command, Stdio};
use std::sync::{Arc, Mutex};
use std::thread::JoinHandle;
use std::time::Duration;

use claudius_agent::js;
use claudius_core::cron::{Zone, next_fire_after_in};
use common::{Payload, Server, fake_bin, free_port, wait_until};
use serde_json::{Value, json};

const TZ: &str = "America/New_York";
/// The recorder's ids: this, then the count as 12 digits.
const PLACEHOLDER: &str = "00000000-0000-4000-8000-";
/// `process.pid` as the recorder stubbed it; no process has it, so the
/// mapping can't hit a timestamp.
const REC_PID: u32 = 777_001;
/// The recorder's armed crons (`FAR`, `FAR2`): next slots years away.
const ARMED_CRONS: [&str; 2] = ["0 0 29 2 *", "15 3 29 2 *"];
/// `MAX_TIMEOUT_MS`: how far out a timer is set.
const DAY_MS: i64 = 86_400_000;
const LOG_FILTER: &str = "claudius=info,claudius::scheduler=debug";
/// The world dirs a run's CLI may log in (`CWDS` in the recorder).
const CWDS: [&str; 6] = ["project", "ws1", "ws2", "ws3", "ws4", "ws-extra"];

fn fixture() -> Value {
    serde_json::from_str(include_str!(
        "../../claudius-core/tests/fixtures/schedule_routes_golden.json"
    ))
    .unwrap()
}

fn now() -> i64 {
    claudius_core::now_ms()
}

fn fake() -> PathBuf {
    fake_bin().canonicalize().unwrap()
}

fn str_of(v: &Value) -> &str {
    v.as_str().unwrap_or_else(|| panic!("not a string: {v}"))
}

// ---- HTTP -------------------------------------------------------------------

#[derive(Debug)]
struct Got {
    status: u16,
    ctype: Option<String>,
    body: String,
}

fn send(s: &mut TcpStream, method: &str, url: &str, body: Option<&[u8]>) {
    let req = common::request_bytes(method, url, Payload::Json(body.unwrap_or_default()));
    s.write_all(&req).unwrap();
}

fn read_response(s: &mut TcpStream) -> Got {
    let r = common::read_response(s);
    assert!(r.status != 0, "{}", r.head);
    assert!(r.header("transfer-encoding").is_none(), "{}", r.head);
    Got {
        status: r.status,
        ctype: r.content_type(),
        body: String::from_utf8_lossy(&r.body).into_owned(),
    }
}

fn request(port: u16, method: &str, url: &str, body: Option<&[u8]>) -> Got {
    let mut s = TcpStream::connect(("127.0.0.1", port)).unwrap();
    send(&mut s, method, url, body);
    read_response(&mut s)
}

// ---- the world ---------------------------------------------------------------

/// A world as the recorder builds it, under a canonical temp root (so the
/// paths the server reports are the ones `$ROOT` stands for).
struct World {
    _tmp: tempfile::TempDir,
    root: PathBuf,
}

impl World {
    fn new(fx: &Value) -> World {
        let tmp = tempfile::tempdir().unwrap();
        let root = tmp.path().canonicalize().unwrap();
        let text = root.to_str().unwrap();
        // `$ROOT` is swapped textually, in JSON text too.
        assert!(
            text.bytes()
                .all(|c| c.is_ascii_alphanumeric() || b"_./-".contains(&c)),
            "root needs escaping: {text}"
        );
        std::fs::create_dir_all(root.join("project")).unwrap();
        for d in fx["world"]["dirs"].as_array().unwrap() {
            std::fs::create_dir_all(root.join(str_of(d))).unwrap();
        }
        let world = World { _tmp: tmp, root };
        for f in fx["world"]["files"].as_array().unwrap() {
            let p = world.root.join(str_of(&f[0]));
            std::fs::write(p, world.denorm(str_of(&f[1]))).unwrap();
        }
        std::fs::write(world.root.join("script.json"), js::stringify(&fx["script"])).unwrap();
        world
    }

    fn root_text(&self) -> &str {
        self.root.to_str().unwrap()
    }

    fn denorm(&self, s: &str) -> String {
        s.replace("$ROOT", self.root_text())
    }

    /// `~/.claude/claudius`, what the snapshots walk.
    fn claudius(&self) -> PathBuf {
        self.root.join("home/.claude/claudius")
    }

    fn sched(&self) -> PathBuf {
        self.claudius().join("schedule")
    }

    fn write(&self, rel: &str, text: &str) {
        let p = self.sched().join(rel);
        std::fs::create_dir_all(p.parent().unwrap()).unwrap();
        std::fs::write(p, text).unwrap();
    }

    fn server_out(&self) -> PathBuf {
        self.root.join("server.out")
    }

    /// `claudius` in this world, logging to `server.out`. The scheduler is
    /// on by default (G07d), so `scheduler: false` turns it off with
    /// `CLAUDIUS_SCHEDULER=0`.
    fn spawn(&self, fake: &Path, scheduler: bool, next: Option<u16>) -> Server {
        let port = free_port();
        let mut cmd = Command::new(common::server_bin());
        cmd.args(["--port", &port.to_string()]);
        match next {
            Some(up) => cmd.args(["--next", &format!("http://127.0.0.1:{up}")]),
            None => cmd.arg("--no-next"),
        };
        cmd.arg("--claude-bin")
            .arg(fake)
            .current_dir(self.root.join("project"))
            .env_remove("CLAUDIUS_DEBUG_SESSIONS")
            .env_remove("NODE_ENV")
            .env_remove("CLAUDIUS_DEV")
            .env_remove("CLAUDIUS_SCHEDULER")
            .env("RUST_LOG", LOG_FILTER)
            .env("HOME", self.root.join("home"))
            .env("CLAUDIUS_STATE_HOME", self.root.join("home"))
            .env("CLAUDE_CONFIG_DIR", self.root.join("config"))
            .env("TZ", TZ)
            .env("FAKE_CLAUDE_SCRIPT", self.root.join("script.json"))
            .env("FAKE_CLAUDE_ARGV", "argv.json")
            .env("FAKE_CLAUDE_LOG", "stdin.log")
            .env("FAKE_CLAUDE_EVENTS", "events.jsonl")
            .stdout(std::fs::File::create(self.server_out()).unwrap())
            .stderr(Stdio::null());
        cmd.env("CLAUDIUS_SCHEDULER", if scheduler { "1" } else { "0" });
        let mut child = cmd.spawn().unwrap();
        common::wait_healthy(&mut child, port, Duration::from_secs(30));
        Server { child, port }
    }

    fn log(&self) -> String {
        std::fs::read_to_string(self.server_out()).unwrap_or_default()
    }

    fn marks(&self, cwd: &str) -> usize {
        std::fs::read_to_string(self.root.join(cwd).join("events.jsonl"))
            .unwrap_or_default()
            .lines()
            .filter(|l| *l == r#"{"mark":"gate"}"#)
            .count()
    }
}

// ---- snapshots ------------------------------------------------------------------

/// `walk(~/.claude/claudius)`: `dir/` as `null`, a file as its text (or
/// `{hex}` when it isn't UTF-8).
fn walk(dir: &Path, rel: &str, norm: &dyn Fn(&str) -> String, out: &mut BTreeMap<String, Value>) {
    let Ok(rd) = std::fs::read_dir(dir) else {
        return;
    };
    for e in rd {
        let e = e.unwrap();
        let name = e.file_name().into_string().unwrap();
        let r = if rel.is_empty() {
            name
        } else {
            format!("{rel}/{name}")
        };
        if e.path().is_dir() {
            out.insert(format!("{r}/"), Value::Null);
            walk(&e.path(), &r, norm, out);
        } else {
            let bytes = std::fs::read(e.path()).unwrap();
            let v = match String::from_utf8(bytes) {
                Ok(t) => Value::String(norm(&t)),
                Err(e) => {
                    let hex: String = e.as_bytes().iter().map(|b| format!("{b:02x}")).collect();
                    json!({ "hex": hex })
                }
            };
            out.insert(r, v);
        }
    }
}

/// Each world dir's `argv.json` and `stdin.log` (request ids as `$ID<n>`).
fn cli_logs(root: &Path, norm: &dyn Fn(&str) -> String) -> BTreeMap<String, Value> {
    let mut out = BTreeMap::new();
    for name in CWDS {
        let dir = root.join(name);
        let mut entry = serde_json::Map::new();
        if let Ok(t) = std::fs::read_to_string(dir.join("argv.json")) {
            entry.insert("argv".into(), serde_json::from_str(&norm(&t)).unwrap());
        }
        if let Ok(t) = std::fs::read_to_string(dir.join("stdin.log")) {
            let mut ids: Vec<String> = Vec::new();
            let lines = norm(&t)
                .split('\n')
                .filter(|l| !l.is_empty())
                .map(|l| {
                    let mut m: Value = serde_json::from_str(l).unwrap();
                    if let Some(id) = m["request_id"].as_str().map(str::to_owned) {
                        let n = ids.iter().position(|x| *x == id).unwrap_or_else(|| {
                            ids.push(id);
                            ids.len() - 1
                        });
                        m["request_id"] = json!(format!("$ID{n}"));
                    }
                    m
                })
                .collect();
            entry.insert("stdin".into(), Value::Array(lines));
        }
        if !entry.is_empty() {
            out.insert(name.to_owned(), Value::Object(entry));
        }
    }
    out
}

/// A `{set, del}` snapshot applied to the state it was taken against.
fn apply(state: &mut BTreeMap<String, Value>, diff: &Value) {
    for e in diff["set"].as_array().unwrap() {
        state.insert(str_of(&e[0]).to_owned(), e[1].clone());
    }
    for k in diff["del"].as_array().unwrap() {
        assert!(state.remove(str_of(k)).is_some(), "del of unknown {k}");
    }
}

#[derive(Debug, Clone, Copy)]
struct Timer {
    at: i64,
    due: i64,
    fire: i64,
}

fn log_num(s: &str) -> i64 {
    let n: f64 = s.parse().unwrap_or_else(|_| panic!("not a number: {s}"));
    assert_eq!(n.fract(), 0.0, "{s}");
    n as i64
}

/// The live timers, replayed from the server's `armed` / `disarmed` lines.
fn timers(log: &str) -> BTreeMap<String, Timer> {
    let mut out = BTreeMap::new();
    for line in log.lines() {
        if let Some((_, rest)) = line.split_once("[scheduler] armed ") {
            let (rest, fire) = rest.rsplit_once(" fire ").unwrap();
            let (rest, due) = rest.rsplit_once(" due ").unwrap();
            let (key, at) = rest.rsplit_once(" at ").unwrap();
            let t = Timer {
                at: log_num(at),
                due: log_num(due),
                fire: log_num(fire),
            };
            out.insert(key.to_owned(), t);
        } else if let Some((_, rest)) = line.split_once("[scheduler] disarmed ") {
            let (key, _) = rest.rsplit_once(" at ").unwrap();
            assert!(out.remove(key).is_some(), "disarmed {key} with no timer");
        }
    }
    out
}

// ---- unification -------------------------------------------------------------

enum Form {
    /// Response bodies, run lines: `JSON.stringify(v)`.
    Compact,
    /// `jobs.json`: `JSON.stringify(v, null, 2)` (+ the recording's newline).
    Pretty,
    /// `runs.jsonl`: compact lines, each compared on its own.
    Lines,
    /// Anything else: as is.
    Exact,
}

fn form_of(rel: &str) -> Form {
    if rel.ends_with(".jsonl") {
        Form::Lines
    } else if rel.ends_with(".json") {
        Form::Pretty
    } else {
        Form::Exact
    }
}

struct Replay {
    root: String,
    fake: String,
    t0: i64,
    /// The server's pid, once it has one.
    pid: Option<u32>,
    /// `[start, end]` of boot (0) and each step (k = step + 1), in ms.
    windows: Vec<(i64, i64)>,
    /// Recorded id → the server's.
    ids: Vec<(String, String)>,
    /// A recorded `nextRunAt` slot (as JSON) → that slot from now.
    next: HashMap<String, i64>,
}

fn is_placeholder(s: &str) -> bool {
    s.len() == 36 && s.starts_with(PLACEHOLDER) && s[24..].bytes().all(|c| c.is_ascii_digit())
}

fn short(s: &str) -> String {
    if s.chars().count() > 600 {
        format!("{}…", s.chars().take(600).collect::<String>())
    } else {
        s.to_owned()
    }
}

impl Replay {
    fn new(world: &World, fake: &Path, t0: i64) -> Replay {
        let now = now() as f64;
        let zone = || Zone::named(TZ).unwrap();
        let next = ARMED_CRONS
            .iter()
            .map(|cron| {
                let then = next_fire_after_in(cron, None, t0 as f64, None, zone()).unwrap();
                let from_now = next_fire_after_in(cron, None, now, None, zone()).unwrap();
                (then.to_string(), from_now)
            })
            .collect();
        Replay {
            root: world.root_text().to_owned(),
            fake: fake.to_str().unwrap().to_owned(),
            t0,
            pid: None,
            windows: Vec::new(),
            ids: Vec::new(),
            next,
        }
    }

    fn norm(&self, s: &str) -> String {
        let s = s.replace(&self.fake, "$FAKE").replace(&self.root, "$ROOT");
        // A run's own pid, as the recording stubbed it. Keyed on the field,
        // so no other number can match.
        match self.pid {
            Some(pid) => s.replace(&format!("\"pid\":{pid}"), &format!("\"pid\":{REC_PID}")),
            None => s,
        }
    }

    /// Recorded text with the ids bound so far, and `$ROOT`.
    fn subst(&self, s: &str) -> String {
        let mut s = s.replace("$ROOT", &self.root);
        for (p, a) in &self.ids {
            s = s.replace(p, a);
        }
        s
    }

    /// Recorded text with the ids bound so far, to compare with normalized
    /// text (where `$ROOT` stays).
    fn ids_only(&self, s: &str) -> String {
        let mut s = s.to_owned();
        for (p, a) in &self.ids {
            s = s.replace(p, a);
        }
        s
    }

    /// The step a recorded time is the clock of.
    fn clock(&self, n: f64) -> Option<usize> {
        let d = n - self.t0 as f64;
        (d >= 0.0 && d.fract() == 0.0 && d % 1000.0 == 0.0)
            .then_some((d / 1000.0) as usize)
            .filter(|k| *k < self.windows.len())
    }

    fn unify(&mut self, e: &Value, a: &Value, at: &str) -> Result<(), String> {
        match (e, a) {
            (Value::Object(eo), Value::Object(ao)) => {
                let ek: Vec<&String> = eo.keys().collect();
                let ak: Vec<&String> = ao.keys().collect();
                if ek != ak {
                    return Err(format!("{at}: keys {ek:?}, got {ak:?}"));
                }
                for (k, ev) in eo {
                    self.unify(ev, &ao[k], &format!("{at}.{k}"))?;
                }
                Ok(())
            }
            (Value::Array(ea), Value::Array(aa)) => {
                if ea.len() != aa.len() {
                    return Err(format!("{at}: {} items, got {}", ea.len(), aa.len()));
                }
                for (i, (ev, av)) in ea.iter().zip(aa).enumerate() {
                    self.unify(ev, av, &format!("{at}[{i}]"))?;
                }
                Ok(())
            }
            (Value::String(es), Value::String(as_)) => self.unify_str(es, as_, at),
            (Value::Number(en), Value::Number(an)) => {
                let (ef, af) = (en.as_f64().unwrap(), an.as_f64().unwrap());
                if let Some(k) = self.clock(ef) {
                    let (lo, hi) = self.windows[k];
                    return (af.fract() == 0.0 && (lo as f64..=hi as f64).contains(&af))
                        .then_some(())
                        .ok_or_else(|| format!("{at}: {af} not in [{lo}, {hi}] (clock {k})"));
                }
                if let Some(n) = self.next.get(&js::stringify(e)) {
                    return (af == *n as f64)
                        .then_some(())
                        .ok_or_else(|| format!("{at}: slot {af}, want {n}"));
                }
                (js::stringify(e) == js::stringify(a))
                    .then_some(())
                    .ok_or_else(|| format!("{at}: {e}, got {a}"))
            }
            _ => (e == a)
                .then_some(())
                .ok_or_else(|| format!("{at}: {e}, got {a}")),
        }
    }

    fn unify_str(&mut self, e: &str, a: &str, at: &str) -> Result<(), String> {
        if !is_placeholder(e) {
            return (self.ids_only(e) == a)
                .then_some(())
                .ok_or_else(|| format!("{at}: {e:?}, got {a:?}"));
        }
        if let Some((_, b)) = self.ids.iter().find(|(p, _)| p == e) {
            return (b == a)
                .then_some(())
                .ok_or_else(|| format!("{at}: {e} is {b}, got {a}"));
        }
        let v4 = uuid::Uuid::parse_str(a)
            .is_ok_and(|u| u.get_version_num() == 4 && u.hyphenated().to_string() == a);
        if !v4 || self.ids.iter().any(|(_, b)| b == a) {
            return Err(format!("{at}: {e} as {a:?}, not a new v4 uuid"));
        }
        self.ids.push((e.to_owned(), a.to_owned()));
        Ok(())
    }

    /// Normalized actual text against recorded text, as `form` reads it.
    fn unify_text(&mut self, e: &str, a: &str, form: Form) -> Result<(), String> {
        if self.ids_only(e) == a {
            return Ok(());
        }
        match form {
            Form::Exact => Err(format!("{}\n  got {}", short(e), short(a))),
            Form::Lines => {
                let (el, al): (Vec<&str>, Vec<&str>) =
                    (e.split('\n').collect(), a.split('\n').collect());
                if el.len() != al.len() {
                    return Err(format!(
                        "{} lines, got {}:\n{}\n  got {}",
                        el.len(),
                        al.len(),
                        short(e),
                        short(a)
                    ));
                }
                for (i, (e, a)) in el.into_iter().zip(al).enumerate() {
                    self.unify_text(e, a, Form::Compact)
                        .map_err(|m| format!("line {i}: {m}"))?;
                }
                Ok(())
            }
            Form::Compact | Form::Pretty => {
                let fail = |m: &str| format!("{m}:\n{}\n  got {}", short(e), short(a));
                let pe = js::json_parse(e).map_err(|_| fail("differs"))?;
                let pa = js::json_parse(a).map_err(|_| fail("not JSON"))?;
                let canon = match form {
                    Form::Pretty => {
                        js::stringify_pretty(&pa) + if e.ends_with('\n') { "\n" } else { "" }
                    }
                    _ => js::stringify(&pa),
                };
                if canon != a {
                    return Err(fail("not as JSON.stringify writes it"));
                }
                self.unify(&pe, &pa, "$").map_err(|m| fail(&m))
            }
        }
    }
}

// ---- the golden replay ------------------------------------------------------

struct Pending {
    handle: JoinHandle<Got>,
}

fn step_body(rp: &Replay, step: &Value) -> Option<Vec<u8>> {
    if let Some(hex) = step["hex"].as_str() {
        let bytes: Vec<u8> = (0..hex.len())
            .step_by(2)
            .map(|i| u8::from_str_radix(&hex[i..i + 2], 16).unwrap())
            .collect();
        let text = String::from_utf8(bytes).expect("hex bodies are UTF-8 here");
        return Some(rp.subst(&text).into_bytes());
    }
    step["body"].as_str().map(|b| rp.subst(b).into_bytes())
}

fn check_got(rp: &mut Replay, want: &Value, got: &Got, log: &str) -> Result<(), String> {
    if let Some(threw) = want["threw"].as_str() {
        if got.status != 500 || got.ctype.is_some() || !got.body.is_empty() {
            return Err(format!("want the empty 500 ({threw}), got {got:?}"));
        }
        // What the handler threw, as the server logs it.
        let tail = format!("] {threw}");
        return log
            .lines()
            .any(|l| rp.norm(l).ends_with(&tail))
            .then_some(())
            .ok_or_else(|| format!("no `{tail}` logged:\n{log}"));
    }
    if Some(got.status) != want["status"].as_u64().map(|s| s as u16)
        || got.ctype.as_deref() != want["type"].as_str()
    {
        return Err(format!("want {want}, got {got:?}"));
    }
    let body = rp.norm(&got.body);
    rp.unify_text(str_of(&want["body"]), &body, Form::Compact)
}

fn check_snap(
    rp: &mut Replay,
    world: &World,
    snap: &Value,
    files: &mut BTreeMap<String, Value>,
    cli: &mut BTreeMap<String, Value>,
) -> Result<(), String> {
    // Files.
    apply(files, &snap["files"]);
    let mut actual = BTreeMap::new();
    walk(&world.claudius(), "", &|s| rp.norm(s), &mut actual);
    // Paths name job ids too.
    let want: BTreeMap<String, &Value> = files.iter().map(|(k, v)| (rp.ids_only(k), v)).collect();
    let (ek, ak): (BTreeSet<&String>, BTreeSet<&String>) =
        (want.keys().collect(), actual.keys().collect());
    if ek != ak {
        return Err(format!("files {ek:?}\n  got {ak:?}"));
    }
    for (rel, want) in want {
        let got = &actual[&rel];
        match (want, got) {
            (Value::String(w), Value::String(g)) => rp
                .unify_text(w, g, form_of(&rel))
                .map_err(|m| format!("{rel}: {m}"))?,
            _ if want == got => {}
            _ => return Err(format!("{rel}: {want}, got {got}")),
        }
    }
    // Timers.
    let live = timers(&world.log());
    let mut want_keys = BTreeSet::new();
    for t in snap["timers"].as_array().unwrap() {
        let rec = str_of(&t[0]);
        let key = match serde_json::from_str::<Value>(rec) {
            Ok(Value::String(id)) if is_placeholder(&id) => {
                let (_, a) = rp
                    .ids
                    .iter()
                    .find(|(p, _)| *p == id)
                    .unwrap_or_else(|| panic!("timer for unbound {id}"));
                js::stringify(&json!(a))
            }
            _ => rec.to_owned(),
        };
        let due = t[1].as_i64().unwrap();
        let Some(k) = rp.clock((due - DAY_MS) as f64) else {
            return Err(format!("timer {rec} due {due}: not a day after a step"));
        };
        let Some(got) = live.get(&key) else {
            return Err(format!("no timer {key}: {live:?}"));
        };
        let (lo, hi) = rp.windows[k];
        if !(lo..=hi).contains(&got.at) || got.due - got.at != DAY_MS || got.fire - got.at <= DAY_MS
        {
            return Err(format!(
                "timer {key} {got:?}: armed in [{lo}, {hi}] (clock {k}), due a day later, firing after that"
            ));
        }
        // What arming wrote, if the job is still there to say.
        let jobs = std::fs::read_to_string(world.sched().join("jobs.json")).unwrap_or_default();
        if let Ok(jobs) = serde_json::from_str::<Value>(&jobs)
            && let Some(job) = jobs["jobs"]
                .as_array()
                .and_then(|js| js.iter().find(|j| js::stringify(&j["id"]) == key))
            && let Some(next) = job["nextRunAt"].as_f64()
            && next != got.fire as f64
        {
            return Err(format!(
                "timer {key} fires at {}, job's nextRunAt is {next}",
                got.fire
            ));
        }
        want_keys.insert(key);
    }
    let live_keys: BTreeSet<String> = live.keys().cloned().collect();
    if want_keys != live_keys {
        return Err(format!("timers {want_keys:?}\n  got {live_keys:?}"));
    }
    // CLI logs.
    apply(cli, &snap["cli"]);
    let got = cli_logs(&world.root, &|s| rp.norm(s));
    if *cli != got {
        return Err(format!(
            "cli logs {}\n  got {}",
            js::stringify(&json!(cli)),
            js::stringify(&json!(got))
        ));
    }
    Ok(())
}

fn replay_group(fx: &Value, g: &Value, fake: &Path) {
    let name = str_of(&g["name"]);
    let world = World::new(fx);
    for s in g["seed"].as_array().unwrap() {
        world.write(str_of(&s[0]), &world.denorm(str_of(&s[1])));
    }
    let t0 = g["boot"]["clock"].as_i64().unwrap();
    assert_eq!(t0, fx["t0"].as_i64().unwrap());
    let mut rp = Replay::new(&world, fake, t0);
    let mut files = BTreeMap::new();
    let mut cli = BTreeMap::new();

    let start = now();
    let server = world.spawn(fake, true, None);
    rp.pid = Some(server.child.id());
    rp.windows.push((start, now()));
    let log = world.log();
    match g["boot"]["result"].get("threw").and_then(Value::as_str) {
        Some(threw) => assert!(
            log.contains(&format!("[scheduler] boot failed: {threw}")),
            "{name}: boot should fail with {threw}:\n{log}"
        ),
        None => assert!(!log.contains("boot failed"), "{name}:\n{log}"),
    }
    check_snap(&mut rp, &world, &g["boot"]["snap"], &mut files, &mut cli)
        .unwrap_or_else(|m| panic!("{name}, boot: {m}"));

    let mut pending: HashMap<String, Pending> = HashMap::new();
    let mut gates: HashMap<String, usize> = HashMap::new();
    for (i, step) in g["steps"].as_array().unwrap().iter().enumerate() {
        assert_eq!(step["clock"].as_i64().unwrap(), t0 + 1000 * (i as i64 + 1));
        let ctx = format!(
            "{name}, step {i} ({} {} {})",
            str_of(&step["op"]),
            step["method"].as_str().unwrap_or(""),
            step["url"]
                .as_str()
                .or(step["path"].as_str())
                .or(step["cwd"].as_str())
                .unwrap_or("")
        );
        let log_from = world.log().len();
        let start = now();
        let got = match str_of(&step["op"]) {
            "req" => {
                let url = rp.subst(str_of(&step["url"]));
                let body = step_body(&rp, step);
                Some(request(
                    server.port,
                    str_of(&step["method"]),
                    &url,
                    body.as_deref(),
                ))
            }
            "start" => {
                let cwd = str_of(&step["cwd"]).to_owned();
                let n = gates.entry(cwd.clone()).or_default();
                *n += 1;
                let n = *n;
                let url = rp.subst(str_of(&step["url"]));
                let port = server.port;
                let handle = std::thread::spawn(move || request(port, "POST", &url, None));
                wait_until(&format!("{ctx}: the gate"), Duration::from_secs(30), || {
                    world.marks(&cwd) >= n
                });
                pending.insert(cwd, Pending { handle });
                None
            }
            "release" => {
                let cwd = str_of(&step["cwd"]);
                let gate = world.root.join(cwd).join("release");
                std::fs::write(&gate, "").unwrap();
                let p = pending.remove(cwd).unwrap();
                let got = p.handle.join().unwrap();
                std::fs::remove_file(&gate).unwrap();
                Some(got)
            }
            "write" => {
                // As recorded: the text as is.
                world.write(str_of(&step["path"]), str_of(&step["text"]));
                None
            }
            "rm" => {
                let p = world.sched().join(str_of(&step["path"]));
                if p.is_dir() {
                    std::fs::remove_dir_all(&p).unwrap();
                } else {
                    let _ = std::fs::remove_file(&p);
                }
                None
            }
            "mkdir" => {
                std::fs::create_dir_all(world.sched().join(str_of(&step["path"]))).unwrap();
                None
            }
            op => panic!("unknown op {op}"),
        };
        rp.windows.push((start, now()));
        match (&step.get("got"), got) {
            (Some(want), Some(got)) => {
                let log = world.log()[log_from..].to_owned();
                check_got(&mut rp, want, &got, &log).unwrap_or_else(|m| panic!("{ctx}: {m}"));
            }
            (None, None) => {}
            (want, got) => panic!("{ctx}: want {want:?}, got {got:?}"),
        }
        check_snap(&mut rp, &world, &step["snap"], &mut files, &mut cli)
            .unwrap_or_else(|m| panic!("{ctx}: {m}"));
    }
    assert!(pending.is_empty(), "{name}: runs left at a gate");
    drop(server);
}

#[test]
fn the_routes_replay_the_ts_handlers() {
    let fx = fixture();
    let fake = fake();
    assert_eq!(fx["pid"].as_u64(), Some(u64::from(REC_PID)));
    let groups = fx["groups"].as_array().unwrap();
    assert_eq!(groups.len(), 6);
    for g in groups {
        replay_group(&fx, g, &fake);
    }
}

// ---- who answers --------------------------------------------------------------

/// A stand-in Next: answers every request `203` with `<method> <target>
/// <body>`, and keeps a list of them.
struct Upstream {
    port: u16,
    seen: Arc<Mutex<Vec<String>>>,
}

fn find(hay: &[u8], needle: &[u8]) -> Option<usize> {
    hay.windows(needle.len()).position(|w| w == needle)
}

fn fill(c: &mut TcpStream, buf: &mut Vec<u8>, until: impl Fn(&[u8]) -> bool) -> bool {
    let mut chunk = [0u8; 4096];
    while !until(buf) {
        match c.read(&mut chunk) {
            Ok(0) | Err(_) => return false,
            Ok(n) => buf.extend_from_slice(&chunk[..n]),
        }
    }
    true
}

fn serve_upstream(mut c: TcpStream, seen: &Mutex<Vec<String>>) {
    let mut buf = Vec::new();
    loop {
        if !fill(&mut c, &mut buf, |b| find(b, b"\r\n\r\n").is_some()) {
            return;
        }
        let end = find(&buf, b"\r\n\r\n").unwrap();
        let head = String::from_utf8_lossy(&buf[..end]).into_owned();
        buf.drain(..end + 4);
        let mut lines = head.split("\r\n");
        let first = lines.next().unwrap().to_owned();
        let headers: Vec<(String, String)> = lines
            .filter_map(|l| l.split_once(':'))
            .map(|(k, v)| (k.trim().to_ascii_lowercase(), v.trim().to_owned()))
            .collect();
        let header = |k: &str| headers.iter().find(|(h, _)| h == k).map(|(_, v)| v.clone());
        let mut body = Vec::new();
        if header("transfer-encoding").is_some_and(|v| v.contains("chunked")) {
            loop {
                if !fill(&mut c, &mut buf, |b| find(b, b"\r\n").is_some()) {
                    return;
                }
                let at = find(&buf, b"\r\n").unwrap();
                let size =
                    usize::from_str_radix(String::from_utf8_lossy(&buf[..at]).trim(), 16).unwrap();
                buf.drain(..at + 2);
                if !fill(&mut c, &mut buf, |b| b.len() >= size + 2) {
                    return;
                }
                body.extend(buf.drain(..size));
                buf.drain(..2);
                if size == 0 {
                    break;
                }
            }
        } else {
            let len: usize = header("content-length").map_or(0, |v| v.parse().unwrap());
            if !fill(&mut c, &mut buf, |b| b.len() >= len) {
                return;
            }
            body.extend(buf.drain(..len));
        }
        let mut parts = first.split(' ');
        let text = format!(
            "{} {} {}",
            parts.next().unwrap(),
            parts.next().unwrap(),
            String::from_utf8_lossy(&body)
        );
        seen.lock().unwrap().push(text.clone());
        let resp = format!(
            "HTTP/1.1 203 Non-Authoritative Information\r\ncontent-type: text/x-upstream\r\ncontent-length: {}\r\n\r\n{text}",
            text.len()
        );
        if c.write_all(resp.as_bytes()).is_err() {
            return;
        }
    }
}

fn upstream() -> Upstream {
    let l = TcpListener::bind("127.0.0.1:0").unwrap();
    let port = l.local_addr().unwrap().port();
    let seen = Arc::new(Mutex::new(Vec::new()));
    let list = seen.clone();
    std::thread::spawn(move || {
        for c in l.incoming().flatten() {
            let list = list.clone();
            std::thread::spawn(move || serve_upstream(c, &list));
        }
    });
    Upstream { port, seen }
}

const JOBS: &str = r#"{
  "jobs": [
    {
      "id": "j",
      "name": "job j",
      "cron": "0 0 29 2 *",
      "prompt": "[plain] j",
      "cwd": "$ROOT/project",
      "enabled": true,
      "createdAt": 1000,
      "updatedAt": 2000
    }
  ]
}
"#;

/// The six ported handlers, one request each.
const OWNED: [(&str, &str, &str); 6] = [
    ("GET", "/api/schedule?x=1", ""),
    (
        "POST",
        "/api/schedule",
        r#"{"name":"n","cron":"0 0 29 2 *","prompt":"p"}"#,
    ),
    ("GET", "/api/schedule/j", ""),
    ("PATCH", "/api/schedule/j", r#"{"name":"renamed"}"#),
    ("POST", "/api/schedule/j/run-now", ""),
    ("GET", "/api/schedule/j/runs?limit=2", ""),
];
const DELETE: (&str, &str, &str) = ("DELETE", "/api/schedule/j", "");
/// G07c's run stream: the scheduler's too (`schedule_stream.rs` replays it).
const STREAM: (&str, &str, &str) = ("GET", "/api/schedule/j/runs/r1/stream", "");
/// G07c's `session-loops` (+ `cancel`), with their answers: live sessions
/// are this process's, so it answers them either way (`schedule_stream.rs`
/// replays them).
const LIVE: [((&str, &str, &str), u16, &str); 2] = [
    (
        ("GET", "/api/schedule/session-loops", ""),
        200,
        r#"{"loops":[]}"#,
    ),
    (
        (
            "POST",
            "/api/schedule/session-loops/cancel",
            r#"{"loopId":"l"}"#,
        ),
        400,
        r#"{"ok":false,"error":"sessionId and loopId required"}"#,
    ),
];
/// Methods those two don't export: axum's empty 405 here, as Next's, never
/// forwarded (nor taken by `{id}`).
const UNEXPORTED: [(&str, &str, &str); 4] = [
    ("POST", "/api/schedule/session-loops", "{}"),
    ("DELETE", "/api/schedule/session-loops", ""),
    ("GET", "/api/schedule/session-loops/cancel", ""),
    ("PATCH", "/api/schedule/session-loops/cancel", "{}"),
];

fn seeded(fx: &Value) -> (World, PathBuf) {
    let world = World::new(fx);
    world.write("jobs.json", &world.denorm(JOBS));
    let file = world.sched().join("jobs.json");
    (world, file)
}

fn call(port: u16, (method, url, body): (&str, &str, &str)) -> Got {
    request(
        port,
        method,
        url,
        (!body.is_empty()).then_some(body.as_bytes()),
    )
}

fn answers_live(port: u16) {
    for (req, status, body) in LIVE {
        let got = call(port, req);
        assert_eq!(
            (got.status, got.ctype.as_deref(), got.body.as_str()),
            (status, Some("application/json"), body),
            "{req:?}"
        );
    }
    for req in UNEXPORTED {
        let got = call(port, req);
        assert_eq!(
            (got.status, got.ctype.as_deref(), got.body.as_str()),
            (405, None, ""),
            "{req:?}"
        );
    }
}

fn forwarded(up: &Upstream, port: u16, req: (&str, &str, &str)) {
    let (method, url, body) = req;
    let got = call(port, req);
    let text = format!("{method} {url} {body}");
    assert_eq!(
        (got.status, got.ctype.as_deref(), got.body.as_str()),
        (203, Some("text/x-upstream"), text.as_str()),
        "{method} {url}"
    );
    assert_eq!(up.seen.lock().unwrap().last(), Some(&text));
}

/// With `CLAUDIUS_SCHEDULER=0` (the Next upstream runs the jobs).
#[test]
fn next_answers_them_while_it_runs_the_scheduler() {
    let fx = fixture();
    let (world, file) = seeded(&fx);
    let before = std::fs::read(&file).unwrap();
    let up = upstream();
    let server = world.spawn(&fake(), false, Some(up.port));
    for req in OWNED.into_iter().chain([DELETE, STREAM]) {
        forwarded(&up, server.port, req);
    }
    answers_live(server.port);
    assert_eq!(up.seen.lock().unwrap().len(), 8);
    // Nothing armed, saved or run here.
    assert_eq!(std::fs::read(&file).unwrap(), before);
    assert!(!world.sched().join("jobs").exists());
    assert!(!world.log().contains("[scheduler]"), "{}", world.log());
    drop(server);
}

#[test]
fn with_the_scheduler_it_answers_them() {
    let fx = fixture();
    let (world, file) = seeded(&fx);
    let up = upstream();
    let server = world.spawn(&fake(), true, Some(up.port));
    let port = server.port;
    let job: Value = serde_json::from_str(&call(port, OWNED[2]).body).unwrap();
    assert_eq!(job["id"], "j");
    assert!(job["nextRunAt"].is_i64(), "booted and armed: {job}");
    let mut statuses = Vec::new();
    for req in OWNED {
        let got = call(port, req);
        assert_eq!(
            got.ctype.as_deref(),
            Some("application/json"),
            "{req:?}: {got:?}"
        );
        statuses.push(got.status);
    }
    assert_eq!(statuses, [200, 201, 200, 200, 202, 200]);
    let stored: Value = serde_json::from_str(&std::fs::read_to_string(&file).unwrap()).unwrap();
    assert_eq!(stored["jobs"][0]["name"], "renamed");
    assert_eq!(stored["jobs"][0]["lastStatus"], "success");
    assert_eq!(stored["jobs"].as_array().unwrap().len(), 2);
    assert_eq!(call(port, DELETE).body, r#"{"ok":true}"#);
    answers_live(port);
    // The stream: an unknown run, then the marker at the first check.
    let mut s = TcpStream::connect(("127.0.0.1", port)).unwrap();
    send(&mut s, STREAM.0, STREAM.1, None);
    let mut raw = String::new();
    s.read_to_string(&mut raw).unwrap();
    assert!(raw.starts_with("HTTP/1.1 200 OK\r\n"), "{raw}");
    assert!(
        raw.contains("\r\ncontent-type: text/event-stream\r\n"),
        "{raw}"
    );
    assert!(
        raw.contains(r#"data: {"type":"error","message":"run_not_live"}"#)
            && raw.contains(r#"data: {"type":"ready","sessionId":"r1:done"}"#),
        "{raw}"
    );
    assert!(up.seen.lock().unwrap().is_empty());
    drop(server);
}

#[test]
fn without_next_or_the_scheduler_nobody_does() {
    let fx = fixture();
    let (world, file) = seeded(&fx);
    let before = std::fs::read(&file).unwrap();
    let server = world.spawn(&fake(), false, None);
    for req in OWNED.into_iter().chain([DELETE, STREAM]) {
        let got = call(server.port, req);
        assert_eq!(
            (got.status, got.body.as_str()),
            (404, "not found (no Next upstream configured)"),
            "{req:?}"
        );
    }
    answers_live(server.port);
    assert_eq!(std::fs::read(&file).unwrap(), before);
    assert!(!world.sched().join("jobs").exists());
    drop(server);
}

#[test]
fn a_run_now_whose_caller_leaves_still_ends() {
    // TS's handler awaits the run, and the run doesn't stop for a client
    // that went away; one cut short would leave the job in flight, so every
    // later run of it would be skipped.
    let fx = fixture();
    let world = World::new(&fx);
    world.write(
        "jobs.json",
        &world.denorm(
            &JOBS
                .replace("[plain] j", "[gate] j")
                .replace("\"enabled\": true", "\"enabled\": false"),
        ),
    );
    let server = world.spawn(&fake(), true, None);
    let mut s = TcpStream::connect(("127.0.0.1", server.port)).unwrap();
    send(&mut s, "POST", "/api/schedule/j/run-now", None);
    wait_until("the gate", Duration::from_secs(30), || {
        world.marks("project") >= 1
    });
    s.shutdown(Shutdown::Both).unwrap();
    drop(s);
    // Long enough for the server to see the client gone.
    std::thread::sleep(Duration::from_millis(500));
    std::fs::write(world.root.join("project/release"), "").unwrap();
    let runs = world.sched().join("jobs/j/runs.jsonl");
    wait_until("the run's end", Duration::from_secs(30), || {
        std::fs::read_to_string(&runs).is_ok_and(|t| t.contains(r#""status":"success""#))
    });
    // Not in flight any more: the next one runs.
    let got = request(server.port, "POST", "/api/schedule/j/run-now", None);
    assert_eq!(got.status, 202, "{got:?}");
    let lines: Vec<Value> = std::fs::read_to_string(&runs)
        .unwrap()
        .lines()
        .map(|l| serde_json::from_str(l).unwrap())
        .collect();
    let status: Vec<&str> = lines
        .iter()
        .map(|r| r["status"].as_str().unwrap())
        .collect();
    assert_eq!(status, ["success", "success"], "{lines:?}");
    drop(server);
}
