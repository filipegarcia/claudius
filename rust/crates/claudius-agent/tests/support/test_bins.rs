//! The binaries the `claudius-agent`, `claudius-core` and `claudius-server`
//! integration tests spawn, `#[path]`-included by each (a file in a
//! `tests/` subdirectory is not a test target of its own).
//!
//! Never spawn a binary straight from `target/debug/`. On macOS cargo
//! copies a binary there instead of hard-linking it (cargo#10060), so every
//! `cargo build`, even a no-op one, removes `target/debug/<bin>` and copies
//! it in again. A build in another process (a second test binary, a gate,
//! any cargo command on the same target dir) then races this process's
//! spawns: an exec between the remove and the copy fails with ENOENT or
//! EACCES ("exists but failed to launch"). The session's CLI was gone before
//! or just after its first prompt (TODO I35; I24 fixed the same race within
//! one process by building once; I36 covered the `CARGO_BIN_EXE_*` paths).
//!
//! So each binary is spawned from [`private_copy`], made once per build at
//! `target/debug/private-bin/<bin>/<mtime ns>-<size>/<bin>`, which cargo
//! never touches. The file name stays, for process listings, `pgrep`
//! patterns and code that looks at its own name. A copy appears there
//! complete, by an atomic rename. Copies of older builds stay until
//! `cargo clean`: a process still on an older build may be about to spawn
//! one.
#![allow(dead_code)] // each test crate uses a different part

use std::collections::HashMap;
use std::io::ErrorKind;
use std::os::unix::fs::PermissionsExt;
use std::path::{Path, PathBuf};
use std::process::{Command, Stdio};
use std::sync::{Mutex, OnceLock};
use std::time::{Duration, UNIX_EPOCH};

/// The fake CLI to spawn, for tests outside `claudius-agent` (which have no
/// `CARGO_BIN_EXE_claudius-fake-claude`): built once per process, then
/// [`private_copy`], run once to check the copy starts.
pub fn fake_claude() -> PathBuf {
    static BIN: OnceLock<PathBuf> = OnceLock::new();
    BIN.get_or_init(|| {
        let cargo = std::env::var("CARGO").unwrap_or_else(|_| "cargo".into());
        let st = Command::new(cargo)
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
        assert!(st.success(), "building the fake CLI");
        let bin = private_copy(
            PathBuf::from(env!("CARGO_MANIFEST_DIR"))
                .join("../../target/debug/claudius-fake-claude"),
        );
        check_runs(&bin);
        bin
    })
    .clone()
}

/// A copy of the uplifted binary at `shared` that no build replaces (see
/// the module docs). Made once per build and looked up once per process.
pub fn private_copy(shared: impl AsRef<Path>) -> PathBuf {
    static COPIES: OnceLock<Mutex<HashMap<PathBuf, PathBuf>>> = OnceLock::new();
    let shared = shared.as_ref();
    let mut copies = COPIES.get_or_init(Default::default).lock().unwrap();
    if let Some(bin) = copies.get(shared) {
        return bin.clone();
    }
    // Another process's build may be between its remove and its copy.
    for _ in 0..500 {
        match copy_once(shared) {
            Ok(bin) => {
                copies.insert(shared.to_path_buf(), bin.clone());
                return bin;
            }
            Err(e) if e.kind() == ErrorKind::NotFound => {
                std::thread::sleep(Duration::from_millis(10));
            }
            Err(e) => panic!("copying {}: {e}", shared.display()),
        }
    }
    panic!("{} never reappeared", shared.display());
}

/// Copy the build at `shared` unless a copy of it exists. The source is
/// opened once, so a build replacing it meanwhile can't mix two files into
/// one copy.
fn copy_once(shared: &Path) -> std::io::Result<PathBuf> {
    let name = shared.file_name().expect("a binary path");
    let mut src = std::fs::File::open(shared)?;
    let meta = src.metadata()?;
    let mtime = meta
        .modified()?
        .duration_since(UNIX_EPOCH)
        .unwrap_or_default()
        .as_nanos();
    let build = shared
        .parent()
        .expect("a binary path")
        .join("private-bin")
        .join(name)
        .join(format!("{mtime}-{}", meta.len()));
    let dest = build.join(name);
    if dest.exists() {
        return Ok(dest);
    }
    std::fs::create_dir_all(&build)?;
    let tmp = build.join(format!(
        ".{}.{}",
        name.to_string_lossy(),
        std::process::id()
    ));
    {
        let mut out = std::fs::File::create(&tmp)?;
        std::io::copy(&mut src, &mut out)?;
        out.set_permissions(std::fs::Permissions::from_mode(0o755))?;
        out.sync_all()?;
    }
    std::fs::rename(&tmp, &dest)?;
    Ok(dest)
}

/// Run the fake once (no script, stdin at EOF: it exits at once), so a copy
/// that doesn't start fails here with its status, not as a dead CLI in some
/// test.
fn check_runs(bin: &Path) {
    let st = Command::new(bin)
        .env_clear()
        .stdin(Stdio::null())
        .stdout(Stdio::null())
        .stderr(Stdio::null())
        .status();
    assert!(
        st.as_ref().is_ok_and(|s| s.success()),
        "the fake CLI at {} doesn't run: {st:?}",
        bin.display()
    );
}
