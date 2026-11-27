//! [`FixtureTranscripts`]: a [`TranscriptSource`] over recorded event logs.
//! Each session's log is replayed through `claudius_client::apply` (as the
//! SSE handler feeds it, `ChatState::on_message`), with a [`FixedEnv`]
//! whose clock is each event's recorded time. A streaming session keeps
//! the rest of its log back and applies it one event at a time
//! ([`FixtureTranscripts::advance`], or a player thread when the app runs).

use std::collections::HashMap;
use std::sync::{Arc, Mutex, Weak};
use std::time::Duration;

use claudius_client::FixedEnv;
use claudius_client::state::ChatState;
use futures::channel::mpsc::{UnboundedReceiver, UnboundedSender, unbounded};
use serde_json::Value;

use crate::script;
use crate::source::{TranscriptChange, TranscriptSource};

/// One recorded SSE message: when it arrived and its `data`.
#[derive(Clone, Debug, PartialEq)]
pub struct EventLine {
    pub at: f64,
    pub data: String,
}

/// Parses a JSONL log of `{"at": ms, "data": "<SSE data>"}` lines; blank
/// lines are skipped.
pub fn parse_log(text: &str) -> Vec<EventLine> {
    text.lines()
        .filter(|l| !l.trim().is_empty())
        .map(|l| {
            let v: Value = serde_json::from_str(l).expect("a fixture log line is JSON");
            EventLine {
                at: v["at"].as_f64().unwrap_or(0.0),
                data: v["data"].as_str().expect("a log line has data").to_owned(),
            }
        })
        .collect()
}

fn apply(state: &mut ChatState, env: &mut FixedEnv, line: &EventLine) {
    env.now = line.at;
    // Effects (fetches, timers) go unanswered: a replay has no server.
    let _ = state.on_message(&line.data, env);
}

/// The state a fresh mount of tab `tab_id` reaches after `lines`.
pub fn replay(tab_id: &str, lines: &[EventLine]) -> ChatState {
    let mut state = ChatState::new(tab_id);
    let mut env = FixedEnv::new(lines.first().map_or(0.0, |l| l.at));
    for line in lines {
        apply(&mut state, &mut env, line);
    }
    state
}

struct Session {
    base: (ChatState, FixedEnv),
    state: ChatState,
    env: FixedEnv,
    stream: Vec<EventLine>,
    next: usize,
}

/// Recorded sessions by id, with change notifications.
#[derive(Default)]
pub struct FixtureTranscripts {
    sessions: Mutex<HashMap<String, Session>>,
    subscribers: Mutex<Vec<UnboundedSender<TranscriptChange>>>,
}

/// The builtin shell fixture's session ids (`claudius-app`'s
/// `fixtures/shell.json`) and the log each one shows.
pub mod ids {
    /// W1's active tab, "Port the app shell to GPUI": [`super::script::demo`], streaming.
    pub const DEMO: &str = "3e9a7c41-0b2d-4e8f-8c6a-1d2e3f405162";
    pub const COMPACTION: &str = "8c1f0b2e-5d4a-4f7e-9a61-2b3c4d5e6f70";
    pub const BUBBLES: &str = "b7d24f19-6c3e-4a5b-9d8e-7f6a5b4c3d2e";
    /// The spike's synthetic long transcript.
    pub const LONG: &str = "51c0e8a3-9f7b-4d2c-a1e6-0b9c8d7e6f5a";
    pub const HOOKS: &str = "e2a96d07-4b1c-4f3e-8d5a-6c7b8a9f0e1d";
    pub const PILLS: &str = "0f4b8c2a-7e6d-4c5b-9a3f-2e1d0c9b8a7f";
    /// W2's active tab.
    pub const STREAMED: &str = "a4c3e2f1-8b7a-4d6c-9e5f-3a2b1c0d9e8f";
    pub const TOOLS: &str = "c6e5d4f3-2a1b-4c0d-8e9f-7a6b5c4d3e2f";
    /// Every kind of tool card, finished ([`super::script::tool_cards`]);
    /// not in the shell fixture.
    pub const CARDS: &str = "d1c2b3a4-5e6f-4a7b-8c9d-0e1f2a3b4c5d";
    /// The same turn with a Bash still running.
    pub const CARDS_RUNNING: &str = "e5f4d3c2-b1a0-4f9e-8d7c-6b5a4f3e2d1c";
}

/// The card sessions' workspace root.
pub const CARDS_ROOT: &str = "/Users/demo/Projects/claudius";

