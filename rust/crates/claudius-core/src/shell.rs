//! `lib/server/shell.ts`: `execShellCommand`, the one-shot `/bin/bash -c`
//! behind `POST /api/workspaces/:id/shell` (the Git page's console prompt).
//! It opens no terminal: each request runs one non-interactive shell and
//! answers with what it printed.
//!
//! As in Node's `spawn(SHELL_PATH, ["-c", command], {cwd, env: process.env,
//! detached: true})`:
//! - the shell inherits the server's environment and leads its own session
//!   (`setsid`), so the timeout's signals reach the whole process group:
//!   `SIGTERM`, then `SIGKILL` 1.5 s later for anything that ignored it
//!   (CC 2.1.300, [`crate::process_group`]), so a `&` job that traps TERM
//!   can't hold the stdio pipes — and the answer — open for ever;
//! - stdin, stdout and stderr are `AF_UNIX` socket pairs, as libuv makes
//!   them (not pipes); stdin stays open until the shell exits (or is fed
//!   `stdin` and shut), the outputs are decoded like `setEncoding("utf8")`;
//! - each stream keeps its first `maxOutputBytes` UTF-16 units (a cut
//!   through a surrogate pair keeps the lone high half, as a
//!   [`js_string`] stand-in) and `truncated` says something was dropped;
//! - the result comes at Node's `close`: the shell has exited and both
//!   streams have ended, so a background job holding them open holds the
//!   answer too (until the timeout kills its group). The run is its own
//!   task, so a caller that goes away doesn't stop the reads or the timeout;
//! - a spawn error libuv reports after the fact (`ENOENT`, `EACCES`,
//!   `EAGAIN`, `EMFILE`, `ENFILE`, e.g. a missing cwd) is a result with the
//!   message in `stderr`; any other one (`ENOTDIR`, `ELOOP`,
//!   `ENAMETOOLONG`, …), a NUL in the command or a cwd `spawn()` refuses
//!   throws ([`Err`]).
//!
//! Replayed against the TS in `tests/shell_golden.rs` (the module with its
//! test options) and `claudius-server/tests/workspace_roots.rs` (the route).

use std::process::Stdio;
use std::time::Duration;

use claudius_agent::{Utf8Decoder, js};
use serde_json::{Map, Value, json};
use tokio::io::{AsyncRead, AsyncReadExt, AsyncWrite, AsyncWriteExt};

use crate::js_string::{self, lossy};

/// `MAX_OUTPUT_BYTES`, which JS measures as a string length: UTF-16 units,
/// per stream.
pub const MAX_OUTPUT_UNITS: usize = 16 * 1024 * 1024;
/// `DEFAULT_TIMEOUT_MS`.
pub const DEFAULT_TIMEOUT_MS: u64 = 120_000;
/// `SHELL_PATH`.
pub const SHELL_PATH: &str = "/bin/bash";
const READ_CHUNK: usize = 64 * 1024;

/// `ShellExecResult`.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct ShellExecResult {
    pub stdout: String,
    pub stderr: String,
    pub truncated: bool,
    /// The exit code; -1 after a signal or a spawn error.
    pub exit_code: i64,
    pub signal: Option<&'static str>,
}

impl ShellExecResult {
    /// The object TS resolves with, in its key order. Print it with
    /// [`js_string::stringify`] so a cut surrogate is written as an escape.
    pub fn to_json(&self) -> Value {
        json!({
            "stdout": self.stdout,
            "stderr": self.stderr,
            "truncated": self.truncated,
            "exitCode": self.exit_code,
            "signal": self.signal,
        })
    }
}

/// `execShellCommand`'s `opts`; the route passes none.
#[derive(Clone, Debug, Default, PartialEq, Eq)]
pub struct ShellOpts {
    /// `timeoutMs` (default [`DEFAULT_TIMEOUT_MS`]).
    pub timeout_ms: Option<u64>,
    /// `maxOutputBytes`, in UTF-16 units (default [`MAX_OUTPUT_UNITS`]).
    pub max_output_units: Option<usize>,
    /// `stdin`: written as UTF-8, then the pipe is closed.
    pub stdin: Option<String>,
}

/// `options.cwd` as `spawn()` takes it.
#[derive(Clone, Debug, PartialEq, Eq)]
pub enum SpawnCwd {
    /// No cwd (`undefined`, `null` or `""`): the server's own.
    Inherit,
    Dir(String),
}

