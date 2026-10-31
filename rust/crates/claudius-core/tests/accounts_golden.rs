//! Replays `fixtures/accounts_golden.json`, recorded by
//! `rust/scripts/accounts-golden.mjs` from the real TS: the account store
//! (`lib/server/accounts-store.ts`), the profile lookup
//! (`lib/server/account-profile.ts`) with a scripted `fetch`, the global
//! config reader (`lib/server/claude-global-config.ts`), the Bedrock helpers
//! of `lib/shared/accounts.ts` and `shouldWarnTokenExpiring`.
//!
//! Each store case rebuilds its world under a temp dir (`$W`), runs the same
//! steps through `claudius_core::accounts` / `account_profile` with the
//! recorder's clock and random bytes, and compares every result as
//! `JSON.stringify` text (or the thrown message), every fetch, and the whole
//! world tree (types, modes, file bytes, link targets) after each step.
//! All tokens are fake; nothing outside the temp dirs is touched.
#![cfg(unix)]

use std::collections::{BTreeMap, VecDeque};
use std::os::unix::fs::PermissionsExt;
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicI64, AtomicUsize, Ordering};
use std::sync::{Arc, Mutex, OnceLock};

use claudius_agent::js;
use claudius_core::account_profile::{FetchResponse, ProfileFetch, ProfileInfoResolver};
use claudius_core::accounts::{
    self, AccountKind, AccountMetadata, AccountProfile, AccountsStore, NewAccount,
};
use claudius_core::claude_global_config::{ClaudeGlobalConfig, config_path_for};
use futures::future::BoxFuture;
use serde_json::{Map, Value, json};

fn fixture() -> &'static Value {
    static F: OnceLock<Value> = OnceLock::new();
    F.get_or_init(|| {
        let path =
            PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("tests/fixtures/accounts_golden.json");
        serde_json::from_str(&std::fs::read_to_string(path).unwrap()).unwrap()
    })
}

/// Where Rust knowingly differs: in case `name`, every expected string of the
/// steps (each result, message, file text and link target, not the world the
/// case starts from) reads with `from` replaced by `to`.
const REPLACE: &[(&str, &str, &str, &str)] = &[
    (
        "foreign: a lone surrogate escape",
        "\\ud800",
        "\u{fffd}",
        "js::json_parse reads a lone-surrogate escape as U+FFFD, so the label (and the rewritten file) holds U+FFFD where TS keeps the surrogate and writes its escape back",
    ),
    (
        "foreign: unicode labels and secrets",
        "\\ude00cde",
        "\u{fffd}cde",
        "the 4-unit secret preview cuts a surrogate pair; a Rust string can't hold the lone half, which prints as U+FFFD",
    ),
];

/// Where Rust deliberately keeps what TS deletes: in case `name`, the Rust
/// tree after every step is the TS tree plus these paths.
const TREE_KEEPS: &[(&str, &[&str], &str)] = &[(
    "delete an id that names the profiles directory",
    &[
        "acc/profiles",
        "acc/profiles/acc_oauth",
        "acc/profiles/acc_oauth/.credentials.json",
    ],
    "an id of \"\" names `<dir>/profiles` itself; TS `rm -rf`s every profile's config dir, Rust only removes a dir strictly inside it",
)];

/// Cases replayed with their own expectations (see `divergent`).
const DIVERGENT: &[(&str, &str)] = &[
    (
        "foreign: nested 200 deep",
        "serde_json stops at 128 levels of nesting, so the file doesn't load: every call errors, nothing is written",
    ),
    (
        "info: a 200 body that is a huge number",
        "js::json_parse reads 1e400 as null, so `email ?? stored` falls back to the stored email and nothing is backfilled; TS keeps Infinity, answers `email: null` and writes `emailAddress: null`",
    ),
    (
        "delete an id that climbs out",
        "an id of \"..\" names the store dir itself; TS `rm -rf`s it (accounts.json included), Rust leaves the disk alone",
    ),
    (
        "env: an id that climbs out",
        "an id of \"..\" would make the store dir the profile's config dir; TS provisions it, Rust refuses",
    ),
];

