//! `!` bash mode (Claude Code parity): one persistent `/bin/bash` per
//! session (`lib/server/bash-mode.ts`), the `<bash-*>` block the model gets
//! on the next prompt (`formatBashIOBlock` in `pending-bash-output.ts`) and
//! the sudo rewrite of `Session.runBashCommand`.
//!
//! [`BashSession`] runs one command at a time on a shell anchored at the
//! session cwd, so `cd`, `export` and functions persist. Each command is
//! followed by a sentinel the shell echoes on both streams once it is done:
//!
//! ```text
//! <command>
//! __claudius_ec=$?
//! printf '%s\n' '__CLAUDIUS_BASH_END_<id>__' 1>&2
//! printf '%s:%d\n' '__CLAUDIUS_BASH_END_<id>__' "$__claudius_ec"
//! ```
//!
//! The TS class is event driven (stream `data`, child `close` / `error`, a
//! timer, a queue), so this is an actor: one task owns the state and each TS
//! callback is a message. Ported as-is, TS quirks included:
//! - output while no command runs is dropped, and so are events from a
//!   shell that was replaced (timeout, `exit`);
//! - streams are capped at 16 Mi UTF-16 units each; past the cap the
//!   sentinel is lost too, so the command runs into its timeout;
//! - after the shell exits (`!exit`) or fails to spawn, the queue isn't
//!   drained: a queued command waits for the next one to finish.
//!
//! One deliberate difference: `dispose()` answers queued commands like a
//! call after the dispose (`BashSession destroyed`), where TS drops them and
//! never answers, which would hold the server's shutdown open.

use std::collections::{HashMap, VecDeque};
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, LazyLock, Mutex};
use std::time::Duration;

use claudius_agent::Utf8Decoder;
use serde::Serialize;
use serde_json::Value;
use tokio::io::{AsyncRead, AsyncReadExt, AsyncWriteExt};
use tokio::sync::{mpsc, oneshot};

/// `MAX_OUTPUT_BYTES`, though JS measures it as a string length: UTF-16
/// units, per stream.
pub const MAX_OUTPUT_UNITS: usize = 16 * 1024 * 1024;
pub const DEFAULT_TIMEOUT: Duration = Duration::from_millis(120_000);
const SHELL_PATH: &str = "/bin/bash";

#[derive(Clone, Debug, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct BashExecResult {
    pub stdout: String,
    pub stderr: String,
    pub exit_code: i64,
    pub truncated: bool,
    pub timed_out: bool,
}

impl BashExecResult {
    fn destroyed() -> Self {
        BashExecResult {
            stdout: String::new(),
            stderr: "BashSession destroyed".to_owned(),
            exit_code: -1,
            truncated: false,
            timed_out: false,
        }
    }
}

/// One persistent shell. Commands queue; see the module docs.
pub struct BashSession {
    tx: mpsc::UnboundedSender<Msg>,
    destroyed: AtomicBool,
}

impl BashSession {
    /// A shell at `cwd` with this process's environment (TS: `process.env`).
    pub fn new(cwd: &str) -> BashSession {
        Self::spawn_actor(cwd, None)
    }

    /// The same, with exactly `env` (tests).
    pub fn with_env(cwd: &str, env: Vec<(String, String)>) -> BashSession {
        Self::spawn_actor(cwd, Some(env))
    }

    fn spawn_actor(cwd: &str, env: Option<Vec<(String, String)>>) -> BashSession {
        let (tx, rx) = mpsc::unbounded_channel();
        let actor = Actor {
            cwd: cwd.to_owned(),
            env,
            tx: tx.downgrade(),
            child: None,
            next_shell: 0,
            stdout: Buffer::default(),
            stderr: Buffer::default(),
            stdout_saw_marker: false,
            stderr_saw_marker: false,
            captured_exit_code: None,
            truncated: false,
            pending: None,
            queue: VecDeque::new(),
            destroyed: false,
            next_id: 0,
        };
        tokio::spawn(actor.run(rx));
        BashSession {
            tx,
            destroyed: AtomicBool::new(false),
        }
    }

