//! The `EventSource` emulation against a scripted local server: each
//! connection gets the next scripted response, and the server records
//! every request's headers and time, and when a response body was
//! dropped (the client closed the connection).
//!
//! The rules come from WHATWG HTML §9.2 and Chromium's `EventSource`, as
//! listed in `src/event_source.rs` and `src/sse.rs`; each test says which
//! it checks. Most run over [`RemoteTransport`] (a real socket, so
//! "connection closed" is real); `in_process_runs_the_same_script` runs a
//! script through [`InProcessTransport`] over the same router.

use std::sync::atomic::{AtomicUsize, Ordering};
use std::sync::{Arc, Mutex};
use std::time::{Duration, Instant};

use axum::Router;
use axum::body::{Body, Bytes};
use axum::extract::State;
use axum::http::{HeaderMap, StatusCode, header};
use axum::response::Response;
use axum::routing::get;
use claudius_transport::{
    EventSource, EventSourceEvent, EventSourceOptions, InProcessTransport, ReadyState,
    RemoteTransport, Transport,
};

/// One step of a scripted body.
#[derive(Clone)]
enum Step {
    Send(Vec<u8>),
    Wait(u64),
}

/// How a scripted body ends.
#[derive(Clone, Copy, PartialEq)]
enum End {
    /// The response ends (the server closes the stream).
    Close,
    /// It never ends.
    Hold,
    /// It breaks off (the body errors, so hyper aborts the connection).
    Break,
}

#[derive(Clone)]
struct Conn {
    status: u16,
    content_type: Option<&'static str>,
    steps: Vec<Step>,
    end: End,
}

fn sse(steps: Vec<Step>, end: End) -> Conn {
    Conn {
        status: 200,
        content_type: Some("text/event-stream"),
        steps,
        end,
    }
}

fn status(code: u16) -> Conn {
    Conn {
        status: code,
        content_type: Some("text/event-stream"),
        steps: vec![],
        end: End::Close,
    }
}

fn send(s: &str) -> Step {
    Step::Send(s.as_bytes().to_vec())
}

struct Seen {
    at: Instant,
    headers: HeaderMap,
}

#[derive(Clone)]
struct Script {
    conns: Arc<Vec<Conn>>,
    seen: Arc<Mutex<Vec<Seen>>>,
    /// Bodies dropped before their end (the client went away).
    dropped: Arc<AtomicUsize>,
}

/// Counts a body dropped before it was done.
struct DropFlag {
    dropped: Arc<AtomicUsize>,
    done: bool,
}

impl DropFlag {
    fn finish(&mut self) {
        self.done = true;
    }
}

impl Drop for DropFlag {
    fn drop(&mut self) {
        if !self.done {
            self.dropped.fetch_add(1, Ordering::SeqCst);
        }
    }
}

async fn handler(State(script): State<Script>, headers: HeaderMap) -> Response {
    let n = {
        let mut seen = script.seen.lock().unwrap();
        seen.push(Seen {
            at: Instant::now(),
            headers,
        });
        seen.len() - 1
    };
    // Past the script: a 500, which fails the connection.
    let conn = script.conns.get(n).cloned().unwrap_or_else(|| status(500));
    let flag = DropFlag {
        dropped: script.dropped.clone(),
        done: false,
    };
    let steps = conn.steps.clone();
    let end = conn.end;
    let body = futures::stream::unfold((0usize, flag), move |(i, mut flag)| {
        let steps = steps.clone();
        async move {
            let mut i = i;
            loop {
                match steps.get(i) {
                    Some(Step::Wait(ms)) => {
                        tokio::time::sleep(Duration::from_millis(*ms)).await;
                        i += 1;
                    }
                    Some(Step::Send(b)) => {
                        return Some((
                            Ok::<_, std::io::Error>(Bytes::from(b.clone())),
                            (i + 1, flag),
                        ));
                    }
                    None => match end {
                        End::Close => {
                            flag.finish();
                            return None;
                        }
                        End::Hold => futures::future::pending::<()>().await,
                        End::Break => {
                            flag.finish();
                            return Some((Err(std::io::Error::other("break")), (i, flag)));
                        }
                    },
                }
            }
        }
    });
    let mut res = Response::new(Body::from_stream(body));
    *res.status_mut() = StatusCode::from_u16(conn.status).unwrap();
    if let Some(ct) = conn.content_type {
        res.headers_mut()
            .insert(header::CONTENT_TYPE, ct.parse().unwrap());
    }
    res
}

