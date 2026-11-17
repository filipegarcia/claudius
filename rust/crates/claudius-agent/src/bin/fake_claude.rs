//! A scripted stand-in for the `claude` binary, speaking just enough of the
//! stream-json + control protocol for deterministic tests (unit, server, and
//! UI e2e) without touching the network.
//!
//! # Built-in behaviour per user prompt text
//! * contains `script:<json>` → runs that JSON as a turn (see *Scripts*): a
//!   step array or a turn object. Trailing text after the JSON is ignored.
//! * contains `tool:` → asks `can_use_tool` for `Bash {command: "<rest>"}`,
//!   then answers `permission:<behavior>`.
//! * contains `ask:` / `plan:` → `AskUserQuestion` / `ExitPlanMode` round trip.
//! * contains `mcp:` → calls `tools/call` on the first SDK MCP server.
//! * contains `hook` → calls the first registered hook callback.
//! * contains `exit:<n>` → writes `boom` to stderr and exits with `<n>`.
//! * anything else → echoes `echo:<text>`.
//!
//! Every built-in turn ends with an assistant message and a `result`.
//!
//! # Environment
//! * `$FAKE_CLAUDE_ARGV` — file that gets the argv as a JSON array.
//! * `$FAKE_CLAUDE_ENV` — file that gets the full environment as a JSON object.
//! * `$FAKE_CLAUDE_LOG` — file that gets every stdin line.
//! * `$FAKE_CLAUDE_CONTROL_LOG` — file that gets every host→CLI
//!   `control_request` / `control_cancel_request`, one JSON line each.
//! * `$FAKE_CLAUDE_PID` — file that gets this process's pid.
//! * `$FAKE_CLAUDE_FDS` — file that gets the descriptors above stdio this
//!   process started with (a JSON array), to check what it inherited.
//! * `$FAKE_CLAUDE_EVENTS` — file that gets `{"mark": label}` for each
//!   `$mark` step and `{"eof": true}` the moment stdin closes, in order, so
//!   a test can tell when the host closed stdin relative to the script.
//! * `$FAKE_CLAUDE_SCRIPT` — a script: inline JSON (starts with `{`) or a
//!   path to a JSON file.
//! * `$FAKE_CLAUDE_TIMES` — file that gets `{"event": "eof", "ms": t}` the
//!   moment stdin closes and `{"event": "SIGTERM", "ms": t}` for each SIGTERM
//!   an `on_sigterm` trap catches (`t`: Unix time in ms), so a test can tell
//!   when the host ended stdin and signalled (R13).
//!
//! # Scripts
//! ```json
//! {
//!   "init":       { "...": "merged over the default system/init message" },
//!   "initialize": { "...": "merged over the default initialize response" },
//!   "on_init":    [ "step", "..." ],
//!   "on_eof":     [ "step", "..." ],
//!   "on_sigterm": "ignore" | "die" | { "exit": 0, "after_ms": 3500 },
//!   "control": {
//!     "<subtype>": "<literal response value>",
//!     "<subtype>": { "$error": "message" },
//!     "<subtype>": { "$response": {}, "$emit": ["step"], "$delay_ms": 0 },
//!     "<subtype>": { "$no_reply": true, "$emit": [{ "$exit": 3 }] },
//!     "<subtype>": { "$before": ["step"], "$envelope": { "...": "..." } },
//!     "<subtype>": { "$same_write": [{ "type": "..." }] },
//!     "<subtype>": { "$sequence": ["<entry>", "..."] }
//!   },
//!   "turns": [
//!     { "match": "substr", "repeat": false, "steps": ["step"], "result": "text" }
//!   ]
//! }
//! ```
//! * `on_init` runs right after the initialize response.
//! * `on_eof` runs when the main loop reads stdin's EOF, instead of exiting
//!   at once (it exits 0 after them): `[{"$delay_ms": 60000}]` is a CLI that
//!   ignores EOF. (A `$control` / `$collect_ms` wait still exits at EOF.)
//! * `on_sigterm` traps SIGTERM and logs it to `$FAKE_CLAUDE_TIMES`, then
//!   `"ignore"` carries on, `"die"` dies by it as if untrapped, and
//!   `{"exit", "after_ms"}` exits with that code that long after the first
//!   one. Without it SIGTERM just kills the process.
//! * `control` overrides the canned response for a control subtype. With
//!   `$emit`, the steps run *after* the response is sent (e.g. `interrupt` →
//!   emit the `error_during_execution` result a real CLI sends). With
//!   `$no_reply`, no response is sent at all (the request stays pending), so
//!   `$emit` can end the process with the host still waiting. `$before`
//!   steps run before the response is sent (e.g. a live `control_request`
//!   ahead of the `initialize` reply). `$envelope`'s keys are merged into
//!   the reply's `response` envelope, next to `subtype` / `request_id` (e.g.
//!   `pending_permission_requests`), `$error` replies too. `$same_write`
//!   messages are written as-is right after the reply, in the same write,
//!   so the host reads them in the same chunk. With
//!   `$sequence`, the n-th request of that subtype is answered by the n-th
//!   entry (any of the forms above), and the last one repeats.
//! * For each user prompt, the first unconsumed turn whose `match` (if any)
//!   is a substring of the prompt runs. `repeat: true` keeps it available.
//!   No match → the built-in behaviour above.
//! * `result`: absent → a success result carrying the last assistant text of
//!   the turn; a string → that text; an object → merged over the default
//!   result; `false` → no result (the turn stays open).
//!
//! A *step* is either a message (any object with a `type`, emitted as-is
//! after placeholder substitution; `session_id` and `uuid` are filled in when
//! the keys are absent) or a directive:
//! * `{"$text": "…"}` — an assistant text message (a non-string value, e.g. a
//!   `$LAST:/ptr` that resolved to `null`, is written as its JSON text).
//! * `{"$control": {request}}` — a CLI→host control request; waits for the
//!   response, which becomes `$LAST`.
//! * `{"$send": {request}}` — the same, without waiting (for requests the
//!   host may leave unanswered). Both take an optional `"$id"`, the request
//!   id to use instead of `cli_<turn>_s<step>`.
//! * `{"$expect": ["id", …]}` — have the next `$collect_ms` also wait for a
//!   response to each of these ids (once per listing), e.g. requests the
//!   host was handed some other way.
//! * `{"$collect_ms": n}` — read inbound lines (so `$FAKE_CLAUDE_LOG` gets
//!   them) until every `$send` (and `$expect`) request is answered or `n` ms
//!   pass.
//! * `{"$mark": "label"}` — append `{"mark": label}` to `$FAKE_CLAUDE_EVENTS`.
//! * `{"$delay_ms": n}`, `{"$stderr": "…"}`, `{"$exit": n}`.
//! * `{"$wait_file": "path"}` — block until `path` (relative to the cwd)
//!   exists, at most 60 s, so a test can hold a turn open on a gate it
//!   controls and release it at a point of its choosing.
//! * `{"$hold_stdout_ms": n}` — start a `sleep` that inherits stdout (only)
//!   and outlives this process by up to `n` ms, so the host sees the exit
//!   while its reader still waits for EOF.
//! * `{"$kill": "SIGTERM"}` — die by that signal (`SIGTERM`, `SIGKILL`,
//!   `SIGINT`, `SIGHUP`, `SIGABRT`, `SIGSEGV`, `SIGUSR1`, or a raw number).
//! * `{"$stdout_bytes": [n, …]}` / `{"$stderr_bytes": [n, …]}` — write those
//!   bytes as-is (no newline added), e.g. invalid UTF-8 or bare `\r`s.
//! * `{"$fs": ["write", path, text | [byte, …]]}`, `["rm", path]` (recursive,
//!   missing is fine), `["mkdir", path]` (recursive), `["chmod", path, mode]`
//!   — change a file mid-turn, between the host's hook callbacks.
//!
//! Placeholders in string values: `$SESSION_ID`, `$MODEL`, `$PROMPT`
//! (substring replace); exact-match only: `$UUID` (fresh v4), `$N` (turn
//! number, as a number), `$LAST` (last control response body),
//! `$LAST:/json/pointer` and `$HOOK:<Event>` (the host's first callback id
//! for that hook event, e.g. `$HOOK:PreToolUse`, for a `hook_callback`).

