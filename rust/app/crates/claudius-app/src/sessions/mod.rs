//! The sessions browser (U11): `app/[workspaceId]/sessions/page.tsx` (the
//! list, its search, filters and row actions) and
//! `app/[workspaceId]/sessions/[id]/page.tsx` (one session's header,
//! actions and read-only transcript), over the [`data::SessionsData`]
//! trait.
//!
//! [`list::SessionsList`] and [`detail::SessionDetail`] hold the pages'
//! logic without GPUI, with the TS rules they rank and label by in
//! [`search`] and the transcript's rows in [`transcript`];
//! [`view::SessionsScreen`] puts them on screen inside the shell.
//! [`fixture::FixtureSessionsData`] answers from a JSON file;
//! [`live::TransportSessionsData`] sends each request to the engine's
//! routes, its unread counts from the notifications stream ([`unread`]).

pub mod data;
pub mod detail;
pub mod fixture;
pub mod list;
pub mod live;
pub mod search;
pub mod transcript;
pub mod unread;
pub mod view;