    /// Run one command (≤ `timeout`). Resolves once both streams saw the
    /// sentinel, the shell went away, or the timeout fired. Like the TS
    /// promise executor, the command is queued right away, before the
    /// future is first polled, so commands run in call order.
    pub fn exec(
        &self,
        command: &str,
        timeout: Duration,
    ) -> impl std::future::Future<Output = BashExecResult> + Send + 'static {
        let rx = (!self.destroyed.load(Ordering::Acquire))
            .then(|| {
                let (reply, rx) = oneshot::channel();
                let msg = Msg::Exec {
                    command: command.to_owned(),
                    timeout,
                    reply,
                };
                self.tx.send(msg).ok().map(|()| rx)
            })
            .flatten();
        async move {
            match rx {
                Some(rx) => rx.await.unwrap_or_else(|_| BashExecResult::destroyed()),
                None => BashExecResult::destroyed(),
            }
        }
    }

    /// Tear the shell (and its process group) down for good.
    pub fn dispose(&self) {
        self.destroyed.store(true, Ordering::Release);
        let _ = self.tx.send(Msg::Dispose);
    }
}

impl Drop for BashSession {
    fn drop(&mut self) {
        self.dispose();
    }
}

static BASH_SESSIONS: LazyLock<Mutex<HashMap<String, Arc<BashSession>>>> =
    LazyLock::new(Default::default);

/// `getOrCreateBashSession`: one shell per session id, anchored at the cwd
/// it was first asked for.
pub fn get_or_create_bash_session(session_id: &str, cwd: &str) -> Arc<BashSession> {
    BASH_SESSIONS
        .lock()
        .unwrap()
        .entry(session_id.to_owned())
        .or_insert_with(|| Arc::new(BashSession::new(cwd)))
        .clone()
}

/// `dropBashSession`: dispose the session's shell, if it has one.
pub fn drop_bash_session(session_id: &str) {
    if let Some(bash) = BASH_SESSIONS.lock().unwrap().remove(session_id) {
        bash.dispose();
    }
}

/// `formatBashIOBlock`: what the model reads as committed history.
pub fn format_bash_io_block(command: &str, stdout: &str, stderr: &str) -> String {
    format!(
        "<bash-input>{command}</bash-input>\n<bash-stdout>{stdout}</bash-stdout><bash-stderr>{stderr}</bash-stderr>"
    )
}

pub const COMPOUND_SUDO_ERROR: &str = "claudius: compound sudo commands aren't supported in `!`-mode. Wrap them in a single `sudo bash -c \"…\"` so one password unlocks the whole run.";

/// What `runBashCommand` hands the shell.
#[derive(Debug, PartialEq)]
pub enum BashPlan {
    /// The command to run.
    Run(String),
    /// More than one `sudo` with a password: refused (one heredoc can only
    /// feed one of them).
    CompoundSudo,
}

/// `runBashCommand`'s sudo rewrite. With a password, the first `sudo` gets
/// `-S -p ''` and a heredoc carrying the password, delimited with the uuid.
/// `Err` is what the TS code throws: `uuid.replace` on a non-string uuid.
pub fn plan_bash_command(
    command: &str,
    sudo_password: Option<&str>,
    uuid: &Value,
) -> Result<BashPlan, &'static str> {
    let Some(password) = sudo_password else {
        return Ok(BashPlan::Run(command.to_owned()));
    };
    if count_sudo_words(command) > 1 {
        return Ok(BashPlan::CompoundSudo);
    }
    let Some(uuid) = uuid.as_str() else {
        return Err("uuid.replace is not a function");
    };
    let delim = format!("__CLAUDIUS_PWD_{}__", uuid.replace('-', ""));
    let sudoified = inject_sudo_flags(command);
    Ok(BashPlan::Run(format!(
        "{sudoified} <<'{delim}'\n{password}\n{delim}"
    )))
}

/// JS `\w` (no `u` flag): ASCII only.
fn is_word_byte(b: u8) -> bool {
    b.is_ascii_alphanumeric() || b == b'_'
}

/// `(command.match(/\bsudo\b/g) ?? []).length`. Bytes are enough: word
/// characters are ASCII, so no UTF-8 continuation byte is one.
fn count_sudo_words(command: &str) -> usize {
    let b = command.as_bytes();
    (0..b.len())
        .filter(|&i| {
            b[i..].starts_with(b"sudo")
                && (i == 0 || !is_word_byte(b[i - 1]))
                && b.get(i + 4).is_none_or(|&n| !is_word_byte(n))
        })
        .count()
}

