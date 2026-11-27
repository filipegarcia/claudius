//! The chat composer (U07a, U07b): `components/chat/PromptInput.tsx` (the editor
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
//! - [`slash`], [`mention`], [`emoji`] (U07b): the pickers' pure rules
//!   (the slash command list and its fuzzy match, the `@` file / agent
//!   mentions, the `:shortcode:` table), replayed against the TS; the
//!   model keeps the open menu ([`model::PickerState`], [`model::Menu`])
//!   and the view draws it over the box.
//!
//! Seams left for the next slices: the picked slash command's dispatch
//! (U07d) still sends as plain text; images, inline pastes and voice
//! (U07c) attach through the editor's paste hook ([`view::ComposerView`]'s
//! `on_paste`) into the composer's `images`.
pub mod emoji;
pub mod fixture;
pub mod mention;
pub mod model;
pub mod rules;
pub mod slash;
pub mod target;
pub mod view;

pub use model::{Composer, Out, SessionView};
pub use target::{ComposerTarget, Resolutions, SessionCall};
pub use view::ComposerView;
