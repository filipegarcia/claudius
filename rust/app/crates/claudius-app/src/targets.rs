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

use std::sync::{Arc, LazyLock, Mutex};

use claudius_chat::source::{TranscriptChange, TranscriptSource};
use claudius_client::effect::{Effect, FetchOutcome, FetchRequest};
use claudius_client::state::ChatState;
use claudius_composer::target::{ComposerTarget, Resolutions, SessionCall, closed};
use claudius_prompts::target::Act;
use claudius_prompts::{PromptSource, PromptTarget};
use futures::StreamExt as _;
use futures::channel::mpsc::{UnboundedReceiver, UnboundedSender, unbounded};
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
    auto_mode: Arc<Mutex<AutoMode>>,
}

impl LivePromptSource {
    pub fn new(transcripts: LiveTranscripts) -> Self {
        LivePromptSource {
            transcripts,
            auto_mode: Arc::default(),
        }
    }
}

impl PromptSource for LivePromptSource {
    fn target(&self, session_id: &str) -> Option<Arc<dyn PromptTarget>> {
        Some(Arc::new(LivePrompts {
            session_id: session_id.to_owned(),
            transcripts: self.transcripts.clone(),
            auto_mode: self.auto_mode.clone(),
        }))
    }
}

/// `useDisableAutoMode(session.cwd)` for the cards (U08f;
/// useDisableAutoMode.ts:23, ChatSurface.tsx:442): the user settings'
/// `disableAutoMode`, asked for when the chat's cwd changes. As the
/// hook's state, an answer stands until the next one: no cwd, a failed
/// request, a non-2xx or a body that doesn't parse keep it.
#[derive(Default)]
struct AutoMode {
    /// The cwd last asked about.
    cwd: Option<String>,
    disabled: bool,
    /// Woken when an answer lands.
    subscribers: Vec<UnboundedSender<()>>,
}

/// The hook's `.then`: the answer, or `None` to keep the last one (a
/// non-2xx returns early; a body that isn't JSON, or a `null` one whose
/// `.settings` throws, goes to the `.catch`).
fn auto_mode_answer(outcome: &FetchOutcome) -> Option<bool> {
    let FetchOutcome::Response { body, .. } = outcome else {
        return None;
    };
    if !outcome.ok() {
        return None;
    }
    let text = body.strip_prefix('\u{feff}').unwrap_or(body);
    let data = claudius_core::js_string::parse(text).ok()?;
    if data.is_null() {
        return None;
    }
    let settings = claudius_agent::js::prop(Some(&data), "settings");
    Some(claudius_core::auto_mode_disabled::is_auto_mode_disabled(
        settings,
    ))
}

/// A state with nothing pending, for a tab the chat isn't on.
static NOTHING_PENDING: LazyLock<ChatState> = LazyLock::new(|| ChatState::new(""));

struct LivePrompts {
    session_id: String,
    transcripts: LiveTranscripts,
    auto_mode: Arc<Mutex<AutoMode>>,
}

impl LivePrompts {
    fn chat(&self) -> Option<LiveChat> {
        self.transcripts
            .chat()
            .filter(|c| c.session_id().as_deref() == Some(self.session_id.as_str()))
    }

    /// The hook's effect on `[cwd]`: asks for the user settings when the
    /// bound chat's cwd isn't the one last asked about. A later cwd's
    /// answer wins (the hook aborts the earlier request).
    fn ask_auto_mode(&self, chat: &LiveChat, state: &ChatState) {
        let Some(cwd) = state.cwd.as_str() else {
            return;
        };
        {
            let mut am = self.auto_mode.lock().unwrap();
            if am.cwd.as_deref() == Some(cwd) {
                return;
            }
            am.cwd = Some(cwd.to_owned());
        }
        let Some(url) = claudius_status::picker::settings_url(Some(cwd)) else {
            return;
        };
        let auto_mode = self.auto_mode.clone();
        let cwd = cwd.to_owned();
        chat.fetch_then(claudius_status::target::get(url), move |outcome| {
            let Some(disabled) = auto_mode_answer(&outcome) else {
                return;
            };
            let mut am = auto_mode.lock().unwrap();
            if am.cwd.as_deref() != Some(cwd.as_str()) {
                return;
            }
            am.disabled = disabled;
            am.subscribers.retain(|tx| tx.unbounded_send(()).is_ok());
        });
    }
}

impl PromptTarget for LivePrompts {
    fn read(&self, f: &mut dyn FnMut(&ChatState)) {
        match self.chat() {
            Some(chat) => {
                let state = chat.state();
                self.ask_auto_mode(&chat, &state);
                f(&state)
            }
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
        let chat = TranscriptSource::subscribe(&self.transcripts)
            .filter(move |c| futures::future::ready(c.session_id == id))
            .map(|_| ());
        let (tx, answers) = unbounded();
        self.auto_mode.lock().unwrap().subscribers.push(tx);
        futures::stream::select(chat, answers).boxed()
    }

    fn auto_mode_disabled(&self) -> bool {
        self.auto_mode.lock().unwrap().disabled
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

#[cfg(test)]
mod tests {
    use super::*;

    fn reply(status: u16, body: &str) -> FetchOutcome {
        FetchOutcome::Response {
            status,
            body: body.to_owned(),
        }
    }

    #[test]
    fn auto_mode_answer_reads_the_user_setting() {
        let on = r#"{"settings":{"disableAutoMode":"disable"}}"#;
        assert_eq!(auto_mode_answer(&reply(200, on)), Some(true));
        // `res.json()` skips a BOM.
        assert_eq!(
            auto_mode_answer(&reply(200, &format!("\u{feff}{on}"))),
            Some(true)
        );
        let nested = r#"{"settings":{"permissions":{"disableAutoMode":"disable"}}}"#;
        assert_eq!(auto_mode_answer(&reply(200, nested)), Some(true));
        // Anything else is an answer too: Auto mode is available.
        for body in [
            r#"{"settings":{}}"#,
            r#"{"settings":{"disableAutoMode":true}}"#,
            r#"{"settings":null}"#,
            "{}",
            "5",
        ] {
            assert_eq!(auto_mode_answer(&reply(200, body)), Some(false), "{body}");
        }
    }

    #[test]
    fn auto_mode_answer_keeps_the_last_one_when_the_hook_would() {
        // `if (!res.ok) return`, and the `.catch`: a failed fetch, a body
        // that isn't JSON, `null.settings`.
        for outcome in [
            reply(500, r#"{"settings":{"disableAutoMode":"disable"}}"#),
            reply(200, "not json"),
            reply(200, "null"),
            FetchOutcome::Failed("offline".into()),
        ] {
            assert_eq!(auto_mode_answer(&outcome), None, "{outcome:?}");
        }
    }
}
