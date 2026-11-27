//! A workspace's session-tab strip: `ChatSurface.tsx`'s open-tabs state and
//! the pure helpers of `SessionTabs.tsx`.
//!
//! The strip holds the open ids (pinned first), the pinned set, and the
//! *bound* session: the one the chat shows (`useSession`'s `sessionId`),
//! which is usually the active tab but lingers on a closed id after the last
//! tab (or, with "Close all", the active unpinned tab) is closed, as in the
//! React app. Binding a new id adds it to the strip (the render-time
//! auto-add); every change after hydration is persisted ([`TabStrip::persist`]).

use serde_json::Value;

use crate::data::{
    ActiveSessionState, OpenTabs, OpenTabsPut, SessionSummary, TAB_LABEL_DEFAULT, TabStatus,
    active_tab_status,
};

/// The closed-tab stack's cap (`closedTabsRef`).
const CLOSED_CAP: usize = 64;

#[derive(Clone, Debug, Default, PartialEq)]
pub struct TabStrip {
    tabs: Vec<String>,
    pinned: Vec<String>,
    bound: Option<String>,
    /// The last id the auto-add saw (`lastAddedKey`).
    last_added: Option<String>,
    closed: Vec<(String, usize)>,
    hydrated: bool,
    label_max_width: Option<f64>,
    /// The persisted titles (`openTabTitles`), for tabs with no session row.
    titles: Vec<(String, String)>,
}

impl TabStrip {
    pub fn tabs(&self) -> &[String] {
        &self.tabs
    }

    pub fn pinned(&self) -> &[String] {
        &self.pinned
    }

    pub fn is_pinned(&self, id: &str) -> bool {
        self.pinned.iter().any(|p| p == id)
    }

    /// The session the chat shows (`session.sessionId`).
    pub fn bound(&self) -> Option<&str> {
        self.bound.as_deref()
    }

    /// The highlighted tab: the bound session, while it's in the strip.
    pub fn active(&self) -> Option<&str> {
        self.bound
            .as_deref()
            .filter(|b| self.tabs.iter().any(|t| t == b))
    }

    pub fn is_hydrated(&self) -> bool {
        self.hydrated
    }

    /// Every tab label's max width (px), the user's or 180.
    pub fn label_max_width(&self) -> f64 {
        self.label_max_width.unwrap_or(TAB_LABEL_DEFAULT)
    }

    /// The persisted title of a tab, if the route had one.
    pub fn saved_title(&self, id: &str) -> Option<&str> {
        self.titles
            .iter()
            .find(|(t, _)| t == id)
            .map(|(_, s)| s.as_str())
    }

    /// The first `GET /api/sessions/open-tabs`: the saved strip, then any id
    /// bound before it answered; the saved pins, width and titles (a title
    /// that trims to nothing is dropped).
    pub fn hydrate(&mut self, saved: &OpenTabs) {
        let mut merged = saved.tabs.clone();
        for id in &self.tabs {
            if !merged.contains(id) {
                merged.push(id.clone());
            }
        }
        self.tabs = merged;
        self.pinned = saved.pinned.clone();
        self.label_max_width = Some(saved.label_max_width).filter(|w| w.is_finite());
        self.titles = saved
            .titles
            .iter()
            .filter_map(|(id, t)| match t {
                Value::String(s) if !s.trim().is_empty() => Some((id.clone(), s.clone())),
                _ => None,
            })
            .collect();
        self.hydrated = true;
        self.normalize();
    }

    /// Binds the chat to a session (`switchSession`, a boot resume, a new
    /// session); a newly bound id joins the strip at the end.
    pub fn bind(&mut self, id: &str) {
        self.bound = Some(id.to_owned());
        if self.last_added.as_deref() != Some(id) {
            self.last_added = Some(id.to_owned());
            if !self.tabs.iter().any(|t| t == id) {
                self.tabs.push(id.to_owned());
            }
        }
        self.normalize();
    }

    /// A tab click (`onSelect`): binds it unless it's already bound.
    pub fn select(&mut self, id: &str) {
        if self.bound.as_deref() != Some(id) {
            self.bind(id);
        }
    }