impl Script {
    fn new(conns: Vec<Conn>) -> Script {
        Script {
            conns: Arc::new(conns),
            seen: Arc::default(),
            dropped: Arc::default(),
        }
    }

    fn router(&self) -> Router {
        Router::new()
            .route("/es", get(handler))
            .with_state(self.clone())
    }

    /// Serve it on a local port; a remote transport to it.
    async fn serve(&self) -> Arc<dyn Transport> {
        let l = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
        let addr = l.local_addr().unwrap();
        let router = self.router();
        tokio::spawn(async move { axum::serve(l, router).await.unwrap() });
        Arc::new(RemoteTransport::new(&format!("http://{addr}")).unwrap())
    }

    fn connections(&self) -> usize {
        self.seen.lock().unwrap().len()
    }

    fn header(&self, conn: usize, name: &str) -> Option<String> {
        let seen = self.seen.lock().unwrap();
        seen[conn]
            .headers
            .get(name)
            .map(|v| String::from_utf8(v.as_bytes().to_vec()).unwrap())
    }

    fn gap_ms(&self, a: usize, b: usize) -> u128 {
        let seen = self.seen.lock().unwrap();
        seen[b].at.duration_since(seen[a].at).as_millis()
    }
}

fn opts(retry_ms: u64) -> EventSourceOptions {
    EventSourceOptions {
        default_retry: Duration::from_millis(retry_ms),
    }
}

fn msg(data: &str, id: &str) -> EventSourceEvent {
    typed(data, "message", id)
}

fn typed(data: &str, event_type: &str, id: &str) -> EventSourceEvent {
    EventSourceEvent::Message {
        data: data.into(),
        event_type: event_type.into(),
        last_event_id: id.into(),
    }
}

const OPEN: EventSourceEvent = EventSourceEvent::Open;
const RETRYING: EventSourceEvent = EventSourceEvent::Error {
    ready_state: ReadyState::Connecting,
};
const FAILED: EventSourceEvent = EventSourceEvent::Error {
    ready_state: ReadyState::Closed,
};

async fn next(es: &mut EventSource) -> Option<EventSourceEvent> {
    tokio::time::timeout(Duration::from_secs(10), es.recv())
        .await
        .expect("an event within 10 s")
}

/// Every event to the end (the source failed), with the `readyState` read
/// after each. A source that never ends (retrying forever) fails the test.
async fn all(es: &mut EventSource) -> Vec<(EventSourceEvent, ReadyState)> {
    let mut out = Vec::new();
    while let Some(ev) = next(es).await {
        out.push((ev, es.ready_state()));
        assert!(out.len() < 100, "no end: {:?}", &out[..10]);
    }
    out
}

fn events(v: &[(EventSourceEvent, ReadyState)]) -> Vec<EventSourceEvent> {
    v.iter().map(|(e, _)| e.clone()).collect()
}

#[tokio::test]
async fn reconnects_after_the_retry_time_with_last_event_id() {
    let script = Script::new(vec![
        sse(vec![send("retry: 300\nid: 1\ndata: a\n\n")], End::Close),
        sse(vec![send("data: b\n\nid: 2\n\n")], End::Close),
    ]);
    let t = script.serve().await;
    let mut es = EventSource::open(t, "/es", opts(10_000));
    assert_eq!(es.ready_state(), ReadyState::Connecting);
    let got = all(&mut es).await;
    assert_eq!(
        got,
        vec![
            (OPEN, ReadyState::Open),
            (msg("a", "1"), ReadyState::Open),
            (RETRYING, ReadyState::Connecting),
            (OPEN, ReadyState::Open),
            // The id persists into the next connection's events.
            (msg("b", "1"), ReadyState::Open),
            (RETRYING, ReadyState::Connecting),
            // The script is over: a 500.
            (FAILED, ReadyState::Closed),
        ]
    );
    assert_eq!(es.ready_state(), ReadyState::Closed);
    assert_eq!(es.recv().await, None);
    assert_eq!(script.connections(), 3);
    // The stream's `retry: 300` replaced the 10 s default.
    assert!(script.gap_ms(0, 1) >= 300, "{}", script.gap_ms(0, 1));
    assert!(script.gap_ms(1, 2) >= 300, "{}", script.gap_ms(1, 2));
    assert!(script.gap_ms(0, 2) < 5_000);
    // No id yet on the first request; then the last dispatched one (an
    // id-only block counts).
    assert_eq!(script.header(0, "last-event-id"), None);
    assert_eq!(script.header(1, "last-event-id").as_deref(), Some("1"));
    assert_eq!(script.header(2, "last-event-id").as_deref(), Some("2"));
    for conn in 0..3 {
        assert_eq!(
            script.header(conn, "accept").as_deref(),
            Some("text/event-stream")
        );
        assert_eq!(
            script.header(conn, "cache-control").as_deref(),
            Some("no-cache")
        );
        assert_eq!(script.header(conn, "pragma").as_deref(), Some("no-cache"));
        assert_eq!(script.header(conn, "origin"), None, "a GET has no Origin");
    }
}

