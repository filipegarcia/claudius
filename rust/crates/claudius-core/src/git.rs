//! `lib/server/git.ts`: the exec wrapper every git route runs through, the
//! readers behind `workspaces/[id]/git/{status,diff,show}` (D06), and the
//! branch commands behind `git/{branches,branch-compare,branch-delete,
//! branch-rename,checkout}` (D07).
//!
//! The wrapper is TS's `git()` over `execFile("git", args, {cwd, maxBuffer,
//! timeout, encoding: "utf8"})`, with what that implies:
//! * the child inherits the server's environment as is (no `LANG` / `LC_ALL`
//!   or pager switches; stdout is a pipe, so git never pages) and gets a
//!   stdin pipe that stays open until it exits, unless `input` is written
//!   and closed;
//! * stdout and stderr are read in pipe-sized chunks and decoded as UTF-8
//!   with U+FFFD for bad bytes (`setEncoding("utf8")`);
//! * past `maxBuffer` decoded bytes on either stream, or at the timeout, both
//!   streams are closed (what was read so far is kept, including the whole
//!   chunk that crossed the limit) and git gets SIGTERM;
//! * the outcome is the exit Node reports at `close`: an exit code, or the
//!   name of the signal that killed it (`killed by SIGTERM`);
//! * `execFile`'s own argument checks (a NUL byte in an argument or the cwd)
//!   throw before anything is spawned, with Node's message, and spawn errors
//!   read `spawn git ENOENT` (`spawn ENOTDIR` for the errnos `spawn()`
//!   throws itself).
//!
//! The run happens on its own task, so a caller that goes away (a closed
//! request) doesn't stop git, as in Node. [`crate::exec_file`] is
//! `promisify(execFile)` for other programs on the same run.
//!
//! User input never reaches git as an option: `diff` passes the path after
//! `--`. `show` has no `--` in TS (`git show <ref>:<path>`), so a ref that
//! starts with `-` would be parsed as an option (`--output=<file>` writes a
//! file); here it is refused with the message git gives an unknown option.
//! The branch commands take no `--` either (in TS or here): every name and
//! ref goes through [`is_valid_ref_name`] first, which refuses a leading
//! `-`, and each argument that carries one starts with a checked name
//! (`<base>..<head>` too) or with `refs/`, so none can be an option. A `--`
//! would change what git does with a name that is also a path (`diff
//! <name>` diffs the path), so none is added.

use std::path::Path;
use std::process::Stdio;
use std::time::Duration;

use claudius_agent::{Utf8Decoder, js};
use serde_json::{Map, Value, json};
use tokio::io::{AsyncRead, AsyncReadExt, AsyncWriteExt};

use crate::js_num;

/// `MAX_BUFFER`: per stream, in decoded UTF-8 bytes.
pub const MAX_BUFFER: usize = 16 * 1024 * 1024;
/// `TIMEOUT_MS`: local plumbing reads.
pub const TIMEOUT_MS: u64 = 15_000;
/// `HOOK_TIMEOUT_MS`: network operations and anything that runs hooks.
pub const HOOK_TIMEOUT_MS: u64 = 10 * 60_000;
/// `execFile`'s default `maxBuffer`, for the `execFileP` probes.
const EXEC_FILE_MAX_BUFFER: usize = 1024 * 1024;
/// `isGitInstalled`'s `git --version` timeout.
const INSTALLED_TIMEOUT_MS: u64 = 1_500;
/// libuv reads a pipe 64 KiB at a time.
const READ_CHUNK: usize = 64 * 1024;

/// `GitError.code`.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum GitErrorCode {
    NotARepo,
    GitMissing,
    GitFailed,
}

impl GitErrorCode {
    pub fn as_str(self) -> &'static str {
        match self {
            GitErrorCode::NotARepo => "not-a-repo",
            GitErrorCode::GitMissing => "git-missing",
            GitErrorCode::GitFailed => "git-failed",
        }
    }
}

/// `GitError`: `{ code, message }`.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct GitError {
    pub code: GitErrorCode,
    pub message: String,
}

impl GitError {
    fn new(code: GitErrorCode, message: impl Into<String>) -> GitError {
        GitError {
            code,
            message: message.into(),
        }
    }
    fn failed(message: impl Into<String>) -> GitError {
        GitError::new(GitErrorCode::GitFailed, message)
    }
}

/// What Node reports at the child's `close`.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Exit {
    Code(i32),
    /// Killed by a signal Node has a name for.
    Signal(&'static str),
}

/// A successful run's output.
#[derive(Clone, Debug, Default, PartialEq, Eq)]
pub struct GitOutput {
    pub stdout: String,
    pub stderr: String,
}

/// TS `GitFailure`: git ran and didn't exit 0.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct GitFailure {
    /// `git <verb> exited <code>: <output>` / `git <verb> killed by <signal>…`.
    pub message: String,
    /// The exit code, or -1 when a signal killed it.
    pub exit_code: i32,
    pub stdout: String,
    pub stderr: String,
}

impl GitFailure {
    /// `output`: stdout + stderr, trimmed (hook output lands on stdout).
    pub fn output(&self) -> String {
        js::trim(&format!("{}{}", self.stdout, self.stderr)).to_owned()
    }
}

/// Why [`git`] rejected.
#[derive(Clone, Debug, PartialEq, Eq)]
pub enum ExecError {
    /// The call threw before git ran (argument validation, a spawn error):
    /// the thrown error's `message`.
    Thrown(String),
    Failure(GitFailure),
}

impl ExecError {
    /// `err instanceof Error ? err.message : String(err)`.
    pub fn message(&self) -> &str {
        match self {
            ExecError::Thrown(m) => m,
            ExecError::Failure(f) => &f.message,
        }
    }
}

/// `git()`'s options.
#[derive(Clone, Copy, Debug, Default)]
pub struct GitOpts<'a> {
    /// Written to stdin, which is then closed (`commit -F -`).
    pub input: Option<&'a str>,
    /// Defaults to [`TIMEOUT_MS`].
    pub timeout_ms: Option<u64>,
}

/// One finished run, before any caller's success rule.
#[derive(Debug)]
pub(crate) struct Run {
    pub(crate) stdout: String,
    pub(crate) stderr: String,
    pub(crate) exit: Exit,
    /// A stream went past `max_buffer` (`execFile`'s maxBuffer error).
    pub(crate) overflow: bool,
    /// Where the chunk that took each stream past `max_buffer` starts (its
    /// text ends with that chunk), for `execFile`'s own cut ([`crate::exec_file`]).
    pub(crate) stdout_crossed_at: Option<usize>,
    pub(crate) stderr_crossed_at: Option<usize>,
}

/// A spawn that threw or failed: Node's `message`, and the error's `code`.
#[derive(Clone, Debug, PartialEq, Eq)]
pub(crate) struct SpawnError {
    pub(crate) message: String,
    pub(crate) code: Option<String>,
}

/// A stream as `execFile` accumulates it: decoded chunks and their byte count.
#[derive(Default)]
struct Sink {
    decoder: Utf8Decoder,
    text: String,
    bytes: usize,
    crossed_at: Option<usize>,
}

