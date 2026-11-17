//! `claudius_core::updater::scheduler` (and `apply::pick_strategy` /
//! `env_for_bun_phase`) against `tests/fixtures/updater_apply_golden.json`,
//! recorded by `rust/scripts/updater-apply-golden.mjs` from the real
//! `lib/server/updater/scheduler.ts` on fake timers and a stub
//! `applyUpdate`.
//!
//! In process: the recorder's world is rebuilt from the fixture's world ops
//! (upstream, seed, the fakes at `home/.bun/bin`, a throwaway clone per
//! case that `$ROOT/current` points at); the apply requests between them
//! aren't sent (the scheduler cases only clone fresh installs from
//! upstream). Each case gets a fresh [`UpdaterScheduler`] whose [`Timers`]
//! record `{set: delay}` / `{clear: k}` and keep each timer's future (a
//! `fire` step runs it), and whose launcher records `"apply"`. Each step
//! must cause the same events, leave the same `updater.json`, and make the
//! same git calls. Steps tagged `nonRoot` (a 0444 mode) are skipped as
//! root.
//!
//! SAFETY: `CLAUDIUS_INSTALL_ROOT` is `$ROOT/current` under this test's temp
//! dir, checked before every scheduler step; the fake git refuses to run
//! outside the root. This is the one test here that runs the scheduler
//! with `CLAUDIUS_UPDATER_DISABLED` unset.
#![cfg(unix)]

use std::path::{Path, PathBuf};
use std::process::{Command, Stdio};
use std::sync::{Arc, Mutex};

use claudius_core::updater::apply::{
    self, ApplyOptions, ApplyOutcome, Phase, SharedApply, Strategy,
};
use claudius_core::updater::detect;
use claudius_core::updater::scheduler::{Source, Timers, UpdaterScheduler};
use claudius_core::{js_string, now_ms, paths};
use futures::FutureExt;
use futures::future::BoxFuture;
use serde_json::{Value, json};

fn fixture() -> Value {
    let path =
        PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("tests/fixtures/updater_apply_golden.json");
    js_string::parse(&std::fs::read_to_string(path).unwrap()).unwrap()
}

/// A delay as JSON prints it (`5000`, not `5000.0`).
fn num(v: f64) -> Value {
    if v.fract() == 0.0 && v.abs() < 9e15 {
        Value::from(v as i64)
    } else {
        Value::from(v)
    }
}

#[derive(Default)]
struct FakeTimers {
    events: Arc<Mutex<Vec<Value>>>,
    fires: Mutex<Vec<Option<BoxFuture<'static, ()>>>>,
}

impl Timers for FakeTimers {
    fn set(&self, delay_ms: f64, fire: BoxFuture<'static, ()>) -> u64 {
        let mut fires = self.fires.lock().unwrap();
        fires.push(Some(fire));
        self.events
            .lock()
            .unwrap()
            .push(json!({ "set": num(delay_ms) }));
        (fires.len() - 1) as u64
    }

    fn clear(&self, id: u64) {
        self.events.lock().unwrap().push(json!({ "clear": id }));
    }
}

/// `$T<n>` tokens as `$T`.
fn want_fixture(s: &str) -> String {
    let mut out = String::with_capacity(s.len());
    let mut rest = s;
    while let Some(at) = rest.find("$T") {
        out.push_str(&rest[..at + 2]);
        rest = rest[at + 2..].trim_start_matches(|c: char| c.is_ascii_digit());
    }
    out.push_str(rest);
    out
}

struct World {
    root: String,
    env: Vec<(String, String)>,
    real_git: String,
    t_start: i64,
}

impl World {
    fn p(&self, rel: &str) -> String {
        if rel.is_empty() {
            self.root.clone()
        } else {
            format!("{}/{rel}", self.root)
        }
    }