/// `command.replace(/^(\s*sudo\b)/, "$1 -S -p ''")`.
fn inject_sudo_flags(command: &str) -> String {
    let start = command
        .char_indices()
        .find(|&(_, c)| !claudius_agent::js::is_whitespace(c))
        .map_or(command.len(), |(i, _)| i);
    let rest = &command.as_bytes()[start..];
    if rest.starts_with(b"sudo") && rest.get(4).is_none_or(|&n| !is_word_byte(n)) {
        let at = start + 4;
        format!("{} -S -p ''{}", &command[..at], &command[at..])
    } else {
        command.to_owned()
    }
}

// ───────────────────────────────── actor ─────────────────────────────────

#[derive(Clone, Copy)]
enum Stream {
    Stdout,
    Stderr,
}

enum Msg {
    Exec {
        command: String,
        timeout: Duration,
        reply: oneshot::Sender<BashExecResult>,
    },
    /// A decoded chunk from a shell's stream.
    Data {
        shell: u64,
        stream: Stream,
        chunk: String,
    },
    /// The shell exited (Node's `exit`; sets `exitCode`).
    Exited {
        shell: u64,
    },
    /// Exited and both streams ended (Node's `close`).
    Closed {
        shell: u64,
    },
    /// The spawn failed (Node's `error`).
    Error {
        shell: u64,
        message: String,
    },
    Timeout {
        id: u64,
    },
    Dispose,
}

struct Child {
    shell: u64,
    pid: Option<u32>,
    stdin: mpsc::UnboundedSender<Vec<u8>>,
    exited: bool,
}

struct Pending {
    id: u64,
    marker: String,
    reply: oneshot::Sender<BashExecResult>,
    timer: tokio::task::JoinHandle<()>,
}

struct Queued {
    command: String,
    timeout: Duration,
    reply: oneshot::Sender<BashExecResult>,
}

/// A JS string buffer: the text plus its JS `length`. They differ only
/// when the cap cut a surrogate pair, whose lone high half JS keeps (and
/// counts) but a Rust string can't hold.
#[derive(Default)]
struct Buffer {
    text: String,
    units: usize,
}

impl Buffer {
    /// `appendBuffered`; true when the cap cut something.
    fn append(&mut self, chunk: &str) -> bool {
        if self.units >= MAX_OUTPUT_UNITS {
            return true;
        }
        let room = MAX_OUTPUT_UNITS - self.units;
        let len = chunk.encode_utf16().count();
        if len <= room {
            self.text.push_str(chunk);
            self.units += len;
            return false;
        }
        // `chunk.slice(0, room)`.
        let mut taken = 0;
        let mut end = 0;
        for (i, c) in chunk.char_indices() {
            if taken + c.len_utf16() > room {
                break;
            }
            taken += c.len_utf16();
            end = i + c.len_utf8();
        }
        self.text.push_str(&chunk[..end]);
        self.units += room;
        true
    }

    /// `buf.slice(0, idx).replace(/\n$/, "")`.
    fn cut(&mut self, idx: usize) {
        self.text.truncate(idx);
        if self.text.ends_with('\n') {
            self.text.pop();
        }
        self.units = self.text.encode_utf16().count();
    }

    fn take(&mut self) -> String {
        self.units = 0;
        std::mem::take(&mut self.text)
    }

    /// `text.indexOf(needle)` right after appending to a buffer that was
    /// `before` bytes long: a match can only end in the new bytes (an
    /// earlier one was found and cut already), so only the tail is searched.
    /// The same answer as a full scan, without rescanning 16 MiB per chunk.
    fn find_after_append(&self, needle: &str, before: usize) -> Option<usize> {
        let mut from = before.saturating_sub(needle.len().saturating_sub(1));
        while !self.text.is_char_boundary(from) {
            from -= 1;
        }
        self.text[from..].find(needle).map(|i| from + i)
    }
}

