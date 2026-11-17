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

/// The pending transcript mirror `start()` seeds next to `title` (CC
/// 2.1.309): on the fresh branch, the stored title it just adopted, since a
/// rename made before the first turn of an earlier boot may never have
/// reached the transcript (that boot's pending mirror died with it). Never
/// on resume, where the transcript may hold a newer TUI rename.
pub fn start_mirror(title: &str, resume: Option<&str>) -> Option<String> {
    resume.is_none().then(|| title.to_owned())
}

/// What `flushPendingTitleMirror` does once its append of `appended` landed
/// (CC 2.1.309): clear the pending mirror, or re-assert the session's own
/// title when a newer rename replaced it while the append was in flight
/// (that rename's append may have been written first, leaving ours as the
/// last custom-title line).
#[derive(Clone, Debug, PartialEq, Eq)]
pub enum MirrorAfterAppend {
    /// `this.pendingTitleMirror = null`.
    Cleared,
    /// Append the session's current title too.
    Reassert(String),
    /// Nothing: a newer rename, but no current title to re-assert.
    Kept,
}

/// The decision, for the pending mirror as it reads *after* the append, the
/// name that was appended, and the session's current title.
pub fn mirror_after_append(
    pending: Option<&str>,
    appended: &str,
    title: Option<&str>,
) -> MirrorAfterAppend {
    if pending == Some(appended) {
        return MirrorAfterAppend::Cleared;
    }
    match title.filter(|t| !t.is_empty() && *t != appended) {
        Some(t) => MirrorAfterAppend::Reassert(t.to_owned()),
        None => MirrorAfterAppend::Kept,
    }
}
