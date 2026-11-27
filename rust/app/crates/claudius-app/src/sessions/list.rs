//! The Sessions page (`app/[workspaceId]/sessions/page.tsx` with
//! `useSessionsHistory`) without GPUI: the workspace's listing, the search
//! box and its ranking, the branch and unread filters, "Search in
//! transcripts", paging and the older-session search, the row actions and
//! the keyboard selection. What it needs from the data source comes back
//! as [`ListEffect`]s; the answers come back through [`SessionsList::replied`].
//!
//! The view owns the two debounces the page runs on timers: 250 ms after the
//! query, the toggle or the workspace changes it calls
//! [`SessionsList::content_search_due`]; 300 ms after the query changes,
//! [`SessionsList::settle`].

use std::collections::BTreeMap;

use super::data::{
    Reply, SessionsPage, SessionsRequest, StoredSession, action_result, content_matches,
};
use super::search::{
    self, CONTENT_MATCH, OLDER_SEARCH_STEP, OlderSearch, OlderSearchInput, SESSION_PAGE_SIZE,
    js_trim, utf16_len,
};
use crate::route::encode_uri_component;
use crate::tabs::short_id;

/// What an answer is for.
#[derive(Clone, Debug, PartialEq, Eq)]
pub enum ListCall {
    /// The listing, by fetch number (a newer one aborts it).
    List {
        seq: u64,
    },
    /// The transcript search, by search number.
    Search {
        seq: u64,
    },
    Delete {
        id: String,
    },
    Export {
        id: String,
    },
}

/// Work for the screen.
#[derive(Clone, Debug, PartialEq, Eq)]
pub enum ListEffect {
    /// Send this, then hand the answer to [`SessionsList::replied`].
    Send(ListCall, SessionsRequest),
    /// Follow this link (`router.push` / `<Link>`), through the redirects.
    Open(String),
    /// The export's text: save it as this file.
    Save { filename: String, text: String },
}

/// The list area when no row shows.
#[derive(Clone, Debug, PartialEq, Eq)]
pub enum EmptyState {
    SearchingTranscripts,
    SearchingOlder,
    /// The auto-load stopped: "No matches in the N most recent sessions."
    /// with "Search older", or after a failed fetch "Couldn't load older
    /// sessions." with "Retry".
    Capped {
        failed: bool,
        loaded: usize,
    },
    NoMatch,
}

impl EmptyState {
    pub fn message(&self) -> String {
        match self {
            EmptyState::SearchingTranscripts => "Searching transcripts…".into(),
            EmptyState::SearchingOlder => "Searching older sessions…".into(),
            EmptyState::Capped { failed: true, .. } => "Couldn't load older sessions.".into(),
            EmptyState::Capped { loaded, .. } => format!(
                "No matches in the {loaded} most recent session{}.",
                if *loaded == 1 { "" } else { "s" }
            ),
            EmptyState::NoMatch => "No sessions match.".into(),
        }
    }

    /// The button under a capped search.
    pub fn button(&self) -> Option<&'static str> {
        match self {
            EmptyState::Capped { failed: true, .. } => Some("Retry"),
            EmptyState::Capped { .. } => Some("Search older"),
            _ => None,
        }
    }
}

/// One row as drawn.
#[derive(Clone, Debug, PartialEq)]
pub struct RowView {
    pub id: String,
    pub title: String,
    /// `sessionId.slice(0, 8)`.
    pub short_id: String,
    pub relative: String,
    pub bytes: String,
    pub branch: Option<String>,
    pub cwd: Option<String>,
    /// The account label, when more than one account is configured.
    pub account: Option<String>,
    pub first_prompt: Option<String>,
    /// The transcript hit's snippet ("in transcript").
    pub snippet: Option<String>,
    pub unread: u32,
    /// The keyboard selection.
    pub selected: bool,
    /// The row's link.
    pub href: String,
}

/// `99+` past 99.
pub fn badge_count(n: u32) -> String {
    if n > 99 { "99+".into() } else { n.to_string() }
}

fn plural(n: u32) -> &'static str {
    if n == 1 { "" } else { "s" }
}

