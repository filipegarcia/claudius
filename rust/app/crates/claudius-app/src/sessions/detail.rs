//! One session's page (`app/[workspaceId]/sessions/[id]/page.tsx`) without
//! GPUI: its metadata and transcript (`info` + `transcript`, as one
//! `Promise.all`), the header's title and rename box, and its actions
//! (resume, fork, rewind, export, raw, delete) with their errors.

use serde_json::Value;

use super::data::{
    Reply, SessionsRequest, StoredSession, TranscriptPage, action_result, fork_result,
};
use super::list::resume_href;
use super::search::{self, js_trim};
use super::transcript::{self, Row};
use crate::route::encode_uri_component;

/// What an answer is for.
#[derive(Clone, Debug, PartialEq, Eq)]
pub enum DetailCall {
    Info {
        seq: u64,
    },
    Transcript {
        seq: u64,
    },
    Rename,
    Fork,
    /// "Rewind here" at this message.
    Rewind {
        uuid: String,
    },
    Delete,
    Export,
}

/// Work for the screen.
#[derive(Clone, Debug, PartialEq, Eq)]
pub enum DetailEffect {
    Send(DetailCall, SessionsRequest),
    /// Follow this link, through the redirects.
    Open(String),
    /// The export's text: save it as this file.
    Save {
        filename: String,
        text: String,
    },
}

#[derive(Clone, Debug)]
pub struct SessionDetail {
    id: String,
    dir: Option<String>,
    info: Option<StoredSession>,
    messages: Vec<Value>,
    history_error: Option<String>,
    loading: bool,
    error: Option<String>,
    renaming: bool,
    title_draft: String,
    rewinding: Option<String>,
    show_raw: bool,
    confirm_delete: bool,
    notice: Option<String>,
    seq: u64,
    info_reply: Option<Result<Reply, String>>,
    transcript_reply: Option<Result<Reply, String>>,
}

impl SessionDetail {
    /// `/sessions/<id>?dir=<dir>`, before its first load.
    pub fn new(id: &str, dir: Option<&str>) -> SessionDetail {
        SessionDetail {
            id: id.to_owned(),
            dir: dir.filter(|d| !d.is_empty()).map(str::to_owned),
            info: None,
            messages: Vec::new(),
            history_error: None,
            loading: true,
            error: None,
            renaming: false,
            title_draft: String::new(),
            rewinding: None,
            show_raw: false,
            confirm_delete: false,
            notice: None,
            seq: 0,
            info_reply: None,
            transcript_reply: None,
        }
    }

    // ---- reads ------------------------------------------------------------

    pub fn id(&self) -> &str {
        &self.id
    }

    pub fn dir(&self) -> Option<&str> {
        self.dir.as_deref()
    }

    pub fn info(&self) -> Option<&StoredSession> {
        self.info.as_ref()
    }

    pub fn messages(&self) -> &[Value] {
        &self.messages
    }

    pub fn history_error(&self) -> Option<&str> {
        self.history_error.as_deref()
    }

    pub fn loading(&self) -> bool {
        self.loading
    }

    pub fn error(&self) -> Option<&str> {
        self.error.as_deref()
    }

    pub fn notice(&self) -> Option<&str> {
        self.notice.as_deref()
    }

    pub fn renaming(&self) -> bool {
        self.renaming
    }

    pub fn title_draft(&self) -> &str {
        &self.title_draft
    }

    pub fn rewinding(&self) -> Option<&str> {
        self.rewinding.as_deref()
    }

    pub fn show_raw(&self) -> bool {
        self.show_raw
    }

    /// The delete confirm is up.
    pub fn confirming_delete(&self) -> bool {
        self.confirm_delete
    }

    /// The question it asks.
    pub const DELETE_QUESTION: &'static str = "Delete this session permanently?";

    /// The header's title: Claudius's, the SDK's, the creation time, or
    /// `(untitled)`.
    pub fn title(&self, now_year: i32) -> String {
        self.info
            .as_ref()
            .map_or_else(|| "(untitled)".into(), |i| i.display_title(now_year))
    }