impl Sink {
    /// `true` once past `max`.
    fn push(&mut self, chunk: &str, max: usize) -> bool {
        let before = self.bytes;
        self.bytes += chunk.len();
        self.text.push_str(chunk);
        // Only once: the run stops reading both streams at the first.
        if self.bytes > max {
            self.crossed_at = Some(before);
        }
        self.bytes > max
    }
    /// One `data` chunk; `true` once past `max`.
    fn write(&mut self, bytes: &[u8], max: usize) -> bool {
        let chunk = self.decoder.write(bytes);
        self.push(&chunk, max)
    }
    /// `end`: the decoder's tail is the last chunk.
    fn end(&mut self, max: usize) -> bool {
        let tail = self.decoder.end();
        self.push(tail, max)
    }
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

/// `util.inspect(string)` as `ERR_INVALID_ARG_VALUE` prints it: a string
/// over 76 units (`breakLength` 80 less 4) is split after each `\n` into
/// quoted pieces joined with ` +\n  `, and the result is cut to 128 units
/// plus `...`.
pub fn node_inspect_string(s: &str) -> String {
    let units = s.encode_utf16().count();
    let inspected = if units > 76 {
        s.split_inclusive('\n')
            .map(str_escape)
            .collect::<Vec<_>>()
            .join(" +\n  ")
    } else {
        str_escape(s)
    };
    let mut out: Vec<u16> = inspected.encode_utf16().collect();
    if out.len() > 128 {
        out.truncate(128);
        out.extend("...".encode_utf16());
    }
    // A cut through a surrogate pair leaves JS a lone half; drop it.
    char::decode_utf16(out).filter_map(Result::ok).collect()
}

/// Node's `strEscape`: pick the quote (`'`, else `"` when the string has a
/// `'` and no `"`, else a backtick when it has no backtick or `${`), and
/// escape C0 / C1 controls, DEL, `\` and the chosen quote if it is `'`.
fn str_escape(s: &str) -> String {
    let quote = if s.contains('\'') {
        if !s.contains('"') {
            '"'
        } else if !s.contains('`') && !s.contains("${") {
            '`'
        } else {
            '\''
        }
    } else {
        '\''
    };
    let mut out = String::with_capacity(s.len() + 2);
    out.push(quote);
    for c in s.chars() {
        match c {
            '\'' if quote == '\'' => out.push_str("\\'"),
            '\\' => out.push_str("\\\\"),
            '\u{8}' => out.push_str("\\b"),
            '\t' => out.push_str("\\t"),
            '\n' => out.push_str("\\n"),
            '\u{c}' => out.push_str("\\f"),
            '\r' => out.push_str("\\r"),
            c if (c as u32) < 0x20 || (0x7f..0xa0).contains(&(c as u32)) => {
                out.push_str(&format!("\\x{:02X}", c as u32));
            }
            c => out.push(c),
        }
    }
    out.push(quote);
    out
}

/// `normalizeSpawnArguments`' NUL checks: `execFile` throws these.
fn validate_spawn(args: &[&str], cwd: Option<&Path>) -> Result<(), String> {
    for (i, a) in args.iter().enumerate() {
        if a.contains('\0') {
            return Err(format!(
                "The argument 'args[{i}]' must be a string without null bytes. Received {}",
                node_inspect_string(a)
            ));
        }
    }
    if let Some(cwd) = cwd {
        let cwd = cwd.to_string_lossy();
        if cwd.contains('\0') {
            return Err(format!(
                "The property 'options.cwd' must be a string, Uint8Array, or URL without null bytes. Received {}",
                node_inspect_string(&cwd)
            ));
        }
    }
    Ok(())
}

/// Node's message for a failed spawn: the errnos libuv reports after the
/// fact are `spawn <file> <CODE>`; `spawn()` throws the rest as `spawn <CODE>`.
fn spawn_message(file: &str, e: &std::io::Error) -> String {
    match claudius_agent::binary::node_error_code(e) {
        Some(code)
            if matches!(
                code.as_str(),
                "EACCES" | "EAGAIN" | "EMFILE" | "ENFILE" | "ENOENT"
            ) =>
        {
            format!("spawn {file} {code}")
        }
        Some(code) => format!("spawn {code}"),
        None => e.to_string(),
    }
}

#[cfg(unix)]
fn exit_of(status: std::process::ExitStatus) -> Exit {
    use std::os::unix::process::ExitStatusExt;
    match (status.code(), status.signal()) {
        (Some(c), _) => Exit::Code(c),
        // Node names the signal; one it has no name for leaves `exitCode`
        // at libuv's 0, so the run reads as a success.
        (None, Some(sig)) => match claudius_agent::signal_name(sig) {
            Some(name) => Exit::Signal(name),
            None => Exit::Code(0),
        },
        (None, None) => Exit::Code(0),
    }
}

#[cfg(not(unix))]
fn exit_of(status: std::process::ExitStatus) -> Exit {
    Exit::Code(status.code().unwrap_or(0))
}

/// `execFile(program, args, {cwd, maxBuffer, timeout, encoding: "utf8"})`
/// up to its `close` event. `Err` is what the call throws.
async fn run(
    program: &str,
    args: &[&str],
    cwd: Option<&Path>,
    input: Option<&str>,
    timeout: Duration,
    max_buffer: usize,
) -> Result<Run, String> {
    spawn_run(program, args, cwd, input, timeout, max_buffer)
        .await
        .map_err(|e| e.message)
}

/// [`run`], with the thrown error's `code` too.
pub(crate) async fn spawn_run(
    program: &str,
    args: &[&str],
    cwd: Option<&Path>,
    input: Option<&str>,
    timeout: Duration,
    max_buffer: usize,
) -> Result<Run, SpawnError> {
    validate_spawn(args, cwd).map_err(|message| SpawnError {
        message,
        code: Some("ERR_INVALID_ARG_VALUE".into()),
    })?;
    let mut cmd = tokio::process::Command::new(program);
    cmd.args(args)
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped());
    // Node passes an empty cwd as none: the child runs in the server's.
    if let Some(cwd) = cwd.filter(|c| !c.as_os_str().is_empty()) {
        cmd.current_dir(cwd);
    }
    let mut child = cmd.spawn().map_err(|e| SpawnError {
        message: spawn_message(program, &e),
        code: claudius_agent::binary::node_error_code(&e),
    })?;
    let input = input.map(str::to_owned);
    // Own task: a dropped caller doesn't stop git (Node keeps reading).
    let task = tokio::spawn(async move {
        let pid = child.id();
        let mut stdin = child.stdin.take();
        if let Some(text) = input
            && let Some(mut pipe) = stdin.take()
        {
            tokio::spawn(async move {
                let _ = pipe.write_all(text.as_bytes()).await;
                let _ = pipe.shutdown().await;
            });
        }
        let mut stdout = child.stdout.take();
        let mut stderr = child.stderr.take();
        let (mut out, mut err) = (Sink::default(), Sink::default());
        let (mut out_buf, mut err_buf) = (vec![0u8; READ_CHUNK], vec![0u8; READ_CHUNK]);
        let deadline = tokio::time::sleep(timeout);
        tokio::pin!(deadline);
        let mut status = None;
        let mut killed = false;
        let mut overflow = false;
        while stdout.is_some() || stderr.is_some() || status.is_none() {
            let mut kill = false;
            tokio::select! {
                r = read_some(&mut stdout, &mut out_buf), if stdout.is_some() => {
                    let over = match r {
                        Ok(n) if n > 0 => out.write(&out_buf[..n], max_buffer),
                        _ => {
                            stdout = None;
                            out.end(max_buffer)
                        }
                    };
                    overflow |= over;
                    kill |= over;
                }
                r = read_some(&mut stderr, &mut err_buf), if stderr.is_some() => {
                    let over = match r {
                        Ok(n) if n > 0 => err.write(&err_buf[..n], max_buffer),
                        _ => {
                            stderr = None;
                            err.end(max_buffer)
                        }
                    };
                    overflow |= over;
                    kill |= over;
                }
                s = child.wait(), if status.is_none() => {
                    status = Some(s);
                    // Node destroys stdin once the child exits.
                    drop(stdin.take());
                }
                _ = &mut deadline, if !killed => kill = true,
            }
            if kill && !killed {
                // `execFile`'s kill(): destroy both streams, then SIGTERM.
                killed = true;
                stdout = None;
                stderr = None;
                if status.is_none() {
                    terminate(&mut child, pid);
                }
            }
        }
        let exit = match status {
            Some(Ok(s)) => exit_of(s),
            _ => Exit::Code(0),
        };
        Run {
            stdout: out.text,
            stderr: err.text,
            exit,
            overflow,
            stdout_crossed_at: out.crossed_at,
            stderr_crossed_at: err.crossed_at,
        }
    });
    task.await.map_err(|e| SpawnError {
        message: e.to_string(),
        code: None,
    })
}

/// `child.kill("SIGTERM")`.
#[cfg(unix)]
fn terminate(_child: &mut tokio::process::Child, pid: Option<u32>) {
    if let Some(pid) = pid {
        // SAFETY: plain kill(2) on our own unreaped child.
        unsafe {
            libc::kill(pid as libc::pid_t, libc::SIGTERM);
        }
    }
}

#[cfg(not(unix))]
fn terminate(child: &mut tokio::process::Child, _pid: Option<u32>) {
    let _ = child.start_kill();
}

