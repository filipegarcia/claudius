//! The chat's status line (U09a): `components/chat/StatusLine.tsx`, the
//! `ModeSelector` it mounts, and the model picker's model / effort /
//! Dynamic Workflows / fast rows (`components/panels/widgets/ModelPicker.tsx`,
//! the SessionCard's popover in the React app, opened here from the status
//! line's model chip), over claudius-client's `ChatState`.
//!
//! - [`line`]: the status line's segments as data ([`line::status_line`]
//!   over [`line::StatusProps`], what `ChatSurface` passes it), with the
//!   helpers it calls (`workingStatusLabel`, `worktreeBadge`,
//!   `modelDeprecationDate`, `fastModeDisabledReasonLabel`,
//!   `formatClockTime`, the cost / context formatting).
//! - [`modes`]: the permission modes, their menu and the Shift+Tab cycle.
//! - [`picker`]: the model picker's rows and choices, and the settings and
//!   context reads the status line makes.
//! - [`target`]: [`target::StatusTarget`], what it reads and calls;
//!   [`target::FixtureStatus`] for the tests and the screenshots.
//! - [`view`]: [`view::StatusLineView`], on screen.
pub mod line;
pub mod modes;
pub mod picker;
pub mod target;
pub mod tone;
pub mod view;

pub use target::{Act, FixtureStatus, StatusTarget};
pub use view::StatusLineView;