struct Actor {
    cwd: String,
    env: Option<Vec<(String, String)>>,
    /// For the shell's tasks and the timers. Weak, so the actor ends once
    /// the handle and every shell task are gone.
    tx: mpsc::WeakUnboundedSender<Msg>,
    child: Option<Child>,
    next_shell: u64,
    stdout: Buffer,
    stderr: Buffer,
    stdout_saw_marker: bool,
    stderr_saw_marker: bool,
    captured_exit_code: Option<i64>,
    truncated: bool,
    pending: Option<Pending>,
    queue: VecDeque<Queued>,
    destroyed: bool,
    next_id: u64,
}

impl Actor {
    async fn run(mut self, mut rx: mpsc::UnboundedReceiver<Msg>) {
        while let Some(msg) = rx.recv().await {
            match msg {
                Msg::Exec {
                    command,
                    timeout,
                    reply,
                } => self.on_exec(command, timeout, reply),
                Msg::Data {
                    shell,
                    stream,
                    chunk,
                } => {
                    if self.is_current(shell) {
                        match stream {
                            Stream::Stdout => self.on_stdout(&chunk),
                            Stream::Stderr => self.on_stderr(&chunk),
                        }
                    }
                }
                Msg::Exited { shell } => {
                    if let Some(c) = self.child.as_mut().filter(|c| c.shell == shell) {
                        c.exited = true;
                    }
                }
                Msg::Closed { shell } => {
                    if self.is_current(shell) {
                        self.on_close();
                    }
                }
                Msg::Error { shell, message } => {
                    if self.is_current(shell) {
                        self.on_error(&message);
                    }
                }
                Msg::Timeout { id } => {
                    if self.pending.as_ref().is_some_and(|p| p.id == id) {
                        self.on_timeout();
                    }
                }
                Msg::Dispose => {
                    self.dispose();
                    return;
                }
            }
        }
    }

    /// The listeners' `this.child !== ownChild` gate.
    fn is_current(&self, shell: u64) -> bool {
        self.child.as_ref().is_some_and(|c| c.shell == shell)
    }

    fn on_exec(
        &mut self,
        command: String,
        timeout: Duration,
        reply: oneshot::Sender<BashExecResult>,
    ) {
        if self.destroyed {
            let _ = reply.send(BashExecResult::destroyed());
        } else if self.pending.is_some() {
            self.queue.push_back(Queued {
                command,
                timeout,
                reply,
            });
        } else {
            self.run_one(&command, timeout, reply);
        }
    }

    /// `ensureChild`: reuse the shell unless it exited.
    fn ensure_child(&mut self) -> &Child {
        if self.child.as_ref().is_some_and(|c| !c.exited) {
            return self.child.as_ref().unwrap();
        }
        let shell = self.next_shell;
        self.next_shell += 1;
        let (stdin_tx, stdin_rx) = mpsc::unbounded_channel();
        let pid = match self.spawn_shell(shell, stdin_rx) {
            Ok(pid) => pid,
            Err(e) => {
                // Node reports a failed spawn asynchronously; the child
                // object exists meanwhile and swallows the writes.
                self.send(Msg::Error {
                    shell,
                    message: spawn_error_message(&e),
                });
                None
            }
        };
        self.child.insert(Child {
            shell,
            pid,
            stdin: stdin_tx,
            exited: false,
        })
    }