/// The row link: `/sessions/<id>?dir=<encodeURIComponent(cwd)>`.
pub fn session_href(s: &StoredSession) -> String {
    match s.cwd() {
        Some(cwd) => format!(
            "/sessions/{}?dir={}",
            s.session_id,
            encode_uri_component(cwd)
        ),
        None => format!("/sessions/{}", s.session_id),
    }
}

/// "Resume": the chat bound to the session.
pub fn resume_href(id: &str) -> String {
    format!("/?session={id}")
}

#[derive(Clone, Debug)]
pub struct SessionsList {
    workspace_id: String,
    root: Option<String>,
    sessions: Vec<StoredSession>,
    accounts_configured: u32,
    loading: bool,
    error: Option<String>,
    limit: u32,
    list_seq: u64,
    filter: String,
    branch: Option<String>,
    search_transcripts: bool,
    unread_only: bool,
    unread: BTreeMap<String, u32>,
    content_matches: Vec<(String, String)>,
    content_searching: bool,
    content_seq: u64,
    older_ceiling: u32,
    settled_query: String,
    ceiling_query: String,
    action_error: Option<String>,
    notice: Option<String>,
    selected: Option<String>,
    confirm_delete: Option<String>,
}

impl SessionsList {
    /// The page for a workspace (`root`: its project dir, `None` until the
    /// workspace list resolves it), before its first fetch.
    pub fn new(workspace_id: &str, root: Option<&str>) -> SessionsList {
        SessionsList {
            workspace_id: workspace_id.to_owned(),
            root: root.map(str::to_owned),
            sessions: Vec::new(),
            accounts_configured: 0,
            loading: true,
            error: None,
            limit: SESSION_PAGE_SIZE,
            list_seq: 0,
            filter: String::new(),
            branch: None,
            search_transcripts: false,
            unread_only: false,
            unread: BTreeMap::new(),
            content_matches: Vec::new(),
            content_searching: false,
            content_seq: 0,
            older_ceiling: OLDER_SEARCH_STEP,
            settled_query: String::new(),
            ceiling_query: String::new(),
            action_error: None,
            notice: None,
            selected: None,
            confirm_delete: None,
        }
    }

    // ---- reads ------------------------------------------------------------

    pub fn workspace_id(&self) -> &str {
        &self.workspace_id
    }

    pub fn root(&self) -> Option<&str> {
        self.root.as_deref()
    }

    /// Everything fetched (before the cwd filter).
    pub fn sessions(&self) -> &[StoredSession] {
        &self.sessions
    }

    pub fn loading(&self) -> bool {
        self.loading
    }

    /// The fetch's error.
    pub fn error(&self) -> Option<&str> {
        self.error.as_deref()
    }

    /// A delete's or export's error.
    pub fn action_error(&self) -> Option<&str> {
        self.action_error.as_deref()
    }

    /// What an export did ("Exported to …").
    pub fn notice(&self) -> Option<&str> {
        self.notice.as_deref()
    }

    pub fn filter(&self) -> &str {
        &self.filter
    }

    pub fn branch(&self) -> Option<&str> {
        self.branch.as_deref()
    }

    pub fn search_transcripts(&self) -> bool {
        self.search_transcripts
    }

    pub fn content_searching(&self) -> bool {
        self.content_searching
    }

    pub fn limit(&self) -> u32 {
        self.limit
    }

    pub fn older_ceiling(&self) -> u32 {
        self.older_ceiling
    }

    /// The session a delete is waiting on the confirm for.
    pub fn confirming_delete(&self) -> Option<&str> {
        self.confirm_delete.as_deref()
    }

    /// The delete confirm's question (`confirm()`).
    pub fn delete_question(&self) -> Option<String> {
        self.confirm_delete
            .as_deref()
            .map(|id| format!("Delete session {}?", short_id(id)))
    }

    /// The workspace's sessions: `s.cwd === workspaceRoot` (all of them
    /// while the root is unknown).
    pub fn scoped(&self) -> Vec<&StoredSession> {
        self.sessions
            .iter()
            .filter(|s| match &self.root {
                None => true,
                Some(r) => s.cwd.as_deref() == Some(r.as_str()),
            })
            .collect()
    }

