//! The chat route's status line over a live chat (U09a): a
//! [`StatusTarget`] over the [`LiveChat`] the shell has mounted, as
//! `ChatSurface` hands `useSession()`'s state and actions to `StatusLine`.
//!
//! The shell sets the mounted chat ([`LiveStatus::set_chat`]) and forwards
//! each new snapshot ([`LiveStatus::changed`]); the status line reads the
//! chat's latest published state, runs the pickers' actions on it, and its
//! own requests (the model list, the settings, the context poll) go over
//! the chat's transport. With no chat mounted it reads nothing and its
//! actions and requests go nowhere.

use std::sync::{Arc, Mutex};

use claudius_client::effect::{FetchOutcome, FetchRequest};
use claudius_client::state::ChatState;
use claudius_status::target::closed;
use claudius_status::{Act, StatusTarget};
use futures::StreamExt as _;
use futures::channel::mpsc::{UnboundedSender, unbounded};
use futures::channel::oneshot;
use futures::stream::BoxStream;

use crate::chat::LiveChat;

#[derive(Default)]
struct Inner {
    chat: Option<LiveChat>,
    subscribers: Vec<UnboundedSender<()>>,
}

/// The mounted live chat, for the status line.
#[derive(Clone, Default)]
pub struct LiveStatus {
    inner: Arc<Mutex<Inner>>,
}

impl LiveStatus {
    pub fn new() -> Self {
        Self::default()
    }

    /// The chat the route mounted, or `None` once it unmounts; setting the
    /// same chat is a no-op.
    pub fn set_chat(&self, chat: Option<LiveChat>) {
        {
            let mut inner = self.inner.lock().unwrap();
            let same = match (&inner.chat, &chat) {
                (Some(a), Some(b)) => a.ptr_eq(b),
                (None, None) => true,
                _ => false,
            };
            if same {
                return;
            }
            inner.chat = chat;
        }
        self.changed();
    }

    /// The chat published a new snapshot.
    pub fn changed(&self) {
        self.inner
            .lock()
            .unwrap()
            .subscribers
            .retain(|tx| tx.unbounded_send(()).is_ok());
    }

    fn chat(&self) -> Option<LiveChat> {
        self.inner.lock().unwrap().chat.clone()
    }
}

impl StatusTarget for LiveStatus {
    fn read(&self, f: &mut dyn FnMut(&ChatState)) -> bool {
        let Some(chat) = self.chat() else {
            return false;
        };
        f(&chat.state());
        true
    }

    fn act(&self, f: Act) {
        if let Some(chat) = self.chat() {
            chat.act(move |s, env| f(s, env));
        }
    }

    fn changes(&self) -> BoxStream<'static, ()> {
        let (tx, rx) = unbounded();
        self.inner.lock().unwrap().subscribers.push(tx);
        rx.boxed()
    }

    fn fetch(&self, req: FetchRequest) -> oneshot::Receiver<FetchOutcome> {
        match self.chat() {
            Some(chat) => chat.fetch(req),
            None => closed(),
        }
    }
}
