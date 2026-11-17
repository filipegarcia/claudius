//! session.ts's calls into the notification bus (S31), queued per session
//! and run off the caller's thread.
//!
//! TS fires each `notificationBus.*` call with `void` and moves on, while the
//! bus reads workspaces.json and SQLite. Here a call goes onto the session's
//! queue, and a task on tokio's blocking pool (a thread of its own outside a
//! runtime) runs the queue, so the session lock is never held over the bus's
//! I/O and the bus sees one session's calls in the order the session made
//! them. (TS starts them in that order but interleaves them at each `await`,
//! so a prompt answered in the same tick it was raised could be marked read
//! before its row is written; here the mark-read always comes second.)
//!
//! The calls, as session.ts makes them:
//! - every `broadcast()` → [`BusFeed::record`] (`recordSessionEvent`) once the
//!   subscribers have the event, with `hasSubscribers`, the session's label
//!   (`title?.trim() || id.slice(0, 8)`) and `hasActiveBackgroundWork`;
//! - `consume()` ending with no `result`, no error broadcast and no abort →
//!   [`BusFeed::synthetic_idle`]: a bare `{type: "sdk", message: {type:
//!   "result"}}` that no subscriber sees (no `hasActiveBackgroundWork`);
//! - a prompt answered, aborted or drained → [`BusFeed::mark_read`]
//!   (`markReadByRequestId`), before its resolver runs;
//! - `sendInput` → [`BusFeed::mark_user_input`] (`markUserInput`), which the
//!   bus's idle row waits for;
//! - `start()` → [`BusFeed::sweep`] (`sweepOrphanedActionableForSession`).
//!
//! Only events the bus can act on are queued ([`may_record`]); for any other
//! one `record` just reads workspaces.json and returns.

use std::collections::VecDeque;
use std::panic::AssertUnwindSafe;
use std::sync::{Arc, Mutex};

use claudius_agent::js;
use serde_json::{Value, json};
use tokio::sync::oneshot;

use crate::log;
use crate::notification_bus::{NotificationBus, SessionEventOpts};

/// Whether the bus's `record` can do anything with `event`: write a row
/// (`mapEventToKind` maps it) or schedule a `state` flush
/// (`isStatusSyncRelevant`). A `run_finished` maps too (only `dev-broadcast`
/// sends one through a session).
pub fn may_record(event: &Value) -> bool {
    match event.get("type").and_then(Value::as_str) {
        Some(
            "turn_status"
            | "ready"
            | "error"
            | "permission_request"
            | "ask_user_question"
            | "mcp_elicitation_request"
            | "plan_approval_request"
            | "run_finished",
        ) => true,
        Some("sdk") => {
            js::prop(event.get("message"), "type").and_then(Value::as_str) == Some("result")
        }
        _ => false,
    }
}

/// `this.title?.trim() || this.id.slice(0, 8)`: the inbox's name for the
/// session.
pub fn session_label(title: Option<&str>, id: &str) -> String {
    match title.map(js::trim).filter(|t| !t.is_empty()) {
        Some(t) => t.to_owned(),
        None => String::from_utf16_lossy(&id.encode_utf16().take(8).collect::<Vec<_>>()),
    }
}

enum Call {
    Record(Value, SessionEventOpts),
    MarkRead(String),
    MarkUserInput,
    Sweep,
    /// Answered once every earlier call has run ([`BusFeed::settled`]).
    Settled(oneshot::Sender<()>),
}

#[derive(Default)]
struct Queue {
    calls: VecDeque<Call>,
    /// A worker is draining `calls`.
    running: bool,
}

struct Feed {
    cwd: String,
    id: String,
    bus: NotificationBus,
    queue: Mutex<Queue>,
}

