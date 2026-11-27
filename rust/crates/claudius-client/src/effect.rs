//! What the state machine asks its host to do: the hook's side effects that
//! leave React state (`fetch`, timers, `window.dispatchEvent`,
//! `history.replaceState`, the `console.error` of a bad SSE payload).
//!
//! The machine never performs I/O. It hands each request back as an
//! [`Effect`] with an id it chose, and the host reports the outcome with the
//! same id: [`ChatState::fetch_settled`](crate::state::ChatState::fetch_settled)
//! for a fetch, [`ChatState::timer_fired`](crate::state::ChatState::timer_fired)
//! for a timer. Effects come back in the order the hook makes the calls.
//!
//! **Promise outcomes.** Most actions change state and nothing else, so
//! the caller reads the result off the state. A few hand their caller a
//! value instead (`jumpToUuid`'s uuid, `send`'s `SendResult`,
//! `moveToActiveAccount`'s `{ ok, error }`): each of those ends with one
//! [`Effect::ActionResolved`], carrying the promise's value as the TS
//! builds it (snapshot JSON: a nested `undefined` is left out). It comes in
//! the same effect list as the work that settles it: the action's own
//! return for an early `return`, else the `fetch_settled` of the reply the
//! TS awaited last. [`Action`] names the call, with the argument that tells
//! two calls apart where the action has one (a jump's target, a todo item's
//! or a queued row's id); calls of one action that are both in flight
//! resolve in the order their fetches settle. An action whose promise is `void`
//! (`cancelQueued`, `interrupt`, ...) emits none, and one that rejects
//! with nothing catching it emits [`Effect::UnhandledRejection`] instead.
//!
//! **The session stream (U01k).** `new EventSource(url)` is
//! [`Effect::OpenEventSource`] with a [`StreamId`] the machine chose, and
//! `es.close()` is [`Effect::CloseEventSource`] with that id. `url` is
//! relative to the server's origin, exactly as the hook builds it:
//! `/api/sessions/<id>/stream?tail=20&tabId=<tabId>`. The host runs a
//! browser `EventSource` for each open one (auto-reconnect with the
//! server's `retry`, `Last-Event-ID`, the readyState transitions) and
//! reports its callbacks with the same id:
//! [`ChatState::event_source_open`](crate::state::ChatState::event_source_open)
//! for `onopen`,
//! [`ChatState::event_source_message`](crate::state::ChatState::event_source_message)
//! for `onmessage` (the `MessageEvent.data` text; the machine parses it),
//! and [`ChatState::event_source_error`](crate::state::ChatState::event_source_error)
//! for `onerror`, with the [`ReadyState`] the source has when the callback
//! runs (the hook branches on it). The machine emulates none of the
//! `EventSource` itself. A callback for a stream it closed or replaced runs
//! as the hook's closure for that stream does: it acts only while that
//! stream's session is still the bound one (the TS guards on the session
//! id, not on the socket), so a late message from a socket the machine
//! rebound for the same session is still applied. An id the machine never
//! opened is ignored, and so is every callback after `unmount`. `close` is emitted each time the hook calls it, also
//! on a source the host already reported `Closed`. The page around the
//! stream is input too: the mount and unmount, the URL and route, and the
//! tab's visibility (see `lifecycle.rs` and
//! [`ChatState::visibility_changed`](crate::state::ChatState::visibility_changed)).

use serde_json::Value;

use crate::JsThrow;

/// A fetch the machine started; the host answers it with this id.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash, PartialOrd, Ord)]
pub struct FetchId(pub u64);

/// A timer the machine armed, numbered like the browser's (1, 2, ... per
/// page), so a recorded log's ids line up.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash, PartialOrd, Ord)]
pub struct TimerId(pub u64);

/// An `EventSource` the machine opened; the host reports its callbacks
/// with this id.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash, PartialOrd, Ord)]
pub struct StreamId(pub u64);

/// `EventSource.readyState` when a callback runs.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash)]
pub enum ReadyState {
    /// `CONNECTING` (0): the source is retrying on its own.
    Connecting,
    /// `OPEN` (1).
    Open,
    /// `CLOSED` (2): the source gave up (or was closed) and won't retry.
    Closed,
}

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
    /// `console.warn(...)`, as the recorder prints it (the arguments joined
    /// by a space, an `Error` as `<name>: <message>`): a todo action's
    /// failure (U01g).
    ConsoleWarn { text: String },
    /// A promise-valued action's promise resolved with `outcome` (see the
    /// module docs).
    ActionResolved { action: Action, outcome: Value },
    /// `new EventSource(url)` (see the module docs).
    OpenEventSource { id: StreamId, url: String },
    /// `es.close()`.
    CloseEventSource { id: StreamId },
    /// `window.location.assign(url)`: load the page anew at `url`
    /// (`openSkippedBootSession`'s "Open anyway").
    AssignUrl { url: String },
}

/// The action an [`Effect::ActionResolved`] settles, and its outcome's
/// shape.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum Action {
    /// `updateTodoItem(itemId, action)` (U01g): `{ ok: true }`, or `{ ok:
    /// false, error }` with the `error` as the hook built it (the server's
    /// `error` as sent, `HTTP <status>`, or the thrown message).
    UpdateTodoItem { item_id: String },
    /// `jumpToUuid(target)` (U01h): the primary uuid of the bubble holding
    /// `target` (its own uuid or a folded SDK uuid), or `null` once the top
    /// of the history is reached without it.
    JumpToUuid { target: String },
    /// `moveToActiveAccount()` (U01n): `{ ok: true }` or `{ ok: false,
    /// error }`.
    MoveToActiveAccount,
    /// `send(...)` (U01j): `SendResult`, `{ ok: true }` or `{ ok: false,
    /// error }`.
    Send,
    /// `enqueue(...)` (U01j): `SendResult`.
    Enqueue,
    /// `editQueued(qid)` (U01j): `{ text, images? }`, or `null`.
    EditQueued { qid: String },
    /// `renameTitle(title)` (U01j): `{ ok: true }` or `{ ok: false, error }`.
    RenameTitle,
    /// `setGoal(text)` (U01j): `{ ok: true }` or `{ ok: false, error }`.
    SetGoal,
    /// `clearGoal()` (U01j). `setGoal` with a blank text clears through
    /// the same POST, and resolves as `SetGoal`.
    ClearGoal,
    /// `submitFeedback(input)` (U01j): `{ ok, stored, forwarded, reason? }`.
    SubmitFeedback,
    /// `createNewSession()` (U01k): the new session's id, or `null` when
    /// the create failed or a newer switch or create superseded it.
    CreateNewSession,
    /// `refreshSessions()` (U01k): the merged list it stored, or `[]` when
    /// a reply threw.
    RefreshSessions,
}