    fn norm(&self, s: &str) -> String {
        let s = s.replace(&self.root, "$ROOT");
        let (lo, hi) = (self.t_start - 1, now_ms() + 1);
        let b = s.as_bytes();
        let mut out = String::with_capacity(s.len());
        let mut i = 0;
        while i < b.len() {
            if b[i].is_ascii_digit() && (i == 0 || !b[i - 1].is_ascii_digit()) {
                let n = b[i..].iter().take_while(|c| c.is_ascii_digit()).count();
                if n == 13
                    && let Ok(v) = s[i..i + n].parse::<i64>()
                    && (lo..=hi).contains(&v)
                {
                    out.push_str("$T");
                    i += n;
                    continue;
                }
            }
            let c = s[i..].chars().next().unwrap();
            out.push(c);
            i += c.len_utf8();
        }
        out
    }

    fn file_state(&self) -> Value {
        let p = self.p("home/.claude/.claudius/updater.json");
        match std::fs::symlink_metadata(&p) {
            Ok(m) if m.is_dir() => Value::String("<dir>".into()),
            Ok(_) => Value::String(self.norm(&std::fs::read_to_string(&p).unwrap())),
            Err(_) => Value::Null,
        }
    }

    fn take_calls(&self) -> Value {
        let p = self.p("home/.bun/bin/calls.log");
        match std::fs::read_to_string(&p) {
            Ok(text) => {
                std::fs::remove_file(&p).unwrap();
                Value::String(self.norm(&text))
            }
            Err(_) => Value::Null,
        }
    }

    fn assert_safe(&self) {
        let ir = std::env::var("CLAUDIUS_INSTALL_ROOT").unwrap();
        assert_eq!(ir, self.p("current"));
        let real = std::fs::canonicalize(&ir).unwrap();
        assert!(
            real.starts_with(&self.root) && real != Path::new(&self.root),
            "install root {ir} resolves to {} outside {}",
            real.display(),
            self.root
        );
    }

    /// A world op (`strict`: its recorded `fails` must hold).
    fn op(&self, s: &Value, strict: bool) {
        let path = s["path"].as_str().map(|p| self.p(p));
        match s["op"].as_str().unwrap() {
            "git" => {
                let args: Vec<String> = s["args"]
                    .as_array()
                    .unwrap()
                    .iter()
                    .map(|a| a.as_str().unwrap().replace("$ROOT", &self.root))
                    .collect();
                let status = Command::new(&self.real_git)
                    .args(&args)
                    .current_dir(self.p(s["cwd"].as_str().unwrap()))
                    .env_clear()
                    .envs(self.env.iter().map(|(k, v)| (k, v)))
                    .stdout(Stdio::null())
                    .stderr(Stdio::null())
                    .status()
                    .unwrap();
                if strict {
                    assert_eq!(!status.success(), s["fails"] == true, "git {args:?}");
                }
            }
            "write" => {
                let path = path.unwrap();
                std::fs::create_dir_all(Path::new(&path).parent().unwrap()).unwrap();
                let text = js_string::lossy(s["text"].as_str().unwrap()).into_owned();
                std::fs::write(&path, text).unwrap();
            }
            "begin" => {}
            "rm" => {
                let path = path.unwrap();
                match std::fs::symlink_metadata(&path) {
                    Ok(m) if m.is_dir() => std::fs::remove_dir_all(&path).unwrap(),
                    Ok(_) => std::fs::remove_file(&path).unwrap(),
                    Err(_) => {}
                }
            }
            "mkdir" => std::fs::create_dir_all(path.unwrap()).unwrap(),
            "link" => {
                let path = path.unwrap();
                let _ = std::fs::remove_file(&path);
                std::fs::create_dir_all(Path::new(&path).parent().unwrap()).unwrap();
                let to = s["to"].as_str().unwrap().replace("$ROOT", &self.root);
                std::os::unix::fs::symlink(to, &path).unwrap();
            }
            "chmod" => {
                use std::os::unix::fs::PermissionsExt;
                let mode = u32::from_str_radix(s["mode"].as_str().unwrap(), 8).unwrap();
                std::fs::set_permissions(path.unwrap(), std::fs::Permissions::from_mode(mode))
                    .unwrap();
            }
            op => panic!("unknown op {op}"),
        }
    }
}

fn which(path: &str, cmd: &str) -> Option<String> {
    let out = Command::new("/bin/sh")
        .args(["-c", &format!("command -v {cmd}")])
        .env_clear()
        .env("PATH", path)
        .output()
        .unwrap();
    let found = String::from_utf8_lossy(&out.stdout).trim().to_owned();
    (out.status.success() && !found.is_empty()).then_some(found)
}

