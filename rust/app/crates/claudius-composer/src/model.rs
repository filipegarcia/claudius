//! [`Composer`]: `components/chat/PromptInput.tsx`'s state and handlers as
//! a pure state machine, with the slice of `ChatSurface.tsx` that wires it
//! (the queue strip's Edit lift and the lifted-prompt history, the
//! suggestion pick, the prompt color load).
//!
//! The model never performs I/O. Every entry point returns the [`Out`]s
//! the TS would cause, in its order: a session action ([`Out::Call`]), one
//! of the composer's own requests ([`Out::Fetch`]: the draft row, `!`-mode
//! bash, the prompt color), a timer ([`Out::SetTimer`] / [`Out::ClearTimer`])
//! or a toast ([`Out::Notice`]). The host reports each outcome back with
//! the id it carried: [`Composer::call_resolved`], [`Composer::fetch_settled`],
//! [`Composer::timer_fired`].
//!
//! **Render and effects.** React re-renders after the handlers and then
//! runs the effects whose deps changed. Entry points end with
//! [`Composer::commit`], which runs the two effects the composer's state
//! feeds: the debounced draft save (deps `[sessionId, value, images]`) and
//! nothing else (focus and autosize are the view's). The session switch
//! (`sessionId` changing) is [`Composer::bind`].
//!
//! **Text and caret.** `value` is the editor's text; offsets are UTF-8
//! byte offsets into it (the TS's UTF-16 ones map one to one, every
//! character the rules look at is ASCII). The view mirrors the editor into
//! the model on every edit ([`Composer::edited`]) and applies the model's
//! own writes (a send clearing the box, a recalled prompt) when
//! [`Composer::text_rev`] moves, with the caret at [`Composer::caret`].
//!
//! **Seams.** The pickers (U07b) plug into [`Composer::refresh_picker_state`]
//! and [`PickerState`]; until then no menu opens and the key rules see
//! them closed. Images, inline pastes and voice (U07c) ride the
//! `images` field and the paste ranges' absence: an image restored with a
//! draft or a lifted queued message is kept and sent, but nothing attaches
//! one yet.

use std::collections::HashMap;

use claudius_client::AttachedImage;
use claudius_client::effect::{FetchId, FetchOutcome, FetchRequest, TimerId};
use claudius_client::queue::SendOpts;
use claudius_client::state::ChatState;
use claudius_client::types::{DisplayBlock, Role};
use claudius_theme::prompt::{PromptColor, PromptColorState};
use serde_json::{Value, json};

use crate::rules::{self, FailedSendPlacement, LiftedPrompt, NoticePlacement, PendingDraft};
use crate::target::SessionCall;

/// The debounced draft save's delay (PromptInput.tsx:775).
pub const DRAFT_SAVE_MS: f64 = 500.0;
/// Double Escape's window (PromptInput.tsx:1440).
pub const DOUBLE_ESCAPE_MS: f64 = 500.0;
/// The invisible-characters notice's life (PromptInput.tsx:1316).
pub const NOTICE_MS: f64 = 4000.0;

const JSON_HEADERS: &[(&str, &str)] = &[("Content-Type", "application/json")];

/// What the composer asks its host to do.
#[derive(Clone, Debug, PartialEq)]
pub enum Out {
    /// A session action. `token` is set when its promise's value matters:
    /// report it with [`Composer::call_resolved`].
    Call {
        token: Option<u64>,
        call: SessionCall,
    },
    /// One of the composer's own requests; report it with
    /// [`Composer::fetch_settled`].
    Fetch(FetchRequest),
    /// `setTimeout(fn, ms)`; report it with [`Composer::timer_fired`].
    SetTimer {
        id: TimerId,
        ms: f64,
    },
    ClearTimer {
        id: TimerId,
    },
    /// `onNotice(message)`: ChatSurface's toast.
    Notice(String),
}

/// The bound session as the composer reads it.
#[derive(Clone, Debug, Default, PartialEq)]
pub struct SessionView {
    pub session_id: Option<String>,
    pub ready: bool,
    pub pending: bool,
    /// `sendDisabled`: `capBreached || session.readOnly` (the cap is not
    /// ported; read-only is the tab-claim lock).
    pub send_disabled: bool,
    pub queue: Vec<QueuedRow>,
    pub sdk_queued_turns: f64,
    pub suggestions: Vec<String>,
    /// The transcript's user prompts, oldest first (ChatSurface.tsx:2108).
    pub sent: Vec<rules::SentPrompt>,
}

/// A row of the queue strip (`QueuedMessage`).
#[derive(Clone, Debug, PartialEq)]
pub struct QueuedRow {
    pub id: String,
    pub text: String,
}

impl SessionView {
    /// What `useSession()` hands the composer, read off the state.
    pub fn of(state: &ChatState) -> SessionView {
        let queue = state
            .queue
            .iter()
            .map(|q| QueuedRow {
                id: q.get("id").and_then(Value::as_str).unwrap_or("").to_owned(),
                text: q
                    .get("text")
                    .and_then(Value::as_str)
                    .unwrap_or("")
                    .to_owned(),
            })
            .collect();
        let sent = state
            .messages
            .iter()
            .filter(|m| m.role == Role::User)
            .map(|m| rules::SentPrompt {
                text: m
                    .blocks
                    .iter()
                    .map(|b| match b {
                        DisplayBlock::Text { text, .. } => text.as_str(),
                        _ => "",
                    })
                    .collect(),
                at: m.created_at,
            })
            .collect();
        SessionView {
            session_id: state.session_id.clone(),
            ready: state.ready,
            pending: state.pending,
            send_disabled: state.read_only(),
            queue,
            sdk_queued_turns: state.sdk_queued_turns.as_f64().unwrap_or(0.0),
            suggestions: state.prompt_suggestions.clone(),
            sent,
        }
    }
}

/// The slash / `@` / `:emoji` menus (U07b): which is open, and the token
/// under the caret.
#[derive(Clone, Debug, Default, PartialEq, Eq)]
pub struct PickerState {
    pub open: bool,
    pub slash_query: Option<String>,
    pub slash_at_start: bool,
    pub at_query: Option<String>,
    pub emoji_query: Option<String>,
}

