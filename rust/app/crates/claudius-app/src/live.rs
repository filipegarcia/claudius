//! [`TransportShellData`]: the [`ShellData`] of a running engine, through
//! the routes the React shell calls, over a [`Backend`]'s transports.
//!
//! | Method | Request |
//! |---|---|
//! | `workspaces` | `GET /api/workspaces` |
//! | `select_workspace` | `POST /api/workspaces/<id>/select` |
//! | `open_tabs` / `put_open_tabs` | `GET` / `PUT /api/sessions/open-tabs` |
//! | `sessions` | `GET /api/sessions?workspaceId=<id>` |
//! | `create_session` | `POST /api/sessions` with `{}` |
//! | `workspace_icon` | `GET /api/workspaces/<id>/icon` |
//! | `customizations` | `GET /api/customizations` |
//!
//! **Cookies.** The open-tabs routes and a cwd-less `POST /api/sessions`
//! scope to the `claudius.workspace` cookie, which the front door sets when
//! a page under `/<workspace id>` loads (`proxy.ts`). So each workspace is
//! its own "page" here, with its own cookie jar holding that cookie: its
//! strip reads and writes, its new sessions and its chat ([`LiveChat`]) all
//! go through it, and no two workspaces share one. The front door's jar
//! (the workspace list, `select`) holds what `select` sets.
//!
//! **Change notifications**, as the React app refreshes:
//! - [`ShellChange::Workspaces`] after a `select` (the store's active
//!   workspace moved; the React app reloads the page then). The shell also
//!   re-reads the list when its window comes to the front, as
//!   `useWorkspaces` does on `focus` / `visibilitychange`.
//! - [`ShellChange::Sessions`] after `create_session`, and whenever a
//!   workspace's chat re-read its session list (`refreshSessions`: after a
//!   switch or a create, on each turn's `result`, on `visibilitychange`, and
//!   by the hook's 30 s poll while anything runs). That is what moves the
//!   React strip's dots for the tabs the chat isn't bound to; the bound
//!   tab's dot reads the chat's own state, which its stream keeps live.
//! - [`ShellChange::OpenTabs`] after a `PUT`.
//!
//! The server pushes nothing else the shell reads: the notifications
//! stream carries unread counts (U15).

use std::collections::HashMap;
use std::sync::{Arc, Mutex};

use claudius_transport::{CookieJar, Request, Response, Transport, TransportError};
use futures::channel::mpsc::{UnboundedReceiver, UnboundedSender, unbounded};
use futures::future::FutureExt as _;
use serde_json::Value;

use crate::chat::{ChatPage, LiveChat};
use crate::data::{
    DataFuture, IconImage, OpenTabs, OpenTabsPut, SessionSummary, ShellChange, ShellData,
    WorkspaceList,
};
use crate::engine::Backend;

/// The workspace cookie (`active-workspace.ts`).
pub const WORKSPACE_COOKIE: &str = "claudius.workspace";

pub struct TransportShellData {
    backend: Arc<Backend>,
    front: Arc<dyn Transport>,
    pages: Mutex<HashMap<String, Arc<dyn Transport>>>,
    subscribers: Arc<Mutex<Vec<UnboundedSender<ShellChange>>>>,
}

impl TransportShellData {
    pub fn new(backend: Arc<Backend>) -> Self {
        let front = backend.transport(Arc::new(CookieJar::new()));
        TransportShellData {
            backend,
            front,
            pages: Mutex::default(),
            subscribers: Arc::default(),
        }
    }

    pub fn backend(&self) -> &Arc<Backend> {
        &self.backend
    }

    /// The front door's transport (the workspace list, `select`).
    pub fn front(&self) -> &Arc<dyn Transport> {
        &self.front
    }

    /// Workspace `id`'s page: a transport whose jar holds its cookie, as
    /// the front door sets it on `/<id>`.
    pub fn page(&self, id: &str) -> Arc<dyn Transport> {
        let mut pages = self.pages.lock().expect("pages lock");
        pages
            .entry(id.to_owned())
            .or_insert_with(|| {
                let jar = Arc::new(CookieJar::new());
                jar.set(&format!("{WORKSPACE_COOKIE}={id}; Path=/"));
                self.backend.transport(jar)
            })
            .clone()
    }

    fn notify(subscribers: &Mutex<Vec<UnboundedSender<ShellChange>>>, change: ShellChange) {
        subscribers
            .lock()
            .expect("subscribers lock")
            .retain(|tx| tx.unbounded_send(change.clone()).is_ok());
    }

    /// Runs `fut` on the engine's runtime; the caller may poll the answer
    /// from any executor.
    fn on_rt<T: Send + 'static>(
        &self,
        fut: impl std::future::Future<Output = anyhow::Result<T>> + Send + 'static,
    ) -> DataFuture<T> {
        let task = self.backend.handle().spawn(fut);
        async move { task.await.map_err(|e| anyhow::anyhow!("{e}"))? }.boxed()
    }
}

