//! `execShellCommand` (`lib/server/shell.ts`) called directly with its
//! test-only options (`timeoutMs`, `maxOutputBytes`, `stdin`), replaying
//! the `exec` section of `tests/fixtures/workspace_roots_golden.json`
//! (recorded by `rust/scripts/workspace-roots-golden.mjs` from the real TS).
//!
//! Each case runs `claudius_core::shell::exec_shell_command` on the same
//! `cwd` value (a string, `null`, `undefined`, another JS type, a URL-like
//! object) and command under a temp root laid out like the recorder's
//! (`p1/`, `file.txt`, a symlink loop), and must resolve to the same
//! `{stdout, stderr, truncated, exitCode, signal}` (lone surrogates as
//! escapes) or reject with the same message. The route, with the default
//! 16 Mi-unit cap and 120 s timeout, is `claudius-server/tests/workspace_roots.rs`.
#![cfg(unix)]

use std::path::PathBuf;
use std::time::{Duration, Instant};

use claudius_core::js_string;
use claudius_core::shell::{ShellOpts, exec_shell_command};
use serde_json::{Value, json};

fn fixture() -> Value {
    let path = PathBuf::from(env!("CARGO_MANIFEST_DIR"))
        .join("tests/fixtures/workspace_roots_golden.json");
    js_string::parse(&std::fs::read_to_string(path).unwrap()).unwrap()
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn replays_the_ts_golden() {
    let fx = fixture();
    let dir = tempfile::tempdir().unwrap();
    let root = dir.path().canonicalize().unwrap().display().to_string();
    std::fs::create_dir(format!("{root}/p1")).unwrap();
    std::fs::write(format!("{root}/file.txt"), "not a dir").unwrap();
    std::os::unix::fs::symlink(format!("{root}/loop"), format!("{root}/loop")).unwrap();
    let real = |s: &str| s.replace("$ROOT", &root);

    let cases = fx["exec"].as_array().unwrap();
    let mut failures = vec![];
    for (i, c) in cases.iter().enumerate() {
        let cwd: Option<Value> = c
            .get("cwd")
            .map(|v| js_string::parse(&real(&js_string::stringify(v))).unwrap());
        let command = real(c["command"].as_str().unwrap());
        let o = &c["opts"];
        let opts = ShellOpts {
            timeout_ms: o["timeoutMs"].as_u64(),
            max_output_units: o["maxOutputBytes"].as_u64().map(|n| n as usize),
            // `stdinRepeat: [text, n]` is `stdin: text.repeat(n)`.
            stdin: match &o["stdinRepeat"] {
                Value::Array(r) => Some(
                    r[0].as_str()
                        .unwrap()
                        .repeat(r[1].as_u64().unwrap() as usize),
                ),
                _ => o["stdin"].as_str().map(str::to_owned),
            },
        };
        let t0 = Instant::now();
        let got = match exec_shell_command(cwd.as_ref(), &command, &opts).await {
            Ok(r) => r.to_json(),
            Err(message) => json!({ "threw": message }),
        };
        let took = t0.elapsed();
        let got = js_string::stringify(&got).replace(&root, "$ROOT");
        let want = js_string::stringify(&c["got"]);
        if got != want {
            failures.push(format!(
                "case {i} ({}):\n  got  {}\n  want {}",
                c["command"],
                got.chars().take(400).collect::<String>(),
                want.chars().take(400).collect::<String>()
            ));
        }
        // A run the timer ended took at least the timeout.
        if let Some(ms) = opts.timeout_ms
            && c["got"]["signal"] == "SIGTERM"
        {
            assert!(took >= Duration::from_millis(ms), "case {i}: {took:?}");
        }
    }
    assert!(
        failures.is_empty(),
        "{} of {} cases differ:\n{}",
        failures.len(),
        cases.len(),
        failures.join("\n")
    );
}

/// A caller that goes away (the client hung up) doesn't stop the run: the
/// timeout still kills the group, as Node's timer does.
#[tokio::test]
async fn a_dropped_call_still_times_out() {
    let dir = tempfile::tempdir().unwrap();
    let pid_file = dir.path().join("pid");
    let command = format!(
        "printf %s $$ > '{}'; exec /bin/sleep 30",
        pid_file.display()
    );
    let opts = ShellOpts {
        timeout_ms: Some(300),
        ..ShellOpts::default()
    };
    let call = exec_shell_command(None, &command, &opts);
    // Drop the call once the shell has started.
    let _ = tokio::time::timeout(Duration::from_secs(10), async {
        tokio::pin!(call);
        tokio::select! {
            _ = &mut call => panic!("finished early"),
            _ = async {
                while !pid_file.exists() {
                    tokio::time::sleep(Duration::from_millis(10)).await;
                }
            } => {}
        }
    })
    .await;
    let pid: i32 = loop {
        if let Ok(s) = std::fs::read_to_string(&pid_file)
            && let Ok(p) = s.trim().parse()
        {
            break p;
        }
        tokio::time::sleep(Duration::from_millis(10)).await;
    };
    let t0 = Instant::now();
    // SAFETY: kill(pid, 0) only probes.
    while unsafe { libc::kill(pid, 0) } == 0 {
        assert!(
            t0.elapsed() < Duration::from_secs(10),
            "the shell outlived its timeout"
        );
        tokio::time::sleep(Duration::from_millis(20)).await;
    }
}
