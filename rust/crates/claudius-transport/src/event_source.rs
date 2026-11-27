//! A browser `EventSource` (WHATWG HTML §9.2, "Server-sent events") over a
//! [`Transport`], as Chromium runs one.
//!
//! **Requests.** `GET` with `Accept: text/event-stream`, `Cache-Control:
//! no-cache` and `Pragma: no-cache` (Chromium's header and the two fetch
//! adds for a `no-store` request), the page's cookies, and on a reconnect
//! `Last-Event-ID` (UTF-8) when the last event ID isn't empty.
//!
//! **The connection's life.**
//! - A response that is a 200 with a `Content-Type` whose MIME essence is
//!   `text/event-stream` (any case, any parameters) is *announced*: `open`,
//!   then its messages as they are parsed ([`crate::sse`]).
//! - Any other response *fails the connection*: `error` with the state
//!   `CLOSED`, and nothing after it.
//! - No response (refused, reset), or a body that ends or breaks off,
//!   *reestablishes* it: `error` with the state `CONNECTING`, then after the
//!   reconnection time (3000 ms, Chromium's default, or the stream's last
//!   `retry:`) a new request. A server that stays down keeps it cycling
//!   there, never reaching `CLOSED`, as in Chromium.
//! - [`EventSource::close`] (or dropping the handle) stops it at once: the
//!   request or body in flight is dropped, a pending reconnect never
//!   happens, and no queued event is delivered.
//!
//! **What a host sees.** [`EventSource::recv`] (or the [`Stream`] impl)
//! yields the events in the order the browser dispatches them. Each is a
//! queued task in the browser, so [`EventSource::ready_state`] moves when
//! the host takes the event, not when the network got there: an `error`
//! carries the state it set, and `ready_state()` reads it from then on.
//! Mapping onto `claudius-client` (U01k's host inputs):
//! - [`EventSourceEvent::Open`] → `ChatState::event_source_open(id, env)`;
//! - [`EventSourceEvent::Message`] whose `event_type` is `"message"` →
//!   `event_source_message(id, &data, env)` (`onmessage` sees only that
//!   type; the server never sends an `event:` line);
//! - [`EventSourceEvent::Error`] → `event_source_error(id, ready_state,
//!   env)`.
//!
//! Not emulated: redirects (the transports don't follow them, so a 3xx
//! fails the connection; no route redirects), Chromium's refusal of a
//! `charset` other than UTF-8 (the spec ignores it), CORS (one origin), and
//! the 6-connections-per-host limit of a browser's HTTP/1.1 pool.

use std::pin::Pin;
use std::sync::Arc;
use std::task::{Context, Poll};
use std::time::Duration;

use futures::{Stream, StreamExt};
use http::HeaderMap;
use http::header::CONTENT_TYPE;
use tokio::sync::mpsc;
use tokio::task::JoinHandle;

use crate::sse::{Parsed, Parser};
use crate::{Request, Transport};

/// `EventSource.readyState`.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash)]
pub enum ReadyState {
    Connecting,
    Open,
    Closed,
}

impl ReadyState {
    /// `EventSource.CONNECTING` / `OPEN` / `CLOSED`: 0, 1, 2.
    pub fn as_number(self) -> u16 {
        match self {
            Self::Connecting => 0,
            Self::Open => 1,
            Self::Closed => 2,
        }
    }
}

/// An event an [`EventSource`] dispatches.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum EventSourceEvent {
    /// `open`: a connection was announced.
    Open,
    /// A `MessageEvent`: `type` (`"message"` unless an `event:` line said
    /// otherwise), `data` and `lastEventId`.
    Message {
        data: String,
        event_type: String,
        last_event_id: String,
    },
    /// `error`, with the `readyState` it leaves: `Connecting` before a
    /// reconnect, `Closed` when the connection failed for good.
    Error { ready_state: ReadyState },
}

/// What isn't the browser's API but a host may want to set.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct EventSourceOptions {
    /// The reconnection time until a `retry:` field sets it (Chromium:
    /// 3000 ms).
    pub default_retry: Duration,
}

impl Default for EventSourceOptions {
    fn default() -> Self {
        Self {
            default_retry: Duration::from_millis(3000),
        }
    }
}

