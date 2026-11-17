//! The dictation proxy's sessions: port of `lib/server/voice-stream.ts`
//! (D25).
//!
//! The renderer never sees the OAuth token. It opens `/api/voice/stream`
//! (the SSE side, [`open_voice_session`]), posts PCM to `/api/voice/chunk`
//! ([`push_audio_chunk`]) and ends with `/api/voice/close`
//! ([`finalize_voice_session`]); this side holds the upstream WebSocket
//! ([`crate::voice_ws`]) to `$VOICE_STREAM_BASE_URL` (read once, default
//! `wss://api.anthropic.com`) + `/api/ws/speech_to_text/voice_stream`, with
//! the TS's query string (`URLSearchParams` form encoding of `language`).
//!
//! Mirrored:
//! - the process-wide session map keyed by id: a second open for a live id
//!   is `voice session <id> already exists` (checked again, atomically,
//!   where the TS re-checks after its awaits);
//! - no active profile, a profile that isn't `oauth-token`, or an empty
//!   secret → `error` `{"kind":"no-auth"}`, the sink closed, then the throw
//!   (`no Claude.ai OAuth account is currently active`); an accounts file
//!   that doesn't read or parse throws its own message;
//! - the upstream's events: `open` → a `KeepAlive` up and `ready`
//!   `{"id":…}` down; text frames relayed verbatim as `message`; `error` →
//!   `{"kind":"upstream","message":…}` plus CC 2.1.309's `hint` for a
//!   CA-trust failure ([`crate::tls_cert_hint`], "configured" when the
//!   settings-only bundle was applied or `NODE_EXTRA_CA_CERTS` is set),
//!   then `closeSession(id, "upstream-error")`; `close` → `{"code","reason"}`
//!   then `closeSession(id, "upstream-close-<code>")`. Each handler closes
//!   *by id*, as the TS does;
//! - a `KeepAlive` every second while OPEN, and the idle reaper (every 5 s,
//!   a session with no chunk / finalize for more than 30 s is closed as
//!   `idle-timeout`, whose CC 2.1.307 self-stop `close` frame is
//!   `{"code":null,"reason":"idle-timeout"}`);
//! - `closeSession`: once per session, the self-stop frame, the timers
//!   stopped, `close(1000, reason)` when CONNECTING or OPEN, the sink closed,
//!   the entry removed.
//!
//! The socket's trust (`socket_trust`): with the settings-only bundle, TS's
//! `ca`; else Node's default store, which holds what a `NODE_EXTRA_CA_CERTS`
//! set in the real environment added once, at startup: here the process's
//! roots ([`crate::extra_ca_env::process_roots`], I23), read with Node's
//! rules when the binary boots, shared with [`crate::fetch::HttpsClient`]
//! and never read again.
//!
//! Where it differs: the Bun branch of `openUpstream` (and its warning) is
//! not ported, as the packaged and `next dev` runtimes are Node. Replayed
//! against the TS routes by `claudius-server/tests/voice.rs`.

use std::sync::atomic::{AtomicBool, AtomicI64, Ordering};
use std::sync::{Arc, LazyLock, Mutex, MutexGuard};
use std::time::Duration;

use claudius_agent::js;
use serde_json::{Map, Value, json};
use tokio::task::JoinHandle;

use crate::accounts::{AccountKind, AccountsStore};
use crate::voice_ws::{self, CONNECTING, Event, OPEN, Trust, Upstream};
use crate::{extra_ca_certs, log, now_ms, tls_cert_hint};

/// The variable the TS (and the CLI) reads the endpoint's origin from.
pub const BASE_URL_ENV: &str = "VOICE_STREAM_BASE_URL";
/// `VOICE_BASE_URL`'s fallback.
pub const DEFAULT_BASE_URL: &str = "wss://api.anthropic.com";
/// `VOICE_PATH`.
pub const VOICE_PATH: &str = "/api/ws/speech_to_text/voice_stream";
/// `SESSION_IDLE_TIMEOUT_MS`.
pub const SESSION_IDLE_TIMEOUT_MS: i64 = 30_000;
/// The idle reaper's `setInterval` period.
pub const IDLE_CHECK: Duration = Duration::from_secs(5);
/// `UPSTREAM_KEEPALIVE_MS`.
pub const UPSTREAM_KEEPALIVE: Duration = Duration::from_secs(1);