fn source(s: &str) -> Source {
    match s {
        "boot" => Source::Boot,
        "daily" => Source::Daily,
        "manual" => Source::Manual,
        s => panic!("source {s}"),
    }
}

/// A scheduler on fake timers whose launcher only records.
fn scheduler() -> (Arc<UpdaterScheduler>, Arc<FakeTimers>) {
    let timers = Arc::new(FakeTimers::default());
    let events = timers.events.clone();
    let sched = UpdaterScheduler::with_launcher(
        timers.clone(),
        Arc::new(move |opts| -> SharedApply {
            assert!(!opts.allow_cc_merge, "a tick never allows the merge");
            assert_eq!(opts.claude_bin.as_deref(), Some(Path::new("/x/claude")));
            events.lock().unwrap().push(json!("apply"));
            futures::future::ready(Ok(ApplyOutcome::NoUpdate))
                .boxed()
                .shared()
        }),
    );
    sched.set_apply_options(ApplyOptions {
        allow_cc_merge: true,
        claude_bin: Some(PathBuf::from("/x/claude")),
    });
    (sched, timers)
}

fn pure(fx: &Value) {
    let mut n = 0;
    for c in fx["pure"]["pick"].as_array().unwrap() {
        let got = apply::pick_strategy(
            c["mode"].as_str().unwrap(),
            &c["pending"],
            c["override"] == true,
        );
        let got = match &got {
            Strategy::Skip(reason) => json!({"kind": "skip", "reason": reason}),
            s => json!({"kind": s.kind()}),
        };
        assert_eq!(got, c["got"], "pickStrategy {c}");
        n += 1;
    }
    assert_eq!(n, 4 * 7 * 2);
    for c in fx["pure"]["bunEnv"].as_array().unwrap() {
        let phase = match c["phase"].as_str().unwrap() {
            "install" => Phase::Install,
            _ => Phase::Build,
        };
        let got: Vec<Value> = apply::env_for_bun_phase(phase)
            .into_iter()
            .map(|(k, v)| json!([k, v]))
            .collect();
        assert_eq!(Value::Array(got), c["got"], "envForBunPhase {}", c["phase"]);
    }
}