    /// The meta line under the header: the cwd, `branch: …`, `created …`,
    /// `updated …`, `N messages`. `stamp` writes a time
    /// (`toLocaleString()`).
    pub fn meta_with(&self, stamp: &dyn Fn(f64) -> String) -> Vec<String> {
        let Some(info) = &self.info else {
            return Vec::new();
        };
        let mut out = Vec::new();
        if let Some(cwd) = info.cwd() {
            out.push(cwd.to_owned());
        }
        if let Some(b) = info.git_branch.as_deref().filter(|b| !b.is_empty()) {
            out.push(format!("branch: {b}"));
        }
        if let Some(c) = info.created_at.filter(|c| *c != 0. && !c.is_nan()) {
            out.push(format!("created {}", stamp(c)));
        }
        out.push(format!("updated {}", stamp(info.last_modified)));
        out.push(format!("{} messages", self.messages.len()));
        out
    }

    /// [`SessionDetail::meta_with`] in local time.
    pub fn meta(&self) -> Vec<String> {
        self.meta_with(&|ms| search::locale_string(&chrono::Local, ms))
    }

    /// The transcript's rows.
    pub fn rows(&self) -> Vec<Row> {
        transcript::rows(&self.messages)
    }

    /// The "Raw" text.
    pub fn raw(&self) -> String {
        transcript::raw(&self.messages)
    }

    // ---- loading ----------------------------------------------------------

    /// Reads the metadata and the transcript (on arrival, after a rename,
    /// or when the source says the session changed).
    pub fn load(&mut self) -> Vec<DetailEffect> {
        self.loading = true;
        self.seq += 1;
        self.info_reply = None;
        self.transcript_reply = None;
        vec![
            DetailEffect::Send(
                DetailCall::Info { seq: self.seq },
                SessionsRequest::Info {
                    id: self.id.clone(),
                    dir: self.dir.clone(),
                },
            ),
            DetailEffect::Send(
                DetailCall::Transcript { seq: self.seq },
                SessionsRequest::Transcript {
                    id: self.id.clone(),
                    dir: self.dir.clone(),
                },
            ),
        ]
    }

    /// Both answers in (or either failed outright): `info: <status>` /
    /// `transcript: <status>` for an error answer; else the page fills, the
    /// rename box pre-filled from a trusted title only.
    fn loaded(&mut self) {
        let failed = |r: &Option<Result<Reply, String>>| matches!(r, Some(Err(_)));
        let both = self.info_reply.is_some() && self.transcript_reply.is_some();
        if !both && !failed(&self.info_reply) && !failed(&self.transcript_reply) {
            return;
        }
        let result = match (self.info_reply.take(), self.transcript_reply.take()) {
            (Some(Err(e)), _) | (_, Some(Err(e))) => Err(e),
            (Some(Ok(info)), Some(Ok(tx))) => Self::read(&info, &tx),
            _ => return,
        };
        match result {
            Ok((meta, tx)) => {
                self.title_draft = meta.title_draft();
                self.info = Some(meta);
                self.messages = tx.messages;
                self.history_error = tx.history_error;
                self.error = None;
            }
            Err(e) => self.error = Some(e),
        }
        self.loading = false;
    }

    fn read(info: &Reply, tx: &Reply) -> Result<(StoredSession, TranscriptPage), String> {
        if !info.ok() {
            return Err(format!("info: {}", info.status));
        }
        if !tx.ok() {
            return Err(format!("transcript: {}", tx.status));
        }
        let meta: StoredSession =
            serde_json::from_value(info.parse()?).map_err(|e| e.to_string())?;
        Ok((meta, TranscriptPage::from_json(&tx.parse()?)))
    }

    // ---- the header -------------------------------------------------------

    /// The pencil: the rename box (its text as last drafted).
    pub fn start_rename(&mut self) {
        self.renaming = true;
    }

    pub fn set_draft(&mut self, text: &str) {
        self.title_draft = text.to_owned();
    }

    /// "Cancel" / Escape.
    pub fn cancel_rename(&mut self) {
        self.renaming = false;
    }

    /// "Save" / Enter: the trimmed title; a blank one does nothing.
    pub fn save_rename(&self) -> Vec<DetailEffect> {
        let title = js_trim(&self.title_draft);
        if title.is_empty() {
            return Vec::new();
        }
        vec![DetailEffect::Send(
            DetailCall::Rename,
            SessionsRequest::Rename {
                session_id: self.id.clone(),
                title: title.to_owned(),
                dir: self.dir.clone(),
            },
        )]
    }

    /// "Resume".
    pub fn resume(&self) -> Vec<DetailEffect> {
        vec![DetailEffect::Open(resume_href(&self.id))]
    }

