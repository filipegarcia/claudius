//! [`FixtureComposer`]: a [`ComposerTarget`] over claudius-chat's
//! `FixtureTranscripts`, standing in for the server the way the bundled
//! transcripts stand in for its sessions.
//!
//! Each session keeps its event log here (the builtin ones as
//! `FixtureTranscripts::builtin` built them). A `send` appends the user
//! prompt and `turn_status: running`, then a scripted reply in a few
//! batches, each written back with `FixtureTranscripts::insert` (a
//! replay), so the transcript and the composer read the same `ChatState`
//! the real reducer builds. A send while a reply plays is queued as the
//! server queues it (`queue:updated`), and the queue's actions edit that
//! list; a turn's end starts the next queued prompt. The composer's own
//! requests (the draft row, the prompt color, `!` bash) answer from memory,
//! and so do the pickers' (U07b): the SDK's command list, the agents, the
//! `@` file search over a canned tree, and the emoji setting.
//!
//! With `autoplay`, a thread plays each reply (one batch per tick);
//! without it, [`FixtureComposer::advance`] steps it (the tests).

use std::collections::{HashMap, VecDeque};
use std::sync::{Arc, Mutex, Weak};
use std::time::Duration;

use claudius_chat::fixture::{
    DEMO_START_MS, EventLine, FixtureTranscripts, golden, ids, parse_log,
};
use claudius_chat::script::{self, Script, word_chunks};
use claudius_chat::source::{TranscriptChange, TranscriptSource};
use claudius_client::effect::{FetchOutcome, FetchRequest};
use claudius_client::state::ChatState;
use futures::channel::mpsc::UnboundedReceiver;
use futures::channel::oneshot;
use serde_json::{Value, json};

use crate::target::{ComposerTarget, SessionCall, closed};

/// Reply batches per turn (each is one replay of the session's log).
const BATCHES: usize = 8;

#[derive(Default)]
struct Fx {
    log: Vec<EventLine>,
    /// The clock of the last event.
    at: f64,
    /// Unique ids for what this fixture adds.
    n: u64,
    /// Queued prompts: uuid and text.
    queue: Vec<(String, String)>,
    /// The playing reply, still held back.
    batches: VecDeque<Vec<EventLine>>,
    running: bool,
}

struct Inner {
    sessions: HashMap<String, Fx>,
    drafts: HashMap<String, Value>,
    colors: HashMap<String, String>,
    /// `GET /api/sessions/<id>/commands`' `commands` (any session).
    commands: Value,
    /// `GET /api/sessions/<id>/agents`' `agents`.
    agents: Value,
    /// The `@` search's tree: `(relPath, is a folder)`.
    files: Vec<(String, bool)>,
    /// A failed search's answer: status and `error`.
    fs_failure: Option<(u16, String)>,
    /// The user-scope `emojiCompletionEnabled`.
    emoji_completion: Option<bool>,
    /// Every request the fixture answered (method, url, body), for tests.
    requests: Vec<(String, String, Option<String>)>,
}

impl Default for Inner {
    fn default() -> Self {
        Inner {
            sessions: HashMap::new(),
            drafts: HashMap::new(),
            colors: HashMap::new(),
            commands: demo_commands(),
            agents: demo_agents(),
            files: DEMO_FILES
                .iter()
                .map(|(p, d)| ((*p).to_owned(), *d))
                .collect(),
            fs_failure: None,
            emoji_completion: None,
            requests: Vec::new(),
        }
    }
}

/// What the demo's `supportedCommands()` adds to the registry: a project
/// command, a plugin's, and an SDK built-in.
fn demo_commands() -> Value {
    json!([
        {"name": "deploy", "description": "Ship the current branch to staging or production.",
         "argumentHint": "<staging|production>"},
        {"name": "release-notes-draft", "description": "Draft release notes from the merged PRs.",
         "argumentHint": "[since-tag]"},
        {"name": "lint:fix", "description": "Run the linters and apply their fixes (plugin)."},
        {"name": "compact", "description": "Compact the conversation.", "builtin": true},
    ])
}