// ---- the recorder's determinism ------------------------------------------------

/// Byte i of call n is `(n * 37 + i * 11 + 5) & 255`.
fn counter_random(calls: Arc<AtomicUsize>) -> accounts::Random {
    Arc::new(move |buf: &mut [u8]| {
        let n = calls.fetch_add(1, Ordering::SeqCst);
        for (i, b) in buf.iter_mut().enumerate() {
            *b = ((n * 37 + i * 11 + 5) & 0xff) as u8;
        }
    })
}

fn set_umask() {
    static ONCE: OnceLock<()> = OnceLock::new();
    ONCE.get_or_init(|| unsafe {
        libc::umask(0o022);
    });
}

// ---- worlds -------------------------------------------------------------------

struct World {
    _dir: tempfile::TempDir,
    w: String,
}

impl World {
    fn new() -> World {
        set_umask();
        let dir = tempfile::tempdir().unwrap();
        let w = dir.path().canonicalize().unwrap().display().to_string();
        World { _dir: dir, w }
    }

    fn fill(&self, v: &Value) -> Value {
        serde_json::from_str(&v.to_string().replace("$W", &self.w)).unwrap()
    }

    /// Recorder `sub`: the world and the pid as placeholders.
    fn sub(&self, s: &str) -> String {
        s.replace(&self.w, "$W")
            .replace(&format!(".{}.", std::process::id()), ".$PID.")
    }

    fn build(&self, files: &Value) {
        let files = self.fill(files);
        let Some(entries) = files.as_object() else {
            return;
        };
        for (rel, spec) in entries {
            let p = format!("{}/{rel}", self.w);
            if spec["delete"] == true {
                unlock(Path::new(&p));
                let _ = std::fs::remove_dir_all(&p).or_else(|_| std::fs::remove_file(&p));
                continue;
            }
            std::fs::create_dir_all(Path::new(&p).parent().unwrap()).unwrap();
            if spec["dir"] == true {
                std::fs::create_dir_all(&p).unwrap();
            } else if let Some(target) = spec["symlink"].as_str() {
                std::os::unix::fs::symlink(target, &p).unwrap();
            } else if let Some(h) = spec["hex"].as_str() {
                std::fs::write(&p, hex(h)).unwrap();
            } else if let Some(t) = spec["text"].as_str() {
                std::fs::write(&p, t).unwrap();
            }
        }
        for (rel, spec) in entries.iter().rev() {
            if let Some(m) = spec["mode"].as_str()
                && spec["delete"] != true
            {
                let mode = u32::from_str_radix(m, 8).unwrap();
                std::fs::set_permissions(
                    format!("{}/{rel}", self.w),
                    std::fs::Permissions::from_mode(mode),
                )
                .unwrap();
            }
        }
    }

    /// The recorder's `tree`.
    fn tree(&self) -> BTreeMap<String, Value> {
        let mut out = BTreeMap::new();
        self.walk("", &mut out);
        out
    }

    fn walk(&self, rel: &str, out: &mut BTreeMap<String, Value>) {
        let dir = if rel.is_empty() {
            self.w.clone()
        } else {
            format!("{}/{rel}", self.w)
        };
        let Ok(rd) = std::fs::read_dir(&dir) else {
            return;
        };
        let mut names: Vec<String> = rd
            .map(|e| e.unwrap().file_name().to_string_lossy().into_owned())
            .collect();
        names.sort();
        for name in names {
            let r = if rel.is_empty() {
                name
            } else {
                format!("{rel}/{name}")
            };
            let full = format!("{}/{r}", self.w);
            let st = std::fs::symlink_metadata(&full).unwrap();
            let m = format!("{:o}", st.permissions().mode() & 0o777);
            if st.file_type().is_symlink() {
                let to = std::fs::read_link(&full).unwrap().display().to_string();
                out.insert(r, json!({"t": "l", "to": self.sub(&to)}));
            } else if st.is_dir() {
                out.insert(r.clone(), json!({"t": "d", "m": m}));
                self.walk(&r, out);
            } else {
                let entry = match std::fs::read(&full) {
                    Err(_) => json!({"t": "f", "m": m}),
                    Ok(b) => match String::from_utf8(b) {
                        Ok(x) => json!({"t": "f", "m": m, "x": x}),
                        Err(e) => {
                            let h: String =
                                e.as_bytes().iter().map(|b| format!("{b:02x}")).collect();
                            json!({"t": "f", "m": m, "h": h})
                        }
                    },
                };
                out.insert(r, entry);
            }
        }
    }
}

