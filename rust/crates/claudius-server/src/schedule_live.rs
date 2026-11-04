//! The live half of `/api/schedule/**` (G07c): ports of
//! `app/api/schedule/[id]/runs/[runId]/stream/route.ts` (GET),
//! `session-loops/route.ts` (GET) and `session-loops/cancel/route.ts`
//! (POST).
//!
//! **Who answers.** The run stream reads the scheduler's live runs, so it
//! follows [`crate::schedule`]'s switch: Rust with `--scheduler`, else the
//! request goes to Next unchanged (where the run is). The session loops are
//! read off live sessions, which only the Rust process has, so Rust always
//! answers those; Next's session manager is empty behind the front door.
//!
//! * `GET /api/schedule/:id/runs/:runId/stream`: SSE (`text/event-stream`,
//!   `no-cache, no-transform`, `keep-alive`, `X-Accel-Buffering: no`). The
//!   scheduler's `subscribeRun` replays the run's events and forwards new
//!   ones as `data: <JSON.stringify(event)>\n\n`; a run that isn't live (over
//!   5 s finished, or unknown; `:id` isn't read) gets one `{type: "error",
//!   message: "run_not_live"}`. `: ping\n\n` every 15 s. Every second the
//!   run is checked; once it isn't live, `{type: "ready", sessionId:
//!   "<runId>:done"}` ends the stream. A client that leaves unsubscribes, so
//!   the run reads `attached: false` again.
//! * `GET /api/schedule/session-loops`: `{loops}`, each live session's loops
//!   (in session order, then the session's own) without the stale wake-ups
//!   ([`session_loops::is_stale_wakeup`] at one `Date.now()`), as
//!   `{...loop, sessionId, sessionTitle}` (`title ?? null`), stably sorted
//!   newest `startedAt` first.
//! * `POST /api/schedule/session-loops/cancel {sessionId, loopId}`: a body
//!   that doesn't parse is 400 `{ok: false, error: "invalid json body"}`;
//!   both ids go through `?.trim()` (a non-string throws: Next's empty 500),
//!   then a blank one is 400 `sessionId and loopId required`, no live session
//!   404 `session not found`, no loop with that id (stale ones count) 404
//!   `loop not found in this session`. A cancelled loop is `{ok: true}`
//!   with nothing sent; otherwise the session is sent
//!   [`session_loops::cancel_prompt`] as a user prompt and the answer is
//!   `{ok: true}`. The loop flips to cancelled only when the agent runs the
//!   tool.

use std::collections::VecDeque;
use std::convert::Infallible;
use std::sync::Arc;
use std::time::Duration;

use axum::Router;
use axum::body::{Body, Bytes};
use axum::extract::{Path, State};
use axum::http::{HeaderValue, StatusCode, header};
use axum::response::Response;
use axum::routing::{get, post};
use claudius_agent::js;
use claudius_core::scheduler;
use claudius_core::session::SendOptions;
use claudius_core::{now_ms, session_loops};
use futures::{Stream, StreamExt};
use serde_json::{Map, Value, json};
use tokio::sync::mpsc;
use tokio::time::{Instant, Interval, MissedTickBehavior, interval_at};

use crate::AppState;
use crate::body::JsonBody;
use crate::schedule::{json_text, owned, threw, trimmed};

pub fn router() -> Router<AppState> {
    Router::new()
        .route("/api/schedule/session-loops", get(list_loops))
        .route("/api/schedule/session-loops/cancel", post(cancel_loop))
        .route(
            "/api/schedule/{id}/runs/{run_id}/stream",
            get(owned(run_stream)),
        )
}

// ────────────────────────────────── run stream ────────────────────────────────

/// The heartbeat comment's period.
pub const PING: Duration = Duration::from_millis(15_000);
/// How often the stream checks that its run is still live.
pub const LIVE_CHECK: Duration = Duration::from_millis(1_000);