/// TS `git(args, cwd, opts)`: resolves on exit 0; otherwise a
/// [`GitFailure`] carrying both streams.
pub async fn git(args: &[&str], cwd: &Path, opts: GitOpts<'_>) -> Result<GitOutput, ExecError> {
    let timeout = Duration::from_millis(opts.timeout_ms.unwrap_or(TIMEOUT_MS));
    let run = run("git", args, Some(cwd), opts.input, timeout, MAX_BUFFER)
        .await
        .map_err(ExecError::Thrown)?;
    failure_of(args, run)
}

fn failure_of(args: &[&str], run: Run) -> Result<GitOutput, ExecError> {
    let Run {
        stdout,
        stderr,
        exit,
        ..
    } = run;
    let (reason, exit_code) = match exit {
        Exit::Code(0) => return Ok(GitOutput { stdout, stderr }),
        Exit::Code(c) => (format!("exited {c}"), c),
        Exit::Signal(s) => (format!("killed by {s}"), -1),
    };
    let combined = format!("{stdout}{stderr}");
    let combined = js::trim(&combined);
    let verb = args.first().copied().unwrap_or("undefined");
    let message = if combined.is_empty() {
        format!("git {verb} {reason}")
    } else {
        format!("git {verb} {reason}: {combined}")
    };
    Err(ExecError::Failure(GitFailure {
        message,
        exit_code,
        stdout,
        stderr,
    }))
}

/// `execFileP("git", args, …)`: the stdout of a run that exited 0 without
/// tripping `maxBuffer`; `None` for every other outcome.
async fn exec_file_ok(args: &[&str], cwd: Option<&Path>, timeout_ms: u64) -> Option<String> {
    let run = run(
        "git",
        args,
        cwd,
        None,
        Duration::from_millis(timeout_ms),
        EXEC_FILE_MAX_BUFFER,
    )
    .await
    .ok()?;
    (!run.overflow && run.exit == Exit::Code(0)).then_some(run.stdout)
}

/// `isGitInstalled`: `git --version` in the server's cwd, within 1.5 s.
pub async fn is_git_installed() -> bool {
    exec_file_ok(&["--version"], None, INSTALLED_TIMEOUT_MS)
        .await
        .is_some()
}

/// `getRepoRoot`: `git rev-parse --show-toplevel`, trimmed (JS `trim`, so a
/// top level that ends in whitespace comes back without it); `None` outside
/// a work tree or on any failure.
pub async fn get_repo_root(cwd: &str) -> Option<String> {
    let out = exec_file_ok(
        &["rev-parse", "--show-toplevel"],
        Some(Path::new(cwd)),
        TIMEOUT_MS,
    )
    .await?;
    let root = js::trim(&out);
    (!root.is_empty()).then(|| root.to_owned())
}

/// `GitFileChange`.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct GitFileChange {
    pub path: String,
    pub old_path: Option<String>,
    pub index: String,
    pub worktree: String,
    pub untracked: bool,
}

impl GitFileChange {
    pub fn to_json(&self) -> Value {
        let mut o = Map::new();
        o.insert("path".into(), json!(self.path));
        if let Some(p) = &self.old_path {
            o.insert("oldPath".into(), json!(p));
        }
        o.insert("index".into(), json!(self.index));
        o.insert("worktree".into(), json!(self.worktree));
        o.insert("untracked".into(), json!(self.untracked));
        Value::Object(o)
    }
}

/// `GitStatus` for a work tree (`isRepo: true`).
#[derive(Clone, Debug, PartialEq)]
pub struct GitStatus {
    pub repo_root: String,
    pub branch: Option<String>,
    pub head: Option<String>,
    pub ahead: Option<f64>,
    pub behind: Option<f64>,
    pub files: Vec<GitFileChange>,
}

impl GitStatus {
    /// In TS key order; `undefined` fields are left out.
    pub fn to_json(&self) -> Value {
        let mut o = Map::new();
        o.insert("isRepo".into(), json!(true));
        o.insert("repoRoot".into(), json!(self.repo_root));
        if let Some(b) = &self.branch {
            o.insert("branch".into(), json!(b));
        }
        if let Some(h) = &self.head {
            o.insert("head".into(), json!(h));
        }
        if let Some(a) = self.ahead {
            o.insert("ahead".into(), js_num(a));
        }
        if let Some(b) = self.behind {
            o.insert("behind".into(), js_num(b));
        }
        o.insert(
            "files".into(),
            Value::Array(self.files.iter().map(GitFileChange::to_json).collect()),
        );
        Value::Object(o)
    }
}

/// `parsePorcelainV1Z`: NUL-terminated `XY <path>` records; a rename or
/// copy in either column takes the next record as its `oldPath`. Records
/// under 4 UTF-16 units are skipped. The status letters and the path are
/// taken by character: git writes three ASCII characters before the path.
pub fn parse_porcelain_v1_z(buf: &str) -> Vec<GitFileChange> {
    let mut out = vec![];
    if buf.is_empty() {
        return out;
    }
    let parts: Vec<&str> = buf.split('\0').collect();
    let mut i = 0;
    while i < parts.len() {
        let rec = parts[i];
        if rec.encode_utf16().count() < 4 {
            i += 1;
            continue;
        }
        let mut chars = rec.chars();
        let index = chars.next().unwrap_or_default().to_string();
        let worktree = chars.next().unwrap_or_default().to_string();
        chars.next();
        let path = chars.as_str().to_owned();
        let mut old_path = None;
        if ["R", "C"].contains(&index.as_str()) || ["R", "C"].contains(&worktree.as_str()) {
            i += 1;
            old_path = parts.get(i).map(|p| (*p).to_owned());
        }
        out.push(GitFileChange {
            path,
            old_path,
            untracked: index == "?" && worktree == "?",
            index,
            worktree,
        });
        i += 1;
    }
    out
}

/// What `parseBranchHeader` reads off the `## …` record.
#[derive(Clone, Debug, Default, PartialEq)]
pub struct BranchHeader {
    pub branch: Option<String>,
    pub ahead: Option<f64>,
    pub behind: Option<f64>,
}

/// JS `.`: anything but a line terminator.
fn is_line_terminator(c: char) -> bool {
    matches!(c, '\n' | '\r' | '\u{2028}' | '\u{2029}')
}

/// `/<word> (\d+)/` on `s`: the first `<word> ` followed by ASCII digits.
fn count_after(s: &str, word: &str) -> Option<f64> {
    s.match_indices(word).find_map(|(at, w)| {
        let rest = &s[at + w.len()..];
        let n = rest
            .find(|c: char| !c.is_ascii_digit())
            .unwrap_or(rest.len());
        (n > 0).then(|| js::to_number(&rest[..n]))
    })
}

/// `parseBranchHeader`: the porcelain `## …` record.
///   `## main...origin/main [ahead 1, behind 2]`, `## main`,
///   `## HEAD (no branch)`, `## No commits yet on main`.
/// Its regexes are spelled out by hand: `^No commits yet on (.+)$` and
/// `^([^.\s[]+)(?:\.{3}\S+)?(?:\s+\[([^\]]+)\])?\s*$`, `\s` being JS
/// whitespace. So, as in TS, a branch whose name has a `.` in it (`v1.2`)
/// or JS whitespace (NBSP) matches nothing and reads as detached.
pub fn parse_branch_header(line: &str) -> BranchHeader {
    let none = BranchHeader::default();
    let Some(body) = line.strip_prefix("## ") else {
        return none;
    };
    if body.starts_with("HEAD (no branch)") {
        return none;
    }
    if let Some(name) = body.strip_prefix("No commits yet on ")
        && !name.is_empty()
        && !name.contains(is_line_terminator)
    {
        return BranchHeader {
            branch: Some(name.to_owned()),
            ..none
        };
    }
    let ws = js::is_whitespace;
    // `([^.\s[]+)`: it can't give characters back, nothing after it starts with one.
    let end = body
        .find(|c: char| c == '.' || c == '[' || ws(c))
        .unwrap_or(body.len());
    if end == 0 {
        return none;
    }
    let branch = &body[..end];
    let mut rest = &body[end..];
    // `(?:\.{3}\S+)?`: if it can't match, the `.` it leaves fails the rest.
    if let Some(up) = rest.strip_prefix("...") {
        let n = up.find(ws).unwrap_or(up.len());
        if n == 0 {
            return none;
        }
        rest = &up[n..];
    }
    // `(?:\s+\[([^\]]+)\])?\s*$`
    let tracking = if rest.chars().all(ws) {
        None
    } else {
        let after_ws = rest.trim_start_matches(ws);
        if after_ws.len() == rest.len() {
            return none;
        }
        let Some(inner) = after_ws.strip_prefix('[') else {
            return none;
        };
        let Some(close) = inner.find(']') else {
            return none;
        };
        if close == 0 || !inner[close + 1..].chars().all(ws) {
            return none;
        }
        Some(&inner[..close])
    };
    BranchHeader {
        branch: Some(branch.to_owned()),
        ahead: tracking.and_then(|t| count_after(t, "ahead ")),
        behind: tracking.and_then(|t| count_after(t, "behind ")),
    }
}