#[tokio::test]
async fn the_default_reconnection_time_is_3000_ms() {
    let script = Script::new(vec![sse(vec![send("data: a\n\n")], End::Close)]);
    let t = script.serve().await;
    let mut es = t.event_source("/es");
    let got = events(&all(&mut es).await);
    assert_eq!(got, vec![OPEN, msg("a", ""), RETRYING, FAILED]);
    let gap = script.gap_ms(0, 1);
    assert!((3_000..4_500).contains(&gap), "{gap} ms");
}

#[tokio::test]
async fn a_non_200_fails_the_connection() {
    for code in [500, 404, 204, 201, 301, 307] {
        let script = Script::new(vec![status(code)]);
        let t = script.serve().await;
        let mut es = EventSource::open(t, "/es", opts(20));
        assert_eq!(
            all(&mut es).await,
            vec![(FAILED, ReadyState::Closed)],
            "{code}"
        );
        tokio::time::sleep(Duration::from_millis(200)).await;
        assert_eq!(script.connections(), 1, "{code}: no reconnect");
    }
}

#[tokio::test]
async fn the_content_type_must_be_text_event_stream() {
    for ct in [
        Some("text/plain"),
        Some("text/event-streamx"),
        Some("application/json"),
        None,
    ] {
        let mut conn = sse(vec![send("data: a\n\n")], End::Close);
        conn.content_type = ct;
        let script = Script::new(vec![conn]);
        let t = script.serve().await;
        let mut es = EventSource::open(t, "/es", opts(20));
        assert_eq!(
            all(&mut es).await,
            vec![(FAILED, ReadyState::Closed)],
            "{ct:?}"
        );
        tokio::time::sleep(Duration::from_millis(200)).await;
        assert_eq!(script.connections(), 1, "{ct:?}: no reconnect");
    }
    // The MIME essence, in any case, with parameters.
    for ct in ["TEXT/Event-Stream", "text/event-stream; charset=utf-8"] {
        let mut conn = sse(vec![send("data: a\n\n")], End::Close);
        conn.content_type = Some(ct);
        let script = Script::new(vec![conn]);
        let t = script.serve().await;
        let mut es = EventSource::open(t, "/es", opts(20));
        assert_eq!(
            events(&all(&mut es).await),
            vec![OPEN, msg("a", ""), RETRYING, FAILED],
            "{ct}"
        );
    }
}

#[tokio::test]
async fn close_mid_stream_drops_the_connection_and_every_event() {
    let script = Script::new(vec![sse(
        vec![
            send("data: 1\n\n"),
            Step::Wait(100),
            send("data: 2\n\ndata: 3\n\n"),
        ],
        End::Hold,
    )]);
    let t = script.serve().await;
    let mut es = EventSource::open(t, "/es", opts(20));
    assert_eq!(next(&mut es).await, Some(OPEN));
    assert_eq!(next(&mut es).await, Some(msg("1", "")));
    // Let 2 and 3 arrive and queue up, then close: neither is delivered.
    tokio::time::sleep(Duration::from_millis(400)).await;
    es.close();
    assert_eq!(es.ready_state(), ReadyState::Closed);
    assert_eq!(es.recv().await, None);
    assert_eq!(es.recv().await, None);
    // The server sees its body dropped (the connection closed) ...
    let t0 = Instant::now();
    while script.dropped.load(Ordering::SeqCst) == 0 {
        assert!(t0.elapsed() < Duration::from_secs(5), "body never dropped");
        tokio::time::sleep(Duration::from_millis(10)).await;
    }
    // ... and no reconnect.
    tokio::time::sleep(Duration::from_millis(200)).await;
    assert_eq!(script.connections(), 1);
}

