//! [`LiveFilesData`]: the [`FilesData`] of a running engine, each method
//! the `fetch` the React page makes (the URLs from [`crate::rules`]), over
//! the workspace page's [`Transport`] (`claudius-app`'s
//! `TransportShellData::page`: its jar holds the workspace cookie, as the
//! browser's does on `/<id>/files`).
//!
//! The transport runs on tokio, so every request is spawned on the
//! engine's runtime and the answer awaited from the UI's executor.

use std::sync::Arc;

use claudius_transport::{Request, Response, Transport, TransportError};
use futures::FutureExt as _;

use crate::data::{
    self, ContentSearch, FileContent, FilesData, FilesFuture, Listing, NewKind, SearchResult,
    WorkspaceRoot,
};
use crate::rules;

/// A workspace's page transport.
pub type PageTransport = Arc<dyn Fn(&str) -> Arc<dyn Transport> + Send + Sync>;

pub struct LiveFilesData {
    rt: tokio::runtime::Handle,
    page: PageTransport,
}

impl LiveFilesData {
    /// Requests for workspace `id` go through `page(id)`, on `rt`.
    pub fn new(rt: tokio::runtime::Handle, page: PageTransport) -> Self {
        LiveFilesData { rt, page }
    }

    /// Every workspace through one transport.
    pub fn single(rt: tokio::runtime::Handle, transport: Arc<dyn Transport>) -> Self {
        LiveFilesData::new(rt, Arc::new(move |_| transport.clone()))
    }

    fn send<T: Send + 'static>(
        &self,
        ws: &str,
        req: Request,
        read: impl FnOnce(&Response) -> data::FilesResult<T> + Send + 'static,
    ) -> FilesFuture<T> {
        let t = (self.page)(ws);
        let task = self.rt.spawn(async move { t.fetch(req).await });
        async move {
            match task.await {
                Ok(Ok(res)) => read(&res),
                Ok(Err(e)) => Err(rejection(&e)),
                Err(e) => Err(e.to_string()),
            }
        }
        .boxed()
    }
}

/// `err.message` of `fetch`'s rejection: `Failed to fetch`, or `network
/// error` for a body cut off.
pub fn rejection(e: &TransportError) -> String {
    let text = e.page_text();
    text.strip_prefix("TypeError: ").unwrap_or(text).to_owned()
}

impl FilesData for LiveFilesData {
    fn roots(&self, ws: &str) -> FilesFuture<Vec<WorkspaceRoot>> {
        self.send(ws, Request::get(rules::roots_url(ws)), |r| {
            data::parse_roots(r.status, &r.text())
        })
    }

    fn list(&self, ws: &str, root: Option<&str>, path: &str) -> FilesFuture<Listing> {
        self.send(ws, Request::get(rules::list_url(ws, root, path)), |r| {
            data::parse_listing(r.status, &r.text())
        })
    }

    fn search(&self, ws: &str, root: Option<&str>, q: &str) -> FilesFuture<SearchResult> {
        self.send(ws, Request::get(rules::search_url(ws, root, q)), |r| {
            data::parse_search(r.status, &r.text())
        })
    }

    fn read(&self, ws: &str, root: &str, rel: &str) -> FilesFuture<FileContent> {
        let asked = root.to_owned();
        self.send(ws, Request::get(rules::file_url(ws, root, rel)), move |r| {
            data::parse_file(r.status, &r.text(), &asked)
        })
    }

    fn save(&self, ws: &str, root: &str, rel: &str, text: &str) -> FilesFuture<()> {
        // `fetch(url, {method: "PUT", body: draft})`: a string body.
        let req = Request::new("PUT", rules::file_url(ws, root, rel)).body(text.to_owned());
        self.send(ws, req, |r| data::parse_ok(r.status, &r.text()))
    }

    fn delete(&self, ws: &str, root: &str, rel: &str) -> FilesFuture<()> {
        let req = Request::new("DELETE", rules::file_url(ws, root, rel));
        self.send(ws, req, |r| data::parse_ok(r.status, &r.text()))
    }

    fn rename(&self, ws: &str, root: &str, rel: &str, next: &str) -> FilesFuture<()> {
        let req = Request::new("PATCH", rules::rename_url(ws, root, rel, next));
        self.send(ws, req, |r| data::parse_ok(r.status, &r.text()))
    }

    fn create(&self, ws: &str, root: &str, path: &str, kind: NewKind) -> FilesFuture<()> {
        let req = Request::post(rules::create_url(ws, root, path, kind));
        self.send(ws, req, |r| data::parse_ok(r.status, &r.text()))
    }

    fn content_search(
        &self,
        ws: &str,
        root: &str,
        folder: &str,
        q: &str,
        case_sensitive: bool,
    ) -> FilesFuture<ContentSearch> {
        let url = rules::content_search_url(ws, root, folder, q, case_sensitive);
        self.send(ws, Request::get(url), |r| {
            data::parse_content_search(r.status, &r.text())
        })
    }

    fn reveal(&self, ws: &str, root: Option<&str>, rel: &str) -> FilesFuture<()> {
        let req = Request::post(rules::reveal_url(ws)).json(rules::reveal_body(rel, root));
        self.send(ws, req, |r| data::parse_ok(r.status, &r.text()))
    }

    fn image(&self, ws: &str, root: &str, rel: &str) -> FilesFuture<(Vec<u8>, String)> {
        self.send(ws, Request::get(rules::serve_url(ws, root, rel)), |r| {
            data::parse_ok(r.status, &r.text())?;
            let ty = r
                .headers
                .get("content-type")
                .and_then(|v| v.to_str().ok())
                .unwrap_or_default()
                .to_owned();
            Ok((r.body.to_vec(), ty))
        })
    }
}
