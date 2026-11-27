//! What the composer asks of the session: [`ComposerTarget`].
//!
//! The composer reads the bound session's `ChatState` (status, queue,
//! suggestions, the sent prompts its history recalls) and calls the
//! actions `useSession()` hands `PromptInput` / `QueueIndicator` /
//! `PromptSuggestions` in `ChatSurface.tsx` (`send`, `editQueued`,
//! `reorderQueued`, `sendQueuedNow`, `sendAllQueuedNow`, `cancelQueued`,
//! `interrupt`), each as a [`SessionCall`]. Its own requests (the
//! per-session draft, `!`-mode bash, the prompt color) are plain
//! [`FetchRequest`]s the target runs against the server.
//!
//! **Over a live session (U04b).** A `Driver` per bound session already
//! runs a `ChatState`'s effects over a transport. The trait is meant to be
//! a few lines over that:
//!
//! ```ignore
//! impl ComposerTarget for LiveSessions {
//!     fn read(&self, id: &str, f: &mut dyn FnMut(&ChatState)) -> bool {
//!         self.with_driver(id, |d| f(&d.state)).is_some()
//!     }
//!     // The transcript's own feed: one value serves both traits.
//!     fn subscribe(&self) -> UnboundedReceiver<TranscriptChange> {
//!         TranscriptSource::subscribe(self)
//!     }
//!     fn call(&self, id: &str, call: SessionCall) -> oneshot::Receiver<Value> {
//!         self.with_driver(id, |d| {
//!             // `resolutions` is shared with the driver's UI callback,
//!             // which hands it every `Effect::ActionResolved`.
//!             let rx = self.resolutions.lock().unwrap().expect(call.resolves_as());
//!             d.act(|s, env| call.apply(s, env));
//!             rx
//!         })
//!         .unwrap_or_else(closed)
//!     }
//!     fn fetch(&self, req: FetchRequest) -> oneshot::Receiver<FetchOutcome> {
//!         let (tx, rx) = oneshot::channel();
//!         let t = self.transport.clone();
//!         self.runtime.spawn(async move { let _ = tx.send(t.fetch_outcome(&req).await); });
//!         rx
//!     }
//! }
//! ```

use std::sync::Mutex;

use claudius_chat::source::TranscriptChange;
use claudius_client::effect::{Action, Effect, FetchOutcome, FetchRequest};
use claudius_client::queue::{SendImage, SendOpts};
use claudius_client::state::ChatState;
use claudius_client::{AttachedImage, ClientEnv};
use futures::channel::mpsc::UnboundedReceiver;
use futures::channel::oneshot;
use serde_json::Value;

/// A `useSession()` action the composer calls.
#[derive(Clone, Debug, PartialEq)]
pub enum SessionCall {
    /// `send(text, images, opts)`: what `handleSend` passes for a typed
    /// prompt (`reportsFailureInline`, `inlinePastes`) or a picked
    /// suggestion (`fromSuggestion`). Resolves with a `SendResult`.
    Send {
        text: String,
        images: Vec<AttachedImage>,
        opts: SendOpts,
    },
    /// `editQueued(qid)`: resolves with `{ text, images? }` or `null`.
    EditQueued { qid: String },
    /// `reorderQueued(qid, dir)`.
    ReorderQueued { qid: String, dir: f64 },
    /// `sendQueuedNow(qid)`.
    SendQueuedNow { qid: String },
    /// `sendAllQueuedNow()`.
    SendAllQueuedNow,
    /// `cancelQueued(qid)`.
    CancelQueued { qid: String },
    /// `interrupt()`.
    Interrupt,
}