impl Drop for World {
    fn drop(&mut self) {
        unlock(Path::new(&self.w));
    }
}

/// Make everything deletable again.
fn unlock(p: &Path) {
    let Ok(st) = std::fs::symlink_metadata(p) else {
        return;
    };
    if st.file_type().is_symlink() {
        return;
    }
    let mode = if st.is_dir() { 0o700 } else { 0o600 };
    let _ = std::fs::set_permissions(p, std::fs::Permissions::from_mode(mode));
    if st.is_dir()
        && let Ok(rd) = std::fs::read_dir(p)
    {
        for e in rd.flatten() {
            unlock(&e.path());
        }
    }
}

fn hex(s: &str) -> Vec<u8> {
    (0..s.len())
        .step_by(2)
        .map(|i| u8::from_str_radix(&s[i..i + 2], 16).unwrap())
        .collect()
}

// ---- the scripted fetch ---------------------------------------------------------

#[derive(Default)]
struct Scripted {
    queue: Mutex<VecDeque<Value>>,
    calls: Mutex<Vec<Value>>,
}

impl ProfileFetch for Scripted {
    fn get<'a>(
        &'a self,
        url: &'a str,
        headers: &'a [(String, String)],
    ) -> BoxFuture<'a, Result<FetchResponse, String>> {
        let h: Map<String, Value> = headers
            .iter()
            .map(|(k, v)| (k.clone(), Value::String(v.clone())))
            .collect();
        self.calls
            .lock()
            .unwrap()
            .push(json!({"url": url, "method": "GET", "headers": h}));
        let next = self
            .queue
            .lock()
            .unwrap()
            .pop_front()
            .expect("unscripted fetch");
        Box::pin(async move {
            if let Some(m) = next["throws"].as_str() {
                return Err(m.to_owned());
            }
            let body = match (next["hex"].as_str(), next["body"].as_str()) {
                (Some(h), _) => hex(h),
                (None, Some(b)) => b.as_bytes().to_vec(),
                _ => Vec::new(),
            };
            Ok(FetchResponse {
                status: next["status"].as_u64().unwrap() as u16,
                body,
            })
        })
    }
}

// ---- inputs ---------------------------------------------------------------------

/// A JS number from the fixture (`{"$num": "NaN"}` for the ones JSON lacks);
/// `None` for anything else (`typeof !== "number"`).
fn js_number(v: Option<&Value>) -> Option<f64> {
    match v? {
        Value::Number(n) => n.as_f64(),
        Value::Object(o) => match o.get("$num")?.as_str()? {
            "NaN" => Some(f64::NAN),
            "Infinity" => Some(f64::INFINITY),
            "-Infinity" => Some(f64::NEG_INFINITY),
            "-0" => Some(-0.0),
            other => panic!("unknown $num {other}"),
        },
        _ => None,
    }
}

fn new_account(input: &Value) -> NewAccount {
    let g = |k: &str| input.get(k).cloned();
    NewAccount {
        label: g("label"),
        kind: g("kind"),
        secret: g("secret"),
        bedrock: g("bedrock"),
        account_uuid: g("accountUuid"),
        email_address: g("emailAddress"),
        organization_uuid: g("organizationUuid"),
        subscription_type: g("subscriptionType"),
        expires_at: js_number(input.get("expiresAt")),
    }
}