/// `GET /api/schedule/:id/runs/:runId/stream`.
async fn run_stream(Path((_, run_id)): Path<(String, String)>) -> Response {
    let sched = scheduler::scheduler().clone();
    // The scheduler calls this with its state locked: hand the event on.
    let (tx, rx) = mpsc::unbounded_channel::<Value>();
    let guard = sched.subscribe_run(
        &run_id,
        Arc::new(move |ev: &Value| {
            let _ = tx.send(ev.clone());
        }),
    );
    let done = js::stringify(&json!({"type": "ready", "sessionId": format!("{run_id}:done")}));
    let body = run_events(rx, guard, move || sched.is_run_live(&run_id), done);
    let mut resp = Response::new(Body::from_stream(body.boxed()));
    let h = resp.headers_mut();
    h.insert(
        header::CONTENT_TYPE,
        HeaderValue::from_static("text/event-stream"),
    );
    h.insert(
        header::CACHE_CONTROL,
        HeaderValue::from_static("no-cache, no-transform"),
    );
    h.insert(header::CONNECTION, HeaderValue::from_static("keep-alive"));
    h.insert("x-accel-buffering", HeaderValue::from_static("no"));
    resp
}

/// One SSE message: `data: <JSON.stringify(event)>\n\n`.
fn frame(ev: &Value) -> Bytes {
    Bytes::from(format!("data: {}\n\n", js::stringify(ev)))
}

struct Run<U, L> {
    events: mpsc::UnboundedReceiver<Value>,
    /// The subscription: dropped with the stream (the client left, or the
    /// run ended), which unsubscribes.
    _guard: U,
    live: L,
    /// False once every sender is gone (the scheduler dropped the
    /// subscriber: a run that wasn't live, or a live buffer that went).
    open: bool,
    ping: Interval,
    check: Interval,
    out: VecDeque<Bytes>,
    done: Option<String>,
}

/// The stream route's body over a subscription: `events` (what the
/// scheduler sent the subscriber) as SSE messages, `: ping` every [`PING`],
/// and, at the first [`LIVE_CHECK`] tick that finds the run no longer
/// `live`, the events still queued and then `done` (`ready …:done`) as the
/// last message. The intervals start when this is called, as the TS ones
/// start in the stream's `start()`.
pub fn run_events<U, L>(
    events: mpsc::UnboundedReceiver<Value>,
    guard: U,
    live: L,
    done: String,
) -> impl Stream<Item = Result<Bytes, Infallible>> + Send + 'static
where
    U: Send + 'static,
    L: Fn() -> bool + Send + 'static,
{
    let now = Instant::now();
    let mut ping = interval_at(now + PING, PING);
    ping.set_missed_tick_behavior(MissedTickBehavior::Delay);
    let mut check = interval_at(now + LIVE_CHECK, LIVE_CHECK);
    check.set_missed_tick_behavior(MissedTickBehavior::Delay);
    let run = Run {
        events,
        _guard: guard,
        live,
        open: true,
        ping,
        check,
        out: VecDeque::new(),
        done: Some(done),
    };
    futures::stream::unfold(run, |mut run| async move {
        loop {
            if let Some(chunk) = run.out.pop_front() {
                return Some((Ok(chunk), run));
            }
            // The marker went out: that's the end.
            let done = run.done.as_ref()?;
            // Every 15th check falls on a ping: the ping goes first, as the
            // heartbeat interval is set up first in TS.
            tokio::select! {
                biased;
                ev = run.events.recv(), if run.open => match ev {
                    Some(ev) => run.out.push_back(frame(&ev)),
                    None => run.open = false,
                },
                _ = run.ping.tick() => run.out.push_back(Bytes::from_static(b": ping\n\n")),
                _ = run.check.tick() => {
                    if !(run.live)() {
                        while let Ok(ev) = run.events.try_recv() {
                            run.out.push_back(frame(&ev));
                        }
                        run.out.push_back(Bytes::from(format!("data: {done}\n\n")));
                        run.done = None;
                    }
                }
            }
        }
    })
}

// ──────────────────────────────── session loops ───────────────────────────────

