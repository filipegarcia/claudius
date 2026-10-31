//! A session's display title: `resolveSessionTitle` and the two places
//! session.ts reads the persisted title through it, `start()` and
//! `sendFreshTitle`. The store is `sessions_db::get_session_title` (the
//! per-project row, then the legacy `session-titles.json`); the SDK side is
//! `sessions_store::info`'s `customTitle`.

use claudius_agent::js;

use crate::{sessions_db, sessions_store};

/// `resolveSessionTitle({ local, info })`: the JS-trimmed `local` (our row),
/// else the JS-trimmed `info.customTitle` (the SDK's rename or AI title),
/// else `None`. Never the SDK's `summary`, which falls back to prompt text.
pub fn resolve_session_title(local: Option<&str>, custom_title: Option<&str>) -> Option<String> {
    [local, custom_title]
        .into_iter()
        .flatten()
        .map(js::trim)
        .find(|s| !s.is_empty())
        .map(str::to_owned)
}

/// `start()`'s title. Resuming: `resolveSessionTitle` over the row for the
/// resumed id, asking the SDK only when there is no row title; a database
/// error leaves no title at all (the TS `try` aborts before the SDK read).
/// Fresh: the row for this id as stored, untrimmed, without the SDK.
pub fn start_title(cwd: &str, id: &str, resume: Option<&str>) -> Option<String> {
    let Some(resume) = resume else {
        return sessions_db::get_session_title(cwd, id).ok().flatten();
    };
    let local = sessions_db::get_session_title(cwd, resume).ok()?;
    let custom = match local {
        Some(_) => None,
        None => sessions_store::info(resume, Some(cwd)).and_then(|i| i.custom_title),
    };
    resolve_session_title(local.as_deref(), custom.as_deref())
}

/// What `sendFreshTitle` does for a new subscriber.
#[derive(Clone, Debug, PartialEq, Eq)]
pub enum FreshTitle {
    /// The resolved title differs from the current one: adopt it, broadcast
    /// `session_title` to every subscriber and `upsertSession` with it.
    Moved(String),
    /// Unchanged (or nothing resolved): echo the current title to this
    /// subscriber only.
    Echo(String),
    /// No resolved and no current title: send nothing.
    Quiet,
}

/// `sendFreshTitle`'s decision: `resolveSessionTitle` over the row (a
/// database error counts as no row) and, without a row title, the SDK's.
pub fn fresh_title(cwd: &str, id: &str, current: Option<&str>) -> FreshTitle {
    let local = sessions_db::get_session_title(cwd, id).ok().flatten();
    let custom = match local {
        Some(_) => None,
        None => sessions_store::info(id, Some(cwd)).and_then(|i| i.custom_title),
    };
    match resolve_session_title(local.as_deref(), custom.as_deref()) {
        Some(next) if Some(next.as_str()) != current => FreshTitle::Moved(next),
        _ => match current.filter(|t| !t.is_empty()) {
            Some(t) => FreshTitle::Echo(t.to_owned()),
            None => FreshTitle::Quiet,
        },
    }
}
