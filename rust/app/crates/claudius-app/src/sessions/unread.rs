//! The unread notification counts the Sessions page badges its rows with:
//! `NotificationsProvider`'s `byWorkspace` map, read as
//! `unreadBySessionByWorkspace[workspaceId]`.
//!
//! [`UnreadStates`] is the map with the provider's version gate (a state is
//! taken only when its `version` is newer than the one held, so a slow
//! `/api/notifications/counts` answer can't undo a fresher stream event).
//! [`feed`] keeps it current the way the provider does:
//!
//! - on start, `GET /api/notifications/counts` (`{states: {id: state}}`);
//! - `GET /api/notifications/stream` as an `EventSource`, each `state`
//!   message applied (the `notification` rows are the toasts and the drawer,
//!   U15);
//! - on the stream's `error`: close it, fetch the counts again, and reopen
//!   after the backoff (1 s, doubling to 15 s; back to 1 s on `open`).
//!
//! Not here: the provider's `visibilitychange` / `online` re-fetch (a
//! dropped stream's recovery; [`super::live::TransportSessionsData::refresh_unread`]
//! is that fetch, for whoever watches the window), and its auto-read of a
//! notification for the session on screen (the chat's, U15).

use std::collections::{BTreeMap, HashMap};
use std::sync::{Arc, Mutex};
use std::time::Duration;

use claudius_transport::{EventSourceEvent, Request, Transport};
use serde_json::Value;

/// `/api/notifications/stream`.
pub const STREAM_URL: &str = "/api/notifications/stream";
/// `/api/notifications/counts`.
pub const COUNTS_URL: &str = "/api/notifications/counts";
/// The reconnect backoff's first step and its cap (`backoff = 1000`,
/// `Math.min(backoff * 2, 15000)`).
pub const BACKOFF_START: Duration = Duration::from_millis(1000);
pub const BACKOFF_MAX: Duration = Duration::from_millis(15000);

/// One workspace's `WorkspaceUnreadState`, as the page reads it.
#[derive(Clone, Debug, PartialEq)]
struct Held {
    /// A JS number: `cur.version >= s.version` compares as one.
    version: f64,
    per_session: BTreeMap<String, u32>,
}

/// The provider's `byWorkspace`.
#[derive(Clone, Debug, Default, PartialEq)]
pub struct UnreadStates {
    by_workspace: HashMap<String, Held>,
}

/// A count as the badge reads it: a number, else none (the page's
/// `?? 0`). Fractions and negatives don't come from the server; they read
/// as the whole part, at least 0 (`as` saturates).
fn count(v: &Value) -> Option<u32> {
    v.as_f64().map(|n| n as u32)
}

impl UnreadStates {
    /// `applyState(s)`: takes `s` unless the held state's version is at
    /// least as new. `Some(workspace id)` when it took it and the
    /// per-session counts moved (the only thing the page reads).
    pub fn apply(&mut self, state: &Value) -> Option<String> {
        let ws = state.get("workspaceId")?.as_str()?;
        // `cur.version >= s.version` is false for an absent / NaN version:
        // then the state is taken.
        let version = state
            .get("version")
            .and_then(Value::as_f64)
            .unwrap_or(f64::NAN);
        if let Some(cur) = self.by_workspace.get(ws)
            && cur.version >= version
        {
            return None;
        }
        let per_session: BTreeMap<String, u32> = state
            .get("perSession")
            .and_then(Value::as_object)
            .map(|m| {
                m.iter()
                    .filter_map(|(k, v)| Some((k.clone(), count(v)?)))
                    .collect()
            })
            .unwrap_or_default();
        let moved = self
            .by_workspace
            .get(ws)
            .is_none_or(|cur| cur.per_session != per_session);
        self.by_workspace.insert(
            ws.to_owned(),
            Held {
                version,
                per_session,
            },
        );
        moved.then(|| ws.to_owned())
    }