fn metadata(meta: &Value) -> AccountMetadata {
    let g = |k: &str| meta.get(k).cloned();
    AccountMetadata {
        account_uuid: g("accountUuid"),
        email_address: g("emailAddress"),
        organization_uuid: g("organizationUuid"),
        subscription_type: g("subscriptionType"),
    }
}

fn env_vars(env: &std::collections::HashMap<String, String>) -> Value {
    let sorted: BTreeMap<&String, &String> = env.iter().collect();
    json!(sorted)
}

// ---- a case ---------------------------------------------------------------------

struct Run {
    world: World,
    store: AccountsStore,
    global: Arc<ClaudeGlobalConfig>,
    fetch: Arc<Scripted>,
    resolver: ProfileInfoResolver,
    clock: Arc<AtomicI64>,
    world_env: Map<String, Value>,
    added: Vec<String>,
}

/// What a step did: its `JSON.stringify` text or thrown message, and the
/// fetches it made.
struct Outcome {
    out: Result<String, String>,
    fetches: Option<(Value, usize)>,
}

impl Run {
    fn new(c: &Value) -> Run {
        let world = World::new();
        let clock = Arc::new(AtomicI64::new(fixture()["t0"].as_i64().unwrap()));
        let calls = Arc::new(AtomicUsize::new(0));
        let mut world_env = Map::new();
        world_env.insert("HOME".into(), format!("{}/home", world.w).into());
        for (k, v) in world.fill(&c["env"]).as_object().unwrap() {
            world_env.insert(k.clone(), v.clone());
        }
        let env = |k: &str| world_env.get(k).and_then(Value::as_str);
        let home = env("HOME").unwrap().to_owned();
        let now: accounts::Clock = {
            let clock = clock.clone();
            Arc::new(move || clock.load(Ordering::SeqCst))
        };
        let store = AccountsStore::new(
            accounts::accounts_dir_for(env(accounts::ACCOUNTS_DIR_ENV), &home),
            &home,
        )
        .with_clock(now.clone())
        .with_random(counter_random(calls));
        let global = Arc::new(
            ClaudeGlobalConfig::new(config_path_for(env("CLAUDIUS_CLAUDE_CONFIG_PATH"), &home))
                .with_clock(now.clone()),
        );
        let fetch = Arc::new(Scripted::default());
        let resolver =
            ProfileInfoResolver::new(store.clone(), global.clone(), fetch.clone()).with_clock(now);
        world.build(&c["files"]);
        Run {
            world,
            store,
            global,
            fetch,
            resolver,
            clock,
            world_env,
            added: Vec::new(),
        }
    }

