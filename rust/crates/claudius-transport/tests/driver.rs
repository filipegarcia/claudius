//! The effect driver over a scripted transport (no I/O, so tokio's paused
//! clock runs the timers): fetches settle back into the state machine,
//! timers fire on time, UI effects reach the callback in order, and the
//! machine's streams run over the transport, their events back into it.

use std::collections::VecDeque;
use std::sync::{Arc, Mutex};
use std::time::Duration;

use async_trait::async_trait;
use bytes::Bytes;
use claudius_client::FixedEnv;
use claudius_client::effect::{Action, Effect, TimerId};
use claudius_client::state::ChatState;
use claudius_transport::driver::Driver;
use claudius_transport::{
    EventSourceEvent, ReadyState, Request, StreamResponse, Transport, TransportError,
};
use http::HeaderMap;
use serde_json::{Value, json};

/// A canned answer.
#[derive(Clone)]
enum Answer {
    Json(u16, Value),
    Sse(&'static str),
    Down,
}

/// Answers each request with the first answer whose URL prefix matches
/// (consumed), and logs it.
#[derive(Clone, Default)]
struct Scripted {
    answers: Arc<Mutex<VecDeque<(&'static str, Answer)>>>,
    log: Arc<Mutex<Vec<Request>>>,
}

impl Scripted {
    fn answer(&self, prefix: &'static str, a: Answer) {
        self.answers.lock().unwrap().push_back((prefix, a));
    }

    fn urls(&self) -> Vec<String> {
        self.log
            .lock()
            .unwrap()
            .iter()
            .map(|r| format!("{} {}", r.method, r.url))
            .collect()
    }
}

#[async_trait]
impl Transport for Scripted {
    async fn send(&self, req: Request) -> Result<StreamResponse, TransportError> {
        self.log.lock().unwrap().push(req.clone());
        let answer = {
            let mut answers = self.answers.lock().unwrap();
            let at = answers.iter().position(|(p, _)| req.url.starts_with(p));
            at.and_then(|i| answers.remove(i)).map(|(_, a)| a)
        };
        let (status, ct, body) = match answer {
            Some(Answer::Json(status, v)) => (status, "application/json", v.to_string()),
            Some(Answer::Sse(text)) => (200, "text/event-stream", text.to_owned()),
            Some(Answer::Down) | None => return Err(TransportError::Network("down".into())),
        };
        let mut headers = HeaderMap::new();
        headers.insert("content-type", ct.parse().unwrap());
        let chunk: Result<Bytes, TransportError> = Ok(Bytes::from(body));
        Ok(StreamResponse {
            status,
            headers,
            body: Box::pin(futures::stream::iter([chunk])),
        })
    }