/// claudius-client's recorded scenarios, one log each.
pub mod golden {
    pub const HOOKS: &str = include_str!("../fixtures/golden-hooks.jsonl");
    pub const PILLS: &str = include_str!("../fixtures/golden-pills.jsonl");
    pub const BUBBLES: &str = include_str!("../fixtures/golden-bubbles.jsonl");
    pub const STREAMED: &str = include_str!("../fixtures/golden-streamed.jsonl");
    pub const TOOLS: &str = include_str!("../fixtures/golden-tools.jsonl");
    pub const COMPACTION: &str = include_str!("../fixtures/golden-compaction.jsonl");
}

/// The demo's clock: 2026-11-26T09:00:00Z.
pub const DEMO_START_MS: f64 = 1_795_683_600_000.0;

impl FixtureTranscripts {
    pub fn new() -> Self {
        Self::default()
    }

    /// The builtin shell fixture's sessions (see [`ids`]).
    pub fn builtin() -> Arc<Self> {
        let me = Self::new();
        let (history, stream) = script::demo(ids::DEMO, DEMO_START_MS, 60.0);
        me.insert_streaming(ids::DEMO, &history, stream);
        me.insert(
            ids::LONG,
            &script::synthetic(ids::LONG, 4400, DEMO_START_MS),
        );
        for (id, running) in [(ids::CARDS, false), (ids::CARDS_RUNNING, true)] {
            me.insert(
                id,
                &script::tool_cards(id, DEMO_START_MS, CARDS_ROOT, running),
            );
        }
        for (id, log) in [
            (ids::COMPACTION, golden::COMPACTION),
            (ids::BUBBLES, golden::BUBBLES),
            (ids::HOOKS, golden::HOOKS),
            (ids::PILLS, golden::PILLS),
            (ids::STREAMED, golden::STREAMED),
            (ids::TOOLS, golden::TOOLS),
        ] {
            me.insert(id, &parse_log(log));
        }
        Arc::new(me)
    }

    /// Adds (or replaces) a session at the end of `lines`.
    pub fn insert(&self, id: &str, lines: &[EventLine]) {
        self.insert_streaming(id, lines, Vec::new());
    }

    /// Adds a session at the end of `history`, with `stream` held back for
    /// [`Self::advance`].
    pub fn insert_streaming(&self, id: &str, history: &[EventLine], stream: Vec<EventLine>) {
        let mut state = ChatState::new(id);
        let mut env = FixedEnv::new(history.first().map_or(0.0, |l| l.at));
        for line in history {
            apply(&mut state, &mut env, line);
        }
        let session = Session {
            base: (state.clone(), env.clone()),
            state,
            env,
            stream,
            next: 0,
        };
        self.sessions.lock().unwrap().insert(id.to_owned(), session);
        self.notify(id);
    }

    /// Applies the session's next held-back event; whether there was one.
    pub fn advance(&self, id: &str) -> bool {
        let moved = {
            let mut sessions = self.sessions.lock().unwrap();
            match sessions.get_mut(id) {
                Some(s) if s.next < s.stream.len() => {
                    let line = s.stream[s.next].clone();
                    apply(&mut s.state, &mut s.env, &line);
                    s.next += 1;
                    true
                }
                _ => false,
            }
        };
        if moved {
            self.notify(id);
        }
        moved
    }

    /// Events still held back.
    pub fn remaining(&self, id: &str) -> usize {
        let sessions = self.sessions.lock().unwrap();
        sessions.get(id).map_or(0, |s| s.stream.len() - s.next)
    }

    /// Back to the end of the history, the stream held back again.
    pub fn restart(&self, id: &str) {
        let restarted = {
            let mut sessions = self.sessions.lock().unwrap();
            match sessions.get_mut(id) {
                Some(s) => {
                    (s.state, s.env) = s.base.clone();
                    s.next = 0;
                    true
                }
                None => false,
            }
        };
        if restarted {
            self.notify(id);
        }
    }

    fn streaming_ids(&self) -> Vec<String> {
        let sessions = self.sessions.lock().unwrap();
        let mut ids: Vec<String> = sessions
            .iter()
            .filter(|(_, s)| !s.stream.is_empty())
            .map(|(id, _)| id.clone())
            .collect();
        ids.sort();
        ids
    }

