//! The pickers (U07b): `SlashCommandPicker`, `AtMentionPicker` and
//! `EmojiShortcodePicker` as the composer mounts them over the box, with
//! their own state (the highlight, the `@` picker's file search and agent
//! list) and their window-capture `keydown` listeners, plus the two
//! requests around them that live higher up in the TS (`useSdkCommands`'
//! command list in PromptInput, `useEmojiCompletionEnabled`'s setting in
//! ChatSurface).
//!
//! **Mounting.** React mounts a picker while its condition holds
//! (PromptInput.tsx:2329): the `@` picker while there's an `@` token, the
//! emoji one while there's a `:` token and no `@` one, the slash one while
//! `pickerOpen` and neither. Its state starts over on each mount (the
//! highlight at the top, a fresh file search and agent fetch) and is gone
//! when it unmounts (its requests aborted). [`Composer::sync_menus`] is
//! that render: it runs after every change the pickers read, resets the
//! highlight when the visible list's length changes (the TS's
//! store-previous-props pattern), and re-runs the `@` picker's effects
//! whose deps changed.
//!
//! **Keys.** A mounted picker with rows sees a key before PromptInput's
//! `onKeyDown` ([`Composer::menu_key`]); with no rows it lets every key
//! through. Cmd/Ctrl + ↑ / ↓ always pass (the history chord).

use super::*;
use crate::emoji;
use crate::mention::{self, Agent, FsEntry, PickerItem};
use crate::slash::{self, SlashSuggestion};

/// A list picker's own state (the slash and emoji pickers).
#[derive(Clone, Debug, Default, PartialEq, Eq)]
pub(super) struct ListMenu {
    hi: usize,
    /// `lastVisibleLen`.
    last_len: usize,
}

/// `AtMentionPicker`'s state while it is mounted.
#[derive(Clone, Debug, Default, PartialEq)]
pub(super) struct AtMenu {
    entries: Vec<FsEntry>,
    file_loading: bool,
    file_error: Option<String>,
    hi: usize,
    last_len: usize,
    /// `agentState`: the session the list was fetched for, and the list.
    agents_for: Option<String>,
    agents: Option<Vec<Agent>>,
    /// `lastInputs`: `{ query, cwd }`.
    last_inputs: (String, Option<String>),
    /// The file search effect's deps (`[query, cwd, agentMode]`) when it
    /// last ran, and its request in flight.
    fs_deps: Option<(String, Option<String>, bool)>,
    fs_fetch: Option<FetchId>,
    /// The agents effect's dep (`[sessionId]`) and its request.
    agents_deps: Option<Option<String>>,
    agents_fetch: Option<FetchId>,
}

/// The picker open over the box, as the view draws it.
#[derive(Clone, Debug, PartialEq)]
pub enum Menu {
    Slash(SlashMenu),
    At(AtMenuView),
    Emoji(EmojiMenu),
}

/// `SlashCommandPicker`'s rows (at most 16).
#[derive(Clone, Debug, PartialEq)]
pub struct SlashMenu {
    pub rows: Vec<SlashRow>,
    pub hi: usize,
    /// The lowercased token the rows matched.
    pub filter: String,
}

#[derive(Clone, Debug, PartialEq)]
pub struct SlashRow {
    pub suggestion: SlashSuggestion,
    /// The category header drawn above the row (no filter, a new category).
    pub header: Option<&'static str>,
    /// The name in `(text, bold)` pieces: the matched characters bold.
    pub name: Vec<(String, bool)>,
}

/// `AtMentionPicker`'s panel.
#[derive(Clone, Debug, PartialEq)]
pub struct AtMenuView {
    /// `"loading…"`, `"3 files"`, `"1 agent"`.
    pub count: String,
    /// The failed search's row.
    pub error: Option<String>,
    pub rows: Vec<PickerItem>,
    pub hi: usize,
}

/// `EmojiShortcodePicker`'s panel.
#[derive(Clone, Debug, PartialEq)]
pub struct EmojiMenu {
    /// `(name, emoji)`.
    pub rows: Vec<(&'static str, &'static str)>,
    pub hi: usize,
    pub count: String,
}

/// Mounts or re-renders a list picker showing `len` rows.
fn list_render(slot: &mut Option<ListMenu>, len: usize) {
    match slot {
        None => {
            *slot = Some(ListMenu {
                hi: 0,
                last_len: len,
            })
        }
        Some(m) if m.last_len != len => {
            m.last_len = len;
            m.hi = 0;
        }
        Some(_) => {}
    }
}