/// `GET /api/schedule/session-loops`.
async fn list_loops(State(app): State<AppState>) -> Response {
    // One instant for every loop.
    let now = now_ms() as f64;
    let mut loops: Vec<(i64, Value)> = Vec::new();
    for s in app.mgr.list() {
        let title = s.title();
        for l in s.scheduled_loops() {
            if session_loops::is_stale_wakeup(&l, now) {
                continue;
            }
            let Value::Object(mut item) = l.to_json() else {
                unreachable!("a loop is an object")
            };
            item.insert("sessionId".into(), json!(s.id));
            item.insert("sessionTitle".into(), json!(title));
            loops.push((l.started_at, Value::Object(item)));
        }
    }
    // Newest first; a stable sort, like V8's.
    loops.sort_by_key(|l| std::cmp::Reverse(l.0));
    let mut body = Map::new();
    body.insert(
        "loops".into(),
        Value::Array(loops.into_iter().map(|(_, v)| v).collect()),
    );
    json_text(StatusCode::OK, &Value::Object(body))
}

/// A number literal past f64 (JS Infinity): a number, so `.trim` isn't a
/// function on it.
const INFINITE: f64 = f64::MAX;

fn refused(status: StatusCode, error: &str) -> Response {
    json_text(status, &json!({"ok": false, "error": error}))
}

