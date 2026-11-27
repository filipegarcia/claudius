//! The chat transcript (U05): `components/chat/MessageList.tsx` and the row
//! components it renders, over `claudius_client::ChatState`.
//!
//! - [`rows`]: the list's decisions as data, no GPUI ([`rows::rows`]).
//! - [`verbose`]: the port of `lib/shared/verbose.ts`.
//! - [`text`]: the string helpers the rows call.
//! - [`source`]: [`source::TranscriptSource`], where the states come from;
//!   [`fixture`] replays recorded logs, [`script`] writes them as code.
//! - [`view`]: [`view::TranscriptView`], the virtualized list on screen;
//!   [`markdown`] keeps the parsed markdown near the viewport.
pub mod fixture;
pub mod markdown;
pub mod rows;
pub mod script;
pub mod source;
pub mod text;
pub mod verbose;
pub mod view;

pub use source::{TranscriptChange, TranscriptSource};
pub use view::TranscriptView;