/// `getStatus`: `git status --porcelain=v1 -b -uall -z` at the repo root,
/// plus `rev-parse --short HEAD` when the header names no branch.
pub async fn get_status(cwd: &str) -> Result<GitStatus, GitError> {
    if !is_git_installed().await {
        return Err(GitError::new(
            GitErrorCode::GitMissing,
            "git is not installed or not on PATH",
        ));
    }
    let Some(root) = get_repo_root(cwd).await else {
        return Err(GitError::new(
            GitErrorCode::NotARepo,
            "workspace is not inside a git repository",
        ));
    };
    let porcelain = git(
        &["status", "--porcelain=v1", "-b", "-uall", "-z"],
        Path::new(&root),
        GitOpts::default(),
    )
    .await
    .map_err(|e| GitError::failed(e.message()))?
    .stdout;
    // The `## …` header is the first NUL-terminated record.
    let (header, records) = porcelain.split_once('\0').unwrap_or((&porcelain, ""));
    let BranchHeader {
        branch,
        ahead,
        behind,
    } = parse_branch_header(header);
    let mut head = None;
    if branch.is_none() {
        // An empty repo has no HEAD to name; leave it out.
        if let Ok(out) = git(
            &["rev-parse", "--short", "HEAD"],
            Path::new(&root),
            GitOpts::default(),
        )
        .await
        {
            head = Some(js::trim(&out.stdout).to_owned());
        }
    }
    let files = parse_porcelain_v1_z(records);
    Ok(GitStatus {
        repo_root: root,
        branch,
        head,
        ahead,
        behind,
        files,
    })
}

/// `DiffMode`.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum DiffMode {
    /// index → working tree
    Worktree,
    /// HEAD → index
    Staged,
    /// `/dev/null` → the file
    Untracked,
}

impl DiffMode {
    pub const ALL: [DiffMode; 3] = [DiffMode::Worktree, DiffMode::Staged, DiffMode::Untracked];

    pub fn as_str(self) -> &'static str {
        match self {
            DiffMode::Worktree => "worktree",
            DiffMode::Staged => "staged",
            DiffMode::Untracked => "untracked",
        }
    }
    pub fn parse(s: &str) -> Option<DiffMode> {
        DiffMode::ALL.into_iter().find(|m| m.as_str() == s)
    }
}

/// `{ diff, binary }`.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct Diff {
    pub diff: String,
    pub binary: bool,
}

impl Diff {
    fn of(diff: String) -> Diff {
        Diff {
            binary: has_binary_line(&diff),
            diff,
        }
    }
    pub fn to_json(&self) -> Value {
        json!({"diff": self.diff, "binary": self.binary})
    }
}

/// `/^Binary files /m`: at the start or after any JS line terminator
/// (`\r` and U+2028 / U+2029 too).
pub fn has_binary_line(s: &str) -> bool {
    s.match_indices("Binary files ")
        .any(|(at, _)| at == 0 || s[..at].ends_with(is_line_terminator))
}

/// `getDiff`: `git diff [--cached] --no-color --no-textconv -- <path>`, or
/// for `untracked` a `--no-index` diff against `/dev/null`. The path is
/// never an option; git's pathspec magic and globs still apply, and as in
/// TS, `--no-index` reads a path outside the repository too.
pub async fn get_diff(cwd: &str, path: &str, mode: DiffMode) -> Result<Diff, GitError> {
    let Some(root) = get_repo_root(cwd).await else {
        return Err(GitError::new(
            GitErrorCode::NotARepo,
            "not a git repository",
        ));
    };
    if mode == DiffMode::Untracked {
        return diff_no_index(&root, path).await.map_err(GitError::failed);
    }
    let args: &[&str] = if mode == DiffMode::Staged {
        &[
            "diff",
            "--cached",
            "--no-color",
            "--no-textconv",
            "--",
            path,
        ]
    } else {
        &["diff", "--no-color", "--no-textconv", "--", path]
    };
    match git(args, Path::new(&root), GitOpts::default()).await {
        Ok(out) => Ok(Diff::of(out.stdout)),
        Err(e) => Err(GitError::failed(e.message())),
    }
}

/// `diffNoIndex`: exit 1 ("they differ", and also "could not access") is a
/// success like 0; any other exit rejects with stderr, or `git diff
/// --no-index exited <code>` (`null` when a signal killed it).
pub async fn diff_no_index(root: &str, path: &str) -> Result<Diff, String> {
    let args = [
        "diff",
        "--no-index",
        "--no-color",
        "--no-textconv",
        "--",
        "/dev/null",
        path,
    ];
    let run = run(
        "git",
        &args,
        Some(Path::new(root)),
        None,
        Duration::from_millis(TIMEOUT_MS),
        MAX_BUFFER,
    )
    .await?;
    match run.exit {
        Exit::Code(0 | 1) => Ok(Diff::of(run.stdout)),
        exit => {
            let stderr = js::trim(&run.stderr);
            if !stderr.is_empty() {
                return Err(stderr.to_owned());
            }
            Err(match exit {
                Exit::Code(c) => format!("git diff --no-index exited {c}"),
                Exit::Signal(_) => "git diff --no-index exited null".to_owned(),
            })
        }
    }
}

/// `gitShow`'s "no blob at that revision" test,
/// `/exists on disk, but not in|does not exist|fatal: path/i`.
pub fn is_missing_blob(message: &str) -> bool {
    let m = message.to_ascii_lowercase();
    [
        "exists on disk, but not in",
        "does not exist",
        "fatal: path",
    ]
    .iter()
    .any(|n| m.contains(n))
}

/// `gitShow`: `git show <rev>:<path>` (`rev = ""` is the index). A blob the
/// revision doesn't have reads as `""`.
///
/// Not TS: a `rev` starting with `-` is refused instead of reaching git as
/// an option, with git's unknown-option failure (what TS returns for most
/// such refs; the ones git takes as options, like `--output=…`, differ).
pub async fn git_show(cwd: &str, rev: &str, path: &str) -> Result<String, GitError> {
    let Some(root) = get_repo_root(cwd).await else {
        return Err(GitError::new(
            GitErrorCode::NotARepo,
            "not a git repository",
        ));
    };
    let spec = format!("{rev}:{path}");
    let result = if spec.starts_with('-') {
        Err(format!(
            "git show exited 128: fatal: unrecognized argument: {spec}"
        ))
    } else {
        git(&["show", &spec], Path::new(&root), GitOpts::default())
            .await
            .map(|o| o.stdout)
            .map_err(|e| e.message().to_owned())
    };
    match result {
        Ok(content) => Ok(content),
        Err(m) if is_missing_blob(&m) => Ok(String::new()),
        Err(m) => Err(GitError::failed(m)),
    }
}

// ------------------------------ branches (D07) ------------------------------

/// `isValidRefName`: what every branch name or ref passes before it reaches
/// git. A leading `-` (an option to git), more than 255 UTF-16 units, JS
/// whitespace or one of `~ ^ : ? * [ \`, `..` or `@{`, and a trailing `/` or
/// `.lock` are refused. Other control characters, NUL included, and a NEL
/// pass (git, or `execFile`'s NUL check, refuses them later).
pub fn is_valid_ref_name(name: &str) -> bool {
    !name.is_empty()
        && !name.starts_with('-')
        && name.encode_utf16().count() <= 255
        && !name
            .chars()
            .any(|c| js::is_whitespace(c) || matches!(c, '~' | '^' | ':' | '?' | '*' | '[' | '\\'))
        && !name.contains("..")
        && !name.contains("@{")
        && !name.ends_with('/')
        && !name.ends_with(".lock")
}

/// The `catch` of the branch commands: a git failure's output (stdout +
/// stderr, trimmed), or its `git <verb> …` message when there was none;
/// a throw's message.
fn failure_text(e: ExecError) -> String {
    match e {
        ExecError::Failure(f) => {
            let output = f.output();
            if output.is_empty() { f.message } else { output }
        }
        ExecError::Thrown(m) => m,
    }
}