    /// `closeTab`: drops the pin, removes the tab and remembers where it
    /// was; closing the bound tab binds its left neighbour (else the new
    /// first tab). The last tab leaves the bound id as it was.
    pub fn close(&mut self, id: &str) {
        self.pinned.retain(|p| p != id);
        let Some(idx) = self.tabs.iter().position(|t| t == id) else {
            return;
        };
        self.tabs.remove(idx);
        self.closed.push((id.to_owned(), idx));
        if self.closed.len() > CLOSED_CAP {
            self.closed.remove(0);
        }
        if self.bound.as_deref() == Some(id) {
            let target = self
                .tabs
                .get(idx.saturating_sub(1))
                .or_else(|| self.tabs.first())
                .cloned();
            if let Some(t) = target {
                self.bind(&t);
            }
        }
    }

    /// `closeActiveTab` (⌘W): closes the bound session's tab.
    pub fn close_active(&mut self) {
        if let Some(id) = self.bound.clone() {
            self.close(&id);
        }
    }

    /// `reopenClosedTab` (⌘⇧T): back where it was (clamped), and bound.
    pub fn reopen(&mut self) {
        let Some((id, index)) = self.closed.pop() else {
            return;
        };
        if !self.tabs.contains(&id) {
            let at = index.min(self.tabs.len());
            self.tabs.insert(at, id.clone());
        }
        self.normalize();
        self.select(&id);
    }

    /// The unpinned tabs "Close all" would close (it asks first).
    pub fn closable(&self) -> Vec<String> {
        self.tabs
            .iter()
            .filter(|t| !self.is_pinned(t))
            .cloned()
            .collect()
    }

    /// `closeAllTabs` once confirmed: only the pinned tabs stay. The bound
    /// session doesn't change.
    pub fn close_all(&mut self) -> Vec<String> {
        let closed = self.closable();
        let pinned = self.pinned.clone();
        self.tabs.retain(|t| pinned.contains(t));
        closed
    }

    /// `togglePin`: the strip re-sorts pinned-first.
    pub fn toggle_pin(&mut self, id: &str) {
        if self.is_pinned(id) {
            self.pinned.retain(|p| p != id);
        } else {
            self.pinned.push(id.to_owned());
        }
        self.normalize();
    }

    /// `reorderTab`: a drag, kept within its group (pinned or not).
    pub fn reorder(&mut self, from: usize, to: usize) {
        let pinned_count = self.tabs.iter().take_while(|t| self.is_pinned(t)).count();
        let to = clamp_reorder_target(from, to, pinned_count, self.tabs.len());
        reorder(&mut self.tabs, from, to);
    }

    /// The tab at a 0-based position, for the cycle and number shortcuts.
    fn tab_at(&self, idx: usize) -> Option<String> {
        self.tabs.get(idx).cloned()
    }

    /// ⌘⌥→ / ⌘⌥←: the next / previous tab, wrapping; with no active tab,
    /// the first / last.
    pub fn cycle(&mut self, forward: bool) {
        let len = self.tabs.len() as isize;
        if len == 0 {
            return;
        }
        let cur = self
            .active()
            .and_then(|a| self.tabs.iter().position(|t| t == a))
            .map(|i| i as isize);
        let dir = if forward { 1 } else { -1 };
        let baseline = cur.unwrap_or(if forward { -1 } else { 0 });
        let idx = (baseline + dir + len).rem_euclid(len) as usize;
        if let Some(t) = self.tab_at(idx) {
            self.select(&t);
        }
    }

    /// ⌘1 … ⌘8 (`tab.go<n>`, `n` 1-based).
    pub fn go_to(&mut self, n: usize) {
        if let Some(t) = n.checked_sub(1).and_then(|i| self.tab_at(i)) {
            self.select(&t);
        }
    }

    /// ⌘9 (`tab.last`).
    pub fn go_to_last(&mut self) {
        if let Some(t) = self.tabs.last().cloned() {
            self.select(&t);
        }
    }

    /// ⌘⇧1 … ⌘⇧9 (`tab.selectByNumber`): tab `n`, but 9 is the last tab
    /// once there are 9 or more (iTerm's rule), and nothing below that.
    pub fn select_by_number(&mut self, n: usize) {
        let target = if n == 9 {
            (self.tabs.len() >= 9)
                .then(|| self.tabs.last().cloned())
                .flatten()
        } else {
            n.checked_sub(1).and_then(|i| self.tab_at(i))
        };
        if let Some(t) = target {
            self.select(&t);
        }
    }

