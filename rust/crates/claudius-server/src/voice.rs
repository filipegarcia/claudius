//! The dictation routes (D25): port of `app/api/voice/stream/route.ts`
//! (GET, the SSE), `voice/chunk` and `voice/close` (POST), over
//! [`claudius_core::voice_stream`].
//!
//! Every route takes `?id=` (`searchParams.get`, first value, form-decoded)
//! and refuses one that isn't 8–64 of `[a-zA-Z0-9_-]`: the stream with a
//! plain-text 400 `invalid or missing id`, the posts with `{"error":"invalid
//! id"}`.
//!
//! The stream answers `retry: 3600000\n\n` first, then each sink frame as
//! `event: NAME\ndata: PAYLOAD\n\n` (the payload as it is, newlines
//! included), and `: ping\n\n` every 15 s. It ends when the session closes
//! its sink, or after `open-failed` `{"kind","message"}` when opening threw.
//! A client that goes away before the end closes the session as
//! `client-abort` (Next aborts `req.signal` only when the response hadn't
//! finished, so a stream that ended on its own, such as a duplicate id's
//! `open-failed`, leaves the live session alone).
//!
//! `chunk` checks `Content-Length` (> 1 MiB is 413 `chunk too large`)
//! before reading, then the bytes: none is 400 `empty chunk`, more than
//! 1 MiB 413; a session that isn't live and OPEN is 410 `session gone`, else
//! 204. `close` is 410 or 204 (`finalizeVoiceSession`).
//!
//! Where it differs: the body is read only up to the 1 MiB cap (TS reads
//! all of it, then answers the same 413); a body that fails mid-read is
//! Next's empty 500 on both.

use std::convert::Infallible;
use std::pin::Pin;
use std::sync::{Arc, Mutex};
use std::task::{Context, Poll};
use std::time::Duration;

use axum::Router;
use axum::body::{Body, Bytes};
use axum::extract::RawQuery;
use axum::http::{HeaderMap, HeaderValue, StatusCode, header};
use axum::response::{IntoResponse, Response};
use axum::routing::{get, post};
use claudius_agent::js;
use claudius_core::voice_stream::{self, SseSink};
use futures::{Stream, StreamExt};
use serde_json::json;
use tokio::sync::mpsc;
use tokio::task::JoinHandle;

use crate::AppState;
use crate::body::thrown;
use crate::session_transcript::search_param;

pub fn router() -> Router<AppState> {
    Router::new()
        .route("/api/voice/stream", get(stream))
        .route("/api/voice/chunk", post(chunk))
        .route("/api/voice/close", post(close))
}

/// `MAX_CHUNK_BYTES`.
pub const MAX_CHUNK_BYTES: usize = 1_048_576;
/// The stream's heartbeat period.
pub const HEARTBEAT: Duration = Duration::from_secs(15);
const RETRY: &[u8] = b"retry: 3600000\n\n";
const PING: &[u8] = b": ping\n\n";

/// `!id || !/^[a-zA-Z0-9_-]{8,64}$/.test(id)` → `None`.
fn valid_id(q: Option<&str>) -> Option<String> {
    search_param(q, "id").filter(|id| {
        (8..=64).contains(&id.len())
            && id
                .bytes()
                .all(|b| b.is_ascii_alphanumeric() || b == b'_' || b == b'-')
    })
}

fn json_error(status: StatusCode, msg: &str) -> Response {
    (
        status,
        [(header::CONTENT_TYPE, "application/json")],
        js::stringify(&json!({"error": msg})),
    )
        .into_response()
}

// ---- GET /api/voice/stream --------------------------------------------------

/// The route's `SseSink` over the response body.
struct BodySink {
    tx: Mutex<Option<mpsc::UnboundedSender<Bytes>>>,
}

impl BodySink {
    fn enqueue(&self, bytes: Bytes) -> bool {
        match self.tx.lock() {
            Ok(tx) => tx.as_ref().is_some_and(|tx| tx.send(bytes).is_ok()),
            Err(_) => false,
        }
    }
}

impl SseSink for BodySink {
    fn send(&self, event: &str, data: &str) {
        self.enqueue(Bytes::from(format!("event: {event}\ndata: {data}\n\n")));
    }

    fn close(&self) {
        if let Ok(mut tx) = self.tx.lock() {
            tx.take();
        }
    }
}

/// The response body: the sink's frames until it closes. Dropped before
/// that (the client went away), it closes the session as `client-abort`.
struct VoiceBody {
    id: String,
    rx: mpsc::UnboundedReceiver<Bytes>,
    heartbeat: JoinHandle<()>,
    finished: bool,
}

impl Stream for VoiceBody {
    type Item = Result<Bytes, Infallible>;

