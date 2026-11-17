//! What the state machine asks its host to do: the hook's side effects that
//! leave React state (`fetch`, timers, `window.dispatchEvent`,
//! `history.replaceState`, the `console.error` of a bad SSE payload).
//!
//! The machine never performs I/O. It hands each request back as an
//! [`Effect`] with an id it chose, and the host reports the outcome with the
//! same id: [`ChatState::fetch_settled`](crate::state::ChatState::fetch_settled)
//! for a fetch, [`ChatState::timer_fired`](crate::state::ChatState::timer_fired)
//! for a timer. Effects come back in the order the hook makes the calls.

use serde_json::Value;

use crate::JsThrow;

/// A fetch the machine started; the host answers it with this id.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash, PartialOrd, Ord)]
pub struct FetchId(pub u64);

/// A timer the machine armed, numbered like the browser's (1, 2, ... per
/// page), so a recorded log's ids line up.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash, PartialOrd, Ord)]
pub struct TimerId(pub u64);

/// `fetch(url, { method, headers, body })`.
#[derive(Debug, Clone, PartialEq)]
pub struct FetchRequest {
    pub id: FetchId,
    pub method: &'static str,
    /// Relative to the server's origin (`/api/sessions/<id>/recap`).
    pub url: String,
    /// The `headers` object the hook passes, in its key order.
    pub headers: Vec<(&'static str, &'static str)>,
    /// The request body as sent (`JSON.stringify(...)` text).
    pub body: Option<String>,
}

/// How a fetch ended.
#[derive(Debug, Clone, PartialEq)]
pub enum FetchOutcome {
    /// A response: its status and body text (`res.json()` parses it, and a
    /// body that isn't JSON rejects there).
    Response { status: u16, body: String },
    /// `fetch` itself rejected (network error, aborted): the error's text.
    Failed(String),
}

impl FetchOutcome {
    /// `res.ok`.
    pub fn ok(&self) -> bool {
        matches!(self, Self::Response { status, .. } if (200..300).contains(status))
    }

    /// `await res.json()`: the parsed body (its UTF-8 decode drops a
    /// leading BOM), or `None` where it rejects (not JSON, or the fetch
    /// itself failed).
    pub(crate) fn json(&self) -> Option<Value> {
        match self {
            Self::Response { body, .. } => {
                let text = body.strip_prefix('\u{feff}').unwrap_or(body);
                claudius_core::js_string::parse(text).ok()
            }
            Self::Failed(_) => None,
        }
    }
}

#[derive(Debug, Clone, PartialEq)]
pub enum Effect {
    /// Start a fetch; report it with `fetch_settled`.
    Fetch(FetchRequest),
    /// `setTimeout(fn, ms)` (`repeat: false`) or `setInterval(fn, ms)`.
    /// Report each expiry with `timer_fired`; an interval stays armed until
    /// a [`Effect::ClearTimer`].
    SetTimer { id: TimerId, ms: f64, repeat: bool },
    /// `clearTimeout` / `clearInterval` of a timer that is still armed.
    ClearTimer { id: TimerId },
    /// `window.dispatchEvent(new CustomEvent(name, { detail }))`.
    WindowEvent { name: String, detail: Value },
    /// `window.history.replaceState(null, "", url)`.
    ReplaceUrl { url: String },
    /// `console.error("bad SSE payload", error, data)`: an SSE message whose
    /// text isn't JSON, or whose handler threw (the TS catches it in
    /// `onmessage`, so what the handler set before the throw stays). The
    /// host has the message's `data`.
    BadPayload { error: JsThrow },
    /// A promise the hook started without a `.catch` rejected: the
    /// browser's "Uncaught (in promise)" (`resolvePermission`'s POST when
    /// the fetch itself fails). `error` is the rejection's text.
    UnhandledRejection { error: String },
}