const KEEPALIVE: &str = r#"{"type":"KeepAlive"}"#;
const CLOSE_STREAM: &str = r#"{"type":"CloseStream"}"#;

/// `VOICE_BASE_URL`: `process.env.VOICE_STREAM_BASE_URL || …`, read once.
static BASE_URL: LazyLock<String> = LazyLock::new(|| {
    std::env::var_os(BASE_URL_ENV)
        .map(|v| v.to_string_lossy().into_owned())
        .filter(|v| !v.is_empty())
        .unwrap_or_else(|| DEFAULT_BASE_URL.to_owned())
});

/// The SSE writer (`SseSink`): the route wires it to its response body.
/// Both calls are no-ops once the stream is gone.
pub trait SseSink: Send + Sync {
    fn send(&self, event: &str, data: &str);
    fn close(&self);
}

struct VoiceSession {
    id: String,
    upstream: Upstream,
    sink: Arc<dyn SseSink>,
    /// `lastActivityAt` (ms since the epoch).
    last_activity_at: AtomicI64,
    closed: AtomicBool,
    /// The idle reaper and the keep-alive (`clearInterval` on close).
    timers: Mutex<Vec<JoinHandle<()>>>,
}

/// `sessions` (on `globalThis` in the TS): insertion-ordered, as the
/// `pushAudioChunk` log lists the known ids.
static SESSIONS: Mutex<Vec<Arc<VoiceSession>>> = Mutex::new(Vec::new());

fn sessions() -> MutexGuard<'static, Vec<Arc<VoiceSession>>> {
    SESSIONS.lock().unwrap_or_else(|e| e.into_inner())
}

fn lookup(id: &str) -> Option<Arc<VoiceSession>> {
    sessions().iter().find(|s| s.id == id).cloned()
}

/// `hasVoiceSession(id)`.
pub fn has_voice_session(id: &str) -> bool {
    lookup(id).is_some()
}

/// `resolveActiveOauthToken()`: the active profile's secret when it is an
/// `oauth-token` profile (an empty one is no token).
fn resolve_active_oauth_token() -> Result<Option<String>, String> {
    let cur = AccountsStore::from_env().read_raw().map_err(|e| e.0)?;
    let Some(active) = cur.active_profile_id.as_deref() else {
        return Ok(None);
    };
    Ok(cur
        .profiles
        .iter()
        .find(|p| p.id() == active)
        .filter(|p| p.kind() == AccountKind::OauthToken)
        .map(|p| p.secret().to_owned())
        .filter(|s| !s.is_empty()))
}

/// `buildUpstreamUrl(language)` on a given origin.
pub fn build_upstream_url(base: &str, language: &str) -> String {
    let params = url::form_urlencoded::Serializer::new(String::new())
        .append_pair("encoding", "linear16")
        .append_pair("sample_rate", "16000")
        .append_pair("channels", "1")
        .append_pair("endpointing_ms", "300")
        .append_pair("utterance_end_ms", "1000")
        .append_pair("language", language)
        .append_pair("use_conversation_engine", "true")
        .append_pair("forward_interims", "typed")
        .append_pair("stt_provider", "deepgram-nova3")
        .finish();
    format!("{base}{VOICE_PATH}?{params}")
}

/// What the socket trusts on top of the OS roots: the settings-only bundle
/// the TS passes as `ca`, else Node's default store with the roots a
/// real-environment `NODE_EXTRA_CA_CERTS` added at startup (the process's,
/// not re-read).
fn socket_trust(settings_ca: Option<String>) -> Trust {
    match settings_ca {
        Some(pem) => Trust::Ca(pem),
        None => Trust::process_default(),
    }
}

