//! The chat composer (U07a): `components/chat/PromptInput.tsx` (the editor
//! and everything around sending), `QueueIndicator.tsx` and
//! `PromptSuggestions.tsx`, over `claudius_client::ChatState`.
//!
//! - [`rules`]: the pure TS helpers it calls (prompt history, the draft
//!   flush, the failed-send placement, markdown lists, the invisible
//!   Unicode strip, `commandNeedsSudo`, ...), replayed against the TS.
//! - [`model`]: [`model::Composer`], the component's state and handlers
//!   as a state machine (keys, history, drafts, send / queue / stop, `!`
//!   bash mode, the queue strip's actions), returning what to do.
//! - [`target`]: [`target::ComposerTarget`], what the composer reads and
//!   calls on the session; [`fixture`] implements it over claudius-chat's
//!   `FixtureTranscripts` (a sent prompt shows, the demo replies).
//! - [`view`]: [`view::ComposerView`], the GPUI view under the transcript.
//!
//! Seams left for the next slices: the pickers (U07b) fill
//! [`model::Composer::refresh_picker_state`] / [`model::PickerState`] and
//! open over the box; images, inline pastes and voice (U07c) attach
//! through the editor's paste hook ([`view::ComposerView`]'s `on_paste`)
//! into the composer's `images`.
pub mod fixture;
pub mod model;
pub mod rules;
pub mod target;
pub mod view;

pub use model::{Composer, Out, SessionView};
pub use target::{ComposerTarget, Resolutions, SessionCall};
pub use view::ComposerView;
