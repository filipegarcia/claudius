//! Replays `tests/fixtures/list_sessions_golden.json`, recorded from the real
//! SDK's `listSessions` and `lib/server/sessions-store.ts` `list()` by
//! `rust/scripts/list-sessions-golden.mjs`: each case's tree is rebuilt under
//! a root of the recorded length (file contents, symlinks, FIFOs, real git
//! worktrees, exact mtimes, modes), then every call must give the recorded
//! `JSON.stringify` text through `sessions_list::list_sessions_in` (`sdk`)
//! or `sessions_store::list_with` (`ts`).

use std::path::{Path, PathBuf};
use std::process::Command;
use std::time::{Duration, SystemTime, UNIX_EPOCH};

use claudius_core::paths;
use claudius_core::sessions_list::{self, ListEnv, ListOptions};
use claudius_core::sessions_store;
use serde_json::Value;

fn fixture() -> Value {
    let raw = std::fs::read_to_string(
        Path::new(env!("CARGO_MANIFEST_DIR")).join("tests/fixtures/list_sessions_golden.json"),
    )
    .unwrap();
    serde_json::from_str(&raw).unwrap()
}

/// A temp root padded to the recorded length, so file sizes and the
/// 200-char project-dir cut come out the same.
struct Root {
    _tmp: tempfile::TempDir,
    path: String,
}

fn make_root(len: usize) -> Root {
    let tmp = tempfile::Builder::new().prefix("lsg-").tempdir().unwrap();
    let base = std::fs::canonicalize(tmp.path()).unwrap();
    let base = base.to_str().unwrap();
    assert!(
        base.len() + 2 <= len,
        "temp dir {base} is too long for {len}"
    );
    let path = format!("{base}/{}", "p".repeat(len - base.len() - 1));
    std::fs::create_dir_all(format!("{path}/config/projects")).unwrap();
    Root { _tmp: tmp, path }
}

fn sub(root: &str, s: &str) -> String {
    s.replace("$ROOT", root)
}

fn resolve(root: &str, spec: &Value) -> PathBuf {
    if let Some(rel) = spec.as_str() {
        return PathBuf::from(format!("{root}/{}", sub(root, rel)));
    }
    let projects = PathBuf::from(format!("{root}/config/projects"));
    let abs = |rel: &Value| format!("{root}/{}", sub(root, rel.as_str().unwrap()));
    let dir = if let Some(p) = spec.get("proj") {
        projects.join(paths::sdk_project_dir_name(&abs(p)))
    } else if let Some(n) = spec.get("projName") {
        projects.join(n.as_str().unwrap())
    } else {
        let name = paths::encode_project_dir(&abs(&spec["projPrefix"]));
        projects.join(format!(
            "{}{}",
            &name[..200],
            spec["suffix"].as_str().unwrap()
        ))
    };
    match spec.get("sub").and_then(Value::as_str) {
        Some(s) => dir.join(sub(root, s)),
        None => dir,
    }
}

fn bytes_of(root: &str, parts: &Value) -> Vec<u8> {
    let mut out = Vec::new();
    for p in parts.as_array().unwrap() {
        if let Some(t) = p["text"].as_str() {
            out.extend_from_slice(sub(root, t).as_bytes());
        } else if let Some(b) = p["b64"].as_str() {
            out.extend(b64(b));
        } else {
            let chunk = p["repeat"].as_str().unwrap();
            out.extend(
                chunk
                    .repeat(p["count"].as_u64().unwrap() as usize)
                    .into_bytes(),
            );
        }
    }
    out
}

fn b64(s: &str) -> Vec<u8> {
    let val = |c: u8| match c {
        b'A'..=b'Z' => c - b'A',
        b'a'..=b'z' => c - b'a' + 26,
        b'0'..=b'9' => c - b'0' + 52,
        b'+' => 62,
        b'/' => 63,
        _ => unreachable!(),
    };
    let bits: Vec<u8> = s.bytes().filter(|c| *c != b'=').map(val).collect();
    bits.chunks(4)
        .flat_map(|c| {
            let n = c.iter().fold(0u32, |a, v| (a << 6) | u32::from(*v)) << (6 * (4 - c.len()));
            n.to_be_bytes()[1..c.len()].to_vec()
        })
        .collect()
}

fn mtime(ns: &str) -> SystemTime {
    let ns: i128 = ns.parse().unwrap();
    let d = Duration::from_nanos(ns.unsigned_abs() as u64);
    if ns < 0 {
        UNIX_EPOCH - d
    } else {
        UNIX_EPOCH + d
    }
}

fn run(cmd: &mut Command) {
    let out = cmd.output().unwrap();
    assert!(
        out.status.success(),
        "{cmd:?}: {}",
        String::from_utf8_lossy(&out.stderr)
    );
}