use std::collections::{BTreeSet, VecDeque};
use std::io::{BufRead, Write};

use serde_json::{Map, Value, json};

struct Io {
    /// Stdin lines, read on a thread so `$collect_ms` can time out.
    lines: std::sync::mpsc::Receiver<String>,
    stash: VecDeque<Value>,
    log: Option<std::fs::File>,
}

impl Io {
    fn emit(&self, v: &Value) {
        self.emit_all(std::slice::from_ref(v));
    }

    /// Lines written with one `write` (then flushed).
    fn emit_all(&self, vs: &[Value]) {
        let text: String = vs.iter().map(|v| format!("{v}\n")).collect();
        let mut out = std::io::stdout().lock();
        let _ = out.write_all(text.as_bytes());
        let _ = out.flush();
    }

    fn read(&mut self) -> Option<Value> {
        if let Some(v) = self.stash.pop_front() {
            return Some(v);
        }
        self.read_raw()
    }

    fn read_raw(&mut self) -> Option<Value> {
        loop {
            let line = self.lines.recv().ok()?;
            if let Some(v) = self.parse_logged(line) {
                return Some(v);
            }
        }
    }

    /// The next inbound message before `deadline`; `Err` on timeout,
    /// `Ok(None)` at EOF.
    fn read_until(&mut self, deadline: std::time::Instant) -> Result<Option<Value>, ()> {
        loop {
            let left = deadline.saturating_duration_since(std::time::Instant::now());
            match self.lines.recv_timeout(left) {
                Ok(line) => {
                    if let Some(v) = self.parse_logged(line) {
                        return Ok(Some(v));
                    }
                }
                Err(std::sync::mpsc::RecvTimeoutError::Timeout) => return Err(()),
                Err(std::sync::mpsc::RecvTimeoutError::Disconnected) => return Ok(None),
            }
        }
    }

    /// A stdin line, logged as is, then read as the CLI's `JSON.parse` reads
    /// it: a lone-surrogate escape the SDK wrote (`JSON.stringify` of a JS
    /// string holding one) becomes U+FFFD, where serde_json alone would drop
    /// the line and leave its request unanswered.
    fn parse_logged(&mut self, line: String) -> Option<Value> {
        if let Some(f) = &mut self.log {
            append_line(f, &line);
        }
        claudius_agent::js::parse_line(&line).ok()
    }

    /// Send a control request and block until its response arrives
    /// (other inbound lines are stashed for the main loop).
    fn ask(&mut self, id: &str, request: Value) -> Value {
        self.emit(&json!({"type": "control_request", "request_id": id, "request": request}));
        loop {
            let Some(v) = self.read_raw() else {
                std::process::exit(0)
            };
            if v["type"] == "control_response" && v["response"]["request_id"] == id {
                return v["response"].clone();
            }
            self.stash.push_back(v);
        }
    }
}

