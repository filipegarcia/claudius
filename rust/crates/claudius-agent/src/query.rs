//! The live connection to one `claude` process — the Rust counterpart of the
//! TS SDK's `Query` + `ProcessTransport`.
//!
//! Wire protocol (newline-delimited JSON on stdin/stdout):
//!
//! * host → CLI: `{type:"user", message, parent_tool_use_id, session_id, uuid}`
//!   prompts, and `{type:"control_request", request_id, request:{subtype,..}}`.
//! * CLI → host: SDK messages (`system`/`assistant`/`user`/`result`/
//!   `stream_event`/...), `control_response` answers to our requests,
//!   `control_request`s of its own (`can_use_tool`, `hook_callback`,
//!   `mcp_message`, `elicitation`, ...), `control_cancel_request`, and
//!   `keep_alive`.
//!
//! The `initialize` control request is written before `spawn` returns, so
//! every later write (including the first prompt) is ordered after it — the
//! same guarantee `streamInput` gets by awaiting `initializeWritten`.

use std::collections::HashMap;
use std::process::Stdio;
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::{Arc, Mutex};
use std::time::Duration;

use indexmap::IndexMap;
use serde_json::{Map, Value, json};
use tokio::io::{AsyncReadExt, AsyncWriteExt};
use tokio::process::{Child, ChildStdin, Command};
use tokio::sync::{mpsc, oneshot, watch};
use tokio_util::sync::CancellationToken;

use crate::binary;
use crate::error::AgentError;
use crate::hooks::HookCallback;
use crate::js;
use crate::mcp::SdkMcpServer;
use crate::options::{McpServerConfig, Options};
use crate::permission::{CanUseTool, ElicitationRequest, OnElicitation, ToolPermissionContext};
use crate::stream::{self, LineSplitter, Utf8Decoder};

/// SIGTERM → SIGKILL grace on close.
const KILL_GRACE: Duration = Duration::from_secs(2);
/// How long after the exit the SDK waits for stderr to close before it
/// reports the exit (`vVe`). Stderr arriving later is ignored.
const STDERR_DRAIN_GRACE: Duration = Duration::from_millis(200);
/// The run-end ceiling when `CLAUDE_CODE_PRINT_BG_WAIT_CEILING_MS` doesn't
/// parse to a non-negative number (`O_`).
const RUN_END_CEILING_DEFAULT_MS: f64 = 600_000.0;
/// `setTimeout`'s maximum delay (`Yh`), which the ceiling is clamped to.
const TIMEOUT_MAX_MS: f64 = 2_147_483_647.0;

/// The run-end ceiling the SDK derives from the CLI env's
/// `CLAUDE_CODE_PRINT_BG_WAIT_CEILING_MS` (`V4`): the parsed value when it's
/// finite and non-negative, else 600000. `0` disables the ceiling.
pub fn run_end_ceiling_ms(raw: Option<&str>) -> f64 {
    let x = js::env_int(raw);
    if x.is_finite() && x >= 0.0 {
        x
    } else {
        RUN_END_CEILING_DEFAULT_MS
    }
}

type ControlReply = Result<Value, AgentError>;

/// Options of [`QueryHandle::submit_feedback`] (the TS `submitFeedback`
/// second argument). `None` fields are left out of the request.
#[derive(Clone, Debug, Default)]
pub struct FeedbackOptions {
    pub surface: Option<String>,
    pub draft_id: Option<String>,
    /// `type` on the wire.
    pub kind: Option<String>,
    pub title: Option<String>,
    pub area: Option<String>,
    pub attach_transcript: Option<bool>,
    pub save_locally: Option<bool>,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum ExitInfo {
    Code(i32),
    Signal(i32),
    Unknown,
}

struct Callbacks {
    can_use_tool: Option<Arc<dyn CanUseTool>>,
    on_elicitation: Option<Arc<dyn OnElicitation>>,
    hooks: HashMap<String, Arc<dyn HookCallback>>,
    /// In-process MCP servers, by name. Mutable: `set_mcp_servers` connects
    /// and disconnects them like the TS `Query.sdkMcpServers` map. Never
    /// held across an `.await`.
    sdk_mcp: Mutex<IndexMap<String, Arc<dyn SdkMcpServer>>>,
}

/// The SDK's `readMessages` bookkeeping. First the run-end tracking
/// (`runEnded`, `resultReceived`, `sessionState` and the ceiling timer): for
/// a single-turn query, ending the run closes stdin, which is how a
/// string-prompt `query()` finishes. Then what an exit error is replaced
/// with, and the latest command list.
#[derive(Default)]
struct RunState {
    single_user_turn: bool,
    run_ended: bool,
    result_received: bool,
    /// The last `session_state_changed` state; `None` until one arrives (or
    /// when it had no `state`), the SDK's `undefined`.
    session_state: Option<Value>,
    /// Bumped by every arm / clear, so a timer armed earlier is stale.
    ceiling_gen: u64,
    /// `lastErrorResultText`: the last `result`'s error text when it was
    /// JS-truthy. Most later messages clear it.
    last_error_result_text: Option<Value>,
    /// `modelLessTurnEnded`: the last `result` was a turn that never reached
    /// the model (`success`, `num_turns: 0`, empty `result`), e.g. a local
    /// slash command after a failed turn.
    model_less_turn_ended: bool,
    /// `errorTextBeforeModelLessTurns`: the error text from before a run of
    /// model-less turns, which still explains a later exit.
    error_text_before_model_less_turns: Option<Value>,
    /// `latestCommands`: the last `system/commands_changed` list, which
    /// `supportedCommands()` prefers over the `initialize` one.
    latest_commands: Option<Value>,
}

/// Why `initialize` has no response.
#[derive(Clone, Debug)]
enum InitFailure {
    /// The host closed the query first.
    Aborted,
    Failed(String),
}

struct Shared {
    stdin: tokio::sync::Mutex<Option<ChildStdin>>,
    pending: Mutex<HashMap<String, oneshot::Sender<ControlReply>>>,
    inflight: Mutex<HashMap<String, CancellationToken>>,
    callbacks: Callbacks,
    /// The `initialize` outcome, once the init task has it. It always gets
    /// one: the reply, a waiter failed when stdout closed, or the close.
    init: watch::Sender<Option<Result<Value, InitFailure>>>,
    exit: watch::Receiver<Option<ExitInfo>>,
    /// Cancelled once the host aborts (`close()`) or the reader ends.
    /// In-flight CLI→host callbacks are its children.
    closed: CancellationToken,
    /// Cancelled once the host aborts: the SDK's `abortController`.
    aborted: CancellationToken,
    /// `cleanupPerformed`: the reader ended and failed every waiter. Set
    /// under the `pending` lock, so a request either fails up front or is
    /// among the waiters the cleanup fails.
    cleaned_up: std::sync::atomic::AtomicBool,
    /// A write to stdin failed: like Node's stdin `error` event, it marks
    /// the transport not `ready`.
    write_failed: std::sync::atomic::AtomicBool,
    /// Tells the waiter task to terminate the child.
    kill: CancellationToken,
    stderr_tail: Mutex<String>,
    /// Cancelled once the stderr reader hits EOF.
    stderr_done: CancellationToken,
    /// Set once the exit is reported. Later stderr is ignored.
    stderr_cutoff: std::sync::atomic::AtomicBool,
    next_id: AtomicU64,
    pid: Option<u32>,
    run: Mutex<RunState>,
    /// `runEndCeilingMs`.
    run_end_ceiling_ms: f64,
    /// `options.hooks` had any event key (even with no matchers): one of the
    /// SDK's bidirectional needs.
    hooks_configured: bool,
    verbatim_prompts: bool,
}

/// Cloneable handle for writing prompts / control requests while another
/// task drains the message stream.
#[derive(Clone)]
pub struct QueryHandle {
    shared: Arc<Shared>,
}

/// Which query a handle drives, for identity checks (`===` on a TS
/// `Query`): equal for handles of one query, distinct across queries. It
/// doesn't own the query, so holding one never keeps the CLI's stdin open.
#[derive(Clone)]
pub struct QueryId(std::sync::Weak<Shared>);

impl PartialEq for QueryId {
    fn eq(&self, other: &Self) -> bool {
        std::sync::Weak::ptr_eq(&self.0, &other.0)
    }
}

impl Eq for QueryId {}

impl std::fmt::Debug for QueryId {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        write!(f, "QueryId({:p})", self.0.as_ptr())
    }
}