    /// The branch chips: each trimmed branch with its count, most first
    /// (ties in first-seen order). The bar shows with two or more.
    pub fn branches(&self) -> Vec<(String, usize)> {
        let mut counts: Vec<(String, usize)> = Vec::new();
        for s in self.scoped() {
            let Some(b) = s
                .git_branch
                .as_deref()
                .map(js_trim)
                .filter(|b| !b.is_empty())
            else {
                continue;
            };
            match counts.iter_mut().find(|(k, _)| k == b) {
                Some((_, n)) => *n += 1,
                None => counts.push((b.to_owned(), 1)),
            }
        }
        counts.sort_by_key(|c| std::cmp::Reverse(c.1));
        counts
    }

    fn unread_of(&self, id: &str) -> u32 {
        self.unread.get(id).copied().unwrap_or(0)
    }

    /// `(sessions with something new, notifications in all)`.
    pub fn unread_summary(&self) -> (u32, u32) {
        let mut sessions = 0;
        let mut total = 0;
        for s in self.scoped() {
            let n = self.unread_of(&s.session_id);
            if n > 0 {
                sessions += 1;
                total += n;
            }
        }
        (sessions, total)
    }

    /// The unread filter as applied: off once nothing is unread (the pill
    /// hides at zero, so a latched filter can't strand an empty list).
    pub fn filter_unread(&self) -> bool {
        self.unread_only && self.unread_summary().0 > 0
    }

    /// The "N new" pill: its label and tooltip, when something is unread.
    pub fn unread_pill(&self) -> Option<(String, String)> {
        let (sessions, total) = self.unread_summary();
        if sessions == 0 {
            return None;
        }
        let title = if self.filter_unread() {
            "Showing only sessions with new notifications — click to show all".to_owned()
        } else {
            format!(
                "{total} new notification{} across {sessions} session{} — click to filter",
                plural(total),
                plural(sessions)
            )
        };
        Some((format!("{} new", badge_count(total)), title))
    }

    fn content_match(&self, id: &str) -> Option<&str> {
        self.content_matches
            .iter()
            .find(|(k, _)| k == id)
            .map(|(_, v)| v.as_str())
    }

    /// The rows the query and filters keep, best match first.
    pub fn filtered(&self) -> Vec<&StoredSession> {
        let filter_unread = self.filter_unread();
        let base: Vec<&StoredSession> = self
            .scoped()
            .into_iter()
            .filter(|s| {
                if let Some(b) = &self.branch
                    && s.git_branch.as_deref() != Some(b.as_str())
                {
                    return false;
                }
                !(filter_unread && self.unread_of(&s.session_id) == 0)
            })
            .collect();
        search::rank(
            base,
            &self.filter,
            |s| s.search_fields(),
            |s| {
                (self.search_transcripts && self.content_match(&s.session_id).is_some())
                    .then_some(CONTENT_MATCH)
            },
        )
    }

    /// `parseSessionQuery(filter).text.trim()`.
    pub fn typed_query(&self) -> String {
        js_trim(&search::parse_session_query(&self.filter).text).to_owned()
    }

    /// The query changed less than 300 ms ago.
    pub fn query_pending(&self) -> bool {
        self.typed_query() != self.settled_query
    }

    /// `hasMoreSessions(sessions.length, limit)`.
    pub fn has_more(&self) -> bool {
        search::has_more_sessions(self.sessions.len(), i64::from(self.limit))
    }

    pub fn older_search(&self) -> OlderSearch {
        search::older_search_state(&OlderSearchInput {
            query: &self.settled_query,
            match_count: self.filtered().len(),
            loaded_count: self.sessions.len(),
            has_more: self.has_more(),
            loading: self.loading || (self.search_transcripts && self.content_searching),
            failed: self.error.is_some(),
            ceiling: self.older_ceiling,
        })
    }

    /// The list area's message, when no row shows. While the first page
    /// loads the area is blank (the header says "loading…").
    pub fn empty_state(&self) -> Option<EmptyState> {
        if !self.filtered().is_empty() {
            return None;
        }
        let older = self.older_search();
        if self.loading && older != OlderSearch::Searching {
            return None;
        }
        Some(if self.search_transcripts && self.content_searching {
            EmptyState::SearchingTranscripts
        } else if matches!(older, OlderSearch::Searching | OlderSearch::Load)
            || (self.query_pending() && self.has_more())
        {
            EmptyState::SearchingOlder
        } else if older == OlderSearch::Capped {
            EmptyState::Capped {
                failed: self.error.is_some(),
                loaded: self.sessions.len(),
            }
        } else {
            EmptyState::NoMatch
        })
    }