#[tokio::test]
async fn close_while_waiting_to_reconnect_stops_it() {
    let script = Script::new(vec![sse(vec![send("data: a\n\n")], End::Close)]);
    let t = script.serve().await;
    let mut es = EventSource::open(t, "/es", opts(300));
    assert_eq!(next(&mut es).await, Some(OPEN));
    assert_eq!(next(&mut es).await, Some(msg("a", "")));
    assert_eq!(next(&mut es).await, Some(RETRYING));
    es.close();
    assert_eq!(es.recv().await, None);
    tokio::time::sleep(Duration::from_millis(700)).await;
    assert_eq!(script.connections(), 1);
}

#[tokio::test]
async fn dropping_the_handle_closes_it() {
    let script = Script::new(vec![sse(vec![send("data: 1\n\n")], End::Hold)]);
    let t = script.serve().await;
    let mut es = EventSource::open(t, "/es", opts(20));
    assert_eq!(next(&mut es).await, Some(OPEN));
    drop(es);
    let t0 = Instant::now();
    while script.dropped.load(Ordering::SeqCst) == 0 {
        assert!(t0.elapsed() < Duration::from_secs(5), "body never dropped");
        tokio::time::sleep(Duration::from_millis(10)).await;
    }
}

#[tokio::test]
async fn close_before_the_first_response() {
    let script = Script::new(vec![sse(
        vec![Step::Wait(300), send("data: 1\n\n")],
        End::Hold,
    )]);
    let t = script.serve().await;
    let mut es = EventSource::open(t, "/es", opts(20));
    es.close();
    assert_eq!(es.ready_state(), ReadyState::Closed);
    assert_eq!(es.recv().await, None);
}

#[tokio::test]
async fn a_body_that_breaks_off_reconnects() {
    let script = Script::new(vec![
        // The wait lets hyper flush the head and the chunk: a body that
        // fails at once can cost the head too.
        sse(
            vec![send("data: a\n\ndata: half"), Step::Wait(200)],
            End::Break,
        ),
        sse(vec![send("data: b\n\n")], End::Close),
    ]);
    let t = script.serve().await;
    let mut es = EventSource::open(t, "/es", opts(20));
    assert_eq!(
        events(&all(&mut es).await),
        vec![
            OPEN,
            msg("a", ""),
            // The unfinished event is dropped with the connection.
            RETRYING,
            OPEN,
            msg("b", ""),
            RETRYING,
            FAILED
        ]
    );
}

#[tokio::test]
async fn a_server_that_is_down_keeps_it_connecting() {
    // A port nothing listens on.
    let l = std::net::TcpListener::bind("127.0.0.1:0").unwrap();
    let addr = l.local_addr().unwrap();
    drop(l);
    let t: Arc<dyn Transport> = Arc::new(RemoteTransport::new(&format!("http://{addr}")).unwrap());
    let mut es = EventSource::open(t, "/es", opts(20));
    for _ in 0..5 {
        assert_eq!(next(&mut es).await, Some(RETRYING));
        assert_eq!(es.ready_state(), ReadyState::Connecting);
    }
    es.close();
    assert_eq!(es.recv().await, None);
}

#[tokio::test]
async fn framing_on_the_wire() {
    let script = Script::new(vec![
        sse(
            vec![
                // A BOM in its own chunk, then a CRLF split across chunks.
                Step::Send(vec![0xEF, 0xBB]),
                Step::Send(vec![0xBF]),
                send(": hello\r"),
                send("\ndata: one\r\ndata: two\r\n\r"),
                send("\n"),
                send("event: custom\rdata\r\r"),
                send("id: 5\nid: no\0pe\ndata:x\n\n"),
                send("retry: soon\nretry:\nretry: 1.5\n"),
                send("data:\n\nevent: x\n\n"),
                send("unknown: field\ndata : not data\ndata: after\n\n"),
                send("id: 6\ndata: unfinished"),
            ],
            End::Close,
        ),
        sse(vec![send("\u{feff}data: bom again\n\n")], End::Close),
    ]);
    let t = script.serve().await;
    let mut es = EventSource::open(t, "/es", opts(50));
    assert_eq!(
        events(&all(&mut es).await),
        vec![
            OPEN,
            msg("one\ntwo", ""),
            typed("", "custom", ""),
            msg("x", "5"),
            msg("", "5"),
            msg("after", "5"),
            RETRYING,
            OPEN,
            // Each connection's stream drops its own leading BOM.
            msg("bom again", "5"),
            RETRYING,
            FAILED,
        ]
    );
    // The bad `retry:` values were ignored: the 50 ms default held.
    assert!(script.gap_ms(0, 1) < 2_000);
    // `id: 6` was never dispatched.
    assert_eq!(script.header(1, "last-event-id").as_deref(), Some("5"));
}