/// A running query: a [`QueryHandle`] plus the stream of non-control
/// messages the CLI emits.
pub struct Query {
    handle: QueryHandle,
    messages: mpsc::UnboundedReceiver<Result<Value, AgentError>>,
}

impl Query {
    /// Spawn the CLI and send `initialize`; prompts are streamed with
    /// [`QueryHandle::send_user_message`] (the SDK's `AsyncIterable` prompt).
    pub async fn spawn(options: Options) -> Result<Query, AgentError> {
        Self::spawn_inner(options, false).await
    }

    /// The SDK's single-turn mode, `query({prompt: "<string>"})`: spawn,
    /// write `prompt` as the one user message, and close stdin once the run
    /// ends, so the CLI exits and the stream ends on its own. The run ends
    /// at a `result` when the session state is unknown or `idle`, or nothing
    /// needs the control channel (no `can_use_tool`, `on_elicitation`, hooks
    /// or SDK MCP servers); otherwise at `session_state_changed: idle`, or
    /// [`run_end_ceiling_ms`] after the result with no idle.
    pub async fn spawn_prompt(prompt: &str, options: Options) -> Result<Query, AgentError> {
        let q = Self::spawn_inner(options, true).await?;
        let mut msg = json!({
            "type": "user",
            "session_id": "",
            "message": {"role": "user", "content": [{"type": "text", "text": prompt}]},
            "parent_tool_use_id": null,
        });
        if q.handle.shared.verbatim_prompts {
            msg["client_composed"] = json!(true);
        }
        if let Err(e) = q.handle.write_json(&msg).await {
            // The SDK aborts the query when this write fails.
            q.handle.close().await;
            return Err(e);
        }
        Ok(q)
    }

    async fn spawn_inner(options: Options, single_user_turn: bool) -> Result<Query, AgentError> {
        let args = options.to_args()?;
        let env = options.to_env();
        let run_end_ceiling_ms = run_end_ceiling_ms(
            env.get("CLAUDE_CODE_PRINT_BG_WAIT_CEILING_MS")
                .map(String::as_str),
        );
        let exe = match &options.path_to_claude_code_executable {
            Some(p) => p.clone(),
            None => binary::locate(options.cwd.as_deref()).ok_or_else(|| {
                AgentError::BinaryNotFound {
                    platform: binary::node_platform(std::env::consts::OS).to_owned(),
                    arch: binary::node_arch(std::env::consts::ARCH).to_owned(),
                }
            })?,
        };
        // `wVe`: a JS entry runs through its interpreter. `executableArgs`
        // come first either way.
        let native = binary::is_native(&exe);
        let program: std::ffi::OsString = if native {
            exe.clone().into()
        } else {
            options.executable.as_deref().unwrap_or("node").into()
        };

        let mut cmd = Command::new(&program);
        cmd.args(&options.executable_args);
        if !native {
            cmd.arg(&exe);
        }
        cmd.args(&args)
            .env_clear()
            .envs(&env)
            .stdin(Stdio::piped())
            .stdout(Stdio::piped())
            .stderr(Stdio::piped())
            .kill_on_drop(true);
        if let Some(cwd) = &options.cwd {
            cmd.current_dir(cwd);
        }
        #[cfg(unix)]
        // SAFETY: the closure only calls the async-signal-safe `getrlimit`,
        // `fcntl` and `close`.
        unsafe {
            cmd.pre_exec(close_leaked_fds);
        }
        // Node's `windowsHide`: no console window for the CLI.
        #[cfg(windows)]
        cmd.creation_flags(0x0800_0000); // CREATE_NO_WINDOW
        tracing::debug!(exe = %exe.display(), args = ?args, "Spawning Claude Code");
        let mut child: Child = cmd.spawn().map_err(|source| AgentError::Spawn {
            message: binary::launch_error_message(&source, &exe, &program, native),
            path: program.to_string_lossy().into_owned(),
            source,
        })?;
        let pid = child.id();
        let stdin = child.stdin.take();
        let stdout = child.stdout.take().expect("piped stdout");
        let stderr = child.stderr.take().expect("piped stderr");

        // Assign hook callback ids the way buildInitializeRequest does:
        // `hook_<n>` counting across every matcher of every event.
        let mut hooks = HashMap::new();
        let mut hooks_payload = Map::new();
        let mut n = 0u64;
        for (event, matchers) in &options.hooks {
            if matchers.is_empty() {
                continue;
            }
            let mut entries = Vec::new();
            for m in matchers {
                let mut ids = Vec::new();
                for h in &m.hooks {
                    let id = format!("hook_{n}");
                    n += 1;
                    hooks.insert(id.clone(), h.clone());
                    ids.push(Value::String(id));
                }
                let mut e = Map::new();
                if let Some(matcher) = &m.matcher {
                    e.insert("matcher".into(), json!(matcher));
                }
                e.insert("hookCallbackIds".into(), Value::Array(ids));
                if let Some(t) = m.timeout {
                    e.insert("timeout".into(), json!(t));
                }
                entries.push(Value::Object(e));
            }
            hooks_payload.insert(event.clone(), Value::Array(entries));
        }
        // In-process servers are handshaken before `initialize` so the CLI
        // can skip its own round trips. Gated on the PARENT's env, like the
        // SDK (`process.env`, not `options.env`).
        let manifests = if crate::mcp::env_flag_truthy(
            std::env::var("CLAUDE_AGENT_SDK_DISABLE_MCP_MANIFESTS")
                .ok()
                .as_deref(),
        ) {
            None
        } else {
            crate::mcp::capture_manifests(&options.sdk_mcp_servers()).await
        };
        let init_request = options.initialize_request(
            (!hooks_payload.is_empty()).then(|| Value::Object(hooks_payload)),
            manifests,
        );

        let (exit_tx, exit_rx) = watch::channel(None);
        let (init_tx, _) = watch::channel(None);
        let kill = CancellationToken::new();
        let shared = Arc::new(Shared {
            stdin: tokio::sync::Mutex::new(stdin),
            pending: Mutex::new(HashMap::new()),
            inflight: Mutex::new(HashMap::new()),
            callbacks: Callbacks {
                can_use_tool: options.can_use_tool.clone(),
                on_elicitation: options.on_elicitation.clone(),
                hooks,
                sdk_mcp: Mutex::new(options.sdk_mcp_servers()),
            },
            init: init_tx,
            exit: exit_rx,
            closed: CancellationToken::new(),
            aborted: CancellationToken::new(),
            cleaned_up: std::sync::atomic::AtomicBool::new(false),
            write_failed: std::sync::atomic::AtomicBool::new(false),
            kill: kill.clone(),
            stderr_tail: Mutex::new(String::new()),
            stderr_done: CancellationToken::new(),
            stderr_cutoff: std::sync::atomic::AtomicBool::new(false),
            next_id: AtomicU64::new(0),
            pid,
            run: Mutex::new(RunState {
                single_user_turn,
                ..RunState::default()
            }),
            run_end_ceiling_ms,
            hooks_configured: !options.hooks.is_empty(),
            verbatim_prompts: options.verbatim_prompts,
        });

        // Waiter: owns the Child; terminates it on `kill`.
        tokio::spawn(async move {
            let status = tokio::select! {
                s = child.wait() => s,
                _ = kill.cancelled() => {
                    terminate(&mut child);
                    match tokio::time::timeout(KILL_GRACE, child.wait()).await {
                        Ok(s) => s,
                        Err(_) => {
                            let _ = child.start_kill();
                            child.wait().await
                        }
                    }
                }
            };
            let info = match status {
                Ok(s) => exit_info(&s),
                Err(_) => ExitInfo::Unknown,
            };
            let _ = exit_tx.send(Some(info));
        });

        // stderr: decode like Node, keep a bounded tail, and hand each
        // decoded chunk to the optional callback.
        {
            let shared = shared.clone();
            let cb = options.stderr.clone();
            tokio::spawn(async move {
                let _done = shared.stderr_done.clone().drop_guard();
                let mut stderr = stderr;
                let mut decoder = Utf8Decoder::default();
                let mut buf = vec![0u8; 8192];
                loop {
                    let n = match stderr.read(&mut buf).await {
                        Ok(0) | Err(_) => break,
                        Ok(n) => n,
                    };
                    if shared.stderr_cutoff.load(Ordering::Acquire) {
                        return;
                    }
                    let text = decoder.write(&buf[..n]);
                    if let Some(cb) = &cb {
                        cb(&text);
                    }
                    stream::push_stderr(&mut shared.stderr_tail.lock().unwrap(), &text);
                }
                stream::push_stderr(&mut shared.stderr_tail.lock().unwrap(), decoder.end());
            });
        }

        let (tx, rx) = mpsc::unbounded_channel();
        let handle = QueryHandle {
            shared: shared.clone(),
        };

        // stdout reader / demultiplexer.
        {
            let handle = handle.clone();
            tokio::spawn(async move {
                let mut stdout = stdout;
                let mut lines = LineSplitter::default();
                let mut buf = vec![0u8; 64 * 1024];
                let mut dispatch = |line: String| handle.dispatch_line(&line, &tx);
                let read_error = loop {
                    match stdout.read(&mut buf).await {
                        Ok(0) => {
                            lines.finish(&mut dispatch);
                            break None;
                        }
                        Ok(n) => lines.push(&buf[..n], &mut dispatch),
                        Err(e) => break Some(e),
                    }
                };
                handle.on_stdout_closed(&tx, read_error).await;
            });
        }

        // initialize — written now, answered asynchronously.
        let init_handle = handle.clone();
        let (id, reply) = handle.write_control_request(init_request).await?;
        tokio::spawn(async move {
            // Unanswered when stdout closed: `on_stdout_closed` fails the
            // waiter with the cleanup's cause, as for any request. (Deciding
            // there instead would race this task picking up a response that
            // did arrive.)
            let res = init_handle
                .await_reply(&id, reply)
                .await
                .map_err(|e| match e {
                    AgentError::Aborted => InitFailure::Aborted,
                    e => InitFailure::Failed(e.to_string()),
                });
            if let Err(e) = &res {
                tracing::warn!("initialize failed: {e:?}");
            }
            // send_replace: `send` drops the value when no receiver is subscribed yet.
            init_handle.shared.init.send_replace(Some(res));
        });

        Ok(Query {
            handle,
            messages: rx,
        })
    }