    /// `spawn(SHELL_PATH, ["--norc", "--noprofile"], {cwd, env, detached: true})`
    /// with its stream, `exit` and `close` listeners.
    fn spawn_shell(
        &self,
        shell: u64,
        mut stdin_rx: mpsc::UnboundedReceiver<Vec<u8>>,
    ) -> std::io::Result<Option<u32>> {
        let mut cmd = tokio::process::Command::new(SHELL_PATH);
        cmd.args(["--norc", "--noprofile"])
            .current_dir(&self.cwd)
            .stdin(std::process::Stdio::piped())
            .stdout(std::process::Stdio::piped())
            .stderr(std::process::Stdio::piped());
        if let Some(env) = &self.env {
            cmd.env_clear().envs(env.iter().map(|(k, v)| (k, v)));
        }
        // `detached: true`: Node calls `setsid()`, so the shell leads its
        // own process group (killed as a group) with no controlling tty.
        #[cfg(unix)]
        // SAFETY: setsid is async-signal-safe and touches no Rust state.
        unsafe {
            cmd.pre_exec(|| {
                libc::setsid();
                // A long-lived child: drop descriptors leaked by a
                // concurrent spawn (see `close_leaked_fds`).
                claudius_agent::close_leaked_fds()
            });
        }
        let mut child = cmd.spawn()?;
        let pid = child.id();
        let (Some(mut stdin), Some(stdout), Some(stderr)) =
            (child.stdin.take(), child.stdout.take(), child.stderr.take())
        else {
            return Err(std::io::Error::other("missing stdio"));
        };
        // Node buffers writes; the writer keeps that off the actor.
        tokio::spawn(async move {
            while let Some(bytes) = stdin_rx.recv().await {
                if stdin.write_all(&bytes).await.is_err() {
                    break;
                }
            }
        });
        let out = self.read_stream(shell, Stream::Stdout, stdout);
        let err = self.read_stream(shell, Stream::Stderr, stderr);
        let tx = self.tx.clone();
        tokio::spawn(async move {
            let _ = child.wait().await;
            if let Some(tx) = tx.upgrade() {
                let _ = tx.send(Msg::Exited { shell });
            }
            let _ = out.await;
            let _ = err.await;
            if let Some(tx) = tx.upgrade() {
                let _ = tx.send(Msg::Closed { shell });
            }
        });
        Ok(pid)
    }

    /// `setEncoding("utf8")` + `on("data")`, and the decoder's leftover at
    /// the end.
    fn read_stream(
        &self,
        shell: u64,
        which: Stream,
        mut stream: impl AsyncRead + Unpin + Send + 'static,
    ) -> tokio::task::JoinHandle<()> {
        let tx = self.tx.clone();
        tokio::spawn(async move {
            let mut decoder = Utf8Decoder::default();
            let mut buf = vec![0u8; 64 * 1024];
            let send = |chunk: String| {
                if chunk.is_empty() {
                    return true;
                }
                tx.upgrade().is_some_and(|tx| {
                    tx.send(Msg::Data {
                        shell,
                        stream: which,
                        chunk,
                    })
                    .is_ok()
                })
            };
            loop {
                match stream.read(&mut buf).await {
                    Ok(0) | Err(_) => break,
                    Ok(n) => {
                        if !send(decoder.write(&buf[..n])) {
                            return;
                        }
                    }
                }
            }
            send(decoder.end().to_owned());
        })
    }

    fn send(&self, msg: Msg) {
        if let Some(tx) = self.tx.upgrade() {
            let _ = tx.send(msg);
        }
    }

    fn run_one(
        &mut self,
        command: &str,
        timeout: Duration,
        reply: oneshot::Sender<BashExecResult>,
    ) {
        self.ensure_child();
        let marker = format!("__CLAUDIUS_BASH_END_{}__", uuid::Uuid::new_v4().simple());
        let id = self.next_id;
        self.next_id += 1;
        self.reset_per_command();
        let tx = self.tx.clone();
        let timer = tokio::spawn(async move {
            tokio::time::sleep(timeout).await;
            if let Some(tx) = tx.upgrade() {
                let _ = tx.send(Msg::Timeout { id });
            }
        });
        let wrapped = format!(
            "{command}\n__claudius_ec=$?\nprintf '%s\\n' '{marker}' 1>&2\nprintf '%s:%d\\n' '{marker}' \"$__claudius_ec\"\n"
        );
        self.pending = Some(Pending {
            id,
            marker,
            reply,
            timer,
        });
        if let Some(c) = &self.child {
            let _ = c.stdin.send(wrapped.into_bytes());
        }
    }

    fn on_stdout(&mut self, chunk: &str) {
        let Some(p) = &self.pending else {
            return; // stray output between commands
        };
        let needle = format!("{}:", p.marker);
        let marker_len = p.marker.len();
        let before = self.stdout.text.len();
        if self.stdout.append(chunk) {
            self.truncated = true;
        }
        if let Some(idx) = self.stdout.find_after_append(&needle, before) {
            let tail = &self.stdout.text[idx + marker_len + 1..];
            self.captured_exit_code = Some(leading_int(tail).unwrap_or(-1));
            self.stdout.cut(idx);
            self.stdout_saw_marker = true;
            self.maybe_resolve();
        }
    }

