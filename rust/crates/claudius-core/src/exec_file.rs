//! `promisify(execFile)` (`execFileP`): a program run to its `close` on
//! [`crate::git`]'s `execFile` model (the inherited env, a stdin pipe open
//! until it exits, lossy UTF-8, `maxBuffer` per stream, the timeout's
//! SIGTERM), settled the way Node's callback settles it (D23):
//!
//! * exit 0 within the buffers resolves `{stdout, stderr}`. So does a child
//!   that exits 0 after the timeout's kill (it ignored SIGTERM, or it had
//!   exited and a grandchild held a pipe), with what was read before it;
//! * past `maxBuffer` it rejects with `<stream> maxBuffer length exceeded`
//!   (`ERR_CHILD_PROCESS_STDIO_MAXBUFFER`) whatever the exit. That stream
//!   keeps `maxBuffer - <bytes before it>` UTF-16 units of the chunk that
//!   crossed: Node spends a byte budget in string units
//!   (`StringPrototypeSlice`), so a multi-byte chunk keeps more bytes;
//! * any other exit rejects with `Command failed: <file> <args joined by
//!   spaces>\n<stderr>`, `code` the exit code, or `null` after a signal;
//! * a spawn error rejects with Node's message (`spawn docker ENOENT`;
//!   `spawn ENOEXEC` for the errnos `spawn()` throws itself) and errno name,
//!   and no output. (Those throws escape `execFileP` synchronously, without
//!   `stdout` / `stderr`; inside a `try` that reads the same.)

use std::path::Path;
use std::time::Duration;

use crate::git::{self, Exit};

/// `execFile`'s default `maxBuffer`.
pub const DEFAULT_MAX_BUFFER: usize = 1024 * 1024;

/// `execFile`'s options that shape the run.
#[derive(Clone, Copy, Debug)]
pub struct ExecFileOptions<'a> {
    /// `cwd`; `None` (or empty) is the server's.
    pub cwd: Option<&'a Path>,
    /// `timeout` in ms; 0 is none.
    pub timeout_ms: u64,
    /// `maxBuffer`, per stream, in decoded UTF-8 bytes.
    pub max_buffer: usize,
}

impl Default for ExecFileOptions<'_> {
    fn default() -> Self {
        ExecFileOptions {
            cwd: None,
            timeout_ms: 0,
            max_buffer: DEFAULT_MAX_BUFFER,
        }
    }
}

/// What `execFileP` resolves.
#[derive(Clone, Debug, Default, PartialEq, Eq)]
pub struct ExecFileOutput {
    pub stdout: String,
    pub stderr: String,
}

/// The rejection's `code`.
#[derive(Clone, Debug, PartialEq, Eq)]
pub enum ErrorCode {
    /// An errno name (`ENOENT`) or Node's own (`ERR_CHILD_PROCESS_STDIO_MAXBUFFER`).
    Name(String),
    /// The exit code of a run that failed.
    Exit(i32),
    /// `null`: a signal ended the run.
    Null,
    /// No code (a spawn error without an OS errno).
    Undefined,
}

/// The error `execFileP` rejects with (`message`, `code`, and the
/// `stdout` / `stderr` it attaches).
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct ExecFileError {
    pub message: String,
    pub code: ErrorCode,
    pub stdout: String,
    pub stderr: String,
}