/// A key press, as `KeyboardEvent` names it.
#[derive(Clone, Debug, Default, PartialEq, Eq)]
pub struct Key {
    /// `e.key`: `"Enter"`, `"ArrowUp"`, `"Escape"`, `"Tab"`, `"c"`, ...
    pub key: String,
    /// `e.code` (`"KeyC"`), when the host knows the physical key.
    pub code: String,
    pub ctrl: bool,
    pub meta: bool,
    pub alt: bool,
    pub shift: bool,
}

impl Key {
    pub fn named(key: &str) -> Key {
        Key {
            key: key.into(),
            ..Key::default()
        }
    }
}

/// What a key press did.
#[derive(Clone, Debug, Default, PartialEq)]
pub struct KeyOutcome {
    /// `preventDefault()`: the editor must not see the key.
    pub handled: bool,
    /// Tab outside a list: the browser moves focus (Shift: backwards).
    pub move_focus: Option<bool>,
    pub out: Vec<Out>,
}

/// The editor's selection when a key arrives.
#[derive(Clone, Copy, Debug, Default, PartialEq, Eq)]
pub struct Selection {
    pub start: usize,
    pub end: usize,
}

/// A stash ↑ restores (`ClearedDraft`, and the failed-send slot).
#[derive(Clone, Debug, PartialEq)]
struct Stash {
    text: String,
    images: Vec<AttachedImage>,
}

#[derive(Clone, Debug, PartialEq)]
struct FailedSend {
    session_id: Option<String>,
    stash: Stash,
}

/// What a fetch continues with.
#[derive(Clone, Debug, PartialEq)]
enum Req {
    /// The bind's draft GET, for this session.
    Seed(String),
    /// A fire-and-forget PUT / DELETE.
    Ignore,
    /// `sendBash`'s POST.
    Bash,
    /// The bind's `GET /prompt-color`.
    Color(String),
    /// `restoreUndelivered`'s "save-to-origin" read of the origin's draft.
    SaveToOrigin { origin: String, sent: Stash },
}

/// What a call's resolution continues with.
#[derive(Clone, Debug, PartialEq)]
enum CallThen {
    /// A typed prompt's `send`: what left, for `restoreUndelivered`.
    Send {
        session_id: Option<String>,
        sent: Stash,
    },
    /// A suggestion pick: nothing (ChatSurface doesn't read it).
    Pick,
    /// The queue strip's Edit (`liftQueued`).
    Lift,
}

/// The composer.
#[derive(Clone, Debug)]
pub struct Composer {
    value: String,
    caret: usize,
    text_rev: u64,
    images: Vec<AttachedImage>,
    session_id: Option<String>,
    picker: PickerState,
    // ---- history (PromptInput.tsx:383) ----
    hist_idx: Option<usize>,
    stashed_draft: String,
    cleared_draft: Option<Stash>,
    failed_send: Option<FailedSend>,
    send_failed: Option<(Option<String>, String)>,
    /// ChatSurface's `liftedHistory`, by session.
    lifted: HashMap<String, Vec<LiftedPrompt>>,
    // ---- drafts (PromptInput.tsx:635) ----
    user_typed: bool,
    seeded_for: Option<String>,
    last_seen_session: Option<String>,
    pending_draft: Option<PendingDraft>,
    save_timer: Option<TimerId>,
    injection_applied: bool,
    // ---- the rest ----
    last_escape: f64,
    sudo_prompt: Option<String>,
    bash_running: bool,
    invisible_notice: Option<String>,
    notice_timer: Option<TimerId>,
    dismissed_hints: Vec<&'static str>,
    ordinal_counter: f64,
    prompt_color: PromptColorState,
    // ---- bookkeeping ----
    /// The effect deps changed since the last commit.
    dirty: bool,
    next_id: u64,
    fetches: HashMap<FetchId, Req>,
    calls: HashMap<u64, CallThen>,
    timers: HashMap<TimerId, Timer>,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
enum Timer {
    Save,
    Notice,
}

impl Default for Composer {
    fn default() -> Self {
        Self::new()
    }
}

/// `encodeURIComponent`.
fn encode_uri_component(s: &str) -> String {
    let mut out = String::with_capacity(s.len());
    for b in s.bytes() {
        if b.is_ascii_alphanumeric() || b"-_.!~*'()".contains(&b) {
            out.push(b as char);
        } else {
            out.push_str(&format!("%{b:02X}"));
        }
    }
    out
}

fn draft_url(id: &str) -> String {
    format!("/api/sessions/{id}/prompt-draft")
}

/// `res.ok ? res.json() : null`, with a body that isn't JSON (or a failed
/// fetch) as `Err` (the promise rejects).
fn ok_json(outcome: &FetchOutcome) -> Result<Option<Value>, ()> {
    match outcome {
        FetchOutcome::Failed(_) => Err(()),
        FetchOutcome::Response { status, body } => {
            if !(200..300).contains(status) {
                return Ok(None);
            }
            let text = body.strip_prefix('\u{feff}').unwrap_or(body);
            serde_json::from_str(text).map(Some).map_err(|_| ())
        }
    }
}

/// A draft reply's `images` (`Array.isArray(data?.images) ? ... : []`).
fn draft_images(data: Option<&Value>) -> Vec<AttachedImage> {
    match data.and_then(|d| d.get("images")) {
        Some(Value::Array(a)) => a
            .iter()
            .filter_map(|v| serde_json::from_value(v.clone()).ok())
            .collect(),
        _ => Vec::new(),
    }
}

/// The highest ordinal of `images`, from `0`.
fn max_ordinal(images: &[AttachedImage]) -> f64 {
    rules::ordinal_floor_after_restore(0.0, images)
}

/// `value.lastIndexOf("\n", caret - 1) + 1`: the line start (`fromIndex`
/// clamps to 0, so a caret at 0 still sees a newline at 0).
fn line_start(value: &str, caret: usize) -> usize {
    let upto = caret.saturating_sub(1);
    value.as_bytes()[..value.len().min(upto + 1)]
        .iter()
        .rposition(|&b| b == b'\n')
        .map_or(0, |i| i + 1)
}

/// `value.indexOf("\n", caret)`, or the length.
fn line_end(value: &str, caret: usize) -> usize {
    let from = caret.min(value.len());
    value[from..].find('\n').map_or(value.len(), |i| from + i)
}

/// `\[Image #(\d+)\]` ordinals of `text`.
fn extract_ordinals(text: &str) -> Vec<f64> {
    let mut out: Vec<f64> = Vec::new();
    let mut from = 0;
    while let Some(rel) = text[from..].find("[Image #") {
        let at = from + rel + "[Image #".len();
        let digits = text[at..].bytes().take_while(u8::is_ascii_digit).count();
        if digits > 0 && text.as_bytes().get(at + digits) == Some(&b']') {
            let n: f64 = text[at..at + digits].parse().unwrap_or(f64::NAN);
            if !out.contains(&n) {
                out.push(n);
            }
            from = at + digits + 1;
        } else {
            from = at - "[Image #".len() + 1;
        }
    }
    out
}

/// The two partial-token cleanups of onChange (PromptInput.tsx:2156):
/// `\[Image #N[^\]]*$` (the first such start past the last `]`) and
/// `^[^\[]*Image #N\]` (the last such end before the first `[`).
fn strip_partial_token(text: &str, ord: f64) -> String {
    let n = rules::num_text(ord);
    let head = format!("[Image #{n}");
    let mut s = text.to_owned();
    let last_close = s.rfind(']').map_or(0, |i| i + 1);
    if let Some(rel) = s[last_close..].find(&head) {
        s.truncate(last_close + rel);
    } else if last_close > 0 {
        // A `]` that is part of the head itself can't exist (the head has
        // none), so an occurrence before the last `]` never matches.
    }
    let tail = format!("Image #{n}]");
    let limit = s.find('[').unwrap_or(s.len());
    let mut best = None;
    let mut from = 0;
    while let Some(rel) = s[from..].find(&tail) {
        let k = from + rel;
        if k > limit {
            break;
        }
        best = Some(k);
        from = k + 1;
    }
    if let Some(k) = best {
        s.replace_range(..k + tail.len(), "");
    }
    s
}

impl Composer {
    pub fn new() -> Self {
        Composer {
            value: String::new(),
            caret: 0,
            text_rev: 0,
            images: Vec::new(),
            session_id: None,
            picker: PickerState::default(),
            hist_idx: None,
            stashed_draft: String::new(),
            cleared_draft: None,
            failed_send: None,
            send_failed: None,
            lifted: HashMap::new(),
            user_typed: false,
            seeded_for: None,
            last_seen_session: None,
            pending_draft: None,
            save_timer: None,
            injection_applied: false,
            last_escape: 0.0,
            sudo_prompt: None,
            bash_running: false,
            invisible_notice: None,
            notice_timer: None,
            dismissed_hints: Vec::new(),
            ordinal_counter: 0.0,
            prompt_color: PromptColorState::default(),
            dirty: false,
            next_id: 0,
            fetches: HashMap::new(),
            calls: HashMap::new(),
            timers: HashMap::new(),
        }
    }