    pub fn handle(&self) -> QueryHandle {
        self.handle.clone()
    }

    /// Next SDK message. `None` once the process is gone and the stream is
    /// drained; a non-zero exit surfaces as a final `Err`.
    pub async fn next(&mut self) -> Option<Result<Value, AgentError>> {
        self.messages.recv().await
    }

    pub fn into_parts(
        self,
    ) -> (
        QueryHandle,
        mpsc::UnboundedReceiver<Result<Value, AgentError>>,
    ) {
        (self.handle, self.messages)
    }
}

/// The one-shot pattern of every `query({prompt: "<string>"})` caller in
/// `lib/server` (commit messages, customization descriptions, ...): run a
/// single-turn query ([`Query::spawn_prompt`]) and return its first `result`
/// message, then close the query, as returning out of the TS `for await`
/// does. `Ok(None)` when the stream ends without a result; the caller
/// decides what a non-`success` subtype means.
pub async fn oneshot(prompt: &str, options: Options) -> Result<Option<Value>, AgentError> {
    let mut q = Query::spawn_prompt(prompt, options).await?;
    let out = loop {
        match q.next().await {
            Some(Ok(msg)) if msg.get("type").is_some_and(|t| t == "result") => break Ok(Some(msg)),
            Some(Ok(_)) => {}
            Some(Err(e)) => break Err(e),
            None => break Ok(None),
        }
    };
    q.handle.close().await;
    out
}

/// In the child, before exec: close every inherited descriptor above stdio
/// that isn't close-on-exec. On macOS `std` creates pipes and sockets
/// without an atomic `O_CLOEXEC` (no `pipe2`), so a child forked by another
/// thread in that window inherits them. A CLI holding another CLI's stdin
/// keeps it from ever seeing EOF, so a single-turn query whose stdin was
/// closed never finishes. Node is immune (libuv's cloexec lock, and spawns
/// from one thread). Descriptors that are close-on-exec, such as `std`'s own
/// exec-error pipe, are left for exec to close. Use it (`pre_exec`) for
/// any other long-lived child the host spawns.
#[cfg(unix)]
pub fn close_leaked_fds() -> std::io::Result<()> {
    let mut lim = libc::rlimit {
        rlim_cur: 0,
        rlim_max: 0,
    };
    // SAFETY: `getrlimit` writes the struct we pass.
    let max = if unsafe { libc::getrlimit(libc::RLIMIT_NOFILE, &mut lim) } == 0 {
        lim.rlim_cur.min(65_536) as libc::c_int
    } else {
        4096
    };
    for fd in 3..max {
        // SAFETY: probing / closing a descriptor number; invalid ones fail
        // with EBADF.
        unsafe {
            let flags = libc::fcntl(fd, libc::F_GETFD);
            if flags >= 0 && flags & libc::FD_CLOEXEC == 0 {
                libc::close(fd);
            }
        }
    }
    Ok(())
}