    fn shared(&self) -> Arc<dyn Transport> {
        Arc::new(self.clone())
    }
}

type Ui = Arc<Mutex<Vec<Effect>>>;

fn driver(t: &Scripted) -> (Driver<FixedEnv>, Ui) {
    let ui: Ui = Arc::default();
    let sink = ui.clone();
    let mut state = ChatState::new("t1");
    state.session_id = Some("s1".into());
    let d = Driver::new(
        state,
        FixedEnv::new(1_000.0),
        Arc::new(t.clone()),
        move |e| sink.lock().unwrap().push(e),
    );
    (d, ui)
}

/// `d.step()`, failing instead of waiting forever when nothing can come (the
/// paused clock jumps to the deadline once every task is idle).
async fn step(d: &mut Driver<FixedEnv>) -> bool {
    tokio::time::timeout(Duration::from_secs(3600), d.step())
        .await
        .expect("stuck: the driver waits for a completion that never comes")
}

/// `d.run_until_idle(limit)`, failing like [`step`] does.
async fn idle(d: &mut Driver<FixedEnv>, limit: usize) -> usize {
    tokio::time::timeout(Duration::from_secs(3600), d.run_until_idle(limit))
        .await
        .expect("stuck: the driver waits for a completion that never comes")
}

fn resolved(ui: &Ui) -> Vec<(Action, Value)> {
    ui.lock()
        .unwrap()
        .iter()
        .filter_map(|e| match e {
            Effect::ActionResolved { action, outcome } => Some((action.clone(), outcome.clone())),
            _ => None,
        })
        .collect()
}

#[tokio::test(start_paused = true)]
async fn a_fetch_settles_back_into_the_state() {
    let t = Scripted::default();
    t.answer(
        "/api/sessions/rename",
        Answer::Json(200, json!({"ok": true})),
    );
    t.answer("/api/sessions", Answer::Json(200, json!([])));
    t.answer(
        "/api/sessions/all",
        Answer::Json(200, json!({"sessions": []})),
    );
    let (mut d, ui) = driver(&t);
    d.act(|s, env| s.rename_title("  New  ", env));
    assert_eq!(d.state.session_title, json!("New"), "shown at once");
    assert!(d.busy());
    // The POST, then the list refresh it starts (two GETs).
    assert_eq!(idle(&mut d, 10).await, 3);
    assert!(!d.busy());
    assert!(!step(&mut d).await, "nothing out");
    assert_eq!(
        t.urls(),
        [
            "POST /api/sessions/rename",
            "GET /api/sessions",
            "GET /api/sessions/all?limit=25"
        ]
    );
    let post = t.log.lock().unwrap()[0].clone();
    assert_eq!(
        post.headers,
        [("Content-Type".to_owned(), "application/json".to_owned())]
    );
    assert_eq!(
        post.body.as_deref(),
        Some(&br#"{"sessionId":"s1","title":"New"}"#[..])
    );
    assert_eq!(resolved(&ui), [(Action::RenameTitle, json!({"ok": true}))]);
    assert_eq!(d.state.session_title, json!("New"));
}

#[tokio::test(start_paused = true)]
async fn a_failed_fetch_is_the_pages_rejection() {
    let t = Scripted::default();
    t.answer("/api/sessions/rename", Answer::Down);
    let (mut d, ui) = driver(&t);
    d.state.session_title = json!("Old");
    d.act(|s, env| s.rename_title("New", env));
    assert_eq!(idle(&mut d, 10).await, 1);
    assert_eq!(d.state.session_title, json!("Old"), "reverted");
    assert_eq!(
        resolved(&ui),
        [(
            Action::RenameTitle,
            json!({"ok": false, "error": "Failed to fetch"})
        )]
    );
}

#[tokio::test(start_paused = true)]
async fn an_interval_fires_on_time_until_cleared() {
    let t = Scripted::default();
    let (mut d, _ui) = driver(&t);
    d.state.pending = true;
    let start = tokio::time::Instant::now();
    d.act(|s, _| s.start_sessions_poll());
    for (tick, answers) in [(1u64, 2usize), (2, 4)] {
        t.answer("/api/sessions", Answer::Json(200, json!([])));
        t.answer(
            "/api/sessions/all",
            Answer::Json(200, json!({"sessions": []})),
        );
        // The tick, then its two fetches.
        assert!(step(&mut d).await);
        assert_eq!(start.elapsed(), Duration::from_secs(30 * tick));
        assert!(step(&mut d).await);
        assert!(step(&mut d).await);
        assert_eq!(t.urls().len(), answers);
    }
    // Clearing it (the hook's unmount): nothing more.
    let id = TimerId(1);
    d.run(vec![Effect::ClearTimer { id }]);
    assert!(!d.busy());
    assert!(!step(&mut d).await);
    tokio::time::sleep(Duration::from_secs(120)).await;
    assert_eq!(t.urls().len(), 4);
}

#[tokio::test(start_paused = true)]
async fn a_timeout_fires_once() {
    let t = Scripted::default();
    let (mut d, ui) = driver(&t);
    let start = tokio::time::Instant::now();
    d.run(vec![
        Effect::SetTimer {
            id: TimerId(50),
            ms: 250.0,
            repeat: false,
        },
        Effect::ReplaceUrl { url: "/x".into() },
    ]);
    assert!(d.busy());
    assert!(step(&mut d).await);
    assert_eq!(start.elapsed(), Duration::from_millis(250));
    assert!(!d.busy(), "spent");
    assert!(!step(&mut d).await);
    // The UI effect went out at once.
    assert_eq!(
        *ui.lock().unwrap(),
        [Effect::ReplaceUrl { url: "/x".into() }]
    );
}

#[tokio::test(start_paused = true)]
async fn a_timer_cleared_after_firing_is_dropped() {
    let t = Scripted::default();
    let (mut d, _ui) = driver(&t);
    d.run(vec![Effect::SetTimer {
        id: TimerId(7),
        ms: 10.0,
        repeat: false,
    }]);
    // Let it fire into the queue without taking it.
    tokio::time::sleep(Duration::from_millis(50)).await;
    d.run(vec![Effect::ClearTimer { id: TimerId(7) }]);
    assert!(!d.busy());
    assert!(!step(&mut d).await);
}

#[tokio::test(start_paused = true)]
async fn a_stream_the_machine_did_not_open_reaches_only_the_tap() {
    let t = Scripted::default();
    t.answer(
        "/api/sessions/s1/stream",
        Answer::Sse(
            "data: {\"type\":\"turn_status\",\"status\":\"running\",\"backgroundTasks\":0}\n\n",
        ),
    );
    // The reconnect: refused, then a 500 fails it.
    t.answer("/api/sessions/s1/stream", Answer::Down);
    t.answer("/api/sessions/s1/stream", Answer::Json(500, json!({})));
    let (mut d, _ui) = driver(&t);
    let seen: Arc<Mutex<Vec<(u64, EventSourceEvent)>>> = Arc::default();
    let log = seen.clone();
    d.on_stream_event(move |id, ev| log.lock().unwrap().push((id, ev.clone())));
    let start = tokio::time::Instant::now();
    d.open_stream(9, "/api/sessions/s1/stream?tail=20&tabId=t1");
    assert!(d.busy());
    idle(&mut d, 20).await;
    assert!(!d.busy(), "a failed stream is done");
    let retrying = EventSourceEvent::Error {
        ready_state: ReadyState::Connecting,
    };
    assert_eq!(
        *seen.lock().unwrap(),
        [
            (9, EventSourceEvent::Open),
            (
                9,
                EventSourceEvent::Message {
                    data: r#"{"type":"turn_status","status":"running","backgroundTasks":0}"#.into(),
                    event_type: "message".into(),
                    last_event_id: String::new(),
                }
            ),
            (9, retrying.clone()),
            (9, retrying),
            (
                9,
                EventSourceEvent::Error {
                    ready_state: ReadyState::Closed
                }
            ),
        ]
    );
    // The machine ignores a stream it didn't open (U01k).
    assert!(!d.state.pending);
    // Two 3 s reconnection waits.
    assert_eq!(start.elapsed(), Duration::from_secs(6));
    assert_eq!(t.urls().len(), 3);
}

#[tokio::test(start_paused = true)]
async fn a_closed_stream_delivers_nothing_more() {
    let t = Scripted::default();
    t.answer("/api/sessions/s1/stream", Answer::Sse("data: {}\n\n"));
    let (mut d, _ui) = driver(&t);
    let seen: Arc<Mutex<Vec<EventSourceEvent>>> = Arc::default();
    let log = seen.clone();
    d.on_stream_event(move |_, ev| log.lock().unwrap().push(ev.clone()));
    d.open_stream(1, "/api/sessions/s1/stream");
    assert!(step(&mut d).await);
    d.close_stream(1);
    assert!(!d.busy());
    assert!(!step(&mut d).await);
    tokio::time::sleep(Duration::from_secs(10)).await;
    assert_eq!(*seen.lock().unwrap(), [EventSourceEvent::Open]);
    assert_eq!(t.urls().len(), 1, "no reconnect");
}

#[tokio::test(start_paused = true)]
async fn a_cleared_timers_queued_expiry_is_skipped() {
    let t = Scripted::default();
    let (mut d, _ui) = driver(&t);
    let start = tokio::time::Instant::now();
    d.run(vec![
        Effect::SetTimer {
            id: TimerId(1),
            ms: 10.0,
            repeat: false,
        },
        Effect::SetTimer {
            id: TimerId(2),
            ms: 1000.0,
            repeat: false,
        },
    ]);
    tokio::time::sleep(Duration::from_millis(50)).await;
    d.run(vec![Effect::ClearTimer { id: TimerId(1) }]);
    // The step is timer 2's, not timer 1's stale expiry.
    assert!(step(&mut d).await);
    assert_eq!(start.elapsed(), Duration::from_millis(1000));
    assert!(!d.busy());
}

#[tokio::test(start_paused = true)]
async fn a_cleared_timer_stops_its_task() {
    let t = Scripted::default();
    let (mut d, _ui) = driver(&t);
    let tasks = || {
        tokio::runtime::Handle::current()
            .metrics()
            .num_alive_tasks()
    };
    let before = tasks();
    d.run(vec![Effect::SetTimer {
        id: TimerId(3),
        ms: 100.0,
        repeat: true,
    }]);
    assert_eq!(tasks(), before + 1);
    d.run(vec![Effect::ClearTimer { id: TimerId(3) }]);
    for _ in 0..10 {
        tokio::task::yield_now().await;
    }
    assert_eq!(tasks(), before);
}

#[tokio::test(start_paused = true)]
async fn a_reopened_stream_drops_the_old_ones_events() {
    let t = Scripted::default();
    t.answer("/one", Answer::Sse("data: {\"from\":\"one\"}\n\n"));
    t.answer("/two", Answer::Sse("data: {\"from\":\"two\"}\n\n"));
    let (mut d, _ui) = driver(&t);
    let seen: Arc<Mutex<Vec<EventSourceEvent>>> = Arc::default();
    let log = seen.clone();
    d.on_stream_event(move |_, ev| log.lock().unwrap().push(ev.clone()));
    d.open_stream(4, "/one");
    // Let stream one's open and message queue up untaken.
    tokio::time::sleep(Duration::from_millis(10)).await;
    d.open_stream(4, "/two");
    assert!(step(&mut d).await);
    assert!(step(&mut d).await);
    assert_eq!(
        *seen.lock().unwrap(),
        [
            EventSourceEvent::Open,
            EventSourceEvent::Message {
                data: r#"{"from":"two"}"#.into(),
                event_type: "message".into(),
                last_event_id: String::new(),
            }
        ]
    );
}

#[tokio::test(start_paused = true)]
async fn the_machines_stream_runs_over_the_transport() {
    let t = Scripted::default();
    t.answer(
        "/api/sessions/s2/stream",
        Answer::Sse(
            "data: {\"type\":\"turn_status\",\"status\":\"running\",\"backgroundTasks\":0}\n\n",
        ),
    );
    t.answer("/api/sessions/s3/stream", Answer::Sse(": hi\n\n"));
    let (mut d, _ui) = driver(&t);
    let seen: Arc<Mutex<Vec<(u64, EventSourceEvent)>>> = Arc::default();
    let log = seen.clone();
    d.on_stream_event(move |id, ev| log.lock().unwrap().push((id, ev.clone())));
    // `switchSession`: the wake POST (no answer: a network error, which
    // the hook ignores), then the bind opens the stream.
    d.act(|s, env| s.switch_session("s2", env));
    let mut n = 0;
    while seen.lock().unwrap().len() < 2 {
        assert!(step(&mut d).await, "the stream never delivered");
        n += 1;
        assert!(n < 50, "too many steps");
    }
    let first = seen.lock().unwrap().clone();
    let sid = first[0].0;
    assert_eq!(first[0].1, EventSourceEvent::Open);
    assert!(
        matches!(&first[1].1, EventSourceEvent::Message { data, .. } if data.contains("turn_status"))
    );
    assert_eq!(first[1].0, sid);
    // `onopen` made it live, and `onmessage` reached the reducer.
    assert_eq!(d.state.session_id.as_deref(), Some("s2"));
    assert!(d.state.pending);
    assert!(
        t.urls()
            .contains(&"GET /api/sessions/s2/stream?tail=20&tabId=t1".to_string()),
        "{:?}",
        t.urls()
    );
    // Switching away closes s2's stream (`CloseEventSource`) and opens s3's.
    d.act(|s, env| s.switch_session("s3", env));
    let mut n = 0;
    while !seen.lock().unwrap().iter().any(|(id, _)| *id != sid) {
        assert!(step(&mut d).await, "s3's stream never opened");
        n += 1;
        assert!(n < 50, "too many steps");
    }
    tokio::time::sleep(Duration::from_secs(10)).await;
    while tokio::time::timeout(Duration::from_millis(1), d.step())
        .await
        .is_ok_and(|b| b)
    {}
    let after: Vec<_> = seen.lock().unwrap()[2..]
        .iter()
        .map(|(id, _)| *id)
        .collect();
    assert!(
        after.iter().all(|id| *id != sid),
        "s2's stream still delivers: {after:?}"
    );
    assert_eq!(d.state.session_id.as_deref(), Some("s3"));
}

#[tokio::test(start_paused = true)]
async fn a_typed_event_is_dropped_and_a_failed_stream_reaches_onerror_closed() {
    let t = Scripted::default();
    // `onmessage` hears only `event: message`: this one goes nowhere.
    t.answer(
        "/api/sessions/s4/stream",
        Answer::Sse(
            "event: ping\ndata: {\"type\":\"turn_status\",\"status\":\"running\",\"backgroundTasks\":0}\n\n",
        ),
    );
    // The reconnect gets a 500: the source fails (readyState CLOSED).
    t.answer("/api/sessions/s4/stream", Answer::Json(500, json!({})));
    let (mut d, ui) = driver(&t);
    let seen: Arc<Mutex<Vec<EventSourceEvent>>> = Arc::default();
    let log = seen.clone();
    d.on_stream_event(move |_, ev| log.lock().unwrap().push(ev.clone()));
    d.act(|s, env| s.switch_session("s4", env));
    let closed = EventSourceEvent::Error {
        ready_state: ReadyState::Closed,
    };
    let ping = |e: &EventSourceEvent| matches!(e, EventSourceEvent::Message { event_type, .. } if event_type == "ping");
    let mut n = 0;
    while !seen.lock().unwrap().iter().any(ping) {
        assert!(step(&mut d).await, "the typed event never came");
        n += 1;
        assert!(n < 50, "too many steps");
    }
    // Checked before the failure, which settles `pending` anyway.
    assert!(!d.state.pending, "a typed event reached onmessage");
    while !seen.lock().unwrap().contains(&closed) {
        assert!(step(&mut d).await, "the stream never failed");
        n += 1;
        assert!(n < 50, "too many steps");
    }
    // `onerror` with CLOSED: the hook's console warning.
    assert!(
        ui.lock().unwrap().iter().any(|e| matches!(
            e,
            Effect::ConsoleWarn { text } if text.contains("was closed by the browser")
        )),
        "{:?}",
        ui.lock().unwrap()
    );
}

#[tokio::test(start_paused = true)]
async fn onopen_ends_the_outage_before_the_badge_shows() {
    let t = Scripted::default();
    // Each body ends at once: an error (CONNECTING), then the 3 s retry
    // reconnects, inside the hook's 4 s badge delay.
    t.answer("/api/sessions/s5/stream", Answer::Sse(": one\n\n"));
    t.answer("/api/sessions/s5/stream", Answer::Sse(": two\n\n"));
    let (mut d, _ui) = driver(&t);
    let opens = Arc::new(Mutex::new(0));
    let count = opens.clone();
    d.on_stream_event(move |_, ev| {
        if *ev == EventSourceEvent::Open {
            *count.lock().unwrap() += 1;
        }
    });
    d.act(|s, env| s.switch_session("s5", env));
    let mut n = 0;
    while *opens.lock().unwrap() < 2 {
        assert!(step(&mut d).await, "the reconnect never opened");
        n += 1;
        assert!(n < 50, "too many steps");
    }
    // Past the first outage's 4 s badge, before the second's.
    tokio::time::sleep(Duration::from_millis(1500)).await;
    while tokio::time::timeout(Duration::from_millis(1), d.step())
        .await
        .is_ok_and(|b| b)
    {}
    assert_eq!(
        d.state.stream_status, "live",
        "onopen didn't cancel the badge"
    );
}
