//! The chat's right rail and goal banner over a live chat (U09b): a
//! [`RailTarget`] over the [`LiveChat`] the shell has mounted, as
//! `ChatSurface` hands `useSession()`'s state and actions to
//! `BackgroundTasksPanel` and `GoalBanner`.
//!
//! It reads, acts and fetches as the status line does ([`LiveStatus`],
//! the same mounted chat and change feed). Its `send` goes through the
//! composer's own call ([`LiveComposer`]), so the rail's prompts (the
//! add-todos append, a loop's cancel, the goal's opening prompt) share
//! the composer's queue of `send` promises; `setGoal`'s promise is
//! answered when the chat's `Effect::ActionResolved` reaches the shell
//! ([`LiveRail::resolve`]).

use std::sync::Arc;

use claudius_client::effect::{Action, Effect, FetchOutcome, FetchRequest};
use claudius_client::queue::SendOpts;
use claudius_client::state::ChatState;
use claudius_composer::target::{ComposerTarget, Resolutions, SessionCall, closed};
use claudius_panels::RailTarget;
use claudius_status::{Act, StatusTarget};
use futures::channel::oneshot;
use futures::stream::BoxStream;
use serde_json::Value;

use crate::status::LiveStatus;
use crate::targets::LiveComposer;

/// The mounted live chat, for the rail and the goal banner.
pub struct LiveRail {
    status: LiveStatus,
    composer: Option<Arc<LiveComposer>>,
    resolutions: Resolutions,
}

impl LiveRail {
    pub fn new(status: LiveStatus, composer: Option<Arc<LiveComposer>>) -> Self {
        LiveRail {
            status,
            composer,
            resolutions: Resolutions::new(),
        }
    }

    /// Hands the chat's `ActionResolved` to the `setGoal` waiting on it;
    /// whether one waited.
    pub fn resolve(&self, effect: &Effect) -> bool {
        self.resolutions.resolve(effect)
    }

    /// `setGoal` calls still waiting on their promise.
    pub fn waiting(&self) -> usize {
        self.resolutions.len()
    }

    fn session_id(&self) -> Option<String> {
        let mut sid = None;
        self.status
            .read(&mut |s: &ChatState| sid = s.session_id.clone().filter(|s| !s.is_empty()));
        sid
    }
}

impl StatusTarget for LiveRail {
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
        self.status.fetch(req)
    }
}

impl RailTarget for LiveRail {
    fn send(&self, text: String, opts: SendOpts) -> oneshot::Receiver<Value> {
        match (&self.composer, self.session_id()) {
            (Some(c), Some(sid)) => c.call(
                &sid,
                SessionCall::Send {
                    text,
                    images: Vec::new(),
                    opts,
                },
            ),
            _ => closed(),
        }
    }

    fn set_goal(&self, text: String) -> oneshot::Receiver<Value> {
        if !self.status.read(&mut |_| {}) {
            return closed();
        }
        let rx = self.resolutions.expect(Some(Action::SetGoal));
        self.status
            .act(Box::new(move |s, env| s.set_goal(&text, env)));
        rx
    }
}