#[cfg(unix)]
fn terminate(child: &mut Child) {
    if let Some(pid) = child.id() {
        // SAFETY: plain kill(2) on our own child's pid.
        unsafe {
            libc::kill(pid as libc::pid_t, libc::SIGTERM);
        }
    }
}

#[cfg(not(unix))]
fn terminate(child: &mut Child) {
    let _ = child.start_kill();
}

fn exit_info(s: &std::process::ExitStatus) -> ExitInfo {
    if let Some(c) = s.code() {
        return ExitInfo::Code(c);
    }
    #[cfg(unix)]
    {
        use std::os::unix::process::ExitStatusExt;
        if let Some(sig) = s.signal() {
            return ExitInfo::Signal(sig);
        }
    }
    ExitInfo::Unknown
}

impl QueryHandle {
    /// This handle's [`QueryId`].
    pub fn id(&self) -> QueryId {
        QueryId(Arc::downgrade(&self.shared))
    }

    pub fn pid(&self) -> Option<u32> {
        self.shared.pid
    }

    pub fn is_closed(&self) -> bool {
        self.shared.closed.is_cancelled() || self.shared.exit.borrow().is_some()
    }

    pub fn stderr_tail(&self) -> String {
        self.shared.stderr_tail.lock().unwrap().clone()
    }

    /// Write one JSON line to the CLI's stdin: `ProcessTransport.write`.
    /// Aborted → [`AgentError::Aborted`]; the CLI exited, a write failed or
    /// the reader ended → [`AgentError::Closed`]; stdin already ended (see
    /// [`end_input`](Self::end_input)) → dropped. A failed write isn't an
    /// error either (Node reports it as a later stdin `error` event): a
    /// request then waits for the cleanup to fail it with the exit's cause.
    pub async fn write_json(&self, v: &Value) -> Result<(), AgentError> {
        if self.shared.aborted.is_cancelled() {
            return Err(AgentError::Aborted);
        }
        if self.shared.cleaned_up.load(Ordering::Acquire)
            || self.shared.write_failed.load(Ordering::Acquire)
            || self.shared.exit.borrow().is_some()
        {
            return Err(AgentError::Closed);
        }
        // `ProcessTransport.write(JSON.stringify(message) + "\n")`: JS number
        // text (`0.000001`, not serde's `1e-6`) and integer-like keys first.
        let mut line = js::stringify(v);
        line.push('\n');
        let mut guard = self.shared.stdin.lock().await;
        let Some(stdin) = guard.as_mut() else {
            tracing::debug!("dropping write to ended stdin");
            return Ok(());
        };
        let written = match stdin.write_all(line.as_bytes()).await {
            Ok(()) => stdin.flush().await,
            Err(e) => Err(e),
        };
        if let Err(e) = written {
            tracing::debug!("stdin write failed (child likely exited): {e}");
            self.shared.write_failed.store(true, Ordering::Release);
        }
        Ok(())
    }

    /// Send a prompt (`SDKUserMessage`), e.g.
    /// `{type:"user", message:{role:"user", content}, parent_tool_use_id:null, session_id, uuid}`.
    /// Like each message of the SDK's `streamInput`, it starts a new run
    /// and, under `verbatim_prompts`, gets `client_composed: true`.
    pub async fn send_user_message(&self, msg: &Value) -> Result<(), AgentError> {
        {
            let mut run = self.shared.run.lock().unwrap();
            run.run_ended = false;
            run.result_received = false;
            run.ceiling_gen += 1;
        }
        if self.shared.verbatim_prompts
            && let Value::Object(m) = msg
        {
            let mut m = m.clone();
            m.insert("client_composed".into(), json!(true));
            return self.write_json(&Value::Object(m)).await;
        }
        self.write_json(msg).await
    }

    /// Close stdin (no more prompts). The CLI finishes the current turn and exits.
    pub async fn end_input(&self) {
        let mut guard = self.shared.stdin.lock().await;
        if let Some(mut s) = guard.take() {
            let _ = s.shutdown().await;
        }
    }

    /// Abort: cancel in-flight callbacks, close stdin, terminate the process.
    pub async fn close(&self) {
        self.shared.aborted.cancel();
        self.shared.closed.cancel();
        self.end_input().await;
        self.shared.kill.cancel();
    }

    /// Wait for the process to exit.
    pub async fn wait_exit(&self) -> ExitInfo {
        let mut rx = self.shared.exit.clone();
        loop {
            if let Some(info) = *rx.borrow() {
                return info;
            }
            if rx.changed().await.is_err() {
                return ExitInfo::Unknown;
            }
        }
    }

    /// The `initialize` response (`commands`, `models`, `agents`, `account`, ...).
    pub async fn initialization_result(&self) -> Result<Value, AgentError> {
        // No race with `closed` here: once the query is closed or its
        // stdout ends, the init task settles promptly, and a response that
        // did arrive must still win (the SDK's `initialization` stays
        // resolved after the stream ends).
        let mut rx = self.shared.init.subscribe();
        loop {
            match rx.borrow_and_update().clone() {
                Some(Ok(v)) => return Ok(v),
                Some(Err(InitFailure::Aborted)) => return Err(AgentError::Aborted),
                Some(Err(InitFailure::Failed(e))) => return Err(AgentError::ControlError(e)),
                None => {}
            }
            if rx.changed().await.is_err() {
                return Err(AgentError::QueryClosed);
            }
        }
    }

    /// Send a control request and await its `response` payload: the SDK's
    /// `Query.request`. Once the reader ended it fails up front
    /// ([`AgentError::QueryClosed`]); a request still waiting then gets the
    /// cleanup's cause (the exit's error), or `QueryClosed` without one.
    pub async fn request(&self, body: Value) -> Result<Value, AgentError> {
        let (id, rx) = self.write_control_request(body).await?;
        self.await_reply(&id, rx).await
    }

    async fn write_control_request(
        &self,
        body: Value,
    ) -> Result<(String, oneshot::Receiver<ControlReply>), AgentError> {
        let n = self.shared.next_id.fetch_add(1, Ordering::Relaxed);
        let id = format!(
            "req_{n}_{}",
            &uuid::Uuid::new_v4().simple().to_string()[..8]
        );
        let (tx, rx) = oneshot::channel();
        {
            let mut pending = self.shared.pending.lock().unwrap();
            if self.shared.cleaned_up.load(Ordering::Acquire) {
                return Err(AgentError::QueryClosed);
            }
            pending.insert(id.clone(), tx);
        }
        let msg = json!({"request_id": id, "type": "control_request", "request": body});
        if let Err(e) = self.write_json(&msg).await {
            self.shared.pending.lock().unwrap().remove(&id);
            return Err(e);
        }
        Ok((id, rx))
    }

    async fn await_reply(
        &self,
        id: &str,
        rx: oneshot::Receiver<ControlReply>,
    ) -> Result<Value, AgentError> {
        // The cleanup fails every waiter, so only an abort needs a branch
        // of its own. The SDK fails those at its cleanup too, with the
        // abort's cause (this same error); failing them right away differs
        // only for a reply already on its way, which a slower CLI would not
        // have sent either. Biased: a reply that already arrived wins.
        tokio::select! {
            biased;
            r = rx => r.unwrap_or(Err(AgentError::QueryClosed)),
            _ = self.shared.aborted.cancelled() => {
                self.shared.pending.lock().unwrap().remove(id);
                Err(AgentError::Aborted)
            }
        }
    }