/// `await execFileP(program, args, opts)`.
pub async fn exec_file(
    program: &str,
    args: &[&str],
    opts: ExecFileOptions<'_>,
) -> Result<ExecFileOutput, ExecFileError> {
    let timeout = match opts.timeout_ms {
        0 => Duration::MAX,
        ms => Duration::from_millis(ms),
    };
    let run = git::spawn_run(program, args, opts.cwd, None, timeout, opts.max_buffer)
        .await
        .map_err(|e| ExecFileError {
            message: e.message,
            code: e.code.map_or(ErrorCode::Undefined, ErrorCode::Name),
            stdout: String::new(),
            stderr: String::new(),
        })?;
    let overflowed = match (run.stdout_crossed_at, run.stderr_crossed_at) {
        (Some(_), _) => Some("stdout"),
        (None, Some(_)) => Some("stderr"),
        (None, None) => None,
    };
    let stdout = kept(run.stdout, run.stdout_crossed_at, opts.max_buffer);
    let stderr = kept(run.stderr, run.stderr_crossed_at, opts.max_buffer);
    if let Some(stream) = overflowed {
        return Err(ExecFileError {
            message: format!("{stream} maxBuffer length exceeded"),
            code: ErrorCode::Name("ERR_CHILD_PROCESS_STDIO_MAXBUFFER".into()),
            stdout,
            stderr,
        });
    }
    let code = match run.exit {
        Exit::Code(0) => return Ok(ExecFileOutput { stdout, stderr }),
        Exit::Code(c) => ErrorCode::Exit(c),
        Exit::Signal(_) => ErrorCode::Null,
    };
    let mut cmd = program.to_owned();
    if !args.is_empty() {
        cmd.push(' ');
        cmd.push_str(&args.join(" "));
    }
    Err(ExecFileError {
        message: format!("Command failed: {cmd}\n{stderr}"),
        code,
        stdout,
        stderr,
    })
}

/// What `execFile`'s buffer holds of a stream: all of it, or, once it went
/// past `max`, the text before the crossing chunk plus `max - <bytes
/// before>` UTF-16 units of that chunk (the last one read).
fn kept(mut text: String, crossed_at: Option<usize>, max: usize) -> String {
    if let Some(at) = crossed_at {
        let cut = at + utf16_prefix_len(&text[at..], max.saturating_sub(at));
        text.truncate(cut);
    }
    text
}

/// The byte length of the first `units` UTF-16 units of `s`. A cut through a
/// surrogate pair keeps neither half, where JS keeps the high one.
fn utf16_prefix_len(s: &str, units: usize) -> usize {
    let mut n = 0;
    for (i, c) in s.char_indices() {
        n += c.len_utf16();
        if n > units {
            return i;
        }
    }
    s.len()
}

#[cfg(test)]
mod tests {
    use super::*;

