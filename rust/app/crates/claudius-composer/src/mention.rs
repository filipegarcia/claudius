//! The `@` mention picker's pure half: `components/chat/at-mention.ts`
//! (`parseAtMentionQuery`, `normalizeFileMentionQuery`, `itemToken`,
//! `filterAgents`), `AtMentionPicker.tsx`'s `fsListErrorText`, its request
//! URLs and count label, and `PromptInput.tsx`'s `@` token
//! (`/(^|\s)@([^\s@]*)$/`) and `insertAtMention` splice. Replayed against
//! the TS by `tests/composer_pickers_golden.rs`.

use claudius_agent::js;
use claudius_core::collate::locale_compare;
use serde_json::Value;

use crate::slash::splice_token;

/// `AGENT_PREFIX` (at-mention.ts:20).
pub const AGENT_PREFIX: &str = "agent-";
/// `PICKER_LIMIT` (at-mention.ts:23): the rows either source shows.
pub const PICKER_LIMIT: usize = 30;
/// The `limit` the file search asks for (AtMentionPicker.tsx:78).
pub const FS_LIST_LIMIT: &str = "50";
/// The header (AtMentionPicker.tsx:200).
pub const HEADER: &str = "@-mention \u{b7} Tab to insert";
/// The count while a list loads (AtMentionPicker.tsx:194).
pub const LOADING: &str = "loading\u{2026}";

/// An SDK-loaded agent (`Agent`, from `/api/sessions/<id>/agents`).
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct Agent {
    pub name: String,
    pub description: Option<String>,
    pub model: Option<String>,
}

/// A `/api/fs/list` entry, as the picker keeps it.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct FsEntry {
    pub rel_path: String,
    pub dir: bool,
}

/// A picker row (`PickerItem`).
#[derive(Clone, Debug, PartialEq, Eq)]
pub enum PickerItem {
    File { rel_path: String, dir: bool },
    Agent(Agent),
}

impl PickerItem {
    /// The row's label (the path, or the agent's name).
    pub fn label(&self) -> &str {
        match self {
            PickerItem::File { rel_path, .. } => rel_path,
            PickerItem::Agent(a) => &a.name,
        }
    }

    /// The agent row's aside: `item.model ?? item.description`.
    pub fn aside(&self) -> Option<&str> {
        match self {
            PickerItem::File { .. } => None,
            PickerItem::Agent(a) => a.model.as_deref().or(a.description.as_deref()),
        }
    }

    /// The lucide icon (`Bot`, `Folder`, `File`).
    pub fn icon(&self) -> &'static str {
        match self {
            PickerItem::Agent(_) => "Bot",
            PickerItem::File { dir: true, .. } => "Folder",
            PickerItem::File { .. } => "File",
        }
    }
}

/// `/(^|\s)@([^\s@]*)$/.exec(before)` (PromptInput.tsx:1271): the `@`
/// token before the caret, without its `@`.
pub fn at_token_before_caret(before: &str) -> Option<&str> {
    let start = before
        .char_indices()
        .rev()
        .find(|(_, c)| crate::rules::is_js_space(*c))
        .map_or(0, |(i, c)| i + c.len_utf8());
    let tok = before[start..].strip_prefix('@')?;
    (!tok.contains('@')).then_some(tok)
}

/// `insertAtMention(rel)` (PromptInput.tsx:1593): the `@token` before
/// `caret` becomes `@<rel> `; the new text and the caret.
pub fn insert_at_mention(value: &str, caret: usize, rel: &str) -> (String, usize) {
    splice_token(value, caret, at_token_before_caret, &format!("@{rel} "))
}

/// `parseAtMentionQuery(query)` (at-mention.ts:31): agent mode, and its
/// filter (empty in file mode).
pub fn parse_at_mention_query(query: &str) -> (bool, &str) {
    match query.strip_prefix(AGENT_PREFIX) {
        Some(f) => (true, f),
        None => (false, ""),
    }
}

/// `normalizeFileMentionQuery(query)` (at-mention.ts:43): one leading `./`
/// dropped.
pub fn normalize_file_mention_query(query: &str) -> &str {
    query.strip_prefix("./").unwrap_or(query)
}

/// `itemToken(item)` (at-mention.ts:53): what the pick inserts after `@`.
pub fn item_token(item: &PickerItem) -> String {
    match item {
        PickerItem::File { rel_path, .. } => rel_path.clone(),
        PickerItem::Agent(a) => format!("{AGENT_PREFIX}{}", a.name),
    }
}

