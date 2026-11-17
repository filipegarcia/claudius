//! "Build installable app": port of `lib/server/customization-build.ts`
//! (D14). [`start_build`] writes the overlay list (the changed and added
//! files of `computeDiff`) to `<root>/<id>/.build-overlay.txt` and spawns
//! `<live>/scripts/build-app-local.mjs --overlay-src <src> --overlay-manifest
//! <list>` in the live source dir, on the first node (or bun) found
//! ([`resolve_launcher`]). The build state is in memory only, one per
//! customization, as in TS: [`get_build_state`] reads it.
//!
//! Like Node's child, each 64 KiB read of stdout / stderr is decoded on its
//! own (lossy UTF-8) and split into log lines on `\r?\n` (empty ones
//! dropped, the newest 400 kept). The state settles at the child's exit:
//! `done` when it exited 0 and `<live>/release/<mac|mac-arm64>/Claudius.app`
//! exists, else `error` (`build exited with code N`, `null` for a signal,
//! plus ` (no .app produced)` without the app). Output that comes after the
//! exit still lands in the log. A spawn that fails with one of the errnos
//! Node reports after the fact (`EACCES`, `EAGAIN`, `EMFILE`, `ENFILE`,
//! `ENOENT`) answers `building` and is an `error` with `[spawn error] …`
//! right after; any other spawn error is thrown (`spawn <CODE>`).

use std::collections::HashMap;
use std::process::Stdio;
use std::sync::{Arc, LazyLock, Mutex, PoisonError};

use anyhow::{anyhow, bail};
use serde_json::{Value, json};
use tokio::io::{AsyncRead, AsyncReadExt};

use crate::customization_publish::diff_error;
use crate::customizations::Store;
use crate::node_fs::{self, FsError};
use crate::{node_path, now_ms};

/// `LOG_TAIL_MAX`.
const LOG_TAIL_MAX: usize = 400;

/// libuv reads a pipe 64 KiB at a time.
const READ_CHUNK: usize = 64 * 1024;

/// `buildAvailability()`'s reason when there is no source checkout.
pub const UNAVAILABLE: &str =
    "Local build needs the Claudius source checkout — run from source (electron:dev) to enable it.";

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
enum Status {
    Building,
    Done,
    Error,
}

impl Status {
    fn as_str(self) -> &'static str {
        match self {
            Status::Building => "building",
            Status::Done => "done",
            Status::Error => "error",
        }
    }
}

#[derive(Debug)]
struct Entry {
    customization_id: String,
    status: Status,
    started_at: i64,
    finished_at: Option<i64>,
    logs: Vec<String>,
    artifact_path: Option<String>,
    error_message: Option<String>,
}

impl Entry {
    /// `snapshot(e, id)`: `errorMessage` only when set.
    fn snapshot(&self) -> Value {
        let mut v = json!({
            "customizationId": self.customization_id,
            "status": self.status.as_str(),
            "startedAt": self.started_at,
            "finishedAt": self.finished_at,
            "artifactPath": self.artifact_path,
        });
        let m = v.as_object_mut().expect("an object");
        if let Some(e) = &self.error_message {
            m.insert("errorMessage".into(), json!(e));
        }
        m.insert("logs".into(), json!(self.logs));
        v
    }

    /// `pushLog(e, chunk)`.
    fn push_log(&mut self, chunk: &str) {
        for line in chunk.split('\n') {
            let line = line.strip_suffix('\r').unwrap_or(line);
            if line.is_empty() {
                continue;
            }
            self.logs.push(line.to_owned());
            if self.logs.len() > LOG_TAIL_MAX {
                let extra = self.logs.len() - LOG_TAIL_MAX;
                self.logs.drain(..extra);
            }
        }
    }
}

type Shared = Arc<Mutex<Entry>>;

/// The process's builds (`globalThis.__claudiusBuildEntries`), by
/// customization id. Each child holds its own entry, so a late line from
/// a replaced build never reaches the new one.
static ENTRIES: LazyLock<Mutex<HashMap<String, Shared>>> =
    LazyLock::new(|| Mutex::new(HashMap::new()));