/// `normalizeSpawnArguments`' check of `options.cwd` (`getValidatedPath`)
/// for a JSON value (`None` is `undefined`): a string, or a URL-like object
/// (`isURL`: a truthy `href` and `protocol`, no `auth` or `path` key) whose
/// `file:` URL `fileURLToPath` turns into a path. Anything else, or a path
/// with a NUL, throws; `Err` is the message (it only reaches the log).
pub fn spawn_cwd(value: Option<&Value>) -> Result<SpawnCwd, String> {
    let path = match value {
        None | Some(Value::Null) => return Ok(SpawnCwd::Inherit),
        Some(Value::String(s)) => s.clone(),
        Some(Value::Object(o)) if is_url(o) => file_url_to_path(o)?,
        Some(other) => {
            return Err(format!(
                "The \"options.cwd\" property must be of type string or an instance of Buffer or URL. Received {}",
                received(other)
            ));
        }
    };
    if path.contains('\0') {
        return Err(format!(
            "The property 'options.cwd' must be a string, Uint8Array, or URL without null bytes. Received {}",
            crate::git::node_inspect_string(&path)
        ));
    }
    // libuv only changes directory for a non-empty cwd.
    Ok(if path.is_empty() {
        SpawnCwd::Inherit
    } else {
        SpawnCwd::Dir(path)
    })
}

/// Node's `isURL(self)`.
fn is_url(o: &Map<String, Value>) -> bool {
    o.get("href").is_some_and(js::truthy)
        && o.get("protocol").is_some_and(js::truthy)
        && !o.contains_key("auth")
        && !o.contains_key("path")
}

/// `fileURLToPath(url)` on POSIX for a URL-like object. Only a string
/// `pathname` is followed; TS would also `String()` other values.
fn file_url_to_path(o: &Map<String, Value>) -> Result<String, String> {
    if o.get("protocol").and_then(Value::as_str) != Some("file:") {
        return Err("The URL must be of scheme file".into());
    }
    if o.get("hostname").and_then(Value::as_str) != Some("") {
        return Err(format!(
            "File URL host must be \"localhost\" or empty on {}",
            crate::tcc_protected::platform()
        ));
    }
    let Some(Value::String(pathname)) = o.get("pathname") else {
        return Err("Cannot read the URL's pathname".into());
    };
    if pathname.contains("%2f") || pathname.contains("%2F") {
        return Err("File URL path must not include encoded / characters".into());
    }
    js_string::decode_uri_component(pathname).ok_or_else(|| "URI malformed".into())
}

/// The `Received …` tail of `ERR_INVALID_ARG_TYPE`.
fn received(v: &Value) -> String {
    match v {
        Value::Bool(b) => format!("type boolean ({b})"),
        Value::Number(n) => format!("type number ({n})"),
        Value::Array(_) => "an instance of Array".into(),
        _ => "an instance of Object".into(),
    }
}

/// How Node reports a failed `spawn()`.
#[derive(Clone, Debug, PartialEq, Eq)]
pub enum SpawnFailure {
    /// A run-time error (`EACCES`, `EAGAIN`, `EMFILE`, `ENFILE`, `ENOENT`):
    /// the child's `error` event, `spawn <file> <CODE>`.
    Emitted(String),
    /// Any other: `spawn()` throws `spawn <CODE>`.
    Thrown(String),
}

/// Classify a spawn error the way `ChildProcess.prototype.spawn` does.
pub fn spawn_failure(file: &str, e: &std::io::Error) -> SpawnFailure {
    match claudius_agent::binary::node_error_code(e) {
        Some(code)
            if matches!(
                code.as_str(),
                "EACCES" | "EAGAIN" | "EMFILE" | "ENFILE" | "ENOENT"
            ) =>
        {
            SpawnFailure::Emitted(format!("spawn {file} {code}"))
        }
        Some(code) => SpawnFailure::Thrown(format!("spawn {code}")),
        None => SpawnFailure::Thrown(e.to_string()),
    }
}

/// One stream's text, as the `data` listener builds it.
#[derive(Default)]
struct Capture {
    text: String,
    /// The JS `length` of `text`.
    units: usize,
    decoder: Utf8Decoder,
}

