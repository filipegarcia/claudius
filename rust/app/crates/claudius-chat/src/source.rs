//! Where the transcript's state comes from: [`TranscriptSource`], next to
//! the shell's `ShellData`. The live implementation (U04b) holds one
//! `ChatState` per bound session, fed by the transport's SSE events through
//! `claudius_client::apply`; [`crate::fixture::FixtureTranscripts`] builds
//! them by replaying recorded event logs.

use claudius_client::state::ChatState;
use futures::channel::mpsc::UnboundedReceiver;

/// A session's transcript changed: read it again.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct TranscriptChange {
    pub session_id: String,
}

/// The chat states the transcript renders, by session id.
pub trait TranscriptSource: Send + Sync + 'static {
    /// Calls `f` with the session's state; `false` (and no call) when the
    /// source holds none for that id, which the view shows as a fresh
    /// session.
    fn read(&self, session_id: &str, f: &mut dyn FnMut(&ChatState)) -> bool;

    /// Change notifications, from now on. Each call is a new stream.
    fn subscribe(&self) -> UnboundedReceiver<TranscriptChange>;
}