#[tokio::test]
async fn last_event_id_is_sent_as_utf8() {
    let script = Script::new(vec![
        sse(vec![send("id: \u{e9}\u{1f600}\ndata: a\n\n")], End::Close),
        sse(vec![send("id\ndata: b\n\n")], End::Close),
    ]);
    let t = script.serve().await;
    let mut es = EventSource::open(t, "/es", opts(20));
    assert_eq!(
        events(&all(&mut es).await),
        vec![
            OPEN,
            msg("a", "\u{e9}\u{1f600}"),
            RETRYING,
            OPEN,
            // `id` with no value resets it to empty ...
            msg("b", ""),
            RETRYING,
            FAILED
        ]
    );
    assert_eq!(
        script.header(1, "last-event-id").as_deref(),
        Some("\u{e9}\u{1f600}")
    );
    // ... and an empty last event ID sends no header.
    assert_eq!(script.header(2, "last-event-id"), None);
}

#[tokio::test]
async fn retry_zero_reconnects_at_once() {
    let script = Script::new(vec![
        sse(vec![send("retry: 0\ndata: a\n\n")], End::Close),
        sse(vec![send("data: b\n\n")], End::Close),
    ]);
    let t = script.serve().await;
    let mut es = EventSource::open(t, "/es", opts(10_000));
    assert_eq!(
        events(&all(&mut es).await),
        vec![
            OPEN,
            msg("a", ""),
            RETRYING,
            OPEN,
            msg("b", ""),
            RETRYING,
            FAILED
        ]
    );
    assert!(script.gap_ms(0, 2) < 2_000);
}

#[tokio::test]
async fn in_process_runs_the_same_script() {
    let script = Script::new(vec![
        sse(vec![send("retry: 100\nid: 1\ndata: a\n\n")], End::Close),
        sse(vec![send("data: b\n\n")], End::Hold),
    ]);
    let t: Arc<dyn Transport> = Arc::new(InProcessTransport::from_router(script.router()));
    let mut es = EventSource::open(t, "/es", opts(10_000));
    for want in [OPEN, msg("a", "1"), RETRYING, OPEN, msg("b", "1")] {
        assert_eq!(next(&mut es).await, Some(want));
    }
    assert_eq!(script.header(1, "last-event-id").as_deref(), Some("1"));
    assert!(script.gap_ms(0, 1) >= 100);
    // Closing drops the router's body at once, though it waits for a chunk
    // that never comes.
    es.close();
    let t0 = Instant::now();
    while script.dropped.load(Ordering::SeqCst) == 0 {
        assert!(t0.elapsed() < Duration::from_secs(5), "body never dropped");
        tokio::time::sleep(Duration::from_millis(10)).await;
    }
    assert_eq!(script.connections(), 2);
}

#[tokio::test]
async fn an_id_no_header_can_carry_fails_the_source() {
    // `HeaderValue` refuses a control byte, so the reconnect can't be
    // sent: the source fails instead of retrying the same request forever.
    let script = Script::new(vec![sse(
        vec![send("id: a\u{1}b\ndata: x\n\n")],
        End::Close,
    )]);
    let t = script.serve().await;
    let mut es = EventSource::open(t, "/es", opts(20));
    assert_eq!(
        events(&all(&mut es).await),
        vec![OPEN, msg("x", "a\u{1}b"), RETRYING, FAILED]
    );
    assert_eq!(script.connections(), 1);
}

#[tokio::test]
async fn a_url_off_the_origin_fails_at_once() {
    let script = Script::new(vec![]);
    let t = script.serve().await;
    for url in ["http://127.0.0.1:1/es", "//elsewhere.test/es"] {
        let mut es = EventSource::open(t.clone(), url, opts(20));
        assert_eq!(
            all(&mut es).await,
            vec![(FAILED, ReadyState::Closed)],
            "{url}"
        );
    }
    assert_eq!(script.connections(), 0);
}

// ── the undici golden ────────────────────────────────────────────────────────

