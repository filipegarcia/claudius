//! The chat route's transcript over a live chat (U04h): a
//! [`TranscriptSource`] over the [`LiveChat`] the shell has mounted, as
//! `ChatSurface` hands `useSession()`'s `messages` to `MessageList`.
//!
//! The shell sets the mounted chat ([`LiveTranscripts::set_chat`]) and
//! forwards each new snapshot ([`LiveTranscripts::changed`]); a view reads
//! the chat's latest published state while the chat is bound to its
//! session, and nothing otherwise (another session's tab shows the live
//! card until the chat switches to it).

use std::sync::{Arc, Mutex};

use claudius_chat::{TranscriptChange, TranscriptSource};
use claudius_client::state::ChatState;
use futures::channel::mpsc::{UnboundedReceiver, UnboundedSender, unbounded};

use crate::chat::LiveChat;

#[derive(Default)]
struct Inner {
    chat: Option<LiveChat>,
    subscribers: Vec<UnboundedSender<TranscriptChange>>,
}

/// The mounted live chat's transcript.
#[derive(Clone, Default)]
pub struct LiveTranscripts {
    inner: Arc<Mutex<Inner>>,
}

impl LiveTranscripts {
    pub fn new() -> Self {
        Self::default()
    }

    /// The mounted chat, if any.
    pub fn chat(&self) -> Option<LiveChat> {
        self.inner.lock().unwrap().chat.clone()
    }

    /// The chat the route mounted, or `None` once it unmounts. The old and
    /// the new chat's sessions read again; setting the same chat is a no-op.
    pub fn set_chat(&self, chat: Option<LiveChat>) {
        let old = {
            let mut inner = self.inner.lock().unwrap();
            let same = match (&inner.chat, &chat) {
                (Some(a), Some(b)) => a.ptr_eq(b),
                (None, None) => true,
                _ => false,
            };
            if same {
                return;
            }
            std::mem::replace(&mut inner.chat, chat)
        };
        if let Some(id) = old.and_then(|c| c.session_id()) {
            self.send(id);
        }
        self.changed();
    }

    /// The chat published a new snapshot: its bound session reads again.
    pub fn changed(&self) {
        let id = self
            .inner
            .lock()
            .unwrap()
            .chat
            .as_ref()
            .and_then(LiveChat::session_id);
        if let Some(id) = id {
            self.send(id);
        }
    }

    fn send(&self, session_id: String) {
        let change = TranscriptChange { session_id };
        self.inner
            .lock()
            .unwrap()
            .subscribers
            .retain(|tx| tx.unbounded_send(change.clone()).is_ok());
    }
}

impl TranscriptSource for LiveTranscripts {
    fn read(&self, session_id: &str, f: &mut dyn FnMut(&ChatState)) -> bool {
        let chat = self.inner.lock().unwrap().chat.clone();
        let Some(chat) = chat else { return false };
        let state = chat.state();
        if state.session_id.as_deref() != Some(session_id) {
            return false;
        }
        f(&state);
        true
    }

    fn subscribe(&self) -> UnboundedReceiver<TranscriptChange> {
        let (tx, rx) = unbounded();
        self.inner.lock().unwrap().subscribers.push(tx);
        rx
    }
}