fn guard<T>(m: &Mutex<T>) -> std::sync::MutexGuard<'_, T> {
    m.lock().unwrap_or_else(PoisonError::into_inner)
}

fn exists(p: &str) -> bool {
    std::fs::metadata(p).is_ok()
}

/// `macSubdir()`: electron-builder's output dir for the host arch.
fn mac_subdir() -> &'static str {
    if std::env::consts::ARCH == "aarch64" {
        "mac-arm64"
    } else {
        "mac"
    }
}

/// `buildScriptPath()`: `<live>/scripts/build-app-local.mjs`, when it and
/// `<live>/electron-builder.yml` both exist.
pub fn build_script_path(live: &str) -> Option<String> {
    let script = node_path::join(&[live, "scripts", "build-app-local.mjs"]);
    let eb_yaml = node_path::join(&[live, "electron-builder.yml"]);
    (exists(&script) && exists(&eb_yaml)).then_some(script)
}

/// `buildAvailability()`.
pub fn build_availability(live: &str) -> Value {
    match build_script_path(live) {
        Some(_) => json!({"available": true}),
        None => json!({"available": false, "reason": UNAVAILABLE}),
    }
}

/// A runtime that can run a `.mjs` (or the revert script).
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct Launcher {
    pub bin: String,
    pub node_dir: Option<String>,
}

/// `resolveLauncher()` for this process: its own binary when that is a
/// node (never, for `claudius`), else the first `node` on `PATH`, then
/// `/opt/homebrew/bin`, `/usr/local/bin`, `/usr/bin`, then
/// `$HOME/.bun/bin/bun`.
pub fn resolve_launcher() -> Option<Launcher> {
    let exe = std::env::current_exe()
        .ok()
        .map(|p| p.to_string_lossy().into_owned());
    let path = std::env::var_os("PATH").map(|v| v.to_string_lossy().into_owned());
    let home = std::env::var_os("HOME").map(|v| v.to_string_lossy().into_owned());
    resolve_launcher_in(exe.as_deref(), path.as_deref(), home.as_deref(), exists)
}

/// [`resolve_launcher`] over the given `process.execPath`, `PATH`, `HOME`
/// and `existsSync`.
pub fn resolve_launcher_in(
    exec_path: Option<&str>,
    path: Option<&str>,
    home: Option<&str>,
    exists: impl Fn(&str) -> bool,
) -> Option<Launcher> {
    if let Some(exe) = exec_path {
        let base = exe.rsplit('/').next().unwrap_or(exe);
        if base.to_lowercase().starts_with("node") {
            return Some(Launcher {
                bin: exe.to_owned(),
                node_dir: Some(node_path::dirname(exe)),
            });
        }
    }
    let on_path = path.unwrap_or("").split(':');
    let fixed = ["/opt/homebrew/bin", "/usr/local/bin", "/usr/bin"];
    for dir in on_path.chain(fixed) {
        let node = node_path::join(&[dir, "node"]);
        if !dir.is_empty() && exists(&node) {
            return Some(Launcher {
                bin: node,
                node_dir: Some(dir.to_owned()),
            });
        }
    }
    let bun = node_path::join(&[home.unwrap_or(""), ".bun", "bin", "bun"]);
    if exists(&bun) {
        let dir = node_path::dirname(&bun);
        return Some(Launcher {
            bin: bun,
            node_dir: Some(dir),
        });
    }
    None
}

/// `getBuildState(id)`: the build's snapshot, or `None` (TS `null`).
pub fn get_build_state(customization_id: &str) -> Option<Value> {
    let entry = guard(&ENTRIES).get(customization_id).cloned()?;
    Some(guard(&entry).snapshot())
}

/// The child's env: this process's, without `__NEXT_PRIVATE_*` and
/// `NEXT_DEPLOYMENT_ID`, the launcher's dir first on `PATH`.
fn child_env(node_dir: Option<&str>) -> Vec<(std::ffi::OsString, std::ffi::OsString)> {
    let mut env: Vec<_> = std::env::vars_os()
        .filter(|(k, _)| {
            let k = k.to_string_lossy();
            !k.starts_with("__NEXT_PRIVATE_") && k != "NEXT_DEPLOYMENT_ID"
        })
        .collect();
    if let Some(dir) = node_dir {
        let at = env.iter().position(|(k, _)| k == "PATH");
        let current = at.map(|i| env[i].1.to_string_lossy().into_owned());
        let next = match current.as_deref() {
            Some(p) if !p.is_empty() => format!("{dir}:{p}"),
            _ => dir.to_owned(),
        };
        match at {
            Some(i) => env[i].1 = next.into(),
            None => env.push(("PATH".into(), next.into())),
        }
    }
    env
}