impl Capture {
    /// One `data` chunk (Node never emits an empty one); true when the cap
    /// dropped some of it.
    fn push(&mut self, chunk: &str, max: usize) -> bool {
        if chunk.is_empty() {
            return false;
        }
        if self.units >= max {
            return true;
        }
        let room = max - self.units;
        let len = js_string::len16(chunk);
        if len <= room {
            self.text.push_str(chunk);
            self.units += len;
            return false;
        }
        // `chunk.slice(0, room)`, which may end on half a surrogate pair.
        let units = js_string::units(chunk);
        self.text.push_str(&js_string::from_units(&units[..room]));
        self.units += room;
        true
    }
}

async fn read_some<R: AsyncRead + Unpin>(
    r: &mut Option<R>,
    buf: &mut [u8],
) -> std::io::Result<usize> {
    match r {
        Some(r) => r.read(buf).await,
        None => std::future::pending().await,
    }
}

/// `execShellCommand(cwd, command, opts)`, where `cwd` is the JS value TS
/// passes (`ws.rootPath`, `None` for `undefined`). `Err` is a throw (the
/// promise rejects; the route answers Next's empty 500): Node checks the
/// arguments for NULs before `options.cwd` ([`spawn_cwd`]).
///
/// The run goes on its own task, so a caller that is dropped (the client
/// hung up) doesn't stop it: as in Node, the output is still drained and
/// the timeout still kills the group.
pub async fn exec_shell_command(
    cwd: Option<&Value>,
    command: &str,
    opts: &ShellOpts,
) -> Result<ShellExecResult, String> {
    let timeout = Duration::from_millis(opts.timeout_ms.unwrap_or(DEFAULT_TIMEOUT_MS));
    let max = opts.max_output_units.unwrap_or(MAX_OUTPUT_UNITS);
    if command.contains('\0') {
        return Err(format!(
            "The argument 'args[1]' must be a string without null bytes. Received {}",
            crate::git::node_inspect_string(command)
        ));
    }
    let cwd = spawn_cwd(cwd)?;
    let mut cmd = tokio::process::Command::new(SHELL_PATH);
    cmd.arg("-c").arg(lossy(command).as_ref());
    let streams = Streams::attach(&mut cmd).map_err(|e| e.to_string())?;
    if let SpawnCwd::Dir(dir) = &cwd {
        cmd.current_dir(lossy(dir).as_ref());
    }
    // `detached: true`: Node calls `setsid()`, so the shell leads its own
    // process group, which the timeout kills as a whole. The hook makes
    // this a fork (see `prepare_fork`).
    claudius_agent::prepare_fork();
    #[cfg(unix)]
    // SAFETY: setsid, fcntl and close are async-signal-safe and touch no
    // Rust state.
    unsafe {
        cmd.pre_exec(|| {
            libc::setsid();
            // Possibly long-lived: drop descriptors leaked by a concurrent
            // spawn (see `close_leaked_fds`).
            claudius_agent::close_leaked_fds()
        });
    }
    let spawned = cmd.spawn();
    // The child's ends of the socket pairs live in `cmd` until it goes.
    drop(cmd);
    let child = match spawned {
        Ok(child) => child,
        Err(e) => {
            return match spawn_failure(SHELL_PATH, &e) {
                // The `error` listener: the message after a newline.
                SpawnFailure::Emitted(message) => Ok(ShellExecResult {
                    stdout: String::new(),
                    stderr: format!("\n{message}"),
                    truncated: false,
                    exit_code: -1,
                    signal: None,
                }),
                SpawnFailure::Thrown(message) => Err(message),
            };
        }
    };
    let stdin = opts
        .stdin
        .as_ref()
        .map(|t| lossy(t).into_owned().into_bytes());
    let mut child = child;
    let (to_child, from_out, from_err) =
        streams.parent_ends(&mut child).map_err(|e| e.to_string())?;
    tokio::spawn(collect(
        child, to_child, from_out, from_err, stdin, timeout, max,
    ))
    .await
    .map_err(|e| e.to_string())
}

/// The child's stdio as Node sets it up for `stdio: "pipe"`: on Unix each
/// stream is one end of an `AF_UNIX` / `SOCK_STREAM` socket pair (libuv's
/// `uv_socketpair`), not a pipe, so `[ -S /dev/stdin ]` holds in the
/// command. The parent's ends are close-on-exec and non-blocking; the
/// child's are left blocking and are `dup2`ed onto 0-2.
#[cfg(unix)]
struct Streams([std::os::fd::OwnedFd; 3]);