#[derive(Default)]
struct Script {
    init: Map<String, Value>,
    initialize: Map<String, Value>,
    on_init: Vec<Value>,
    on_eof: Vec<Value>,
    on_sigterm: Value,
    control: Map<String, Value>,
    turns: Vec<Value>,
}

impl Script {
    fn load() -> Script {
        let Ok(raw) = std::env::var("FAKE_CLAUDE_SCRIPT") else {
            return Script::default();
        };
        let text = if raw.trim_start().starts_with('{') {
            raw
        } else {
            std::fs::read_to_string(&raw)
                .unwrap_or_else(|e| fail(&format!("FAKE_CLAUDE_SCRIPT {raw}: {e}")))
        };
        let v: Value = serde_json::from_str(&text)
            .unwrap_or_else(|e| fail(&format!("FAKE_CLAUDE_SCRIPT: bad JSON: {e}")));
        let obj = |k: &str| v[k].as_object().cloned().unwrap_or_default();
        let arr = |k: &str| v[k].as_array().cloned().unwrap_or_default();
        Script {
            init: obj("init"),
            initialize: obj("initialize"),
            on_init: arr("on_init"),
            on_eof: arr("on_eof"),
            on_sigterm: v["on_sigterm"].clone(),
            control: obj("control"),
            turns: arr("turns"),
        }
    }

    /// Index of the first unconsumed scripted turn for this prompt.
    fn pick(&self, text: &str) -> Option<usize> {
        self.turns
            .iter()
            .position(|t| !t.is_null() && t["match"].as_str().is_none_or(|m| text.contains(m)))
    }
}

/// `$kill`: die by a signal (a name or a raw number).
#[cfg(unix)]
fn kill_self(name: &Value) -> ! {
    let sig = match name.as_str() {
        Some("SIGTERM") => libc::SIGTERM,
        Some("SIGKILL") => libc::SIGKILL,
        Some("SIGINT") => libc::SIGINT,
        Some("SIGHUP") => libc::SIGHUP,
        Some("SIGABRT") => libc::SIGABRT,
        Some("SIGSEGV") => libc::SIGSEGV,
        Some("SIGUSR1") => libc::SIGUSR1,
        _ => match name.as_i64() {
            Some(n) => n as i32,
            None => fail(&format!("unknown signal {name}")),
        },
    };
    let _ = std::io::stdout().flush();
    // SAFETY: signalling our own pid; a default-action signal ends the process.
    unsafe {
        libc::signal(sig, libc::SIG_DFL);
        libc::kill(libc::getpid(), sig);
    }
    std::thread::sleep(std::time::Duration::from_secs(5));
    fail(&format!("survived signal {name}"))
}

#[cfg(not(unix))]
fn kill_self(name: &Value) -> ! {
    fail(&format!("$kill {name} needs Unix signals"))
}

/// Append `{"event": event, "ms": <Unix ms>}` to `$FAKE_CLAUDE_TIMES`, in
/// one write: the stdin thread's `eof` can race a SIGTERM's line, and a
/// `die` ends the process right after its own.
fn log_time(event: &str) {
    if let Some(mut f) = append_file("FAKE_CLAUDE_TIMES") {
        let ms = std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .map_or(0, |d| d.as_millis() as u64);
        append_line(&mut f, &json!({"event": event, "ms": ms}).to_string());
    }
}

/// `on_sigterm`: block SIGTERM before any other thread starts (they inherit
/// the mask), and take it on a thread of its own with `sigwait`, where
/// logging and exiting are safe.
#[cfg(unix)]
fn trap_sigterm(mode: Value) {
    // SAFETY: a zeroed `sigset_t` is valid input to `sigemptyset`; the mask
    // only changes for this (still single-threaded) process.
    let set = unsafe {
        let mut set: libc::sigset_t = std::mem::zeroed();
        libc::sigemptyset(&mut set);
        libc::sigaddset(&mut set, libc::SIGTERM);
        libc::pthread_sigmask(libc::SIG_BLOCK, &set, std::ptr::null_mut());
        set
    };
    std::thread::spawn(move || {
        loop {
            let mut sig = 0;
            // SAFETY: `set` holds SIGTERM, which every thread blocks.
            if unsafe { libc::sigwait(&set, &mut sig) } != 0 {
                continue;
            }
            log_time("SIGTERM");
            match &mode {
                Value::String(m) if m == "die" => {
                    // SAFETY: back to the default action, unblocked here, so
                    // the re-sent signal ends the process like an untrapped one.
                    unsafe {
                        libc::signal(libc::SIGTERM, libc::SIG_DFL);
                        libc::pthread_sigmask(libc::SIG_UNBLOCK, &set, std::ptr::null_mut());
                        libc::kill(libc::getpid(), libc::SIGTERM);
                    }
                }
                // The first SIGTERM's exit comes first: later ones are moot.
                Value::Object(o) => {
                    let code = o.get("exit").and_then(Value::as_i64).unwrap_or(0) as i32;
                    let ms = o.get("after_ms").and_then(Value::as_u64).unwrap_or(0);
                    std::thread::spawn(move || {
                        std::thread::sleep(std::time::Duration::from_millis(ms));
                        std::process::exit(code);
                    });
                }
                _ => {}
            }
        }
    });
}

#[cfg(not(unix))]
fn trap_sigterm(_mode: Value) {
    fail("on_sigterm needs Unix signals")
}

