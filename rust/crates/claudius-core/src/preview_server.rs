//! Customization previews: port of `lib/server/preview-server.ts` (D15).
//! Each customization gets at most one `next dev` child, run in its
//! `src/` mirror on a port of its own, so the user can browse an isolated
//! copy of their edited Claudius. The state is in memory only, as in TS.
//!
//! [`start_preview`] (`startPreview`): a running (`starting` / `ready`)
//! preview is answered as it is. Otherwise a tracked exited one is dropped,
//! the mirror must be a directory (`customization <id> has no src/ dir`),
//! its `node_modules` is mirrored from the live tree
//! ([`ensure_node_modules_mirror`]), the dev toolchain is completed with
//! `bun install` when it is missing ([`ensure_mirror_deps`]), whatever still
//! holds the old port is reaped ([`kill_squatters`]), the first free port of
//! the range is taken ([`pick_free_port`]: `no free port in S-E`) and reaped
//! too, and `<src>/node_modules/.bin/next dev -p <port>` is spawned with the
//! scrubbed env of [`build_preview_env`]. The answer is the state right
//! after the spawn: `starting`, the pid (`null` when the spawn failed with
//! an errno Node reports after the fact; the `error` lands right after), the
//! `[deps]` line if any. Other spawn errors (`spawn ENOTDIR`) are thrown.
//!
//! Like Node's `data` handlers, each 64 KiB read of stdout / stderr is
//! decoded on its own (lossy UTF-8) and split on `\r?\n`, empty lines
//! dropped, the newest 200 kept; a line matching
//! `/\b(ready|started server|listening)\b/i` turns `starting` into `ready`.
//! The exit makes it `exited` with Node's `exitCode` / `exitSignal` and an
//! `[exit] code=… signal=…` line.
//!
//! [`stop_preview`] sends SIGTERM and answers the state of that moment. TS
//! arms a 5 s SIGKILL only for a child whose SIGTERM failed, i.e. one that
//! is already gone (`child.killed` is set by any delivered signal), and
//! Node's `kill()` on it does nothing, so there is no SIGKILL here: a child
//! that ignores SIGTERM keeps running, as in TS. [`restart_preview`] stops a
//! running one, waits 600 ms, reaps the old port, sweeps the whole range
//! for listeners this process doesn't own ([`sweep_stale_listeners`]) and
//! starts afresh. Squatters are found with `lsof` and killed with
//! `process.kill` semantics: SIGTERM, then 800 ms later SIGKILL for any
//! still listed.
//!
//! Differences, on purpose:
//! * starts and restarts run one at a time. TS can interleave two at their
//!   `await`s and spawn twice for one customization (or on one port);
//! * the port this server listens on ([`reserve_port`]) is never offered.
//!   The front door's default (3100) is inside the preview range, and the
//!   TS probe (a dual-stack bind on `::`) can't see a listener on
//!   `127.0.0.1`, so a preview would take the UI's own port and answer
//!   `localhost` there;
//! * [`shutdown`] SIGTERMs every live child, previews replaced by a restart
//!   included, and SIGKILLs those still alive 3 s later. TS SIGTERMs only
//!   the tracked ones at exit and leaves the rest;
//! * `bun install` doesn't block the server (TS runs it with `spawnSync`);
//! * there is no Electron `process.resourcesPath`, so the bundled
//!   `preview-runtime` dir is never used;
//! * `CLAUDIUS_PREVIEW_PORTS=S-E` ([`PORTS_ENV`]) replaces the 3100-3199
//!   range (tests run on a free block).
//!
//! Path safety: every file-system call and the spawn check that the target
//! is strictly inside the customizations root; the route answers 403 for
//! an id whose mirror is not, before anything runs.

use std::collections::HashMap;
use std::ffi::OsString;
use std::net::{Ipv4Addr, Ipv6Addr, SocketAddr};
use std::process::{ExitStatus, Stdio};
use std::sync::atomic::{AtomicU16, Ordering};
use std::sync::{Arc, LazyLock, Mutex, PoisonError};
use std::time::Duration;

use anyhow::{anyhow, bail};
use claudius_agent::js;
use serde_json::{Map, Value, json};
use tokio::io::{AsyncRead, AsyncReadExt};
use tokio::net::TcpSocket;
use tokio::sync::{mpsc, oneshot};

use crate::customization_bootstrap::ensure_node_modules_mirror;
use crate::customizations::Store;
use crate::exec_file::{ExecFileOptions, exec_file};
use crate::{node_fs, node_path, now_ms};

/// `PORT_START` / `PORT_END`.
pub const PORT_START: u16 = 3100;
pub const PORT_END: u16 = 3199;
/// Replaces the port range: `S-E` (Rust-only, for tests).
pub const PORTS_ENV: &str = "CLAUDIUS_PREVIEW_PORTS";
/// `LOG_TAIL_MAX`.
const LOG_TAIL_MAX: usize = 200;
/// libuv reads a pipe 64 KiB at a time.
const READ_CHUNK: usize = 64 * 1024;
/// `spawnSync`'s `timeout` for `bun install`, and its default `maxBuffer`
/// (stdout and stderr together).
const BUN_TIMEOUT: Duration = Duration::from_secs(5 * 60);
const SPAWN_SYNC_MAX_BUFFER: usize = 1024 * 1024;
/// The pause before a squatter's SIGKILL, and restart's after its stop.
const SQUAT_GRACE: Duration = Duration::from_millis(800);
const RESTART_GRACE: Duration = Duration::from_millis(600);
/// How long [`shutdown`] waits after SIGTERM before SIGKILL.
const SHUTDOWN_GRACE: Duration = Duration::from_secs(3);
/// `lsof`'s `timeout`.
const LSOF_TIMEOUT_MS: u64 = 3_000;