    fn on_stderr(&mut self, chunk: &str) {
        let Some(p) = &self.pending else {
            return;
        };
        let marker = p.marker.clone();
        let before = self.stderr.text.len();
        if self.stderr.append(chunk) {
            self.truncated = true;
        }
        if let Some(idx) = self.stderr.find_after_append(&marker, before) {
            self.stderr.cut(idx);
            self.stderr_saw_marker = true;
            self.maybe_resolve();
        }
    }

    fn result(&mut self, exit_code: i64, timed_out: bool) -> BashExecResult {
        BashExecResult {
            stdout: self.stdout.take(),
            stderr: self.stderr.take(),
            exit_code,
            truncated: self.truncated,
            timed_out,
        }
    }

    /// Settle the running command with `r`.
    fn settle(p: Pending, r: BashExecResult) {
        p.timer.abort();
        let _ = p.reply.send(r);
    }

    fn maybe_resolve(&mut self) {
        if self.pending.is_none() || !self.stdout_saw_marker || !self.stderr_saw_marker {
            return;
        }
        let p = self.pending.take().unwrap();
        let code = self.captured_exit_code.unwrap_or(-1);
        let r = self.result(code, false);
        self.reset_per_command();
        Self::settle(p, r);
        self.run_next();
    }

    /// The shell exited and its streams ended (`exit`, or killed).
    fn on_close(&mut self) {
        if let Some(p) = self.pending.take() {
            let code = self.captured_exit_code.unwrap_or(-1);
            let r = self.result(code, false);
            self.reset_per_command();
            Self::settle(p, r);
        }
        self.child = None;
    }

    fn on_error(&mut self, message: &str) {
        if let Some(p) = self.pending.take() {
            let mut r = self.result(-1, false);
            r.stderr.push('\n');
            r.stderr.push_str(message);
            self.reset_per_command();
            Self::settle(p, r);
        }
        self.child = None;
    }

    fn on_timeout(&mut self) {
        let Some(p) = self.pending.take() else {
            return;
        };
        let r = self.result(-1, true);
        self.reset_per_command();
        self.kill_group();
        self.child = None;
        let _ = p.reply.send(r);
        self.run_next();
    }

    fn run_next(&mut self) {
        if let Some(q) = self.queue.pop_front() {
            self.run_one(&q.command, q.timeout, q.reply);
        }
    }

    fn reset_per_command(&mut self) {
        self.stdout.take();
        self.stderr.take();
        self.stdout_saw_marker = false;
        self.stderr_saw_marker = false;
        self.captured_exit_code = None;
        self.truncated = false;
    }

    /// `process.kill(-pid, "SIGTERM")`.
    fn kill_group(&self) {
        #[cfg(unix)]
        if let Some(pid) = self.child.as_ref().and_then(|c| c.pid) {
            // SAFETY: plain syscall; a gone group is just ESRCH.
            unsafe {
                libc::kill(-(pid as i32), libc::SIGTERM);
            }
        }
    }

    fn dispose(&mut self) {
        self.destroyed = true;
        self.kill_group();
        self.child = None;
        for q in std::mem::take(&mut self.queue) {
            let _ = q.reply.send(BashExecResult::destroyed());
        }
        if let Some(p) = self.pending.take() {
            let r = self.result(-1, false);
            Self::settle(p, r);
        }
    }
}

/// `/^(-?\d+)/` then `Number(…)`.
fn leading_int(s: &str) -> Option<i64> {
    let neg = s.starts_with('-');
    let digits = &s[usize::from(neg)..];
    let n = digits.bytes().take_while(u8::is_ascii_digit).count();
    if n == 0 {
        return None;
    }
    let v: i64 = digits[..n].parse().ok()?;
    Some(if neg { -v } else { v })
}

/// Node's message for a failed spawn: `spawn <file> <code>`.
fn spawn_error_message(e: &std::io::Error) -> String {
    let code = e.raw_os_error().and_then(errno_name).unwrap_or("UNKNOWN");
    format!("spawn {SHELL_PATH} {code}")
}