/// A `$stdout_bytes` / `$stderr_bytes` payload: an array of byte values.
fn raw_bytes(v: &Value) -> Vec<u8> {
    v.as_array()
        .unwrap_or_else(|| fail(&format!("expected a byte array, got {v}")))
        .iter()
        .map(|b| match b.as_u64() {
            Some(n) if n <= 255 => n as u8,
            _ => fail(&format!("not a byte: {b}")),
        })
        .collect()
}

/// A `sleep` holding (only) stdout open for `ms`. Never waited on: it is
/// meant to outlive this process, and init reaps it.
#[allow(clippy::zombie_processes)]
fn hold_stdout(ms: u64) {
    std::process::Command::new("sleep")
        .arg(format!("{}.{:03}", ms / 1000, ms % 1000))
        .stdin(std::process::Stdio::null())
        .stderr(std::process::Stdio::null())
        .spawn()
        .unwrap_or_else(|e| fail(&format!("spawn sleep: {e}")));
}

/// A `$send` / `$control` step's request id: its `$id`, else
/// `cli_<turn>_s<step>`.
fn step_id(step: &Value, turn: u32, i: usize) -> String {
    step.get("$id")
        .and_then(Value::as_str)
        .map_or_else(|| format!("cli_{turn}_s{i}"), str::to_owned)
}

/// Takes one `id` off the ids `$collect_ms` waits for; `false` if it isn't
/// one of them.
fn take(sent: &mut Vec<String>, id: &str) -> bool {
    match sent.iter().position(|s| s == id) {
        Some(i) => {
            sent.remove(i);
            true
        }
        None => false,
    }
}

fn fail(msg: &str) -> ! {
    eprintln!("claudius-fake-claude: {msg}");
    std::process::exit(2)
}

fn merge(base: &mut Value, over: &Map<String, Value>) {
    if let Some(b) = base.as_object_mut() {
        for (k, v) in over {
            b.insert(k.clone(), v.clone());
        }
    }
}

fn prompt_text(msg: &Value) -> String {
    match &msg["message"]["content"] {
        Value::String(s) => s.clone(),
        Value::Array(parts) => parts
            .iter()
            .filter_map(|p| p["text"].as_str())
            .collect::<Vec<_>>()
            .join(""),
        _ => String::new(),
    }
}

/// First JSON value in `s`, ignoring whatever follows it.
fn leading_json(s: &str) -> Option<Value> {
    serde_json::Deserializer::from_str(s.trim_start())
        .into_iter::<Value>()
        .next()?
        .ok()
}

fn assistant_text(msg: &Value) -> Option<String> {
    if msg["type"] != "assistant" {
        return None;
    }
    let text: String = msg["message"]["content"]
        .as_array()?
        .iter()
        .filter_map(|p| p["text"].as_str())
        .collect();
    Some(text)
}

struct Fake {
    io: Io,
    script: Script,
    control_log: Option<std::fs::File>,
    events: Option<std::fs::File>,
    session_id: String,
    model: String,
    mode: String,
    sdk_servers: Vec<String>,
    hook_ids: Vec<String>,
    /// Hook callback ids by event name, for `$HOOK:<Event>`.
    hook_ids_by_event: std::collections::HashMap<String, Vec<String>>,
    /// Merged `apply_flag_settings` bodies (reflected by `get_settings`).
    flag_settings: Map<String, Value>,
    /// Server names set via `mcp_set_servers` (for added/removed diffs).
    dynamic_mcp: BTreeSet<String>,
    /// Turn number (1-based), shared by built-in and scripted turns.
    n: u32,
    prompt: String,
    last: Value,
    /// Last assistant text emitted in the current turn.
    last_text: String,
    /// `$send` / `$expect` request ids still waiting for a response, once
    /// per expected response.
    sent: Vec<String>,
}

impl Fake {
    fn subst(&self, v: &Value) -> Value {
        match v {
            Value::String(s) => match s.as_str() {
                "$UUID" => json!(uuid::Uuid::new_v4().to_string()),
                "$N" => json!(self.n),
                "$LAST" => self.last.clone(),
                _ if s.starts_with("$LAST:") => {
                    self.last.pointer(&s[6..]).cloned().unwrap_or(Value::Null)
                }
                _ if s.starts_with("$HOOK:") => self
                    .hook_ids_by_event
                    .get(&s[6..])
                    .and_then(|ids| ids.first())
                    .map_or(Value::Null, |id| json!(id)),
                _ => json!(
                    s.replace("$SESSION_ID", &self.session_id)
                        .replace("$MODEL", &self.model)
                        .replace("$PROMPT", &self.prompt)
                ),
            },
            Value::Array(a) => Value::Array(a.iter().map(|x| self.subst(x)).collect()),
            Value::Object(o) => {
                Value::Object(o.iter().map(|(k, x)| (k.clone(), self.subst(x))).collect())
            }
            other => other.clone(),
        }
    }

    fn emit_message(&mut self, mut msg: Value) {
        let control = msg["type"]
            .as_str()
            .is_some_and(|t| t.starts_with("control_"));
        if let (Some(o), false) = (msg.as_object_mut(), control) {
            o.entry("session_id")
                .or_insert_with(|| json!(self.session_id));
            o.entry("uuid")
                .or_insert_with(|| json!(uuid::Uuid::new_v4().to_string()));
        }
        if let Some(t) = assistant_text(&msg) {
            self.last_text = t;
        }
        self.io.emit(&msg);
    }