/// `POST /api/schedule/session-loops/cancel`.
async fn cancel_loop(State(app): State<AppState>, body: Bytes) -> Response {
    const ROUTE: &str = "schedule/session-loops/cancel";
    let Ok(b) = JsonBody::parse_or_message_overflow(&body, &json!(INFINITE)) else {
        return refused(StatusCode::BAD_REQUEST, "invalid json body");
    };
    let Ok(session_id) = trimmed(&b, "sessionId") else {
        return threw(ROUTE, &"TypeError: body?.sessionId?.trim is not a function");
    };
    let Ok(loop_id) = trimmed(&b, "loopId") else {
        return threw(ROUTE, &"TypeError: body?.loopId?.trim is not a function");
    };
    let (Some(session_id), Some(loop_id)) = (
        session_id.filter(|s| !s.is_empty()),
        loop_id.filter(|s| !s.is_empty()),
    ) else {
        return refused(StatusCode::BAD_REQUEST, "sessionId and loopId required");
    };
    let Some(session) = app.mgr.get(session_id) else {
        return refused(StatusCode::NOT_FOUND, "session not found");
    };
    // Only an id the agent itself minted reaches the prompt.
    let Some(known) = session
        .scheduled_loops()
        .into_iter()
        .find(|l| l.id == loop_id)
    else {
        return refused(StatusCode::NOT_FOUND, "loop not found in this session");
    };
    if !known.cancelled {
        session.send_input(
            &session_loops::cancel_prompt(&known),
            &[],
            SendOptions::default(),
        );
    }
    json_text(StatusCode::OK, &json!({"ok": true}))
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::sync::Mutex;
    use std::sync::atomic::{AtomicBool, Ordering};

    /// What the stream wrote, with when (ms since it opened).
    type Log = Arc<Mutex<Vec<(u64, String)>>>;

    struct Dropped(Arc<AtomicBool>);
    impl Drop for Dropped {
        fn drop(&mut self) {
            self.0.store(true, Ordering::SeqCst);
        }
    }

    /// The stream on a paused clock, read on its own task into a log.
    fn open(
        live: Arc<AtomicBool>,
    ) -> (
        mpsc::UnboundedSender<Value>,
        Log,
        Arc<AtomicBool>,
        tokio::task::JoinHandle<()>,
    ) {
        let (tx, rx) = mpsc::unbounded_channel();
        let dropped = Arc::new(AtomicBool::new(false));
        let start = Instant::now();
        let body = run_events(
            rx,
            Dropped(dropped.clone()),
            move || live.load(Ordering::SeqCst),
            r#"{"type":"ready","sessionId":"r:done"}"#.to_owned(),
        );
        let log: Log = Arc::default();
        let into = log.clone();
        let task = tokio::spawn(async move {
            let mut body = Box::pin(body);
            while let Some(Ok(chunk)) = body.next().await {
                let at = start.elapsed().as_millis() as u64;
                into.lock()
                    .unwrap()
                    .push((at, String::from_utf8(chunk.to_vec()).unwrap()));
            }
            into.lock()
                .unwrap()
                .push((start.elapsed().as_millis() as u64, "end".into()));
        });
        (tx, log, dropped, task)
    }

    async fn at(ms: u64) {
        tokio::time::sleep(Duration::from_millis(ms)).await;
        // Let the reader catch up.
        for _ in 0..10 {
            tokio::task::yield_now().await;
        }
    }

    fn texts(log: &Log) -> Vec<(u64, String)> {
        log.lock().unwrap().clone()
    }

    const DONE: &str = "data: {\"type\":\"ready\",\"sessionId\":\"r:done\"}\n\n";

    #[test]
    fn the_periods_are_the_ts_ones() {
        assert_eq!(PING.as_millis(), 15_000);
        assert_eq!(LIVE_CHECK.as_millis(), 1_000);
    }

    #[tokio::test(start_paused = true)]
    async fn a_live_run_streams_pings_then_ends_after_it_does() {
        let live = Arc::new(AtomicBool::new(true));
        let (tx, log, dropped, task) = open(live.clone());
        tx.send(json!({"type": "ready", "sessionId": "r", "n": 1.0}))
            .unwrap();
        at(10).await;
        assert_eq!(
            texts(&log),
            [(
                0,
                "data: {\"type\":\"ready\",\"sessionId\":\"r\",\"n\":1}\n\n".into()
            )]
        );
        // Live: the checks say nothing; a ping each 15 s from the open.
        at(29_990).await;
        assert_eq!(
            texts(&log)[1..],
            [(15_000, ": ping\n\n".into()), (30_000, ": ping\n\n".into())]
        );
        tx.send(json!({"type": "sdk", "message": {"x": "\u{2028}"}}))
            .unwrap();
        at(500).await;
        assert_eq!(
            texts(&log)[3],
            (
                30_000,
                "data: {\"type\":\"sdk\",\"message\":{\"x\":\"\u{2028}\"}}\n\n".into()
            )
        );
        // It ends at 30.5 s: what it sent still goes out, and the next check
        // (31 s) sends the marker and drops the subscription.
        tx.send(json!({"last": 1})).unwrap();
        live.store(false, Ordering::SeqCst);
        at(10).await;
        assert!(!dropped.load(Ordering::SeqCst));
        at(1_000).await;
        task.await.unwrap();
        let log = texts(&log);
        assert_eq!(
            log[4..],
            [
                (30_500, "data: {\"last\":1}\n\n".into()),
                (31_000, DONE.into()),
                (31_000, "end".into()),
            ]
        );
        assert!(dropped.load(Ordering::SeqCst));
    }

    #[tokio::test(start_paused = true)]
    async fn the_check_drains_events_before_the_marker() {
        // The run's last events land after the stream last looked (here:
        // while the check reads `live`): they still go out, before the
        // marker.
        let (tx, rx) = mpsc::unbounded_channel();
        let start = Instant::now();
        let last = tx.clone();
        let live = move || {
            last.send(json!(1)).unwrap();
            last.send(json!(2)).unwrap();
            false
        };
        let mut body = Box::pin(run_events(rx, (), live, "{}".into()));
        let mut got = Vec::new();
        while let Some(Ok(c)) = body.next().await {
            got.push(String::from_utf8(c.to_vec()).unwrap());
        }
        assert_eq!(got, ["data: 1\n\n", "data: 2\n\n", "data: {}\n\n"]);
        assert_eq!(start.elapsed().as_millis(), 1_000);
        drop(tx);
    }

    #[tokio::test(start_paused = true)]
    async fn a_run_that_ends_on_a_ping_gets_the_ping_first() {
        // Many streams, so an unordered `select!` (a random first branch per
        // poll) can't pass by chance.
        let live = Arc::new(AtomicBool::new(true));
        let opened: Vec<_> = (0..64).map(|_| open(live.clone())).collect();
        at(14_500).await;
        live.store(false, Ordering::SeqCst);
        at(500).await;
        for (_tx, log, _, task) in opened {
            task.await.unwrap();
            assert_eq!(
                texts(&log),
                [
                    (15_000, ": ping\n\n".into()),
                    (15_000, DONE.into()),
                    (15_000, "end".into()),
                ]
            );
        }
    }

    #[tokio::test(start_paused = true)]
    async fn a_run_that_is_not_live_ends_at_the_first_check() {
        // `subscribeRun` already sent its `run_not_live` and dropped the
        // subscriber: a closed channel isn't the end, the check is.
        let live = Arc::new(AtomicBool::new(false));
        let (tx, log, dropped, task) = open(live);
        tx.send(json!({"type": "error", "message": "run_not_live"}))
            .unwrap();
        drop(tx);
        at(999).await;
        assert_eq!(
            texts(&log),
            [(
                0,
                "data: {\"type\":\"error\",\"message\":\"run_not_live\"}\n\n".into()
            )]
        );
        assert!(!dropped.load(Ordering::SeqCst));
        at(1).await;
        task.await.unwrap();
        assert_eq!(
            texts(&log)[1..],
            [(1_000, DONE.into()), (1_000, "end".into())]
        );
        assert!(dropped.load(Ordering::SeqCst));
    }

    #[tokio::test(start_paused = true)]
    async fn a_client_that_leaves_unsubscribes() {
        let live = Arc::new(AtomicBool::new(true));
        let (tx, rx) = mpsc::unbounded_channel::<Value>();
        let dropped = Arc::new(AtomicBool::new(false));
        let body = run_events(
            rx,
            Dropped(dropped.clone()),
            move || live.load(Ordering::SeqCst),
            "{}".into(),
        );
        tokio::time::advance(Duration::from_millis(20_000)).await;
        assert!(!dropped.load(Ordering::SeqCst));
        drop(body);
        assert!(dropped.load(Ordering::SeqCst));
        assert!(tx.send(json!(1)).is_err());
    }

    #[tokio::test(start_paused = true)]
    async fn a_stalled_stream_does_not_catch_up() {
        // Node re-arms an interval from when its callback ran: after a stall
        // each timer fires once, then a period after that.
        use futures::FutureExt;
        use std::sync::atomic::AtomicUsize;
        let checks = Arc::new(AtomicUsize::new(0));
        let live = Arc::new(AtomicBool::new(true));
        let (counted, is_live) = (checks.clone(), live.clone());
        let (_tx, rx) = mpsc::unbounded_channel::<Value>();
        let mut body = Box::pin(run_events(
            rx,
            (),
            move || {
                counted.fetch_add(1, Ordering::SeqCst);
                is_live.load(Ordering::SeqCst)
            },
            "{}".into(),
        ));
        let ping = Bytes::from_static(b": ping\n\n");
        let mut next = move || body.next().now_or_never().map(|c| c.unwrap().unwrap());
        tokio::time::advance(Duration::from_millis(40_500)).await;
        assert_eq!(next(), Some(ping.clone()));
        assert_eq!(next(), None);
        assert_eq!(checks.load(Ordering::SeqCst), 1);
        // The next ping is 15 s after the late one (55.5 s), not on the old
        // beat (45 s).
        tokio::time::advance(Duration::from_millis(14_999)).await;
        assert_eq!(next(), None);
        assert_eq!(checks.load(Ordering::SeqCst), 2);
        tokio::time::advance(Duration::from_millis(1)).await;
        assert_eq!(next(), Some(ping));
        assert_eq!(next(), None);
        // Likewise the check: 1 s after 55.499 s, not at 56 s.
        live.store(false, Ordering::SeqCst);
        tokio::time::advance(Duration::from_millis(501)).await;
        assert_eq!(next(), None);
        assert_eq!(checks.load(Ordering::SeqCst), 2);
        tokio::time::advance(Duration::from_millis(498)).await;
        assert_eq!(next(), Some(Bytes::from_static(b"data: {}\n\n")));
        assert_eq!(checks.load(Ordering::SeqCst), 3);
    }
}