/// `ensureMirrorDeps`'s answer without a `bun`.
pub const NO_BUN: &str =
    "cannot complete preview dependencies: no `bun` found (install bun or run from source)";

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
enum Status {
    Starting,
    Ready,
    Exited,
    Error,
}

impl Status {
    fn as_str(self) -> &'static str {
        match self {
            Status::Starting => "starting",
            Status::Ready => "ready",
            Status::Exited => "exited",
            Status::Error => "error",
        }
    }

    fn running(self) -> bool {
        matches!(self, Status::Starting | Status::Ready)
    }
}

/// A request to the child's watcher: send `.0`, answer whether it went.
struct Signal(i32, oneshot::Sender<bool>);

#[derive(Debug)]
struct Entry {
    customization_id: String,
    port: u16,
    /// `child.pid`: kept after the exit, as Node keeps it.
    pid: Option<u32>,
    status: Status,
    started_at: i64,
    logs: Vec<String>,
    exit_code: Option<i32>,
    exit_signal: Option<&'static str>,
    error_message: Option<String>,
    /// To the watcher that owns the child (signals go through it, so none
    /// reaches a pid after it was reaped).
    signals: Option<mpsc::UnboundedSender<Signal>>,
}

impl Entry {
    /// `snapshot(e, id)`: `errorMessage` only when set.
    fn snapshot(&self) -> Value {
        let mut m = Map::new();
        m.insert("customizationId".into(), json!(self.customization_id));
        m.insert("status".into(), json!(self.status.as_str()));
        m.insert("port".into(), json!(self.port));
        m.insert("pid".into(), json!(self.pid));
        m.insert("startedAt".into(), json!(self.started_at));
        m.insert("exitCode".into(), json!(self.exit_code));
        m.insert("exitSignal".into(), json!(self.exit_signal));
        if let Some(e) = &self.error_message {
            m.insert("errorMessage".into(), json!(e));
        }
        m.insert("logs".into(), json!(self.logs));
        Value::Object(m)
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
            if self.status == Status::Starting && is_ready_line(line) {
                self.status = Status::Ready;
            }
        }
    }
}

/// `/\b(ready|started server|listening)\b/i.test(line)`. Without the `u`
/// flag `\w` is ASCII and `i` folds only ASCII letters here (a non-ASCII
/// character never canonicalizes to an ASCII one), so bytes will do.
fn is_ready_line(line: &str) -> bool {
    const WORDS: [&str; 3] = ["ready", "started server", "listening"];
    let b = line.as_bytes();
    let word = |i: usize| {
        b.get(i)
            .is_some_and(|c| c.is_ascii_alphanumeric() || *c == b'_')
    };
    (0..b.len()).any(|i| {
        (i == 0 || !word(i - 1))
            && WORDS.iter().any(|w| {
                let end = i + w.len();
                end <= b.len() && b[i..end].eq_ignore_ascii_case(w.as_bytes()) && !word(end)
            })
    })
}

/// `snapshot(undefined, id)`.
fn blank(customization_id: &str) -> Value {
    json!({
        "customizationId": customization_id,
        "status": "exited",
        "port": null,
        "pid": null,
        "startedAt": null,
        "exitCode": null,
        "exitSignal": null,
        "logs": [],
    })
}

type Shared = Arc<Mutex<Entry>>;

/// The previews by customization id (`globalThis.__claudiusPreviewEntries`).
static ENTRIES: LazyLock<Mutex<HashMap<String, Shared>>> =
    LazyLock::new(|| Mutex::new(HashMap::new()));
/// Every entry whose child may still run, tracked or not (for [`shutdown`]).
static SPAWNED: Mutex<Vec<Shared>> = Mutex::new(Vec::new());
/// Starts and restarts, one at a time.
static OPS: tokio::sync::Mutex<()> = tokio::sync::Mutex::const_new(());
/// The port this server listens on; 0 for none.
static RESERVED: AtomicU16 = AtomicU16::new(0);

fn guard<T>(m: &Mutex<T>) -> std::sync::MutexGuard<'_, T> {
    m.lock().unwrap_or_else(PoisonError::into_inner)
}

/// Never offer `port` to a preview: the server's own (see the module doc).
pub fn reserve_port(port: u16) {
    RESERVED.store(port, Ordering::SeqCst);
}

/// The preview port range: [`PORTS_ENV`] when it is a valid `S-E`, else
/// 3100-3199. Read once.
fn port_range() -> (u16, u16) {
    static RANGE: LazyLock<(u16, u16)> = LazyLock::new(|| {
        std::env::var(PORTS_ENV)
            .ok()
            .and_then(|v| parse_range(&v))
            .unwrap_or((PORT_START, PORT_END))
    });
    *RANGE
}

