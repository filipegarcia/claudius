//! The session stream (U01k): `bindToSession`, the `EventSource`'s three
//! callbacks, the reconnect backoff, the "Reconnecting" badge and the
//! visibility listener that revives a dead stream.
//!
//! The machine never opens a socket: [`Effect::OpenEventSource`] and
//! [`Effect::CloseEventSource`] ask the host to, and the host reports the
//! browser's callbacks back with the stream's id (the contract is in
//! `effect.rs`). Each opened stream keeps what the hook's closures capture
//! (the session it was bound for, `rebuildOnOpen`) plus the readyState the
//! host last reported, which the visibility listener reads as
//! `es.readyState`.
//!
//! - `bindToSession(id, { rebuildOnOpen })`: cancel an armed recovery, close
//!   the current stream, bind `id`, announce it (`claudius:session-bound`),
//!   prime the advisor mirror (`GET /advisor`) and open
//!   `/api/sessions/<id>/stream?tail=20&tabId=<tab>`.
//! - `onopen`: the backoff restarts, the outage ends, and the transcript is
//!   rebuilt (`resetState`) when this socket was a recovery rebind or the
//!   outage outran the replay window (`shouldRebuildTranscript`); the badge
//!   is disarmed and the stream reads `"live"`.
//! - `onmessage`: the hook's `JSON.parse` + `applyEvent`.
//! - `onerror`: the outage starts (once), the 4 s badge is armed; on
//!   `CONNECTING` the browser is retrying, on `CLOSED` it gave up: a
//!   `console.warn`, the turn settles and a rebind is scheduled with the
//!   1 s .. 30 s backoff (one at a time).
//! - `visibilitychange` to visible: a dead (or missing) stream is rebound
//!   at once with the backoff reset, then the list is refreshed and a turn
//!   the server says is over settles (the poll's reconcile).
//!
//! Every callback first checks that its stream's session is still the
//! bound one (`sessionIdRef.current !== boundId`), as the TS does; it
//! doesn't check that the socket is still the current one.

use serde_json::json;

use crate::ClientEnv;
use crate::apply::Cx;
use crate::effect::{Effect, ReadyState, StreamId};
use crate::lifecycle::LifeThen;
use crate::state::{AfterRefresh, ChatState, Then, TimerFn};
use crate::stream_recovery::{
    STREAM_BADGE_AFTER_MS, should_rebuild_transcript, stream_recovery_delay_ms,
};

/// What a stream's callbacks close over, and its last reported state.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Stream {
    /// The session `bindToSession` opened it for (`boundId`).
    pub bound_id: String,
    /// `opts.rebuildOnOpen`: a recovery rebind, which rebuilds on open.
    pub rebuild_on_open: bool,
    /// `es.readyState`, as the host last reported it (`Connecting` until
    /// a callback says otherwise, `Closed` once the machine closes it).
    pub ready_state: ReadyState,
}

impl ChatState {
    /// `es.onopen` of the stream `id`.
    pub fn event_source_open(&mut self, id: StreamId, env: &mut dyn ClientEnv) -> Vec<Effect> {
        let mut cx = Cx::new(env);
        let Some(s) = self.streams.get_mut(&id) else {
            return cx.out;
        };
        s.ready_state = ReadyState::Open;
        let (bound, rebuild) = (s.bound_id.clone(), s.rebuild_on_open);
        if self.session_id.as_deref() != Some(bound.as_str()) {
            return cx.out;
        }
        self.reconnect_attempts = 0;
        let down_since = self.stream_down_since.take();
        let now = cx.env.now_ms();
        if rebuild || down_since.is_some_and(|d| should_rebuild_transcript(now - d)) {
            self.reset_state();
        }
        self.clear_reconnecting_badge(&mut cx.out);
        self.stream_status = "live";
        self.commit(&mut cx);
        cx.out
    }

    /// `es.onmessage` of the stream `id`, with the message's `data`.
    pub fn event_source_message(
        &mut self,
        id: StreamId,
        data: &str,
        env: &mut dyn ClientEnv,
    ) -> Vec<Effect> {
        let Some(s) = self.streams.get(&id) else {
            return Vec::new();
        };
        if self.session_id.as_deref() != Some(s.bound_id.as_str()) {
            return Vec::new();
        }
        self.on_message(data, env)
    }

    /// `es.onerror` of the stream `id`, with its `readyState` then.
    pub fn event_source_error(
        &mut self,
        id: StreamId,
        ready_state: ReadyState,
        env: &mut dyn ClientEnv,
    ) -> Vec<Effect> {
        let mut cx = Cx::new(env);
        let Some(s) = self.streams.get_mut(&id) else {
            return cx.out;
        };
        s.ready_state = ready_state;
        let bound = s.bound_id.clone();
        if self.session_id.as_deref() != Some(bound.as_str()) {
            return cx.out;
        }
        if self.stream_down_since.is_none() {
            self.stream_down_since = Some(cx.env.now_ms());
        }
        self.arm_reconnecting_badge(&mut cx.out);
        if ready_state == ReadyState::Closed {
            cx.out.push(Effect::ConsoleWarn {
                text: format!(
                    "[claudius] SSE stream for session {bound} was closed by the browser (it will not retry) \u{2014} rebuilding. Check the Network tab for the failed /stream response."
                ),
            });
            self.set_pending_tracked(false, &mut cx);
            self.schedule_stream_recovery(bound, &mut cx.out);
        }
        self.commit(&mut cx);
        cx.out
    }

