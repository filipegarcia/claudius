//! `lib/client/boot-guard.ts` (CC 2.1.301): the guard that stops a
//! conversation which crashes or freezes the page from being reopened on
//! every reload.
//!
//! Before the boot resumes a session it writes a marker to the tab's
//! storage; once that session has replayed and rendered, the marker goes.
//! A boot that finds a marker from an earlier page load still naming the
//! session it is about to resume opens a fresh session instead, with an
//! "Open anyway" notice ([`SkippedBoot`]).
//!
//! The storage is the tab's `sessionStorage` ([`TabStorage`]); every
//! storage failure is swallowed, as in the TS (the guard is best effort).
//! `currentPageLoad()` (`performance.timeOrigin`) is the caller's: pass the
//! page load's id as `load`.
//!
//! One difference: the marker is read with `JSON.parse`, and a number past
//! the `f64` range (`1e400`, JS `Infinity`) reads as `null` here, as
//! everywhere in the port (`claudius_core::js_string::parse`), so such a
//! marker is no marker. The guard only ever writes finite times.

use serde::{Deserialize, Serialize};
use serde_json::{Value, json};

use crate::JsThrow;

/// `BOOT_MARKER_KEY`: the storage key of the pending-boot marker.
pub const BOOT_MARKER_KEY: &str = "claudius:boot-pending";

/// `BOOT_FORCE_KEY`: the storage key of the "Open anyway" choice.
pub const BOOT_FORCE_KEY: &str = "claudius:boot-force";

/// `BOOT_MARKER_TTL_MS`: an older marker is ignored (30 minutes).
pub const BOOT_MARKER_TTL_MS: f64 = 30.0 * 60.0 * 1000.0;

/// The `Storage` calls the guard makes. Each may throw (storage disabled
/// or full).
pub trait TabStorage {
    fn get_item(&mut self, key: &str) -> Result<Option<String>, JsThrow>;
    fn set_item(&mut self, key: &str, value: &str) -> Result<(), JsThrow>;
    fn remove_item(&mut self, key: &str) -> Result<(), JsThrow>;
}

/// The marker: which session, when, and which page load wrote it.
#[derive(Debug, Clone, PartialEq)]
struct Marker {
    id: String,
    at: f64,
    load: Option<f64>,
}

/// `readMarker(storage)`: an object with a string `id` and a number `at`
/// (and `load` when it is a number); anything else, a failed read and bad
/// JSON are none.
fn read_marker(storage: &mut dyn TabStorage) -> Option<Marker> {
    // `if (!raw) return null`: `""` doesn't parse either.
    let raw = storage.get_item(BOOT_MARKER_KEY).ok()??;
    let m = claudius_core::js_string::parse(&raw).ok()?;
    // `JSON.parse("null").id` throws, which the `catch` turns into none;
    // any other non-object has neither field.
    let id = m.get("id")?.as_str()?.to_owned();
    let at = m.get("at")?.as_f64()?;
    let load = m.get("load").and_then(Value::as_f64);
    Some(Marker { id, at, load })
}

/// `shouldSkipResume(id, storage, now, forced, load)`: the marker names
/// `id`, was written by another page load, and is younger than
/// [`BOOT_MARKER_TTL_MS`]. `forced` ("Open anyway") always resumes.
pub fn should_skip_resume(
    id: &str,
    storage: &mut dyn TabStorage,
    now: f64,
    forced: bool,
    load: f64,
) -> bool {
    if forced {
        return false;
    }
    read_marker(storage)
        .is_some_and(|m| m.id == id && m.load != Some(load) && now - m.at < BOOT_MARKER_TTL_MS)
}

/// `markBootAttempt(id, storage, now, load)`: this page load is about to
/// resume `id`.
pub fn mark_boot_attempt(id: &str, storage: &mut dyn TabStorage, now: f64, load: f64) {
    // `JSON.stringify`: a non-finite time is `null`.
    let marker = json!({ "id": id, "at": now, "load": load });
    let _ = storage.set_item(
        BOOT_MARKER_KEY,
        &claudius_core::js_string::stringify(&marker),
    );
}

/// `clearBootAttempt(storage)`.
fn clear_boot_attempt(storage: &mut dyn TabStorage) {
    let _ = storage.remove_item(BOOT_MARKER_KEY);
}

/// `clearBootAttemptFor(id, storage)`: session `id` replayed and rendered,
/// so a marker naming it goes (one naming another session stays).
pub fn clear_boot_attempt_for(id: &str, storage: &mut dyn TabStorage) {
    if read_marker(storage).is_some_and(|m| m.id == id) {
        clear_boot_attempt(storage);
    }
}

/// `SkippedBoot`: the session the boot declined to reopen (`id`) and the
/// fresh one it opened instead (`None`, written `null`, while that create is
/// in flight).
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SkippedBoot {
    pub id: String,
    pub fresh_id: Option<String>,
}

/// `scopeSkippedBoot(state, boundId)`: the notice stays while the fresh
/// session (or nothing yet) is bound, and goes once another session is,
/// the skipped one included.
pub fn scope_skipped_boot(
    state: Option<SkippedBoot>,
    bound_id: Option<&str>,
) -> Option<SkippedBoot> {
    let state = state?;
    let Some(bound) = bound_id.filter(|b| !b.is_empty()) else {
        return Some(state);
    };
    if bound == state.id {
        return None;
    }
    match state.fresh_id.as_deref() {
        None => Some(state),
        Some(fresh) if fresh == bound => Some(state),
        Some(_) => None,
    }
}

/// `consumeForcedResume(id, storage)`: read and clear the "Open anyway"
/// flag for `id`. A storage failure reads as not forced.
pub fn consume_forced_resume(id: &str, storage: &mut dyn TabStorage) -> bool {
    match storage.get_item(BOOT_FORCE_KEY) {
        Ok(Some(v)) if v == id => storage.remove_item(BOOT_FORCE_KEY).is_ok(),
        _ => false,
    }
}