/// `openVoiceSession(id, sink, { language, keyterms })`. `Err` is the
/// message of what the TS throws; the route answers it as `open-failed`.
/// Needs a tokio runtime: the socket, its event relay and the two timers
/// run as tasks.
pub fn open_voice_session(
    id: &str,
    sink: Arc<dyn SseSink>,
    language: Option<&str>,
    keyterms: &[String],
) -> Result<(), String> {
    let exists = || format!("voice session {id} already exists");
    if has_voice_session(id) {
        return Err(exists());
    }
    let Some(token) = resolve_active_oauth_token()? else {
        sink.send("error", &js::stringify(&json!({"kind": "no-auth"})));
        sink.close();
        return Err("no Claude.ai OAuth account is currently active".to_owned());
    };
    let url = build_upstream_url(&BASE_URL, language.unwrap_or("en"));
    let mut headers = vec![("Authorization".to_owned(), format!("Bearer {token}"))];
    if !keyterms.is_empty() {
        headers.push(("x-config-keyterms".to_owned(), keyterms.join(",")));
    }
    tracing::info!(
        target: log::API,
        "[voice:{id}] openVoiceSession url={} ...?<params>",
        url.split('?').next().unwrap_or_default()
    );
    let ca = extra_ca_certs::resolve_extra_ca_certs();
    let extra_ca_configured = ca.is_some() || extra_ca_certs::env_set();

    // The re-check, the socket and the registration happen under one lock
    // (TS: synchronously after its last await).
    let mut map = sessions();
    if map.iter().any(|s| s.id == id) {
        return Err(exists());
    }
    // The `open` handler's first `KeepAlive` goes out as the socket opens.
    let (upstream, events) =
        voice_ws::open(&url, &headers, socket_trust(ca), Some(KEEPALIVE.to_owned()))?;
    let session = Arc::new(VoiceSession {
        id: id.to_owned(),
        upstream,
        sink: Arc::clone(&sink),
        last_activity_at: AtomicI64::new(now_ms()),
        closed: AtomicBool::new(false),
        timers: Mutex::new(Vec::new()),
    });
    let idle = {
        let (s, id) = (Arc::clone(&session), id.to_owned());
        every(IDLE_CHECK, move || {
            if s.closed.load(Ordering::SeqCst) {
                return false;
            }
            if now_ms() - s.last_activity_at.load(Ordering::SeqCst) > SESSION_IDLE_TIMEOUT_MS {
                close_session(&id, "idle-timeout");
            }
            true
        })
    };
    let keepalive = {
        let s = Arc::clone(&session);
        every(UPSTREAM_KEEPALIVE, move || {
            if s.closed.load(Ordering::SeqCst) {
                return false;
            }
            if s.upstream.ready_state() == OPEN {
                s.upstream.send_text(KEEPALIVE);
            }
            true
        })
    };
    if let Ok(mut t) = session.timers.lock() {
        t.extend([idle, keepalive]);
    }
    map.push(session);
    drop(map);

    tokio::spawn(relay(id.to_owned(), events, sink, extra_ca_configured));
    Ok(())
}

/// `setInterval(f, period)` until `f` says stop.
fn every(period: Duration, mut f: impl FnMut() -> bool + Send + 'static) -> JoinHandle<()> {
    tokio::spawn(async move {
        let mut tick = tokio::time::interval_at(tokio::time::Instant::now() + period, period);
        tick.set_missed_tick_behavior(tokio::time::MissedTickBehavior::Delay);
        loop {
            tick.tick().await;
            if !f() {
                return;
            }
        }
    })
}

/// The `upstream.on*` handlers.
async fn relay(
    id: String,
    mut events: tokio::sync::mpsc::UnboundedReceiver<Event>,
    sink: Arc<dyn SseSink>,
    extra_ca_configured: bool,
) {
    while let Some(ev) = events.recv().await {
        match ev {
            Event::Open => {
                tracing::info!(target: log::API, "[voice:{id}] upstream open");
                sink.send("ready", &js::stringify(&json!({"id": id})));
            }
            Event::Text(text) => sink.send("message", &text),
            Event::Error(err) => {
                let message = err
                    .get("message")
                    .and_then(Value::as_str)
                    .unwrap_or_default()
                    .to_owned();
                let hint = tls_cert_hint::tls_cert_failure_hint(&err, extra_ca_configured);
                let log_hint = tls_cert_hint::tls_cert_failure_log_hint(&err, extra_ca_configured)
                    .map(|h| format!(" — {h}"))
                    .unwrap_or_default();
                tracing::warn!(target: log::API, "[voice:{id}] upstream error: {message}{log_hint}");
                let mut payload = Map::new();
                payload.insert("kind".into(), json!("upstream"));
                payload.insert("message".into(), json!(message));
                if let Some(hint) = hint {
                    payload.insert("hint".into(), json!(hint));
                }
                sink.send("error", &js::stringify(&Value::Object(payload)));
                close_session(&id, "upstream-error");
            }
            Event::Close { code, reason } => {
                let shown = if reason.is_empty() { "(none)" } else { &reason };
                tracing::info!(
                    target: log::API,
                    "[voice:{id}] upstream close code={code} reason={shown}"
                );
                sink.send(
                    "close",
                    &js::stringify(&json!({"code": code, "reason": reason})),
                );
                close_session(&id, &format!("upstream-close-{code}"));
            }
        }
    }
}