/// `startBuild(id)`: an ongoing build's state, or a new build's
/// (`building`). Throws TS's errors: `customization not found`, the
/// availability reason, `no node/bun runtime found to run the build`, a diff
/// or overlay-write error, a spawn error Node throws. Needs a tokio runtime
/// (the child is read on it).
pub fn start_build(store: &Store, live: &str, customization_id: &str) -> anyhow::Result<Value> {
    if let Some(existing) = guard(&ENTRIES).get(customization_id) {
        let e = guard(existing);
        if e.status == Status::Building {
            return Ok(e.snapshot());
        }
    }
    if store.get_customization(customization_id)?.is_none() {
        bail!("customization not found");
    }
    let Some(script) = build_script_path(live) else {
        bail!(UNAVAILABLE);
    };
    let Some(launcher) = resolve_launcher() else {
        bail!("no node/bun runtime found to run the build");
    };
    let diff = store
        .compute_diff(customization_id, live)
        .map_err(diff_error)?;
    let overlay: Vec<&str> = diff["files"]
        .as_array()
        .map(|a| a.iter().filter_map(|f| f["path"].as_str()).collect())
        .unwrap_or_default();
    let manifest_file = node_path::join(&[
        &store.customization_dir(customization_id),
        ".build-overlay.txt",
    ]);
    let fail = |e: FsError| anyhow!(e.message);
    node_fs::mkdir_recursive(&node_path::dirname(&manifest_file), 0o777).map_err(fail)?;
    node_fs::write_file(&manifest_file, &(overlay.join("\n") + "\n"), 0o666).map_err(fail)?;
    let src_dir = store.customization_src_dir(customization_id);
    let artifact_path = node_path::join(&[live, "release", mac_subdir(), "Claudius.app"]);

    let mut cmd = tokio::process::Command::new(&launcher.bin);
    cmd.args([
        script.as_str(),
        "--overlay-src",
        &src_dir,
        "--overlay-manifest",
        &manifest_file,
    ])
    .env_clear()
    .envs(child_env(launcher.node_dir.as_deref()))
    .stdin(Stdio::null())
    .stdout(Stdio::piped())
    .stderr(Stdio::piped());
    // Node passes an empty cwd as none.
    if !live.is_empty() {
        cmd.current_dir(live);
    }
    let spawned = cmd.spawn();
    if let Err(e) = &spawned
        && !matches!(
            claudius_agent::binary::node_error_code(e).as_deref(),
            Some("EACCES" | "EAGAIN" | "EMFILE" | "ENFILE" | "ENOENT")
        )
    {
        bail!(crate::git::spawn_message(&launcher.bin, e));
    }
    let entry: Shared = Arc::new(Mutex::new(Entry {
        customization_id: customization_id.to_owned(),
        status: Status::Building,
        started_at: now_ms(),
        finished_at: None,
        logs: Vec::new(),
        artifact_path: None,
        error_message: None,
    }));
    guard(&ENTRIES).insert(customization_id.to_owned(), entry.clone());
    let state = guard(&entry).snapshot();
    match spawned {
        Ok(child) => {
            tokio::spawn(watch(child, entry, artifact_path));
        }
        // The child's `error` event, a tick after the call returned.
        Err(e) => {
            let message = crate::git::spawn_message(&launcher.bin, &e);
            let mut e = guard(&entry);
            e.status = Status::Error;
            e.finished_at = Some(now_ms());
            e.push_log(&format!("[spawn error] {message}"));
            e.error_message = Some(message);
        }
    }
    Ok(state)
}

async fn read_some<R: AsyncRead + Unpin>(
    pipe: &mut Option<R>,
    buf: &mut [u8],
) -> std::io::Result<usize> {
    match pipe {
        Some(r) => r.read(buf).await,
        None => std::future::pending().await,
    }
}