/// The demo session's `supportedAgents()`.
fn demo_agents() -> Value {
    json!([
        {"name": "general-purpose", "description": "General-purpose agent for multi-step tasks.",
         "model": "inherit"},
        {"name": "Explore", "description": "Read-only search agent for broad fan-out searches.",
         "model": "haiku"},
        {"name": "code-reviewer", "description": "Independent review of the current diff.",
         "model": "sonnet"},
        {"name": "docs-writer", "description": "Drafts README and CHANGELOG updates."},
    ])
}

/// A fresh session's folder.
pub const DEMO_CWD: &str = "/demo/claudius";

/// The `@` search's demo tree.
const DEMO_FILES: &[(&str, bool)] = &[
    ("README.md", false),
    ("rust", true),
    ("rust/app", true),
    ("rust/app/crates/claudius-composer/src/model.rs", false),
    ("rust/app/crates/claudius-composer/src/view.rs", false),
    ("rust/app/crates/claudius-composer/src/slash.rs", false),
    ("rust/app/crates/claudius-composer/src/mention.rs", false),
    ("rust/app/crates/claudius-composer/src/emoji.rs", false),
    ("rust/crates/claudius-server/src/fs_routes.rs", false),
    ("components/chat/PromptInput.tsx", false),
    ("components/chat/SlashCommandPicker.tsx", false),
    ("components/chat/AtMentionPicker.tsx", false),
    ("lib/shared/slash-commands.ts", false),
    ("package.json", false),
];

/// `URLSearchParams.get(name)` on a query string.
fn search_param(query: &str, name: &str) -> Option<String> {
    query.split('&').find_map(|pair| {
        let (k, v) = pair.split_once('=').unwrap_or((pair, ""));
        (k == name).then(|| form_decode(v))
    })
}

fn form_decode(s: &str) -> String {
    let b = s.as_bytes();
    let mut out = Vec::with_capacity(b.len());
    let mut i = 0;
    while i < b.len() {
        let hex = (b[i] == b'%')
            .then(|| s.get(i + 1..i + 3))
            .flatten()
            .and_then(|h| u8::from_str_radix(h, 16).ok());
        match (b[i], hex) {
            (b'+', _) => out.push(b' '),
            (_, Some(v)) => {
                out.push(v);
                i += 2;
            }
            (c, None) => out.push(c),
        }
        i += 1;
    }
    String::from_utf8_lossy(&out).into_owned()
}

/// The fixture "server" behind the native composer.
pub struct FixtureComposer {
    transcripts: Arc<FixtureTranscripts>,
    inner: Mutex<Inner>,
    autoplay: Option<Duration>,
    me: Weak<FixtureComposer>,
}

/// Makes the ids of lines a fresh `Script` wrote unique (`Script` numbers
/// its uuids from 1).
fn uniquify(lines: Vec<EventLine>, tag: &str) -> Vec<EventLine> {
    lines
        .into_iter()
        .map(|l| {
            let mut v: Value = serde_json::from_str(&l.data).expect("a script line is JSON");
            if let Some(Value::String(u)) = v.pointer_mut("/message/uuid") {
                u.push('-');
                u.push_str(tag);
            }
            EventLine {
                at: l.at,
                data: v.to_string(),
            }
        })
        .collect()
}

fn reply_text(prompt: &str) -> String {
    let short: String = prompt.chars().take(80).collect();
    let more = if prompt.chars().count() > 80 {
        "\u{2026}"
    } else {
        ""
    };
    format!(
        "This is the offline demo, so no model saw that. You asked: \u{201c}{short}{more}\u{201d}\n\nThe composer, the queue strip and this transcript are the real ones: send another prompt while this reply streams and it queues above the box, where you can edit, move or send it now."
    )
}

fn ok_json(v: Value) -> FetchOutcome {
    FetchOutcome::Response {
        status: 200,
        body: v.to_string(),
    }
}

impl FixtureComposer {
    /// An empty fixture over `transcripts`.
    pub fn new(transcripts: Arc<FixtureTranscripts>, autoplay: Option<Duration>) -> Arc<Self> {
        Arc::new_cyclic(|me| FixtureComposer {
            transcripts,
            inner: Mutex::new(Inner::default()),
            autoplay,
            me: me.clone(),
        })
    }

