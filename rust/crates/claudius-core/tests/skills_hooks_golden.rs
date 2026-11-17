//! `skills.rs`, `skill_names.rs`, `hooks.rs`, `keybindings.rs` and
//! `claudemd.rs` (D12), replayed against what
//! `rust/scripts/skills-hooks-golden.mjs` recorded from the real
//! `lib/server/{skills,hooks,keybindings,claudemd}.ts`,
//! `lib/shared/skill-names.ts` and `invisible-unicode.ts`
//! (`tests/fixtures/skills_hooks_golden.json`):
//! - `props`: the Unicode properties the name rules read, for every code
//!   point, against V8's `\p{…}` (node 22's ICU);
//! - `names`: the folder-name rule, the engine's shown / offerable rules and
//!   `visualizeHiddenNameUnicode` on the recorded names;
//! - `handlers` / `agentEvents`: the CC 2.1.300 agent-hook rules of
//!   `lib/shared/hook-events.ts` (`isLegacyAgentHook`,
//!   `legacyAgentHookName`, `agentHandlerAllowed`);
//! - `modules`: each scenario's calls in order on a fresh world (one temp
//!   root, `$ROOT/home` as the home dir), checking each result or thrown
//!   error (name, message) and every watched path the call changed (kind,
//!   mode, text or bytes, symlink target), then the whole tree at the end.
//!   A scenario that needs enforced permissions runs only where a `chmod 0`
//!   directory is unreadable.
#![cfg(unix)]

use std::collections::{BTreeMap, HashSet};
use std::os::unix::fs::PermissionsExt;
use std::path::{Path, PathBuf};
use std::sync::OnceLock;

use claudius_agent::js;
use claudius_core::claudemd::{self, ClaudeMdScope};
use claudius_core::hooks;
use claudius_core::settings::Scope;
use claudius_core::skills::{self, SkillScope, Thrown};
use claudius_core::{db_agents, js_string, keybindings, paths, skill_names};
use serde_json::{Value, json};

fn fixture() -> &'static Value {
    static F: OnceLock<Value> = OnceLock::new();
    F.get_or_init(|| js_string::parse(include_str!("fixtures/skills_hooks_golden.json")).unwrap())
}

#[test]
fn unicode_properties_match_v8() {
    let fx = fixture();
    assert_eq!(fx["unicode"], "17.0", "recorded on node 22's Unicode 17");
    let runs: Vec<(u32, u32)> = fx["props"]
        .as_str()
        .unwrap()
        .split(',')
        .map(|r| {
            let (a, b) = r.split_once(':').unwrap();
            (
                u32::from_str_radix(a, 16).unwrap(),
                u32::from_str_radix(b, 16).unwrap(),
            )
        })
        .collect();
    assert!(runs.len() > 1000, "{} runs", runs.len());
    let mut wrong = Vec::new();
    for (i, &(start, bits)) in runs.iter().enumerate() {
        let end = runs.get(i + 1).map_or(0x11_0000, |r| r.0);
        for cp in start..end {
            let got = skill_names::property_bits(cp);
            if got != bits {
                wrong.push(format!("U+{cp:04X}: {got:#x}, V8 {bits:#x}"));
            }
        }
    }
    assert!(
        wrong.is_empty(),
        "{} code points differ: {:?}",
        wrong.len(),
        &wrong[..wrong.len().min(20)]
    );
}

#[test]
fn name_rules_match_ts() {
    let names = fixture()["names"].as_array().unwrap();
    assert!(names.len() > 3000);
    for n in names {
        let name = n[0].as_str().unwrap();
        let bits = u32::from(skill_names::is_valid_skill_dir_name(name))
            | u32::from(skill_names::is_engine_shown_name(name)) << 1
            | u32::from(skill_names::is_engine_offerable_name(name)) << 2;
        assert_eq!(u64::from(bits), n[1].as_u64().unwrap(), "rules of {name:?}");
        let (shown, count) = skill_names::visualize_hidden_name_unicode(name);
        assert_eq!(shown, n[2].as_str().unwrap(), "visualized {name:?}");
        assert_eq!(count as u64, n[3].as_u64().unwrap(), "count {name:?}");
    }
}

// ─────────────────────────────────── world ───────────────────────────────────

const WATCH: [&str; 8] = [
    "home/.claude",
    "project",
    "ws",
    "untrusted",
    "outside",
    "dotfile",
    "config",
    "caf\u{e9} x\u{1f600}",
];

struct World {
    root: String,
}

impl World {
    fn path(&self, rel: &str) -> PathBuf {
        PathBuf::from(format!("{}/{}", self.root, self.abs(rel)))
    }