    /// `applyStates(data.states)`: each of the counts route's states, in
    /// order, gated on its own. The workspaces whose counts moved.
    pub fn apply_counts(&mut self, body: &Value) -> Vec<String> {
        let Some(states) = body.get("states").and_then(Value::as_object) else {
            return Vec::new();
        };
        states.values().filter_map(|s| self.apply(s)).collect()
    }

    /// `unreadBySessionByWorkspace[id] ?? {}`.
    pub fn per_session(&self, workspace_id: &str) -> BTreeMap<String, u32> {
        self.by_workspace
            .get(workspace_id)
            .map(|h| h.per_session.clone())
            .unwrap_or_default()
    }
}

/// A stream message's state: the `{type: "state", …}` envelope's data, or
/// `None` (another type, or a payload that doesn't parse: the provider's
/// `catch` ignores it).
pub fn stream_state(data: &str) -> Option<Value> {
    let v: Value = serde_json::from_str(data).ok()?;
    (v.get("type").and_then(Value::as_str) == Some("state")).then_some(v)
}

/// Called with each workspace whose counts moved.
pub type OnMoved = Arc<dyn Fn(&str) + Send + Sync>;

/// The counts fetch: `if (!res.ok) return null`, a body without `states`
/// is nothing, and any failure is dropped (best effort).
pub async fn fetch_counts(t: Arc<dyn Transport>, states: Arc<Mutex<UnreadStates>>, moved: OnMoved) {
    let Ok(res) = t.fetch(Request::get(COUNTS_URL)).await else {
        return;
    };
    if !res.ok() {
        return;
    }
    let text = res.text();
    let Ok(body) = serde_json::from_str::<Value>(text.strip_prefix('\u{feff}').unwrap_or(&text))
    else {
        return;
    };
    let ids = states.lock().expect("unread lock").apply_counts(&body);
    for ws in ids {
        moved(&ws);
    }
}

