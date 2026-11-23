//! The chat client's state machine: a port of `lib/client/use-session.ts`
//! (the React hook behind every chat pane) as plain Rust over the server's
//! events, with no UI toolkit and no transport. The native UI (U00: GPUI)
//! feeds it the same `ServerEvent`s the React hook reads over SSE, either
//! in-process from `claudius-core` or from a remote server (U02).
//!
//! U01a ports the hook's pure helpers, the ones `use-session.ts` defines
//! around `useSession` (most are exported for its unit tests), with the
//! `lib/client/types.ts` shapes they build and the `lib/shared` and
//! `lib/client/sdk-message-filters.ts` predicates they call. Each is
//! replayed against the real TS (`tests/client_helpers_golden.rs`, recorded
//! by `rust/scripts/client-helpers-golden.mjs`).
//!
//! **Parity contract.** The state types are typed structs, and a field the
//! TS leaves `undefined` is `None`, the same as a missing key: nothing in
//! the hook or the components reads these objects with `in`,
//! `Object.keys` or `JSON.stringify`, so presence is never observable. Key
//! order is kept where it is observable, in the `Record<string, T>` maps
//! the UI iterates ([`JsRecord`], JS own-key order). JS numbers stay `f64`.
//! Strings are JS strings: lone surrogates as `claudius_core::js_string`
//! stand-ins, lengths and slices in UTF-16 units. Where the TS throws on a
//! malformed event (a `null` content block), the port returns [`JsThrow`].
//!
//! One deliberate difference: where the TS copies an SDK field it types as
//! a string (a tool_use `id` / `name`, a message `uuid`) without checking
//! it, a non-string value reads as `""` here, and a non-boolean `is_error`
//! as absent, instead of travelling on as a number or object. The CLI
//! never writes one; the golden test lists each case where it shows.

pub mod account;
pub mod api_retry;
pub mod apply;
pub mod blocks;
pub mod boot_guard;
pub mod compact;
pub mod effect;
pub mod effort_wait;
pub mod env;
pub mod event;
pub mod idle_reconcile;
pub mod labels;
pub mod loops;
pub mod messages;
pub mod parse_init;
pub mod prompt_queue;
pub mod prompts;
pub mod queue;
pub mod refresh;
pub mod sdk;
pub mod sdk_filters;
pub mod shared;
pub mod state;
pub mod status;
pub mod stream_recovery;
pub mod system_entries;
pub mod system_events;
pub mod task_events;
pub mod task_status;
mod text;
pub mod types;
pub mod user_events;
pub mod workflow_meta;

pub use env::{ClientEnv, FixedEnv, SystemEnv};
pub use types::*;

/// A JS exception: what the TS helper throws for the same input (V8's
/// `TypeError` text for a property read on `null`, say).
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct JsThrow {
    pub name: &'static str,
    pub message: String,
}

impl JsThrow {
    pub fn type_error(message: impl Into<String>) -> Self {
        Self {
            name: "TypeError",
            message: message.into(),
        }
    }

    /// V8's `TypeError` for `null.<key>` (a property read on `null`).
    pub(crate) fn read_of_null(key: &str) -> Self {
        Self::type_error(format!("Cannot read properties of null (reading '{key}')"))
    }
}

impl std::fmt::Display for JsThrow {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        write!(f, "{}: {}", self.name, self.message)
    }
}

impl std::error::Error for JsThrow {}