    fn assistant(&mut self, text: &str) {
        self.emit_message(json!({
            "type": "assistant",
            "message": {"id": format!("msg_{}", uuid::Uuid::new_v4().simple()), "role": "assistant", "model": "fake",
                        "content": [{"type": "text", "text": text}], "stop_reason": "end_turn",
                        "usage": {"input_tokens": 1, "output_tokens": 1}},
            "parent_tool_use_id": null,
        }));
    }

    fn result_msg(&self, text: &str) -> Value {
        json!({
            "type": "result", "subtype": "success", "is_error": false, "result": text,
            "duration_ms": 1, "duration_api_ms": 1, "num_turns": 1, "total_cost_usd": 0.0,
            "usage": {"input_tokens": 1, "output_tokens": 1}, "session_id": self.session_id,
            "uuid": uuid::Uuid::new_v4().to_string(),
        })
    }

    fn run_steps(&mut self, steps: &[Value]) {
        for (i, step) in steps.iter().enumerate() {
            let step = self.subst(step);
            if step.get("type").is_some() {
                self.emit_message(step);
            } else if let Some(t) = step.get("$text") {
                // A non-string (e.g. a `$LAST:/ptr` that resolved to null or
                // an object) is written as its JSON text.
                let text = t.as_str().map_or_else(|| t.to_string(), str::to_owned);
                self.assistant(&text);
            } else if let Some(req) = step.get("$control") {
                let id = step_id(&step, self.n, i);
                self.last = self.io.ask(&id, req.clone())["response"].clone();
            } else if let Some(req) = step.get("$send") {
                let id = step_id(&step, self.n, i);
                self.io
                    .emit(&json!({"type": "control_request", "request_id": id, "request": req}));
                self.sent.push(id);
            } else if let Some(ids) = step.get("$expect").and_then(Value::as_array) {
                self.sent
                    .extend(ids.iter().filter_map(Value::as_str).map(str::to_owned));
            } else if let Some(ms) = step.get("$collect_ms").and_then(Value::as_u64) {
                let deadline = std::time::Instant::now() + std::time::Duration::from_millis(ms);
                // Responses an earlier `$control` wait stashed count too.
                let sent = &mut self.sent;
                self.io.stash.retain(|v| {
                    v["type"] != "control_response"
                        || !take(
                            sent,
                            v["response"]["request_id"].as_str().unwrap_or_default(),
                        )
                });
                while !self.sent.is_empty() {
                    match self.io.read_until(deadline) {
                        Ok(Some(v)) => {
                            let id = v["response"]["request_id"].as_str().unwrap_or_default();
                            if v["type"] != "control_response" || !take(&mut self.sent, id) {
                                self.io.stash.push_back(v);
                            }
                        }
                        Ok(None) => std::process::exit(0),
                        Err(()) => break,
                    }
                }
            } else if let Some(label) = step.get("$mark") {
                if let Some(f) = &mut self.events {
                    append_line(f, &json!({"mark": label}).to_string());
                }
            } else if let Some(ms) = step.get("$delay_ms").and_then(Value::as_u64) {
                std::thread::sleep(std::time::Duration::from_millis(ms));
            } else if let Some(path) = step.get("$wait_file").and_then(Value::as_str) {
                let deadline = std::time::Instant::now() + std::time::Duration::from_secs(60);
                while !std::path::Path::new(path).exists() && std::time::Instant::now() < deadline {
                    std::thread::sleep(std::time::Duration::from_millis(5));
                }
            } else if let Some(s) = step.get("$stderr").and_then(Value::as_str) {
                eprintln!("{s}");
            } else if let Some(ms) = step.get("$hold_stdout_ms").and_then(Value::as_u64) {
                hold_stdout(ms);
            } else if let Some(code) = step.get("$exit").and_then(Value::as_i64) {
                std::process::exit(code as i32);
            } else if let Some(bytes) = step.get("$stdout_bytes") {
                let mut out = std::io::stdout().lock();
                let _ = out.write_all(&raw_bytes(bytes));
                let _ = out.flush();
            } else if let Some(bytes) = step.get("$stderr_bytes") {
                let _ = std::io::stderr().write_all(&raw_bytes(bytes));
            } else if let Some(name) = step.get("$kill") {
                kill_self(name);
            } else if let Some(op) = step.get("$fs") {
                Self::fs_op(op);
            } else {
                fail(&format!("unknown script step: {step}"));
            }
        }
    }

    /// A `$fs` step.
    fn fs_op(op: &Value) {
        let arg = |i: usize| op[i].as_str().unwrap_or_default();
        let ok = match arg(0) {
            "write" => match &op[2] {
                Value::String(text) => std::fs::write(arg(1), text),
                bytes => std::fs::write(arg(1), raw_bytes(bytes)),
            }
            .is_ok(),
            "rm" => {
                let p = std::path::Path::new(arg(1));
                match std::fs::symlink_metadata(p) {
                    Ok(m) if m.is_dir() => std::fs::remove_dir_all(p).is_ok(),
                    Ok(_) => std::fs::remove_file(p).is_ok(),
                    Err(_) => true,
                }
            }
            "mkdir" => std::fs::create_dir_all(arg(1)).is_ok(),
            #[cfg(unix)]
            "chmod" => {
                use std::os::unix::fs::PermissionsExt;
                let mode = op[2].as_u64().unwrap_or(0o644) as u32;
                std::fs::set_permissions(arg(1), std::fs::Permissions::from_mode(mode)).is_ok()
            }
            _ => false,
        };
        if !ok {
            fail(&format!("$fs failed: {op}"));
        }
    }