    /// "Load more sessions" (`Some(enabled)`), hidden while the older
    /// search owns the paging.
    pub fn load_more_button(&self) -> Option<bool> {
        let show = self.has_more()
            && self.older_search() == OlderSearch::Idle
            && !(self.query_pending() && self.filtered().is_empty());
        show.then_some(!self.loading)
    }

    /// The account column shows with two or more accounts.
    pub fn show_accounts(&self) -> bool {
        self.accounts_configured > 1
    }

    /// The keyboard selection, when its row is listed.
    pub fn selected(&self) -> Option<&str> {
        let id = self.selected.as_deref()?;
        self.filtered()
            .iter()
            .any(|s| s.session_id == id)
            .then_some(id)
    }

    /// The rows as drawn, at `now_ms` (the relative times) in `now_year`
    /// (the untitled label). `date` writes an older row's date.
    pub fn rows_with(
        &self,
        now_ms: f64,
        now_year: i32,
        date: &dyn Fn(f64) -> String,
    ) -> Vec<RowView> {
        let selected = self.selected().map(str::to_owned);
        let show_accounts = self.show_accounts();
        self.filtered()
            .into_iter()
            .map(|s| RowView {
                id: s.session_id.clone(),
                title: s.display_title(now_year),
                short_id: short_id(&s.session_id),
                relative: search::fmt_relative_with(s.last_modified, now_ms, date),
                bytes: search::fmt_bytes(s.file_size),
                branch: s.git_branch.clone().filter(|b| !b.is_empty()),
                cwd: s.cwd().map(str::to_owned),
                account: s
                    .account_label
                    .clone()
                    .filter(|l| show_accounts && !l.is_empty()),
                first_prompt: s.first_prompt.clone().filter(|p| !p.is_empty()),
                snippet: self
                    .content_match(&s.session_id)
                    .filter(|m| self.search_transcripts && !m.is_empty())
                    .map(str::to_owned),
                unread: self.unread_of(&s.session_id),
                selected: selected.as_deref() == Some(s.session_id.as_str()),
                href: session_href(s),
            })
            .collect()
    }

    /// [`SessionsList::rows_with`] in local time.
    pub fn rows(&self, now_ms: f64, now_year: i32) -> Vec<RowView> {
        self.rows_with(now_ms, now_year, &|ms| {
            search::locale_date(&chrono::Local, ms)
        })
    }

    fn find(&self, id: &str) -> Option<&StoredSession> {
        self.sessions.iter().find(|s| s.session_id == id)
    }

    // ---- the listing ------------------------------------------------------

    fn fetch(&mut self) -> Vec<ListEffect> {
        self.loading = true;
        self.list_seq += 1;
        vec![ListEffect::Send(
            ListCall::List { seq: self.list_seq },
            SessionsRequest::List {
                dir: self.root.clone(),
                limit: self.limit,
            },
        )]
    }

    /// The first fetch, on arrival.
    pub fn start(&mut self) -> Vec<ListEffect> {
        self.fetch()
    }

    /// "Refresh" (and after a delete).
    pub fn refresh(&mut self) -> Vec<ListEffect> {
        self.fetch()
    }

    /// "Load more sessions": a page bigger.
    pub fn load_more(&mut self) -> Vec<ListEffect> {
        self.limit += SESSION_PAGE_SIZE;
        self.fetch()
    }

    /// The workspace's root resolved or moved: the fetch re-scopes with
    /// the page size reset.
    pub fn set_root(&mut self, root: Option<&str>) -> Vec<ListEffect> {
        if self.root.as_deref() == root {
            return Vec::new();
        }
        self.root = root.map(str::to_owned);
        self.limit = SESSION_PAGE_SIZE;
        self.content_seq += 1;
        self.fetch()
    }

    /// The source says the listing changed.
    pub fn changed(&mut self) -> Vec<ListEffect> {
        self.fetch()
    }