/// `new EventSource(url)`: a handle to one event source. Dropping it
/// closes it.
pub struct EventSource {
    url: String,
    rx: mpsc::UnboundedReceiver<EventSourceEvent>,
    task: JoinHandle<()>,
    ready_state: ReadyState,
}

impl std::fmt::Debug for EventSource {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.debug_struct("EventSource")
            .field("url", &self.url)
            .field("ready_state", &self.ready_state)
            .finish_non_exhaustive()
    }
}

impl EventSource {
    /// Start connecting to `url` (origin-relative) over `transport`. Must
    /// be called inside a tokio runtime: the connection runs on a task.
    pub fn open(
        transport: Arc<dyn Transport>,
        url: impl Into<String>,
        opts: EventSourceOptions,
    ) -> Self {
        let url = url.into();
        let (tx, rx) = mpsc::unbounded_channel();
        let task = tokio::spawn(run(transport, url.clone(), opts, tx));
        Self {
            url,
            rx,
            task,
            ready_state: ReadyState::Connecting,
        }
    }

    /// `EventSource.url` (as given, origin-relative).
    pub fn url(&self) -> &str {
        &self.url
    }

    /// `EventSource.readyState`, as of the last event taken (see the
    /// module docs).
    pub fn ready_state(&self) -> ReadyState {
        self.ready_state
    }

    /// The next event, or `None` once closed or failed (after its
    /// `error`).
    pub async fn recv(&mut self) -> Option<EventSourceEvent> {
        std::future::poll_fn(|cx| self.poll_event(cx)).await
    }

    /// `EventSource.close()`: no event after this one call, and no more
    /// requests.
    pub fn close(&mut self) {
        self.task.abort();
        self.ready_state = ReadyState::Closed;
    }

    fn poll_event(&mut self, cx: &mut Context<'_>) -> Poll<Option<EventSourceEvent>> {
        if self.ready_state == ReadyState::Closed {
            return Poll::Ready(None);
        }
        let ev = std::task::ready!(self.rx.poll_recv(cx));
        match &ev {
            Some(EventSourceEvent::Open) => self.ready_state = ReadyState::Open,
            Some(EventSourceEvent::Error { ready_state }) => self.ready_state = *ready_state,
            Some(EventSourceEvent::Message { .. }) => {}
            // The task ended without failing: it only does after the
            // receiver is gone, so not seen here; read it as closed.
            None => self.ready_state = ReadyState::Closed,
        }
        Poll::Ready(ev)
    }
}

impl Stream for EventSource {
    type Item = EventSourceEvent;

    fn poll_next(self: Pin<&mut Self>, cx: &mut Context<'_>) -> Poll<Option<Self::Item>> {
        self.get_mut().poll_event(cx)
    }
}

impl Drop for EventSource {
    fn drop(&mut self) {
        self.task.abort();
    }
}

/// Whether the response's `Content-Type` is `text/event-stream`: the
/// header (several joined by `", "`, as fetch's header list reads them)
/// parsed as a MIME type (WHATWG MIME Sniffing "parse a MIME type"), its
/// essence compared. A value that doesn't parse is not.
pub(crate) fn is_event_stream(headers: &HeaderMap) -> bool {
    let values: Vec<String> = headers
        .get_all(CONTENT_TYPE)
        .iter()
        .map(|v| v.as_bytes().iter().map(|&b| char::from(b)).collect())
        .collect();
    if values.is_empty() {
        return false;
    }
    mime_essence(&values.join(", ")).is_some_and(|e| e == "text/event-stream")
}

/// "Parse a MIME type" far enough for its essence (`type/subtype`,
/// lowercase): the input trimmed of HTTP whitespace, the type up to `/`,
/// the subtype up to `;` less trailing whitespace; `None` without a `/`.
/// The algorithm's token checks are left out: a type or subtype they refuse
/// can't make the essence `text/event-stream` anyway.
fn mime_essence(input: &str) -> Option<String> {
    let http_ws = ['\t', '\n', '\r', ' '];
    let s = input.trim_matches(http_ws);
    let (ty, rest) = s.split_once('/')?;
    let subtype = rest.split(';').next().unwrap_or_default();
    let subtype = subtype.trim_end_matches(http_ws);
    Some(format!("{ty}/{subtype}").to_ascii_lowercase())
}