    /// A scripted turn: a step array or `{steps, result}`.
    fn run_turn(&mut self, turn: &Value) {
        let (steps, result) = match turn {
            Value::Array(steps) => (steps.clone(), Value::Null),
            t => (
                t["steps"].as_array().cloned().unwrap_or_default(),
                t.get("result").cloned().unwrap_or(Value::Null),
            ),
        };
        self.last_text.clear();
        self.run_steps(&steps);
        match self.subst(&result) {
            Value::Bool(false) => {}
            Value::String(s) => {
                let r = self.result_msg(&s);
                self.emit_message(r);
            }
            Value::Object(over) => {
                let mut r = self.result_msg(&self.last_text);
                merge(&mut r, &over);
                self.emit_message(r);
            }
            _ => {
                let r = self.result_msg(&self.last_text);
                self.emit_message(r);
            }
        }
    }

    fn log_control(&mut self, msg: &Value) {
        if let Some(f) = &mut self.control_log {
            append_line(f, &msg.to_string());
        }
    }

    /// Canned response for a host→CLI control request when no script entry
    /// overrides it.
    fn default_response(&mut self, req: &Value) -> Value {
        let commands = json!([{"name": "clear", "description": "Clear"}]);
        match req["subtype"].as_str().unwrap_or_default() {
            "initialize" => {
                self.sdk_servers = req["sdkMcpServers"]
                    .as_array()
                    .map(|a| {
                        a.iter()
                            .filter_map(|s| s.as_str().map(str::to_owned))
                            .collect()
                    })
                    .unwrap_or_default();
                if let Some(h) = req["hooks"].as_object() {
                    for (event, matchers) in h {
                        for m in matchers.as_array().into_iter().flatten() {
                            for id in m["hookCallbackIds"].as_array().into_iter().flatten() {
                                let id = id.as_str().unwrap_or_default().to_owned();
                                self.hook_ids.push(id.clone());
                                self.hook_ids_by_event
                                    .entry(event.clone())
                                    .or_default()
                                    .push(id);
                            }
                        }
                    }
                }
                let mut init = json!({
                    "type": "system", "subtype": "init", "cwd": std::env::current_dir().unwrap(),
                    "session_id": self.session_id, "model": self.model, "permissionMode": self.mode,
                    "tools": ["Bash", "Read"], "mcp_servers": [], "slash_commands": ["clear", "compact"],
                    "apiKeySource": "none", "uuid": uuid::Uuid::new_v4().to_string(),
                });
                merge(&mut init, &self.script.init);
                self.emit_message(init);
                let mut resp = json!({"commands": commands, "models": [{"value": "fake-model"}],
                                      "agents": [], "account": {"email": "fake@example.com"}});
                merge(&mut resp, &self.script.initialize);
                resp
            }
            "set_permission_mode" => {
                self.mode = req["mode"].as_str().unwrap_or("default").to_owned();
                json!({})
            }
            "set_model" => {
                if let Some(m) = req["model"].as_str() {
                    self.model = m.to_owned();
                }
                json!({})
            }
            "apply_flag_settings" => {
                if let Some(s) = req["settings"].as_object() {
                    for (k, v) in s {
                        self.flag_settings.insert(k.clone(), v.clone());
                    }
                }
                json!({})
            }
            "get_settings" => json!({
                "effective": self.flag_settings,
                "applied": {"model": self.model,
                            "effort": self.flag_settings.get("effortLevel").cloned().unwrap_or(Value::Null)},
            }),
            "interrupt" => json!({"still_queued": []}),
            "mcp_status" => json!({"mcpServers": []}),
            "mcp_set_servers" => {
                let next: BTreeSet<String> = req["servers"]
                    .as_object()
                    .map(|o| o.keys().cloned().collect())
                    .unwrap_or_default();
                let added: Vec<_> = next.difference(&self.dynamic_mcp).cloned().collect();
                let removed: Vec<_> = self.dynamic_mcp.difference(&next).cloned().collect();
                self.dynamic_mcp = next;
                json!({"added": added, "removed": removed, "errors": {}})
            }
            "reload_plugins" => json!({"commands": commands, "agents": [], "plugins": [],
                                       "mcpServers": [], "error_count": 0}),
            "background_tasks" => json!({"backgrounded": true}),
            "rewind_files" => {
                json!({"canRewind": true, "filesChanged": [], "insertions": 0, "deletions": 0})
            }
            "get_usage" => json!({
                "session": {"total_cost_usd": 0.0, "total_api_duration_ms": 0, "total_duration_ms": 0,
                            "total_lines_added": 0, "total_lines_removed": 0, "model_usage": {}},
                "subscription_type": null, "rate_limits_available": false, "rate_limits": {},
            }),
            // seed_read_state, update_settings, submit_feedback, stop_task,
            // set_max_thinking_tokens, mcp_toggle/reconnect, …: ack.
            _ => json!({}),
        }
    }

    /// The script's `control.<subtype>` entry; a `$sequence` hands out its
    /// entries in turn, the last one repeating (an empty one: no entry).
    fn control_entry(&mut self, subtype: &str) -> Option<Value> {
        let entry = self.script.control.get_mut(subtype)?;
        let Some(seq) = entry.get_mut("$sequence").and_then(Value::as_array_mut) else {
            return Some(entry.clone());
        };
        if seq.len() > 1 {
            Some(seq.remove(0))
        } else {
            seq.first().cloned()
        }
    }