    /// Over `FixtureTranscripts::builtin()`'s sessions, with their logs.
    pub fn builtin(transcripts: Arc<FixtureTranscripts>, autoplay: Option<Duration>) -> Arc<Self> {
        let me = Self::new(transcripts, autoplay);
        let (history, stream) = script::demo(ids::DEMO, DEMO_START_MS, 60.0);
        let mut demo = history;
        demo.extend(stream);
        me.seed(ids::DEMO, demo);
        me.seed(ids::LONG, script::synthetic(ids::LONG, 4400, DEMO_START_MS));
        for (id, log) in [
            (ids::COMPACTION, golden::COMPACTION),
            (ids::BUBBLES, golden::BUBBLES),
            (ids::HOOKS, golden::HOOKS),
            (ids::PILLS, golden::PILLS),
            (ids::STREAMED, golden::STREAMED),
            (ids::TOOLS, golden::TOOLS),
        ] {
            me.seed(id, parse_log(log));
        }
        me
    }

    /// Records the log `transcripts` already shows for `id` (nothing is
    /// written back until the session changes).
    pub fn seed(&self, id: &str, log: Vec<EventLine>) {
        let at = log.last().map_or(DEMO_START_MS, |l| l.at);
        let fx = Fx {
            log,
            at,
            ..Fx::default()
        };
        self.inner
            .lock()
            .unwrap()
            .sessions
            .insert(id.to_owned(), fx);
    }

    /// The transcripts this fixture writes to.
    pub fn transcripts(&self) -> &Arc<FixtureTranscripts> {
        &self.transcripts
    }

    /// The requests answered so far (method, url, body).
    pub fn requests(&self) -> Vec<(String, String, Option<String>)> {
        self.inner.lock().unwrap().requests.clone()
    }

    /// A session's stored draft row.
    pub fn draft(&self, id: &str) -> Option<Value> {
        self.inner.lock().unwrap().drafts.get(id).cloned()
    }

    /// Sets a session's stored prompt color (`/color`'s POST).
    pub fn set_color(&self, id: &str, name: &str) {
        let mut inner = self.inner.lock().unwrap();
        inner.colors.insert(id.to_owned(), name.to_owned());
    }

    /// What `GET /api/sessions/<id>/commands` answers (`commands`).
    pub fn set_sdk_commands(&self, commands: Value) {
        self.inner.lock().unwrap().commands = commands;
    }

    /// What `GET /api/sessions/<id>/agents` answers (`agents`).
    pub fn set_agents(&self, agents: Value) {
        self.inner.lock().unwrap().agents = agents;
    }

    /// The `@` search's tree: `(relPath, is a folder)`.
    pub fn set_files(&self, files: &[(&str, bool)]) {
        self.inner.lock().unwrap().files =
            files.iter().map(|(p, d)| ((*p).to_owned(), *d)).collect();
    }

    /// Makes the `@` search fail with `status` and `{ error }` (`None`:
    /// answer again).
    pub fn fail_file_search(&self, failure: Option<(u16, &str)>) {
        self.inner.lock().unwrap().fs_failure = failure.map(|(s, e)| (s, e.to_owned()));
    }

    /// The user-scope `emojiCompletionEnabled` (`None`: unset).
    pub fn set_emoji_completion(&self, on: Option<bool>) {
        self.inner.lock().unwrap().emoji_completion = on;
    }

    /// Whether a reply is playing (or queued prompts wait) in `id`.
    pub fn busy(&self, id: &str) -> bool {
        let inner = self.inner.lock().unwrap();
        inner
            .sessions
            .get(id)
            .is_some_and(|fx| fx.running || !fx.queue.is_empty())
    }