/// `pushAudioChunk(id, bytes)`: forwarded when the session is live and its
/// socket OPEN.
pub fn push_audio_chunk(id: &str, bytes: Vec<u8>) -> bool {
    let Some(session) = lookup(id) else {
        let map = sessions();
        let known: Vec<&str> = map.iter().map(|s| s.id.as_str()).collect();
        tracing::warn!(
            target: log::API,
            "[voice:{id}] pushAudioChunk: session not in map (size={}, known=[{}])",
            known.len(),
            known.join(",")
        );
        return false;
    };
    if session.closed.load(Ordering::SeqCst) {
        tracing::warn!(target: log::API, "[voice:{id}] pushAudioChunk: session marked closed");
        return false;
    }
    let state = session.upstream.ready_state();
    if state != OPEN {
        tracing::warn!(
            target: log::API,
            "[voice:{id}] pushAudioChunk: upstream readyState={state}"
        );
        return false;
    }
    session.upstream.send_binary(bytes);
    session.last_activity_at.store(now_ms(), Ordering::SeqCst);
    true
}

/// `finalizeVoiceSession(id)`: `CloseStream` up when OPEN; `true` for any
/// live session.
pub fn finalize_voice_session(id: &str) -> bool {
    let Some(session) = lookup(id).filter(|s| !s.closed.load(Ordering::SeqCst)) else {
        return false;
    };
    if session.upstream.ready_state() == OPEN {
        session.upstream.send_text(CLOSE_STREAM);
    }
    session.last_activity_at.store(now_ms(), Ordering::SeqCst);
    true
}

/// `selfStopCloseFrame(reason)`: the `close` payload when the proxy itself
/// ends the session (the idle reaper), else `None`.
pub fn self_stop_close_frame(reason: &str) -> Option<String> {
    (reason == "idle-timeout")
        .then(|| js::stringify(&json!({"code": null, "reason": "idle-timeout"})))
}

/// `closeSession(id, reason)`: tear the session down, once.
pub fn close_session(id: &str, reason: &str) {
    let Some(session) = lookup(id) else { return };
    if session.closed.swap(true, Ordering::SeqCst) {
        return;
    }
    tracing::info!(target: log::API, "[voice:{id}] closeSession reason={reason}");
    if let Some(frame) = self_stop_close_frame(reason) {
        session.sink.send("close", &frame);
    }
    if let Ok(mut timers) = session.timers.lock() {
        for t in timers.drain(..) {
            t.abort();
        }
    }
    if matches!(session.upstream.ready_state(), CONNECTING | OPEN) {
        session.upstream.close(1000, reason);
    }
    session.sink.close();
    sessions().retain(|s| !Arc::ptr_eq(s, &session));
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn the_upstream_query_is_form_encoded() {
        assert_eq!(
            build_upstream_url("ws://h:1", "pt BR+\u{e9}&x"),
            "ws://h:1/api/ws/speech_to_text/voice_stream?encoding=linear16&sample_rate=16000\
             &channels=1&endpointing_ms=300&utterance_end_ms=1000&language=pt+BR%2B%C3%A9%26x\
             &use_conversation_engine=true&forward_interims=typed&stt_provider=deepgram-nova3"
        );
    }

    #[test]
    fn only_the_idle_reaper_self_stops() {
        assert_eq!(
            self_stop_close_frame("idle-timeout").as_deref(),
            Some(r#"{"code":null,"reason":"idle-timeout"}"#)
        );
        for other in ["client-abort", "upstream-error", "upstream-close-1000", ""] {
            assert_eq!(self_stop_close_frame(other), None);
        }
    }
}