    fn on_control_request(&mut self, msg: &Value) {
        self.log_control(msg);
        let id = msg["request_id"].clone();
        let req = &msg["request"];
        let subtype = req["subtype"].as_str().unwrap_or_default().to_owned();
        // The default handler also updates state (mode, model, flag
        // settings, initialize bookkeeping), so it always runs.
        let default = self.default_response(req);
        let entry = self.control_entry(&subtype);
        let directive = entry.as_ref().and_then(Value::as_object).filter(|o| {
            [
                "$error",
                "$response",
                "$emit",
                "$no_reply",
                "$before",
                "$envelope",
                "$same_write",
            ]
            .iter()
            .any(|k| o.contains_key(*k))
        });
        if let Some(ms) = directive
            .and_then(|o| o.get("$delay_ms"))
            .and_then(Value::as_u64)
        {
            std::thread::sleep(std::time::Duration::from_millis(ms));
        }
        if let Some(before) = directive
            .and_then(|o| o.get("$before"))
            .and_then(Value::as_array)
        {
            self.run_steps(before);
        }
        let envelope = directive
            .and_then(|o| o.get("$envelope"))
            .and_then(Value::as_object)
            .cloned()
            .unwrap_or_default();
        let same_write: Vec<Value> = directive
            .and_then(|o| o.get("$same_write"))
            .and_then(Value::as_array)
            .cloned()
            .unwrap_or_default();
        if directive.is_some_and(|o| o.get("$no_reply") == Some(&Value::Bool(true))) {
            // Left unanswered.
        } else if let Some(err) = directive.and_then(|o| o.get("$error")) {
            let err = err.as_str().map_or_else(|| err.to_string(), str::to_owned);
            let mut reply = json!({"subtype": "error", "request_id": id, "error": err});
            merge(&mut reply, &envelope);
            let mut lines = vec![json!({"type": "control_response", "response": reply})];
            lines.extend(same_write);
            self.io.emit_all(&lines);
        } else {
            let response = match (directive, entry.as_ref()) {
                (Some(o), _) => o.get("$response").map(|r| self.subst(r)).unwrap_or(default),
                (None, Some(literal)) => self.subst(literal),
                (None, None) => default,
            };
            let mut reply = json!({"subtype": "success", "request_id": id, "response": response});
            merge(&mut reply, &envelope);
            let mut lines = vec![json!({"type": "control_response", "response": reply})];
            lines.extend(same_write);
            self.io.emit_all(&lines);
        }
        if subtype == "initialize" {
            let steps = std::mem::take(&mut self.script.on_init);
            self.run_steps(&steps);
        }
        if let Some(emit) = directive
            .and_then(|o| o.get("$emit"))
            .and_then(Value::as_array)
        {
            let emit = emit.clone();
            self.run_steps(&emit);
        }
    }

    fn on_user(&mut self, msg: &Value) {
        let text = prompt_text(msg);
        self.n += 1;
        self.prompt = text.clone();
        if let Some(turn) = text
            .split_once("script:")
            .and_then(|(_, r)| leading_json(r))
        {
            return self.run_turn(&turn);
        }
        if let Some(i) = self.script.pick(&text) {
            let turn = self.script.turns[i].clone();
            if turn["repeat"] != true {
                self.script.turns[i] = Value::Null;
            }
            return self.run_turn(&turn);
        }
        if let Some(code) = text.split("exit:").nth(1) {
            eprintln!("boom");
            std::process::exit(code.trim().parse().unwrap_or(1));
        }
        let n = self.n;
        let reply = if let Some(cmd) = text.split("tool:").nth(1) {
            let r = self.io.ask(
                &format!("cli_{n}"),
                json!({"subtype": "can_use_tool", "tool_name": "Bash", "input": {"command": cmd.trim()},
                       "tool_use_id": format!("toolu_{n}"),
                       "permission_suggestions": [{"type": "addRules", "behavior": "allow",
                           "rules": [{"toolName": "Bash", "ruleContent": format!("{}:*", cmd.trim())}],
                           "destination": "localSettings"}]}),
            );
            format!(
                "permission:{}",
                r["response"]["behavior"].as_str().unwrap_or("error")
            )
        } else if text.contains("ask:") {
            let r = self.io.ask(
                &format!("cli_{n}"),
                json!({"subtype": "can_use_tool", "tool_name": "AskUserQuestion", "tool_use_id": format!("toolu_{n}"),
                       "input": {"questions": [{"question": "Pick?", "header": "H", "multiSelect": false,
                           "options": [{"label": "A", "description": "a"}, {"label": "B", "description": "b"}]}]}}),
            );
            format!(
                "ask:{}:{}",
                r["response"]["behavior"].as_str().unwrap_or("error"),
                r["response"]["updatedInput"]["answers"]
            )
        } else if text.contains("plan:") {
            let r = self.io.ask(
                &format!("cli_{n}"),
                json!({"subtype": "can_use_tool", "tool_name": "ExitPlanMode", "tool_use_id": format!("toolu_{n}"),
                       "input": {"plan": "1. do it"}}),
            );
            format!(
                "plan:{}:{}",
                r["response"]["behavior"].as_str().unwrap_or("error"),
                r["response"]["updatedInput"]["plan"]
            )
        } else if text.contains("mcp:") && !self.sdk_servers.is_empty() {
            let server = self.sdk_servers[0].clone();
            let list = self.io.ask(
                &format!("cli_{n}_l"),
                json!({"subtype": "mcp_message", "server_name": server,
                "message": {"jsonrpc": "2.0", "id": 1, "method": "tools/list"}}),
            );
            let tool = list["response"]["mcp_response"]["result"]["tools"][0]["name"]
                .as_str()
                .unwrap_or("")
                .to_owned();
            let r = self.io.ask(&format!("cli_{n}_c"), json!({"subtype": "mcp_message", "server_name": server,
                "message": {"jsonrpc": "2.0", "id": 2, "method": "tools/call", "params": {"name": tool, "arguments": {}}}}));
            format!(
                "mcp:{}",
                r["response"]["mcp_response"]["result"]["content"][0]["text"]
                    .as_str()
                    .unwrap_or("")
            )
        } else if text.contains("hook") && !self.hook_ids.is_empty() {
            let r = self.io.ask(
                &format!("cli_{n}_h"),
                json!({"subtype": "hook_callback", "callback_id": self.hook_ids[0],
                "input": {"hook_event_name": "PostToolUse"}, "tool_use_id": "toolu_h"}),
            );
            format!("hook:{}", r["response"])
        } else {
            format!("echo:{text}")
        };
        self.assistant(&reply);
        let r = self.result_msg(&reply);
        self.emit_message(r);
    }
}