#[cfg(unix)]
impl Streams {
    fn attach(cmd: &mut tokio::process::Command) -> std::io::Result<Streams> {
        use std::os::fd::{FromRawFd, OwnedFd};
        let mut ours = Vec::with_capacity(3);
        let mut theirs = Vec::with_capacity(3);
        for _ in 0..3 {
            let mut fds = [0 as libc::c_int; 2];
            // SAFETY: socketpair writes two descriptors into `fds`, which
            // are then owned here and nowhere else.
            let (a, b) = unsafe {
                if libc::socketpair(libc::AF_UNIX, libc::SOCK_STREAM, 0, fds.as_mut_ptr()) != 0 {
                    return Err(std::io::Error::last_os_error());
                }
                (OwnedFd::from_raw_fd(fds[0]), OwnedFd::from_raw_fd(fds[1]))
            };
            for (fd, nonblocking) in [(&a, true), (&b, false)] {
                use std::os::fd::AsRawFd;
                let fd = fd.as_raw_fd();
                // SAFETY: fcntl on a descriptor this function owns.
                unsafe {
                    libc::fcntl(fd, libc::F_SETFD, libc::FD_CLOEXEC);
                    if nonblocking {
                        let flags = libc::fcntl(fd, libc::F_GETFL);
                        libc::fcntl(fd, libc::F_SETFL, flags | libc::O_NONBLOCK);
                    }
                }
            }
            ours.push(a);
            theirs.push(Stdio::from(b));
        }
        let mut theirs = theirs.into_iter();
        let mut next = || theirs.next().expect("three streams");
        cmd.stdin(next()).stdout(next()).stderr(next());
        Ok(Streams(ours.try_into().expect("three streams")))
    }

    fn parent_ends(
        self,
        _child: &mut tokio::process::Child,
    ) -> std::io::Result<(
        tokio::net::UnixStream,
        tokio::net::UnixStream,
        tokio::net::UnixStream,
    )> {
        let [i, o, e] = self.0;
        let wrap = |fd: std::os::fd::OwnedFd| {
            tokio::net::UnixStream::from_std(std::os::unix::net::UnixStream::from(fd))
        };
        Ok((wrap(i)?, wrap(o)?, wrap(e)?))
    }
}

/// Pipes where there are no socket pairs.
#[cfg(not(unix))]
struct Streams;

#[cfg(not(unix))]
impl Streams {
    fn attach(cmd: &mut tokio::process::Command) -> std::io::Result<Streams> {
        cmd.stdin(Stdio::piped())
            .stdout(Stdio::piped())
            .stderr(Stdio::piped());
        Ok(Streams)
    }

    fn parent_ends(
        self,
        child: &mut tokio::process::Child,
    ) -> std::io::Result<(
        tokio::process::ChildStdin,
        tokio::process::ChildStdout,
        tokio::process::ChildStderr,
    )> {
        let gone = || std::io::Error::other("stdio not captured");
        Ok((
            child.stdin.take().ok_or_else(gone)?,
            child.stdout.take().ok_or_else(gone)?,
            child.stderr.take().ok_or_else(gone)?,
        ))
    }
}

/// From the spawn to Node's `close`: feed `stdin`, read both streams under
/// the cap, fire the timeout once, and wait for the exit.
async fn collect<W, O, E>(
    mut child: tokio::process::Child,
    to_child: W,
    from_out: O,
    from_err: E,
    stdin_payload: Option<Vec<u8>>,
    timeout: Duration,
    max: usize,
) -> ShellExecResult
where
    W: AsyncWrite + Unpin + Send + 'static,
    O: AsyncRead + Unpin,
    E: AsyncRead + Unpin,
{
    let pid = child.id();
    let mut stdin = Some(to_child);
    let mut writer = None;
    if let Some(bytes) = stdin_payload
        && let Some(mut pipe) = stdin.take()
    {
        // `child.stdin.end(payload)`; EPIPE is swallowed.
        writer = Some(tokio::spawn(async move {
            let _ = pipe.write_all(&bytes).await;
            let _ = pipe.shutdown().await;
        }));
    }
    let (mut stdout, mut stderr) = (Some(from_out), Some(from_err));
    let (mut out, mut err) = (Capture::default(), Capture::default());
    let (mut out_buf, mut err_buf) = (vec![0u8; READ_CHUNK], vec![0u8; READ_CHUNK]);
    let mut truncated = false;
    let deadline = tokio::time::sleep(timeout);
    tokio::pin!(deadline);
    let mut fired = false;
    let mut status = None;
    while stdout.is_some() || stderr.is_some() || status.is_none() {
        let mut kill = false;
        tokio::select! {
            r = read_some(&mut stdout, &mut out_buf), if stdout.is_some() => {
                let chunk = match r {
                    Ok(n) if n > 0 => out.decoder.write(&out_buf[..n]),
                    _ => {
                        stdout = None;
                        out.decoder.end().to_owned()
                    }
                };
                truncated |= out.push(&chunk, max);
            }
            r = read_some(&mut stderr, &mut err_buf), if stderr.is_some() => {
                let chunk = match r {
                    Ok(n) if n > 0 => err.decoder.write(&err_buf[..n]),
                    _ => {
                        stderr = None;
                        err.decoder.end().to_owned()
                    }
                };
                truncated |= err.push(&chunk, max);
            }
            s = child.wait(), if status.is_none() => {
                status = Some(s);
                // Node destroys stdin once the child exits.
                drop(stdin.take());
                if let Some(w) = writer.take() {
                    w.abort();
                }
            }
            _ = &mut deadline, if !fired => kill = true,
        }
        if kill {
            fired = true;
            terminate_group(&mut child, pid);
        }
    }
    let (exit_code, signal) = match status {
        Some(Ok(s)) => exit_of(s),
        _ => (0, None),
    };
    ShellExecResult {
        stdout: out.text,
        stderr: err.text,
        truncated,
        exit_code,
        signal,
    }
}