/// The child's `data` and `exit` handlers, until both pipes close and the
/// child is reaped.
///
/// `biased`: when both pipes are readable, stdout is read first (libuv
/// reports the two fds in the order they were registered, stdout first),
/// and the exit is only taken once neither pipe has anything ready, so a
/// settled state already holds every line the child wrote before it
/// exited. An unbiased `select!` picks at random and could interleave
/// the streams or settle with lines still unread.
async fn watch(mut child: tokio::process::Child, entry: Shared, artifact_path: String) {
    let mut stdout = child.stdout.take();
    let mut stderr = child.stderr.take();
    let (mut out_buf, mut err_buf) = (vec![0u8; READ_CHUNK], vec![0u8; READ_CHUNK]);
    let mut exited = false;
    while stdout.is_some() || stderr.is_some() || !exited {
        tokio::select! {
            biased;
            r = read_some(&mut stdout, &mut out_buf), if stdout.is_some() => match r {
                Ok(n) if n > 0 => guard(&entry).push_log(&String::from_utf8_lossy(&out_buf[..n])),
                _ => stdout = None,
            },
            r = read_some(&mut stderr, &mut err_buf), if stderr.is_some() => match r {
                Ok(n) if n > 0 => guard(&entry).push_log(&String::from_utf8_lossy(&err_buf[..n])),
                _ => stderr = None,
            },
            status = child.wait(), if !exited => {
                exited = true;
                let code = status.ok().and_then(|s| s.code());
                let has_app = exists(&artifact_path);
                let mut e = guard(&entry);
                e.finished_at = Some(now_ms());
                if code == Some(0) && has_app {
                    e.status = Status::Done;
                    e.artifact_path = Some(artifact_path.clone());
                } else {
                    e.status = Status::Error;
                    let code = code.map_or("null".to_owned(), |c| c.to_string());
                    let suffix = if has_app { "" } else { " (no .app produced)" };
                    e.error_message = Some(format!("build exited with code {code}{suffix}"));
                }
            }
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn the_launcher_order_is_the_ts_order() {
        let has = |set: &'static [&'static str]| move |p: &str| set.contains(&p);
        let l = |bin: &str, dir: &str| {
            Some(Launcher {
                bin: bin.into(),
                node_dir: Some(dir.into()),
            })
        };
        let none: &[&str] = &[];
        assert_eq!(
            resolve_launcher_in(Some("/x/Node22"), None, None, has(none)),
            l("/x/Node22", "/x")
        );
        assert_eq!(
            resolve_launcher_in(
                Some("/x/claudius"),
                Some(":/a:/b"),
                None,
                has(&["/b/node", "/usr/bin/node"])
            ),
            l("/b/node", "/b")
        );
        assert_eq!(
            resolve_launcher_in(None, Some("/a"), None, has(&["/usr/bin/node"])),
            l("/usr/bin/node", "/usr/bin")
        );
        assert_eq!(
            resolve_launcher_in(None, None, Some("/h"), has(&["/h/.bun/bin/bun"])),
            l("/h/.bun/bin/bun", "/h/.bun/bin")
        );
        // No HOME: a relative `.bun/bin/bun`.
        assert_eq!(
            resolve_launcher_in(None, None, None, has(&[".bun/bin/bun"])),
            l(".bun/bin/bun", ".bun/bin")
        );
        assert_eq!(resolve_launcher_in(None, Some(""), None, has(none)), None);
    }

    #[test]
    fn logs_split_per_chunk_and_keep_the_last_400() {
        let mut e = Entry {
            customization_id: "c".into(),
            status: Status::Building,
            started_at: 0,
            finished_at: None,
            logs: Vec::new(),
            artifact_path: None,
            error_message: None,
        };
        e.push_log("a\r\nb\n\n\rc\r\r\n");
        assert_eq!(e.logs, ["a", "b", "\rc\r"]);
        for i in 0..500 {
            e.push_log(&format!("{i}\n"));
        }
        assert_eq!(e.logs.len(), 400);
        assert_eq!(e.logs[0], "100");
    }
}