    // ------------------------------------------------------------ reads

    pub fn value(&self) -> &str {
        &self.value
    }

    /// Where the caret goes after the model's own write.
    pub fn caret(&self) -> usize {
        self.caret
    }

    /// Bumped on every write the model makes to the text (not on
    /// [`Self::edited`], which mirrors the editor).
    pub fn text_rev(&self) -> u64 {
        self.text_rev
    }

    pub fn images(&self) -> &[AttachedImage] {
        &self.images
    }

    pub fn session_id(&self) -> Option<&str> {
        self.session_id.as_deref()
    }

    pub fn picker(&self) -> &PickerState {
        &self.picker
    }

    /// `isBashMode` (PromptInput.tsx:1904).
    pub fn is_bash_mode(&self) -> bool {
        self.value.starts_with('!')
    }

    pub fn bash_running(&self) -> bool {
        self.bash_running
    }

    /// The command the sudo password modal is open for.
    pub fn sudo_prompt(&self) -> Option<&str> {
        self.sudo_prompt.as_deref()
    }

    /// `sendFailedNotice`: the hint, on the session it was raised in.
    pub fn send_failed_notice(&self) -> Option<&str> {
        match &self.send_failed {
            Some((sid, text)) if *sid == self.session_id => Some(text),
            _ => None,
        }
    }

    pub fn invisible_notice(&self) -> Option<&str> {
        self.invisible_notice.as_deref()
    }

    /// The footer's keyword hint and its state.
    pub fn hint(&self) -> Option<(&'static rules::KeywordHint, rules::HintState)> {
        rules::detected_hint(&self.value, &self.dismissed_hints)
    }

    /// The prompt accent for the bound session (`activePromptColor`).
    pub fn prompt_color(&self) -> Option<PromptColor> {
        self.prompt_color.active(self.session_id.as_deref())
    }

    /// `disabled={inputDisabled || bashRunning}` (PromptInput.tsx:2221).
    pub fn input_disabled(&self, view: &SessionView) -> bool {
        !view.ready || self.bash_running
    }

    /// The Send / Queue buttons' `disabled` (PromptInput.tsx:2277).
    pub fn send_button_disabled(&self, view: &SessionView) -> bool {
        !view.ready
            || view.send_disabled
            || (rules::utf16_len(claudius_agent::js::trim(&self.value)) == 0
                && self.images.is_empty())
    }

    /// `promptHistory` (ChatSurface.tsx:2108): the sent prompts with this
    /// session's lifted ones merged in.
    pub fn history(&self, view: &SessionView) -> Vec<String> {
        let lifted = self
            .session_id
            .as_ref()
            .and_then(|id| self.lifted.get(id))
            .map_or(&[][..], Vec::as_slice);
        rules::build_prompt_history(&view.sent, lifted)
    }

    /// Whether a draft PUT is waiting on the debounce.
    pub fn has_pending_draft(&self) -> bool {
        self.pending_draft.is_some()
    }

    // ------------------------------------------------------- plumbing

    fn id(&mut self) -> u64 {
        self.next_id += 1;
        self.next_id
    }

    fn fetch(
        &mut self,
        out: &mut Vec<Out>,
        method: &'static str,
        url: String,
        body: Option<String>,
        then: Req,
    ) {
        let id = FetchId(self.id());
        let headers = if body.is_some() {
            JSON_HEADERS.to_vec()
        } else {
            Vec::new()
        };
        self.fetches.insert(id, then);
        out.push(Out::Fetch(FetchRequest {
            id,
            method,
            url,
            headers,
            body,
        }));
    }