/// `{ code: "not-a-repo", message: "not a git repository" }`.
fn not_a_repo() -> GitError {
    GitError::new(GitErrorCode::NotARepo, "not a git repository")
}

/// A successful run's `(stdout + stderr).trim()`.
fn combined(out: &GitOutput) -> String {
    js::trim(&format!("{}{}", out.stdout, out.stderr)).to_owned()
}

/// `git(args, root)` for the branch commands: the combined output, or the
/// failure's text.
async fn run_branch_command(
    args: &[&str],
    root: &str,
    opts: GitOpts<'_>,
) -> Result<String, GitError> {
    git(args, Path::new(root), opts)
        .await
        .map(|o| combined(&o))
        .map_err(|e| GitError::failed(failure_text(e)))
}

/// `GitBranch.kind`.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum BranchKind {
    Local,
    Remote,
}

impl BranchKind {
    pub fn as_str(self) -> &'static str {
        match self {
            BranchKind::Local => "local",
            BranchKind::Remote => "remote",
        }
    }
}

/// `GitBranch`.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct GitBranch {
    /// `%(refname:short)`: `main`, `origin/main`, or `heads/x` when the
    /// short name is ambiguous.
    pub name: String,
    pub kind: BranchKind,
    pub sha: String,
    /// `upstream || undefined`.
    pub upstream: Option<String>,
    pub committer_date: String,
    pub current: bool,
}

impl GitBranch {
    /// In TS key order; no `upstream` key without one.
    pub fn to_json(&self) -> Value {
        let mut o = Map::new();
        o.insert("name".into(), json!(self.name));
        o.insert("kind".into(), json!(self.kind.as_str()));
        o.insert("sha".into(), json!(self.sha));
        if let Some(u) = &self.upstream {
            o.insert("upstream".into(), json!(u));
        }
        o.insert("committerDate".into(), json!(self.committer_date));
        o.insert("current".into(), json!(self.current));
        Value::Object(o)
    }
}

/// `listBranches`' for-each-ref format: six `%00`-separated fields.
const BRANCH_FORMAT: &str = "--format=%(refname)%00%(refname:short)%00%(objectname:short)%00%(upstream:short)%00%(committerdate:iso8601)%00%(HEAD)";

/// `listBranches`' parse of the for-each-ref lines: `\n`-separated (a `\r`
/// stays in the line), each split on NUL into refname, short name, sha,
/// upstream, date and the HEAD flag; a missing field reads as `""`. A line
/// without a refname or a short name is skipped, and so is a remote whose
/// short name is `<one segment>/HEAD` (git shortens `refs/remotes/o/HEAD`
/// to `o`, which stays).
pub fn parse_branch_list(stdout: &str) -> Vec<GitBranch> {
    let mut out = vec![];
    for line in stdout.split('\n') {
        if line.is_empty() {
            continue;
        }
        let mut fields = line.split('\0');
        let mut next = || fields.next().unwrap_or("");
        let (refname, name, sha, upstream, date, head) =
            (next(), next(), next(), next(), next(), next());
        if refname.is_empty() || name.is_empty() {
            continue;
        }
        let kind = if refname.starts_with("refs/remotes/") {
            BranchKind::Remote
        } else {
            BranchKind::Local
        };
        // `/^[^/]+\/HEAD$/`
        let remote_head = name
            .strip_suffix("/HEAD")
            .is_some_and(|r| !r.is_empty() && !r.contains('/'));
        if kind == BranchKind::Remote && remote_head {
            continue;
        }
        out.push(GitBranch {
            name: name.to_owned(),
            kind,
            sha: sha.to_owned(),
            upstream: (!upstream.is_empty()).then(|| upstream.to_owned()),
            committer_date: date.to_owned(),
            current: head == "*",
        });
    }
    out
}

/// `listBranches`: local and remote-tracking branches, newest commit first,
/// in one `for-each-ref`. A failing run is its `git for-each-ref …` message.
pub async fn list_branches(cwd: &str) -> Result<Vec<GitBranch>, GitError> {
    let Some(root) = get_repo_root(cwd).await else {
        return Err(not_a_repo());
    };
    let args = [
        "for-each-ref",
        BRANCH_FORMAT,
        "--sort=-committerdate",
        "refs/heads",
        "refs/remotes",
    ];
    match git(&args, Path::new(&root), GitOpts::default()).await {
        Ok(out) => Ok(parse_branch_list(&out.stdout)),
        Err(e) => Err(GitError::failed(e.message())),
    }
}

/// `refExists`: `git show-ref --verify --quiet <ref>` exits 0 (an
/// `execFileP` probe: any failure, a NUL included, is `false`).
async fn ref_exists(root: &str, r: &str) -> bool {
    exec_file_ok(
        &["show-ref", "--verify", "--quiet", r],
        Some(Path::new(root)),
        TIMEOUT_MS,
    )
    .await
    .is_some()
}

/// `checkoutBranch(cwd, { name, create, startPoint })`: the combined output.
///   * `create`: `git switch -c <name> [<startPoint>]`;
///   * a local branch: `git switch <name>`;
///   * a remote-tracking `<remote>/<rest>`: `git switch <rest>` when that
///     local exists, else `git switch --track <name>` (git picks the local
///     name);
///   * otherwise `unknown branch: <name>`.
///
/// The name is trimmed, the start point isn't; both must pass
/// [`is_valid_ref_name`] (the start point even without `create`). Git's
/// dirty-tree refusal comes back as is.
pub async fn checkout_branch(
    cwd: &str,
    name: &str,
    create: bool,
    start_point: Option<&str>,
) -> Result<String, GitError> {
    let Some(root) = get_repo_root(cwd).await else {
        return Err(not_a_repo());
    };
    let name = js::trim(name);
    if !is_valid_ref_name(name) {
        return Err(GitError::failed("invalid branch name"));
    }
    if start_point.is_some_and(|s| !is_valid_ref_name(s)) {
        return Err(GitError::failed("invalid start point"));
    }
    let local_name;
    let args: Vec<&str> = if create {
        let mut args = vec!["switch", "-c", name];
        args.extend(start_point.filter(|s| !s.is_empty()));
        args
    } else if ref_exists(&root, &format!("refs/heads/{name}")).await {
        vec!["switch", name]
    } else if ref_exists(&root, &format!("refs/remotes/{name}")).await {
        // "origin/foo" → "foo": everything after the first slash.
        local_name = name.split_once('/').map_or("", |(_, rest)| rest);
        if local_name.is_empty() || !is_valid_ref_name(local_name) {
            return Err(GitError::failed("could not derive local branch name"));
        }
        if ref_exists(&root, &format!("refs/heads/{local_name}")).await {
            vec!["switch", local_name]
        } else {
            vec!["switch", "--track", name]
        }
    } else {
        return Err(GitError::failed(format!("unknown branch: {name}")));
    };
    run_branch_command(&args, &root, GitOpts::default()).await
}

/// `renameBranch`: `git branch -m <old> <new>` on the trimmed names (no
/// `-M`); git prints nothing on success, which reads `Renamed 'o' → 'n'`.
pub async fn rename_branch(cwd: &str, old_name: &str, new_name: &str) -> Result<String, GitError> {
    let Some(root) = get_repo_root(cwd).await else {
        return Err(not_a_repo());
    };
    let (o, n) = (js::trim(old_name), js::trim(new_name));
    if !is_valid_ref_name(o) || !is_valid_ref_name(n) {
        return Err(GitError::failed("invalid branch name"));
    }
    let out = run_branch_command(&["branch", "-m", o, n], &root, GitOpts::default()).await?;
    Ok(if out.is_empty() {
        format!("Renamed '{o}' \u{2192} '{n}'")
    } else {
        out
    })
}

/// `deleteLocalBranch`: `git branch -d <name>`, or `-D` with `force`.
pub async fn delete_local_branch(cwd: &str, name: &str, force: bool) -> Result<String, GitError> {
    let Some(root) = get_repo_root(cwd).await else {
        return Err(not_a_repo());
    };
    let name = js::trim(name);
    if !is_valid_ref_name(name) {
        return Err(GitError::failed("invalid branch name"));
    }
    let flag = if force { "-D" } else { "-d" };
    run_branch_command(&["branch", flag, name], &root, GitOpts::default()).await
}