fn parse_range(v: &str) -> Option<(u16, u16)> {
    let (a, b) = v.split_once('-')?;
    let (a, b): (u16, u16) = (a.trim().parse().ok()?, b.trim().parse().ok()?);
    (a >= 1 && a <= b).then_some((a, b))
}

/// `getPreviewState(id)`.
pub fn get_preview_state(customization_id: &str) -> Value {
    match guard(&ENTRIES).get(customization_id).cloned() {
        Some(e) => guard(&e).snapshot(),
        None => blank(customization_id),
    }
}

// ---- ports and squatters ---------------------------------------------------------

/// `isPortFree(port)`: `listen({port})` with no host. Node binds `::`
/// (dual-stack) with `SO_REUSEADDR`, falls back to `0.0.0.0` when that bind
/// fails, then listens (backlog 511); any error is "taken".
async fn is_port_free(port: u16) -> bool {
    let bind = |addr: SocketAddr| -> std::io::Result<TcpSocket> {
        let s = if addr.is_ipv6() {
            TcpSocket::new_v6()?
        } else {
            TcpSocket::new_v4()?
        };
        s.set_reuseaddr(true)?;
        s.bind(addr)?;
        Ok(s)
    };
    let socket = match bind(SocketAddr::from((Ipv6Addr::UNSPECIFIED, port))) {
        Ok(s) => s,
        Err(_) => match bind(SocketAddr::from((Ipv4Addr::UNSPECIFIED, port))) {
            Ok(s) => s,
            Err(_) => return false,
        },
    };
    socket.listen(511).is_ok()
}

/// `pickFreePort()`: the first free port of the range.
async fn pick_free_port() -> anyhow::Result<u16> {
    let (start, end) = port_range();
    let reserved = RESERVED.load(Ordering::SeqCst);
    for p in start..=end {
        if p != reserved && is_port_free(p).await {
            return Ok(p);
        }
    }
    bail!("no free port in {start}-{end}")
}

/// `pidsOnPort(port)`: `lsof -nP -iTCP -iTCP:<port> -sTCP:LISTEN -t` (3 s),
/// each line through `Number(s.trim())`, the finite positive ones; any
/// failure (no `lsof`, exit 1 for none) is none.
async fn pids_on_port(port: u16) -> Vec<f64> {
    let filter = format!("-iTCP:{port}");
    let opts = ExecFileOptions {
        timeout_ms: LSOF_TIMEOUT_MS,
        ..ExecFileOptions::default()
    };
    match exec_file(
        "lsof",
        &["-nP", "-iTCP", &filter, "-sTCP:LISTEN", "-t"],
        opts,
    )
    .await
    {
        Ok(out) => out
            .stdout
            .split('\n')
            .map(|s| js::to_number(js::trim(s)))
            .filter(|n| n.is_finite() && *n > 0.0)
            .collect(),
        Err(_) => Vec::new(),
    }
}

/// `process.kill(pid, sig)` returning instead of throwing: a pid that isn't
/// an int32 throws `ERR_INVALID_ARG_TYPE`, a failed `kill(2)` its errno.
#[cfg(unix)]
fn kill_pid(pid: f64, sig: i32) -> bool {
    let p = pid as i32;
    if f64::from(p) != pid {
        return false;
    }
    // SAFETY: kill(2) with a positive pid only signals that process.
    unsafe { libc::kill(p, sig) == 0 }
}

#[cfg(not(unix))]
fn kill_pid(_pid: f64, _sig: i32) -> bool {
    false
}

#[cfg(unix)]
const SIGTERM: i32 = libc::SIGTERM;
#[cfg(unix)]
const SIGKILL: i32 = libc::SIGKILL;
#[cfg(not(unix))]
const SIGTERM: i32 = 15;
#[cfg(not(unix))]
const SIGKILL: i32 = 9;

/// `killSquatters(port)`: SIGTERM every pid `lsof` lists for the port (ours
/// included); when any went, SIGKILL those still listed 800 ms later. The
/// number SIGTERMed.
async fn kill_squatters(port: u16) -> usize {
    let mut killed = 0;
    for pid in pids_on_port(port).await {
        if kill_pid(pid, SIGTERM) {
            killed += 1;
        }
    }
    if killed == 0 {
        return 0;
    }
    tokio::time::sleep(SQUAT_GRACE).await;
    for pid in pids_on_port(port).await {
        kill_pid(pid, SIGKILL);
    }
    killed
}

/// `sweepStaleListeners()`: [`kill_squatters`] over the whole range, sparing
/// every tracked preview's pid (exited ones too), this process and its
/// parent.
async fn sweep_stale_listeners() -> usize {
    let mut owned: Vec<f64> = guard(&ENTRIES)
        .values()
        .filter_map(|e| guard(e).pid)
        .map(f64::from)
        .collect();
    owned.push(f64::from(std::process::id()));
    #[cfg(unix)]
    {
        let parent = std::os::unix::process::parent_id();
        if parent > 0 {
            owned.push(f64::from(parent));
        }
    }
    let (start, end) = port_range();
    let mut killed = 0;
    for p in start..=end {
        for pid in pids_on_port(p).await {
            if !owned.contains(&pid) && kill_pid(pid, SIGTERM) {
                killed += 1;
            }
        }
    }
    if killed > 0 {
        tokio::time::sleep(SQUAT_GRACE).await;
        for p in start..=end {
            for pid in pids_on_port(p).await {
                if !owned.contains(&pid) {
                    kill_pid(pid, SIGKILL);
                }
            }
        }
    }
    killed
}