    fn poll_next(mut self: Pin<&mut Self>, cx: &mut Context<'_>) -> Poll<Option<Self::Item>> {
        match self.rx.poll_recv(cx) {
            Poll::Ready(Some(b)) => Poll::Ready(Some(Ok(b))),
            Poll::Ready(None) => {
                self.finished = true;
                Poll::Ready(None)
            }
            Poll::Pending => Poll::Pending,
        }
    }
}

impl Drop for VoiceBody {
    fn drop(&mut self) {
        self.heartbeat.abort();
        if !self.finished {
            voice_stream::close_session(&self.id, "client-abort");
        }
    }
}

async fn stream(RawQuery(q): RawQuery) -> Response {
    let q = q.as_deref();
    let Some(id) = valid_id(q) else {
        return (
            StatusCode::BAD_REQUEST,
            [(header::CONTENT_TYPE, "text/plain;charset=UTF-8")],
            "invalid or missing id",
        )
            .into_response();
    };
    let language = search_param(q, "lang")
        .filter(|l| !l.is_empty())
        .unwrap_or_else(|| "en".to_owned());

    let (tx, rx) = mpsc::unbounded_channel();
    let _ = tx.send(Bytes::from_static(RETRY));
    let sink = Arc::new(BodySink {
        tx: Mutex::new(Some(tx)),
    });
    let heartbeat = {
        let sink = Arc::clone(&sink);
        tokio::spawn(async move {
            let mut tick =
                tokio::time::interval_at(tokio::time::Instant::now() + HEARTBEAT, HEARTBEAT);
            tick.set_missed_tick_behavior(tokio::time::MissedTickBehavior::Delay);
            loop {
                tick.tick().await;
                if !sink.enqueue(Bytes::from_static(PING)) {
                    return;
                }
            }
        })
    };
    if let Err(message) = voice_stream::open_voice_session(&id, sink.clone(), Some(&language), &[])
    {
        sink.send(
            "error",
            &js::stringify(&json!({"kind": "open-failed", "message": message})),
        );
        heartbeat.abort();
        sink.close();
    }
    let body = VoiceBody {
        id,
        rx,
        heartbeat,
        finished: false,
    };
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

// ---- POST /api/voice/chunk --------------------------------------------------

async fn chunk(RawQuery(q): RawQuery, headers: HeaderMap, body: Body) -> Response {
    let Some(id) = valid_id(q.as_deref()) else {
        return json_error(StatusCode::BAD_REQUEST, "invalid id");
    };
    // `Number(req.headers.get("content-length") ?? "0") > MAX_CHUNK_BYTES`.
    let declared = headers
        .get(header::CONTENT_LENGTH)
        .and_then(|v| v.to_str().ok())
        .map_or(0.0, js::to_number);
    if declared > MAX_CHUNK_BYTES as f64 {
        return json_error(StatusCode::PAYLOAD_TOO_LARGE, "chunk too large");
    }
    let mut buf = Vec::new();
    let mut data = body.into_data_stream();
    while let Some(part) = data.next().await {
        match part {
            Ok(bytes) => {
                buf.extend_from_slice(&bytes);
                if buf.len() > MAX_CHUNK_BYTES {
                    return json_error(StatusCode::PAYLOAD_TOO_LARGE, "chunk too large");
                }
            }
            Err(_) => return thrown(),
        }
    }
    if buf.is_empty() {
        return json_error(StatusCode::BAD_REQUEST, "empty chunk");
    }
    if !voice_stream::push_audio_chunk(&id, buf) {
        return json_error(StatusCode::GONE, "session gone");
    }
    StatusCode::NO_CONTENT.into_response()
}

// ---- POST /api/voice/close --------------------------------------------------

async fn close(RawQuery(q): RawQuery) -> Response {
    let Some(id) = valid_id(q.as_deref()) else {
        return json_error(StatusCode::BAD_REQUEST, "invalid id");
    };
    if !voice_stream::finalize_voice_session(&id) {
        return json_error(StatusCode::GONE, "session gone");
    }
    StatusCode::NO_CONTENT.into_response()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn ids_the_routes_take() {
        for ok in ["abcdefgh", "A-b_9-zZ", &"x".repeat(64)] {
            assert_eq!(
                valid_id(Some(&format!("id={ok}"))).as_deref(),
                Some(ok),
                "{ok}"
            );
        }
        for bad in [
            "",
            "id=",
            "id=abcdefg",
            &format!("id={}", "x".repeat(65)),
            "id=abcd%20efgh",
            "id=abcdefg%C3%A9",
            "id=abcdefgh%0A",
        ] {
            assert_eq!(valid_id(Some(bad)), None, "{bad}");
        }
        // The first `id` wins, form-decoded.
        assert_eq!(
            valid_id(Some("id=abcd%2Defgh&id=zzzzzzzz")).as_deref(),
            Some("abcd-efgh")
        );
    }
}