    /// "Fork": the whole session.
    pub fn fork(&self) -> Vec<DetailEffect> {
        vec![DetailEffect::Send(
            DetailCall::Fork,
            SessionsRequest::Fork {
                session_id: self.id.clone(),
                up_to_message_id: None,
                dir: self.dir.clone(),
            },
        )]
    }

    /// "↺ Rewind here": a fork up to this message, opened in the chat.
    pub fn rewind(&mut self, uuid: &str) -> Vec<DetailEffect> {
        if self.rewinding.as_deref() == Some(uuid) {
            return Vec::new();
        }
        self.rewinding = Some(uuid.to_owned());
        vec![DetailEffect::Send(
            DetailCall::Rewind {
                uuid: uuid.to_owned(),
            },
            SessionsRequest::Fork {
                session_id: self.id.clone(),
                up_to_message_id: Some(uuid.to_owned()),
                dir: self.dir.clone(),
            },
        )]
    }

    /// "Export".
    pub fn export(&mut self) -> Vec<DetailEffect> {
        self.notice = None;
        vec![DetailEffect::Send(
            DetailCall::Export,
            SessionsRequest::Export {
                id: self.id.clone(),
                dir: self.dir.clone(),
            },
        )]
    }

    /// The export was written (or the save failed).
    pub fn saved(&mut self, result: Result<String, String>) {
        match result {
            Ok(path) => self.notice = Some(format!("Exported to {path}")),
            Err(e) => self.error = Some(format!("Export failed: {e}")),
        }
    }

    /// "Raw" / "Pretty".
    pub fn toggle_raw(&mut self) {
        self.show_raw = !self.show_raw;
    }

    /// "Delete": asks first.
    pub fn ask_delete(&mut self) {
        self.confirm_delete = true;
    }

    pub fn confirm_delete(&mut self, yes: bool) -> Vec<DetailEffect> {
        if !std::mem::take(&mut self.confirm_delete) || !yes {
            return Vec::new();
        }
        vec![DetailEffect::Send(
            DetailCall::Delete,
            SessionsRequest::Delete {
                id: self.id.clone(),
                dir: self.dir.clone(),
            },
        )]
    }

    // ---- answers ----------------------------------------------------------

    pub fn replied(&mut self, call: DetailCall, reply: Result<Reply, String>) -> Vec<DetailEffect> {
        match call {
            DetailCall::Info { seq } => {
                if seq == self.seq {
                    self.info_reply = Some(reply);
                    self.loaded();
                }
                Vec::new()
            }
            DetailCall::Transcript { seq } => {
                if seq == self.seq {
                    self.transcript_reply = Some(reply);
                    self.loaded();
                }
                Vec::new()
            }
            DetailCall::Rename => match action_result(&reply) {
                Ok(()) => {
                    self.error = None;
                    self.renaming = false;
                    self.load()
                }
                Err(e) => {
                    self.error = Some(format!("Rename failed: {e}"));
                    Vec::new()
                }
            },
            DetailCall::Fork => match fork_result(&reply) {
                Some(new_id) => vec![DetailEffect::Open(match &self.dir {
                    Some(d) => format!("/sessions/{new_id}?dir={}", encode_uri_component(d)),
                    None => format!("/sessions/{new_id}"),
                })],
                None => {
                    self.error = Some("Fork failed".into());
                    Vec::new()
                }
            },
            DetailCall::Rewind { uuid } => {
                if self.rewinding.as_deref() == Some(uuid.as_str()) {
                    self.rewinding = None;
                }
                match fork_result(&reply) {
                    Some(new_id) => vec![DetailEffect::Open(resume_href(&new_id))],
                    None => {
                        self.error = Some("Fork failed".into());
                        Vec::new()
                    }
                }
            }
            DetailCall::Delete => match action_result(&reply) {
                Ok(()) => vec![DetailEffect::Open("/sessions".into())],
                Err(e) => {
                    self.error = Some(format!("Delete failed: {e}"));
                    Vec::new()
                }
            },
            DetailCall::Export => match reply {
                Ok(r) if r.ok() => vec![DetailEffect::Save {
                    filename: r
                        .filename
                        .clone()
                        .unwrap_or_else(|| format!("claudius-session-{}.txt", self.id)),
                    text: r.body,
                }],
                other => {
                    let why = match &other {
                        Ok(r) if !r.body.is_empty() && r.parse().is_err() => r.body.clone(),
                        _ => action_result(&other).err().unwrap_or_default(),
                    };
                    self.error = Some(format!("Export failed: {why}"));
                    Vec::new()
                }
            },
        }
    }
}
