//! [`StatusTarget`]: what the status line reads from a chat and calls on
//! it, next to claudius-chat's `TranscriptSource`, the composer's and the
//! prompt cards' targets (the same shape: read a `&ChatState`, run an
//! action returning `Vec<Effect>` through the chat's runner, a change
//! feed, and the page's own `fetch`).
//!
//! Over U04b's `LiveChat` (`state()`, `act(f)`, `changes()`) it is (see
//! `claudius_app::status`):
//!
//! ```ignore
//! impl StatusTarget for LiveStatus {
//!     fn read(&self, f: &mut dyn FnMut(&ChatState)) -> bool {
//!         f(&self.chat.state());
//!         true
//!     }
//!     fn act(&self, f: Act) { self.chat.act(move |s, env| f(s, env)); }
//!     ...
//! }
//! ```
//!
//! [`FixtureStatus`] holds a state the tests and the screenshots change
//! (through the real `ChatState::on_message`), records every effect the
//! actions return, and answers fetches from a table.

use std::collections::HashMap;
use std::sync::{Arc, Mutex};

use claudius_client::effect::{Effect, FetchId, FetchOutcome, FetchRequest};
use claudius_client::state::ChatState;
use claudius_client::{ClientEnv, FixedEnv};
use futures::StreamExt as _;
use futures::channel::mpsc::{UnboundedSender, unbounded};
use futures::channel::oneshot;
use futures::stream::BoxStream;
use serde_json::Value;

/// An action on the chat's machine.
pub type Act = Box<dyn FnOnce(&mut ChatState, &mut dyn ClientEnv) -> Vec<Effect> + Send>;

/// What the status line needs from a chat.
pub trait StatusTarget: Send + Sync + 'static {
    /// Calls `f` with the chat's state; `false` (and no call) when there
    /// is no chat.
    fn read(&self, f: &mut dyn FnMut(&ChatState)) -> bool;

    /// Runs `f` on the machine, after every earlier call, and runs the
    /// effects it returns.
    fn act(&self, f: Act);

    /// Wakes after each state change.
    fn changes(&self) -> BoxStream<'static, ()>;

    /// One of the status line's own requests (the model list, the
    /// settings, the context poll), relative to the page's origin.
    fn fetch(&self, req: FetchRequest) -> oneshot::Receiver<FetchOutcome>;
}

/// A `GET` the status line makes.
pub fn get(url: impl Into<String>) -> FetchRequest {
    FetchRequest {
        id: FetchId(0),
        method: "GET",
        url: url.into(),
        headers: Vec::new(),
        body: None,
    }
}

/// A receiver whose sender is already gone (a target with no fetch).
pub fn closed<T>() -> oneshot::Receiver<T> {
    oneshot::channel().1
}

/// A chat over a fixed clock, changed by events, its fetches answered
/// from a table.
pub struct FixtureStatus {
    inner: Mutex<Inner>,
    subscribers: Mutex<Vec<UnboundedSender<()>>>,
}

struct Inner {
    state: Option<ChatState>,
    env: FixedEnv,
    effects: Vec<Effect>,
    replies: HashMap<String, FetchOutcome>,
    fetched: Vec<String>,
}

impl FixtureStatus {
    /// A chat bound to `session_id`, ready, in `default` mode.
    pub fn new(session_id: &str) -> Arc<Self> {
        let mut state = ChatState::new(format!("tab-{session_id}"));
        state.session_id = Some(session_id.to_owned());
        state.ready = true;
        Self::with_state(Some(state))
    }

    /// Over `state` (`None`: no chat).
    pub fn with_state(state: Option<ChatState>) -> Arc<Self> {
        Arc::new(FixtureStatus {
            inner: Mutex::new(Inner {
                state,
                env: FixedEnv::new(1_795_683_600_000.0),
                effects: Vec::new(),
                replies: HashMap::new(),
                fetched: Vec::new(),
            }),
            subscribers: Mutex::new(Vec::new()),
        })
    }

    /// Applies one server event (its JSON), as the SSE handler does.
    pub fn event(&self, ev: Value) {
        {
            let mut i = self.inner.lock().unwrap();
            let Inner { state, env, .. } = &mut *i;
            if let Some(state) = state {
                let _ = state.on_message(&ev.to_string(), env);
            }
        }
        self.notify();
    }

    /// Changes the state directly.
    pub fn update(&self, f: impl FnOnce(&mut ChatState)) {
        if let Some(s) = self.inner.lock().unwrap().state.as_mut() {
            f(s);
        }
        self.notify();
    }

    /// The state now.
    pub fn state(&self) -> Option<ChatState> {
        self.inner.lock().unwrap().state.clone()
    }

    /// Answers `GET url` with `status` and `body` from now on.
    pub fn reply(&self, url: &str, status: u16, body: Value) {
        self.inner.lock().unwrap().replies.insert(
            url.to_owned(),
            FetchOutcome::Response {
                status,
                body: body.to_string(),
            },
        );
    }

    /// Every effect the actions returned, in order.
    pub fn effects(&self) -> Vec<Effect> {
        self.inner.lock().unwrap().effects.clone()
    }

    /// The actions' fetches, as `(method url, body)`.
    pub fn posts(&self) -> Vec<(String, Option<String>)> {
        self.effects()
            .into_iter()
            .filter_map(|e| match e {
                Effect::Fetch(r) => Some((format!("{} {}", r.method, r.url), r.body)),
                _ => None,
            })
            .collect()
    }

    /// The URLs the status line fetched itself, in order.
    pub fn fetched(&self) -> Vec<String> {
        self.inner.lock().unwrap().fetched.clone()
    }

    fn notify(&self) {
        self.subscribers
            .lock()
            .unwrap()
            .retain(|tx| tx.unbounded_send(()).is_ok());
    }
}

impl StatusTarget for FixtureStatus {
    fn read(&self, f: &mut dyn FnMut(&ChatState)) -> bool {
        match &self.inner.lock().unwrap().state {
            Some(s) => {
                f(s);
                true
            }
            None => false,
        }
    }

    fn act(&self, f: Act) {
        {
            let mut i = self.inner.lock().unwrap();
            let Inner {
                state,
                env,
                effects,
                ..
            } = &mut *i;
            if let Some(state) = state {
                effects.extend(f(state, env));
            }
        }
        self.notify();
    }

    fn changes(&self) -> BoxStream<'static, ()> {
        let (tx, rx) = unbounded();
        self.subscribers.lock().unwrap().push(tx);
        rx.boxed()
    }

    fn fetch(&self, req: FetchRequest) -> oneshot::Receiver<FetchOutcome> {
        let (tx, rx) = oneshot::channel();
        let mut i = self.inner.lock().unwrap();
        i.fetched.push(req.url.clone());
        let outcome = i
            .replies
            .get(&req.url)
            .cloned()
            .unwrap_or_else(|| FetchOutcome::Failed("Failed to fetch".into()));
        let _ = tx.send(outcome);
        rx
    }
}