/// The provider's boot fetch and live stream, until the task is dropped
/// (see the module docs). Call it on a tokio runtime.
pub async fn feed(t: Arc<dyn Transport>, states: Arc<Mutex<UnreadStates>>, moved: OnMoved) {
    tokio::spawn(fetch_counts(t.clone(), states.clone(), moved.clone()));
    let mut backoff = BACKOFF_START;
    loop {
        let mut es = t.event_source(STREAM_URL);
        while let Some(ev) = es.recv().await {
            match ev {
                EventSourceEvent::Open => backoff = BACKOFF_START,
                // `onmessage`: the default event type only.
                EventSourceEvent::Message {
                    data, event_type, ..
                } if event_type == "message" => {
                    let Some(state) = stream_state(&data) else {
                        continue;
                    };
                    let ws = states.lock().expect("unread lock").apply(&state);
                    if let Some(ws) = ws {
                        moved(&ws);
                    }
                }
                EventSourceEvent::Message { .. } => {}
                EventSourceEvent::Error { .. } => break,
            }
        }
        // `es.close()`, `refreshCounts()`, `setTimeout(open, backoff)`.
        es.close();
        drop(es);
        tokio::spawn(fetch_counts(t.clone(), states.clone(), moved.clone()));
        tokio::time::sleep(backoff).await;
        backoff = (backoff * 2).min(BACKOFF_MAX);
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    fn state(ws: &str, version: Value, per: Value) -> Value {
        json!({"type": "state", "workspaceId": ws, "version": version, "totalUnread": 0, "perSession": per})
    }

    #[test]
    fn a_state_is_taken_only_when_newer() {
        let mut u = UnreadStates::default();
        assert_eq!(
            u.apply(&state("w1", json!(2), json!({"s1": 3, "s2": 1}))),
            Some("w1".into())
        );
        assert_eq!(
            u.per_session("w1"),
            BTreeMap::from([("s1".into(), 3), ("s2".into(), 1)])
        );
        // Older or the same version: dropped.
        assert_eq!(u.apply(&state("w1", json!(1), json!({}))), None);
        assert_eq!(u.apply(&state("w1", json!(2), json!({}))), None);
        assert_eq!(u.per_session("w1").len(), 2);
        // Newer with the same counts: taken, but nothing moved.
        assert_eq!(
            u.apply(&state("w1", json!(3), json!({"s1": 3, "s2": 1}))),
            None
        );
        // Newer, fewer: moved; the version is now 4.
        assert_eq!(
            u.apply(&state("w1", json!(4), json!({"s2": 1}))),
            Some("w1".into())
        );
        assert_eq!(u.apply(&state("w1", json!(3), json!({"s9": 9}))), None);
        assert_eq!(u.per_session("w1"), BTreeMap::from([("s2".into(), 1)]));
        // Another workspace is its own; an unknown one is empty.
        assert_eq!(
            u.apply(&state("w2", json!(1), json!({"s3": 120}))),
            Some("w2".into())
        );
        assert_eq!(u.per_session("w2"), BTreeMap::from([("s3".into(), 120)]));
        assert!(u.per_session("w3").is_empty());
    }

    #[test]
    fn odd_states_read_as_the_provider_reads_them() {
        let mut u = UnreadStates::default();
        // No version: `cur.version >= undefined` is false, so it's taken,
        // and then any state (even an older-looking one) replaces it.
        assert_eq!(
            u.apply(&state("w1", Value::Null, json!({"a": 1}))),
            Some("w1".into())
        );
        assert_eq!(
            u.apply(&state("w1", json!(0), json!({"a": 2}))),
            Some("w1".into())
        );
        // Counts that aren't numbers are left out; fractions keep their
        // whole part, negatives read as 0.
        assert_eq!(
            u.apply(&state(
                "w1",
                json!(5),
                json!({"a": "2", "b": null, "c": 2.7, "d": -1, "e": 1e12})
            )),
            Some("w1".into())
        );
        assert_eq!(
            u.per_session("w1"),
            BTreeMap::from([("c".into(), 2), ("d".into(), 0), ("e".into(), u32::MAX)])
        );
        // No workspace id: nothing to file it under.
        assert_eq!(
            u.apply(&json!({"type": "state", "version": 9, "perSession": {}})),
            None
        );
        // No perSession: an empty map.
        assert_eq!(
            u.apply(&json!({"workspaceId": "w1", "version": 6})),
            Some("w1".into())
        );
        assert!(u.per_session("w1").is_empty());
    }

    #[test]
    fn the_counts_body_applies_each_state() {
        let mut u = UnreadStates::default();
        u.apply(&state("w1", json!(5), json!({"x": 1})));
        let body = json!({"states": {
            "w1": state("w1", json!(4), json!({"stale": 1})),
            "w2": state("w2", json!(1), json!({"y": 2})),
            // The key isn't what files it: `s.workspaceId` is.
            "k": state("w3", json!(1), json!({"z": 3})),
        }});
        assert_eq!(
            u.apply_counts(&body),
            vec!["w2".to_owned(), "w3".to_owned()]
        );
        assert_eq!(u.per_session("w1"), BTreeMap::from([("x".into(), 1)]));
        assert_eq!(u.per_session("w3"), BTreeMap::from([("z".into(), 3)]));
        assert!(u.apply_counts(&json!({})).is_empty());
        assert!(u.apply_counts(&json!({"states": []})).is_empty());
    }

    #[test]
    fn only_state_messages_count() {
        let s = stream_state(r#"{"type":"state","workspaceId":"w1","version":1}"#).unwrap();
        assert_eq!(s["workspaceId"], "w1");
        assert_eq!(
            stream_state(r#"{"type":"notification","notification":{}}"#),
            None
        );
        assert_eq!(stream_state("not json"), None);
        assert_eq!(stream_state("[1]"), None);
    }
}