    // ---- typed control requests (names follow the TS Query methods) ----

    /// Returns the ids of queued prompts that are still pending.
    pub async fn interrupt(&self) -> Result<Vec<String>, AgentError> {
        let r = self.request(json!({"subtype": "interrupt"})).await?;
        Ok(r.get("still_queued")
            .and_then(Value::as_array)
            .map(|a| {
                a.iter()
                    .filter_map(|v| v.as_str().map(str::to_owned))
                    .collect()
            })
            .unwrap_or_default())
    }

    pub async fn set_permission_mode(&self, mode: &str) -> Result<(), AgentError> {
        self.request(json!({"subtype": "set_permission_mode", "mode": mode}))
            .await
            .map(|_| ())
    }

    pub async fn set_model(&self, model: Option<&str>) -> Result<(), AgentError> {
        self.request(json!({"subtype": "set_model", "model": model}))
            .await
            .map(|_| ())
    }

    pub async fn set_max_thinking_tokens(
        &self,
        tokens: Option<u64>,
        display: Option<&str>,
    ) -> Result<(), AgentError> {
        let mut req = json!({"subtype": "set_max_thinking_tokens", "max_thinking_tokens": tokens});
        if let Some(d) = display {
            req["thinking_display"] = json!(d);
        }
        self.request(req).await.map(|_| ())
    }

    pub async fn apply_flag_settings(&self, settings: Value) -> Result<(), AgentError> {
        self.request(json!({"subtype": "apply_flag_settings", "settings": settings}))
            .await
            .map(|_| ())
    }

    /// `mcpServerStatus()`: the reply's `mcpServers`, `Null` when it has
    /// none (the SDK returns `undefined`).
    pub async fn mcp_server_status(&self) -> Result<Value, AgentError> {
        let r = self.request(json!({"subtype": "mcp_status"})).await?;
        Ok(r.get("mcpServers").cloned().unwrap_or(Value::Null))
    }

    pub async fn reconnect_mcp_server(&self, name: &str) -> Result<(), AgentError> {
        self.request(json!({"subtype": "mcp_reconnect", "serverName": name}))
            .await
            .map(|_| ())
    }

    pub async fn toggle_mcp_server(&self, name: &str, enabled: bool) -> Result<(), AgentError> {
        self.request(json!({"subtype": "mcp_toggle", "serverName": name, "enabled": enabled}))
            .await
            .map(|_| ())
    }

    pub async fn stop_task(&self, task_id: &str) -> Result<(), AgentError> {
        self.request(json!({"subtype": "stop_task", "task_id": task_id}))
            .await
            .map(|_| ())
    }

    /// `rewindFiles(userMessageId, opts?)`: the CLI's `RewindFilesResult`.
    /// `dry_run: None` leaves the key out, as `JSON.stringify` drops the
    /// SDK's `opts?.dryRun` when it is `undefined`.
    pub async fn rewind_files(
        &self,
        user_message_id: &str,
        dry_run: Option<bool>,
    ) -> Result<Value, AgentError> {
        let mut body = json!({"subtype": "rewind_files", "user_message_id": user_message_id});
        if let Some(d) = dry_run {
            body["dry_run"] = json!(d);
        }
        self.request(body).await
    }

    /// `getContextUsage(opts?)` — `opts` (e.g. `{detail:"summary"}`) is spread
    /// into the request body.
    pub async fn get_context_usage(&self, opts: Option<Value>) -> Result<Value, AgentError> {
        let mut body = json!({"subtype": "get_context_usage"});
        if let Some(Value::Object(o)) = opts {
            for (k, v) in o {
                body[k] = v;
            }
        }
        self.request(body).await
    }

    /// `seedReadState(path, mtime)`: tell the CLI a file was already read at
    /// `mtime` (ms), so an Edit after a resume doesn't demand a fresh Read.
    pub async fn seed_read_state(&self, path: &str, mtime: i64) -> Result<(), AgentError> {
        self.request(json!({"subtype": "seed_read_state", "path": path, "mtime": mtime}))
            .await
            .map(|_| ())
    }

    /// `updateSettings(source, settings)`: write `settings` into one settings
    /// layer (`"userSettings"`, `"projectSettings"`, `"localSettings"`, …).
    pub async fn update_settings(&self, source: &str, settings: Value) -> Result<(), AgentError> {
        self.request(json!({"subtype": "update_settings", "source": source, "settings": settings}))
            .await
            .map(|_| ())
    }

    /// `getSettings()`: `{effective, applied, …}` as the CLI reports it.
    pub async fn get_settings(&self) -> Result<Value, AgentError> {
        self.request(json!({"subtype": "get_settings"})).await
    }

    /// `submitFeedback(description, opts)`. Unset options are omitted, like
    /// `JSON.stringify` dropping the SDK's `undefined` fields.
    pub async fn submit_feedback(
        &self,
        description: &str,
        opts: &FeedbackOptions,
    ) -> Result<Value, AgentError> {
        let mut body = Map::new();
        body.insert("subtype".into(), json!("submit_feedback"));
        body.insert("description".into(), json!(description));
        for (k, v) in [
            ("surface", opts.surface.as_deref().map(Value::from)),
            ("draft_id", opts.draft_id.as_deref().map(Value::from)),
            ("type", opts.kind.as_deref().map(Value::from)),
            ("title", opts.title.as_deref().map(Value::from)),
            ("area", opts.area.as_deref().map(Value::from)),
            ("attach_transcript", opts.attach_transcript.map(Value::from)),
            ("save_locally", opts.save_locally.map(Value::from)),
        ] {
            if let Some(v) = v {
                body.insert(k.into(), v);
            }
        }
        self.request(Value::Object(body)).await
    }

    /// `setMcpServers(servers)`: replace the session's dynamic MCP servers.
    ///
    /// Same reconcile as the TS SDK:
    /// - in-process servers missing from `servers` are disconnected, even the
    ///   ones passed to `Options` at spawn;
    /// - new ones are connected;
    /// - a name that's already connected keeps its existing instance;
    /// - the request lists the external configs first, then
    ///   `{type: "sdk", name, ...settings}` for each in-process server;
    /// - a `null` external config fails with the SDK's `TypeError` text
    ///   before anything changes, and a server named `__proto__` is dropped.
    ///
    /// Returns `{added, removed, errors}` from the CLI.
    pub async fn set_mcp_servers(
        &self,
        mut servers: IndexMap<String, McpServerConfig>,
    ) -> Result<Value, AgentError> {
        // The SDK reads `config.type` off every entry before it changes
        // anything, so a `null` one throws there.
        if servers
            .values()
            .any(|c| matches!(c, McpServerConfig::External(Value::Null)))
        {
            return Err(AgentError::InvalidOptions(
                "Cannot read properties of null (reading 'type')".into(),
            ));
        }
        // Then it sorts them into plain objects (`bucket[name] = config`),
        // where `__proto__` sets the prototype instead of adding a key: that
        // server never reaches the request.
        servers.shift_remove("__proto__");
        let mut external = Map::new();
        let mut sdk_entries = Vec::new();
        {
            let mut live = self.shared.callbacks.sdk_mcp.lock().unwrap();
            let wanted: IndexMap<&String, &Arc<dyn SdkMcpServer>> = servers
                .iter()
                .filter_map(|(k, v)| match v {
                    McpServerConfig::Sdk(s) => Some((k, s)),
                    McpServerConfig::External(_) => None,
                })
                .collect();
            live.retain(|name, _| wanted.contains_key(name));
            for (name, server) in &wanted {
                if !live.contains_key(*name) {
                    live.insert((*name).clone(), Arc::clone(server));
                }
            }
            for (name, cfg) in &servers {
                match cfg {
                    McpServerConfig::External(v) => {
                        external.insert(name.clone(), v.clone());
                    }
                    McpServerConfig::Sdk(_) => {
                        // `{type: "sdk", name, ...settings}` of the CONNECTED
                        // instance (a kept one keeps its old settings).
                        let mut entry = Map::new();
                        entry.insert("type".into(), json!("sdk"));
                        entry.insert("name".into(), json!(name));
                        if let Some(server) = live.get(name) {
                            entry.extend(server.settings().to_json());
                        }
                        sdk_entries.push((name.clone(), Value::Object(entry)));
                    }
                }
            }
        }
        external.extend(sdk_entries);
        self.request(json!({"subtype": "mcp_set_servers", "servers": external}))
            .await
    }

