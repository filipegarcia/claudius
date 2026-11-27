//! `components/git/CommitBox.tsx`: the message, where it comes from (the
//! persisted draft, else the branch prefix), what enables each button, and
//! the generate → commit → push chain's steps. The page runs the requests;
//! this holds the box's own state.

use crate::types::{js_trim, plural};

/// `comboStep`.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum ComboStep {
    Generate,
    Commit,
    Push,
}

impl ComboStep {
    /// `comboStepLabel`.
    pub fn label(self) -> &'static str {
        match self {
            ComboStep::Generate => "Generating",
            ComboStep::Commit => "Committing",
            ComboStep::Push => "Pushing",
        }
    }
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub struct CommitBox {
    message: String,
    /// Bumped on every change the box makes itself (the view copies the
    /// message into its text area then).
    revision: u64,
    /// The caret goes to the end after a programmatic reset (`resetTick`).
    reset_tick: u64,
    pub error: Option<String>,
    pub generating: bool,
    pub combo_step: Option<ComboStep>,
    cancelled: bool,
    pub cancelling: bool,
    last_reset: (String, String),
    last_prefix: Option<String>,
}

fn initial(initial_message: &str, prefix: Option<&str>) -> String {
    if !initial_message.is_empty() {
        initial_message.to_owned()
    } else {
        prefix.unwrap_or_default().to_owned()
    }
}

impl CommitBox {
    /// `useState(initial)` (CommitBox.tsx:68): the draft, else the prefix.
    pub fn new(draft_key: &str, initial_message: &str, prefix: Option<&str>) -> Self {
        CommitBox {
            message: initial(initial_message, prefix),
            revision: 0,
            reset_tick: 0,
            error: None,
            generating: false,
            combo_step: None,
            cancelled: false,
            cancelling: false,
            last_reset: (draft_key.to_owned(), initial_message.to_owned()),
            last_prefix: prefix.map(str::to_owned),
        }
    }

    pub fn message(&self) -> &str {
        &self.message
    }

    pub fn revision(&self) -> u64 {
        self.revision
    }

    pub fn reset_tick(&self) -> u64 {
        self.reset_tick
    }

    /// The user typed.
    pub fn set_message(&mut self, text: &str) {
        self.message = text.to_owned();
    }

    fn put(&mut self, text: String) {
        self.message = text;
        self.revision += 1;
    }

    /// The props changed (CommitBox.tsx:89): a new draft key or draft
    /// replaces the text (draft, else prefix); a new prefix fills an empty
    /// box. Both read the message as it was before this render, as the
    /// render-phase updates do.
    pub fn sync(&mut self, draft_key: &str, initial_message: &str, prefix: Option<&str>) {
        let before = self.message.clone();
        if self.last_reset.0 != draft_key || self.last_reset.1 != initial_message {
            self.last_reset = (draft_key.to_owned(), initial_message.to_owned());
            let next = initial(initial_message, prefix);
            let reset = !next.is_empty();
            self.put(next);
            if reset {
                self.reset_tick += 1;
            }
        }
        if self.last_prefix.as_deref() != prefix {
            self.last_prefix = prefix.map(str::to_owned);
            if let Some(p) = prefix.filter(|p| !p.is_empty())
                && before.is_empty()
            {
                self.put(p.to_owned());
                self.reset_tick += 1;
            }
        }
    }

    /// `idle` (CommitBox.tsx:162): `busy` is the page's commit.
    pub fn idle(&self, busy: bool) -> bool {
        !busy && !self.generating && self.combo_step.is_none()
    }

    /// `canCommit`: idle, a checked file, a non-blank message.
    pub fn can_commit(&self, busy: bool, checked: usize) -> bool {
        self.idle(busy) && checked > 0 && !js_trim(&self.message).is_empty()
    }

    /// `canGenerate` (the page always passes `onGenerate`).
    pub fn can_generate(&self, busy: bool, checked: usize) -> bool {
        self.idle(busy) && checked > 0
    }

    /// `canCombo` (`onPush` and `onGenerate` are both passed, so a blank
    /// message is fine: it gets generated).
    pub fn can_combo(&self, busy: bool, checked: usize) -> bool {
        self.idle(busy) && checked > 0
    }

    /// The combo button is enabled idle-with-prereqs or mid-flight (as Stop).
    pub fn combo_enabled(&self, busy: bool, checked: usize) -> bool {
        !self.cancelling && (self.combo_step.is_some() || self.can_combo(busy, checked))
    }