#[tokio::test]
async fn updater_scheduler_replays_the_ts_golden() {
    let fx = fixture();
    pure(&fx);

    let tmp = tempfile::tempdir().unwrap();
    let root = tmp
        .path()
        .canonicalize()
        .unwrap()
        .to_string_lossy()
        .into_owned();
    let temp_dir = std::env::temp_dir().canonicalize().unwrap();
    assert!(Path::new(&root).starts_with(&temp_dir), "{root}");
    let strs = |k: &str| -> Vec<String> {
        fx[k]
            .as_array()
            .unwrap()
            .iter()
            .map(|v| v.as_str().unwrap().to_owned())
            .collect()
    };
    let base = [strs("sys"), strs("abs")].concat().join(":");
    let real_git = which(&base, "git").expect("no git on the base PATH");
    let mut env: Vec<(String, String)> = fx["env"]
        .as_object()
        .unwrap()
        .iter()
        .map(|(k, v)| (k.clone(), v.as_str().unwrap().replace("$ROOT", &root)))
        .collect();
    env.push(("PATH".into(), format!("{root}/xbin:{base}")));
    env.push(("REAL_GIT".into(), real_git.clone()));
    // SAFETY: this test binary's only test; nothing else reads the env.
    unsafe {
        for (k, v) in &env {
            std::env::set_var(k, v);
        }
        std::env::set_var("CLAUDIUS_INSTALL_ROOT", format!("{root}/current"));
        std::env::remove_var("CLAUDIUS_LIVE_SOURCE");
    }
    assert!(paths::set_home_override(PathBuf::from(format!(
        "{root}/home"
    ))));
    let world = World {
        root,
        env,
        real_git,
        t_start: now_ms(),
    };
    for d in ["home", "servercwd", "xbin"] {
        std::fs::create_dir_all(world.p(d)).unwrap();
    }
    // The world the apply phase built: upstream, the seed and the fakes.
    // Its requests aren't sent, and its install clones aren't made.
    let in_clone = |p: &str| {
        p.starts_with("current/")
            || (p.starts_with('i') && p[1..].starts_with(|c: char| c.is_ascii_digit()))
    };
    let install_git = |s: &Value| {
        (s["op"] == "git" && (s["args"][0] == "clone" || s["cwd"].as_str().is_some_and(in_clone)))
            || s["path"].as_str().is_some_and(in_clone)
    };
    for phase in fx["phases"].as_array().unwrap() {
        for s in phase["steps"].as_array().unwrap() {
            if !matches!(s["op"].as_str(), Some("req" | "together")) && !install_git(s) {
                world.op(s, true);
            }
        }
    }
    let _ = std::fs::remove_file(world.p("home/.bun/bin/calls.log"));

    let is_root = Command::new("id")
        .arg("-u")
        .output()
        .map(|o| String::from_utf8_lossy(&o.stdout).trim() == "0")
        .unwrap_or(false);
    let mut failures = vec![];
    let mut steps = 0;
    for case in fx["scheduler"].as_array().unwrap() {
        let label = case["label"].as_str().unwrap();
        let (sched, timers) = scheduler();
        for (i, s) in case["steps"].as_array().unwrap().iter().enumerate() {
            let op = s["op"].as_str().unwrap();
            if !matches!(op, "boot" | "tick" | "fire" | "race") {
                world.op(s, true);
                continue;
            }
            if s["nonRoot"] == true && is_root {
                continue;
            }
            world.assert_safe();
            steps += 1;
            let mut check = Value::Null;
            match op {
                "boot" => sched.boot_with(s["mirror"] == true, s["disabled"].as_str()),
                "tick" => sched.tick(source(s["source"].as_str().unwrap())).await,
                "fire" => {
                    let k = s["timer"].as_u64().unwrap() as usize;
                    let fire = timers.fires.lock().unwrap()[k].take().expect("fired twice");
                    fire.await;
                }
                _ => {
                    let c = detect::check_for_updates();
                    sched.tick(Source::Manual).await;
                    check = c.await.unwrap().to_json();
                }
            }
            let events = Value::Array(std::mem::take(&mut *timers.events.lock().unwrap()));
            let file = world.file_state();
            let calls = world.take_calls();
            let at = format!("{label} #{i} ({op})");
            if events != s["events"] {
                failures.push(format!("{at}: events {events}, want {}", s["events"]));
            }
            let want_file = match &s["file"] {
                Value::String(t) => Value::String(want_fixture(t)),
                v => v.clone(),
            };
            if file != want_file {
                failures.push(format!(
                    "{at}: updater.json\n got: {file}\nwant: {want_file}"
                ));
            }
            let want_calls = match &s["calls"] {
                Value::String(t) => Value::String(want_fixture(t)),
                v => v.clone(),
            };
            if calls != want_calls {
                failures.push(format!("{at}: calls\n got: {calls}\nwant: {want_calls}"));
            }
            if op == "race" {
                let check = Value::String(world.norm(&check.to_string()));
                let want = Value::String(s["check"].to_string());
                if check != want {
                    failures.push(format!("{at}: check {check}, want {want}"));
                }
            }
        }
    }
    assert!(steps >= 25, "only {steps} scheduler steps");
    assert!(failures.is_empty(), "{}", failures.join("\n"));

    // `boot()` reads `$CLAUDIUS_UPDATER_DISABLED` itself.
    for (disabled, want) in [("1", json!([])), ("0", json!([{"set": 5000}]))] {
        // SAFETY: as above.
        unsafe { std::env::set_var("CLAUDIUS_UPDATER_DISABLED", disabled) };
        let (sched, timers) = scheduler();
        sched.boot();
        sched.boot();
        let events = Value::Array(std::mem::take(&mut *timers.events.lock().unwrap()));
        assert_eq!(events, want, "boot() with DISABLED={disabled}");
    }
    unsafe { std::env::set_var("CLAUDIUS_UPDATER_DISABLED", "1") };
}