/// `r.json().catch(() => ({}))`.
fn json_or_empty(body: &str) -> Value {
    let text = body.strip_prefix('\u{feff}').unwrap_or(body);
    serde_json::from_str(text).unwrap_or_else(|_| json!({}))
}

/// Moves a highlight one row (`(h ± 1 + n) % n`).
fn step(hi: usize, n: usize, down: bool) -> usize {
    if down { (hi + 1) % n } else { (hi + n - 1) % n }
}

impl Composer {
    // ------------------------------------------------------------ reads

    /// Whether emoji completion is on (`emojiCompletionEnabled`).
    pub fn emoji_completion_enabled(&self) -> bool {
        self.emoji_enabled
    }

    /// The SDK's command list for the bound session, once it loaded.
    pub fn sdk_commands(&self) -> Option<&[slash::SdkCommand]> {
        self.sdk_commands
            .as_ref()
            .filter(|(f, _)| Some(f.as_str()) == self.session_id.as_deref())
            .and_then(|(_, l)| l.as_deref())
    }

    /// The slash picker's whole list (`mergeSuggestions`).
    pub fn slash_suggestions(&self) -> Vec<SlashSuggestion> {
        slash::merge_suggestions(&self.slash_commands, &self.skills, self.sdk_commands())
    }

    fn slash_visible(&self) -> (Vec<SlashSuggestion>, String) {
        let filter = slash::picker_filter(self.picker.slash_query.as_deref().unwrap_or(""));
        let all = self.slash_suggestions();
        let rows = slash::filter_suggestions(&all, &filter)
            .into_iter()
            .take(slash::VISIBLE_LIMIT)
            .cloned()
            .collect();
        (rows, filter)
    }

    fn emoji_visible(&self) -> Vec<(&'static str, &'static str)> {
        emoji::filter_emoji_shortcodes(self.picker.emoji_query.as_deref().unwrap_or(""))
    }

    fn at_mode(&self) -> (bool, String) {
        let q = self.picker.at_query.as_deref().unwrap_or("");
        let (agent_mode, filter) = mention::parse_at_mention_query(q);
        (agent_mode, filter.to_owned())
    }

