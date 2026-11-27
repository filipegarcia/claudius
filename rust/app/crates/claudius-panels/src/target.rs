//! [`RailTarget`]: what the rail and the goal banner read from a chat and
//! call on it. It is U09a's [`StatusTarget`] (read a `&ChatState`, run an
//! action, the change feed, the page's own `fetch`) plus the two
//! promises the rail awaits, which `act` can't hand back:
//!
//! - `send(text)`, whose `SendResult` keeps the add-todos form open with
//!   its error when the prompt didn't go (ChatSurface.tsx:1069);
//! - `setGoal(text)`, awaited before the goal's opening prompt is sent
//!   (ChatSurface.tsx:2094), so the server arms the goal first.
//!
//! Over the live chat (`claudius_app::rail::LiveRail`) the send goes
//! through the composer's own call (one queue of `send` promises), and
//! `setGoal`'s `ActionResolved` is handed back by the shell.
//!
//! [`FixtureRail`] wraps a [`FixtureStatus`] and answers the promises from
//! a queue the tests fill.

use std::sync::{Arc, Mutex};

use claudius_client::effect::{FetchOutcome, FetchRequest};
use claudius_client::queue::SendOpts;
use claudius_client::state::ChatState;
use claudius_status::{Act, FixtureStatus, StatusTarget};
use futures::channel::oneshot;
use futures::stream::BoxStream;
use serde_json::Value;

/// What the rail needs from a chat.
pub trait RailTarget: StatusTarget {
    /// `send(text, undefined, opts)`: the receiver gets its `SendResult`
    /// (`{ ok }` / `{ ok: false, error }`); a dropped sender reads as
    /// undelivered.
    fn send(&self, text: String, opts: SendOpts) -> oneshot::Receiver<Value>;

    /// `setGoal(text)`: the receiver gets `{ ok }` / `{ ok: false, error }`.
    fn set_goal(&self, text: String) -> oneshot::Receiver<Value>;
}

/// `res.ok` of a promise's value, and its error text.
pub fn outcome(v: Option<&Value>) -> Result<(), String> {
    match v {
        Some(v) if v.get("ok") == Some(&Value::Bool(true)) => Ok(()),
        Some(v) => Err(claudius_agent::js::to_string(v.get("error"))),
        None => Err("unknown".into()),
    }
}

/// A call the fixture holds until the test answers it.
#[derive(Debug)]
pub struct Held {
    pub kind: &'static str,
    pub text: String,
    pub opts: Option<SendOpts>,
    tx: oneshot::Sender<Value>,
}

/// A [`FixtureStatus`] whose `send` / `setGoal` run on the machine (their
/// effects recorded) and resolve when the test says.
pub struct FixtureRail {
    pub status: Arc<FixtureStatus>,
    held: Mutex<Vec<Held>>,
    requests: Mutex<Vec<(String, Option<String>)>>,
}

impl FixtureRail {
    pub fn new(status: Arc<FixtureStatus>) -> Arc<Self> {
        Arc::new(FixtureRail {
            status,
            held: Mutex::new(Vec::new()),
            requests: Mutex::new(Vec::new()),
        })
    }

    /// The rail's own requests, as `(method url, body)`.
    pub fn requests(&self) -> Vec<(String, Option<String>)> {
        self.requests.lock().unwrap().clone()
    }

    /// The calls still waiting, oldest first: `(kind, text)`.
    pub fn held(&self) -> Vec<(&'static str, String)> {
        self.held
            .lock()
            .unwrap()
            .iter()
            .map(|h| (h.kind, h.text.clone()))
            .collect()
    }

    /// The options the oldest held `send` went with.
    pub fn held_opts(&self) -> Option<SendOpts> {
        self.held
            .lock()
            .unwrap()
            .iter()
            .find(|h| h.kind == "send")
            .and_then(|h| h.opts.clone())
    }

    /// Answers the oldest held call.
    pub fn answer(&self, v: Value) -> bool {
        let mut held = self.held.lock().unwrap();
        if held.is_empty() {
            return false;
        }
        let h = held.remove(0);
        h.tx.send(v).is_ok()
    }

    fn hold(
        &self,
        kind: &'static str,
        text: String,
        opts: Option<SendOpts>,
    ) -> oneshot::Receiver<Value> {
        let (tx, rx) = oneshot::channel();
        self.held.lock().unwrap().push(Held {
            kind,
            text,
            opts,
            tx,
        });
        rx
    }
}

impl StatusTarget for FixtureRail {
    fn read(&self, f: &mut dyn FnMut(&ChatState)) -> bool {
        self.status.read(f)
    }

    fn act(&self, f: Act) {
        self.status.act(f)
    }

    fn changes(&self) -> BoxStream<'static, ()> {
        self.status.changes()
    }

    fn fetch(&self, req: FetchRequest) -> oneshot::Receiver<FetchOutcome> {
        self.requests
            .lock()
            .unwrap()
            .push((format!("{} {}", req.method, req.url), req.body.clone()));
        self.status.fetch(req)
    }
}

impl RailTarget for FixtureRail {
    fn send(&self, text: String, opts: SendOpts) -> oneshot::Receiver<Value> {
        let (t, o) = (text.clone(), opts.clone());
        self.status
            .act(Box::new(move |s, env| s.send(&t, None, &o, env)));
        self.hold("send", text, Some(opts))
    }

    fn set_goal(&self, text: String) -> oneshot::Receiver<Value> {
        let t = text.clone();
        self.status.act(Box::new(move |s, env| s.set_goal(&t, env)));
        self.hold("setGoal", text, None)
    }
}
