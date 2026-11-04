//! `POST /api/sessions/fork`'s call into the SDK (D05): `fork(body.sessionId,
//! { upToMessageId, title, dir })` (`lib/server/sessions-store.ts`) with the
//! request body's values as they come, so a value of the wrong type throws
//! what `forkSession` (SDK 0.3.312 `V0` / `Z0`) throws for it, where it
//! throws it:
//!
//! 1. a `sessionId` that isn't a UUID string: `Invalid sessionId: ${id}`;
//! 2. a truthy `dir` that isn't a string, before any lookup: darwin
//!    NFC-normalizes it (`e.normalize is not a function`); elsewhere the
//!    project-dir encoder is the first to call a string method on it
//!    (`e.replace is not a function`, by inspection);
//! 3. the lookup ([`sessions_store::fork_source`]; a falsy `dir` searches
//!    every project);
//! 4. a truthy `upToMessageId` that isn't a string matches no message:
//!    `Message ${upTo} not found in session …`, after the "no messages"
//!    check;
//! 5. a `title` other than a string, `null` or missing:
//!    `n.title?.trim is not a function` once the copy is built, so nothing
//!    is written.
//!
//! `${v}` is JS's `String(v)` ([`js_string::to_js_string`]); an object with
//! its own `toString` throws "Cannot convert object to primitive value"
//! there instead. Replayed against the TS in
//! `claudius-server/tests/worktrees_fork.rs`.

use claudius_agent::js;
use serde_json::Value;

use crate::{js_string, sessions_store};

/// `ToPrimitive`'s `TypeError` for an object whose `toString` isn't callable.
const NO_PRIMITIVE: &str = "Cannot convert object to primitive value";

/// What a truthy non-string `dir` throws (see the module doc).
#[cfg(target_os = "macos")]
const DIR_NOT_A_STRING: &str = "e.normalize is not a function";
#[cfg(not(target_os = "macos"))]
const DIR_NOT_A_STRING: &str = "e.replace is not a function";

/// What a `title` that is neither a string nor nullish throws.
const TITLE_NOT_A_STRING: &str = "n.title?.trim is not a function";

/// The `upToMessageId` a non-string one is searched as: no entry's uuid.
const NO_MESSAGE: &str = "\u{0}claudius: not a message id\u{0}";

/// `` `${v}` ``, or the `TypeError` it throws.
fn template(v: &Value) -> Result<String, String> {
    js_string::to_js_string(v).map_err(|_| NO_PRIMITIVE.to_owned())
}

/// `await fork(sessionId, { upToMessageId, title, dir })`: the fork's id,
/// or the message of what it throws. `None` is `undefined`.
pub fn fork_js(
    session_id: &Value,
    up_to_message_id: Option<&Value>,
    title: Option<&Value>,
    dir: Option<&Value>,
) -> Result<String, String> {
    let sid = match session_id {
        Value::String(s) if sessions_store::is_uuid(s) => s.as_str(),
        other => return Err(format!("Invalid sessionId: {}", template(other)?)),
    };
    let dir = match dir {
        Some(Value::String(d)) if !d.is_empty() => Some(d.as_str()),
        Some(v) if js::truthy(v) => return Err(DIR_NOT_A_STRING.into()),
        _ => None,
    };
    let file = sessions_store::fork_source(sid, dir).map_err(|e| e.to_string())?;
    let up_to = match up_to_message_id {
        Some(Value::String(s)) => Some(s.as_str()),
        Some(v) if js::truthy(v) => Some(NO_MESSAGE),
        _ => None,
    };
    let (title, title_throws) = match title {
        None | Some(Value::Null) => (None, false),
        Some(Value::String(t)) => (Some(t.as_str()), false),
        Some(_) => (None, true),
    };
    let (text, fork_id) = sessions_store::fork_text(&file, sid, up_to, title).map_err(|e| {
        let message = e.to_string();
        match up_to_message_id {
            Some(v) if message == format!("Message {NO_MESSAGE} not found in session {sid}") => {
                template(v)
                    .map_or_else(|e| e, |v| format!("Message {v} not found in session {sid}"))
            }
            _ => message,
        }
    })?;
    if title_throws {
        return Err(TITLE_NOT_A_STRING.into());
    }
    sessions_store::write_fork(&file, &fork_id, &text).map_err(|e| e.to_string())?;
    Ok(fork_id)
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    #[test]
    fn the_id_is_checked_first() {
        let bad_dir = json!(5);
        assert_eq!(
            fork_js(&json!(5), None, None, Some(&bad_dir)),
            Err("Invalid sessionId: 5".into())
        );
        assert_eq!(
            fork_js(&json!({"toString": 1}), None, None, None),
            Err(NO_PRIMITIVE.into())
        );
        assert_eq!(
            fork_js(
                &json!("11111111-1111-4111-8111-111111111111"),
                None,
                None,
                Some(&bad_dir)
            ),
            Err(DIR_NOT_A_STRING.into())
        );
    }
}