    /// Sets the labels' max width (`onLabelWidthChange`, clamped 60–600).
    pub fn set_label_max_width(&mut self, width: f64) -> f64 {
        let w = width.clamp(TAB_LABEL_MIN, TAB_LABEL_MAX);
        self.label_max_width = Some(w);
        w
    }

    /// Pinned first, each group in its order (`normalizePinnedOrder`).
    fn normalize(&mut self) {
        let (pin, rest): (Vec<String>, Vec<String>) =
            self.tabs.drain(..).partition(|t| self.pinned.contains(t));
        self.tabs = pin.into_iter().chain(rest).collect();
    }

    /// What the chat `PUT`s after a change, `None` before hydration (the
    /// empty boot strip would clobber the saved one). A tab whose session
    /// lives in another workspace (`cwd` other than `root`) is left out, as
    /// is its pin; one with no session row yet is kept. `activeId` is the
    /// bound session when it's in what is saved.
    pub fn persist(&self, root: &str, sessions: &[SessionSummary]) -> Option<OpenTabsPut> {
        if !self.hydrated {
            return None;
        }
        let tabs: Vec<String> = self
            .tabs
            .iter()
            .filter(|id| {
                sessions
                    .iter()
                    .find(|s| &s.id == *id)
                    .is_none_or(|s| s.cwd == root)
            })
            .cloned()
            .collect();
        let active = self.bound.clone().filter(|b| tabs.contains(b));
        let pinned = self
            .pinned
            .iter()
            .filter(|p| tabs.contains(p))
            .cloned()
            .collect();
        Some(OpenTabsPut {
            tabs: Some(tabs),
            active_id: Some(active),
            pinned: Some(pinned),
            label_max_width: None,
        })
    }

    /// One tab as the strip draws it.
    pub fn view(
        &self,
        id: &str,
        sessions: &[SessionSummary],
        bound_state: Option<ActiveSessionState>,
        now_year: i32,
    ) -> TabView {
        let status = if self.bound.as_deref() == Some(id)
            && let Some(state) = bound_state
        {
            active_tab_status(state)
        } else {
            sessions
                .iter()
                .find(|s| s.id == id)
                .and_then(|s| s.status)
                .map_or(TabStatus::Background, Into::into)
        };
        TabView {
            id: id.to_owned(),
            label: tab_label(id, sessions, self.saved_title(id), None, now_year),
            status,
            pinned: self.is_pinned(id),
            active: self.active() == Some(id),
        }
    }
}

/// A tab's drawing state.
#[derive(Clone, Debug, PartialEq)]
pub struct TabView {
    pub id: String,
    pub label: String,
    pub status: TabStatus,
    pub pinned: bool,
    pub active: bool,
}

impl TabView {
    /// A pinned tab that isn't active draws as its pin and number only.
    pub fn compact(&self) -> bool {
        self.pinned && !self.active
    }
}

/// `TAB_LABEL_MIN` / `TAB_LABEL_MAX`.
pub const TAB_LABEL_MIN: f64 = 60.;
pub const TAB_LABEL_MAX: f64 = 600.;

/// `tabLabelFor` over the chat's session list (the live rows, plus a
/// `{id, title}` row for an open tab with no live row but a saved title):
/// the override (the bound session's live title), else the row's title,
/// else its creation date ([`readable_session_label`]), else the id's first
/// 8 characters. Titles are trimmed.
pub fn tab_label(
    id: &str,
    sessions: &[SessionSummary],
    saved_title: Option<&str>,
    title_override: Option<&str>,
    now_year: i32,
) -> String {
    if let Some(t) = title_override.map(str::trim).filter(|t| !t.is_empty()) {
        return t.to_owned();
    }
    match sessions.iter().find(|s| s.id == id) {
        Some(known) => {
            if let Some(t) = known
                .title
                .as_deref()
                .map(str::trim)
                .filter(|t| !t.is_empty())
            {
                return t.to_owned();
            }
            if known.created_at != 0. && !known.created_at.is_nan() {
                return readable_session_label(known.created_at, now_year);
            }
        }
        None => {
            if let Some(t) = saved_title.map(str::trim).filter(|t| !t.is_empty()) {
                return t.to_owned();
            }
        }
    }
    short_id(id)
}