    /// The document's `visibilitychange` (U01k): set `hidden`, and on
    /// becoming visible revive a dead stream and reconcile the turn.
    pub fn visibility_changed(&mut self, hidden: bool, env: &mut dyn ClientEnv) -> Vec<Effect> {
        let mut cx = Cx::new(env);
        self.hidden = hidden;
        // The unmount removed the listener.
        if hidden || self.unmounted {
            return cx.out;
        }
        if let Some(live) = self.session_id.clone().filter(|id| !id.is_empty()) {
            let dead = self
                .event_source
                .and_then(|es| self.streams.get(&es))
                .is_none_or(|s| s.ready_state == ReadyState::Closed);
            if dead {
                // `cancelStreamRecovery()` first: `bind` starts with it.
                self.reconnect_attempts = 0;
                self.bind(&live, true, &mut cx);
            }
        }
        self.refresh_sessions(AfterRefresh::Poll, &mut cx);
        self.commit(&mut cx);
        cx.out
    }

    /// `bindToSession(id, { rebuildOnOpen })`.
    pub(crate) fn bind(&mut self, id: &str, rebuild_on_open: bool, cx: &mut Cx<'_>) {
        self.cancel_stream_recovery(&mut cx.out);
        if let Some(es) = self.event_source {
            self.close_stream(es, &mut cx.out);
        }
        self.session_id = Some(id.to_owned());
        cx.out.push(Effect::WindowEvent {
            name: "claudius:session-bound".into(),
            detail: json!({ "sessionId": id }),
        });
        self.fetch(
            cx,
            "GET",
            format!("/api/sessions/{id}/advisor"),
            Vec::new(),
            None,
            Then::Life(LifeThen::Advisor { id: id.to_owned() }),
        );
        self.next_stream += 1;
        let stream = StreamId(self.next_stream);
        self.streams.insert(
            stream,
            Stream {
                bound_id: id.to_owned(),
                rebuild_on_open,
                ready_state: ReadyState::Connecting,
            },
        );
        self.event_source = Some(stream);
        cx.out.push(Effect::OpenEventSource {
            id: stream,
            url: format!("/api/sessions/{id}/stream?tail=20&tabId={}", self.my_tab_id),
        });
    }

    /// `es.close()`.
    pub(crate) fn close_stream(&mut self, id: StreamId, out: &mut Vec<Effect>) {
        if let Some(s) = self.streams.get_mut(&id) {
            s.ready_state = ReadyState::Closed;
        }
        out.push(Effect::CloseEventSource { id });
    }

    /// `cancelStreamRecovery`: disarm a pending rebind.
    pub(crate) fn cancel_stream_recovery(&mut self, out: &mut Vec<Effect>) {
        if let Some(t) = self.reconnect_timer.take() {
            self.clear_timer(out, t);
        }
    }

    /// `scheduleStreamRecovery(id)`: one rebind at a time, after the backoff
    /// for the failures so far.
    fn schedule_stream_recovery(&mut self, id: String, out: &mut Vec<Effect>) {
        if self.reconnect_timer.is_some() {
            return;
        }
        let delay = stream_recovery_delay_ms(f64::from(self.reconnect_attempts));
        self.reconnect_attempts = self.reconnect_attempts.saturating_add(1);
        self.reconnect_session = id;
        let t = self.set_timer(out, TimerFn::StreamRecovery, delay, false);
        self.reconnect_timer = Some(t);
    }

    /// The recovery timer: rebind, unless the user moved on meanwhile.
    pub(crate) fn stream_recovery_fired(&mut self, cx: &mut Cx<'_>) {
        self.reconnect_timer = None;
        let id = self.reconnect_session.clone();
        if self.session_id.as_deref() != Some(id.as_str()) {
            return;
        }
        self.bind(&id, true, cx);
    }

    /// `armReconnectingBadge`: debounced, once per outage.
    fn arm_reconnecting_badge(&mut self, out: &mut Vec<Effect>) {
        if self.badge_timer.is_some() {
            return;
        }
        let t = self.set_timer(out, TimerFn::ReconnectBadge, STREAM_BADGE_AFTER_MS, false);
        self.badge_timer = Some(t);
    }

    pub(crate) fn reconnect_badge_fired(&mut self) {
        self.badge_timer = None;
        self.stream_status = "reconnecting";
    }

    /// `clearReconnectingBadge`.
    fn clear_reconnecting_badge(&mut self, out: &mut Vec<Effect>) {
        if let Some(t) = self.badge_timer.take() {
            self.clear_timer(out, t);
        }
    }
}