    fn fx<'a>(inner: &'a mut Inner, id: &str) -> &'a mut Fx {
        inner.sessions.entry(id.to_owned()).or_insert_with(|| Fx {
            at: DEMO_START_MS,
            ..Fx::default()
        })
    }

    /// Appends what a `Script` writes after the session's clock.
    fn append(fx: &mut Fx, id: &str, f: impl FnOnce(&mut Script)) {
        fx.n += 1;
        let mut s = Script::new(id, fx.at);
        if fx.log.is_empty() {
            s.ready().replay_done();
        }
        f(&mut s);
        let lines = uniquify(s.lines(), &format!("fx{}", fx.n));
        if let Some(last) = lines.last() {
            fx.at = last.at;
        }
        fx.log.extend(lines);
    }

    fn queue_event(fx: &mut Fx, id: &str) {
        let rows: Vec<Value> = fx
            .queue
            .iter()
            .map(|(u, t)| json!({"uuid": u, "text": t}))
            .collect();
        Self::append(fx, id, |s| {
            s.event(json!({"type": "queue:updated", "queue": rows, "sdkQueuedTurns": 0}));
        });
    }

    /// The prompt and `running`, with the reply held back in batches.
    fn start_turn(fx: &mut Fx, id: &str, text: &str) {
        Self::append(fx, id, |s| {
            s.user(text).running(true);
        });
        fx.n += 1;
        let tag = format!("fx{}", fx.n);
        let mut s = Script::new(id, fx.at);
        let msg = format!("msg_{tag}");
        s.stream(&msg, &word_chunks(&reply_text(text)), 40.0);
        s.result();
        for p in ["What does Ctrl+Enter do?", "Show me the queue strip"] {
            s.event(
                json!({"type": "sdk", "message": {"type": "prompt_suggestion", "suggestion": p,
                "session_id": id, "uuid": format!("sg-{tag}-{}", p.len())}}),
            );
        }
        s.running(false);
        let lines = uniquify(s.lines(), &tag);
        let per = lines.len().div_ceil(BATCHES).max(1);
        fx.batches = lines.chunks(per).map(<[EventLine]>::to_vec).collect();
        fx.running = true;
    }

    /// Ends the turn: the next queued prompt starts, or the session idles.
    fn turn_over(fx: &mut Fx, id: &str) {
        fx.running = false;
        if !fx.queue.is_empty() {
            let (_, text) = fx.queue.remove(0);
            Self::queue_event(fx, id);
            Self::start_turn(fx, id, &text);
        }
    }

    /// Writes the log back (the transcripts notify their subscribers,
    /// the composer among them).
    fn publish(&self, id: &str, log: &[EventLine]) {
        self.transcripts.insert(id, log);
    }

    /// Plays the next batch of `id`'s reply (or starts its next queued
    /// prompt); whether anything moved.
    pub fn advance(&self, id: &str) -> bool {
        let log = {
            let mut inner = self.inner.lock().unwrap();
            let Some(fx) = inner.sessions.get_mut(id) else {
                return false;
            };
            if !fx.running {
                return false;
            }
            match fx.batches.pop_front() {
                Some(batch) => {
                    if let Some(last) = batch.last() {
                        fx.at = last.at;
                    }
                    fx.log.extend(batch);
                    if fx.batches.is_empty() {
                        Self::turn_over(fx, id);
                    }
                }
                None => Self::turn_over(fx, id),
            }
            fx.log.clone()
        };
        self.publish(id, &log);
        true
    }

    /// Plays `id` to the end (the tests).
    pub fn finish(&self, id: &str) {
        while self.advance(id) {}
    }

    fn play(&self, id: &str) {
        let Some(every) = self.autoplay else { return };
        let weak = self.me.clone();
        let id = id.to_owned();
        std::thread::Builder::new()
            .name("composer-fixture-reply".into())
            .spawn(move || {
                loop {
                    std::thread::sleep(every);
                    let Some(me) = weak.upgrade() else { return };
                    if !me.advance(&id) {
                        return;
                    }
                }
            })
            .expect("spawn the composer fixture's reply");
    }

    /// Runs a call; the promise's value.
    fn run(&self, id: &str, call: SessionCall) -> Option<Value> {
        let mut start = false;
        // A turn the transcripts play on their own (the bundled demo's).
        let mut shown_running = false;
        if call == SessionCall::Interrupt {
            self.transcripts
                .read(id, &mut |s| shown_running = s.pending);
        }
        let (log, value) = {
            let mut inner = self.inner.lock().unwrap();
            let fx = Self::fx(&mut inner, id);
            let value = match call {
                SessionCall::Send { text, .. } => {
                    if fx.running {
                        fx.n += 1;
                        fx.queue.push((format!("q-{}-{}", id, fx.n), text));
                        Self::queue_event(fx, id);
                    } else {
                        Self::start_turn(fx, id, &text);
                        start = true;
                    }
                    Some(json!({"ok": true}))
                }
                SessionCall::EditQueued { qid } => {
                    match fx.queue.iter().position(|(u, _)| *u == qid) {
                        Some(i) => {
                            let (_, text) = fx.queue.remove(i);
                            Self::queue_event(fx, id);
                            Some(json!({"text": text}))
                        }
                        None => Some(Value::Null),
                    }
                }
                SessionCall::ReorderQueued { qid, dir } => {
                    if let Some(i) = fx.queue.iter().position(|(u, _)| *u == qid) {
                        let j = if dir == -1.0 {
                            i.checked_sub(1)
                        } else {
                            Some(i + 1)
                        };
                        if let Some(j) = j.filter(|&j| j < fx.queue.len()) {
                            fx.queue.swap(i, j);
                            Self::queue_event(fx, id);
                        }
                    }
                    None
                }
                SessionCall::SendQueuedNow { qid } => {
                    if let Some(i) = fx.queue.iter().position(|(u, _)| *u == qid) {
                        let row = fx.queue.remove(i);
                        fx.queue.insert(0, row);
                        if !fx.running {
                            Self::turn_over(fx, id);
                            start = true;
                        } else {
                            Self::queue_event(fx, id);
                        }
                    }
                    None
                }
                SessionCall::SendAllQueuedNow => {
                    if !fx.queue.is_empty() {
                        let rows: Vec<(String, String)> = std::mem::take(&mut fx.queue);
                        Self::queue_event(fx, id);
                        if fx.running {
                            // They join the running turn.
                            Self::append(fx, id, |s| {
                                for (_, t) in &rows {
                                    s.user(t);
                                }
                            });
                        } else {
                            let text = rows
                                .iter()
                                .map(|(_, t)| t.as_str())
                                .collect::<Vec<_>>()
                                .join("\n\n");
                            Self::start_turn(fx, id, &text);
                            start = true;
                        }
                    }
                    None
                }
                SessionCall::CancelQueued { qid } => {
                    let before = fx.queue.len();
                    fx.queue.retain(|(u, _)| *u != qid);
                    if fx.queue.len() != before {
                        Self::queue_event(fx, id);
                    }
                    None
                }
                SessionCall::Interrupt => {
                    if fx.running {
                        fx.batches.clear();
                        Self::append(fx, id, |s| {
                            s.result().running(false);
                        });
                        Self::turn_over(fx, id);
                        start = fx.running;
                    } else if shown_running && !fx.log.is_empty() {
                        // Stops the demo's loop: its log, ended.
                        Self::append(fx, id, |s| {
                            s.result().running(false);
                        });
                    }
                    None
                }
            };
            (fx.log.clone(), value)
        };
        self.publish(id, &log);
        if start {
            self.play(id);
        }
        value
    }

    fn answer(&self, req: &FetchRequest) -> FetchOutcome {
        let mut inner = self.inner.lock().unwrap();
        inner
            .requests
            .push((req.method.to_owned(), req.url.clone(), req.body.clone()));
        if let Some(query) = req.url.strip_prefix("/api/fs/list?") {
            if let Some((status, error)) = &inner.fs_failure {
                return FetchOutcome::Response {
                    status: *status,
                    body: json!({ "error": error }).to_string(),
                };
            }
            // A case-insensitive substring of the path (the real search
            // ranks a fuzzy match).
            let q = search_param(query, "q").unwrap_or_default().to_lowercase();
            let entries: Vec<Value> = inner
                .files
                .iter()
                .filter(|(p, _)| p.to_lowercase().contains(&q))
                .map(|(p, dir)| {
                    json!({"relPath": p, "absPath": format!("/demo/{p}"),
                        "type": if *dir { "dir" } else { "file" }})
                })
                .collect();
            return ok_json(json!({ "cwd": search_param(query, "cwd"), "entries": entries }));
        }
        if req.url.starts_with("/api/settings?") {
            let mut settings = serde_json::Map::new();
            if let Some(on) = inner.emoji_completion {
                settings.insert("emojiCompletionEnabled".into(), json!(on));
            }
            return ok_json(json!({ "settings": settings }));
        }
        let parts: Vec<&str> = req.url.trim_start_matches('/').split('/').collect();
        let (id, route) = match parts.as_slice() {
            ["api", "sessions", id, route] => ((*id).to_owned(), *route),
            _ => {
                return FetchOutcome::Response {
                    status: 404,
                    body: "{}".into(),
                };
            }
        };
        let body: Value = req
            .body
            .as_deref()
            .and_then(|b| serde_json::from_str(b).ok())
            .unwrap_or(Value::Null);
        match (req.method, route) {
            ("GET", "prompt-draft") => ok_json(
                inner
                    .drafts
                    .get(&id)
                    .cloned()
                    .unwrap_or_else(|| json!({"text": "", "images": []})),
            ),
            ("PUT", "prompt-draft") => {
                let text = body.get("text").and_then(Value::as_str).unwrap_or("");
                let images = body.get("images").cloned().unwrap_or(json!([]));
                inner
                    .drafts
                    .insert(id, json!({"text": text, "images": images}));
                ok_json(json!({"ok": true}))
            }
            ("DELETE", "prompt-draft") => {
                inner.drafts.remove(&id);
                ok_json(json!({"ok": true}))
            }
            ("GET", "prompt-color") => ok_json(json!({"color": inner.colors.get(&id)})),
            ("GET", "commands") => ok_json(json!({ "commands": inner.commands })),
            ("GET", "agents") => ok_json(json!({ "agents": inner.agents })),
            ("POST", "bash") => {
                let command = body
                    .get("command")
                    .and_then(Value::as_str)
                    .unwrap_or("")
                    .to_owned();
                let stdout = "(the offline demo runs no shell)".to_owned();
                let block = format!(
                    "<bash-input>{command}</bash-input>\n<bash-stdout>{stdout}</bash-stdout><bash-stderr></bash-stderr>"
                );
                let fx = Self::fx(&mut inner, &id);
                fx.n += 1;
                let uuid = format!("bash-{}", fx.n);
                let sid = id.clone();
                Self::append(fx, &id, |s| {
                    s.event(json!({"type": "sdk", "message": {"type": "user",
                        "message": {"role": "user", "content": block}, "parent_tool_use_id": null,
                        "session_id": sid, "uuid": uuid}}));
                });
                let log = fx.log.clone();
                drop(inner);
                self.publish(&id, &log);
                ok_json(
                    json!({"uuid": uuid, "stdout": stdout, "stderr": "", "exitCode": 0,
                    "truncated": false, "timedOut": false}),
                )
            }
            _ => FetchOutcome::Response {
                status: 404,
                body: "{\"error\":\"not found\"}".into(),
            },
        }
    }
}

impl ComposerTarget for FixtureComposer {
    fn read(&self, session_id: &str, f: &mut dyn FnMut(&ChatState)) -> bool {
        if self.transcripts.read(session_id, f) {
            return true;
        }
        // A tab with no log yet: a fresh, ready session in the demo folder.
        let mut state = ChatState::new(session_id);
        state.session_id = Some(session_id.to_owned());
        state.ready = true;
        state.cwd = json!(DEMO_CWD);
        f(&state);
        true
    }

    fn subscribe(&self) -> UnboundedReceiver<TranscriptChange> {
        TranscriptSource::subscribe(&*self.transcripts)
    }

    fn call(&self, session_id: &str, call: SessionCall) -> oneshot::Receiver<Value> {
        match self.run(session_id, call) {
            Some(v) => {
                let (tx, rx) = oneshot::channel();
                let _ = tx.send(v);
                rx
            }
            None => closed(),
        }
    }

    fn fetch(&self, req: FetchRequest) -> oneshot::Receiver<FetchOutcome> {
        let (tx, rx) = oneshot::channel();
        let _ = tx.send(self.answer(&req));
        rx
    }
}
