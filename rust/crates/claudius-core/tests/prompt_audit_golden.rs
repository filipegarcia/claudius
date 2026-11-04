//! The doctor's pure helpers and file readers (D22), replayed against what
//! `rust/scripts/doctor-golden.mjs` recorded from the real TS
//! (`tests/fixtures/prompt_audit_golden.json`):
//! - `sweep`: every code point through the skill-name rules (alone, after
//!   `a`, before U+0307 and before U+093F, which together pin each Unicode
//!   class the rules read) and every UTF-16 unit through the prompt
//!   patterns' `\s` and the path / command token classes, compared as the
//!   lists of code points where the answer flips;
//! - `names`, `patterns`, `paths`, `commands`, `contradictions`,
//!   `telemetry`: each recorded input's output;
//! - `slash`: the command registry entry by entry, and `findSlashCommand`;
//! - `modules`: the recorded world built under a temp root (`$ROOT/home` as
//!   the home dir, `$ROOT/project` as the cwd, umask 022), then each
//!   `readScope` / `resolveHierarchy` / `listSkills` /
//!   `auditWorkspacePrompts` call's result or thrown error (name, code,
//!   message). Calls tagged `needs: "perm"` run only where a `chmod 0` file
//!   is unreadable.
#![cfg(unix)]

use std::os::unix::fs::PermissionsExt;
use std::path::Path;
use std::sync::OnceLock;

use claudius_core::claudemd::{self, ClaudeMdScope as Scope};
use claudius_core::prompt_audit as pa;
use claudius_core::skills::{self, SkillScope, Thrown};
use claudius_core::{js_string, paths, skill_names, slash_commands, telemetry_env};
use serde_json::{Value, json};

fn fixture() -> &'static Value {
    static F: OnceLock<Value> = OnceLock::new();
    // `js_string::parse`: the fixture holds lone surrogates.
    F.get_or_init(|| js_string::parse(include_str!("fixtures/prompt_audit_golden.json")).unwrap())
}

fn s(v: &Value) -> &str {
    v.as_str().unwrap()
}

/// The JS string of one code point (a lone surrogate for U+D800..U+DFFF).
fn cp_str(cp: u32) -> String {
    match char::from_u32(cp) {
        Some(c) => c.to_string(),
        None => js_string::from_units(&[cp as u16]),
    }
}

fn flips(last: u32, f: impl Fn(&str) -> bool) -> Vec<u64> {
    let mut out = Vec::new();
    let mut prev = false;
    for cp in 0..=last {
        let v = f(&cp_str(cp));
        if v != prev {
            out.push(u64::from(cp));
            prev = v;
        }
    }
    out
}

fn recorded_flips(name: &str) -> Vec<u64> {
    fixture()["sweep"][name]
        .as_array()
        .unwrap()
        .iter()
        .map(|v| v.as_u64().unwrap())
        .collect()
}

type Pred = Box<dyn Fn(&str) -> bool + Sync>;

#[test]
fn sweep_skill_names() {
    let shown = skill_names::is_engine_shown_name;
    let cases: [(&str, Pred); 5] = [
        ("valid", Box::new(skill_names::is_valid_skill_dir_name)),
        ("shown", Box::new(shown)),
        ("afterA", Box::new(move |c| shown(&format!("a{c}")))),
        (
            "beforeDotAbove",
            Box::new(move |c| shown(&format!("{c}\u{307}"))),
        ),
        (
            "beforeVowelSign",
            Box::new(move |c| shown(&format!("{c}\u{93f}"))),
        ),
    ];
    std::thread::scope(|scope| {
        for (name, f) in &cases {
            scope.spawn(move || {
                assert_eq!(flips(0x10ffff, f), recorded_flips(name), "{name}");
            });
        }
    });
}

#[test]
fn sweep_prompt_classes() {
    assert_eq!(
        flips(0xffff, |c| !pa::find_stale_prompt_patterns(&format!(
            "think{c}step by step"
        ))
        .is_empty()),
        recorded_flips("cotSpace")
    );
    assert_eq!(
        flips(0xffff, |c| !pa::extract_referenced_paths(&format!(
            "`a{c}/b.ts`"
        ))
        .is_empty()),
        recorded_flips("pathChar")
    );
    assert_eq!(
        flips(0xffff, |c| !pa::extract_referenced_commands(&format!(
            "`/a{c}`"
        ))
        .is_empty()),
        recorded_flips("commandChar")
    );
}

#[test]
fn names() {
    let mut bad = Vec::new();
    for case in fixture()["names"].as_array().unwrap() {
        let name = s(&case[0]);
        let got = json!([
            name,
            skill_names::is_valid_skill_dir_name(name),
            skill_names::is_engine_shown_name(name),
            skill_names::is_engine_offerable_name(name),
        ]);
        if &got != case {
            bad.push(format!("{case} -> {got}"));
        }
    }
    assert!(bad.is_empty(), "{} of them:\n{}", bad.len(), bad.join("\n"));
}