fn unhex(s: &str) -> Vec<u8> {
    (0..s.len())
        .step_by(2)
        .map(|i| u8::from_str_radix(&s[i..i + 2], 16).unwrap())
        .collect()
}

fn hex(b: &[u8]) -> String {
    b.iter().map(|b| format!("{b:02x}")).collect()
}

/// A recorded connection as a script one: its chunks (paced like the
/// recorder's server), the wait before its end, and the end.
fn conn_of(c: &serde_json::Value) -> Conn {
    let mut steps = Vec::new();
    for chunk in c["chunks"].as_array().unwrap() {
        steps.push(Step::Send(unhex(chunk.as_str().unwrap())));
        steps.push(Step::Wait(5));
    }
    let wait = c["waitBeforeEnd"].as_u64().unwrap();
    if wait > 0 {
        steps.push(Step::Wait(wait));
    }
    Conn {
        status: u16::try_from(c["status"].as_u64().unwrap()).unwrap(),
        content_type: c["contentType"]
            .as_str()
            .map(|s| &*Box::leak(s.to_owned().into_boxed_str())),
        steps,
        end: match c["end"].as_str().unwrap() {
            "close" => End::Close,
            "hold" => End::Hold,
            "destroy" => End::Break,
            other => panic!("end {other}"),
        },
    }
}

/// An event as the recorder writes it, with the `readyState` read after it.
fn recorded(ev: &EventSourceEvent, rs: ReadyState) -> serde_json::Value {
    let rs = rs.as_number();
    match ev {
        EventSourceEvent::Open => serde_json::json!({"type": "open", "readyState": rs}),
        EventSourceEvent::Error { .. } => serde_json::json!({"type": "error", "readyState": rs}),
        EventSourceEvent::Message {
            data,
            event_type,
            last_event_id,
        } => serde_json::json!({
            "type": "message",
            "eventType": event_type,
            "data": data,
            "lastEventId": last_event_id,
            "readyState": rs,
        }),
    }
}

/// `scripts/eventsource-golden.mjs`: every scenario's events and request
/// headers, as undici's EventSource saw and sent them.
#[tokio::test]
async fn replays_the_undici_golden() {
    let path = std::path::Path::new(env!("CARGO_MANIFEST_DIR"))
        .join("tests/fixtures/eventsource_golden.json");
    let fx: serde_json::Value =
        serde_json::from_str(&std::fs::read_to_string(path).unwrap()).unwrap();
    let mut failures = Vec::new();
    let scenarios = fx["scenarios"].as_array().unwrap();
    for sc in scenarios {
        let name = sc["name"].as_str().unwrap();
        let conns = sc["conns"]
            .as_array()
            .unwrap()
            .iter()
            .map(conn_of)
            .collect();
        let script = Script::new(conns);
        let t = script.serve().await;
        let retry = sc["defaultRetry"].as_u64().unwrap();
        let mut es = EventSource::open(t, "/es", opts(retry));
        let close_after = sc["closeAfter"].as_u64().map(|n| n as usize);
        let mut got = Vec::new();
        while let Some(ev) = next(&mut es).await {
            assert!(got.len() < 100, "{name}: no end");
            got.push(recorded(&ev, es.ready_state()));
            if close_after == Some(got.len()) {
                es.close();
            }
        }
        // As the recorder waits after the end: nothing more, no request.
        tokio::time::sleep(Duration::from_millis(300)).await;
        if got != *sc["events"].as_array().unwrap() {
            failures.push(format!(
                "{name}: events\n  got  {got:?}\n  want {}",
                sc["events"]
            ));
        }
        let seen: Vec<serde_json::Value> = (0..script.connections())
            .map(|i| {
                let h = |k: &str| {
                    script.seen.lock().unwrap()[i]
                        .headers
                        .get(k)
                        .map(|v| hex(v.as_bytes()))
                };
                serde_json::json!({
                    "accept": h("accept"),
                    "cacheControl": h("cache-control"),
                    "pragma": h("pragma"),
                    "lastEventId": h("last-event-id"),
                })
            })
            .collect();
        if seen != *sc["requests"].as_array().unwrap() {
            failures.push(format!(
                "{name}: requests\n  got  {seen:?}\n  want {}",
                sc["requests"]
            ));
        }
    }
    assert!(
        failures.is_empty(),
        "{} of {} scenarios differ from undici:\n{}",
        failures.len(),
        scenarios.len(),
        failures.join("\n")
    );
}