    fn opts(timeout_ms: u64, max_buffer: usize) -> ExecFileOptions<'static> {
        ExecFileOptions {
            cwd: None,
            timeout_ms,
            max_buffer,
        }
    }

    async fn sh(
        script: &str,
        timeout_ms: u64,
        max: usize,
    ) -> Result<ExecFileOutput, ExecFileError> {
        exec_file("/bin/sh", &["-c", script], opts(timeout_ms, max)).await
    }

    fn failed(message: &str, code: ErrorCode, stdout: &str, stderr: &str) -> ExecFileError {
        ExecFileError {
            message: message.into(),
            code,
            stdout: stdout.into(),
            stderr: stderr.into(),
        }
    }

    #[test]
    fn prefixes_count_utf16_units() {
        assert_eq!(utf16_prefix_len("abc", 0), 0);
        assert_eq!(utf16_prefix_len("abc", 2), 2);
        assert_eq!(utf16_prefix_len("abc", 9), 3);
        // é is 2 bytes and 1 unit; 😀 is 4 bytes and 2 units.
        assert_eq!(utf16_prefix_len("éé", 1), 2);
        assert_eq!(utf16_prefix_len("a😀b", 3), 5);
        assert_eq!(utf16_prefix_len("a😀b", 2), 1);
        assert_eq!(kept("abcdef".into(), None, 2), "abcdef");
        assert_eq!(kept("abcdef".into(), Some(4), 5), "abcde");
        assert_eq!(kept("abééé".into(), Some(2), 4), "abéé");
        assert_eq!(kept("abc".into(), Some(3), 2), "abc");
    }

    #[cfg(unix)]
    #[tokio::test]
    async fn settles_like_exec_file_p() {
        assert_eq!(
            sh("printf out; printf err >&2", 5_000, DEFAULT_MAX_BUFFER).await,
            Ok(ExecFileOutput {
                stdout: "out".into(),
                stderr: "err".into()
            })
        );
        assert_eq!(
            sh(
                "printf o; printf 'bad\\n' >&2; exit 3",
                5_000,
                DEFAULT_MAX_BUFFER
            )
            .await,
            Err(failed(
                "Command failed: /bin/sh -c printf o; printf 'bad\\n' >&2; exit 3\nbad\n",
                ErrorCode::Exit(3),
                "o",
                "bad\n"
            ))
        );
        // No args: no space after the file.
        assert_eq!(
            exec_file("/usr/bin/false", &[], opts(5_000, 10)).await,
            Err(failed(
                "Command failed: /usr/bin/false\n",
                ErrorCode::Exit(1),
                "",
                ""
            ))
        );
        // A signal: code null.
        assert_eq!(
            sh("printf x >&2; kill -KILL $$", 5_000, 10).await,
            Err(failed(
                "Command failed: /bin/sh -c printf x >&2; kill -KILL $$\nx",
                ErrorCode::Null,
                "",
                "x"
            ))
        );
        // Spawn errors carry the errno name and no output.
        assert_eq!(
            exec_file("/nonexistent-claudius-d23", &["ps"], opts(5_000, 10)).await,
            Err(failed(
                "spawn /nonexistent-claudius-d23 ENOENT",
                ErrorCode::Name("ENOENT".into()),
                "",
                ""
            ))
        );
        // Node's own argument checks throw before anything runs.
        assert_eq!(
            exec_file("/bin/sh", &["-c", "a\0"], opts(5_000, 10)).await,
            Err(failed(
                "The argument 'args[1]' must be a string without null bytes. Received 'a\\x00'",
                ErrorCode::Name("ERR_INVALID_ARG_VALUE".into()),
                "",
                ""
            ))
        );
        // Timeout 0 is none.
        assert_eq!(
            sh("sleep 0.2; printf late", 0, 10).await.map(|o| o.stdout),
            Ok("late".into())
        );
    }

    #[cfg(unix)]
    #[tokio::test]
    async fn timeouts_kill_and_late_success_resolves() {
        let t0 = std::time::Instant::now();
        let e = sh("printf so; printf se >&2; exec sleep 30", 500, 100)
            .await
            .unwrap_err();
        assert!(t0.elapsed() >= Duration::from_millis(500));
        assert_eq!(
            e,
            failed(
                "Command failed: /bin/sh -c printf so; printf se >&2; exec sleep 30\nse",
                ErrorCode::Null,
                "so",
                "se"
            )
        );
        // SIGTERM ignored, then exit 0: a success with what came before the
        // kill (a write after it would die of SIGPIPE, the pipes are closed).
        let out = sh("trap '' TERM; printf before; sleep 1.5; exit 0", 500, 100).await;
        assert_eq!(
            out,
            Ok(ExecFileOutput {
                stdout: "before".into(),
                stderr: String::new()
            })
        );
        // The same exiting 4 fails with that code.
        let e = sh("trap '' TERM; printf e >&2; sleep 1.5; exit 4", 500, 100)
            .await
            .unwrap_err();
        assert_eq!(e.code, ErrorCode::Exit(4));
    }

    #[cfg(unix)]
    #[tokio::test]
    async fn max_buffer_names_the_stream_and_cuts_by_units() {
        let e = sh("printf '%020d' 0; exit 0", 5_000, 8).await.unwrap_err();
        assert_eq!(
            e,
            failed(
                "stdout maxBuffer length exceeded",
                ErrorCode::Name("ERR_CHILD_PROCESS_STDIO_MAXBUFFER".into()),
                "00000000",
                ""
            )
        );
        // Four é (8 bytes, 4 units) in one write, 2 bytes allowed: 2 units
        // (4 bytes) are kept.
        let e = sh(
            "printf '\\303\\251\\303\\251\\303\\251\\303\\251' >&2; exec sleep 30",
            5_000,
            2,
        )
        .await
        .unwrap_err();
        assert_eq!(
            (e.message.as_str(), e.stderr.as_str()),
            ("stderr maxBuffer length exceeded", "éé")
        );
        // Exactly at the limit is fine.
        assert_eq!(
            sh("printf '%08d' 0", 5_000, 8).await.map(|o| o.stdout),
            Ok("00000000".into())
        );
    }
}