// ---- the child's runtime and env -------------------------------------------------

fn exists(p: &str) -> bool {
    std::fs::metadata(p).is_ok()
}

/// `resolveNodeDir()` for this process ([`resolve_node_dir_in`]).
fn resolve_node_dir() -> Option<String> {
    let exe = std::env::current_exe()
        .ok()
        .map(|p| p.to_string_lossy().into_owned());
    let path = std::env::var_os("PATH").map(|v| v.to_string_lossy().into_owned());
    resolve_node_dir_in(exe.as_deref(), path.as_deref(), exists)
}

/// `resolveNodeDir()` over a `process.execPath`, `PATH` and `existsSync`:
/// the exec path's dir when its name starts with `node` (any case), else
/// the first `PATH` entry (as written) holding a `node`, else the first of
/// `/opt/homebrew/bin`, `/usr/local/bin`, `/usr/bin` that does.
pub fn resolve_node_dir_in(
    exec_path: Option<&str>,
    path: Option<&str>,
    exists: impl Fn(&str) -> bool,
) -> Option<String> {
    if let Some(exe) = exec_path
        && node_path::basename(exe).to_lowercase().starts_with("node")
    {
        return Some(node_path::dirname(exe));
    }
    let on_path = path.unwrap_or("").split(':');
    let fixed = ["/opt/homebrew/bin", "/usr/local/bin", "/usr/bin"];
    on_path
        .chain(fixed)
        .find(|dir| !dir.is_empty() && exists(&node_path::join(&[dir, "node"])))
        .map(str::to_owned)
}

/// `resolveBun()` over `HOME`, `PATH` and `existsSync`:
/// `$HOME/.bun/bin/bun`, else `<dir>/bun` for the first `PATH` entry that
/// has one (joined, so normalized).
pub fn resolve_bun_in(
    home: Option<&str>,
    path: Option<&str>,
    exists: impl Fn(&str) -> bool,
) -> Option<String> {
    let home = home.unwrap_or("");
    if !home.is_empty() {
        let bun = node_path::join(&[home, ".bun", "bin", "bun"]);
        if exists(&bun) {
            return Some(bun);
        }
    }
    path.unwrap_or("")
        .split(':')
        .filter(|dir| !dir.is_empty())
        .map(|dir| node_path::join(&[dir, "bun"]))
        .find(|bun| exists(bun))
}

/// `buildPreviewEnv(port)`: this process's env without `__NEXT_PRIVATE_*`,
/// `TURBOPACK`, `CLAUDIUS_PACKAGED`, `CLAUDIUS_ELECTRON` and
/// `NEXT_DEPLOYMENT_ID`, with `NODE_ENV=development`,
/// `NEXT_TELEMETRY_DISABLED=1`, `PORT=<port>`, and a `node` dir first on
/// `PATH`.
pub fn build_preview_env(port: u16) -> Vec<(OsString, OsString)> {
    const DROPPED: [&str; 4] = [
        "TURBOPACK",
        "CLAUDIUS_PACKAGED",
        "CLAUDIUS_ELECTRON",
        "NEXT_DEPLOYMENT_ID",
    ];
    let mut env: Vec<(OsString, OsString)> = std::env::vars_os()
        .filter(|(k, _)| {
            let k = k.to_string_lossy();
            !k.starts_with("__NEXT_PRIVATE_") && !DROPPED.contains(&k.as_ref())
        })
        .collect();
    let mut set = |key: &str, value: String| match env.iter().position(|(k, _)| k == key) {
        Some(i) => env[i].1 = value.into(),
        None => env.push((key.into(), value.into())),
    };
    set("NODE_ENV", "development".into());
    set("NEXT_TELEMETRY_DISABLED", "1".into());
    set("PORT", port.to_string());
    if let Some(dir) = resolve_node_dir() {
        let path = std::env::var_os("PATH").map(|v| v.to_string_lossy().into_owned());
        set(
            "PATH",
            match path.as_deref() {
                Some(p) if !p.is_empty() => format!("{dir}:{p}"),
                _ => dir,
            },
        );
    }
    env
}