/// `deleteRemoteBranch`: `<remote>/<branch>`, split at the first slash, as
/// `git push <remote> --delete <branch>` under the hook timeout. The remote
/// is any name git takes: `./x` pushes to the repo itself and deletes its
/// local `x`, and a remote whose name has a slash is misparsed.
pub async fn delete_remote_branch(cwd: &str, remote_ref: &str) -> Result<String, GitError> {
    let Some(root) = get_repo_root(cwd).await else {
        return Err(not_a_repo());
    };
    let trimmed = js::trim(remote_ref);
    if !is_valid_ref_name(trimmed) {
        return Err(GitError::failed("invalid branch name"));
    }
    let (remote, branch) = match trimmed.split_once('/') {
        Some((remote, branch)) if !remote.is_empty() && !branch.is_empty() => (remote, branch),
        _ => return Err(GitError::failed("expected <remote>/<branch>")),
    };
    if !is_valid_ref_name(remote) || !is_valid_ref_name(branch) {
        return Err(GitError::failed("invalid remote or branch name"));
    }
    let opts = GitOpts {
        input: None,
        timeout_ms: Some(HOOK_TIMEOUT_MS),
    };
    run_branch_command(&["push", remote, "--delete", branch], &root, opts).await
}

/// A run's stdout, or the failure's text.
async fn stdout_of(args: &[&str], root: &str) -> Result<String, GitError> {
    git(args, Path::new(root), GitOpts::default())
        .await
        .map(|o| o.stdout)
        .map_err(|e| GitError::failed(failure_text(e)))
}

/// `compareBranches`: `log --oneline base..head`, `head..base` and
/// `diff --stat base...head` (no colour, no textconv), one after the other,
/// as the console report. The names aren't trimmed.
pub async fn compare_branches(cwd: &str, base: &str, head: &str) -> Result<String, GitError> {
    let Some(root) = get_repo_root(cwd).await else {
        return Err(not_a_repo());
    };
    if !is_valid_ref_name(base) || !is_valid_ref_name(head) {
        return Err(GitError::failed("invalid branch name"));
    }
    let (ahead, behind, both) = (
        format!("{base}..{head}"),
        format!("{head}..{base}"),
        format!("{base}...{head}"),
    );
    let ahead = stdout_of(&["log", "--oneline", "--no-color", &ahead], &root).await?;
    let behind = stdout_of(&["log", "--oneline", "--no-color", &behind], &root).await?;
    let stat = stdout_of(
        &["diff", "--stat", "--no-color", "--no-textconv", &both],
        &root,
    )
    .await?;
    let (ahead, behind, stat) = (js::trim(&ahead), js::trim(&behind), js::trim(&stat));
    let count = |list: &str| {
        if list.is_empty() {
            0
        } else {
            list.split('\n').count()
        }
    };
    let or_none = |list: &str| {
        if list.is_empty() {
            "(none)".to_owned()
        } else {
            list.to_owned()
        }
    };
    let mut lines = vec![
        format!("# Comparing {base} \u{2194} {head}"),
        String::new(),
        format!("## {head} has {} commit(s) not in {base}:", count(ahead)),
        or_none(ahead),
        String::new(),
        format!("## {base} has {} commit(s) not in {head}:", count(behind)),
        or_none(behind),
    ];
    if !stat.is_empty() {
        lines.push(String::new());
        lines.push(format!("## File-level diff ({base}...{head}):"));
        lines.push(stat.to_owned());
    }
    Ok(lines.join("\n"))
}