    /// `cachedAgents`: only a list fetched for the bound session.
    fn cached_agents<'a>(&self, m: &'a AtMenu) -> Option<&'a [Agent]> {
        (m.agents_for == self.session_id)
            .then_some(m.agents.as_deref())
            .flatten()
    }

    fn at_visible(&self, m: &AtMenu) -> Vec<PickerItem> {
        let (agent_mode, filter) = self.at_mode();
        if agent_mode {
            return mention::filter_agents(self.cached_agents(m).unwrap_or(&[]), &filter);
        }
        m.entries
            .iter()
            .take(mention::PICKER_LIMIT)
            .map(|e| PickerItem::File {
                rel_path: e.rel_path.clone(),
                dir: e.dir,
            })
            .collect()
    }

    /// The displayed `loading` (AtMentionPicker.tsx:132).
    fn at_loading(&self, m: &AtMenu) -> bool {
        if self.at_mode().0 {
            self.session_id.is_some() && self.cached_agents(m).is_none()
        } else {
            m.file_loading
        }
    }

    /// The picker drawn over the box, if one is mounted and shows anything
    /// (each returns `null` with nothing to show).
    pub fn menu(&self) -> Option<Menu> {
        if let Some(m) = &self.at_menu {
            let rows = self.at_visible(m);
            let loading = self.at_loading(m);
            let agent_mode = self.at_mode().0;
            let error = (!agent_mode && !loading)
                .then(|| m.file_error.clone())
                .flatten();
            if rows.is_empty() && !loading && error.is_none() {
                return None;
            }
            return Some(Menu::At(AtMenuView {
                count: mention::count_label(loading, agent_mode, rows.len()),
                error,
                rows,
                hi: m.hi,
            }));
        }
        if let Some(m) = &self.emoji_menu {
            let rows = self.emoji_visible();
            if rows.is_empty() {
                return None;
            }
            return Some(Menu::Emoji(EmojiMenu {
                count: emoji::count_label(rows.len()),
                rows,
                hi: m.hi,
            }));
        }
        let m = self.slash_menu.as_ref()?;
        let (visible, filter) = self.slash_visible();
        if visible.is_empty() {
            return None;
        }
        let rows = visible
            .iter()
            .enumerate()
            .map(|(i, c)| {
                let new_category = i == 0 || visible[i - 1].category != c.category;
                SlashRow {
                    header: (filter.is_empty() && new_category).then(|| c.category.label()),
                    name: slash::highlight_segments(&filter, &c.name),
                    suggestion: c.clone(),
                }
            })
            .collect();
        Some(Menu::Slash(SlashMenu {
            rows,
            hi: m.hi,
            filter,
        }))
    }

    // ---------------------------------------------------------- render

    /// The pickers' render: mounts and unmounts them from the picker
    /// state, resets a highlight whose list changed length, and runs the
    /// `@` picker's effects whose deps changed (their requests go out with
    /// the entry point's next [`Composer::commit`]).
    pub(super) fn sync_menus(&mut self) {
        let at_on = self.picker.at_query.is_some();
        let emoji_on = !at_on && self.picker.emoji_query.is_some();
        let slash_on = self.picker.open && !at_on && self.picker.emoji_query.is_none();
        if slash_on {
            let len = self.slash_visible().0.len();
            list_render(&mut self.slash_menu, len);
        } else {
            self.slash_menu = None;
        }
        if emoji_on {
            let len = self.emoji_visible().len();
            list_render(&mut self.emoji_menu, len);
        } else {
            self.emoji_menu = None;
        }
        if at_on {
            self.sync_at();
        } else if let Some(m) = self.at_menu.take() {
            // Unmount: both effects' cleanups abort.
            self.abort(m.fs_fetch);
            self.abort(m.agents_fetch);
        }
    }

    fn abort(&mut self, id: Option<FetchId>) {
        if let Some(id) = id {
            self.fetches.remove(&id);
        }
    }

    /// A picker's GET, sent with the entry point's other effects.
    fn menu_fetch(&mut self, url: String, then: Req) -> FetchId {
        let mut out = Vec::new();
        self.fetch(&mut out, "GET", url, None, then);
        let id = match out.first() {
            Some(Out::Fetch(r)) => r.id,
            _ => unreachable!("fetch pushes its request"),
        };
        self.menu_out.append(&mut out);
        id
    }

    fn sync_at(&mut self) {
        let query = self.picker.at_query.clone().unwrap_or_default();
        let cwd = self.cwd.clone();
        let agent_mode = mention::parse_at_mention_query(&query).0;
        let mut m = self.at_menu.take().unwrap_or_else(|| AtMenu {
            file_loading: true,
            last_inputs: (query.clone(), cwd.clone()),
            ..AtMenu::default()
        });
        // Render: a new query or cwd shows "loading…" until its search lands.
        if m.last_inputs != (query.clone(), cwd.clone()) {
            m.last_inputs = (query.clone(), cwd.clone());
            m.file_loading = true;
        }
        // The file search (`[query, cwd, agentMode]`); agent mode fires none.
        let deps = (query.clone(), cwd.clone(), agent_mode);
        if m.fs_deps.as_ref() != Some(&deps) {
            self.abort(m.fs_fetch.take());
            m.fs_deps = Some(deps);
            if !agent_mode {
                let url = mention::fs_list_url(&query, cwd.as_deref());
                m.fs_fetch = Some(self.menu_fetch(url, Req::FsList));
            }
        }
        // The agent list, once per session (`[sessionId]`).
        let sid = self.session_id.clone();
        if m.agents_deps.as_ref() != Some(&sid) {
            self.abort(m.agents_fetch.take());
            m.agents_deps = Some(sid.clone());
            if let Some(s) = sid {
                let url = mention::agents_url(&s);
                m.agents_fetch = Some(self.menu_fetch(url, Req::Agents(s)));
            }
        }
        let len = self.at_visible(&m).len();
        if len != m.last_len {
            m.last_len = len;
            m.hi = 0;
        }
        self.at_menu = Some(m);
    }

    /// The `@` picker's file search settled.
    pub(super) fn fs_list_settled(&mut self, id: FetchId, outcome: &FetchOutcome) {
        let Some(m) = self.at_menu.as_mut() else {
            return;
        };
        if m.fs_fetch != Some(id) {
            return;
        }
        m.fs_fetch = None;
        match outcome {
            // A network failure stays quiet.
            FetchOutcome::Failed(_) => {
                m.entries.clear();
                m.file_error = None;
            }
            FetchOutcome::Response { status, body } => {
                let d = json_or_empty(body);
                if d.is_null() {
                    // `d.entries` throws: the `.catch` path.
                    m.entries.clear();
                    m.file_error = None;
                } else if (200..300).contains(status) {
                    m.entries = mention::fs_entries_of(&d);
                    m.file_error = None;
                } else {
                    m.entries.clear();
                    m.file_error = mention::fs_list_error_text(*status, &d);
                }
            }
        }
        m.file_loading = false;
        self.sync_menus();
    }

    /// The `@` picker's agent list settled.
    pub(super) fn agents_settled(&mut self, id: FetchId, for_id: String, outcome: &FetchOutcome) {
        let Some(m) = self.at_menu.as_mut() else {
            return;
        };
        if m.agents_fetch != Some(id) {
            return;
        }
        m.agents_fetch = None;
        let agents = match ok_json(outcome) {
            Ok(Some(d)) => mention::agents_of(Some(&d)),
            Ok(None) | Err(()) => Vec::new(),
        };
        m.agents_for = Some(for_id);
        m.agents = Some(agents);
        self.sync_menus();
    }

    /// `useSdkCommands`' fetch settled.
    pub(super) fn commands_settled(&mut self, for_id: String, outcome: &FetchOutcome) {
        let list = match ok_json(outcome) {
            Ok(Some(d)) => slash::sdk_commands_of(Some(&d)),
            Ok(None) | Err(()) => None,
        };
        self.sdk_commands = Some((for_id, list));
        self.sync_menus();
    }

    /// `useEmojiCompletionEnabled`'s fetch settled.
    pub(super) fn emoji_setting_settled(&mut self, id: FetchId, outcome: &FetchOutcome) {
        if self.emoji_fetch != Some(id) {
            return;
        }
        self.emoji_fetch = None;
        if let Ok(Some(d)) = ok_json(outcome)
            && let Some(on) = emoji::emoji_enabled_of(&d)
        {
            self.emoji_enabled = on;
        }
    }

    /// `useSdkCommands(sessionId)`'s effect, on a bind.
    pub(super) fn load_sdk_commands(&mut self, out: &mut Vec<Out>) {
        self.fetches.retain(|_, r| !matches!(r, Req::Commands(_)));
        if let Some(id) = self.session_id.clone() {
            let url = format!("/api/sessions/{}/commands", encode_uri_component(&id));
            self.fetch(out, "GET", url, None, Req::Commands(id));
        }
    }

    /// What the composer reads of the bound session changed: the cwd (the
    /// `@` search's, and ChatSurface's `useEmojiCompletionEnabled(cwd)`),
    /// the init's command and skill names (the slash list).
    pub fn observe(&mut self, view: &SessionView) -> Vec<Out> {
        let changed = self.cwd != view.cwd
            || self.slash_commands != view.slash_commands
            || self.skills != view.skills;
        self.cwd = view.cwd.clone();
        self.slash_commands = view.slash_commands.clone();
        self.skills = view.skills.clone();
        if changed {
            self.sync_menus();
        }
        let mut out = std::mem::take(&mut self.menu_out);
        if self.emoji_dep.as_ref() != Some(&self.cwd) {
            if let Some(id) = self.emoji_fetch.take() {
                self.fetches.remove(&id);
            }
            self.emoji_dep = Some(self.cwd.clone());
            if let Some(cwd) = self.cwd.clone() {
                let url = emoji::settings_url(&cwd);
                self.fetch(&mut out, "GET", url, None, Req::EmojiSetting);
                if let Some(Out::Fetch(r)) = out.last() {
                    self.emoji_fetch = Some(r.id);
                }
            }
        }
        out
    }

    // ------------------------------------------------------------ keys

    /// The mounted picker's `keydown` listener (window, capture phase):
    /// `Some` when it took the key, so `onKeyDown` never sees it.
    pub(super) fn menu_key(&mut self, k: &Key, sel: Selection) -> Option<KeyOutcome> {
        let arrow = matches!(k.key.as_str(), "ArrowUp" | "ArrowDown");
        if (k.meta || k.ctrl) && arrow {
            return None;
        }
        let down = k.key == "ArrowDown";
        let mut o = KeyOutcome {
            handled: true,
            ..KeyOutcome::default()
        };
        if let Some(m) = &self.at_menu {
            let rows = self.at_visible(m);
            if rows.is_empty() {
                return None;
            }
            let hi = m.hi.min(rows.len() - 1);
            match k.key.as_str() {
                "ArrowUp" | "ArrowDown" => {
                    if let Some(m) = self.at_menu.as_mut() {
                        m.hi = step(hi, rows.len(), down);
                    }
                }
                "Tab" | "Enter" => self.pick_at(&mention::item_token(&rows[hi]), sel.start),
                "Escape" => {
                    self.picker.at_query = None;
                    self.sync_menus();
                }
                _ => return None,
            }
        } else if let Some(m) = &self.emoji_menu {
            let rows = self.emoji_visible();
            if rows.is_empty() {
                return None;
            }
            let hi = m.hi.min(rows.len() - 1);
            match k.key.as_str() {
                "ArrowUp" | "ArrowDown" => {
                    if let Some(m) = self.emoji_menu.as_mut() {
                        m.hi = step(hi, rows.len(), down);
                    }
                }
                "Tab" | "Enter" => self.pick_emoji(rows[hi].0, sel.start),
                "Escape" => {
                    self.picker.emoji_query = None;
                    self.sync_menus();
                }
                _ => return None,
            }
        } else if let Some(m) = &self.slash_menu {
            let (rows, filter) = self.slash_visible();
            if rows.is_empty() {
                return None;
            }
            let hi = m.hi.min(rows.len() - 1);
            let capture = self.picker.slash_at_start;
            match k.key.as_str() {
                "ArrowUp" | "ArrowDown" => {
                    if let Some(m) = self.slash_menu.as_mut() {
                        m.hi = step(hi, rows.len(), down);
                    }
                }
                "Tab" => self.pick_slash(&rows[hi].name, sel.start),
                // A leading `/word`: Enter runs a confident match (a prefix
                // of the name or an alias) and swallows a typo (CC 2.1.236).
                "Enter" if capture && !filter.is_empty() => {
                    let c = &rows[hi];
                    if slash::is_confident_slash_match(&c.name, &c.aliases, &filter) {
                        self.pick_slash(&c.name.clone(), sel.start);
                    }
                }
                // `stopPropagation()` without `preventDefault()`: the
                // editor still sees it, `onKeyDown` doesn't.
                "Escape" => {
                    self.picker.open = false;
                    self.picker.slash_query = None;
                    self.picker.slash_at_start = false;
                    self.sync_menus();
                    o.handled = false;
                }
                _ => return None,
            }
        } else {
            return None;
        }
        self.commit_into(&mut o.out);
        Some(o)
    }

    // ----------------------------------------------------------- picks

    /// `insertSlashCommand(cmd)`: the token becomes `/<cmd> ` and the slash
    /// picker closes (the `@` / emoji state is left as it was).
    fn pick_slash(&mut self, cmd: &str, caret: usize) {
        let (next, at) = slash::insert_slash_command(&self.value, caret, cmd);
        self.set_value(next, at);
        self.picker.slash_query = None;
        self.picker.slash_at_start = false;
        self.picker.open = false;
        self.sync_menus();
    }

    /// `insertAtMention(rel)`.
    fn pick_at(&mut self, token: &str, caret: usize) {
        let (next, at) = mention::insert_at_mention(&self.value, caret, token);
        self.set_value(next, at);
        self.picker.at_query = None;
        self.sync_menus();
    }

    /// `insertEmojiShortcode(name)`: nothing for a name with no emoji.
    fn pick_emoji(&mut self, name: &str, caret: usize) {
        let Some((next, at)) = emoji::insert_emoji_shortcode(&self.value, caret, name) else {
            return;
        };
        self.set_value(next, at);
        self.picker.emoji_query = None;
        self.sync_menus();
    }

    /// A row's `onMouseEnter`: it becomes the highlight.
    pub fn menu_hover(&mut self, index: usize) {
        if let Some(m) = self.at_menu.as_mut() {
            m.hi = index;
        } else if let Some(m) = self.emoji_menu.as_mut() {
            m.hi = index;
        } else if let Some(m) = self.slash_menu.as_mut() {
            m.hi = index;
        }
    }

    /// A row's `onMouseDown` (`onSelect(row)`); `caret` is the editor's
    /// selection start.
    pub fn menu_pick(&mut self, index: usize, caret: usize) -> Vec<Out> {
        let mut out = Vec::new();
        match self.menu() {
            Some(Menu::At(m)) => {
                if let Some(item) = m.rows.get(index) {
                    self.pick_at(&mention::item_token(item), caret);
                }
            }
            Some(Menu::Emoji(m)) => {
                if let Some((name, _)) = m.rows.get(index) {
                    self.pick_emoji(name, caret);
                }
            }
            Some(Menu::Slash(m)) => {
                if let Some(row) = m.rows.get(index) {
                    let name = row.suggestion.name.clone();
                    self.pick_slash(&name, caret);
                }
            }
            None => {}
        }
        self.commit_into(&mut out);
        out
    }
}

#[cfg(test)]
mod tests;