/// Append `line` and its newline to a log in ONE `write(2)`, which
/// `O_APPEND` makes atomic. `writeln!` on an unbuffered `File` makes a write
/// per formatted piece (the text, then the `\n`; a `Value`, one per token),
/// so another writer appending in between (every fake CLI a server spawns
/// shares `$FAKE_CLAUDE_LOG`; the stdin thread's `eof` and the main thread's
/// marks share `$FAKE_CLAUDE_EVENTS`) spliced its line into this one, and a
/// test lost both to a line it couldn't parse (TODO I22).
fn append_line(f: &mut std::fs::File, line: &str) {
    let mut buf = Vec::with_capacity(line.len() + 1);
    buf.extend_from_slice(line.as_bytes());
    buf.push(b'\n');
    let _ = f.write_all(&buf);
}

fn append_file(var: &str) -> Option<std::fs::File> {
    let p = std::env::var(var).ok()?;
    std::fs::OpenOptions::new()
        .create(true)
        .append(true)
        .open(p)
        .ok()
}

fn main() {
    let argv: Vec<String> = std::env::args().skip(1).collect();
    if let Ok(p) = std::env::var("FAKE_CLAUDE_ARGV") {
        let _ = std::fs::write(p, serde_json::to_string(&argv).unwrap());
    }
    if let Ok(p) = std::env::var("FAKE_CLAUDE_ENV") {
        let env: std::collections::BTreeMap<String, String> = std::env::vars().collect();
        let _ = std::fs::write(p, serde_json::to_string(&env).unwrap());
    }
    if let Ok(p) = std::env::var("FAKE_CLAUDE_PID") {
        let _ = std::fs::write(p, std::process::id().to_string());
    }
    #[cfg(unix)]
    if let Ok(p) = std::env::var("FAKE_CLAUDE_FDS") {
        // SAFETY: F_GETFD only probes whether the descriptor is open.
        let open: Vec<i32> = (3..1024)
            .filter(|&fd| unsafe { libc::fcntl(fd, libc::F_GETFD) } >= 0)
            .collect();
        let _ = std::fs::write(p, serde_json::to_string(&open).unwrap());
    }
    let flag = |prefix: &str| argv.iter().find_map(|a| a.strip_prefix(prefix));
    let script = Script::load();
    if !script.on_sigterm.is_null() {
        trap_sigterm(script.on_sigterm.clone());
    }
    let session_id = flag("--session-id=")
        .or_else(|| flag("--resume="))
        .map(str::to_owned)
        .unwrap_or_else(|| uuid::Uuid::new_v4().to_string());
    let mut fake = Fake {
        io: Io {
            lines: {
                let (tx, rx) = std::sync::mpsc::channel();
                std::thread::spawn(move || {
                    for line in std::io::stdin().lock().lines() {
                        let Ok(line) = line else { break };
                        if tx.send(line).is_err() {
                            break;
                        }
                    }
                    if let Some(mut f) = append_file("FAKE_CLAUDE_EVENTS") {
                        append_line(&mut f, &json!({"eof": true}).to_string());
                    }
                    log_time("eof");
                });
                rx
            },
            stash: VecDeque::new(),
            log: append_file("FAKE_CLAUDE_LOG"),
        },
        script,
        control_log: append_file("FAKE_CLAUDE_CONTROL_LOG"),
        events: append_file("FAKE_CLAUDE_EVENTS"),
        session_id,
        model: flag("--model=").unwrap_or("fake-model").to_owned(),
        mode: flag("--permission-mode=").unwrap_or("default").to_owned(),
        sdk_servers: vec![],
        hook_ids: vec![],
        hook_ids_by_event: Default::default(),
        flag_settings: Map::new(),
        dynamic_mcp: BTreeSet::new(),
        n: 0,
        prompt: String::new(),
        last: Value::Null,
        last_text: String::new(),
        sent: Vec::new(),
    };

    while let Some(msg) = fake.io.read() {
        match msg["type"].as_str() {
            Some("control_request") => fake.on_control_request(&msg),
            Some("control_cancel_request") => fake.log_control(&msg),
            Some("user") => fake.on_user(&msg),
            _ => {}
        }
    }
    let steps = std::mem::take(&mut fake.script.on_eof);
    fake.run_steps(&steps);
}