    /// Names of the in-process MCP servers currently connected.
    pub fn sdk_mcp_server_names(&self) -> Vec<String> {
        self.shared
            .callbacks
            .sdk_mcp
            .lock()
            .unwrap()
            .keys()
            .cloned()
            .collect()
    }

    /// `reloadPlugins({holdOnCacheImpact})`: `hold_on_cache_impact: true` is
    /// sent only when set (the SDK spreads `…holdOnCacheImpact && {…}`).
    pub async fn reload_plugins(&self, hold_on_cache_impact: bool) -> Result<Value, AgentError> {
        let mut body = json!({"subtype": "reload_plugins"});
        if hold_on_cache_impact {
            body["hold_on_cache_impact"] = json!(true);
        }
        self.request(body).await
    }

    /// `backgroundTasks(toolUseId?)`: `response.backgrounded ?? true`. Without
    /// a tool use id, every running foreground task is backgrounded.
    pub async fn background_tasks(&self, tool_use_id: Option<&str>) -> Result<bool, AgentError> {
        let mut body = json!({"subtype": "background_tasks"});
        if let Some(id) = tool_use_id {
            body["tool_use_id"] = json!(id);
        }
        let r = self.request(body).await?;
        Ok(r.get("backgrounded")
            .filter(|v| !v.is_null())
            .is_none_or(|v| v.as_bool().unwrap_or(true)))
    }

    /// `usage_EXPERIMENTAL_MAY_CHANGE_DO_NOT_RELY_ON_THIS_API_YET({skipBehaviors})`
    /// (`get_usage`): plan rate limits plus, unless skipped, the local
    /// transcript `behaviors` scan.
    pub async fn get_usage(&self, skip_behaviors: bool) -> Result<Value, AgentError> {
        let mut body = json!({"subtype": "get_usage"});
        if skip_behaviors {
            body["skip_behaviors"] = json!(true);
        }
        self.request(body).await
    }

    /// The last `system/commands_changed` list, else the `initialize` one.
    pub async fn supported_commands(&self) -> Result<Value, AgentError> {
        let init = self.initialization_result().await?;
        let latest = self.shared.run.lock().unwrap().latest_commands.clone();
        Ok(latest
            .or_else(|| init.get("commands").cloned())
            .unwrap_or(json!([])))
    }

    pub async fn supported_models(&self) -> Result<Value, AgentError> {
        Ok(self
            .initialization_result()
            .await?
            .get("models")
            .cloned()
            .unwrap_or(json!([])))
    }

    pub async fn supported_agents(&self) -> Result<Value, AgentError> {
        Ok(self
            .initialization_result()
            .await?
            .get("agents")
            .cloned()
            .unwrap_or(json!([])))
    }

    pub async fn account_info(&self) -> Result<Value, AgentError> {
        Ok(self
            .initialization_result()
            .await?
            .get("account")
            .cloned()
            .unwrap_or(Value::Null))
    }

    // ---- inbound ----

    fn dispatch_line(&self, line: &str, tx: &mpsc::UnboundedSender<Result<Value, AgentError>>) {
        // Blank by JS `trim`, but parsed untrimmed: `JSON.parse` only skips
        // JSON whitespace, so e.g. an NBSP-padded line is dropped.
        if js::trim(line).is_empty() {
            return;
        }
        let v: Value = match serde_json::from_str(line) {
            Ok(v) => v,
            Err(e) => {
                tracing::debug!(
                    "ignoring non-JSON stdout line ({e}): {}",
                    truncate(line, 200)
                );
                return;
            }
        };
        match v.get("type").and_then(Value::as_str) {
            Some("control_response") => {
                let resp = v.get("response").cloned().unwrap_or(Value::Null);
                let Some(id) = resp.get("request_id").and_then(Value::as_str) else {
                    return;
                };
                let Some(waiter) = self.shared.pending.lock().unwrap().remove(id) else {
                    return;
                };
                let reply = if resp.get("subtype").and_then(Value::as_str) == Some("success") {
                    Ok(resp.get("response").cloned().unwrap_or_else(|| json!({})))
                } else {
                    Err(AgentError::ControlError(
                        resp.get("error")
                            .and_then(Value::as_str)
                            .unwrap_or("control request failed")
                            .to_owned(),
                    ))
                };
                let _ = waiter.send(reply);
            }
            Some("control_request") => {
                // The SDK calls `handleControlRequest` without awaiting it,
                // so each callback runs up to its first `await` in arrival
                // order (two `can_use_tool`s prompt in the CLI's order).
                // Poll once here for the same; a task finishes the rest.
                let this = self.clone();
                let mut fut = Box::pin(async move { this.handle_control_request(v).await });
                let mut cx = std::task::Context::from_waker(std::task::Waker::noop());
                if fut.as_mut().poll(&mut cx).is_pending() {
                    tokio::spawn(fut);
                }
            }
            Some("control_cancel_request") => {
                if let Some(id) = v.get("request_id").and_then(Value::as_str)
                    && let Some(tok) = self.shared.inflight.lock().unwrap().get(id)
                {
                    tok.cancel();
                }
            }
            Some("keep_alive") | Some("transcript_mirror") => {}
            _ => {
                if self.read_message(&v) {
                    let _ = tx.send(Ok(v));
                }
            }
        }
    }