/// The connection loop (see the module docs). Ends when the connection
/// fails or the handle is gone.
async fn run(
    transport: Arc<dyn Transport>,
    url: String,
    opts: EventSourceOptions,
    tx: mpsc::UnboundedSender<EventSourceEvent>,
) {
    let mut retry = opts.default_retry;
    let mut last_event_id = String::new();
    let mut parsed = Vec::new();
    loop {
        let mut req = Request::get(&url)
            .header("accept", "text/event-stream")
            .header("cache-control", "no-cache")
            .header("pragma", "no-cache");
        if !last_event_id.is_empty() {
            req = req.header("last-event-id", latin1_of_utf8(&last_event_id));
        }
        match transport.send(req).await {
            Err(crate::TransportError::Invalid(_)) => {
                // Not a request a page could make (an id `Headers` refuses,
                // say): fail rather than retry the same one forever.
                let _ = tx.send(EventSourceEvent::Error {
                    ready_state: ReadyState::Closed,
                });
                return;
            }
            Err(_) => {}
            Ok(res) => {
                if res.status != 200 || !is_event_stream(&res.headers) {
                    let _ = tx.send(EventSourceEvent::Error {
                        ready_state: ReadyState::Closed,
                    });
                    return;
                }
                if tx.send(EventSourceEvent::Open).is_err() {
                    return;
                }
                let mut parser = Parser::new(last_event_id.as_str());
                let mut body = res.body;
                while let Some(Ok(chunk)) = body.next().await {
                    parser.feed(&chunk, &mut parsed);
                    for p in parsed.drain(..) {
                        match p {
                            Parsed::Retry(ms) => retry = Duration::from_millis(ms),
                            Parsed::Message {
                                data,
                                event_type,
                                last_event_id,
                            } => {
                                let ev = EventSourceEvent::Message {
                                    data,
                                    event_type,
                                    last_event_id,
                                };
                                if tx.send(ev).is_err() {
                                    return;
                                }
                            }
                        }
                    }
                }
                last_event_id = parser.last_event_id().to_owned();
            }
        }
        // Reestablish the connection.
        let ev = EventSourceEvent::Error {
            ready_state: ReadyState::Connecting,
        };
        if tx.send(ev).is_err() {
            return;
        }
        tokio::time::sleep(retry).await;
    }
}

/// The header value for `Last-Event-ID`: the id's UTF-8 bytes, which a
/// [`Request`] header (a latin1 string, one char per byte) carries as is.
fn latin1_of_utf8(id: &str) -> String {
    id.bytes().map(char::from).collect()
}

#[cfg(test)]
mod tests {
    use super::*;

    fn ct(values: &[&str]) -> HeaderMap {
        let mut h = HeaderMap::new();
        for v in values {
            h.append(CONTENT_TYPE, v.parse().unwrap());
        }
        h
    }

    #[test]
    fn content_type_is_the_mime_essence() {
        for ok in [
            "text/event-stream",
            "TEXT/Event-Stream",
            "text/event-stream; charset=utf-8",
            "text/event-stream;charset=latin1",
            " text/event-stream ",
            "text/event-stream ; x=y",
            "text/event-stream;",
        ] {
            assert!(is_event_stream(&ct(&[ok])), "{ok:?}");
        }
        for bad in [
            "text/plain",
            "text/event-streamx",
            "text/event",
            "text /event-stream",
            "text/event stream",
            "event-stream",
            "/event-stream",
            "text/",
            "",
            "text/event-stream, text/plain",
        ] {
            assert!(!is_event_stream(&ct(&[bad])), "{bad:?}");
        }
        assert!(!is_event_stream(&HeaderMap::new()));
        // Two headers are read as one joined value, which doesn't parse.
        assert!(!is_event_stream(&ct(&[
            "text/event-stream",
            "text/event-stream"
        ])));
    }

    #[test]
    fn ready_state_numbers() {
        assert_eq!(
            [ReadyState::Connecting, ReadyState::Open, ReadyState::Closed]
                .map(ReadyState::as_number),
            [0, 1, 2]
        );
    }

    #[test]
    fn last_event_id_goes_out_as_its_utf8_bytes() {
        assert_eq!(latin1_of_utf8("a\u{e9}"), "a\u{c3}\u{a9}");
    }
}