impl Feed {
    fn lock(&self) -> std::sync::MutexGuard<'_, Queue> {
        self.queue.lock().unwrap_or_else(|e| e.into_inner())
    }

    fn push(self: &Arc<Self>, call: Call) {
        let start = {
            let mut q = self.lock();
            q.calls.push_back(call);
            !std::mem::replace(&mut q.running, true)
        };
        if start {
            let worker = Worker(Some(self.clone()));
            match tokio::runtime::Handle::try_current() {
                Ok(rt) => {
                    rt.spawn_blocking(move || worker.run());
                }
                Err(_) => {
                    std::thread::spawn(move || worker.run());
                }
            }
        }
    }

    /// Run the queue until it's empty.
    fn drain(&self) {
        loop {
            let call = {
                let mut q = self.lock();
                match q.calls.pop_front() {
                    Some(c) => c,
                    None => {
                        q.running = false;
                        return;
                    }
                }
            };
            // The bus swallows its errors; a panic mustn't wedge the queue.
            if std::panic::catch_unwind(AssertUnwindSafe(|| self.call(call))).is_err() {
                tracing::warn!(target: log::SESSION, session = %self.id, "[notifications] bus call panicked");
            }
        }
    }

    fn call(&self, call: Call) {
        let (cwd, id) = (self.cwd.as_str(), self.id.as_str());
        match call {
            Call::Record(ev, opts) => self.bus.record_session_event(cwd, id, &ev, opts),
            Call::MarkRead(request_id) => self.bus.mark_read_by_request_id(cwd, &request_id),
            Call::MarkUserInput => self.bus.mark_user_input(id),
            Call::Sweep => self.bus.sweep_orphaned_actionable_for_session(cwd, id),
            Call::Settled(tx) => {
                let _ = tx.send(());
            }
        }
    }
}

/// Drains a feed's queue. Dropped without running (a runtime that shuts
/// down drops the blocking tasks it hasn't started), it hands the queue to
/// a thread of its own, so the calls still run and the feed doesn't stay
/// marked busy.
struct Worker(Option<Arc<Feed>>);

impl Worker {
    fn run(mut self) {
        if let Some(feed) = self.0.take() {
            feed.drain();
        }
    }
}

impl Drop for Worker {
    fn drop(&mut self) {
        if let Some(feed) = self.0.take() {
            std::thread::spawn(move || feed.drain());
        }
    }
}

/// One session's ordered feed into the notification bus. Cheap to clone;
/// the default feed (a bare session state's) drops every call.
#[derive(Clone, Default)]
pub struct BusFeed(Option<Arc<Feed>>);

impl BusFeed {
    /// The session `id` in `cwd`, on the process's bus.
    pub fn new(cwd: &str, id: &str) -> BusFeed {
        BusFeed::with_bus(NotificationBus::global().clone(), cwd, id)
    }

    /// The same on another bus.
    pub fn with_bus(bus: NotificationBus, cwd: &str, id: &str) -> BusFeed {
        BusFeed(Some(Arc::new(Feed {
            cwd: cwd.to_owned(),
            id: id.to_owned(),
            bus,
            queue: Mutex::default(),
        })))
    }

    fn push(&self, call: Call) {
        if let Some(feed) = &self.0 {
            feed.push(call);
        }
    }

    /// `notificationBus.recordSessionEvent(cwd, id, event, {hasSubscribers,
    /// sessionTitle, hasActiveBackgroundWork})` at the end of `broadcast()`.
    /// `background_work` is only asked for an event the bus can act on.
    pub fn record(
        &self,
        event: &Value,
        subscribers: usize,
        title: Option<&str>,
        background_work: impl FnOnce() -> bool,
    ) {
        let Some(feed) = &self.0 else { return };
        if !may_record(event) {
            return;
        }
        let opts = SessionEventOpts {
            has_subscribers: Some(subscribers > 0),
            session_title: Some(session_label(title, &feed.id)),
            has_active_background_work: Some(background_work()),
        };
        feed.push(Call::Record(event.clone(), opts));
    }

    /// `consume()`'s synthetic `session_idle`: the stream ended without a
    /// `result`, an error or an abort. Straight to the bus (no subscriber
    /// or buffer sees it), without `hasActiveBackgroundWork`.
    pub fn synthetic_idle(&self, subscribers: usize, title: Option<&str>) {
        let Some(feed) = &self.0 else { return };
        let opts = SessionEventOpts {
            has_subscribers: Some(subscribers > 0),
            session_title: Some(session_label(title, &feed.id)),
            has_active_background_work: None,
        };
        let event = json!({"type": "sdk", "message": {"type": "result"}});
        feed.push(Call::Record(event, opts));
    }

    /// `markReadByRequestId(cwd, requestId)`: the prompt is gone (answered,
    /// aborted or drained), so its inbox row is read.
    pub fn mark_read(&self, request_id: &str) {
        self.push(Call::MarkRead(request_id.to_owned()));
    }

    /// `markUserInput(id)`: the user sent a prompt.
    pub fn mark_user_input(&self) {
        self.push(Call::MarkUserInput);
    }

    /// `sweepOrphanedActionableForSession(cwd, id)`: a fresh session can't
    /// answer an earlier life's prompts.
    pub fn sweep(&self) {
        self.push(Call::Sweep);
    }