/// What `spawnSync` gives back: `status` (`null` after a signal, a kill or
/// a failed spawn) and the bytes of each stream.
struct SyncRun {
    status: Option<i32>,
    stdout: Vec<u8>,
    stderr: Vec<u8>,
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

/// Signal our own child, if it hasn't been reaped yet.
#[cfg(unix)]
fn signal_child(child: &tokio::process::Child, sig: i32) -> bool {
    child
        .id()
        .and_then(|pid| i32::try_from(pid).ok())
        // SAFETY: the child is ours and not reaped (`id()` is `Some`).
        .is_some_and(|pid| unsafe { libc::kill(pid, sig) } == 0)
}

#[cfg(not(unix))]
fn signal_child(_child: &tokio::process::Child, _sig: i32) -> bool {
    false
}

/// `spawnSync(file, args, {cwd, env, stdio: ["ignore", "pipe", "pipe"],
/// timeout})` without blocking: past the timeout, or past 1 MiB of output
/// in all (the chunk that crossed kept), the child gets SIGTERM and its
/// pipes are closed; it is still waited for.
async fn spawn_sync(
    file: &str,
    args: &[&str],
    cwd: &str,
    env: Vec<(OsString, OsString)>,
    timeout: Duration,
) -> SyncRun {
    let mut cmd = tokio::process::Command::new(file);
    cmd.args(args)
        .current_dir(cwd)
        .env_clear()
        .envs(env)
        .stdin(Stdio::null())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped());
    let Ok(mut child) = cmd.spawn() else {
        return SyncRun {
            status: None,
            stdout: Vec::new(),
            stderr: Vec::new(),
        };
    };
    let (mut so, mut se) = (child.stdout.take(), child.stderr.take());
    let (mut stdout, mut stderr) = (Vec::new(), Vec::new());
    let (mut ob, mut eb) = (vec![0u8; READ_CHUNK], vec![0u8; READ_CHUNK]);
    let mut exit: Option<std::io::Result<ExitStatus>> = None;
    let mut killed = false;
    let deadline = tokio::time::sleep(timeout);
    tokio::pin!(deadline);
    while so.is_some() || se.is_some() || exit.is_none() {
        tokio::select! {
            biased;
            r = read_some(&mut so, &mut ob), if so.is_some() => match r {
                Ok(n) if n > 0 => stdout.extend_from_slice(&ob[..n]),
                _ => so = None,
            },
            r = read_some(&mut se, &mut eb), if se.is_some() => match r {
                Ok(n) if n > 0 => stderr.extend_from_slice(&eb[..n]),
                _ => se = None,
            },
            st = child.wait(), if exit.is_none() => exit = Some(st),
            () = &mut deadline, if !killed => killed = true,
        }
        if !killed && stdout.len() + stderr.len() > SPAWN_SYNC_MAX_BUFFER {
            killed = true;
        }
        if killed && (so.is_some() || se.is_some()) {
            if exit.is_none() {
                signal_child(&child, SIGTERM);
            }
            (so, se) = (None, None);
        }
    }
    let status = match exit {
        Some(Ok(s)) => exit_of(s).0.filter(|_| !signaled(s)),
        _ => None,
    };
    SyncRun {
        status,
        stdout,
        stderr,
    }
}

#[cfg(unix)]
fn signaled(s: ExitStatus) -> bool {
    use std::os::unix::process::ExitStatusExt;
    s.signal().is_some()
}

#[cfg(not(unix))]
fn signaled(_s: ExitStatus) -> bool {
    false
}

/// Node's `exit` arguments: `(code, null)`, or `(null, "SIG…")`; a signal
/// Node has no name for reads `(0, null)`.
#[cfg(unix)]
fn exit_of(s: ExitStatus) -> (Option<i32>, Option<&'static str>) {
    use std::os::unix::process::ExitStatusExt;
    match (s.code(), s.signal()) {
        (Some(c), _) => (Some(c), None),
        (None, Some(sig)) => match claudius_agent::signal_name(sig) {
            Some(name) => (None, Some(name)),
            None => (Some(0), None),
        },
        (None, None) => (None, None),
    }
}

#[cfg(not(unix))]
fn exit_of(s: ExitStatus) -> (Option<i32>, Option<&'static str>) {
    (s.code(), None)
}

/// `ensureMirrorDeps(srcDir)`: nothing when the mirror has the dev
/// toolchain (`next/dist/cli/next-dev.js` and `@tailwindcss/postcss`);
/// else, with a `bun`, remove the packages the packaged app ships stripped
/// (`next`, `react`, `react-dom`, `scheduler`, `.bin`) and `bun install`
/// in the mirror. The line for the log.
async fn ensure_mirror_deps(root: &str, src_dir: &str) -> Option<String> {
    let base = format!("{root}/");
    let nm = node_path::join(&[src_dir, "node_modules"]);
    let cli = node_path::resolve(&[&nm, "next", "dist", "cli", "next-dev.js"]);
    let postcss = node_path::resolve(&[&nm, "@tailwindcss", "postcss"]);
    if !cli.starts_with(&base) || !postcss.starts_with(&base) {
        return None;
    }
    if exists(&cli) && exists(&postcss) {
        return None;
    }
    let home = std::env::var_os("HOME").map(|v| v.to_string_lossy().into_owned());
    let path = std::env::var_os("PATH").map(|v| v.to_string_lossy().into_owned());
    let Some(bun) = resolve_bun_in(home.as_deref(), path.as_deref(), exists) else {
        return Some(NO_BUN.to_owned());
    };
    for p in ["next", "react", "react-dom", "scheduler", ".bin"] {
        let target = node_path::resolve(&[&nm, p]);
        if !target.starts_with(&base) {
            continue;
        }
        // Best-effort, as the TS `try { rmSync } catch {}`.
        let _ = node_fs::rm_recursive_force(&target);
    }
    let cwd = node_path::resolve(&[src_dir]);
    if !cwd.starts_with(&base) {
        return None;
    }
    let res = spawn_sync(&bun, &["install"], &cwd, build_preview_env(0), BUN_TIMEOUT).await;
    if res.status != Some(0) {
        let text = format!(
            "{}{}",
            String::from_utf8_lossy(&res.stdout),
            String::from_utf8_lossy(&res.stderr)
        );
        let lines: Vec<&str> = text
            .split('\n')
            .map(|l| l.strip_suffix('\r').unwrap_or(l))
            .filter(|l| !l.is_empty())
            .collect();
        let tail = lines[lines.len().saturating_sub(3)..].join(" | ");
        let code = res
            .status
            .map_or_else(|| "null".to_owned(), |c| c.to_string());
        return Some(format!("bun install failed (code {code}): {tail}"));
    }
    Some("installed preview dependencies".to_owned())
}