    fn set_timer(&mut self, out: &mut Vec<Out>, kind: Timer, ms: f64) -> TimerId {
        let id = TimerId(self.id());
        self.timers.insert(id, kind);
        out.push(Out::SetTimer { id, ms });
        id
    }

    fn clear_timer(&mut self, out: &mut Vec<Out>, id: Option<TimerId>) {
        if let Some(id) = id
            && self.timers.remove(&id).is_some()
        {
            out.push(Out::ClearTimer { id });
        }
    }

    /// `setValue(next)` with the caret at `caret` (a model write).
    fn set_value(&mut self, next: String, caret: usize) {
        if next != self.value {
            self.dirty = true;
        }
        self.value = next;
        self.caret = caret.min(self.value.len());
        self.text_rev += 1;
    }

    /// `setImages(next)`: a new array, so the save effect's deps change.
    fn set_images(&mut self, next: Vec<AttachedImage>) {
        self.images = next;
        self.dirty = true;
    }

    /// `refreshPickerState(value, caret)` (PromptInput.tsx:1257): U07b
    /// fills it (`slashTokenBeforeCaret`, the `@` and `:emoji` tokens);
    /// until then no menu opens.
    pub fn refresh_picker_state(&mut self, _value: &str, _caret: usize) {
        self.picker = PickerState::default();
    }

    /// `closePickers` (PromptInput.tsx:1291).
    fn close_pickers(&mut self) {
        self.picker = PickerState::default();
    }

    fn delete_draft(&mut self, out: &mut Vec<Out>) {
        if let Some(id) = self.session_id.clone() {
            self.fetch(out, "DELETE", draft_url(&id), None, Req::Ignore);
        }
    }

    /// The effects whose deps changed: the debounced draft save
    /// (PromptInput.tsx:741).
    pub fn commit(&mut self) -> Vec<Out> {
        let mut out = Vec::new();
        self.commit_into(&mut out);
        out
    }

    fn commit_into(&mut self, out: &mut Vec<Out>) {
        // The render-time guard (:687): an injection before the first seed
        // counts as typed, on every render.
        if self.seeded_for.is_none() && self.injection_applied {
            self.user_typed = true;
        }
        if !std::mem::take(&mut self.dirty) {
            return;
        }
        // The previous run's cleanup: `clearTimeout(t)`.
        let old = self.save_timer.take();
        self.clear_timer(out, old);
        let Some(id) = self.session_id.clone() else {
            return;
        };
        if self.seeded_for.as_deref() != Some(id.as_str()) {
            return;
        }
        if !self.user_typed && self.value.is_empty() && self.images.is_empty() {
            return;
        }
        self.pending_draft = Some(PendingDraft {
            session_id: id,
            text: self.value.clone(),
            images: self.images.clone(),
        });
        self.save_timer = Some(self.set_timer(out, Timer::Save, DRAFT_SAVE_MS));
    }

    /// `flushPendingDraft(ref, { unloading })` (pending-draft.ts:78).
    fn flush_pending(&mut self, out: &mut Vec<Out>, unloading: bool) {
        let req = rules::build_draft_flush_request(self.pending_draft.as_ref(), unloading);
        self.pending_draft = None;
        if let Some(r) = req {
            self.fetch(out, r.method, r.url, Some(r.body), Req::Ignore);
        }
    }

    // -------------------------------------------------- session switch

    /// The bound session changed (`sessionId` prop): the render-time reset
    /// (PromptInput.tsx:669), the effects' cleanups (the debounce's
    /// `clearTimeout`, then the pending draft's flush to the session it was
    /// recorded for, :779), then the new session's seed GET (:690) and
    /// ChatSurface's prompt-color load (:307). A no-op for the same id.
    pub fn bind(&mut self, session_id: Option<&str>) -> Vec<Out> {
        let mut out = Vec::new();
        let next = session_id.map(str::to_owned);
        if next == self.session_id && self.last_seen_session == next {
            return out;
        }
        // The render: the reset of everything tied to the old session.
        self.session_id = next.clone();
        self.last_seen_session = next.clone();
        self.user_typed = false;
        self.hist_idx = None;
        self.cleared_draft = None;
        // The commit: the cleanups of the effects keyed on `sessionId`, in
        // declaration order (the seed's `cancelled`, the debounce's
        // `clearTimeout`, the pending draft's flush), ...
        self.fetches
            .retain(|_, r| !matches!(r, Req::Seed(_) | Req::Color(_)));
        let old = self.save_timer.take();
        self.clear_timer(&mut out, old);
        self.flush_pending(&mut out, false);
        // ... then the new runs: the seed GET, the debounced save (which
        // the seed guard normally stops), and ChatSurface's color load.
        if let Some(id) = &next {
            self.fetch(&mut out, "GET", draft_url(id), None, Req::Seed(id.clone()));
        }
        self.dirty = true;
        self.commit_into(&mut out);
        if let Some(id) = next {
            let url = format!("/api/sessions/{id}/prompt-color");
            self.fetch(&mut out, "GET", url, None, Req::Color(id));
        }
        out
    }

    /// The composer goes away (the effects' unmount cleanups); `unloading`
    /// is the page's `pagehide` (the PUT asks for `keepalive`).
    pub fn unmount(&mut self, unloading: bool) -> Vec<Out> {
        let mut out = Vec::new();
        let old = self.save_timer.take();
        self.clear_timer(&mut out, old);
        self.flush_pending(&mut out, unloading);
        let notice = self.notice_timer.take();
        self.clear_timer(&mut out, notice);
        out
    }

    /// `/color`'s optimistic set for the bound session.
    pub fn set_prompt_color(&mut self, color: Option<PromptColor>) {
        if let Some(id) = &self.session_id {
            self.prompt_color.set(id, color);
        }
    }

    // ------------------------------------------------------------ edits