fn match_json(m: &pa::Match) -> Value {
    json!({"pattern": m.pattern.as_str(), "note": m.pattern.note(), "snippet": m.snippet})
}

#[test]
fn patterns() {
    let mut bad = Vec::new();
    for case in fixture()["patterns"].as_array().unwrap() {
        let got: Vec<Value> = pa::find_stale_prompt_patterns(s(&case[0]))
            .iter()
            .map(match_json)
            .collect();
        if json!(got) != case[1] {
            bad.push(format!(
                "{} -> {}",
                js_string::stringify(case),
                js_string::stringify(&json!(got))
            ));
        }
    }
    assert!(bad.is_empty(), "{} of them:\n{}", bad.len(), bad.join("\n"));
}

#[test]
fn references() {
    let mut bad = Vec::new();
    for (key, f) in [
        (
            "paths",
            pa::extract_referenced_paths as fn(&str) -> Vec<String>,
        ),
        ("commands", pa::extract_referenced_commands),
    ] {
        for case in fixture()[key].as_array().unwrap() {
            let got = json!(f(s(&case[0])));
            if got != case[1] {
                bad.push(format!("{key} {} -> {got}", js_string::stringify(case)));
            }
        }
    }
    assert!(bad.is_empty(), "{} of them:\n{}", bad.len(), bad.join("\n"));
}

#[test]
fn contradictions() {
    let mut bad = Vec::new();
    for case in fixture()["contradictions"].as_array().unwrap() {
        let sources: Vec<(String, String)> = case[0]
            .as_array()
            .unwrap()
            .iter()
            .map(|x| (s(&x["id"]).to_owned(), s(&x["text"]).to_owned()))
            .collect();
        let got: Vec<Value> = pa::find_instruction_contradictions(&sources)
            .into_iter()
            .map(|c| json!({"token": c.token, "sources": c.sources}))
            .collect();
        if json!(got) != case[1] {
            bad.push(format!(
                "{} -> {}",
                js_string::stringify(case),
                js_string::stringify(&json!(got))
            ));
        }
    }
    assert!(bad.is_empty(), "{} of them:\n{}", bad.len(), bad.join("\n"));
}

#[test]
fn telemetry() {
    for case in fixture()["telemetry"].as_array().unwrap() {
        let env = (case[0] != "absent").then_some(&case[0]);
        assert_eq!(
            json!(telemetry_env::ignored_telemetry_env_keys(env)),
            case[1],
            "{case}"
        );
        assert_eq!(
            json!(telemetry_env::ignored_attachments_env_keys(env)),
            case[2],
            "{case}"
        );
    }
}

#[test]
fn slash_registry() {
    let ours: Vec<Value> = slash_commands::SLASH_COMMANDS
        .iter()
        .map(|(id, name, aliases)| json!([id, name, aliases]))
        .collect();
    assert_eq!(json!(ours), fixture()["slash"]["registry"]);
    for case in fixture()["slash"]["lookups"].as_array().unwrap() {
        assert_eq!(
            json!(slash_commands::find_slash_command(s(&case[0]))),
            case[1],
            "{case}"
        );
    }
}

// ─────────────────────────────── modules ───────────────────────────────

struct Ph {
    root: String,
    eroot: String,
}

impl Ph {
    fn abs(&self, s: &str) -> String {
        s.replace("$EROOT", &self.eroot)
            .replace("$ROOT", &self.root)
    }

    fn rel(&self, s: &str) -> String {
        s.replace(&self.eroot, "$EROOT")
            .replace(&self.root, "$ROOT")
    }

    /// `rel` over every string of a value, keys too.
    fn rel_value(&self, v: &Value) -> Value {
        match v {
            Value::String(x) => Value::String(self.rel(x)),
            Value::Array(a) => Value::Array(a.iter().map(|x| self.rel_value(x)).collect()),
            Value::Object(m) => Value::Object(
                m.iter()
                    .map(|(k, x)| (self.rel(k), self.rel_value(x)))
                    .collect(),
            ),
            other => other.clone(),
        }
    }
}

fn set_umask() {
    // SAFETY: umask only swaps the process's file-mode mask.
    unsafe {
        libc::umask(0o022);
    }
}

fn mkdir_p(p: &Path) {
    std::fs::create_dir_all(p).unwrap();
}