    pub fn set_unread(&mut self, unread: BTreeMap<String, u32>) {
        self.unread = unread;
    }

    /// What the older search asks for: the next page while a no-match
    /// query is under the ceiling (the page's `olderSearch === "load"`
    /// effect). Run after every change.
    pub fn drive(&mut self) -> Vec<ListEffect> {
        if self.older_search() == OlderSearch::Load {
            self.load_more()
        } else {
            Vec::new()
        }
    }

    /// "Search older" / "Retry": the ceiling grows a step past what's
    /// loaded, and the next page loads.
    pub fn search_older(&mut self) -> Vec<ListEffect> {
        self.older_ceiling =
            search::next_older_search_ceiling(self.older_ceiling, self.sessions.len());
        self.load_more()
    }

    // ---- the search box and the filters -----------------------------------

    /// The box's text. The view restarts both debounces.
    pub fn set_filter(&mut self, text: &str) {
        if self.filter != text {
            self.filter = text.to_owned();
            self.content_seq += 1;
        }
    }

    /// 300 ms after the last keystroke: the query the older search uses.
    /// A new query starts from the default ceiling again.
    pub fn settle(&mut self) {
        self.settled_query = self.typed_query();
        if self.ceiling_query != self.settled_query {
            self.ceiling_query = self.settled_query.clone();
            self.older_ceiling = OLDER_SEARCH_STEP;
        }
    }

    /// "Search in transcripts".
    pub fn set_search_transcripts(&mut self, on: bool) {
        if self.search_transcripts != on {
            self.search_transcripts = on;
            self.content_seq += 1;
        }
    }

    /// 250 ms after the query, the toggle or the root changed: search the
    /// transcripts when that's on and the query has 2+ units, else drop
    /// the matches.
    pub fn content_search_due(&mut self) -> Vec<ListEffect> {
        let q = js_trim(&self.filter).to_owned();
        let Some(root) = self.root.clone().filter(|_| self.search_transcripts) else {
            self.content_matches.clear();
            self.content_searching = false;
            return Vec::new();
        };
        if utf16_len(&q) < 2 {
            self.content_matches.clear();
            self.content_searching = false;
            return Vec::new();
        }
        self.content_searching = true;
        vec![ListEffect::Send(
            ListCall::Search {
                seq: self.content_seq,
            },
            SessionsRequest::Search { q, dir: root },
        )]
    }

    /// A branch chip (`None`: "all").
    pub fn set_branch(&mut self, branch: Option<&str>) {
        self.branch = branch.map(str::to_owned);
    }

    /// The "N new" pill.
    pub fn toggle_unread_only(&mut self) {
        self.unread_only = !self.unread_only;
    }

    /// Enter in the box: the best match.
    pub fn open_best(&self) -> Vec<ListEffect> {
        self.filtered()
            .first()
            .map(|s| ListEffect::Open(session_href(s)))
            .into_iter()
            .collect()
    }

    // ---- the keyboard selection -------------------------------------------

    /// ↓ / ↑: the next or previous row, from the first or the last.
    pub fn move_selection(&mut self, down: bool) {
        let ids: Vec<String> = self
            .filtered()
            .iter()
            .map(|s| s.session_id.clone())
            .collect();
        if ids.is_empty() {
            self.selected = None;
            return;
        }
        let at = self
            .selected()
            .and_then(|id| ids.iter().position(|x| x == id));
        let next = match (at, down) {
            (None, true) => 0,
            (None, false) => ids.len() - 1,
            (Some(i), true) => (i + 1).min(ids.len() - 1),
            (Some(i), false) => i.saturating_sub(1),
        };
        self.selected = Some(ids[next].clone());
    }

    /// Home / End.
    pub fn select_edge(&mut self, last: bool) {
        let ids: Vec<String> = self
            .filtered()
            .iter()
            .map(|s| s.session_id.clone())
            .collect();
        self.selected = if last {
            ids.last().cloned()
        } else {
            ids.first().cloned()
        };
    }

    pub fn select(&mut self, id: &str) {
        self.selected = Some(id.to_owned());
    }