    fn step(&mut self, step: &Value) -> Outcome {
        let id = match step["added"].as_u64() {
            Some(i) => self.added[i as usize].clone(),
            None => step["id"].as_str().unwrap_or_default().to_owned(),
        };
        let text = |v: Value| self.world.sub(&js::stringify(&v));
        let profile_text =
            |p: Option<AccountProfile>| text(p.map_or(Value::Null, |p| p.to_value()));
        let mut fetches = None;
        let out: Result<String, String> = match step["op"].as_str().unwrap() {
            "read" => self
                .store
                .read_raw()
                .map(|s| text(s.to_value()))
                .map_err(|e| e.0),
            "public" => self.store.read_public().map(text).map_err(|e| e.0),
            "active" => self
                .store
                .get_active_profile()
                .map(profile_text)
                .map_err(|e| e.0),
            "byId" => self
                .store
                .get_profile_by_id(&id)
                .map(profile_text)
                .map_err(|e| e.0),
            "add" => match self.store.add_account(&new_account(&step["input"])) {
                Ok((state, profile)) => {
                    self.added.push(profile.id().to_owned());
                    Ok(text(
                        json!({"state": state.to_value(), "profile": profile.to_value()}),
                    ))
                }
                Err(e) => Err(e.0),
            },
            "autoRotate" => self
                .store
                .set_auto_rotate(step["on"].as_bool().unwrap())
                .map(|s| text(s.to_value()))
                .map_err(|e| e.0),
            "meta" => self
                .store
                .update_account_metadata(&id, &metadata(&step["meta"]))
                .map(|()| "null".to_owned())
                .map_err(|e| e.0),
            "rotate" => self
                .store
                .rotate_to_next_profile()
                .map(|r| text(r.map_or(Value::Null, |r| json!({"from": r.from, "to": r.to}))))
                .map_err(|e| e.0),
            "activate" => self
                .store
                .set_active_account(&id)
                .map(|s| text(s.to_value()))
                .map_err(|e| e.0),
            "delete" => self
                .store
                .delete_account(&id)
                .map(|s| text(s.to_value()))
                .map_err(|e| e.0),
            "env" => {
                let profile = self
                    .store
                    .get_profile_by_id(&id)
                    .unwrap()
                    .expect("a stored profile");
                let mut base = std::collections::HashMap::new();
                for (k, v) in self.world_env.iter().chain(
                    self.world
                        .fill(&step["env"])
                        .as_object()
                        .unwrap_or(&Map::new()),
                ) {
                    base.insert(k.clone(), v.as_str().unwrap().to_owned());
                }
                self.store
                    .build_env_for_profile_from(&profile, base)
                    .map(|env| self.world.sub(&js::stringify(&env_vars(&env))))
                    .map_err(|e| e.0)
            }
            "info" => {
                *self.fetch.queue.lock().unwrap() =
                    step["fetch"].as_array().cloned().unwrap_or_default().into();
                self.fetch.calls.lock().unwrap().clear();
                let r = futures::executor::block_on(
                    self.resolver
                        .get_profile_info_for_account(&id, step["skipCache"] == true),
                );
                let calls = Value::Array(self.fetch.calls.lock().unwrap().clone());
                fetches = Some((
                    self.world
                        .fill(&serde_json::from_str(&self.world.sub(&calls.to_string())).unwrap()),
                    self.fetch.queue.lock().unwrap().len(),
                ));
                r.map(|v| text(v.unwrap_or(Value::Null))).map_err(|e| e.0)
            }
            "invalidate" => {
                self.resolver.invalidate_profile_cache(step["id"].as_str());
                Ok("null".into())
            }
            "global" => Ok(text(
                self.global
                    .read_oauth_account(step["skipCache"] == true)
                    .map_or(Value::Null, Value::Object),
            )),
            "advance" => {
                self.clock
                    .fetch_add(step["ms"].as_i64().unwrap(), Ordering::SeqCst);
                Ok("null".into())
            }
            "files" => {
                self.world.build(&step["files"]);
                Ok("null".into())
            }
            op => panic!("unknown op {op}"),
        };
        Outcome {
            out: out
                .map(|s| self.world.sub(&s))
                .map_err(|s| self.world.sub(&s)),
            fetches,
        }
    }
}

fn expected(step: &Value) -> Result<String, String> {
    match step["out"].as_str() {
        Some(o) => Ok(o.to_owned()),
        None => Err(step["throws"].as_str().unwrap().to_owned()),
    }
}

/// An `env` result is recorded as `{vars, types}`: every defined value as
/// `String(v)` (what `spawn` hands the child) and the `typeof` of the ones
/// that weren't strings. Rust builds the strings directly, so only `vars`
/// is compared.
fn expected_vars(step: &Value) -> Result<String, String> {
    expected(step).map(|o| {
        let v: Value = serde_json::from_str(&o).unwrap();
        js::stringify(&v["vars"])
    })
}

fn replace_all(v: &Value, from: &str, to: &str) -> Value {
    match v {
        Value::String(s) => Value::String(s.replace(from, to)),
        Value::Array(a) => Value::Array(a.iter().map(|x| replace_all(x, from, to)).collect()),
        Value::Object(o) => Value::Object(
            o.iter()
                .map(|(k, x)| (k.clone(), replace_all(x, from, to)))
                .collect(),
        ),
        other => other.clone(),
    }
}