    /// `readMessages`' bookkeeping for one SDK message. `false` when the SDK
    /// drops the message instead of yielding it.
    fn read_message(&self, v: &Value) -> bool {
        let mut run = self.shared.run.lock().unwrap();
        let ty = v.get("type").and_then(Value::as_str);
        let subtype = v.get("subtype").and_then(Value::as_str);
        if (ty, subtype) == (Some("system"), Some("commands_changed"))
            && let Some(commands @ Value::Array(_)) = v.get("commands")
        {
            run.latest_commands = Some(commands.clone());
        }
        match (ty, subtype) {
            // Yielded without touching any state.
            (Some("system"), Some("post_turn_summary" | "task_summary" | "session_metadata"))
            | (Some("active_goal" | "autocompact_state"), _) => {}
            (Some("result"), _) => {
                run.last_error_result_text = result_error_text(v).filter(js::truthy);
                run.model_less_turn_ended = subtype == Some("success")
                    && !v.get("is_error").is_some_and(js::truthy)
                    && v.get("num_turns").and_then(Value::as_f64) == Some(0.0)
                    && v.get("result").and_then(Value::as_str) == Some("");
                if !run.model_less_turn_ended {
                    run.error_text_before_model_less_turns = run.last_error_result_text.clone();
                }
                run.result_received = true;
                let idle_or_unknown = run.session_state.as_ref().is_none_or(|s| s == "idle");
                if idle_or_unknown || !self.has_bidirectional_needs() {
                    self.end_run(&mut run);
                } else {
                    self.arm_run_end_ceiling(&mut run);
                }
            }
            (Some("system"), Some("session_state_changed")) => {
                let state = v.get("state");
                run.session_state = state.cloned();
                if state.is_some_and(|s| s == "idle") {
                    if run.result_received {
                        self.end_run(&mut run);
                    }
                } else if !(run.single_user_turn && run.run_ended) {
                    run.run_ended = false;
                    if state.is_some_and(|s| s == "requires_action") {
                        run.ceiling_gen += 1;
                    } else if run.result_received {
                        self.arm_run_end_ceiling(&mut run);
                    }
                }
                // Meant for the host's own bookkeeping, not the consumer.
                if v.get("sdk_host_only") == Some(&Value::Bool(true)) {
                    return false;
                }
            }
            _ => {
                run.last_error_result_text = None;
                if (ty, subtype) == (Some("system"), Some("init")) {
                    run.model_less_turn_ended = false;
                } else if ty != Some("system") || subtype == Some("compact_boundary") {
                    run.error_text_before_model_less_turns = None;
                    run.model_less_turn_ended = false;
                }
                // Top-level output means the run is still going.
                if matches!(ty, Some("assistant" | "stream_event"))
                    && v.get("parent_tool_use_id") == Some(&Value::Null)
                    && !(run.single_user_turn && run.run_ended)
                {
                    run.run_ended = false;
                    run.ceiling_gen += 1;
                }
            }
        }
        true
    }

    /// What the reader swaps an exit error for: the last error result's
    /// text, or, after model-less turns, the error from before them.
    fn error_result_text(&self) -> Option<String> {
        let run = self.shared.run.lock().unwrap();
        let text = match &run.last_error_result_text {
            Some(t) => Some(t),
            None if run.model_less_turn_ended => run.error_text_before_model_less_turns.as_ref(),
            None => None,
        };
        text.map(|t| js::to_string(Some(t)))
    }

    /// `hasBidirectionalNeeds()`: something may still ask the host for a
    /// control answer after the result.
    fn has_bidirectional_needs(&self) -> bool {
        let cb = &self.shared.callbacks;
        cb.can_use_tool.is_some()
            || cb.on_elicitation.is_some()
            || self.shared.hooks_configured
            || !cb.sdk_mcp.lock().unwrap().is_empty()
    }

    /// `endRun()`: for a single-turn query, close stdin.
    fn end_run(&self, run: &mut RunState) {
        if run.run_ended {
            return;
        }
        run.run_ended = true;
        run.ceiling_gen += 1;
        if run.single_user_turn {
            let this = self.clone();
            tokio::spawn(async move { this.end_input().await });
        }
    }

    /// `armRunEndCeiling()`: end the run if no `idle` comes in time.
    fn arm_run_end_ceiling(&self, run: &mut RunState) {
        run.ceiling_gen += 1;
        let ms = self.shared.run_end_ceiling_ms;
        if run.run_ended || self.shared.closed.is_cancelled() || ms <= 0.0 {
            return;
        }
        let armed = run.ceiling_gen;
        let this = self.clone();
        tokio::spawn(async move {
            tokio::time::sleep(Duration::from_millis(ms.min(TIMEOUT_MAX_MS) as u64)).await;
            let mut run = this.shared.run.lock().unwrap();
            if run.ceiling_gen == armed {
                tracing::debug!("no 'idle' {ms}ms after the last result, ending the run");
                this.end_run(&mut run);
            }
        });
    }

    async fn handle_control_request(&self, v: Value) {
        let Some(request_id) = v
            .get("request_id")
            .and_then(Value::as_str)
            .map(str::to_owned)
        else {
            return;
        };
        if self.shared.closed.is_cancelled() {
            return;
        }
        let token = self.shared.closed.child_token();
        {
            let mut inflight = self.shared.inflight.lock().unwrap();
            if inflight.contains_key(&request_id) {
                tracing::debug!("duplicate delivery of in-flight request {request_id}");
                return;
            }
            inflight.insert(request_id.clone(), token.clone());
        }
        let result = self
            .process_control_request(&request_id, v.get("request"), token)
            .await;
        self.shared.inflight.lock().unwrap().remove(&request_id);
        if self.shared.closed.is_cancelled() {
            return;
        }
        let msg = match result {
            Ok(None) => return, // leave unanswered
            Ok(Some(resp)) => json!({
                "type": "control_response",
                "response": {"subtype": "success", "request_id": request_id, "response": resp},
            }),
            Err(e) => json!({
                "type": "control_response",
                "response": {"subtype": "error", "request_id": request_id, "error": e},
            }),
        };
        if let Err(e) = self.write_json(&msg).await {
            tracing::error!("control response write failed: {e}");
        }
    }

