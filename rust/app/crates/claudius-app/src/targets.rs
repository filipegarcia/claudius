//! The chat route's composer and prompt cards over the live chat (U07e,
//! U08c): a [`ComposerTarget`] and a [`PromptSource`] on the mounted
//! [`LiveChat`], as `ChatSurface.tsx` hands `PromptInput` and the prompt
//! components the hook's state and actions.
//!
//! It reads what [`LiveTranscripts`] reads (the mounted chat's state while
//! it is bound to the session, and the same change feed), runs each
//! [`SessionCall`] on the chat ([`LiveChat::act`]), and answers a call's
//! promise when the chat's `Effect::ActionResolved` reaches the shell
//! ([`LiveComposer::resolve`]). The composer's own requests (the draft,
//! `!` bash, the prompt color) go over the chat's own transport
//! ([`LiveChat::fetch`]), as the browser's `fetch` would.

use std::sync::{Arc, LazyLock};

use claudius_chat::source::{TranscriptChange, TranscriptSource};
use claudius_client::effect::{Effect, FetchOutcome, FetchRequest};
use claudius_client::state::ChatState;
use claudius_composer::target::{ComposerTarget, Resolutions, SessionCall, closed};
use claudius_prompts::target::Act;
use claudius_prompts::{PromptSource, PromptTarget};
use futures::StreamExt as _;
use futures::channel::mpsc::UnboundedReceiver;
use futures::channel::oneshot;
use futures::stream::BoxStream;
use serde_json::Value;

use crate::chat::LiveChat;
use crate::transcripts::LiveTranscripts;

pub struct LiveComposer {
    transcripts: LiveTranscripts,
    resolutions: Resolutions,
}

impl LiveComposer {
    pub fn new(transcripts: LiveTranscripts) -> Self {
        LiveComposer {
            transcripts,
            resolutions: Resolutions::new(),
        }
    }

    /// The mounted chat, when it is bound to `session_id`.
    fn chat_for(&self, session_id: &str) -> Option<LiveChat> {
        self.transcripts
            .chat()
            .filter(|c| c.session_id().as_deref() == Some(session_id))
    }

    /// Hands the chat's `ActionResolved` to the call waiting on it; whether
    /// one waited.
    pub fn resolve(&self, effect: &Effect) -> bool {
        self.resolutions.resolve(effect)
    }

    /// Calls still waiting on their promise.
    pub fn waiting(&self) -> usize {
        self.resolutions.len()
    }
}

impl ComposerTarget for LiveComposer {
    fn read(&self, session_id: &str, f: &mut dyn FnMut(&ChatState)) -> bool {
        TranscriptSource::read(&self.transcripts, session_id, f)
    }

    fn subscribe(&self) -> UnboundedReceiver<TranscriptChange> {
        TranscriptSource::subscribe(&self.transcripts)
    }

    fn call(&self, session_id: &str, call: SessionCall) -> oneshot::Receiver<Value> {
        let Some(chat) = self.chat_for(session_id) else {
            return closed();
        };
        let rx = self.resolutions.expect(call.resolves_as());
        chat.act(move |s, env| call.apply(s, env));
        rx
    }

    fn fetch(&self, req: FetchRequest) -> oneshot::Receiver<FetchOutcome> {
        match self.transcripts.chat() {
            Some(chat) => chat.fetch(req),
            None => closed(),
        }
    }
}

/// The prompt cards over the live chat (U08c): a [`PromptTarget`] per tab
/// that reads and answers the mounted chat while it is bound to the tab's
/// session, and shows nothing otherwise (another tab's cards come back
/// when the chat switches to it, as `ChatSurface` shows only the bound
/// session's prompts).
pub struct LivePromptSource {
    transcripts: LiveTranscripts,
}

impl LivePromptSource {
    pub fn new(transcripts: LiveTranscripts) -> Self {
        LivePromptSource { transcripts }
    }
}

impl PromptSource for LivePromptSource {
    fn target(&self, session_id: &str) -> Option<Arc<dyn PromptTarget>> {
        Some(Arc::new(LivePrompts {
            session_id: session_id.to_owned(),
            transcripts: self.transcripts.clone(),
        }))
    }
}

/// A state with nothing pending, for a tab the chat isn't on.
static NOTHING_PENDING: LazyLock<ChatState> = LazyLock::new(|| ChatState::new(""));

struct LivePrompts {
    session_id: String,
    transcripts: LiveTranscripts,
}

impl LivePrompts {
    fn chat(&self) -> Option<LiveChat> {
        self.transcripts
            .chat()
            .filter(|c| c.session_id().as_deref() == Some(self.session_id.as_str()))
    }
}

impl PromptTarget for LivePrompts {
    fn read(&self, f: &mut dyn FnMut(&ChatState)) {
        match self.chat() {
            Some(chat) => f(&chat.state()),
            None => f(&NOTHING_PENDING),
        }
    }

    fn act(&self, f: Act) {
        if let Some(chat) = self.chat() {
            chat.act(move |s, env| f(s, env));
        }
    }

    fn changes(&self) -> BoxStream<'static, ()> {
        let id = self.session_id.clone();
        TranscriptSource::subscribe(&self.transcripts)
            .filter(move |c| futures::future::ready(c.session_id == id))
            .map(|_| ())
            .boxed()
    }

    /// `tabLabelFor(sessionId, sessions, sessionTitle)` over the chat's
    /// merged list and live title.
    fn session_label(&self) -> Option<String> {
        let st = self.chat()?.state();
        let rows = crate::chat::session_rows(&st.sessions);
        Some(crate::tabs::tab_label(
            &self.session_id,
            &rows,
            None,
            st.session_title.as_str(),
            crate::tabs::current_year(),
        ))
    }

    /// The page's origin (`window.location.origin`).
    fn own_origin(&self) -> Option<String> {
        Some(crate::shell::PAGE_ORIGIN.to_owned())
    }
}