fn tree_of(v: &Value) -> BTreeMap<String, Value> {
    v.as_object()
        .unwrap()
        .iter()
        .map(|(k, v)| (k.clone(), v.clone()))
        .collect()
}

#[test]
fn store_cases_match_the_ts() {
    let cases = fixture()["store"].as_array().unwrap();
    assert!(cases.len() > 90, "the fixture lost its cases");
    let mut compared = 0;
    for c in cases {
        let name = c["name"].as_str().unwrap();
        if DIVERGENT.iter().any(|(n, _)| *n == name) {
            continue;
        }
        let mut c = c.clone();
        for (_, from, to, _) in REPLACE.iter().filter(|(n, ..)| *n == name) {
            c["steps"] = replace_all(&c["steps"], from, to);
        }
        let keeps: &[&str] = TREE_KEEPS
            .iter()
            .find(|(n, ..)| *n == name)
            .map_or(&[], |(_, k, _)| k);
        let mut run = Run::new(&c);
        assert_eq!(
            run.world.sub(run.store.dir()),
            c["dir"].as_str().unwrap(),
            "{name}: accountsDir()"
        );
        let mut want_tree = tree_of(&c["start"]);
        assert_eq!(run.world.tree(), want_tree, "{name}: the world as built");
        for (i, step) in c["steps"].as_array().unwrap().iter().enumerate() {
            let got = run.step(step);
            let op = step["op"].as_str().unwrap();
            let want = if op == "env" {
                expected_vars(step)
            } else {
                expected(step)
            };
            assert_eq!(got.out, want, "{name} #{i} {op}");
            if let Some((calls, unused)) = got.fetches {
                assert_eq!(calls, step["fetches"], "{name} #{i}: fetches");
                assert_eq!(
                    unused as u64,
                    step["unused"].as_u64().unwrap(),
                    "{name} #{i}: unused responses"
                );
            }
            if let Some(t) = step.get("tree") {
                want_tree = tree_of(t);
            }
            let mut tree = run.world.tree();
            for k in keeps {
                assert!(
                    tree.remove(*k).is_some(),
                    "{name} #{i}: Rust should keep {k}"
                );
            }
            assert_eq!(tree, want_tree, "{name} #{i} {op}: the world afterwards");
            compared += 1;
        }
    }
    assert!(compared > 400, "only {compared} steps compared");
}

/// The [`DIVERGENT`] cases, each with what Rust does instead.
#[test]
fn divergent_cases() {
    let cases = fixture()["store"].as_array().unwrap();
    let case = |name: &str| {
        cases
            .iter()
            .find(|c| c["name"] == name)
            .unwrap_or_else(|| panic!("no case {name}"))
    };
    for (name, _) in DIVERGENT {
        let c = case(name);
        let mut run = Run::new(c);
        let start = run.world.tree();
        assert_eq!(start, tree_of(&c["start"]), "{name}: the world as built");
        let steps = c["steps"].as_array().unwrap();
        match *name {
            "foreign: nested 200 deep" => {
                for step in steps {
                    let err = run.step(step).out.unwrap_err();
                    assert!(err.contains("recursion limit exceeded"), "{name}: {err}");
                    assert_eq!(run.world.tree(), start, "{name}: nothing written");
                }
            }
            "info: a 200 body that is a huge number" => {
                let want = steps[0]["out"]
                    .as_str()
                    .unwrap()
                    .replace("\"email\":null", "\"email\":\"stored@example.com\"");
                for step in &steps[..2] {
                    assert_eq!(run.step(step).out.unwrap(), want, "{name}");
                    assert_eq!(run.world.tree(), start, "{name}: no backfill");
                }
                let read = run.step(&steps[2]).out.unwrap();
                assert!(
                    read.contains("\"emailAddress\":\"stored@example.com\""),
                    "{read}"
                );
            }
            "delete an id that climbs out" => {
                let state = run.step(&steps[0]).out.unwrap();
                assert_eq!(
                    state,
                    steps[0]["out"].as_str().unwrap(),
                    "{name}: the state"
                );
                let tree = run.world.tree();
                assert_eq!(
                    tree["acc/keep.txt"]["x"], "keep",
                    "{name}: the store dir stays"
                );
                assert_eq!(
                    run.step(&steps[1]).out.unwrap(),
                    state,
                    "{name}: the store reads back"
                );
            }
            "env: an id that climbs out" => {
                let err = run.step(&steps[0]).out.unwrap_err();
                assert_eq!(err, "profile id escapes the profiles directory");
                assert_eq!(run.world.tree(), start, "{name}: nothing provisioned");
            }
            other => panic!("no expectations for {other}"),
        }
    }
}