/// The recorder's `build`: ops in order, then the mtimes, then the modes.
fn build(root: &str, ops: &[Value]) {
    let mut times = Vec::new();
    let mut modes = Vec::new();
    for op in ops {
        let at = op.get("path").map(|p| resolve(root, p));
        let parent = || std::fs::create_dir_all(at.as_ref().unwrap().parent().unwrap()).unwrap();
        match op["op"].as_str().unwrap() {
            "mkdir" => std::fs::create_dir_all(at.unwrap()).unwrap(),
            "write" => {
                parent();
                let at = at.unwrap();
                std::fs::write(&at, bytes_of(root, &op["parts"])).unwrap();
                times.push((at, mtime(op["mtime"].as_str().unwrap())));
            }
            "symlink" => {
                parent();
                #[cfg(unix)]
                std::os::unix::fs::symlink(sub(root, op["target"].as_str().unwrap()), at.unwrap())
                    .unwrap();
            }
            "fifo" => {
                parent();
                run(Command::new("mkfifo").arg(at.unwrap()));
            }
            "rm" => {
                let _ = std::fs::remove_dir_all(at.unwrap());
            }
            "chmod" => modes.push((at.unwrap(), op["mode"].as_u64().unwrap() as u32)),
            "git" => {
                let cwd = format!("{root}/{}", op["cwd"].as_str().unwrap());
                std::fs::create_dir_all(&cwd).unwrap();
                let args: Vec<String> = op["args"]
                    .as_array()
                    .unwrap()
                    .iter()
                    .map(|a| sub(root, a.as_str().unwrap()))
                    .collect();
                run(Command::new("git")
                    .args(&args)
                    .current_dir(&cwd)
                    .env("GIT_CONFIG_GLOBAL", "/dev/null")
                    .env("GIT_CONFIG_NOSYSTEM", "1"));
            }
            other => panic!("unknown op {other}"),
        }
    }
    for (p, t) in times {
        let f = std::fs::File::options().write(true).open(&p).unwrap();
        f.set_modified(t).unwrap();
    }
    #[cfg(unix)]
    for (p, mode) in modes {
        use std::os::unix::fs::PermissionsExt;
        std::fs::set_permissions(p, std::fs::Permissions::from_mode(mode)).unwrap();
    }
}

fn number(v: &Value) -> Option<f64> {
    match v {
        Value::Null => None,
        Value::String(s) => Some(match s.as_str() {
            "NaN" => f64::NAN,
            "Infinity" => f64::INFINITY,
            "-Infinity" => f64::NEG_INFINITY,
            other => panic!("number {other}"),
        }),
        v => v.as_f64(),
    }
}

fn call(root: &str, env: &ListEnv, call: &Value) -> String {
    let o = &call["opts"];
    let dir = o["dir"].as_str().map(|d| sub(root, d));
    let got = match call["fn"].as_str().unwrap() {
        "sdk" => sessions_list::list_sessions_in(
            &ListOptions {
                dir,
                limit: number(&o["limit"]),
                offset: number(&o["offset"]),
                include_worktrees: o["includeWorktrees"].as_bool(),
                include_programmatic: o["includeProgrammatic"].as_bool(),
            },
            env,
        ),
        "ts" => sessions_store::list_with(
            env,
            dir.as_deref(),
            number(&o["limit"]),
            o["includeWorktrees"].as_bool(),
        ),
        other => panic!("fn {other}"),
    };
    claudius_agent::js::stringify(&serde_json::to_value(&got).unwrap()).replace(root, "$ROOT")
}

fn is_root_user() -> bool {
    #[cfg(unix)]
    {
        Command::new("id")
            .arg("-u")
            .output()
            .is_ok_and(|o| String::from_utf8_lossy(&o.stdout).trim() == "0")
    }
    #[cfg(not(unix))]
    false
}

#[test]
fn list_sessions_matches_the_sdk() {
    let f = fixture();
    let root_len = f["rootLen"].as_u64().unwrap() as usize;
    let root_user = is_root_user();
    let (mut checked, mut skipped) = (0, 0);
    let mut failures = Vec::new();
    for case in f["cases"].as_array().unwrap() {
        let name = case["name"].as_str().unwrap();
        let ops = case["ops"].as_array().unwrap();
        if case["os"].as_str() == Some("darwin") && !cfg!(target_os = "macos")
            || root_user && ops.iter().any(|o| o["op"] == "chmod")
        {
            skipped += 1;
            continue;
        }
        let root = make_root(root_len);
        build(&root.path, ops);
        let env = ListEnv {
            projects: PathBuf::from(format!("{}/config/projects", root.path)),
            project_dir_name: sessions_list::plain_dir_name(
                case["env"]["CLAUDE_CODE_PROJECT_DIR_NAME"].as_str(),
            ),
        };
        for c in case["calls"].as_array().unwrap() {
            checked += 1;
            let got = call(&root.path, &env, c);
            let want = c["result"].as_str().unwrap();
            if got != want {
                failures.push(format!(
                    "{name} {} {}:\n  want {want}\n  got  {got}",
                    c["fn"], c["opts"]
                ));
            }
        }
        #[cfg(unix)]
        {
            let _ = Command::new("chmod")
                .args(["-R", "u+rwX", &root.path])
                .status();
        }
    }
    assert!(
        failures.is_empty(),
        "{} of {checked} calls differ:\n{}",
        failures.len(),
        failures.join("\n")
    );
    assert!(
        checked >= 80,
        "only {checked} calls replayed ({skipped} cases skipped)"
    );
}

#[test]
fn date_parse_matches_v8() {
    let f = fixture();
    for d in f["dates"].as_array().unwrap() {
        let (s, want) = (d[0].as_str().unwrap(), d[1].as_f64().map(|v| v as i64));
        assert_eq!(
            claudius_core::js_date::date_parse(s),
            want,
            "Date.parse({s:?})"
        );
    }
    // Only V8's legacy fallback reads these. The zoned ones match here. The
    // local ones (`2026-1-01`, `275760-09-13`) were recorded under
    // `TZ=UTC`, which this binary doesn't pin; `date_parse_golden.rs`
    // checks them under its pinned zone.
    for d in f["legacyDates"].as_array().unwrap() {
        let s = d[0].as_str().unwrap();
        assert!(!d[1].is_null(), "{s:?} should parse in V8");
        if s.ends_with('Z') || s.ends_with("GMT") {
            assert_eq!(
                claudius_core::js_date::date_parse(s),
                d[1].as_i64(),
                "{s:?}"
            );
        }
    }
}