/// `id.slice(0, 8)` (UTF-16 units).
pub fn short_id(id: &str) -> String {
    let units: Vec<u16> = id.encode_utf16().take(8).collect();
    String::from_utf16_lossy(&units)
}

/// `readableSessionLabel` in en-US, local time: `Jun 30 at 2:15 PM`, with
/// the year when it isn't this one (`Jun 30, 2024 at 2:15 PM`). ICU puts a
/// narrow no-break space (U+202F) before the day period, as Chromium does.
pub fn readable_session_label(created_at_ms: f64, now_year: i32) -> String {
    use chrono::{Datelike, Local, TimeZone};
    let Some(d) = Local.timestamp_millis_opt(created_at_ms as i64).single() else {
        return String::new();
    };
    let date = if d.year() == now_year {
        d.format("%b %-d").to_string()
    } else {
        d.format("%b %-d, %Y").to_string()
    };
    format!("{date} at {}", d.format("%-I:%M\u{202f}%p"))
}

/// The local year, for [`readable_session_label`].
pub fn current_year() -> i32 {
    use chrono::Datelike;
    chrono::Local::now().year()
}

/// `shortcutForTabIndex`: up to 9 tabs, tab N is N; past 9, tabs 1–8 keep
/// theirs, the last is 9 and the rest have none.
pub fn shortcut_for_tab_index(idx: usize, len: usize) -> Option<usize> {
    if idx >= len {
        return None;
    }
    if len <= 9 || idx < 8 {
        return Some(idx + 1);
    }
    (idx == len - 1).then_some(9)
}

/// `clampReorderTarget`: a drop inside the dragged tab's own group.
pub fn clamp_reorder_target(from: usize, to: usize, pinned_count: usize, len: usize) -> usize {
    let from_pinned = from < pinned_count;
    let (lo, hi) = if from_pinned {
        (0, pinned_count as isize - 1)
    } else {
        (pinned_count, len as isize - 1)
    };
    if hi < lo as isize {
        return from;
    }
    (to.max(lo) as isize).min(hi) as usize
}

/// `reorderArray` in place (out-of-range or same index: no change).
pub fn reorder<T>(items: &mut Vec<T>, from: usize, to: usize) {
    if from >= items.len() || to >= items.len() || from == to {
        return;
    }
    let moved = items.remove(from);
    items.insert(to, moved);
}

/// The strip's trailing controls' reserve (overflow chevron, `+`, close
/// all), px.
pub const TRAILER_PX: f32 = 120.;
/// A tab's width before it was ever measured, px.
pub const UNMEASURED_PX: f32 = 100.;

/// The overflow rule (`SessionTabs`' layout effect): tabs fit left to right
/// in the strip minus [`TRAILER_PX`]; the active tab is always shown, by
/// dropping tabs off the end until it fits. Returns the hidden ids, in
/// strip order.
pub fn hidden_tabs(
    tabs: &[String],
    width_of: impl Fn(&str) -> Option<f32>,
    strip_width: f32,
    active: Option<&str>,
) -> Vec<String> {
    if strip_width <= 0. || tabs.is_empty() {
        return Vec::new();
    }
    let w = |id: &str| width_of(id).unwrap_or(UNMEASURED_PX);
    let available = (strip_width - TRAILER_PX).max(0.);
    let mut visible: Vec<&str> = Vec::new();
    let mut used = 0.;
    for t in tabs {
        let tw = w(t);
        if used + tw <= available {
            visible.push(t);
            used += tw;
        } else {
            break;
        }
    }
    if let Some(a) = active
        && !visible.contains(&a)
    {
        let aw = w(a);
        while !visible.is_empty() && used + aw > available {
            let popped = visible.pop().expect("not empty");
            used -= w(popped);
        }
        visible.push(a);
    }
    tabs.iter()
        .filter(|t| !visible.contains(&t.as_str()))
        .cloned()
        .collect()
}
