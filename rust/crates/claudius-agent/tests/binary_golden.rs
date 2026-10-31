//! Replays `fixtures/binary_golden.json` (recorded by
//! `rust/scripts/binary-golden.mjs` on macOS):
//! - the SDK's default lookup (`xZ`) over platform × arch × libc × installed
//!   packages, against [`binary::native_candidates`] and [`binary::lookup`];
//! - its "binary not found" template;
//! - failed launches through [`Query::spawn_prompt`], whose error must read
//!   like the SDK's;
//! - JS entries run through `node` with `executableArgs`;
//! - Node's errno names.
//!
//! The launch, JS-entry and errno cases are macOS behaviour and only replay
//! there.

use std::path::{Path, PathBuf};

use claudius_agent::{AgentError, Options, Query, binary};
use serde_json::{Value, json};

fn fixture() -> Value {
    let path = PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("tests/fixtures/binary_golden.json");
    serde_json::from_str(&std::fs::read_to_string(path).unwrap()).unwrap()
}

fn on_recorded_os(fx: &Value) -> bool {
    fx["os"].as_str() == Some(std::env::consts::OS)
}

/// Launch cases Rust can't match, with the reason.
const GAPS: &[(&str, &str)] = &[(
    "no_shebang",
    "Node's posix_spawn reports ENOEXEC; std's execvp retries the file through /bin/sh, so it runs",
)];

#[test]
fn lookup_matches_the_sdk() {
    let fx = fixture();
    let cases = fx["candidates"].as_array().unwrap();
    assert!(cases.len() >= 300);
    let mut failures = Vec::new();
    for c in cases {
        let installed: Vec<String> = c["installed"]
            .as_array()
            .unwrap()
            .iter()
            .map(|i| format!("{}-{}", binary::SDK_PACKAGE, i.as_str().unwrap()))
            .collect();
        let candidates = binary::native_candidates(
            c["platform"].as_str().unwrap(),
            c["arch"].as_str().unwrap(),
            c["preferMusl"].as_bool().unwrap(),
        );
        let mut tried = Vec::new();
        let picked = binary::lookup(
            &candidates,
            |spec| {
                tried.push(spec.to_owned());
                let pkg = spec.split('/').take(2).collect::<Vec<_>>().join("/");
                installed
                    .contains(&pkg)
                    .then(|| PathBuf::from(format!("/nm/{spec}")))
            },
            |_| true,
        );
        let got = json!({"tried": tried, "picked": picked.map(|p| p.display().to_string())});
        let want = json!({"tried": c["tried"], "picked": c["picked"]});
        if got != want {
            failures.push(format!("{c}\n  rust: {got}"));
        }
    }
    assert!(failures.is_empty(), "{}", failures.join("\n"));
}

#[test]
fn not_found_message_matches_the_sdk() {
    let e = AgentError::BinaryNotFound {
        platform: "${process.platform}".into(),
        arch: "${process.arch}".into(),
    };
    assert_eq!(json!(e.to_string()), fixture()["notFound"]);
}

fn spawn_options(tmp: &Path, exe: PathBuf, path_dirs: &[String]) -> Options {
    Options {
        path_to_claude_code_executable: Some(exe),
        cwd: Some(tmp.to_path_buf()),
        executable: Some("node".into()),
        env: Some(
            [
                ("PATH".to_owned(), path_dirs.join(":")),
                ("HOME".to_owned(), tmp.display().to_string()),
            ]
            .into_iter()
            .collect(),
        ),
        ..Default::default()
    }
}

/// The recorder's scratch files, at the same relative paths.
fn scratch() -> (tempfile::TempDir, PathBuf) {
    let dir = tempfile::tempdir().unwrap();
    let tmp = dir.path().canonicalize().unwrap();
    let w = |name: &str, body: &str, mode: u32| {
        let p = tmp.join(name);
        std::fs::write(&p, body).unwrap();
        #[cfg(unix)]
        {
            use std::os::unix::fs::PermissionsExt;
            std::fs::set_permissions(&p, std::fs::Permissions::from_mode(mode)).unwrap();
        }
        #[cfg(not(unix))]
        let _ = mode;
    };
    std::fs::create_dir(tmp.join("empty-bin")).unwrap();
    std::fs::create_dir(tmp.join("a-directory")).unwrap();
    w("not-executable", "#!/bin/sh\nexit 0\n", 0o644);
    w("no-shebang", "exit 0\n", 0o755);
    #[cfg(unix)]
    {
        std::os::unix::fs::symlink(tmp.join("loop-b"), tmp.join("loop-a")).unwrap();
        std::os::unix::fs::symlink(tmp.join("loop-a"), tmp.join("loop-b")).unwrap();
    }
    let entry = "const fs = require(\"fs\");\nfs.writeFileSync(process.env.ARGV_OUT, JSON.stringify({ argv: process.argv.slice(1), execArgv: process.execArgv }));\n";
    w("entry.js", entry, 0o644);
    w("entry.cjs.ts", entry, 0o644);
    (dir, tmp)
}