    /// Wait until every call queued so far has run (tests).
    pub async fn settled(&self) {
        let Some(feed) = &self.0 else { return };
        let (tx, rx) = oneshot::channel();
        feed.push(Call::Settled(tx));
        let _ = rx.await;
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn only_events_the_bus_acts_on_are_queued() {
        for ev in [
            json!({"type": "turn_status", "status": "idle"}),
            json!({"type": "ready"}),
            json!({"type": "error", "message": "x"}),
            json!({"type": "permission_request"}),
            json!({"type": "ask_user_question"}),
            json!({"type": "mcp_elicitation_request"}),
            json!({"type": "plan_approval_request"}),
            json!({"type": "run_finished"}),
            json!({"type": "sdk", "message": {"type": "result"}}),
            json!({"type": "sdk", "message": {"type": "result", "parent_tool_use_id": "t"}}),
        ] {
            assert!(may_record(&ev), "{ev}");
        }
        for ev in [
            json!({"type": "sdk", "message": {"type": "assistant"}}),
            json!({"type": "sdk", "message": "result"}),
            json!({"type": "sdk", "message": null}),
            json!({"type": "sdk"}),
            json!({"type": "prompt_settled"}),
            json!({"type": "session_title"}),
            json!({"type": 5}),
            json!({}),
            json!("error"),
            json!(null),
        ] {
            assert!(!may_record(&ev), "{ev}");
        }
    }

    #[test]
    fn the_label_is_the_trimmed_title_or_the_id_prefix() {
        let id = "0123456789abcdef";
        assert_eq!(session_label(Some("  My title\n"), id), "My title");
        assert_eq!(session_label(Some(" \u{feff} "), id), "01234567");
        assert_eq!(session_label(Some(""), id), "01234567");
        assert_eq!(session_label(None, id), "01234567");
        assert_eq!(session_label(None, "abc"), "abc");
        // NEL isn't JS whitespace.
        assert_eq!(session_label(Some("\u{85}"), id), "\u{85}");
    }

    #[test]
    fn a_bare_feed_drops_its_calls() {
        let feed = BusFeed::default();
        feed.record(&json!({"type": "ready"}), 1, None, || unreachable!());
        feed.synthetic_idle(0, None);
        feed.mark_read("r");
        feed.mark_user_input();
        feed.sweep();
        assert!(feed.0.is_none());
    }

    /// The queue is empty and its worker has let go. `settled()` returns as
    /// soon as the `Settled` call runs, which is a moment before the worker
    /// finds the queue empty and clears `running`, so wait for that.
    fn idle(feed: &BusFeed) -> bool {
        let q = feed.0.as_ref().unwrap();
        for _ in 0..1000 {
            {
                let q = q.lock();
                if q.calls.is_empty() && !q.running {
                    return true;
                }
            }
            std::thread::sleep(std::time::Duration::from_millis(5));
        }
        false
    }

    /// The queue drains on the blocking pool inside a runtime and on a
    /// thread of its own outside one, and goes idle after each burst. Only
    /// `markUserInput` here: the other calls read workspaces.json and open
    /// the cwd's database under the real home (`session_notifications_golden`
    /// runs them under a temp one).
    #[tokio::test]
    async fn the_queue_drains_and_goes_idle() {
        use std::sync::atomic::{AtomicUsize, Ordering};
        // `markUserInput` reads the clock once: count the calls that ran.
        let ran = Arc::new(AtomicUsize::new(0));
        let tick = ran.clone();
        let bus = NotificationBus::new(crate::notification_bus::BusOptions {
            clock: Arc::new(move || tick.fetch_add(1, Ordering::SeqCst) as f64),
            ..Default::default()
        });
        let feed = BusFeed::with_bus(bus, "/unused", "s-1");
        for burst in 1..=3 {
            for _ in 0..50 {
                feed.mark_user_input();
            }
            feed.settled().await;
            assert!(idle(&feed));
            assert_eq!(ran.load(Ordering::SeqCst), burst * 50);
        }
        let outside = feed.clone();
        std::thread::spawn(move || {
            // Outside any runtime: the worker is a thread of its own.
            outside.mark_user_input();
            let rt = tokio::runtime::Builder::new_current_thread()
                .build()
                .unwrap();
            rt.block_on(outside.settled());
            assert!(idle(&outside));
        })
        .join()
        .unwrap();
        assert_eq!(ran.load(Ordering::SeqCst), 151);
    }
}