/// `killProcessGroup(child.pid)`: SIGTERM the group, then SIGKILL whatever
/// ignored it 1.5 s later ([`crate::process_group`]); ESRCH ignored.
#[cfg(unix)]
fn terminate_group(_child: &mut tokio::process::Child, pid: Option<u32>) {
    if let Some(pid) = pid {
        crate::process_group::kill_process_group(pid);
    }
}

#[cfg(not(unix))]
fn terminate_group(child: &mut tokio::process::Child, _pid: Option<u32>) {
    let _ = child.start_kill();
}

/// The `close` event's `(code ?? -1, signal ?? null)`. A signal Node has no
/// name for leaves `exitCode` at libuv's 0 and `signalCode` unset.
#[cfg(unix)]
fn exit_of(status: std::process::ExitStatus) -> (i64, Option<&'static str>) {
    use std::os::unix::process::ExitStatusExt;
    match (status.code(), status.signal()) {
        (Some(c), _) => (i64::from(c), None),
        (None, Some(sig)) => match claudius_agent::signal_name(sig) {
            Some(name) => (-1, Some(name)),
            None => (0, None),
        },
        (None, None) => (-1, None),
    }
}

#[cfg(not(unix))]
fn exit_of(status: std::process::ExitStatus) -> (i64, Option<&'static str>) {
    (status.code().map_or(-1, i64::from), None)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn the_cap_counts_utf16_units_and_keeps_a_cut_high_surrogate() {
        let mut c = Capture::default();
        assert!(!c.push("ab", 4));
        assert!(c.push("c\u{1F600}", 4));
        assert_eq!(js_string::stringify(&json!(c.text)), "\"abc\\ud83d\"");
        assert_eq!(c.units, 4);
        assert!(c.push("x", 4));
        assert!(!c.push("", 4));
        let mut exact = Capture::default();
        assert!(!exact.push("\u{1F600}", 2));
        assert_eq!(exact.units, 2);
    }

    #[test]
    fn spawn_cwd_reads_like_get_validated_path() {
        assert_eq!(spawn_cwd(None), Ok(SpawnCwd::Inherit));
        assert_eq!(spawn_cwd(Some(&json!(null))), Ok(SpawnCwd::Inherit));
        assert_eq!(spawn_cwd(Some(&json!(""))), Ok(SpawnCwd::Inherit));
        assert_eq!(
            spawn_cwd(Some(&json!("/x"))),
            Ok(SpawnCwd::Dir("/x".into()))
        );
        assert!(spawn_cwd(Some(&json!("/x\u{0}"))).is_err());
        assert!(spawn_cwd(Some(&json!(5))).is_err());
        assert!(spawn_cwd(Some(&json!(["/x"]))).is_err());
        let url = json!({"href": "x", "protocol": "file:", "hostname": "", "pathname": "/a%20b"});
        assert_eq!(spawn_cwd(Some(&url)), Ok(SpawnCwd::Dir("/a b".into())));
        let with_auth = json!({"href": "x", "protocol": "file:", "hostname": "", "pathname": "/a", "auth": null});
        assert!(spawn_cwd(Some(&with_auth)).is_err());
    }
}