impl SessionCall {
    /// Runs the call on the session's state machine.
    pub fn apply(&self, state: &mut ChatState, env: &mut dyn ClientEnv) -> Vec<Effect> {
        match self {
            SessionCall::Send { text, images, opts } => {
                let imgs: Vec<SendImage> = images
                    .iter()
                    .map(|im| SendImage {
                        id: Some(im.id.clone()),
                        ordinal: Some(im.ordinal),
                        data: im.data.clone(),
                        media_type: im.media_type.clone(),
                    })
                    .collect();
                let imgs = (!imgs.is_empty()).then_some(&imgs[..]);
                state.send(text, imgs, opts, env)
            }
            SessionCall::EditQueued { qid } => state.edit_queued(qid, env),
            SessionCall::ReorderQueued { qid, dir } => state.reorder_queued(qid, *dir, env),
            SessionCall::SendQueuedNow { qid } => state.send_queued_now(qid, env),
            SessionCall::SendAllQueuedNow => state.send_all_queued_now(env),
            SessionCall::CancelQueued { qid } => state.cancel_queued(qid, env),
            SessionCall::Interrupt => state.interrupt(env),
        }
    }

    /// The [`Action`] its promise resolves as (`Effect::ActionResolved`),
    /// or `None` for a `void` action.
    pub fn resolves_as(&self) -> Option<Action> {
        match self {
            SessionCall::Send { .. } => Some(Action::Send),
            SessionCall::EditQueued { qid } => Some(Action::EditQueued { qid: qid.clone() }),
            _ => None,
        }
    }
}

/// What the composer reads and calls. `Send + Sync` like
/// `TranscriptSource`, so one value can serve both.
pub trait ComposerTarget: Send + Sync + 'static {
    /// Calls `f` with the session's state; `false` (and no call) when the
    /// target holds none for that id.
    fn read(&self, session_id: &str, f: &mut dyn FnMut(&ChatState)) -> bool;

    /// The sessions whose state changed, from now on (the
    /// `TranscriptSource` feed's type, so a target that is also the
    /// transcripts' source hands out the same feed).
    fn subscribe(&self) -> UnboundedReceiver<TranscriptChange>;

    /// Runs `call` on the session. The receiver gets the promise's value
    /// (`Effect::ActionResolved`'s `outcome`); a `void` action (or a
    /// session the target doesn't hold) drops the sender. A dropped `send`
    /// reads as a rejected promise: undelivered, `"unknown"`.
    fn call(&self, session_id: &str, call: SessionCall) -> oneshot::Receiver<Value>;

    /// Runs one of the composer's own requests (relative URL, as the
    /// browser's `fetch` would).
    fn fetch(&self, req: FetchRequest) -> oneshot::Receiver<FetchOutcome>;
}

/// A receiver whose sender is already gone.
pub fn closed<T>() -> oneshot::Receiver<T> {
    oneshot::channel().1
}

/// Matches each `Effect::ActionResolved` to the oldest call still waiting
/// on that [`Action`] (a target's helper: calls of one action resolve in
/// the order their fetches settle, which for the composer's one-at-a-time
/// sends is call order).
#[derive(Default)]
pub struct Resolutions {
    waiting: Mutex<Vec<(Action, oneshot::Sender<Value>)>>,
}

impl Resolutions {
    pub fn new() -> Self {
        Self::default()
    }

    /// A receiver for the next resolution of `action`, or a closed one for
    /// `None` (a `void` action).
    pub fn expect(&self, action: Option<Action>) -> oneshot::Receiver<Value> {
        let Some(action) = action else {
            return closed();
        };
        let (tx, rx) = oneshot::channel();
        self.waiting.lock().unwrap().push((action, tx));
        rx
    }

    /// Hands an `ActionResolved` to its waiting call; whether one waited.
    pub fn resolve(&self, effect: &Effect) -> bool {
        let Effect::ActionResolved { action, outcome } = effect else {
            return false;
        };
        let mut waiting = self.waiting.lock().unwrap();
        match waiting.iter().position(|(a, _)| a == action) {
            Some(i) => {
                let (_, tx) = waiting.remove(i);
                let _ = tx.send(outcome.clone());
                true
            }
            None => false,
        }
    }

    /// Calls still waiting.
    pub fn len(&self) -> usize {
        self.waiting.lock().unwrap().len()
    }

    pub fn is_empty(&self) -> bool {
        self.len() == 0
    }
}