    /// Enter on the list: the selected row's page.
    pub fn open_selected(&self) -> Vec<ListEffect> {
        let Some(id) = self.selected() else {
            return Vec::new();
        };
        self.find(id)
            .map(|s| ListEffect::Open(session_href(s)))
            .into_iter()
            .collect()
    }

    // ---- the row actions --------------------------------------------------

    /// "Resume": the chat, bound to the session.
    pub fn resume(&self, id: &str) -> Vec<ListEffect> {
        vec![ListEffect::Open(resume_href(id))]
    }

    /// "Delete": asks first.
    pub fn ask_delete(&mut self, id: &str) {
        self.confirm_delete = Some(id.to_owned());
    }

    /// The confirm's answer.
    pub fn confirm_delete(&mut self, yes: bool) -> Vec<ListEffect> {
        let Some(id) = self.confirm_delete.take() else {
            return Vec::new();
        };
        if !yes {
            return Vec::new();
        }
        self.action_error = None;
        let dir = self.find(&id).and_then(|s| s.cwd()).map(str::to_owned);
        vec![ListEffect::Send(
            ListCall::Delete { id: id.clone() },
            SessionsRequest::Delete { id, dir },
        )]
    }

    /// "Export": the plain-text transcript, to a file.
    pub fn export(&mut self, id: &str) -> Vec<ListEffect> {
        let dir = self.find(id).and_then(|s| s.cwd()).map(str::to_owned);
        self.notice = None;
        vec![ListEffect::Send(
            ListCall::Export { id: id.to_owned() },
            SessionsRequest::Export {
                id: id.to_owned(),
                dir,
            },
        )]
    }

    /// The export was written (or the save failed).
    pub fn saved(&mut self, result: Result<String, String>) {
        match result {
            Ok(path) => self.notice = Some(format!("Exported to {path}")),
            Err(e) => self.action_error = Some(format!("Export failed: {e}")),
        }
    }

    // ---- answers ----------------------------------------------------------

    /// An answer arrived.
    pub fn replied(&mut self, call: ListCall, reply: Result<Reply, String>) -> Vec<ListEffect> {
        match call {
            ListCall::List { seq } => {
                if seq == self.list_seq {
                    self.list_replied(reply);
                }
                Vec::new()
            }
            ListCall::Search { seq } => {
                if seq == self.content_seq {
                    self.content_matches = match reply {
                        Ok(r) if r.ok() => {
                            r.parse().map(|v| content_matches(&v)).unwrap_or_default()
                        }
                        _ => Vec::new(),
                    };
                    self.content_searching = false;
                }
                Vec::new()
            }
            ListCall::Delete { id } => match action_result(&reply) {
                Ok(()) => self.refresh(),
                Err(e) => {
                    self.action_error = Some(format!("Delete failed ({}): {e}", short_id(&id)));
                    Vec::new()
                }
            },
            ListCall::Export { id } => match reply {
                Ok(r) if r.ok() => vec![ListEffect::Save {
                    filename: r
                        .filename
                        .clone()
                        .unwrap_or_else(|| format!("claudius-session-{id}.txt")),
                    text: r.body,
                }],
                other => {
                    let why = match &other {
                        Ok(r) if !r.body.is_empty() && r.parse().is_err() => r.body.clone(),
                        _ => action_result(&other).err().unwrap_or_default(),
                    };
                    self.action_error = Some(format!("Export failed ({}): {why}", short_id(&id)));
                    Vec::new()
                }
            },
        }
    }

    /// The hook's fetch: `HTTP <status>` for an error answer, the body's
    /// `error` for a 200 that carries one; the list stays as it was on
    /// either.
    fn list_replied(&mut self, reply: Result<Reply, String>) {
        let page = match reply {
            Err(message) => Err(message),
            Ok(r) if !r.ok() => Err(format!("HTTP {}", r.status)),
            Ok(r) => r.parse().map(|v| SessionsPage::from_json(&v)),
        };
        match page {
            Ok(SessionsPage { error: Some(e), .. }) => self.error = Some(e),
            Ok(page) => {
                self.sessions = page.sessions;
                self.accounts_configured = page.accounts_configured;
                self.error = None;
            }
            Err(e) => self.error = Some(e),
        }
        self.loading = false;
    }
}
