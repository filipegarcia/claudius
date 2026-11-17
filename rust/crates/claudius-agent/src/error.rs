use thiserror::Error;

#[derive(Debug, Error)]
pub enum AgentError {
    #[error("{0}")]
    InvalidOptions(String),

    /// The launch failed. `message` is the SDK's wording for it (see
    /// [`crate::binary::launch_error_message`]); `path` is what was
    /// launched (the binary, or a JS entry's interpreter).
    #[error("{message}")]
    Spawn {
        message: String,
        path: String,
        #[source]
        source: std::io::Error,
    },

    /// No `claude` binary was found (the SDK's default lookup failed).
    /// `platform` and `arch` use Node's names.
    #[error(
        "Native CLI binary for {platform}-{arch} not found. Reinstall @anthropic-ai/claude-agent-sdk without --omit=optional, or set options.pathToClaudeCodeExecutable."
    )]
    BinaryNotFound { platform: String, arch: String },

    #[error("Claude Code process exited with code {code}{stderr}")]
    ProcessExited { code: i32, stderr: String },

    /// Only for signals Node can name: for any other, Node reports exit
    /// code 0 and the SDK no error at all.
    #[error(
        "Claude Code process terminated by signal {}{stderr}",
        signal_name(*signal).unwrap_or("unknown")
    )]
    ProcessKilled { signal: i32, stderr: String },

    /// The CLI exited with an error after a `result` reported one: the
    /// SDK's reader swaps the exit error for the result's text.
    #[error("Claude Code returned an error result: {0}")]
    ErrorResult(String),

    /// The CLI answered a control request with `subtype: "error"`.
    #[error("{0}")]
    ControlError(String),

    /// The host aborted (`close()`): writes from then on, and every request
    /// still waiting, `initialize` included (the SDK's `vZ()`; its cleanup
    /// rejects the waiters with the abort's cause, which is this). The
    /// stream ends with it too.
    #[error("Operation aborted")]
    Aborted,

    /// The end of an aborted query's stream when its CLI was still running
    /// at the close timer's SIGTERM, 2 s after the abort: the SDK forwards
    /// the abort to the spawn's `signal`, Node emits `error`, and the reader
    /// stops at once with `Py()`, without waiting for the exit.
    #[error("Claude Code process aborted by user")]
    AbortedByUser,

    /// A write after the CLI exited (or a write to its stdin failed) but
    /// before the reader ended: the transport is no longer `ready`. Prompts
    /// get it after the reader ended too.
    #[error("ProcessTransport is not ready for writing")]
    Closed,

    /// The SDK's reader threw a JS `TypeError` (V8's message), e.g. walking
    /// a malformed `pending_permission_requests` list on the `initialize`
    /// reply. The stream ends with it and every waiting request fails.
    #[error("{0}")]
    TypeError(String),

    /// A control request made once the reader ended (`cleanupPerformed`), or
    /// still waiting when the CLI went away cleanly (`ww()`).
    #[error("Query closed before response received")]
    QueryClosed,

    #[error(transparent)]
    Io(#[from] std::io::Error),

    #[error(transparent)]
    Json(#[from] serde_json::Error),
}

impl AgentError {
    /// The same error again, for each waiter the cleanup fails with its
    /// cause (`io::Error` isn't `Clone`; a copy keeps the message).
    pub(crate) fn duplicate(&self) -> AgentError {
        match self {
            Self::ProcessExited { code, stderr } => Self::ProcessExited {
                code: *code,
                stderr: stderr.clone(),
            },
            Self::ProcessKilled { signal, stderr } => Self::ProcessKilled {
                signal: *signal,
                stderr: stderr.clone(),
            },
            Self::ErrorResult(text) => Self::ErrorResult(text.clone()),
            Self::TypeError(message) => Self::TypeError(message.clone()),
            Self::Aborted => Self::Aborted,
            Self::AbortedByUser => Self::AbortedByUser,
            Self::Closed => Self::Closed,
            Self::QueryClosed => Self::QueryClosed,
            Self::Io(e) => Self::Io(std::io::Error::new(e.kind(), e.to_string())),
            e => Self::ControlError(e.to_string()),
        }
    }

    /// `. stderr: <tail>`, or nothing for an empty (already formatted) tail.
    pub(crate) fn stderr_suffix(tail: &str) -> String {
        if tail.is_empty() {
            String::new()
        } else {
            format!(". stderr: {tail}")
        }
    }
}

/// Node's `signo_string`: the name a child's `signalCode` gets. Signals Node
/// has no name for (`SIGEMT` on macOS, real-time signals on Linux) are
/// `None`.
#[cfg(unix)]
pub fn signal_name(signo: i32) -> Option<&'static str> {
    use libc::*;
    Some(match signo {
        SIGHUP => "SIGHUP",
        SIGINT => "SIGINT",
        SIGQUIT => "SIGQUIT",
        SIGILL => "SIGILL",
        SIGTRAP => "SIGTRAP",
        SIGABRT => "SIGABRT",
        SIGBUS => "SIGBUS",
        SIGFPE => "SIGFPE",
        SIGKILL => "SIGKILL",
        SIGUSR1 => "SIGUSR1",
        SIGSEGV => "SIGSEGV",
        SIGUSR2 => "SIGUSR2",
        SIGPIPE => "SIGPIPE",
        SIGALRM => "SIGALRM",
        SIGTERM => "SIGTERM",
        SIGCHLD => "SIGCHLD",
        #[cfg(any(target_os = "linux", target_os = "android"))]
        SIGSTKFLT => "SIGSTKFLT",
        SIGCONT => "SIGCONT",
        SIGSTOP => "SIGSTOP",
        SIGTSTP => "SIGTSTP",
        SIGTTIN => "SIGTTIN",
        SIGTTOU => "SIGTTOU",
        SIGURG => "SIGURG",
        SIGXCPU => "SIGXCPU",
        SIGXFSZ => "SIGXFSZ",
        SIGVTALRM => "SIGVTALRM",
        SIGPROF => "SIGPROF",
        SIGWINCH => "SIGWINCH",
        SIGIO => "SIGIO",
        #[cfg(any(target_os = "linux", target_os = "android"))]
        SIGPWR => "SIGPWR",
        #[cfg(any(
            target_os = "macos",
            target_os = "ios",
            target_os = "freebsd",
            target_os = "netbsd",
            target_os = "openbsd",
            target_os = "dragonfly"
        ))]
        SIGINFO => "SIGINFO",
        SIGSYS => "SIGSYS",
        _ => return None,
    })
}

/// Without Unix signals there's nothing to name.
#[cfg(not(unix))]
pub fn signal_name(_signo: i32) -> Option<&'static str> {
    None
}