/// `diffBranchAgainstWorktree`: `git diff --no-color --no-textconv <branch>`
/// (the branch's tip against the working tree; a name that is only a path
/// diffs that path), trimmed. A repo's `diff.external` runs.
pub async fn diff_branch_against_worktree(cwd: &str, branch: &str) -> Result<String, GitError> {
    let Some(root) = get_repo_root(cwd).await else {
        return Err(not_a_repo());
    };
    if !is_valid_ref_name(branch) {
        return Err(GitError::failed("invalid branch name"));
    }
    let out = stdout_of(&["diff", "--no-color", "--no-textconv", branch], &root).await?;
    let out = js::trim(&out);
    Ok(if out.is_empty() {
        format!("(no differences between {branch} and the working tree)")
    } else {
        out.to_owned()
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    fn rec(path: &str, old: Option<&str>, x: &str, y: &str) -> GitFileChange {
        GitFileChange {
            path: path.into(),
            old_path: old.map(Into::into),
            index: x.into(),
            worktree: y.into(),
            untracked: x == "?" && y == "?",
        }
    }

    #[test]
    fn porcelain_records() {
        assert_eq!(parse_porcelain_v1_z(""), vec![]);
        assert_eq!(
            parse_porcelain_v1_z(" M a\0R  new\0old\0?? d/e f\0 C c\0src\0MM x\0"),
            vec![
                rec("a", None, " ", "M"),
                rec("new", Some("old"), "R", " "),
                rec("d/e f", None, "?", "?"),
                rec("c", Some("src"), " ", "C"),
                rec("x", None, "M", "M"),
            ]
        );
        // Short records are skipped; a trailing rename takes "" or nothing.
        assert_eq!(
            parse_porcelain_v1_z("M \0?? \0 M é\0R  z\0"),
            vec![rec("é", None, " ", "M"), rec("z", Some(""), "R", " ")]
        );
        assert_eq!(parse_porcelain_v1_z("C  z"), vec![rec("z", None, "C", " ")]);
        // Units, not bytes: one astral character is two of the four.
        assert_eq!(
            parse_porcelain_v1_z("?? \u{1f600}"),
            vec![rec("\u{1f600}", None, "?", "?")]
        );
        assert_eq!(parse_porcelain_v1_z("?? "), vec![]);
        // Four bytes but two units: skipped.
        assert_eq!(parse_porcelain_v1_z("M\u{20ac}\0"), vec![]);
        // `?` in one column only isn't untracked.
        assert!(!parse_porcelain_v1_z("?M p")[0].untracked);
        assert!(!parse_porcelain_v1_z("M? p")[0].untracked);
    }

    #[test]
    fn branch_headers() {
        let h = |b: Option<&str>, a: Option<f64>, be: Option<f64>| BranchHeader {
            branch: b.map(Into::into),
            ahead: a,
            behind: be,
        };
        let cases: &[(&str, BranchHeader)] = &[
            ("## main", h(Some("main"), None, None)),
            ("main", h(None, None, None)),
            ("##  main", h(None, None, None)),
            ("## main...origin/main", h(Some("main"), None, None)),
            (
                "## main...origin/main [ahead 1]",
                h(Some("main"), Some(1.0), None),
            ),
            (
                "## main...o/m [ahead 1, behind 22]",
                h(Some("main"), Some(1.0), Some(22.0)),
            ),
            ("## main...o/m [behind 3]", h(Some("main"), None, Some(3.0))),
            ("## main...o/m [gone]", h(Some("main"), None, None)),
            (
                "## main...o/m [ahead x, ahead 007]",
                h(Some("main"), Some(7.0), None),
            ),
            (
                "## main...o/m   [ahead 2]  ",
                h(Some("main"), Some(2.0), None),
            ),
            ("## main [ahead 2]", h(Some("main"), Some(2.0), None)),
            ("## main...o/m [ahead 2] x", h(None, None, None)),
            ("## main...o/m [ahead 2", h(None, None, None)),
            ("## main...o/m []", h(None, None, None)),
            ("## main...o/m[ahead 2]", h(None, None, None)),
            ("## main...", h(None, None, None)),
            ("## main... ", h(None, None, None)),
            ("## main....x", h(Some("main"), None, None)),
            ("## main..x", h(None, None, None)),
            ("## v1.2", h(None, None, None)),
            ("## a[b", h(None, None, None)),
            // `\s+\[`: the bracket needs whitespace before it.
            ("## a[ahead 1]", h(None, None, None)),
            ("## a[b]", h(None, None, None)),
            ("## main  ", h(Some("main"), None, None)),
            ("## ", h(None, None, None)),
            ("##  ", h(None, None, None)),
            ("## \t", h(None, None, None)),
            ("## [x]", h(None, None, None)),
            ("## a...b\u{85}c", h(Some("a"), None, None)),
            ("## a\u{a0}b", h(None, None, None)),
            ("## a\u{85}b", h(Some("a\u{85}b"), None, None)),
            ("## a\u{feff}", h(Some("a"), None, None)),
            ("## a...b\u{a0}c", h(None, None, None)),
            ("## a [x\n] ", h(Some("a"), None, None)),
            ("## HEAD (no branch)", h(None, None, None)),
            ("## HEAD (no branch) x", h(None, None, None)),
            ("## No commits yet on main", h(Some("main"), None, None)),
            ("## No commits yet on v1.0 x", h(Some("v1.0 x"), None, None)),
            ("## No commits yet on ", h(None, None, None)),
            ("## No commits yet on a\u{2028}b", h(None, None, None)),
            ("## No commits yet on a\rb", h(None, None, None)),
            (
                "## No commits yet on a\u{85}b",
                h(Some("a\u{85}b"), None, None),
            ),
            (
                "## main...o/m [ahead 99999999999999999999]",
                h(Some("main"), Some(1e20), None),
            ),
        ];
        for (line, want) in cases {
            assert_eq!(&parse_branch_header(line), want, "{line:?}");
        }
    }

    #[test]
    fn binary_lines() {
        assert!(has_binary_line("Binary files a and b differ"));
        assert!(has_binary_line("x\nBinary files "));
        assert!(has_binary_line("x\rBinary files "));
        assert!(has_binary_line("x\u{2028}Binary files "));
        assert!(has_binary_line("x\u{2029}Binary files "));
        assert!(!has_binary_line("x\u{85}Binary files "));
        assert!(!has_binary_line("+Binary files a"));
        assert!(!has_binary_line("Binary files"));
        assert!(!has_binary_line("binary files a"));
        assert!(has_binary_line("+Binary files x\nBinary files y"));
    }

    #[test]
    fn missing_blob_messages() {
        assert!(is_missing_blob("fatal: Path 'x' DOES NOT EXIST in 'HEAD'"));
        assert!(is_missing_blob(
            "fatal: path 'x' exists on disk, but not in 'HEAD'"
        ));
        assert!(is_missing_blob(
            "git show exited 128: FATAL: PATH 'x' is in the index"
        ));
        assert!(!is_missing_blob("fatal: invalid object name 'x'."));
        assert!(!is_missing_blob("fatal:  path"));
    }

    #[test]
    fn inspect_strings_like_node() {
        // The recorded `util.inspect` forms (node 22).
        assert_eq!(node_inspect_string("a\0b"), "'a\\x00b'");
        assert_eq!(node_inspect_string("it's\0"), "\"it's\\x00\"");
        assert_eq!(node_inspect_string("q\"'\0"), "`q\"'\\x00`");
        assert_eq!(node_inspect_string("q\"'`\0"), "'q\"\\'`\\x00'");
        assert_eq!(node_inspect_string("q\"'${\0"), "'q\"\\'${\\x00'");
        assert_eq!(
            node_inspect_string("\x7f\u{85}\0\t\n\\\u{8}\u{b}\u{c}\r\u{1b}\u{9f}\u{a0}"),
            "'\\x7F\\x85\\x00\\t\\n\\\\\\b\\x0B\\f\\r\\x1B\\x9F\u{a0}'"
        );
        let long = format!("{}\n\0{}", "x".repeat(120), "y\n".repeat(20));
        assert_eq!(
            node_inspect_string(&long),
            format!("'{}\\n' +\n ...", "x".repeat(120))
        );
        let long = format!("\0{}", "z".repeat(200));
        assert_eq!(
            node_inspect_string(&long),
            format!("'\\x00{}...", "z".repeat(123))
        );
        // Up to 76 units it stays one piece (recorded at 62, 76, 77, 124, 125).
        let s = format!("{}\n\0", "a".repeat(74));
        assert_eq!(
            node_inspect_string(&s),
            format!("'{}\\n\\x00'", "a".repeat(74))
        );
        let s = format!("{}\n\0", "a".repeat(75));
        assert_eq!(
            node_inspect_string(&s),
            format!("'{}\\n' +\n  '\\x00'", "a".repeat(75))
        );
        let s = format!("{}\n\0", "a".repeat(122));
        assert_eq!(
            node_inspect_string(&s),
            format!("'{}\\n' +...", "a".repeat(122))
        );
        let s = format!("{}\n\0", "a".repeat(123));
        assert_eq!(
            node_inspect_string(&s),
            format!("'{}\\n' ...", "a".repeat(123))
        );
        // Cut only past 128 units: 122 fill 128 exactly.
        let s = format!("\0{}", "a".repeat(122));
        assert_eq!(
            node_inspect_string(&s),
            format!("'\\x00{}'", "a".repeat(122))
        );
        let s = format!("\0{}", "a".repeat(123));
        assert_eq!(
            node_inspect_string(&s),
            format!("'\\x00{}...", "a".repeat(123))
        );
        let s = format!("{}\n\0", "a".repeat(10));
        assert_eq!(node_inspect_string(&s), "'aaaaaaaaaa\\n\\x00'");
    }

    #[test]
    fn spawn_checks_throw_like_execfile() {
        assert_eq!(
            validate_spawn(&["diff", "--", "a\0b"], None),
            Err(
                "The argument 'args[2]' must be a string without null bytes. Received 'a\\x00b'"
                    .into()
            )
        );
        assert_eq!(
            validate_spawn(&["diff"], Some(Path::new("a\0b"))),
            Err("The property 'options.cwd' must be a string, Uint8Array, or URL without null bytes. Received 'a\\x00b'".into())
        );
        assert_eq!(validate_spawn(&["diff"], Some(Path::new("/tmp"))), Ok(()));
    }

    fn sh(script: &str) -> Vec<&str> {
        vec!["-c", script]
    }

    async fn run_sh(script: &str, timeout_ms: u64, max: usize) -> Run {
        run(
            "/bin/sh",
            &sh(script),
            None,
            None,
            Duration::from_millis(timeout_ms),
            max,
        )
        .await
        .unwrap()
    }

    #[cfg(unix)]
    #[tokio::test]
    async fn exits_and_messages() {
        let r = run_sh(
            "printf 'out '; printf 'err ' >&2; exit 3",
            5_000,
            MAX_BUFFER,
        )
        .await;
        assert_eq!(
            (r.stdout.as_str(), r.stderr.as_str(), r.exit),
            ("out ", "err ", Exit::Code(3))
        );
        let e = failure_of(&["status", "x"], r).unwrap_err();
        assert_eq!(e.message(), "git status exited 3: out err");
        let ExecError::Failure(f) = e else { panic!() };
        assert_eq!((f.exit_code, f.output().as_str()), (3, "out err"));
        // No output: no colon.
        let r = run_sh("exit 1", 5_000, MAX_BUFFER).await;
        assert_eq!(
            failure_of(&["diff"], r).unwrap_err().message(),
            "git diff exited 1"
        );
        let r = run_sh("printf ' \\n'; exit 0", 5_000, MAX_BUFFER).await;
        assert_eq!(
            failure_of(&["x"], r),
            Ok(GitOutput {
                stdout: " \n".into(),
                stderr: String::new()
            })
        );
        // JS `trim`: a trailing NEL stays.
        let r = run_sh("printf 'x\\302\\205 '; exit 1", 5_000, MAX_BUFFER).await;
        let ExecError::Failure(f) = failure_of(&["log"], r).unwrap_err() else {
            panic!()
        };
        assert_eq!(
            (f.message.as_str(), f.output().as_str()),
            ("git log exited 1: x\u{85}", "x\u{85}")
        );
        // Killed: the signal's name, exit code -1.
        let r = run_sh("printf partial; kill -KILL $$", 5_000, MAX_BUFFER).await;
        assert_eq!(r.exit, Exit::Signal("SIGKILL"));
        let ExecError::Failure(f) = failure_of(&["show"], r).unwrap_err() else {
            panic!()
        };
        assert_eq!(
            (f.message.as_str(), f.exit_code),
            ("git show killed by SIGKILL: partial", -1)
        );
        // A signal Node has no name for (SIGEMT on macOS) reads as exit 0:
        // `close` gives (0, null), recorded with node 22.
        #[cfg(target_os = "macos")]
        {
            let r = run_sh("printf x; kill -EMT $$", 5_000, MAX_BUFFER).await;
            assert_eq!(r.exit, Exit::Code(0));
            assert!(failure_of(&["show"], r).is_ok());
        }
        // Bad bytes decode to U+FFFD, a cut sequence at the end too.
        let r = run_sh("printf 'a\\377b\\342\\202'", 5_000, MAX_BUFFER).await;
        assert_eq!(r.stdout, "a\u{fffd}b\u{fffd}");
    }

    #[cfg(unix)]
    #[tokio::test]
    async fn timeout_terminates() {
        let t0 = std::time::Instant::now();
        let r = run_sh("printf before; exec sleep 30", 1_000, MAX_BUFFER).await;
        // At the timeout, not before it (and well short of twice it).
        let took = t0.elapsed();
        assert!(
            (Duration::from_millis(1_000)..Duration::from_millis(1_900)).contains(&took),
            "{took:?}"
        );
        assert_eq!(
            (r.stdout.as_str(), r.exit, r.overflow),
            ("before", Exit::Signal("SIGTERM"), false)
        );
        assert_eq!(
            failure_of(&["push"], r).unwrap_err().message(),
            "git push killed by SIGTERM: before"
        );
    }

    #[cfg(unix)]
    #[tokio::test]
    async fn max_buffer_keeps_the_crossing_chunk() {
        // One 100-byte write per chunk, then a stall: the 10th chunk crosses
        // 950 bytes and is kept whole; nothing after it is read.
        let script = "i=0; while [ $i -lt 20 ]; do printf '%0100d' 0; sleep 0.05; i=$((i+1)); done";
        let r = run_sh(script, 10_000, 950).await;
        assert!(r.overflow);
        assert_eq!(r.stdout.len(), 1000, "{}", r.stdout.len());
        assert!(
            matches!(r.exit, Exit::Signal("SIGTERM") | Exit::Signal("SIGPIPE")),
            "{:?}",
            r.exit
        );
        // The streams are closed at the kill: a child that ignores SIGTERM
        // dies of SIGPIPE at its next write (recorded with node 22).
        let script = format!("trap '' TERM; {script}");
        let r = run_sh(&script, 10_000, 950).await;
        assert!(r.overflow);
        assert_eq!((r.stdout.len(), r.exit), (1000, Exit::Signal("SIGPIPE")));
        // A read takes up to 64 KiB, as libuv's: one 64 KiB write arrives as
        // one chunk and is kept whole (node 22 keeps all 65536 too).
        let r = run_sh(
            "dd if=/dev/zero bs=65536 count=1 2>/dev/null; exec sleep 30",
            10_000,
            10,
        )
        .await;
        assert!(r.overflow);
        assert_eq!(r.stdout.len(), 65536);
        // The decoder's tail at EOF is a chunk too: "a" + U+FFFD is 4 bytes.
        let r = run_sh("printf 'a\\342'", 5_000, 2).await;
        assert!(r.overflow);
        assert_eq!(r.stdout, "a\u{fffd}");
        let r = run_sh("printf 'a\\342'", 5_000, 4).await;
        assert!(!r.overflow);
        // stderr counts on its own.
        let r = run_sh("printf '%0100d' 0 >&2; printf '%0100d' 0", 10_000, 150).await;
        assert!(!r.overflow);
        assert_eq!((r.stdout.len(), r.stderr.len()), (100, 100));
        let r = run_sh("printf '%0200d' 0 >&2; exec sleep 30", 10_000, 150).await;
        assert!(r.overflow);
        assert_eq!(r.stderr.len(), 200);
        // Exactly at the limit is fine.
        let r = run_sh("printf '%0150d' 0", 10_000, 150).await;
        assert!(!r.overflow);
        assert_eq!(r.exit, Exit::Code(0));
    }

    #[cfg(unix)]
    #[tokio::test]
    async fn stdin_stays_open_unless_input_is_given() {
        // `cat` would wait forever on an open stdin: the timeout ends it.
        let r = run(
            "/bin/cat",
            &[],
            None,
            None,
            Duration::from_millis(300),
            MAX_BUFFER,
        )
        .await
        .unwrap();
        assert_eq!(r.exit, Exit::Signal("SIGTERM"));
        let r = run(
            "/bin/cat",
            &[],
            None,
            Some("msg\n"),
            Duration::from_secs(10),
            MAX_BUFFER,
        )
        .await
        .unwrap();
        assert_eq!((r.stdout.as_str(), r.exit), ("msg\n", Exit::Code(0)));
        // Node destroys stdin once the child exits: a grandchild still
        // reading it (a hook's background job) gets EOF and lets the run end.
        let r = run_sh(
            "exec 3<&0; (cat <&3 >/dev/null; echo done) & exit 0",
            5_000,
            MAX_BUFFER,
        )
        .await;
        assert_eq!((r.stdout.as_str(), r.exit), ("done\n", Exit::Code(0)));
        // The git wrapper takes it too.
        let dir = tempfile::tempdir().unwrap();
        let out = git(
            &["hash-object", "--stdin"],
            dir.path(),
            GitOpts {
                input: Some("x\n"),
                timeout_ms: None,
            },
        )
        .await
        .unwrap();
        assert_eq!(out.stdout, "587be6b4c3f93f93c489c0111bba5596147a26cb\n");
    }

    #[cfg(unix)]
    #[tokio::test]
    async fn spawn_errors_read_like_node() {
        let e = run(
            "git",
            &["status"],
            Some(Path::new("/nonexistent-claudius-d06")),
            None,
            Duration::from_secs(5),
            MAX_BUFFER,
        )
        .await
        .unwrap_err();
        assert_eq!(e, "spawn git ENOENT");
        // The errnos `spawn()` throws itself (a cwd that is a file: libuv's
        // own PATH walk reports ENOTDIR, where std's `posix_spawnp` says
        // ENOENT; only `getRepoRoot` sees such a cwd, and it swallows both).
        let enotdir = std::io::Error::from_raw_os_error(libc::ENOTDIR);
        assert_eq!(spawn_message("git", &enotdir), "spawn ENOTDIR");
        for errno in [
            libc::EACCES,
            libc::EAGAIN,
            libc::EMFILE,
            libc::ENFILE,
            libc::ENOENT,
        ] {
            let e = std::io::Error::from_raw_os_error(errno);
            assert!(
                spawn_message("git", &e).starts_with("spawn git E"),
                "{errno}"
            );
        }
        assert_eq!(spawn_message("git", &std::io::Error::other("boom")), "boom");
        let e = run(
            "/nonexistent-claudius-git",
            &[],
            None,
            None,
            Duration::from_secs(5),
            MAX_BUFFER,
        )
        .await
        .unwrap_err();
        assert_eq!(e, "spawn /nonexistent-claudius-git ENOENT");
        let e = git(&["diff", "--", "a\0"], Path::new("/"), GitOpts::default())
            .await
            .unwrap_err();
        assert_eq!(
            e,
            ExecError::Thrown(
                "The argument 'args[2]' must be a string without null bytes. Received 'a\\x00'"
                    .into()
            )
        );
    }

    #[cfg(unix)]
    #[tokio::test]
    async fn exec_file_probe_rules() {
        // Exit 0 within the buffer only.
        let ok = run_sh("printf x", 5_000, 1).await;
        assert!(!ok.overflow && ok.exit == Exit::Code(0));
        let over = run_sh("printf xy", 5_000, 1).await;
        assert!(over.overflow);
        assert!(is_git_installed().await);
        let dir = tempfile::tempdir().unwrap();
        // `execFileP`'s 1 MiB default buffer, and exit 0 only (`config
        // --get` of a missing key exits 1).
        let cfg = dir.path().join("big.cfg");
        let mib = 1024 * 1024;
        std::fs::write(
            &cfg,
            format!(
                "[a]\n\tb = {}\n\tc = {}\n",
                "x".repeat(mib),
                "y".repeat(mib - 1)
            ),
        )
        .unwrap();
        let cfg = cfg.display().to_string();
        let get = |key: &'static str| {
            let cfg = cfg.clone();
            async move { exec_file_ok(&["config", "--file", &cfg, "--get", key], None, 5_000).await }
        };
        assert_eq!(get("a.b").await, None);
        assert_eq!(get("a.c").await.map(|s| s.len()), Some(mib));
        assert_eq!(get("a.zz").await, None);
        assert_eq!(get_repo_root(&dir.path().display().to_string()).await, None);
        assert_eq!(get_repo_root("/nonexistent-claudius-d06").await, None);
    }
}