/// `fetch` then `res.ok` or the route's `{error}`.
async fn fetch_ok(t: &Arc<dyn Transport>, req: Request) -> anyhow::Result<Response> {
    let res = t.fetch(req).await.map_err(page_error)?;
    if !res.ok() {
        let msg = serde_json::from_slice::<Value>(&res.body)
            .ok()
            .and_then(|v| v.get("error").and_then(Value::as_str).map(str::to_owned))
            .unwrap_or_else(|| format!("HTTP {}", res.status));
        anyhow::bail!(msg);
    }
    Ok(res)
}

fn page_error(e: TransportError) -> anyhow::Error {
    anyhow::anyhow!("{}: {e}", e.page_text())
}

fn json<T: serde::de::DeserializeOwned>(res: &Response) -> anyhow::Result<T> {
    let text = res.text();
    let text = text.strip_prefix('\u{feff}').unwrap_or(&text);
    Ok(serde_json::from_str(text)?)
}

/// `encodeURIComponent` for an id in a path or a query.
fn enc(s: &str) -> String {
    url_escape(s)
}

fn url_escape(s: &str) -> String {
    let mut out = String::new();
    for b in s.bytes() {
        if b.is_ascii_alphanumeric() || b"-_.!~*'()".contains(&b) {
            out.push(char::from(b));
        } else {
            out.push_str(&format!("%{b:02X}"));
        }
    }
    out
}

/// `SideNav`'s enabled set from `GET /api/customizations`: the names
/// (lower-cased) of the customizations with a publish not reverted. `None`
/// for a reply that isn't ok (the rail keeps the gated tiles hidden, as
/// before an answer); an error (no reply, a body the TS would throw on) is
/// the empty set, as the `catch` sets it.
pub fn enabled_customizations(res: Result<&Response, ()>) -> Option<Vec<String>> {
    let Ok(res) = res else {
        return Some(Vec::new());
    };
    if !res.ok() {
        return None;
    }
    let parsed: Option<Value> = json(res).ok();
    let Some(d) = parsed else {
        return Some(Vec::new());
    };
    // `d.customizations.filter(...)` throws unless it's an array.
    let Some(list) = d.get("customizations").and_then(Value::as_array) else {
        return Some(Vec::new());
    };
    let live: Vec<&Value> = d
        .get("publishes")
        .and_then(Value::as_array)
        .map(|ps| {
            ps.iter()
                .filter(|p| p.get("revertedAt").is_none_or(Value::is_null))
                .filter_map(|p| p.get("customizationId"))
                .collect()
        })
        .unwrap_or_default();
    let mut names: Vec<String> = Vec::new();
    for c in list {
        let id = c.get("id");
        if !id.is_some_and(|id| live.contains(&id)) {
            continue;
        }
        // `c.name.toLowerCase()` throws on a non-string.
        let Some(name) = c.get("name").and_then(Value::as_str) else {
            return Some(Vec::new());
        };
        let lower = name.to_lowercase();
        if !names.contains(&lower) {
            names.push(lower);
        }
    }
    Some(names)
}

impl ShellData for TransportShellData {
    fn workspaces(&self) -> DataFuture<WorkspaceList> {
        let t = self.front.clone();
        self.on_rt(async move {
            let res = fetch_ok(&t, Request::get("/api/workspaces")).await?;
            json(&res)
        })
    }

    fn select_workspace(&self, id: &str) -> DataFuture<()> {
        let t = self.front.clone();
        let url = format!("/api/workspaces/{}/select", enc(id));
        let subscribers = self.subscribers.clone();
        self.on_rt(async move {
            fetch_ok(&t, Request::post(url)).await?;
            Self::notify(&subscribers, ShellChange::Workspaces);
            Ok(())
        })
    }

    fn open_tabs(&self, workspace_id: &str) -> DataFuture<OpenTabs> {
        let t = self.page(workspace_id);
        self.on_rt(async move {
            let res = fetch_ok(&t, Request::get("/api/sessions/open-tabs")).await?;
            json(&res)
        })
    }

    fn put_open_tabs(&self, workspace_id: &str, body: OpenTabsPut) -> DataFuture<()> {
        let t = self.page(workspace_id);
        let subscribers = self.subscribers.clone();
        let ws = workspace_id.to_owned();
        self.on_rt(async move {
            let text = serde_json::to_string(&body)?;
            fetch_ok(
                &t,
                Request::new("PUT", "/api/sessions/open-tabs").json(text),
            )
            .await?;
            Self::notify(&subscribers, ShellChange::OpenTabs { workspace_id: ws });
            Ok(())
        })
    }

    fn sessions(&self, workspace_id: &str) -> DataFuture<Vec<SessionSummary>> {
        let t = self.front.clone();
        let url = format!("/api/sessions?workspaceId={}", enc(workspace_id));
        self.on_rt(async move {
            let res = fetch_ok(&t, Request::get(url)).await?;
            // A row the shell can't read (no id, a status it doesn't know)
            // is left out rather than failing the list.
            let rows: Vec<Value> = json(&res)?;
            Ok(rows
                .into_iter()
                .filter_map(|r| serde_json::from_value(r).ok())
                .collect())
        })
    }