/// The deliberate difference (see `accounts`' module docs): an id whose
/// config dir isn't strictly inside `<dir>/profiles/` is never provisioned,
/// and deleting it leaves the disk alone. The recorded `""` and `..` cases
/// are in [`TREE_KEEPS`] / [`DIVERGENT`]; these are the other shapes.
#[test]
fn ids_outside_the_profiles_dir_are_refused() {
    let world = World::new();
    let dir = format!("{}/acc", world.w);
    let home = format!("{}/home", world.w);
    let bad = [
        "",
        ".",
        "..",
        "./",
        "/",
        "//",
        "a/..",
        "../x",
        "../profilesX",
        "a/../..",
        "x/../../acc",
    ];
    let profile = |id: &str| json!({"id": id, "label": "L", "kind": "oauth-token", "secret": "sk-ant-oat01-FAKE-guard", "createdAt": "c"});
    let mut files = Map::new();
    files.insert("home/.claude/settings.json".into(), json!({"text": "{}"}));
    for keep in [
        "acc/profiles/keep",
        "acc/profilesX/keep",
        "acc/x/keep",
        "acc/acc/keep",
    ] {
        files.insert(keep.into(), json!({"text": "keep"}));
    }
    let state = json!({"profiles": bad.iter().map(|id| profile(id)).collect::<Vec<_>>()});
    files.insert(
        "acc/accounts.json".into(),
        json!({"text": state.to_string()}),
    );
    world.build(&Value::Object(files));
    let store = AccountsStore::new(dir.as_str(), home.as_str());
    let before = world.tree();
    for id in bad {
        let p = AccountProfile::from_value(&profile(id)).unwrap();
        let err = store
            .build_env_for_profile_from(&p, std::collections::HashMap::new())
            .unwrap_err();
        assert_eq!(err.0, "profile id escapes the profiles directory", "{id:?}");
        assert_eq!(world.tree(), before, "{id:?}: nothing provisioned");
    }
    for id in bad {
        store.delete_account(id).unwrap();
    }
    let mut after = world.tree();
    let mut want = before.clone();
    for t in [&mut after, &mut want] {
        t.remove("acc/accounts.json");
    }
    assert_eq!(after, want, "the deletes removed nothing but profiles");
    assert_eq!(store.read_raw().unwrap().profiles.len(), 0);
    // A nested id is inside, and provisions as TS does.
    let nested = AccountProfile::from_value(&profile("team/a")).unwrap();
    let env = store
        .build_env_for_profile_from(&nested, std::collections::HashMap::new())
        .unwrap();
    assert_eq!(env["CLAUDE_CONFIG_DIR"], format!("{dir}/profiles/team/a"));
    assert_eq!(
        world.tree()["acc/profiles/team/a/settings.json"],
        json!({"t": "l", "to": "$W/home/.claude/settings.json"})
    );
}

