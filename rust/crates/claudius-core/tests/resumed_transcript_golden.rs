//! The compaction row's transcript path (R04, CC 2.1.301), replayed against
//! the TS recording in `tests/fixtures/resumed_transcript_golden.json`
//! (`rust/scripts/resumed-transcript-golden.mjs`):
//! - `finds`: the real `findResumedTranscriptPath(id, cwd, projectsBase)`
//!   over 10 seeded trees (the cwd's own project dir, a fork resumed in its
//!   worktree, readdir order, symlinked dirs and transcripts, odd cwds and
//!   ids, odd bases);
//! - `display`: `resumedTranscriptPath()`'s `~`-shortened form.
//!
//! The trees are rebuilt in the recorded order under one root, because a
//! base that resolves above its own tree sees the ones seeded before it.

use std::path::{Path, PathBuf};
use std::sync::OnceLock;

use claudius_core::paths;
use claudius_core::resumed_transcript::{display_path, find_resumed_transcript_path};
use serde_json::Value;

fn fixture() -> &'static Value {
    static F: OnceLock<Value> = OnceLock::new();
    F.get_or_init(|| {
        let path = PathBuf::from(env!("CARGO_MANIFEST_DIR"))
            .join("tests/fixtures/resumed_transcript_golden.json");
        serde_json::from_str(&std::fs::read_to_string(path).unwrap()).unwrap()
    })
}

/// One isolated `$HOME` per test binary, so the default base and the `~`
/// shortening are the recorder's.
fn env() -> &'static (tempfile::TempDir, String, String) {
    static E: OnceLock<(tempfile::TempDir, String, String)> = OnceLock::new();
    E.get_or_init(|| {
        let root = tempfile::tempdir().unwrap();
        let root_s = root.path().canonicalize().unwrap().display().to_string();
        let home = Path::new(&root_s).join("home");
        std::fs::create_dir_all(&home).unwrap();
        assert!(paths::set_home_override(home.clone()));
        assert!(paths::set_config_dir_override(
            Path::new(&root_s).join("config")
        ));
        (root, root_s, home.display().to_string())
    })
}

#[test]
fn finds_match_the_ts_lookup() {
    let (_, root, home) = env();
    let mut calls = 0;
    for (i, tree) in fixture()["finds"].as_array().unwrap().iter().enumerate() {
        let name = tree["name"].as_str().unwrap();
        let base = if tree["defaultBase"] == true {
            Path::new(home).join(".claude").join("projects")
        } else {
            Path::new(root).join("bases").join(i.to_string())
        };
        let base_s = base.display().to_string();
        std::fs::create_dir_all(&base).unwrap();
        std::fs::write(Path::new(root).join("a-file"), "not a dir").unwrap();
        // Node's `join`, not `Path::join`: a seed path that starts with `/`
        // (an empty `encodeProjectDir(cwd)`) still lands under the base.
        let abs = |p: &str| {
            if p.contains("$ROOT") {
                PathBuf::from(p.replace("$ROOT", root))
            } else {
                PathBuf::from(claudius_core::node_path::join(&[&base_s, p]))
            }
        };
        for op in tree["files"].as_array().unwrap() {
            let a = op.as_array().unwrap();
            let target = abs(a[1].as_str().unwrap());
            match a[0].as_str().unwrap() {
                "write" => {
                    std::fs::create_dir_all(target.parent().unwrap())
                        .unwrap_or_else(|e| panic!("{name}: mkdir {target:?}: {e}"));
                    std::fs::write(&target, "{}\n")
                        .unwrap_or_else(|e| panic!("{name}: write {target:?}: {e}"));
                }
                "mkdir" => std::fs::create_dir_all(&target).unwrap(),
                "symlink" => {
                    let link = abs(a[2].as_str().unwrap());
                    std::fs::create_dir_all(link.parent().unwrap()).unwrap();
                    std::os::unix::fs::symlink(&target, &link).unwrap();
                }
                o => panic!("{name}: unknown file op {o}"),
            }
        }
        for call in tree["calls"].as_array().unwrap() {
            let id = call["id"].as_str().unwrap();
            let cwd = call["cwd"].as_str().unwrap();
            let arg_base = match call["base"].as_str() {
                None => base_s.clone(),
                // TS's own default, `homedir()/.claude/projects`.
                Some("$DEFAULT") => claudius_core::resumed_transcript::default_projects_base()
                    .to_string_lossy()
                    .into_owned(),
                Some(b) => b.replace("$BASE", &base_s).replace("$ROOT", root),
            };
            let got = find_resumed_transcript_path(id, cwd, &arg_base).map(|p| {
                p.replace(&base_s, "$BASE")
                    .replace(root.as_str(), "$ROOT")
                    .replace(home.as_str(), "$HOME")
            });
            assert_eq!(
                got.as_deref(),
                call["found"].as_str(),
                "{name}: id {id:?} cwd {cwd:?} base {:?}",
                call["base"]
            );
            calls += 1;
        }
    }
    assert!(calls >= 30, "{calls}");
}

#[test]
fn the_display_form_matches() {
    let (_, _, home) = env();
    let mut shortened = 0;
    for c in fixture()["display"].as_array().unwrap() {
        let Some(file) = c["file"].as_str() else {
            // `undefined` / no file: the method answers nothing, which the
            // Rust side models by never calling `display_path`.
            assert!(c["result"].is_null());
            continue;
        };
        // TS's `if (!file) return undefined`: an empty path is no path.
        if file.is_empty() {
            assert!(c["result"].is_null());
            continue;
        }
        let got = display_path(&file.replace("$HOME", home));
        let want = c["result"].as_str().unwrap().replace("$HOME", home);
        assert_eq!(got, want, "{file:?}");
        shortened += usize::from(got.starts_with('~'));
    }
    assert!(shortened >= 4, "{shortened}");
}