// ---- start / stop / restart -------------------------------------------------------

/// `startPreview(id)` for the customization store `store`, mirroring
/// `node_modules` from the live source dir `live`. Throws the TS errors
/// (their `message` is the 500's `error`). Needs a tokio runtime.
pub async fn start_preview(
    store: &Store,
    live: &str,
    customization_id: &str,
) -> anyhow::Result<Value> {
    let _ops = OPS.lock().await;
    start_locked(store, live, customization_id).await
}

async fn start_locked(store: &Store, live: &str, customization_id: &str) -> anyhow::Result<Value> {
    let existing = guard(&ENTRIES).get(customization_id).cloned();
    let mut old_port = None;
    if let Some(e) = &existing {
        let e = guard(e);
        if e.status.running() {
            return Ok(e.snapshot());
        }
        old_port = Some(e.port);
    }
    // A tracked exited run is dropped, so a fresh log buffer starts clean.
    if existing.is_some() {
        guard(&ENTRIES).remove(customization_id);
    }
    let base = format!("{}/", store.root());
    let src_dir = store.customization_src_dir(customization_id);
    let src = node_path::resolve(&[&src_dir]);
    if !src.starts_with(&base) {
        bail!("path outside allowed root");
    }
    if !std::fs::metadata(&src).is_ok_and(|m| m.is_dir()) {
        bail!("customization {customization_id} has no src/ dir");
    }
    // Self-heal an older bootstrap's `node_modules` symlink (or a missing one).
    let (l, s) = (live.to_owned(), src_dir.clone());
    tokio::task::spawn_blocking(move || ensure_node_modules_mirror(&l, &s))
        .await
        .map_err(|e| anyhow!("{e}"))?
        .map_err(|e| anyhow!(e.message))?;
    let dep_msg = ensure_mirror_deps(store.root(), &src_dir).await;
    if let Some(p) = old_port {
        kill_squatters(p).await;
    }
    let port = pick_free_port().await?;
    // Something may have raced in between the probe and the spawn.
    kill_squatters(port).await;

    let next_bin = node_path::join(&[&src_dir, "node_modules", ".bin", "next"]);
    if !node_path::resolve(&[&next_bin]).starts_with(&base) {
        bail!("path outside allowed root");
    }
    let mut cmd = tokio::process::Command::new(&next_bin);
    cmd.args(["dev", "-p", &port.to_string()])
        .current_dir(&src)
        .env_clear()
        .envs(build_preview_env(port))
        .stdin(Stdio::null())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped());
    let spawned = cmd.spawn();
    if let Err(e) = &spawned
        && !matches!(
            claudius_agent::binary::node_error_code(e).as_deref(),
            Some("EACCES" | "EAGAIN" | "EMFILE" | "ENFILE" | "ENOENT")
        )
    {
        bail!(crate::git::spawn_message(&next_bin, e));
    }
    let (tx, rx) = mpsc::unbounded_channel();
    let entry: Shared = Arc::new(Mutex::new(Entry {
        customization_id: customization_id.to_owned(),
        port,
        pid: spawned.as_ref().ok().and_then(tokio::process::Child::id),
        status: Status::Starting,
        started_at: now_ms(),
        logs: Vec::new(),
        exit_code: None,
        exit_signal: None,
        error_message: None,
        signals: Some(tx),
    }));
    guard(&ENTRIES).insert(customization_id.to_owned(), entry.clone());
    if let Some(m) = dep_msg {
        guard(&entry).push_log(&format!("[deps] {m}"));
    }
    let state = guard(&entry).snapshot();
    match spawned {
        Ok(child) => {
            {
                let mut all = guard(&SPAWNED);
                all.retain(|e| guard(e).status.running());
                all.push(entry.clone());
            }
            tokio::spawn(watch(child, entry, rx));
        }
        // The child's `error` event, a tick after the call returned.
        Err(e) => {
            let message = crate::git::spawn_message(&next_bin, &e);
            let mut e = guard(&entry);
            e.status = Status::Error;
            e.error_message = Some(message.clone());
            e.push_log(&format!("[spawn error] {message}"));
        }
    }
    Ok(state)
}