    /// The editor's text changed (`onChange`, PromptInput.tsx:2131): typing,
    /// a paste, cut, undo. `caret` is the editor's after the change;
    /// `composing` is an IME composition in progress.
    pub fn edited(&mut self, next: &str, caret: usize, composing: bool) -> Vec<Out> {
        let mut out = Vec::new();
        self.user_typed = true;
        self.send_failed = None;
        self.hist_idx = None;
        if !composing {
            let before = extract_ordinals(&self.value);
            let after = extract_ordinals(next);
            let dropped: Vec<f64> = before.into_iter().filter(|o| !after.contains(o)).collect();
            if !dropped.is_empty() {
                let kept = self
                    .images
                    .iter()
                    .filter(|im| !dropped.contains(&im.ordinal))
                    .cloned()
                    .collect();
                self.set_images(kept);
                let mut cleaned = next.to_owned();
                for ord in &dropped {
                    cleaned = strip_partial_token(&cleaned, *ord);
                }
                let len = cleaned.len();
                self.set_value(cleaned.clone(), len);
                self.refresh_picker_state(&cleaned, len);
                self.commit_into(&mut out);
                return out;
            }
            // `* ` at a line start becomes `• ` (PromptInput.tsx:2170).
            let grew_by_one = rules::utf16_len(next) == rules::utf16_len(&self.value) + 1;
            if grew_by_one && caret > 0 && next.as_bytes().get(caret - 1) == Some(&b' ') {
                let ls = line_start(next, caret);
                let before_caret = &next[ls.min(caret)..caret];
                let ws = before_caret
                    .char_indices()
                    .find(|(_, c)| !rules::is_js_space(*c))
                    .map_or(before_caret.len(), |(i, _)| i);
                if &before_caret[ws..] == "* " {
                    let indent = &before_caret[..ws];
                    let replaced = format!(
                        "{}{indent}{} {}",
                        &next[..ls],
                        rules::BULLET_GLYPH,
                        &next[caret..]
                    );
                    // `•` is wider than `*` in bytes; the caret stays after it.
                    let at = ls + indent.len() + rules::BULLET_GLYPH.len_utf8() + 1;
                    self.set_value(replaced.clone(), at);
                    self.refresh_picker_state(&replaced, at);
                    self.commit_into(&mut out);
                    return out;
                }
            }
            // The `:shortcode:` auto-complete (:2194) is U07b's.
        }
        if next != self.value {
            self.dirty = true;
        }
        self.value = next.to_owned();
        self.caret = caret.min(self.value.len());
        self.refresh_picker_state(next, caret);
        self.commit_into(&mut out);
        out
    }

    /// `applyEdit(start, end, insert, caretOffset)` (PromptInput.tsx:1324).
    fn apply_edit(&mut self, start: usize, end: usize, insert: &str, caret_offset: usize) {
        let next = format!("{}{insert}{}", &self.value[..start], &self.value[end..]);
        self.user_typed = true;
        let at = start + caret_offset;
        self.set_value(next.clone(), at);
        self.refresh_picker_state(&next, at);
    }

    /// `clearInput` (PromptInput.tsx:991): Ctrl+C when idle, double Esc.
    fn clear_input(&mut self, out: &mut Vec<Out>) {
        if rules::should_stash_cleared_draft(&self.value, self.images.len()) {
            self.cleared_draft = Some(Stash {
                text: self.value.clone(),
                images: self.images.clone(),
            });
            self.pending_draft = None;
            self.delete_draft(out);
            self.user_typed = true;
        }
        self.set_value(String::new(), 0);
        self.set_images(Vec::new());
        self.close_pickers();
        self.ordinal_counter = 0.0;
        self.hist_idx = None;
    }

    /// `applyRecalledText` (PromptInput.tsx:1349).
    fn apply_recalled(&mut self, text: String, recalled: bool) {
        let len = text.len();
        self.set_value(text.clone(), len);
        if recalled {
            self.close_pickers();
        } else {
            self.refresh_picker_state(&text, len);
        }
    }

    /// `recallHistory(dir)` (PromptInput.tsx:1369): whether it took the key.
    fn recall_history(&mut self, up: bool, history: &[String]) -> bool {
        if history.is_empty() {
            return false;
        }
        let mut idx = self.hist_idx;
        if let Some(i) = idx
            && i > history.len() - 1
        {
            idx = Some(history.len() - 1);
        }
        let idx = if up {
            match idx {
                None => {
                    self.stashed_draft = self.value.clone();
                    rules::history_entry_index(history, &self.value).unwrap_or(history.len() - 1)
                }
                Some(i) if i > 0 => i - 1,
                Some(_) => return true,
            }
        } else {
            match idx {
                None => return false,
                Some(i) if i < history.len() - 1 => i + 1,
                Some(_) => {
                    self.hist_idx = None;
                    let draft = self.stashed_draft.clone();
                    self.apply_recalled(draft, false);
                    return true;
                }
            }
        };
        self.hist_idx = Some(idx);
        self.apply_recalled(history[idx].clone(), true);
        true
    }

    fn failed_send_here(&self) -> Option<&FailedSend> {
        self.failed_send
            .as_ref()
            .filter(|f| f.session_id == self.session_id)
    }

    // ------------------------------------------------------------- keys