#[tokio::test]
async fn launch_errors_match_the_sdk() {
    let fx = fixture();
    if !on_recorded_os(&fx) {
        eprintln!("skipped: launch errors were recorded on {}", fx["os"]);
        return;
    }
    let (_dir, tmp) = scratch();
    let sub = |s: &str| s.replace(&tmp.display().to_string(), "$TMP");
    let mut failures = Vec::new();
    let mut gaps_hit = Vec::new();
    for c in fx["launches"].as_array().unwrap() {
        let name = c["name"].as_str().unwrap();
        let dirs: Vec<String> = c["pathDirs"]
            .as_array()
            .unwrap()
            .iter()
            .map(|d| match d.as_str().unwrap() {
                "$EMPTY" => tmp.join("empty-bin").display().to_string(),
                d => d.to_owned(),
            })
            .collect();
        let exe = tmp.join(c["path"].as_str().unwrap());
        let got = match Query::spawn_prompt("go", spawn_options(&tmp, exe, &dirs)).await {
            Err(e) => Some(sub(&e.to_string())),
            Ok(mut q) => {
                // Launched after all: the stream's own end.
                let mut last = None;
                while let Some(m) = q.next().await {
                    if let Err(e) = m {
                        last = Some(sub(&e.to_string()));
                    }
                }
                last
            }
        };
        if json!(got) != c["error"] {
            if GAPS.iter().any(|(g, _)| *g == name) {
                gaps_hit.push(name);
                continue;
            }
            failures.push(format!("{name}\n  sdk:  {}\n  rust: {got:?}", c["error"]));
        }
    }
    assert!(failures.is_empty(), "{}", failures.join("\n"));
    for (g, why) in GAPS {
        assert!(
            gaps_hit.contains(g),
            "{g} now matches; drop it from GAPS ({why})"
        );
    }
}

/// `node` on this test's `PATH`, for the JS-entry cases.
fn node_dir() -> Option<PathBuf> {
    std::env::split_paths(&std::env::var_os("PATH")?).find(|d| d.join("node").is_file())
}

#[tokio::test]
async fn js_entries_run_through_node_like_the_sdk() {
    let fx = fixture();
    let Some(node) = node_dir() else {
        eprintln!("skipped: no node on PATH");
        return;
    };
    let (_dir, tmp) = scratch();
    let sub = |s: &str| s.replace(&tmp.display().to_string(), "$TMP");
    for (i, c) in fx["jsEntries"].as_array().unwrap().iter().enumerate() {
        let file = c["file"].as_str().unwrap();
        let out = tmp.join(format!("argv-{i}.json"));
        let mut opts = spawn_options(
            &tmp,
            tmp.join(file),
            &[node.display().to_string(), "/usr/bin".into(), "/bin".into()],
        );
        opts.executable_args = c["executableArgs"]
            .as_array()
            .unwrap()
            .iter()
            .map(|a| a.as_str().unwrap().to_owned())
            .collect();
        opts.env
            .as_mut()
            .unwrap()
            .insert("ARGV_OUT".into(), out.display().to_string());
        let mut q = Query::spawn_prompt("go", opts).await.unwrap();
        let mut error = None;
        while let Some(m) = q.next().await {
            if let Err(e) = m {
                error = Some(sub(&e.to_string()));
            }
        }
        let seen: Value = serde_json::from_str(&std::fs::read_to_string(&out).unwrap()).unwrap();
        let argv: Vec<String> = seen["argv"]
            .as_array()
            .unwrap()
            .iter()
            .map(|a| sub(a.as_str().unwrap()))
            .collect();
        assert_eq!(json!(argv), c["argv"], "{file}: argv");
        assert_eq!(seen["execArgv"], c["execArgv"], "{file}: executableArgs");
        assert_eq!(json!(error), c["error"], "{file}: error");
    }
}

#[cfg(unix)]
#[test]
fn errno_names_match_node() {
    let fx = fixture();
    if !on_recorded_os(&fx) {
        eprintln!("skipped: errno names were recorded on {}", fx["os"]);
        return;
    }
    for (i, want) in fx["errnoNames"].as_array().unwrap().iter().enumerate() {
        let errno = i as i32 + 1;
        let got = binary::node_error_code(&std::io::Error::from_raw_os_error(errno));
        assert_eq!(json!(got), *want, "errno {errno}");
    }
}