/// The child's `data` and `exit` handlers, and the signals sent to it,
/// until both pipes close and it is reaped. `biased`, as in
/// [`crate::customization_build`]: stdout before stderr, and the exit only
/// once neither pipe has anything ready.
async fn watch(
    mut child: tokio::process::Child,
    entry: Shared,
    mut signals: mpsc::UnboundedReceiver<Signal>,
) {
    let mut stdout = child.stdout.take();
    let mut stderr = child.stderr.take();
    let (mut ob, mut eb) = (vec![0u8; READ_CHUNK], vec![0u8; READ_CHUNK]);
    let mut exited = false;
    while stdout.is_some() || stderr.is_some() || !exited {
        tokio::select! {
            biased;
            r = read_some(&mut stdout, &mut ob), if stdout.is_some() => match r {
                Ok(n) if n > 0 => guard(&entry).push_log(&String::from_utf8_lossy(&ob[..n])),
                _ => stdout = None,
            },
            r = read_some(&mut stderr, &mut eb), if stderr.is_some() => match r {
                Ok(n) if n > 0 => guard(&entry).push_log(&String::from_utf8_lossy(&eb[..n])),
                _ => stderr = None,
            },
            Some(Signal(sig, done)) = signals.recv() => {
                let _ = done.send(signal_child(&child, sig));
            }
            status = child.wait(), if !exited => {
                exited = true;
                let (code, signal) = status.map_or((None, None), exit_of);
                let mut e = guard(&entry);
                e.status = Status::Exited;
                e.exit_code = code;
                e.exit_signal = signal;
                let code = code.map_or_else(|| "null".to_owned(), |c| c.to_string());
                e.push_log(&format!("[exit] code={code} signal={}", signal.unwrap_or("-")));
            }
        }
    }
}

/// Send `sig` to the entry's child through its watcher; whether it went.
async fn send_signal(entry: &Shared, sig: i32) -> bool {
    let Some(tx) = guard(entry).signals.clone() else {
        return false;
    };
    let (done, went) = oneshot::channel();
    if tx.send(Signal(sig, done)).is_err() {
        return false;
    }
    went.await.unwrap_or(false)
}

/// `stopPreview(id)`: SIGTERM a running preview; the state as it was.
pub async fn stop_preview(customization_id: &str) -> Value {
    let Some(entry) = guard(&ENTRIES).get(customization_id).cloned() else {
        return blank(customization_id);
    };
    let (state, running) = {
        let e = guard(&entry);
        (e.snapshot(), e.status.running())
    };
    if running {
        send_signal(&entry, SIGTERM).await;
    }
    state
}

/// `restartPreview(id)`: stop a running preview and give it 600 ms, reap
/// its old port, sweep the range, then start afresh.
pub async fn restart_preview(
    store: &Store,
    live: &str,
    customization_id: &str,
) -> anyhow::Result<Value> {
    let _ops = OPS.lock().await;
    let existing = guard(&ENTRIES).get(customization_id).cloned();
    let (running, old_port) = match &existing {
        Some(e) => {
            let e = guard(e);
            (e.status.running(), Some(e.port))
        }
        None => (false, None),
    };
    if running {
        stop_preview(customization_id).await;
        tokio::time::sleep(RESTART_GRACE).await;
    }
    if let Some(p) = old_port {
        kill_squatters(p).await;
    }
    sweep_stale_listeners().await;
    guard(&ENTRIES).remove(customization_id);
    start_locked(store, live, customization_id).await
}