    /// `onKeyDown` (PromptInput.tsx:1406). `sel` is the editor's selection,
    /// `now_ms` the clock (`performance.now()`), `composing` an IME
    /// composition in progress.
    pub fn key(
        &mut self,
        k: &Key,
        sel: Selection,
        view: &SessionView,
        now_ms: f64,
        composing: bool,
    ) -> KeyOutcome {
        let mut o = KeyOutcome::default();
        if composing {
            return o;
        }
        // Ctrl+C (:1414): interrupt a running turn, else clear the box.
        if k.ctrl && rules::is_letter_key(&k.key, &k.code, k.alt, 'c') && sel.start == sel.end {
            o.handled = true;
            if view.pending {
                o.out.push(Out::Call {
                    token: None,
                    call: SessionCall::Interrupt,
                });
            } else {
                self.clear_input(&mut o.out);
            }
            self.commit_into(&mut o.out);
            return o;
        }
        // Ctrl+Enter (:1436): every queued message, now.
        if k.ctrl && k.key == "Enter" {
            o.handled = true;
            o.out.push(Out::Call {
                token: None,
                call: SessionCall::SendAllQueuedNow,
            });
            return o;
        }
        // Double Escape (:1446).
        if k.key == "Escape" {
            let gap = now_ms - self.last_escape;
            self.last_escape = now_ms;
            if gap < DOUBLE_ESCAPE_MS {
                o.handled = true;
                self.clear_input(&mut o.out);
                self.last_escape = 0.0;
                self.commit_into(&mut o.out);
            }
            return o;
        }
        // Cmd/Ctrl + ↑ / ↓ (:1465): shell-style history.
        if (k.meta || k.ctrl) && (k.key == "ArrowUp" || k.key == "ArrowDown") {
            let history = self.history(view);
            o.handled = self.recall_history(k.key == "ArrowUp", &history);
            self.commit_into(&mut o.out);
            return o;
        }
        // Plain ↑ on an empty box restores a cleared draft (:1474).
        if k.key == "ArrowUp"
            && !k.meta
            && !k.ctrl
            && !k.alt
            && !k.shift
            && rules::can_restore_cleared_draft(&rules::RestoreGate {
                value: &self.value,
                image_count: self.images.len(),
                picker_open: self.picker.open,
                at_active: self.picker.at_query.is_some(),
                emoji_active: self.picker.emoji_query.is_some(),
                browsing_history: self.hist_idx.is_some(),
                has_stash: self.failed_send_here().is_some() || self.cleared_draft.is_some(),
            })
        {
            o.handled = true;
            let d = if self.failed_send_here().is_some() {
                let f = self.failed_send.take().expect("checked");
                self.user_typed = true;
                self.send_failed = None;
                f.stash
            } else {
                self.cleared_draft.take().expect("has_stash")
            };
            self.ordinal_counter =
                rules::ordinal_floor_after_restore(self.ordinal_counter, &d.images);
            let len = d.text.len();
            self.set_value(d.text, len);
            self.set_images(d.images);
            self.commit_into(&mut o.out);
            return o;
        }
        let pickers_quiet = self.picker.at_query.is_none() && self.picker.emoji_query.is_none();
        // Enter (:1529): list continuation, else send (or the first queued
        // message, on an empty box).
        if k.key == "Enter" && (!self.picker.open || !self.picker.slash_at_start) && pickers_quiet {
            let caret = sel.start.min(self.value.len());
            let ls = line_start(&self.value, caret);
            let le = line_end(&self.value, caret);
            let line = self.value.get(ls..le.max(ls)).unwrap_or("").to_owned();
            if let Some(cont) = rules::compute_list_continuation(&line) {
                o.handled = true;
                match cont {
                    rules::ListContinuation::Empty => self.apply_edit(ls, le, "", 0),
                    rules::ListContinuation::Next(next) => {
                        let insert = format!("\n{next}");
                        let n = insert.len();
                        self.apply_edit(caret, caret, &insert, n);
                    }
                }
                self.commit_into(&mut o.out);
                return o;
            }
            if k.shift {
                return o;
            }
            o.handled = true;
            if claudius_agent::js::trim(&self.value).is_empty()
                && self.images.is_empty()
                && let Some(first) = view.queue.first()
            {
                o.out.push(Out::Call {
                    token: None,
                    call: SessionCall::SendQueuedNow {
                        qid: first.id.clone(),
                    },
                });
                return o;
            }
            let mut sent = self.submit(view);
            o.out.append(&mut sent);
            return o;
        }
        // Tab (:1567): indent / outdent a list item.
        if k.key == "Tab" && !self.picker.open && pickers_quiet {
            let caret = sel.start.min(self.value.len());
            let ls = line_start(&self.value, caret);
            let le = line_end(&self.value, caret);
            let line = self.value.get(ls..le.max(ls)).unwrap_or("").to_owned();
            if !rules::is_list_line(&line) {
                o.handled = true;
                o.move_focus = Some(!k.shift);
                return o;
            }
            o.handled = true;
            if k.shift {
                let removed = line.bytes().take(2).take_while(|&b| b == b' ').count();
                if removed == 0 {
                    return o;
                }
                let at = caret.saturating_sub(ls).saturating_sub(removed);
                self.apply_edit(ls, le, &line[removed..], at);
            } else {
                self.apply_edit(ls, ls, "  ", 2 + (caret - ls));
            }
            self.commit_into(&mut o.out);
            return o;
        }
        o
    }

    // ------------------------------------------------------------ send

    /// `submit()` (PromptInput.tsx:1029): Enter, the Send / Queue button.
    pub fn submit(&mut self, view: &SessionView) -> Vec<Out> {
        let mut out = Vec::new();
        if view.send_disabled {
            return out;
        }
        if self.value.starts_with('!') {
            self.submit_bash(&mut out);
            self.commit_into(&mut out);
            return out;
        }
        let strip = rules::strip_invisible_unicode(&self.value);
        if strip.removed_count > 0
            && rules::invisible_strip_needs_review(
                &strip.cleaned,
                strip.bidi_count,
                !self.images.is_empty(),
            )
        {
            let len = strip.cleaned.len();
            self.set_value(strip.cleaned, len);
            out.push(Out::Notice(rules::hidden_chars_notice(
                strip.removed_count,
                true,
                true,
            )));
            self.commit_into(&mut out);
            return out;
        }
        let text = claudius_agent::js::trim(&strip.cleaned).to_owned();
        if text.is_empty() && self.images.is_empty() {
            return out;
        }
        let wire = rules::bullets_to_markdown(&text);
        let sent = Stash {
            text: strip.cleaned.clone(),
            images: self.images.clone(),
        };
        self.send_failed = None;
        let token = self.id();
        self.calls.insert(
            token,
            CallThen::Send {
                session_id: self.session_id.clone(),
                sent,
            },
        );
        out.push(Out::Call {
            token: Some(token),
            call: SessionCall::Send {
                text: wire,
                images: self.images.clone(),
                opts: SendOpts {
                    reports_failure_inline: true,
                    ..SendOpts::default()
                },
            },
        });
        if strip.removed_count > 0 {
            self.note_invisible(&mut out, strip.removed_count, true);
        }
        self.set_value(String::new(), 0);
        self.dismissed_hints.clear();
        self.set_images(Vec::new());
        self.close_pickers();
        self.ordinal_counter = 0.0;
        self.hist_idx = None;
        self.user_typed = false;
        self.pending_draft = None;
        self.delete_draft(&mut out);
        self.commit_into(&mut out);
        out
    }

    /// `noteInvisibleStrip` (PromptInput.tsx:1311).
    fn note_invisible(&mut self, out: &mut Vec<Out>, removed: usize, from_prompt: bool) {
        if removed == 0 {
            return;
        }
        let old = self.notice_timer.take();
        self.clear_timer(out, old);
        self.invisible_notice = Some(rules::hidden_chars_notice(removed, from_prompt, false));
        self.notice_timer = Some(self.set_timer(out, Timer::Notice, NOTICE_MS));
    }