    fn create_session(&self, workspace_id: &str) -> DataFuture<String> {
        let t = self.page(workspace_id);
        let subscribers = self.subscribers.clone();
        let ws = workspace_id.to_owned();
        self.on_rt(async move {
            let res = fetch_ok(&t, Request::post("/api/sessions").json("{}")).await?;
            let v: Value = json(&res)?;
            let id = v
                .get("id")
                .and_then(Value::as_str)
                .ok_or_else(|| anyhow::anyhow!("no session id in the reply"))?
                .to_owned();
            Self::notify(&subscribers, ShellChange::Sessions { workspace_id: ws });
            Ok(id)
        })
    }

    fn workspace_icon(&self, id: &str) -> DataFuture<Option<IconImage>> {
        let t = self.front.clone();
        let url = format!("/api/workspaces/{}/icon", enc(id));
        self.on_rt(async move {
            let res = t.fetch(Request::get(url)).await.map_err(page_error)?;
            if !res.ok() {
                return Ok(None);
            }
            let content_type = res
                .headers
                .get("content-type")
                .and_then(|v| v.to_str().ok())
                .unwrap_or_default()
                .to_owned();
            Ok(Some(IconImage {
                bytes: res.body.to_vec(),
                content_type,
            }))
        })
    }

    fn customizations(&self) -> DataFuture<Option<Vec<String>>> {
        let t = self.front.clone();
        self.on_rt(async move {
            let res = t.fetch(Request::get("/api/customizations")).await;
            Ok(enabled_customizations(res.as_ref().map_err(|_| ())))
        })
    }

    fn open_chat(&self, workspace_id: &str, href: &str, pathname: &str) -> Option<ChatPage> {
        let (chat, ui) = LiveChat::spawn(
            &self.backend.handle(),
            self.page(workspace_id),
            workspace_id,
            href,
            pathname,
        );
        // The chat's session list moving is the shell's cue to re-read the
        // workspace's (see the module docs).
        let mut changes = chat.changes();
        let subscribers = self.subscribers.clone();
        let ws = workspace_id.to_owned();
        self.backend.handle().spawn(async move {
            let mut seen = changes.borrow().state.sessions.clone();
            while changes.changed().await.is_ok() {
                let now = changes.borrow().state.sessions.clone();
                if now != seen {
                    seen = now;
                    Self::notify(
                        &subscribers,
                        ShellChange::Sessions {
                            workspace_id: ws.clone(),
                        },
                    );
                }
            }
        });
        Some(ChatPage { chat, ui })
    }

    fn has_live_chat(&self) -> bool {
        true
    }

    fn subscribe(&self) -> UnboundedReceiver<ShellChange> {
        let (tx, rx) = unbounded();
        self.subscribers.lock().expect("subscribers lock").push(tx);
        rx
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use bytes::Bytes;
    use http::HeaderMap;
    use serde_json::json;

    fn res(status: u16, body: Value) -> Response {
        Response {
            status,
            headers: HeaderMap::new(),
            body: Bytes::from(body.to_string()),
        }
    }

    #[test]
    fn the_enabled_set_follows_side_nav() {
        let d = json!({
            "customizations": [
                {"id": "c1", "name": "Docker"},
                {"id": "c2", "name": "Tracker"},
                {"id": "c3", "name": "Database"},
                {"id": "c4", "name": "DOCKER"},
            ],
            "publishes": [
                {"customizationId": "c1", "revertedAt": null},
                {"customizationId": "c2", "revertedAt": 1},
                {"customizationId": "c3"},
                {"customizationId": "c4", "revertedAt": null},
            ],
        });
        assert_eq!(
            enabled_customizations(Ok(&res(200, d))),
            Some(vec!["docker".into(), "database".into()])
        );
        // Not ok: unknown (hidden). Failed or unreadable: the empty set.
        assert_eq!(enabled_customizations(Ok(&res(500, json!({})))), None);
        assert_eq!(enabled_customizations(Err(())), Some(vec![]));
        assert_eq!(
            enabled_customizations(Ok(&res(200, json!({"publishes": []})))),
            Some(vec![])
        );
        // No publishes key: nothing is live.
        assert_eq!(
            enabled_customizations(Ok(&res(
                200,
                json!({"customizations": [{"id": "c1", "name": "Docker"}]})
            ))),
            Some(vec![])
        );
        // A live one without a string name throws: the empty set.
        assert_eq!(
            enabled_customizations(Ok(&res(
                200,
                json!({"customizations": [{"id": "c1", "name": 3}], "publishes": [{"customizationId": "c1"}]})
            ))),
            Some(vec![])
        );
        let bad = Response {
            status: 200,
            headers: HeaderMap::new(),
            body: Bytes::from_static(b"not json"),
        };
        assert_eq!(enabled_customizations(Ok(&bad)), Some(vec![]));
    }

    #[test]
    fn ids_are_uri_components() {
        assert_eq!(enc("wks_3f2a9c81d0e4"), "wks_3f2a9c81d0e4");
        assert_eq!(enc("a b/c?d&e#é"), "a%20b%2Fc%3Fd%26e%23%C3%A9");
        assert_eq!(enc("-_.!~*'()"), "-_.!~*'()");
    }
}