/// One recorded setup op, as the recorder applied it.
fn apply(ph: &Ph, op: &Value) {
    let path = op["path"]
        .as_str()
        .map(|p| format!("{}/{}", ph.root, ph.abs(p)));
    let p = || Path::new(path.as_deref().unwrap());
    match s(&op["op"]) {
        "write" => {
            mkdir_p(p().parent().unwrap());
            let bytes = match op["bytes"].as_array() {
                Some(b) => b.iter().map(|n| n.as_u64().unwrap() as u8).collect(),
                None => js_string::lossy(&ph.abs(s(&op["text"])))
                    .as_bytes()
                    .to_vec(),
            };
            std::fs::write(p(), bytes).unwrap();
        }
        "mkdir" => mkdir_p(p()),
        "rm" => {
            let _ = std::fs::remove_dir_all(p()).or_else(|_| std::fs::remove_file(p()));
        }
        "symlink" => {
            mkdir_p(p().parent().unwrap());
            std::os::unix::fs::symlink(ph.abs(s(&op["target"])), p()).unwrap();
        }
        "chmod" => {
            let mode = op["mode"].as_u64().unwrap() as u32;
            std::fs::set_permissions(p(), std::fs::Permissions::from_mode(mode)).unwrap();
        }
        "sql" => {
            let db = paths::db_path(&ph.abs(s(&op["cwd"])));
            mkdir_p(db.parent().unwrap());
            let conn = rusqlite::Connection::open(&db).unwrap();
            conn.execute_batch(s(&op["sql"])).unwrap();
            conn.close().unwrap();
        }
        other => panic!("op {other}"),
    }
}

/// Whether a `chmod 0` file is unreadable here (not root).
fn perm_enforced(root: &str) -> bool {
    let p = format!("{root}/perm-probe");
    std::fs::write(&p, "x").unwrap();
    std::fs::set_permissions(&p, std::fs::Permissions::from_mode(0o000)).unwrap();
    let enforced = std::fs::read(&p).is_err();
    std::fs::remove_file(&p).unwrap();
    enforced
}

fn threw_claudemd(e: &Thrown) -> Value {
    json!({"name": e.name, "message": e.message})
}

fn scope(name: &str) -> Scope {
    match name {
        "user" => Scope::User,
        "project" => Scope::Project,
        "project-claude" => Scope::ProjectClaude,
        "local" => Scope::Local,
        other => panic!("scope {other}"),
    }
}

#[test]
fn modules() {
    set_umask();
    let tmp = tempfile::tempdir().unwrap();
    let root = tmp.path().canonicalize().unwrap();
    let root = root.to_str().unwrap().to_owned();
    let ph = Ph {
        eroot: paths::encode_project_dir(&root),
        root: root.clone(),
    };
    let home = format!("{root}/home");
    mkdir_p(Path::new(&format!("{root}/project")));
    // `homedir()` for the agents DB; the cwd for relative project dirs.
    paths::set_home_override(home.clone().into());
    std::env::set_current_dir(format!("{root}/project")).unwrap();
    let perm = perm_enforced(&root);

    let fx = &fixture()["modules"];
    for op in fx["setup"].as_array().unwrap() {
        apply(&ph, op);
    }
    let mut bad = Vec::new();
    let mut ran = 0;
    for call in fx["calls"].as_array().unwrap() {
        if call["needs"] == "perm" && !perm {
            continue;
        }
        ran += 1;
        let args = call["call"].as_array().unwrap();
        let cwd_arg = ph.abs(s(args.last().unwrap()));
        let got = match s(&args[0]) {
            "readScope" => match claudemd::read_scope(&home, scope(s(&args[1])), &cwd_arg) {
                Ok(f) => json!({"result": f.to_json()}),
                Err(e) => json!({"threw": threw_claudemd(&e)}),
            },
            "resolveHierarchy" => match claudemd::resolve_hierarchy(&home, &cwd_arg) {
                Ok(h) => json!({"result": h}),
                Err(e) => json!({"threw": threw_claudemd(&e)}),
            },
            "listSkills" => {
                let sc = match s(&args[1]) {
                    "user" => SkillScope::User,
                    _ => SkillScope::Project,
                };
                match skills::list_skills(&home, sc, &cwd_arg) {
                    Ok(list) => {
                        json!({"result": list.iter().map(|f| f.to_json().unwrap_or(Value::Null)).collect::<Vec<_>>()})
                    }
                    Err(e) => json!({"threw": threw_claudemd(&e)}),
                }
            }
            "auditWorkspacePrompts" => match pa::audit_workspace_prompts(&home, &cwd_arg) {
                Ok(r) => json!({"result": r.to_json()}),
                Err(e) => json!({"threw": threw_claudemd(&e)}),
            },
            other => panic!("call {other}"),
        };
        let got = ph.rel_value(&got);
        let want = match (&call.get("result"), &call.get("threw")) {
            (Some(r), _) => json!({"result": r}),
            // D12's `Thrown` has no errno `code`: compare name + message.
            (_, Some(t)) => json!({"threw": {"name": t["name"], "message": t["message"]}}),
            _ => panic!("{call}"),
        };
        if js_string::stringify(&got) != js_string::stringify(&want) {
            bad.push(format!(
                "{}\n  want {}\n  got  {}",
                js_string::stringify(&call["call"]),
                js_string::stringify(&want),
                js_string::stringify(&got)
            ));
        }
    }
    // Let the temp dir go (a 0-mode file can still be unlinked).
    std::env::set_current_dir("/").unwrap();
    assert!(
        bad.is_empty(),
        "{} of {ran}:\n{}",
        bad.len(),
        bad.join("\n")
    );
    assert!(ran > 100, "{ran}");
}