    /// `submitBash` (PromptInput.tsx:918).
    fn submit_bash(&mut self, out: &mut Vec<Out>) {
        if self.session_id.is_none() {
            return;
        }
        let stripped = &self.value[1..];
        let strip = rules::strip_invisible_unicode(stripped);
        if strip.removed_count > 0 {
            self.note_invisible(out, strip.removed_count, false);
        }
        let cmd = claudius_agent::js::trim(&strip.cleaned).to_owned();
        if cmd.is_empty() {
            return;
        }
        if rules::command_needs_sudo(&cmd) {
            self.sudo_prompt = Some(cmd);
            return;
        }
        self.run_bash(out, cmd, None);
    }

    /// `runBashCommand(command, sudoPassword)` (PromptInput.tsx:939).
    fn run_bash(&mut self, out: &mut Vec<Out>, command: String, sudo_password: Option<String>) {
        let Some(id) = self.session_id.clone() else {
            return;
        };
        self.bash_running = true;
        self.set_value(String::new(), 0);
        self.dismissed_hints.clear();
        self.set_images(Vec::new());
        self.close_pickers();
        self.ordinal_counter = 0.0;
        self.hist_idx = None;
        self.user_typed = false;
        self.pending_draft = None;
        self.delete_draft(out);
        let mut body = serde_json::Map::new();
        body.insert("command".into(), json!(command));
        if let Some(p) = sudo_password {
            body.insert("sudoPassword".into(), json!(p));
        }
        let url = format!("/api/sessions/{}/bash", encode_uri_component(&id));
        self.fetch(
            out,
            "POST",
            url,
            Some(Value::Object(body).to_string()),
            Req::Bash,
        );
    }

    /// The sudo modal's Run: the password goes with this one request and
    /// nowhere else.
    pub fn sudo_submit(&mut self, password: &str) -> Vec<Out> {
        let mut out = Vec::new();
        if password.is_empty() {
            return out;
        }
        let Some(cmd) = self.sudo_prompt.take() else {
            return out;
        };
        self.run_bash(&mut out, cmd, Some(password.to_owned()));
        self.commit_into(&mut out);
        out
    }

    /// The sudo modal's Cancel / Esc / click outside: the command stays in
    /// the box.
    pub fn sudo_cancel(&mut self) {
        self.sudo_prompt = None;
    }

    /// `restoreUndelivered` (PromptInput.tsx:1178).
    fn restore_undelivered(
        &mut self,
        out: &mut Vec<Out>,
        origin: Option<String>,
        sent: Stash,
        error: &str,
    ) {
        let placement = rules::place_failed_send(
            origin.as_deref(),
            self.session_id.as_deref(),
            &self.value,
            self.images.len(),
        );
        match placement {
            FailedSendPlacement::SaveToOrigin => {
                let origin = origin.expect("save-to-origin has an origin");
                let url = draft_url(&origin);
                self.fetch(out, "GET", url, None, Req::SaveToOrigin { origin, sent });
            }
            FailedSendPlacement::Stash => {
                self.failed_send = Some(FailedSend {
                    session_id: origin,
                    stash: sent,
                });
                self.send_failed = Some((
                    self.session_id.clone(),
                    rules::send_failed_notice(error, NoticePlacement::Stash).to_owned(),
                ));
            }
            FailedSendPlacement::Restore => {
                self.user_typed = true;
                let len = sent.text.len();
                self.set_value(sent.text, len);
                self.close_pickers();
                if !sent.images.is_empty() {
                    self.ordinal_counter = js_max(self.ordinal_counter, max_ordinal(&sent.images));
                }
                self.set_images(sent.images);
                self.send_failed = Some((
                    self.session_id.clone(),
                    rules::send_failed_notice(error, NoticePlacement::Restore).to_owned(),
                ));
            }
        }
    }

    // ------------------------------------------------- around the box

    /// The Stop button (`onInterrupt`).
    pub fn interrupt(&mut self) -> Vec<Out> {
        vec![Out::Call {
            token: None,
            call: SessionCall::Interrupt,
        }]
    }

    /// A suggestion chip (ChatSurface.tsx:2856): `handleSend(s, undefined,
    /// { fromSuggestion: true })`; the box is untouched.
    pub fn pick_suggestion(&mut self, s: &str) -> Vec<Out> {
        let token = self.id();
        self.calls.insert(token, CallThen::Pick);
        vec![Out::Call {
            token: Some(token),
            call: SessionCall::Send {
                text: s.to_owned(),
                images: Vec::new(),
                opts: SendOpts {
                    reports_failure_inline: true,
                    from_suggestion: true,
                    ..SendOpts::default()
                },
            },
        }]
    }

    /// The queue strip's Edit (`liftQueued`, ChatSurface.tsx:1093).
    pub fn queue_edit(&mut self, qid: &str) -> Vec<Out> {
        let token = self.id();
        self.calls.insert(token, CallThen::Lift);
        vec![Out::Call {
            token: Some(token),
            call: SessionCall::EditQueued { qid: qid.into() },
        }]
    }

    /// Up (`-1`) / Down (`1`).
    pub fn queue_move(&mut self, qid: &str, dir: f64) -> Vec<Out> {
        vec![Out::Call {
            token: None,
            call: SessionCall::ReorderQueued {
                qid: qid.into(),
                dir,
            },
        }]
    }

    pub fn queue_send_now(&mut self, qid: &str) -> Vec<Out> {
        vec![Out::Call {
            token: None,
            call: SessionCall::SendQueuedNow { qid: qid.into() },
        }]
    }

    /// "Send all now" (the strip's header, and the footer's Ctrl+Enter hint).
    pub fn queue_send_all(&mut self) -> Vec<Out> {
        vec![Out::Call {
            token: None,
            call: SessionCall::SendAllQueuedNow,
        }]
    }

    pub fn queue_remove(&mut self, qid: &str) -> Vec<Out> {
        vec![Out::Call {
            token: None,
            call: SessionCall::CancelQueued { qid: qid.into() },
        }]
    }