/// `filterAgents(agents, filter)` (at-mention.ts:62): a case-insensitive
/// substring of the name or description, by `localeCompare` of the names
/// (stable), at most [`PICKER_LIMIT`].
pub fn filter_agents(agents: &[Agent], filter: &str) -> Vec<PickerItem> {
    let needle = filter.to_lowercase();
    let mut hits: Vec<&Agent> = agents
        .iter()
        .filter(|a| {
            a.name.to_lowercase().contains(&needle)
                || a.description
                    .as_ref()
                    .is_some_and(|d| d.to_lowercase().contains(&needle))
        })
        .collect();
    hits.sort_by(|a, b| locale_compare(&a.name, &b.name));
    hits.into_iter()
        .take(PICKER_LIMIT)
        .map(|a| PickerItem::Agent(a.clone()))
        .collect()
}

/// `fsListErrorText(status, body)` (AtMentionPicker.tsx:22): the error row
/// for a 403 or a 5xx (`body.error ?? "Search failed (HTTP <status>)"`),
/// else nothing.
pub fn fs_list_error_text(status: u16, body: &Value) -> Option<String> {
    if status != 403 && status < 500 {
        return None;
    }
    Some(match body.get("error") {
        None | Some(Value::Null) => format!("Search failed (HTTP {status})"),
        Some(Value::String(s)) => s.clone(),
        Some(other) => js::to_string(Some(other)),
    })
}

/// `application/x-www-form-urlencoded` (`URLSearchParams.toString()`).
fn form_encode(s: &str) -> String {
    let mut out = String::with_capacity(s.len());
    for b in s.bytes() {
        match b {
            b' ' => out.push('+'),
            b'*' | b'-' | b'.' | b'_' => out.push(b as char),
            _ if b.is_ascii_alphanumeric() => out.push(b as char),
            _ => out.push_str(&format!("%{b:02X}")),
        }
    }
    out
}

/// The file search's URL (AtMentionPicker.tsx:78): `q` (normalized),
/// `limit=50`, then `cwd` when there is one.
pub fn fs_list_url(query: &str, cwd: Option<&str>) -> String {
    let mut url = format!(
        "/api/fs/list?q={}&limit={FS_LIST_LIMIT}",
        form_encode(normalize_file_mention_query(query))
    );
    if let Some(c) = cwd.filter(|c| !c.is_empty()) {
        url.push_str("&cwd=");
        url.push_str(&form_encode(c));
    }
    url
}

/// `/api/sessions/<encodeURIComponent(id)>/agents` (AtMentionPicker.tsx:107).
pub fn agents_url(session_id: &str) -> String {
    format!(
        "/api/sessions/{}/agents",
        crate::rules::encode_uri_component(session_id)
    )
}

/// The search's `entries`, as the picker keeps them (`r.ok ? (d.entries ??
/// []) : []`, then `.slice(0, 30)`). Rows that aren't objects are dropped,
/// a missing `relPath` reads as `""`.
pub fn fs_entries_of(body: &Value) -> Vec<FsEntry> {
    let Some(list) = body.get("entries").and_then(Value::as_array) else {
        return Vec::new();
    };
    list.iter()
        .filter(|e| e.is_object())
        .take(PICKER_LIMIT)
        .map(|e| FsEntry {
            rel_path: e
                .get("relPath")
                .and_then(Value::as_str)
                .unwrap_or("")
                .to_owned(),
            dir: e.get("type").and_then(Value::as_str) == Some("dir"),
        })
        .collect()
}

/// The agents answer: `d && Array.isArray(d.agents) ? d.agents : []`.
/// Rows without a string `name` are dropped; a non-string `description` /
/// `model` reads as absent.
pub fn agents_of(body: Option<&Value>) -> Vec<Agent> {
    let Some(list) = body.and_then(|d| d.get("agents")).and_then(Value::as_array) else {
        return Vec::new();
    };
    list.iter()
        .filter_map(|a| {
            let text = |k: &str| a.get(k).and_then(Value::as_str).map(str::to_owned);
            Some(Agent {
                name: a.get("name")?.as_str()?.to_owned(),
                description: text("description"),
                model: text("model"),
            })
        })
        .collect()
}

/// The header's count (AtMentionPicker.tsx:193).
pub fn count_label(loading: bool, agent_mode: bool, n: usize) -> String {
    if loading {
        return LOADING.into();
    }
    let kind = if agent_mode { "agent" } else { "file" };
    let s = if n == 1 { "" } else { "s" };
    format!("{n} {kind}{s}")
}

#[cfg(test)]
mod tests;