/// At server shutdown (TS: the `exit` / `SIGINT` / `SIGTERM` hooks): SIGTERM
/// every child still running, tracked or replaced, then SIGKILL the ones
/// alive 3 s later.
pub async fn shutdown() {
    let live = || -> Vec<Shared> {
        guard(&SPAWNED)
            .iter()
            .filter(|e| guard(e).status.running())
            .cloned()
            .collect()
    };
    let running = live();
    if running.is_empty() {
        return;
    }
    for e in &running {
        send_signal(e, SIGTERM).await;
    }
    let deadline = tokio::time::Instant::now() + SHUTDOWN_GRACE;
    while !live().is_empty() && tokio::time::Instant::now() < deadline {
        tokio::time::sleep(Duration::from_millis(50)).await;
    }
    let left = live();
    for e in &left {
        send_signal(e, SIGKILL).await;
    }
    let deadline = tokio::time::Instant::now() + Duration::from_secs(1);
    while !live().is_empty() && tokio::time::Instant::now() < deadline {
        tokio::time::sleep(Duration::from_millis(20)).await;
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn entry() -> Entry {
        Entry {
            customization_id: "c".into(),
            port: 3100,
            pid: Some(7),
            status: Status::Starting,
            started_at: 5,
            logs: Vec::new(),
            exit_code: None,
            exit_signal: None,
            error_message: None,
            signals: None,
        }
    }

    #[test]
    fn readiness_is_the_ts_regex() {
        for yes in [
            "ready",
            "Ready in 5ms",
            "- READY -",
            "ready-made",
            "x ready",
            "started server on 0.0.0.0",
            "STARTED SERVER",
            "Listening on :3000",
            "\u{e9}ready\u{e9}",
            "(listening)",
        ] {
            assert!(is_ready_line(yes), "{yes}");
        }
        for no in [
            "",
            "Already",
            "readyz",
            "x_ready",
            "ready_",
            "ready1",
            "unready",
            "started  server",
            "started_server",
            "startedserver",
            "listen",
            "listenings",
            "re ady",
            "\u{17f}tarted server",
            "rea\u{2d9}dy",
        ] {
            assert!(!is_ready_line(no), "{no}");
        }
    }

    #[test]
    fn logs_split_per_chunk_flip_ready_and_keep_the_last_200() {
        let mut e = entry();
        e.push_log("a\r\nb\n\n\rc\r\r\n");
        assert_eq!(e.logs, ["a", "b", "\rc\r"]);
        assert_eq!(e.status, Status::Starting);
        e.push_log("x\nnow ready\ny");
        assert_eq!(e.status, Status::Ready);
        for i in 0..300 {
            e.push_log(&format!("{i}\n"));
        }
        assert_eq!(e.logs.len(), 200);
        assert_eq!(e.logs[0], "100");
        // Only `starting` turns `ready`.
        let mut e = entry();
        e.status = Status::Error;
        e.push_log("ready");
        assert_eq!(e.status, Status::Error);
    }

    #[test]
    fn snapshots_keep_the_ts_key_order() {
        let mut e = entry();
        assert_eq!(
            js::stringify(&e.snapshot()),
            r#"{"customizationId":"c","status":"starting","port":3100,"pid":7,"startedAt":5,"exitCode":null,"exitSignal":null,"logs":[]}"#
        );
        e.error_message = Some(String::new());
        e.exit_signal = Some("SIGTERM");
        assert_eq!(
            js::stringify(&e.snapshot()),
            r#"{"customizationId":"c","status":"starting","port":3100,"pid":7,"startedAt":5,"exitCode":null,"exitSignal":"SIGTERM","errorMessage":"","logs":[]}"#
        );
        assert_eq!(
            js::stringify(&blank("x")),
            r#"{"customizationId":"x","status":"exited","port":null,"pid":null,"startedAt":null,"exitCode":null,"exitSignal":null,"logs":[]}"#
        );
    }

    #[test]
    fn the_node_dir_order_is_the_ts_order() {
        let has = |set: &'static [&'static str]| move |p: &str| set.contains(&p);
        let none: &[&str] = &[];
        let d = |s: &str| Some(s.to_owned());
        assert_eq!(
            resolve_node_dir_in(Some("/x/Node22"), None, has(none)),
            d("/x")
        );
        assert_eq!(
            resolve_node_dir_in(Some("/x/NODE.exe"), Some("/b"), has(&["/b/node"])),
            d("/x")
        );
        assert_eq!(
            resolve_node_dir_in(Some("/x/nodejs/bin/claudius"), None, has(none)),
            None
        );
        assert_eq!(
            resolve_node_dir_in(
                Some("/x/claudius"),
                Some(":/a:/b//c/:/d"),
                has(&["/b/c/node", "/d/node"])
            ),
            d("/b//c/")
        );
        assert_eq!(
            resolve_node_dir_in(
                None,
                Some("/a"),
                has(&["/usr/local/bin/node", "/usr/bin/node"])
            ),
            d("/usr/local/bin")
        );
        assert_eq!(
            resolve_node_dir_in(None, None, has(&["/opt/homebrew/bin/node"])),
            d("/opt/homebrew/bin")
        );
        assert_eq!(resolve_node_dir_in(None, Some(""), has(&["node"])), None);
    }

    #[test]
    fn bun_comes_from_home_then_path() {
        let has = |set: &'static [&'static str]| move |p: &str| set.contains(&p);
        let d = |s: &str| Some(s.to_owned());
        assert_eq!(
            resolve_bun_in(Some("/h"), Some("/p"), has(&["/h/.bun/bin/bun", "/p/bun"])),
            d("/h/.bun/bin/bun")
        );
        assert_eq!(
            resolve_bun_in(Some(""), Some("/p"), has(&[".bun/bin/bun", "/p/bun"])),
            d("/p/bun")
        );
        assert_eq!(
            resolve_bun_in(None, Some("::/q/./r/:/p"), has(&["/q/r/bun"])),
            d("/q/r/bun")
        );
        assert_eq!(resolve_bun_in(None, None, has(&["bun"])), None);
    }

    #[test]
    fn port_ranges_parse_or_fall_back() {
        assert_eq!(parse_range("20000-20005"), Some((20000, 20005)));
        assert_eq!(parse_range(" 7 - 7 "), Some((7, 7)));
        for bad in ["", "1", "0-5", "6-5", "a-b", "1-70000", "1-2-3"] {
            assert_eq!(parse_range(bad), None, "{bad}");
        }
    }

    #[cfg(unix)]
    #[test]
    fn process_kill_takes_only_int32_pids() {
        let me = f64::from(std::process::id());
        assert!(kill_pid(me, 0));
        assert!(!kill_pid(me + 0.5, 0));
        assert!(!kill_pid(2_147_483_648.0, 0));
        assert!(!kill_pid(4_294_967_296.0 + me, 0));
        assert!(!kill_pid(2_147_483_647.0, 0));
    }
}
