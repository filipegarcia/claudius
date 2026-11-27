//! The prompt cards (U08): what a live turn blocks on until the user
//! answers it.
//!
//! - [`permission`]: `PermissionPrompt.tsx` (the rule preview, the
//!   auto-mode tip, deny with feedback, the queue count).
//! - [`plan`]: `PlanOverlay.tsx`, `PlanModeBanner.tsx` and the decisions and
//!   toasts `ChatSurface.tsx` wires to them.
//! - [`elicitation`]: `lib/shared/elicitation.ts` and
//!   `McpElicitationPrompt.tsx` (the schema-driven form, the sign-in link).
//! - [`ask`]: `AskUserQuestionPrompt.tsx`, `formatAskAsPrompt` and the
//!   resurrected modal. The HTML preview is U08b's seam
//!   ([`ask::PreviewContent::Html`]).
//! - [`unicode`], [`arm`]: the shared guards (hidden characters, the arm
//!   window, typing focus).
//! - [`target`]: [`target::PromptTarget`], what the cards read and call.
//!
//! The modules above are pure (no GPUI); [`view`] puts them on screen.
pub mod arm;
pub mod ask;
pub mod elicitation;
pub mod permission;
pub mod plan;
pub mod target;
pub mod unicode;
pub mod view;

pub use target::{
    Act, FixturePromptSource, FixturePrompts, PromptSource, PromptState, PromptTarget,
};
pub use view::ChatPrompts;