    /// `processControlRequest`. `Ok(None)` leaves the request unanswered
    /// (the SDK's `fc` sentinel); `Err` is the error reply's message, as
    /// `rt(e)` prints the thrown value. JS semantics matter here: subtypes
    /// match only as strings, a non-string subtype prints with `String()`,
    /// and reading `.subtype` off a missing / null `request` throws.
    async fn process_control_request(
        &self,
        request_id: &str,
        req: Option<&Value>,
        token: CancellationToken,
    ) -> Result<Option<Value>, String> {
        let req = match req {
            None => return Err(read_prop_error("undefined", "subtype")),
            Some(Value::Null) => return Err(read_prop_error("null", "subtype")),
            Some(req) => req,
        };
        let get = |k: &str| js::prop(Some(req), k);
        let subtype = get("subtype");
        let cb = &self.shared.callbacks;
        match subtype.and_then(Value::as_str) {
            // For the machine serving this session's tools (`DZ`).
            Some(
                "remote_tool_call"
                | "remote_plumbing_call"
                | "remote_tools_probe"
                | "remote_tools_reannounce",
            ) => Ok(None),
            Some("can_use_tool") => {
                let can_use = cb
                    .can_use_tool
                    .as_ref()
                    .ok_or("canUseTool callback is not provided.")?;
                let tool = get("tool_name")
                    .and_then(Value::as_str)
                    .unwrap_or_default()
                    .to_owned();
                let input = get("input").cloned().unwrap_or_else(|| json!({}));
                let ctx = ToolPermissionContext::from_request(request_id, req, token);
                // `toolUseID: request.tool_use_id`, whatever its type.
                let tool_use_id = get("tool_use_id").cloned();
                Ok(can_use
                    .can_use_tool(&tool, input, ctx)
                    .await
                    .map(|r| r.to_wire(tool_use_id.as_ref())))
            }
            Some("hook_callback") => {
                // `hookCallbacks` is keyed by `hook_<n>` strings.
                let id = get("callback_id");
                let hook = id
                    .and_then(Value::as_str)
                    .and_then(|id| cb.hooks.get(id))
                    .ok_or_else(|| {
                        format!("No hook callback found for ID: {}", js::to_string(id))
                    })?;
                let input = get("input").cloned().unwrap_or(Value::Null);
                let tool_use_id = get("tool_use_id")
                    .and_then(Value::as_str)
                    .map(str::to_owned);
                Ok(Some(hook.call(input, tool_use_id, token).await))
            }
            Some("mcp_message") => {
                let name = get("server_name");
                let server = name
                    .and_then(Value::as_str)
                    .and_then(|n| cb.sdk_mcp.lock().unwrap().get(n).cloned())
                    .ok_or_else(|| format!("SDK MCP server not found: {}", js::to_string(name)))?;
                // `kZ(message)`: `"method" in m && "id" in m && m.id !== null`.
                // The `in` operator throws on a primitive (arrays are objects).
                let message = get("message");
                let is_request = match message {
                    Some(Value::Object(m)) => {
                        m.contains_key("method") && m.get("id").is_some_and(|id| !id.is_null())
                    }
                    Some(Value::Array(_)) => false,
                    other => {
                        return Err(format!(
                            "Cannot use 'in' operator to search for 'method' in {}",
                            js::to_string(other)
                        ));
                    }
                };
                let message = message.cloned().unwrap_or(Value::Null);
                if is_request {
                    // The SDK waits for the server's reply to this id; a
                    // server that never answers (e.g. a malformed request it
                    // drops) leaves the control request unanswered.
                    Ok(server
                        .handle(message)
                        .await
                        .map(|resp| json!({"mcp_response": resp})))
                } else {
                    let _ = server.handle(message).await;
                    Ok(Some(
                        json!({"mcp_response": {"jsonrpc": "2.0", "result": {}, "id": 0}}),
                    ))
                }
            }
            Some("elicitation") => match &cb.on_elicitation {
                Some(h) => Ok(h
                    .on_elicitation(ElicitationRequest::from_request(request_id, req, token))
                    .await),
                None => Ok(Some(json!({"action": "decline"}))),
            },
            // No `onUserDialog`: stay silent so a capable client (or the
            // CLI's park deadline) settles it.
            Some("request_user_dialog") => Ok(None),
            // Callbacks Claudius never passes (`getOAuthToken`,
            // `getHostAuthToken`, `refreshWorkSecret`).
            Some("oauth_token_refresh") => Err("getOAuthToken callback is not provided.".into()),
            Some("host_auth_token_refresh") => {
                Err("getHostAuthToken callback is not provided.".into())
            }
            Some("remote_control_work_secret") => {
                Err("refreshWorkSecret callback is not provided.".into())
            }
            // `ui_*` too: they're served only by a `uiHost`, which Claudius
            // doesn't pass.
            _ => Err(format!(
                "Unsupported control request subtype: {}",
                js::to_string(subtype)
            )),
        }
    }

    /// Stdout is done (EOF, or `read_error`): wait for the exit, then the
    /// SDK's `cleanup(cause)`: fail every pending request with the cause (or
    /// [`AgentError::QueryClosed`] without one) and end the stream with it.
    async fn on_stdout_closed(
        &self,
        tx: &mpsc::UnboundedSender<Result<Value, AgentError>>,
        read_error: Option<std::io::Error>,
    ) {
        let info = tokio::time::timeout(Duration::from_secs(5), self.wait_exit())
            .await
            .unwrap_or(ExitInfo::Unknown);
        let err = if self.shared.aborted.is_cancelled() {
            // Once aborted, the SDK's `waitForExit` rejects with `vZ()`
            // whatever the exit was, and that is never swapped for a result.
            Some(AgentError::Aborted)
        } else {
            self.exit_error(read_error, info).await
        };
        let waiters: Vec<_> = {
            let mut pending = self.shared.pending.lock().unwrap();
            self.shared.cleaned_up.store(true, Ordering::Release);
            pending.drain().map(|(_, w)| w).collect()
        };
        for w in waiters {
            let cause = err
                .as_ref()
                .map_or(AgentError::QueryClosed, AgentError::duplicate);
            let _ = w.send(Err(cause));
        }
        for tok in self.shared.inflight.lock().unwrap().values() {
            tok.cancel();
        }
        if let Some(e) = err {
            let _ = tx.send(Err(e));
        }
        self.shared.closed.cancel();
    }

    /// The error the SDK's reader ends with when the host didn't abort:
    /// from the read, the exit code or the signal, swapped for the last
    /// error result's text when there was one.
    async fn exit_error(
        &self,
        read_error: Option<std::io::Error>,
        info: ExitInfo,
    ) -> Option<AgentError> {
        // Like the SDK, report the exit once stderr is drained, so its tail
        // is complete, but give up shortly after the exit (a grandchild may
        // hold the pipe open).
        let _ = tokio::time::timeout(STDERR_DRAIN_GRACE, self.shared.stderr_done.cancelled()).await;
        self.shared.stderr_cutoff.store(true, Ordering::Release);
        let stderr = AgentError::stderr_suffix(&stream::format_stderr_tail(&self.stderr_tail()));
        let err = match (read_error, info) {
            (Some(e), _) => AgentError::Io(e),
            (None, ExitInfo::Code(0) | ExitInfo::Unknown) => return None,
            (None, ExitInfo::Code(code)) => AgentError::ProcessExited { code, stderr },
            // Node has no name for it, so it reports exit code 0.
            (None, ExitInfo::Signal(signal)) if crate::signal_name(signal).is_none() => {
                return None;
            }
            (None, ExitInfo::Signal(signal)) => AgentError::ProcessKilled { signal, stderr },
        };
        Some(match self.error_result_text() {
            Some(text) => {
                tracing::debug!("replacing exit error with result text. Original: {err}");
                AgentError::ErrorResult(text)
            }
            None => err,
        })
    }
}

fn truncate(s: &str, max: usize) -> &str {
    if s.len() <= max {
        return s;
    }
    let mut end = max;
    while !s.is_char_boundary(end) {
        end -= 1;
    }
    &s[..end]
}

/// A `result`'s error text (`readMessages`): `result` itself for an
/// `is_error` success, else the trimmed, non-blank `errors` joined with
/// `; `. (The SDK throws on a non-array `errors` or a non-string entry; the
/// CLI never sends either, and here they just don't count.)
fn result_error_text(v: &Value) -> Option<Value> {
    if !v.get("is_error").is_some_and(js::truthy) {
        return None;
    }
    if v.get("subtype").and_then(Value::as_str) == Some("success") {
        return v.get("result").cloned();
    }
    let errors = v.get("errors").and_then(Value::as_array)?;
    let texts: Vec<&str> = errors
        .iter()
        .filter_map(Value::as_str)
        .map(js::trim)
        .filter(|t| !t.is_empty())
        .collect();
    Some(Value::String(texts.join("; ")))
}

/// V8's `TypeError` for reading a property of `undefined` / `null`.
fn read_prop_error(of: &str, key: &str) -> String {
    format!("Cannot read properties of {of} (reading '{key}')")
}