    /// A replace-mode `draftInjection` (PromptInput.tsx:563): a lifted
    /// queued message, Edit & retry. `recalled` keeps the menus closed.
    pub fn inject(&mut self, text: &str, images: Vec<AttachedImage>, recalled: bool) -> Vec<Out> {
        let mut out = Vec::new();
        self.injection_applied = true;
        if rules::should_stash_cleared_draft(&self.value, self.images.len()) && self.value != text {
            self.cleared_draft = Some(Stash {
                text: self.value.clone(),
                images: self.images.clone(),
            });
        }
        self.set_value(text.to_owned(), text.len());
        if recalled {
            self.close_pickers();
        } else {
            self.refresh_picker_state(text, text.len());
        }
        if !images.is_empty() {
            self.ordinal_counter = js_max(self.ordinal_counter, max_ordinal(&images));
            self.set_images(images);
        } else {
            self.set_images(Vec::new());
        }
        self.commit_into(&mut out);
        out
    }

    /// The footer hint's `· ignore`.
    pub fn dismiss_hint(&mut self) {
        if let Some((h, rules::HintState::Active)) = self.hint()
            && !self.dismissed_hints.contains(&h.id)
        {
            self.dismissed_hints.push(h.id);
        }
    }

    /// The ignored hint's `· undo`.
    pub fn restore_hint(&mut self) {
        if let Some((h, _)) = self.hint() {
            self.dismissed_hints.retain(|id| *id != h.id);
        }
    }

    // --------------------------------------------------------- results

    /// A session call's promise settled with `value` (`None`: the target
    /// dropped it, a rejected promise).
    ///
    /// `now_ms` is `Date.now()` (a lifted message's history timestamp).
    pub fn call_resolved(&mut self, token: u64, value: Option<Value>, now_ms: f64) -> Vec<Out> {
        let mut out = Vec::new();
        let Some(then) = self.calls.remove(&token) else {
            return out;
        };
        match then {
            CallThen::Send { session_id, sent } => {
                let delivery = value
                    .as_ref()
                    .map_or_else(rules::undelivered, rules::send_delivery);
                if let Err(error) = delivery {
                    self.restore_undelivered(&mut out, session_id, sent, &error);
                }
            }
            CallThen::Pick => {}
            CallThen::Lift => {
                let Some(item) = value.filter(|v| !v.is_null()) else {
                    return out;
                };
                let text = item
                    .get("text")
                    .and_then(Value::as_str)
                    .unwrap_or("")
                    .to_owned();
                if let Some(sid) = self.session_id.clone()
                    && !claudius_agent::js::trim(&text).is_empty()
                {
                    self.lifted.entry(sid).or_default().push(LiftedPrompt {
                        text: text.clone(),
                        at: now_ms,
                    });
                }
                let images = draft_images(Some(&item));
                let mut more = self.inject(&text, images, true);
                out.append(&mut more);
                return out;
            }
        }
        self.commit_into(&mut out);
        out
    }

    /// One of the composer's requests settled.
    pub fn fetch_settled(&mut self, id: FetchId, outcome: &FetchOutcome) -> Vec<Out> {
        let mut out = Vec::new();
        let Some(then) = self.fetches.remove(&id) else {
            return out;
        };
        match then {
            Req::Ignore => {}
            Req::Bash => {
                self.bash_running = false;
                self.sudo_prompt = None;
            }
            Req::Seed(for_id) => {
                if self.session_id.as_deref() != Some(for_id.as_str()) {
                    return out;
                }
                match ok_json(outcome) {
                    Err(()) => self.seeded_for = Some(for_id),
                    Ok(data) => {
                        self.seeded_for = Some(for_id);
                        if self.user_typed {
                            return out;
                        }
                        let text = data
                            .as_ref()
                            .and_then(|d| d.get("text"))
                            .and_then(Value::as_str)
                            .unwrap_or("")
                            .to_owned();
                        let imgs = draft_images(data.as_ref());
                        let len = text.len();
                        self.set_value(text.clone(), len);
                        self.refresh_picker_state(&text, len);
                        if !imgs.is_empty() {
                            self.ordinal_counter = js_max(self.ordinal_counter, max_ordinal(&imgs));
                        }
                        self.set_images(imgs);
                    }
                }
            }
            Req::Color(for_id) => {
                if self.session_id.as_deref() != Some(for_id.as_str()) {
                    return out;
                }
                // A failed fetch (or a body that isn't JSON) is caught: the
                // state stays.
                if let Ok(data) = ok_json(outcome) {
                    let color = data
                        .as_ref()
                        .and_then(|d| d.get("color"))
                        .and_then(Value::as_str)
                        .map(str::to_owned);
                    self.prompt_color
                        .loaded(&for_id, data.is_some(), color.as_deref());
                }
            }
            Req::SaveToOrigin { origin, sent } => {
                // `.then(r.ok ? json : null).catch(() => null)`.
                let data = ok_json(outcome).ok().flatten();
                let cur_text = data
                    .as_ref()
                    .and_then(|d| d.get("text"))
                    .and_then(Value::as_str)
                    .unwrap_or("")
                    .to_owned();
                let cur_images = draft_images(data.as_ref());
                let (text, images) =
                    rules::merge_into_draft(&cur_text, &cur_images, &sent.text, &sent.images);
                if let Some(r) = rules::build_draft_flush_request(
                    Some(&PendingDraft {
                        session_id: origin,
                        text,
                        images,
                    }),
                    false,
                ) {
                    self.fetch(&mut out, r.method, r.url, Some(r.body), Req::Ignore);
                }
            }
        }
        self.commit_into(&mut out);
        out
    }

    /// A timer the model armed fired.
    pub fn timer_fired(&mut self, id: TimerId) -> Vec<Out> {
        let mut out = Vec::new();
        match self.timers.remove(&id) {
            Some(Timer::Save) => {
                if self.save_timer == Some(id) {
                    self.save_timer = None;
                }
                if let Some(p) = self.pending_draft.take() {
                    let body = rules::draft_body(&p.text, &p.images);
                    self.fetch(
                        &mut out,
                        "PUT",
                        draft_url(&p.session_id),
                        Some(body),
                        Req::Ignore,
                    );
                }
            }
            Some(Timer::Notice) => {
                if self.notice_timer == Some(id) {
                    self.notice_timer = None;
                }
                self.invisible_notice = None;
            }
            None => {}
        }
        out
    }
}

fn js_max(a: f64, b: f64) -> f64 {
    if a.is_nan() || b.is_nan() {
        f64::NAN
    } else {
        a.max(b)
    }
}

#[cfg(test)]
mod tests;