    fn abs(&self, s: &str) -> String {
        s.replace("$ROOT", &self.root)
    }

    /// `$ROOT` back in, and `writeSettings`' temp names masked.
    fn rel(&self, s: &str) -> String {
        mask_tmp(&s.replace(&self.root, "$ROOT"))
    }

    fn build(&self, layout: &Value) {
        let root = Path::new(&self.root);
        open_up(root);
        for e in std::fs::read_dir(root).unwrap() {
            let p = e.unwrap().path();
            if std::fs::symlink_metadata(&p).unwrap().is_dir() {
                std::fs::remove_dir_all(p).unwrap();
            } else {
                std::fs::remove_file(p).unwrap();
            }
        }
        for d in layout["dirs"].as_array().unwrap() {
            std::fs::create_dir_all(self.path(d.as_str().unwrap())).unwrap();
        }
        for f in layout["files"].as_array().unwrap() {
            let p = self.path(f[0].as_str().unwrap());
            std::fs::create_dir_all(p.parent().unwrap()).unwrap();
            std::fs::write(p, self.abs(f[1].as_str().unwrap())).unwrap();
        }
    }

    fn apply(&self, op: &Value) {
        let p = self.path(op["path"].as_str().unwrap());
        match op["op"].as_str().unwrap() {
            "write" => {
                std::fs::create_dir_all(p.parent().unwrap()).unwrap();
                let bytes = match op.get("bytes") {
                    Some(b) => b
                        .as_array()
                        .unwrap()
                        .iter()
                        .map(|n| n.as_u64().unwrap() as u8)
                        .collect(),
                    None => self.abs(op["text"].as_str().unwrap()).into_bytes(),
                };
                std::fs::write(p, bytes).unwrap();
            }
            "mkdir" => std::fs::create_dir_all(p).unwrap(),
            "rm" => {
                open_up(&p);
                match std::fs::symlink_metadata(&p) {
                    Ok(m) if m.is_dir() => std::fs::remove_dir_all(p).unwrap(),
                    Ok(_) => std::fs::remove_file(p).unwrap(),
                    Err(_) => {}
                }
            }
            "symlink" => {
                std::fs::create_dir_all(p.parent().unwrap()).unwrap();
                std::os::unix::fs::symlink(self.abs(op["target"].as_str().unwrap()), p).unwrap()
            }
            "chmod" => std::fs::set_permissions(
                p,
                std::fs::Permissions::from_mode(op["mode"].as_u64().unwrap() as u32),
            )
            .unwrap(),
            other => panic!("unknown op {other}"),
        }
    }

    /// The recorder's `snapshot()`.
    fn snapshot(&self) -> BTreeMap<String, Value> {
        let mut snap = BTreeMap::new();
        for rel in WATCH {
            self.visit(rel, &mut snap);
        }
        snap
    }

    fn visit(&self, rel: &str, snap: &mut BTreeMap<String, Value>) {
        if snap.contains_key(rel) || rel == "home/.claude/.claudius" {
            return;
        }
        let abs = self.path(rel);
        let Ok(meta) = std::fs::symlink_metadata(&abs) else {
            return;
        };
        let mode = meta.permissions().mode() & 0o777;
        if meta.file_type().is_symlink() {
            let target = std::fs::read_link(&abs).unwrap().display().to_string();
            snap.insert(
                rel.into(),
                json!({"kind": "symlink", "target": self.rel(&target)}),
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
                self.visit(&format!("{rel}/{}", self.rel(&n)), snap);
            }
        } else {
            let entry = match std::fs::read(&abs) {
                Err(_) => json!({"kind": "file", "mode": mode, "unreadable": true}),
                Ok(bytes) => match String::from_utf8(bytes) {
                    Ok(text) => json!({"kind": "file", "mode": mode, "text": self.rel(&text)}),
                    Err(e) => json!({"kind": "file", "mode": mode, "bytes": e.into_bytes()}),
                },
            };
            snap.insert(rel.into(), entry);
        }
    }
}

/// `.tmp-<pid>-<n>` as `.tmp-PID-N`.
/// CC 2.1.300: the agent-hook shape rules, on every recorded handler.
#[test]
fn agent_hook_shapes_match_the_ts() {
    let fx = fixture();
    let rows = fx["handlers"].as_array().unwrap();
    assert!(rows.len() >= 30, "{} handlers", rows.len());
    let mut legacy = 0;
    for row in rows {
        let (h, want_legacy, want_name) = (&row[0], row[1].as_bool().unwrap(), &row[2]);
        assert_eq!(hooks::is_legacy_agent_hook(h), want_legacy, "{h}");
        assert_eq!(
            hooks::legacy_agent_hook_name(h).map_or(Value::Null, Value::from),
            *want_name,
            "{h}"
        );
        legacy += u32::from(want_legacy);
    }
    assert!(legacy >= 8, "{legacy} legacy shapes recorded");
    // `agentHandlerAllowed` over every event name, in the TS order.
    let events = fx["agentEvents"].as_array().unwrap();
    assert_eq!(events.len(), hooks::HOOK_EVENT_NAMES.len());
    for (row, name) in events.iter().zip(hooks::HOOK_EVENT_NAMES) {
        assert_eq!(row[0].as_str(), Some(name), "the event order");
        assert_eq!(
            hooks::agent_handler_allowed(name),
            row[1].as_bool().unwrap(),
            "{name}"
        );
    }
}