    /// Plays every streaming session: one event each `every`, then a
    /// `pause` at the end, then from the start again. The thread ends once
    /// the source is dropped.
    pub fn spawn_player(
        self: &Arc<Self>,
        every: Duration,
        pause: Duration,
    ) -> std::thread::JoinHandle<()> {
        let weak: Weak<Self> = Arc::downgrade(self);
        std::thread::Builder::new()
            .name("transcript-fixture-player".into())
            .spawn(move || {
                loop {
                    std::thread::sleep(every);
                    let Some(me) = weak.upgrade() else { return };
                    for id in me.streaming_ids() {
                        if !me.advance(&id) {
                            drop(me);
                            std::thread::sleep(pause);
                            let Some(me) = weak.upgrade() else { return };
                            me.restart(&id);
                            break;
                        }
                    }
                }
            })
            .expect("spawn the fixture player")
    }

    fn notify(&self, id: &str) {
        let change = TranscriptChange {
            session_id: id.to_owned(),
        };
        self.subscribers
            .lock()
            .unwrap()
            .retain(|tx| tx.unbounded_send(change.clone()).is_ok());
    }
}

impl TranscriptSource for FixtureTranscripts {
    fn read(&self, session_id: &str, f: &mut dyn FnMut(&ChatState)) -> bool {
        let sessions = self.sessions.lock().unwrap();
        match sessions.get(session_id) {
            Some(s) => {
                f(&s.state);
                true
            }
            None => false,
        }
    }

    fn subscribe(&self) -> UnboundedReceiver<TranscriptChange> {
        let (tx, rx) = unbounded();
        self.subscribers.lock().unwrap().push(tx);
        rx
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::rows::{Row, ViewOptions, rows};

    fn read_rows(src: &FixtureTranscripts, id: &str) -> Vec<Row> {
        let mut out = Vec::new();
        assert!(src.read(id, &mut |s| out = rows(s, &ViewOptions::default()).rows));
        out
    }

    #[test]
    fn every_golden_log_replays_to_rows() {
        let src = FixtureTranscripts::builtin();
        for id in [
            ids::COMPACTION,
            ids::BUBBLES,
            ids::HOOKS,
            ids::PILLS,
            ids::STREAMED,
            ids::TOOLS,
            ids::CARDS,
            ids::CARDS_RUNNING,
            ids::DEMO,
            ids::LONG,
        ] {
            assert!(!read_rows(&src, id).is_empty(), "{id} has rows");
        }
        assert!(!src.read("nope", &mut |_| {}));
    }

    #[test]
    fn the_long_session_has_thousands_of_rows() {
        let src = FixtureTranscripts::builtin();
        let n = read_rows(&src, ids::LONG).len();
        assert!(n > 1900, "{n} rows");
    }

    #[test]
    fn advancing_streams_the_reply_and_restart_rewinds_it() {
        let src = FixtureTranscripts::builtin();
        let mut changes = src.subscribe();
        let before = read_rows(&src, ids::DEMO);
        assert!(matches!(before.last(), Some(Row::Working { .. })));
        let total = src.remaining(ids::DEMO);
        assert!(total > 20);
        for _ in 0..10 {
            assert!(src.advance(ids::DEMO));
        }
        assert_eq!(src.remaining(ids::DEMO), total - 10);
        let mid = read_rows(&src, ids::DEMO);
        let live = mid
            .iter()
            .any(|r| matches!(r, Row::Assistant(a) if a.streaming_live));
        assert!(live, "a live bubble mid-stream");
        while src.advance(ids::DEMO) {}
        assert!(!src.advance(ids::DEMO));
        let done = read_rows(&src, ids::DEMO);
        assert!(!done.iter().any(|r| matches!(r, Row::Working { .. })));
        src.restart(ids::DEMO);
        assert_eq!(read_rows(&src, ids::DEMO), before);
        assert_eq!(src.remaining(ids::DEMO), total);
        let mut n = 0;
        while let Ok(c) = changes.try_recv() {
            assert_eq!(c.session_id, ids::DEMO);
            n += 1;
        }
        assert_eq!(n, total + 1);
    }

    #[test]
    fn a_dropped_subscriber_is_forgotten() {
        let src = FixtureTranscripts::builtin();
        drop(src.subscribe());
        src.advance(ids::DEMO);
        assert!(src.subscribers.lock().unwrap().is_empty());
    }

    #[test]
    fn parse_log_skips_blank_lines() {
        let lines = parse_log("{\"at\":5,\"data\":\"{}\"}\n\n");
        assert_eq!(
            lines,
            [EventLine {
                at: 5.0,
                data: "{}".into()
            }]
        );
    }
}