#[test]
fn listed_differences_still_differ() {
    // A REPLACE / TREE_KEEPS entry whose case no longer contains the TS text
    // it rewrites is stale.
    let cases = fixture()["store"].as_array().unwrap();
    for (name, from, to, _) in REPLACE {
        let c = cases.iter().find(|c| c["name"] == *name).unwrap();
        assert_ne!(
            replace_all(&c["steps"], from, to),
            c["steps"],
            "{name}: stale REPLACE"
        );
    }
    for (name, keeps, _) in TREE_KEEPS {
        let c = cases.iter().find(|c| c["name"] == *name).unwrap();
        let last = c["steps"]
            .as_array()
            .unwrap()
            .iter()
            .rev()
            .find_map(|s| s.get("tree"))
            .unwrap();
        for k in *keeps {
            assert!(
                last.get(*k).is_none(),
                "{name}: TS keeps {k} too, stale TREE_KEEPS"
            );
        }
    }
}

// ---- pure functions -----------------------------------------------------------

fn pure(key: &str) -> &'static Vec<Value> {
    fixture()["pure"][key].as_array().unwrap()
}

#[test]
fn normalize_bedrock_config_matches() {
    for c in pure("normalize") {
        let input = (c["input"] != json!({"$undefined": true})).then_some(&c["input"]);
        let got = accounts::normalize_bedrock_config(input, c["secret"].as_str().unwrap())
            .map(|m| js::stringify(&Value::Object(m)))
            .map_err(|e| e.0);
        assert_eq!(got, expected(c), "{c}");
    }
}

#[test]
fn describe_bedrock_config_matches() {
    for c in pure("describe") {
        let got = accounts::describe_bedrock_config(c["cfg"].as_object().unwrap())
            .map(|s| js::stringify(&Value::String(s)))
            .map_err(|e| e.0);
        assert_eq!(got, expected(c), "{c}");
    }
}

#[test]
fn to_public_matches() {
    for c in pure("toPublic") {
        let p = AccountProfile::from_value(&c["profile"]).expect("a stored-shape profile");
        let got = p.to_public().map(|v| js::stringify(&v)).map_err(|e| e.0);
        assert_eq!(got, expected(c), "{c}");
    }
}

#[test]
fn small_predicates_match() {
    for c in pure("kind") {
        assert_eq!(
            AccountKind::from_value(&c["value"]).is_some(),
            c["out"] == true,
            "{c}"
        );
    }
    for c in pure("region") {
        assert_eq!(
            accounts::is_valid_aws_region(c["value"].as_str().unwrap()),
            c["out"] == true,
            "{c}"
        );
    }
    for c in pure("accountsDir") {
        let got = accounts::accounts_dir_for(c["override"].as_str(), c["home"].as_str().unwrap());
        assert_eq!(got, c["out"].as_str().unwrap(), "{c}");
    }
    for c in pure("expiry") {
        let got = accounts::should_warn_token_expiring(
            js_number(Some(&c["expiresAt"])),
            js_number(Some(&c["now"])).unwrap(),
        );
        assert_eq!(got, c["out"] == true, "{c}");
    }
}

#[test]
fn apply_bedrock_env_matches() {
    for c in pure("bedrockEnv") {
        let p = AccountProfile::from_value(&c["profile"]).unwrap();
        let mut env: std::collections::HashMap<String, String> = c["env"]
            .as_object()
            .unwrap()
            .iter()
            .map(|(k, v)| (k.clone(), v.as_str().unwrap().to_owned()))
            .collect();
        let got = accounts::apply_bedrock_env(&mut env, &p)
            .map(|()| js::stringify(&env_vars(&env)))
            .map_err(|e| e.0);
        assert_eq!(got, expected_vars(c), "{c}");
    }
}

#[test]
fn profiles_never_print_their_secret() {
    let p = AccountProfile::from_value(&json!({
        "id": "acc_x", "label": "L", "kind": "oauth-token", "secret": "sk-ant-oat01-FAKE-debug", "createdAt": "c"
    }))
    .unwrap();
    let shown = format!(
        "{p:?} {:?}",
        NewAccount {
            secret: Some(json!("sk-ant-api03-FAKE-new")),
            ..Default::default()
        }
    );
    assert!(!shown.contains("FAKE"), "{shown}");
}