#[cfg(unix)]
fn errno_name(n: i32) -> Option<&'static str> {
    Some(match n {
        libc::ENOENT => "ENOENT",
        libc::EACCES => "EACCES",
        libc::ENOTDIR => "ENOTDIR",
        libc::EPERM => "EPERM",
        libc::ENOMEM => "ENOMEM",
        libc::EAGAIN => "EAGAIN",
        libc::EMFILE => "EMFILE",
        libc::ENFILE => "ENFILE",
        libc::E2BIG => "E2BIG",
        libc::ELOOP => "ELOOP",
        libc::ENAMETOOLONG => "ENAMETOOLONG",
        _ => return None,
    })
}

#[cfg(not(unix))]
fn errno_name(_n: i32) -> Option<&'static str> {
    None
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    /// The sentinel can arrive split across reads: the search after an
    /// append must look back far enough to find it, and only find it once.
    #[test]
    fn a_marker_split_across_chunks_is_found() {
        let needle = "__CLAUDIUS_BASH_END_x__:";
        let mut b = Buffer::default();
        for cut in 1..needle.len() {
            b.take();
            b.append("out\n");
            b.append(&needle[..cut]);
            let before = b.text.len();
            assert_eq!(b.find_after_append(needle, before), None, "{cut}");
            b.append(&needle[cut..]);
            assert_eq!(b.find_after_append(needle, before), Some(4), "{cut}");
        }
        // Multi-byte text just before the window start.
        b.take();
        b.append("é🎉");
        let before = b.text.len();
        b.append(needle);
        assert_eq!(b.find_after_append(needle, before), Some(before));
    }

    #[test]
    fn sudo_words_are_ascii_bounded() {
        assert_eq!(count_sudo_words("sudo a && sudo b"), 2);
        assert_eq!(count_sudo_words("pseudo sudoers sudo_x xsudo"), 0);
        assert_eq!(count_sudo_words("ésudo sudo-x"), 2);
        assert_eq!(count_sudo_words("SUDO ls"), 0);
    }

    #[test]
    fn the_first_sudo_gets_its_flags() {
        assert_eq!(inject_sudo_flags("sudo ls"), "sudo -S -p '' ls");
        assert_eq!(
            inject_sudo_flags(" \u{a0}\u{feff}sudo"),
            " \u{a0}\u{feff}sudo -S -p ''"
        );
        assert_eq!(inject_sudo_flags("\u{85}sudo ls"), "\u{85}sudo ls");
        assert_eq!(inject_sudo_flags("sudoers"), "sudoers");
        assert_eq!(inject_sudo_flags("echo sudo"), "echo sudo");
    }

    #[test]
    fn a_non_string_uuid_throws_only_with_a_password() {
        assert_eq!(
            plan_bash_command("ls", None, &json!(5)),
            Ok(BashPlan::Run("ls".into()))
        );
        assert_eq!(
            plan_bash_command("sudo ls", Some("pw"), &json!(5)),
            Err("uuid.replace is not a function")
        );
        assert_eq!(
            plan_bash_command("sudo a; sudo b", Some("pw"), &json!(5)),
            Ok(BashPlan::CompoundSudo)
        );
        assert_eq!(
            plan_bash_command("sudo ls", Some("pw"), &json!("a-b-c")),
            Ok(BashPlan::Run(
                "sudo -S -p '' ls <<'__CLAUDIUS_PWD_abc__'\npw\n__CLAUDIUS_PWD_abc__".into()
            ))
        );
    }

    #[test]
    fn the_cap_counts_utf16_units() {
        let mut b = Buffer {
            text: "x".repeat(MAX_OUTPUT_UNITS - 1),
            units: MAX_OUTPUT_UNITS - 1,
        };
        // A pair cut in half: JS keeps the lone high surrogate.
        assert!(b.append("😀"));
        assert_eq!(b.units, MAX_OUTPUT_UNITS);
        assert_eq!(b.text.len(), MAX_OUTPUT_UNITS - 1);
        assert!(b.append("y"));
        assert_eq!(b.text.len(), MAX_OUTPUT_UNITS - 1);
    }

    #[test]
    fn exit_codes_parse_like_the_regex() {
        assert_eq!(leading_int("0\n"), Some(0));
        assert_eq!(leading_int("-3x"), Some(-3));
        assert_eq!(leading_int(""), None);
        assert_eq!(leading_int("-"), None);
    }
}