    /// `withPrefix` (CommitBox.tsx:217): a generated message gets the
    /// branch prefix unless it already starts with it.
    pub fn with_prefix(generated: &str, prefix: Option<&str>) -> String {
        match prefix.filter(|p| !p.is_empty()) {
            Some(p) if !generated.starts_with(p) => format!("{p}{generated}"),
            _ => generated.to_owned(),
        }
    }

    // ---- submit -----------------------------------------------------------

    /// `submit`: the message to commit, if allowed.
    pub fn begin_submit(&mut self, busy: bool, checked: usize) -> Option<String> {
        if !self.can_commit(busy, checked) {
            return None;
        }
        self.error = None;
        Some(self.message.clone())
    }

    /// The commit answered: cleared on success (the caller then clears the
    /// draft), the error shown otherwise.
    pub fn submitted(&mut self, result: Result<(), String>) {
        match result {
            Ok(()) => self.put(String::new()),
            Err(e) => self.error = Some(e),
        }
    }

    // ---- generate ---------------------------------------------------------

    pub fn begin_generate(&mut self, busy: bool, checked: usize) -> bool {
        if !self.can_generate(busy, checked) {
            return false;
        }
        self.error = None;
        self.generating = true;
        true
    }

    /// The message came back: prefixed into the box; the caller persists it
    /// (`generating` holds until that answers, [`Self::generate_done`]).
    pub fn generated(
        &mut self,
        result: Result<String, String>,
        prefix: Option<&str>,
    ) -> Option<String> {
        match result {
            Ok(m) => {
                let next = Self::with_prefix(&m, prefix);
                self.put(next.clone());
                Some(next)
            }
            Err(e) => {
                self.error = Some(e);
                self.generating = false;
                None
            }
        }
    }

    pub fn generate_done(&mut self) {
        self.generating = false;
    }

    // ---- generate → commit → push -----------------------------------------

    /// `generateCommitAndPush`'s start: the first step (generate when the
    /// box is blank), or `None` when not allowed.
    pub fn begin_combo(&mut self, busy: bool, checked: usize) -> Option<ComboStep> {
        if !self.can_combo(busy, checked) {
            return None;
        }
        self.error = None;
        self.cancelled = false;
        self.cancelling = false;
        let step = if js_trim(&self.message).is_empty() {
            ComboStep::Generate
        } else {
            ComboStep::Commit
        };
        self.combo_step = Some(step);
        Some(step)
    }

    pub fn cancelled(&self) -> bool {
        self.cancelled
    }

    /// The Stop click (`cancelCombo`).
    pub fn cancel_combo(&mut self) {
        self.cancelled = true;
        self.cancelling = true;
    }

    /// The chain is over (its `finally`).
    pub fn end_combo(&mut self) {
        self.combo_step = None;
        self.cancelling = false;
    }

    /// The combo's generated message went in (step 1's tail).
    pub fn combo_generated(&mut self, message: String) {
        self.put(message);
    }

    /// The commit landed (step 2's tail): the box empties.
    pub fn combo_committed(&mut self) {
        self.put(String::new());
    }

    // ---- labels -----------------------------------------------------------

    /// `Commit <n> file(s)` (and ` to <branch>`).
    pub fn header(checked: usize, branch: Option<&str>) -> String {
        let mut s = format!("Commit {checked} file{}", plural(checked));
        if let Some(b) = branch {
            s.push_str(" to ");
            s.push_str(b);
        }
        s
    }

    pub fn placeholder(&self) -> &'static str {
        if self.generating {
            "Generating commit message…"
        } else {
            "Commit message"
        }
    }

    pub fn commit_label(busy: bool) -> &'static str {
        if busy { "Committing…" } else { "Commit" }
    }

    pub fn generate_label(&self) -> &'static str {
        if self.generating {
            "Generating…"
        } else {
            "Generate"
        }
    }

    pub fn generate_title(checked: usize) -> &'static str {
        if checked == 0 {
            "Check files to commit first"
        } else {
            "Ask Claude to draft a commit message from the diff"
        }
    }

    pub fn combo_label(&self) -> String {
        if self.cancelling {
            "Cancelling…".into()
        } else if let Some(s) = self.combo_step {
            format!("{}… · Stop", s.label())
        } else {
            "Commit & Push".into()
        }
    }

    pub fn combo_title(&self, checked: usize) -> String {
        if self.cancelling {
            "Cancelling… waiting for the current step to finish".into()
        } else if let Some(s) = self.combo_step {
            format!("{} — click to stop after this step", s.label())
        } else if checked == 0 {
            "Check files to commit first".into()
        } else if js_trim(&self.message).is_empty() {
            "Generate a commit message, commit, then push (⌘/Ctrl + ⇧ + Enter)".into()
        } else {
            "Commit, then push (⌘/Ctrl + ⇧ + Enter)".into()
        }
    }
}
