//! The Files page (U12c): `app/[workspaceId]/files/page.tsx` and what it
//! mounts from `components/files/` (the tree, the highlighted editor, the
//! binary placeholder, the path context menu), with find in file, find in
//! folder and the last-open memory, which the React page has as modules
//! but doesn't render (see [`view`] for where the native page puts them).
//!
//! - [`rules`]: the pure helpers (URLs, labels, sizes, the shortcut
//!   matcher, the find matchers, the grammar of a path), each citing its TS.
//! - [`data`]: [`data::FilesData`], one method per `fetch` the page makes,
//!   and the TS's reads of an answer.
//! - [`model`]: [`model::FilesPage`], the page's state and handlers as a
//!   pure state machine returning effects.
//! - [`live`]: the `FilesData` over a `claudius-transport` `Transport`.
//! - [`fixture`]: an in-memory `FilesData` for the tests and screenshots.
//! - [`view`]: the GPUI screen, [`view::FilesScreen`].
//!
//! Highlighting is gpui-component's (its syntect backend) with
//! `claudius-gpui-theme`'s highlight styles, the ones the chat's code
//! blocks paint with: Shiki's `github-dark-default`.

pub mod data;
pub mod fixture;
pub mod last_open;
pub mod live;
pub mod model;
pub mod rules;
pub mod view;

pub use data::{FilesData, SharedFilesData};
pub use view::{FilesEvent, FilesScreen};