fn mask_tmp(s: &str) -> String {
    let mut out = String::with_capacity(s.len());
    let mut rest = s;
    while let Some(i) = rest.find(".tmp-") {
        out.push_str(&rest[..i]);
        let after = &rest[i + 5..];
        let pid = after.bytes().take_while(u8::is_ascii_digit).count();
        let tail = &after[pid..];
        let n = tail
            .strip_prefix('-')
            .map_or(0, |t| t.bytes().take_while(u8::is_ascii_digit).count());
        if pid > 0 && n > 0 {
            out.push_str(".tmp-PID-N");
            rest = &tail[1 + n..];
        } else {
            out.push_str(".tmp-");
            rest = after;
        }
    }
    out.push_str(rest);
    out
}

/// chmod every directory under `p` back to 0755, so it can be removed.
fn open_up(p: &Path) {
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

/// JS's default `sort()`: by UTF-16 code units.
fn js_sort(v: &mut [String]) {
    v.sort_by(|a, b| a.encode_utf16().cmp(b.encode_utf16()));
}

/// The recorder's `changes`.
fn changes(before: &BTreeMap<String, Value>, after: &BTreeMap<String, Value>) -> Value {
    let mut keys: Vec<String> = before.keys().chain(after.keys()).cloned().collect();
    js_sort(&mut keys);
    keys.dedup();
    Value::Array(
        keys.into_iter()
            .filter(|k| before.get(k) != after.get(k))
            .map(|k| json!([k, after.get(&k).cloned().unwrap_or(Value::Null)]))
            .collect(),
    )
}

fn perm_enforced() -> bool {
    let d = tempfile::tempdir().unwrap();
    let p = d.path().join("probe");
    std::fs::create_dir(&p).unwrap();
    std::fs::set_permissions(&p, std::fs::Permissions::from_mode(0o0)).unwrap();
    let enforced = std::fs::read_dir(&p).is_err();
    std::fs::set_permissions(&p, std::fs::Permissions::from_mode(0o755)).unwrap();
    enforced
}

// ─────────────────────────────────── calls ───────────────────────────────────

fn skill_scope(v: &Value) -> SkillScope {
    SkillScope::parse(v.as_str().unwrap()).unwrap()
}

fn settings_scope(v: &Value) -> Scope {
    Scope::parse(v.as_str().unwrap()).unwrap()
}

fn md_scope(v: &Value) -> ClaudeMdScope {
    ClaudeMdScope::parse(v.as_str().unwrap()).unwrap()
}

/// `JSON.stringify`, or "circular" for a value it throws on.
fn text(v: Option<Value>) -> String {
    v.map_or("circular".to_owned(), |v| js_string::stringify(&v))
}

fn files(list: &[skills::SkillFile]) -> Option<Value> {
    list.iter()
        .map(skills::SkillFile::to_json)
        .collect::<Option<Vec<_>>>()
        .map(Value::Array)
}

/// One recorded call: its `result` text or what it threw.
fn call(name: &str, args_text: &str, home: &str) -> Result<String, Thrown> {
    // Each argument as the TS function got it: Infinity where a check reads
    // it, `null` where it is written out, lone surrogates kept for keybindings.
    let args = match name {
        "writeKeybindings" => js_string::parse(args_text).unwrap(),
        "addGroup" => js::json_parse(args_text).unwrap(),
        _ => db_agents::json_parse(args_text).unwrap(),
    };
    let a = args.as_array().unwrap();
    let s = |i: usize| a[i].as_str().unwrap();
    Ok(match name {
        "listSkills" => text(files(&skills::list_skills(home, skill_scope(&a[0]), s(1))?)),
        "readSkill" => match skills::read_skill(home, skill_scope(&a[0]), s(1), s(2))? {
            None => "null".into(),
            Some(f) => text(f.to_json()),
        },
        "writeSkill" => {
            skills::write_skill(home, skill_scope(&a[0]), s(1), &a[2], s(3))?;
            "undefined".into()
        }
        "deleteSkill" => skills::delete_skill(home, skill_scope(&a[0]), s(1), s(2))?.to_string(),
        "listAll" => js_string::stringify(&Value::Array(
            hooks::list_all(s(0))?
                .iter()
                .map(hooks::ScopedHooks::to_json)
                .collect(),
        )),
        "addGroup" => {
            hooks::add_group(settings_scope(&a[0]), s(1), s(2), &a[3])?;
            "undefined".into()
        }
        "removeGroup" => {
            let index = db_agents::number(&a[3]).unwrap();
            hooks::remove_group(settings_scope(&a[0]), s(1), s(2), index)?.to_string()
        }
        "setDisableAllHooks" => {
            hooks::set_disable_all_hooks(settings_scope(&a[0]), s(1), a[2].as_bool().unwrap())?;
            "undefined".into()
        }
        "readKeybindings" => js_string::stringify(&keybindings::read_keybindings(home)?),
        "writeKeybindings" => {
            keybindings::write_keybindings(home, &a[0])?;
            "undefined".into()
        }
        "pathFor" => js::stringify(&json!(claudemd::path_for(home, md_scope(&a[0]), s(1))?)),
        "readScope" => js::stringify(&claudemd::read_scope(home, md_scope(&a[0]), s(1))?.to_json()),
        "writeScope" => js::stringify(
            &json!({ "path": claudemd::write_scope(home, md_scope(&a[0]), s(1), s(2))? }),
        ),
        "readAllScopes" => js::stringify(&Value::Array(
            claudemd::read_all_scopes(home, s(0))?
                .iter()
                .map(claudemd::ScopeFile::to_json)
                .collect(),
        )),
        "resolveContent" => js::stringify(&Value::Array(
            claudemd::resolve_content(s(0), s(1), &mut HashSet::new(), 0)
                .iter()
                .map(claudemd::Segment::to_json)
                .collect(),
        )),
        "resolveHierarchy" => js::stringify(&claudemd::resolve_hierarchy(home, s(0))?),
        other => panic!("unknown call {other}"),
    })
}

#[test]
fn module_scenarios_replay_the_ts() {
    let fx = fixture();
    // The recorder ran under umask 022.
    unsafe { libc::umask(0o022) };
    let dir = tempfile::tempdir().unwrap();
    let root = dir.path().canonicalize().unwrap().display().to_string();
    assert!(
        root.bytes()
            .all(|b| b.is_ascii_alphanumeric() || b"_./-".contains(&b)),
        "placeholders are swapped textually: {root}"
    );
    let w = World { root };
    let home = format!("{}/home", w.root);
    assert!(paths::set_home_override(PathBuf::from(&home)));
    let perm = perm_enforced();
    let (mut ran, mut calls) = (0, 0);
    for sc in fx["modules"].as_array().unwrap() {
        let name = sc["name"].as_str().unwrap();
        if sc["skipped"] == true {
            continue;
        }
        if sc["needs"].as_array().unwrap().iter().any(|n| n == "perm") && !perm {
            continue;
        }
        ran += 1;
        w.build(&fx["world"]);
        for (i, step) in sc["steps"].as_array().unwrap().iter().enumerate() {
            if let Some(ops) = step.get("setup") {
                for op in ops.as_array().unwrap() {
                    w.apply(op);
                }
                continue;
            }
            calls += 1;
            let fname = step["call"].as_str().unwrap();
            let args = step["args"].as_str().unwrap();
            let what = format!("{name} step {i}: {fname}({args})");
            let before = w.snapshot();
            let got = call(fname, &w.abs(args), &home);
            let after = w.snapshot();
            match (&got, step.get("threw")) {
                (Ok(text), None) => {
                    assert_eq!(w.rel(text), step["result"].as_str().unwrap(), "{what}")
                }
                (Err(t), Some(want)) => assert_eq!(
                    json!({"name": t.name, "message": w.rel(&t.message)}),
                    *want,
                    "{what}"
                ),
                (got, _) => panic!("{what}: got {got:?}, recorded {step}"),
            }
            assert_eq!(changes(&before, &after), step["changes"], "{what}: changed");
        }
        let end: BTreeMap<String, Value> = sc["final"]
            .as_object()
            .unwrap()
            .iter()
            .map(|(k, v)| (k.clone(), v.clone()))
            .collect();
        assert_eq!(w.snapshot(), end, "{name}: the tree at the end");
    }
    open_up(Path::new(&w.root));
    let skipped = if perm { 0 } else { 3 };
    assert_eq!(ran, 10 - skipped, "scenarios run");
    assert!(calls >= 250, "{calls} calls");
    println!("{calls} recorded calls replayed");
}
