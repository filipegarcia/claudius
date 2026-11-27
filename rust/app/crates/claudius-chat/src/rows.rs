//! The transcript's rows: what `MessageList.tsx` renders for a session, as
//! data. [`rows`] reads a [`ChatState`] (what `useSession` returns) and the
//! view's options and gives the list, top to bottom; the view draws one
//! list item per [`Row`]. No GPUI here.
//!
//! Each rule cites the component it comes from. The React list is one
//! scroll container of turns (`<section>`s) holding message `<div>`s, each
//! followed by the system pills anchored to it; the rows flatten that:
//!
//! 1. the top sentinel (`hasMoreAbove`) or "Beginning of conversation"
//!    (more than 20 messages and nothing older),
//! 2. the pills anchored to no message (`afterMessageUuid: ""`),
//! 3. every visible message in chronological order
//!    (`sortMessagesByChronology`, as the hook returns them), each followed
//!    by its own pills,
//! 4. the working row, when a turn is running and no question waits.
//!
//! An empty transcript with nothing older shows the splash or "Catching
//! up…" instead ([`Placeholder`]), with the unanchored pills under it.
//!
//! **Native additions** (not in the React list): text over
//! [`FOLD_BYTES`] folds behind "Show more" (U00a: a row's markdown is laid
//! out in one frame, and a 12–30 KB row cost up to 281 ms), unless it is
//! still streaming or the user expanded it; expansion and every card's
//! open state are keys in [`ViewOptions::toggled`] (the components'
//! `useState`s).

use std::collections::{HashMap, HashSet};
use std::sync::Arc;

use claudius_client::sdk_filters::is_real_user_display_message;
use claudius_client::state::ChatState;
use claudius_client::{DisplayBlock, DisplayMessage, Role, SystemEntry, SystemEntryKind};
use serde_json::Value;

use crate::text::{self, Segment, js_trim, truthy};
use crate::verbose::{self, Verbose};

/// Text longer than this many bytes folds (the U00a spike's `--row-cap`).
pub const FOLD_BYTES: usize = 4096;

/// `useRateLimitWarningPct`'s default threshold (`DEFAULT_PCT`).
pub const RATE_LIMIT_WARNING_PCT: f64 = 50.0;

/// What the view decides on top of the session's state.
#[derive(Clone, Debug, PartialEq)]
pub struct ViewOptions {
    /// The chat's level (`effectiveVerbose`: focus mode forces
    /// ultra-compact).
    pub verbose: Verbose,
    /// `session.catchingUp`: a switched-to session still replaying (U01k's
    /// switch lifecycle; not in `ChatState` yet).
    pub catching_up: bool,
    /// Fold text past this many bytes ([`FOLD_BYTES`]).
    pub fold_bytes: usize,
    /// The rate-limit pill's threshold, percent (Settings).
    pub rate_limit_warning_pct: f64,
    /// Toggle keys the user clicked ([`Toggle::key`]): each inverts its
    /// card's default (open under ultra-verbose, else closed; a bash block
    /// starts open; folded text starts folded).
    pub toggled: HashSet<String>,
}

impl Default for ViewOptions {
    fn default() -> Self {
        ViewOptions {
            verbose: Verbose::Normal,
            catching_up: false,
            fold_bytes: FOLD_BYTES,
            rate_limit_warning_pct: RATE_LIMIT_WARNING_PCT,
            toggled: HashSet::new(),
        }
    }
}

/// A clickable part of a row: its key in [`ViewOptions::toggled`].
#[derive(Clone, Debug, PartialEq, Eq, Hash)]
pub enum Toggle {
    /// "Show more" on a folded text (message uuid, block index).
    Fold(String, usize),
    /// A thinking card (message uuid, block index).
    Thinking(String, usize),
    /// A tool card (message uuid, block index); U06 draws the body.
    Tool(String, usize),
    /// A peer message's header (`PeerMessageHeader`'s toggle).
    Peer(String),
    /// A `!`-mode bash block's header (message uuid, segment index).
    Bash(String, usize),
    /// A pill's expandable body (reminder text, hook stderr, compaction
    /// summary), by entry uuid.
    Pill(String),
}

impl Toggle {
    pub fn key(&self) -> String {
        match self {
            Toggle::Fold(u, i) => format!("fold:{u}:{i}"),
            Toggle::Thinking(u, i) => format!("thinking:{u}:{i}"),
            Toggle::Tool(u, i) => format!("tool:{u}:{i}"),
            Toggle::Peer(u) => format!("peer:{u}"),
            Toggle::Bash(u, i) => format!("bash:{u}:{i}"),
            Toggle::Pill(u) => format!("pill:{u}"),
        }
    }

    /// Whether this toggle is a card whose default follows the level
    /// (cleared when `expand_all` flips, as `ThinkingBlock` / `ToolCall`
    /// re-apply `defaultOpen`).
    pub fn follows_level(key: &str) -> bool {
        key.starts_with("thinking:") || key.starts_with("tool:")
    }
}

/// `transcriptPlaceholder`.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Placeholder {
    /// The scroll list.
    List,
    /// "Catching up…", or "Disconnected — reconnecting…" while the stream
    /// is down.
    CatchingUp { disconnected: bool },
    /// `SplashScreen`.
    Splash,
}

/// The transcript as rows.
#[derive(Clone, Debug, PartialEq)]
pub struct Transcript {
    pub placeholder: Placeholder,
    /// With a placeholder: the unanchored pills under it.
    pub rows: Vec<Row>,
    /// `lastUserUuid`: the chronologically latest real prompt (the list
    /// jumps to the bottom when it changes, after the replay).
    pub last_user_uuid: String,
    /// `replaying`.
    pub replaying: bool,
}

/// One list item.
#[derive(Clone, Debug, PartialEq)]
pub enum Row {
    /// The top sentinel: "Scroll up for older messages", or "Loading older
    /// messages…" while a page is on its way.
    Older {
        loading: bool,
    },
    /// "Beginning of conversation".
    Beginning,
    System(SystemRow),
    /// Shared: a message that didn't change keeps its row between builds
    /// ([`RowBuilder`]).
    User(Arc<UserRow>),
    Assistant(Arc<AssistantRow>),
    /// `WorkingRow`: "Claude is working…", or "Disconnected —
    /// reconnecting…".
    Working {
        disconnected: bool,
    },
}

impl Row {
    /// `==`, without comparing a message row a build kept to itself.
    pub fn same(&self, other: &Row) -> bool {
        match (self, other) {
            (Row::User(a), Row::User(b)) => Arc::ptr_eq(a, b) || a == b,
            (Row::Assistant(a), Row::Assistant(b)) => Arc::ptr_eq(a, b) || a == b,
            _ => self == other,
        }
    }

    /// A stable identity for the list.
    pub fn key(&self) -> String {
        match self {
            Row::Older { .. } => "older".into(),
            Row::Beginning => "beginning".into(),
            Row::System(s) => format!("s:{}", s.uuid),
            Row::User(u) => format!("m:{}", u.uuid),
            Row::Assistant(a) => format!("m:{}", a.uuid),
            Row::Working { .. } => "working".into(),
        }
    }
}

/// A Lucide icon by its lucide-react name (`claudius_gpui_theme::icons`).
pub type IconRef = &'static str;

/// A pill's text tone (the Tailwind class it maps to).
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Tone {
    /// `text-[var(--muted)]`.
    Muted,
    Emerald,
    Sky,
    Amber,
    Violet,
    Red,
}

/// One `SystemPill`.
#[derive(Clone, Debug, PartialEq)]
pub struct SystemRow {
    pub uuid: String,
    pub kind: SystemEntryKind,
    pub pill: Pill,
}

#[derive(Clone, Debug, PartialEq)]
pub enum Pill {
    /// The one-line pill: icon, label, `×count` (over 1), `— detail`.
    Plain {
        icon: IconRef,
        icon_tone: Tone,
        /// `text-amber-400` for a warning-level info line, else muted.
        row_tone: Tone,
        label: String,
        count: Option<f64>,
        detail: Option<String>,
    },
    /// `CompactBoundaryDivider`: a rule with the stats and the summary
    /// toggle.
    Compaction {
        label: String,
        stats: Option<String>,
        detail: Option<String>,
        summary: Option<Arc<str>>,
        expanded: bool,
        /// "Earlier messages aren't loaded…": the resumed transcript's path.
        earlier_saved_in: Option<String>,
    },
    /// `ConversationResetDivider`.
    Reset {
        label: String,
        detail: Option<String>,
        at_ms: Option<f64>,
    },
    /// `RateLimitPill` (headline and reset; the countdown and links are
    /// U06's panel work).
    RateLimit {
        headline: String,
        tone: RateTone,
        resets_at: Option<f64>,
    },
    /// `SystemReminderPill`.
    Reminder {
        title: &'static str,
        body: Arc<str>,
        expanded: bool,
    },
    /// `HookFailurePill`: red, the first lines of stderr under it.
    HookFailure {
        label: String,
        detail: Option<String>,
        stderr: Option<Arc<str>>,
        expanded: bool,
    },
    /// The model-refusal box (the "Edit & retry" lever is the composer's,
    /// U07).
    Refusal {
        label: String,
        detail: Option<String>,
    },
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum RateTone {
    Rejected,
    Warning,
    Plain,
}

/// Folded or not.
#[derive(Clone, Debug, PartialEq)]
pub enum Fold {
    /// Fits, or still streaming.
    Whole,
    /// The shown part (markdown, any fence closed) and how much is hidden.
    Folded {
        shown: Arc<str>,
        hidden_bytes: usize,
    },
    /// The user expanded it ("Show less").
    Expanded,
}

/// `UserMessage`.
#[derive(Clone, Debug, PartialEq)]
pub struct UserRow {
    pub uuid: String,
    /// Dimmed "Sending…" until the model has it.
    pub pending: bool,
    pub created_at: Option<f64>,
    /// The latest prompt (sticky at the top of its turn in React).
    pub pinned: bool,
    /// `PeerMessageHeader`: the one-line preview, and whether it's open.
    pub peer: Option<(String, bool)>,
    pub goal_badge: bool,
    pub suggested_badge: bool,
    /// The body; empty while a peer message is collapsed.
    pub body: Vec<UserSegment>,
    /// The footer row (time) shows.
    pub footer: bool,
    /// Pure `!cmd` echo: no badges, no actions.
    pub pure_bash: bool,
}

#[derive(Clone, Debug, PartialEq)]
pub enum UserSegment {
    /// `InlineUserText` through `<Markdown breaks>` (already prepared as
    /// [`text::user_markdown`]).
    Markdown { text: Arc<str>, fold: Fold },
    /// `InlineUserText`'s plain branch: the text has `[Image #N]` tokens
    /// for attached images (thumbnails are U12's), or is empty.
    Plain { text: Arc<str> },
    /// `BashIOBlock`.
    Bash {
        command: String,
        stdout: String,
        stderr: String,
        open: bool,
    },
}

/// `AssistantMessage`.
#[derive(Clone, Debug, PartialEq)]
pub struct AssistantRow {
    pub uuid: String,
    /// `streamingLive`: streaming and the stream is up (the pulsing dot and
    /// "streaming…").
    pub streaming_live: bool,
    pub aborted: bool,
    /// "Error · server error" (`errorTag` with `_` as spaces).
    pub error_label: Option<String>,
    pub created_at: Option<f64>,
    pub blocks: Vec<AssistantBlock>,
    /// `RateLimitHitPanel` / `OpusHighDemandPanel` (U06's panels).
    pub rate_limit_hit: bool,
    pub opus_high_demand: bool,
}

#[derive(Clone, Debug, PartialEq)]
pub enum AssistantBlock {
    /// `<Markdown math>`; math is raw TeX until U05b.
    Text {
        index: usize,
        text: Arc<str>,
        fold: Fold,
    },
    /// `ThinkingBlock`.
    Thinking {
        index: usize,
        label: &'static str,
        open: bool,
        body: ThinkingBody,
    },
    /// A tool call: one compact row until U06's cards.
    Tool(ToolRow),
}

#[derive(Clone, Debug, PartialEq)]
pub enum ThinkingBody {
    Text(Arc<str>),
    /// The italic note: redacted, still streaming, or no trace.
    Note(&'static str),
}

/// `ToolCall`'s header as one row.
#[derive(Clone, Debug, PartialEq)]
pub struct ToolRow {
    pub index: usize,
    pub id: String,
    pub name: String,
    /// Which card U06 puts here (`TaskBlock`, `WorkflowBlock`, …).
    pub card: ToolCard,
    pub summary: String,
    pub status: ToolStatus,
    pub open: bool,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum ToolCard {
    Tool,
    /// `isSubagentToolName`: `Task` / `Agent`.
    Task,
    Workflow,
    ProposeGoal,
}

/// `ToolCall`'s `status` (without the task-joined and settled cases U06
/// adds).
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum ToolStatus {
    Running,
    Done,
    Error,
    /// Auto mode's check had no usable answer: dim "Not run".
    NotRun,
}

impl ToolStatus {
    pub fn label(self) -> &'static str {
        match self {
            ToolStatus::Running => "running",
            ToolStatus::Done => "done",
            ToolStatus::Error => "error",
            ToolStatus::NotRun => "not run",
        }
    }
}

/// [`rows`] that keeps what didn't change between builds: a message equal
/// to the last build's (and kept the same blocks), under the same options
/// and session-wide inputs, keeps its row; a rebuilt row keeps the `Arc`
/// of any text that didn't change. So a streaming delta rebuilds one row
/// (U00a: the stream must not cost the whole transcript per delta).
#[derive(Default)]
pub struct RowBuilder {
    cache: HashMap<String, Arc<str>>,
    next: HashMap<String, Arc<str>>,
    /// The last build's message rows, in order.
    memo: Vec<Option<Box<Memo>>>,
    /// Where each uuid sits in `memo`, built only when a message moved.
    memo_index: Option<HashMap<String, usize>>,
    memo_next: Vec<Option<Box<Memo>>>,
    /// The next in-order `memo` slot to try.
    cursor: usize,
    inputs: Option<Inputs>,
}

/// A message, its row (none when the level hides it) and what that was
/// built from.
struct Memo {
    message: DisplayMessage,
    /// `isRealUserDisplayMessage` (a regex classification, so kept).
    real: bool,
    kept: Vec<usize>,
    row: Option<Row>,
}

/// The session-wide inputs a message row reads besides its message.
#[derive(PartialEq)]
struct Inputs {
    opts: ViewOptions,
    last_user: String,
    goals: indexmap::IndexSet<String>,
    suggested: indexmap::IndexSet<String>,
    pending_ask: Option<String>,
    disconnected: bool,
}

/// `serde_json` equality, walking objects in order (`preserve_order`): an
/// unchanged object keeps its key order, so this is a straight scan where
/// `Value`'s own `==` looks every key up. Reordered keys read as a change
/// (the row is rebuilt).
fn value_eq(a: &Value, b: &Value) -> bool {
    match (a, b) {
        (Value::Object(x), Value::Object(y)) => {
            x.len() == y.len()
                && x.iter()
                    .zip(y)
                    .all(|((ka, va), (kb, vb))| ka == kb && value_eq(va, vb))
        }
        (Value::Array(x), Value::Array(y)) => {
            x.len() == y.len() && x.iter().zip(y).all(|(p, q)| value_eq(p, q))
        }
        _ => a == b,
    }
}

fn block_eq(a: &DisplayBlock, b: &DisplayBlock) -> bool {
    match (a, b) {
        (
            DisplayBlock::ToolUse {
                id,
                name,
                input,
                result,
                started_at,
            },
            DisplayBlock::ToolUse {
                id: id2,
                name: name2,
                input: input2,
                result: result2,
                started_at: started_at2,
            },
        ) => {
            id == id2
                && name == name2
                && result == result2
                && started_at == started_at2
                && value_eq(input, input2)
        }
        _ => a == b,
    }
}

/// `DisplayMessage`'s `==` with [`block_eq`]. Every field is named, so a
/// field the client adds fails to compile here until it's compared.
fn message_eq(a: &DisplayMessage, b: &DisplayMessage) -> bool {
    let DisplayMessage {
        uuid,
        role,
        blocks,
        streaming,
        pending,
        parent_tool_use_id,
        folded_sdk_uuids,
        images,
        created_at,
        rate_limit_hit,
        opus_high_demand,
        aborted,
        error_tag,
        peer,
    } = a;
    *uuid == b.uuid
        && *role == b.role
        && *streaming == b.streaming
        && *pending == b.pending
        && *created_at == b.created_at
        && blocks.len() == b.blocks.len()
        && blocks.iter().zip(&b.blocks).all(|(x, y)| block_eq(x, y))
        && *parent_tool_use_id == b.parent_tool_use_id
        && *folded_sdk_uuids == b.folded_sdk_uuids
        && *images == b.images
        && *rate_limit_hit == b.rate_limit_hit
        && *opus_high_demand == b.opus_high_demand
        && *aborted == b.aborted
        && *error_tag == b.error_tag
        && *peer == b.peer
}

impl RowBuilder {
    pub fn build(&mut self, state: &ChatState, opts: &ViewOptions) -> Transcript {
        self.cursor = 0;
        self.memo_index = None;
        self.memo_next.clear();
        let out = build(state, opts, self);
        self.cache = std::mem::take(&mut self.next);
        std::mem::swap(&mut self.memo, &mut self.memo_next);
        self.memo_next.clear();
        out
    }

    /// Takes the last build's memo of `uuid`: the next one in order when it
    /// matches (nothing moved), else by lookup.
    fn take_memo(&mut self, uuid: &str) -> Option<Box<Memo>> {
        if let Some(slot) = self.memo.get_mut(self.cursor)
            && slot.as_ref().is_some_and(|m| m.message.uuid == uuid)
        {
            self.cursor += 1;
            return slot.take();
        }
        let memo = &self.memo;
        let index = self.memo_index.get_or_insert_with(|| {
            memo.iter()
                .enumerate()
                .filter_map(|(i, m)| m.as_ref().map(|m| (m.message.uuid.clone(), i)))
                .collect()
        });
        let i = *index.get(uuid)?;
        self.cursor = i + 1;
        self.memo[i].take()
    }

    fn text(&mut self, key: String, text: &str) -> Arc<str> {
        let arc = match self.cache.remove(&key) {
            Some(a) if &*a == text => a,
            _ => Arc::from(text),
        };
        self.next.insert(key, arc.clone());
        arc
    }
}

/// The transcript's rows (see the module docs).
pub fn rows(state: &ChatState, opts: &ViewOptions) -> Transcript {
    RowBuilder::default().build(state, opts)
}

/// `sortMessagesByChronology` over references: a stable sort by
/// `createdAt`, a message without one taking the last time before it.
fn chronological(messages: &[DisplayMessage]) -> Vec<&DisplayMessage> {
    let mut last = f64::NEG_INFINITY;
    let at: Vec<f64> = messages
        .iter()
        .map(|m| match m.created_at {
            Some(t) if t.is_finite() => {
                last = t;
                t
            }
            _ if last == f64::NEG_INFINITY => 0.0,
            _ => last,
        })
        .collect();
    let mut order: Vec<usize> = (0..messages.len()).collect();
    order.sort_by(|&a, &b| {
        at[a]
            .partial_cmp(&at[b])
            .unwrap_or(std::cmp::Ordering::Equal)
            .then(a.cmp(&b))
    });
    order.into_iter().map(|i| &messages[i]).collect()
}

/// `lastUserUuid`: the real prompt with the latest `createdAt` (ties go to
/// the later one), else the last real prompt.
fn last_user_uuid(messages: &[&DisplayMessage], real: &[bool]) -> String {
    let mut best = "";
    let mut best_at = f64::NEG_INFINITY;
    let mut fallback = "";
    for (m, &real) in messages.iter().zip(real) {
        if !real {
            continue;
        }
        fallback = &m.uuid;
        if let Some(at) = m.created_at
            && at >= best_at
        {
            best_at = at;
            best = &m.uuid;
        }
    }
    if best.is_empty() { fallback } else { best }.to_owned()
}

fn build(state: &ChatState, opts: &ViewOptions, b: &mut RowBuilder) -> Transcript {
    let messages = chronological(&state.messages);
    // What's unchanged since the last build.
    let mut memos: Vec<Option<Box<Memo>>> = messages
        .iter()
        .map(|m| {
            b.take_memo(&m.uuid)
                .filter(|memo| message_eq(&memo.message, m))
        })
        .collect();
    let real: Vec<bool> = messages
        .iter()
        .zip(&memos)
        .map(|(m, memo)| match memo {
            Some(memo) => memo.real,
            None => is_real_user_display_message(m),
        })
        .collect();
    let disconnected = state.stream_status == "reconnecting";
    let has_more_above = truthy(state.has_more_above.as_ref());
    let last_user = last_user_uuid(&messages, &real);
    // `groupSystemEntries` over the entries the level keeps.
    let mut grouped: HashMap<&str, Vec<&SystemEntry>> = HashMap::new();
    for e in &state.system_entries {
        if !verbose::is_system_entry_hidden(e.kind, opts.verbose) {
            grouped
                .entry(e.after_message_uuid.as_str())
                .or_default()
                .push(e);
        }
    }
    let pills = |b: &mut RowBuilder, anchor: &str, out: &mut Vec<Row>| {
        for e in grouped.get(anchor).into_iter().flatten() {
            if let Some(pill) = system_row(e, state, opts, b) {
                out.push(Row::System(pill));
            }
        }
    };
    let mut rows = Vec::new();
    let placeholder = if !messages.is_empty() || has_more_above {
        Placeholder::List
    } else if opts.catching_up {
        Placeholder::CatchingUp { disconnected }
    } else {
        Placeholder::Splash
    };
    if placeholder != Placeholder::List {
        pills(b, "", &mut rows);
        return Transcript {
            placeholder,
            rows,
            last_user_uuid: last_user,
            replaying: state.replaying,
        };
    }
    if has_more_above {
        rows.push(Row::Older {
            loading: state.loading_older,
        });
    } else if messages.len() > 20 {
        rows.push(Row::Beginning);
    }
    pills(b, "", &mut rows);
    let pending_ask = state
        .pending_asks
        .first()
        .and_then(|p| p.0.get("toolUseId"))
        .and_then(Value::as_str);
    let inputs = Inputs {
        opts: opts.clone(),
        last_user: last_user.clone(),
        goals: state.goal_uuids.clone(),
        suggested: state.suggested_uuids.clone(),
        pending_ask: pending_ask.map(str::to_owned),
        disconnected,
    };
    let fresh = b.inputs.as_ref() != Some(&inputs);
    if fresh {
        b.inputs = Some(inputs);
    }
    let expand_all = verbose::expand_all(opts.verbose);
    let mut visible = verbose::visible_messages(&messages, opts.verbose)
        .into_iter()
        .peekable();
    for (i, m) in messages.iter().enumerate() {
        let kept = match visible.peek() {
            Some((v, _)) if *v == i => visible.next().map(|(_, kept)| kept),
            _ => None,
        };
        let memo = memos[i].take();
        let memo = match (memo, kept) {
            // Hidden by the level: no row, but the message stays memoized.
            (Some(mut memo), None) => {
                memo.row = None;
                memo
            }
            (Some(memo), Some(kept)) if !fresh && memo.row.is_some() && memo.kept == kept => memo,
            (_, kept) => {
                let row = kept.as_ref().map(|kept| {
                    if m.role == Role::User {
                        Row::User(Arc::new(user_row(m, &last_user, state, opts, b)))
                    } else {
                        Row::Assistant(Arc::new(assistant_row(
                            m,
                            kept,
                            disconnected,
                            pending_ask,
                            expand_all,
                            opts,
                            b,
                        )))
                    }
                });
                Box::new(Memo {
                    message: (*m).clone(),
                    real: real[i],
                    kept: kept.unwrap_or_default(),
                    row,
                })
            }
        };
        if let Some(row) = &memo.row {
            rows.push(row.clone());
            if !grouped.is_empty() {
                pills(b, &m.uuid, &mut rows);
            }
        }
        b.memo_next.push(Some(memo));
    }
    // The working row closes the last turn (or stands alone with no turn),
    // and hides while a question waits: the agent is blocked on the user.
    if state.pending && state.pending_asks.is_empty() {
        rows.push(Row::Working { disconnected });
    }
    Transcript {
        placeholder,
        rows,
        last_user_uuid: last_user,
        replaying: state.replaying,
    }
}

fn toggled(opts: &ViewOptions, t: Toggle) -> bool {
    opts.toggled.contains(&t.key())
}

fn fold(
    opts: &ViewOptions,
    uuid: &str,
    index: usize,
    text: &str,
    streaming: bool,
    b: &mut RowBuilder,
) -> Fold {
    if streaming {
        return Fold::Whole;
    }
    let Some(cut) = text::fold_cut(text, opts.fold_bytes) else {
        return Fold::Whole;
    };
    if toggled(opts, Toggle::Fold(uuid.to_owned(), index)) {
        return Fold::Expanded;
    }
    let shown = text::folded_markdown(text, cut);
    Fold::Folded {
        shown: b.text(format!("fold:{uuid}:{index}"), &shown),
        hidden_bytes: text.len() - cut,
    }
}

fn user_row(
    m: &DisplayMessage,
    last_user: &str,
    state: &ChatState,
    opts: &ViewOptions,
    b: &mut RowBuilder,
) -> UserRow {
    // `message.blocks.map(b => b.kind === "text" ? b.text : "").join("")`.
    let text: String = m.blocks.iter().filter_map(DisplayBlock::as_text).collect();
    let segments = text::bash_segments(&text);
    let has_bash = segments.iter().any(|s| matches!(s, Segment::Bash { .. }));
    let pure_bash = has_bash && segments.iter().all(|s| matches!(s, Segment::Bash { .. }));
    let peer_label = m
        .peer
        .as_ref()
        .map(|p| p.name.clone().unwrap_or_else(|| p.from.clone()));
    let peer = peer_label.filter(|_| !pure_bash).map(|label| {
        let open = toggled(opts, Toggle::Peer(m.uuid.clone()));
        (text::peer_preview(&label, &text), open)
    });
    let show_body = peer.as_ref().is_none_or(|(_, open)| *open);
    let ordinals: Vec<f64> = m.images.iter().flatten().map(|i| i.ordinal).collect();
    let inline = |seg: &str, b: &mut RowBuilder, n: usize| -> UserSegment {
        let has_image = text::image_tokens(seg)
            .into_iter()
            .any(|ord| ordinals.contains(&(ord as f64)));
        if has_image || seg.is_empty() {
            return UserSegment::Plain {
                text: b.text(format!("u:{}:{n}", m.uuid), seg),
            };
        }
        let md = text::user_markdown(seg);
        let fold = fold(opts, &m.uuid, n, &md, false, b);
        UserSegment::Markdown {
            text: b.text(format!("u:{}:{n}", m.uuid), &md),
            fold,
        }
    };
    let mut body = Vec::new();
    if show_body {
        if has_bash {
            for (n, seg) in segments.into_iter().enumerate() {
                body.push(match seg {
                    Segment::Text(t) => inline(&t, b, n),
                    Segment::Bash {
                        command,
                        stdout,
                        stderr,
                    } => UserSegment::Bash {
                        command,
                        stdout,
                        stderr,
                        open: !toggled(opts, Toggle::Bash(m.uuid.clone(), n)),
                    },
                });
            }
        } else {
            body.push(inline(&text, b, 0));
        }
    }
    let goal = state.goal_uuids.contains(&m.uuid);
    let stamp = m.created_at.is_some_and(f64::is_finite);
    UserRow {
        uuid: m.uuid.clone(),
        pending: m.pending == Some(true),
        created_at: m.created_at.filter(|t| t.is_finite()),
        pinned: m.uuid == last_user,
        peer,
        goal_badge: goal && !pure_bash,
        suggested_badge: state.suggested_uuids.contains(&m.uuid) && !goal && !pure_bash,
        body,
        // The footer holds the time, Copy and the rewind actions; the
        // native one draws the time (the actions are U07's).
        footer: show_body && stamp,
        pure_bash,
    }
}

fn assistant_row(
    m: &DisplayMessage,
    kept: &[usize],
    disconnected: bool,
    pending_ask: Option<&str>,
    expand_all: bool,
    opts: &ViewOptions,
    b: &mut RowBuilder,
) -> AssistantRow {
    let streaming = m.streaming == Some(true);
    let mut blocks = Vec::new();
    for &index in kept {
        let block = &m.blocks[index];
        match block {
            DisplayBlock::Text { text } => blocks.push(AssistantBlock::Text {
                index,
                fold: fold(opts, &m.uuid, index, text, streaming, b),
                text: b.text(format!("t:{}:{index}", m.uuid), text),
            }),
            DisplayBlock::Thinking { text, redacted } => {
                let redacted = *redacted == Some(true);
                let has_body = !js_trim(text).is_empty();
                let label = if redacted {
                    "Thinking (encrypted)"
                } else if !has_body && !streaming {
                    "Thinking (no trace)"
                } else {
                    "Thinking"
                };
                let body = if redacted {
                    ThinkingBody::Note(
                        "Reasoning was redacted by the model and is not available to the client. The agent still uses it internally.",
                    )
                } else if has_body {
                    ThinkingBody::Text(b.text(format!("k:{}:{index}", m.uuid), text))
                } else if streaming {
                    ThinkingBody::Note("Streaming the reasoning…")
                } else {
                    ThinkingBody::Note("No readable trace for this turn.")
                };
                let open = expand_all != toggled(opts, Toggle::Thinking(m.uuid.clone(), index));
                blocks.push(AssistantBlock::Thinking {
                    index,
                    label,
                    open,
                    body,
                });
            }
            DisplayBlock::ToolUse {
                id,
                name,
                input,
                result,
                ..
            } => {
                // The live AskUserQuestion's row merges into the inline
                // question form (U08), so it hides while the ask is live.
                if name == "AskUserQuestion" && pending_ask == Some(id.as_str()) {
                    continue;
                }
                let card = match name.as_str() {
                    "Task" | "Agent" => ToolCard::Task,
                    "Workflow" => ToolCard::Workflow,
                    "ProposeGoal" => ToolCard::ProposeGoal,
                    _ => ToolCard::Tool,
                };
                let status = match result {
                    None => ToolStatus::Running,
                    Some(r) if r.is_error == Some(true) && r.not_run == Some(true) => {
                        ToolStatus::NotRun
                    }
                    Some(r) if r.is_error == Some(true) => ToolStatus::Error,
                    Some(_) => ToolStatus::Done,
                };
                blocks.push(AssistantBlock::Tool(ToolRow {
                    index,
                    id: id.clone(),
                    name: name.clone(),
                    card,
                    summary: text::tool_summary(input),
                    status,
                    open: expand_all != toggled(opts, Toggle::Tool(m.uuid.clone(), index)),
                }));
            }
        }
    }
    AssistantRow {
        uuid: m.uuid.clone(),
        streaming_live: streaming && !disconnected,
        aborted: m.aborted == Some(true),
        error_label: m
            .error_tag
            .as_ref()
            .filter(|t| !t.is_empty())
            .map(|t| format!("Error · {}", t.replace('_', " "))),
        created_at: m.created_at.filter(|t| t.is_finite()),
        blocks,
        rate_limit_hit: m.rate_limit_hit.is_some(),
        opus_high_demand: m.opus_high_demand == Some(true),
    }
}

/// `KIND_META`: each kind's icon and tone.
fn kind_meta(kind: SystemEntryKind) -> (IconRef, Tone) {
    use SystemEntryKind as K;
    match kind {
        K::Init => ("Cpu", Tone::Emerald),
        K::HookStarted => ("Webhook", Tone::Sky),
        K::HookResponse => ("CheckCircle2", Tone::Sky),
        K::Status => ("Clock", Tone::Amber),
        K::CompactBoundary => ("GitMerge", Tone::Violet),
        K::RateLimit | K::ApiRetry => ("AlertTriangle", Tone::Amber),
        K::PermissionDenied => ("ShieldAlert", Tone::Red),
        K::ModelFallback => ("Cpu", Tone::Amber),
        K::SystemReminder | K::Notification => ("Bell", Tone::Muted),
        K::ConversationReset => ("Eraser", Tone::Violet),
        K::ModelRefusal => ("ShieldAlert", Tone::Red),
        K::Info => ("Info", Tone::Muted),
    }
}

/// `SystemPill`'s branches, in its order.
fn system_row(
    e: &SystemEntry,
    state: &ChatState,
    opts: &ViewOptions,
    b: &mut RowBuilder,
) -> Option<SystemRow> {
    use SystemEntryKind as K;
    let (icon, base_tone) = kind_meta(e.kind);
    let expanded = toggled(opts, Toggle::Pill(e.uuid.clone()));
    let detail = e.detail.clone().filter(|d| !d.is_empty());
    let pill = match e.kind {
        K::CompactBoundary => Pill::Compaction {
            label: e.label.clone(),
            stats: e.compact_stats.as_ref().and_then(text::compact_stats),
            detail,
            summary: e
                .compact_summary
                .as_deref()
                .filter(|s| !s.is_empty())
                .map(|s| b.text(format!("cs:{}", e.uuid), s)),
            expanded,
            earlier_saved_in: state
                .transcript_path
                .clone()
                .filter(|p| !p.is_empty() && e.after_message_uuid.is_empty()),
        },
        K::ConversationReset => Pill::Reset {
            label: e.label.clone(),
            detail,
            at_ms: e
                .ts
                .as_deref()
                .and_then(claudius_core::js_date::date_parse)
                .map(|t| t as f64),
        },
        K::RateLimit if e.rate_limit.is_some() => {
            let info = e.rate_limit.as_ref()?;
            let status = info.status.as_deref().unwrap_or("allowed");
            // `shouldShowRateLimitPill`: a rejection always shows; a
            // warning shows from the threshold up.
            let shows = status == "rejected"
                || match info.utilization {
                    Some(u) => u * 100.0 >= opts.rate_limit_warning_pct,
                    None => opts.rate_limit_warning_pct <= 0.0,
                };
            if !shows {
                return None;
            }
            let tier = info
                .rate_limit_type
                .as_deref()
                .map_or("limit", rate_limit_tier);
            let pct = info.utilization.map(rate_limit_pct);
            let headline = match (status, pct) {
                ("rejected", _) => format!("You've hit your {tier}"),
                ("allowed_warning", Some(p)) => format!("You've used {p}% of your {tier}"),
                _ => format!("Approaching {tier}"),
            };
            let both_rejected =
                status == "rejected" && info.overage_status.as_deref() == Some("rejected");
            let resets_at = if both_rejected {
                Some(
                    info.resets_at
                        .unwrap_or(0.0)
                        .max(info.overage_resets_at.unwrap_or(0.0)),
                )
                .filter(|t| *t != 0.0 && !t.is_nan())
            } else {
                info.resets_at
            };
            Pill::RateLimit {
                headline,
                tone: match status {
                    "rejected" => RateTone::Rejected,
                    "allowed_warning" => RateTone::Warning,
                    _ => RateTone::Plain,
                },
                resets_at,
            }
        }
        K::SystemReminder if e.reminder_body.as_deref().is_some_and(|s| !s.is_empty()) => {
            let body = e.reminder_body.as_deref().unwrap_or_default();
            Pill::Reminder {
                title: text::system_reminder_title(body),
                body: b.text(format!("rb:{}", e.uuid), body),
                expanded,
            }
        }
        K::HookResponse if e.hook_failed == Some(true) => Pill::HookFailure {
            label: e.label.clone(),
            detail,
            stderr: e
                .hook_stderr
                .as_deref()
                .filter(|s| !s.is_empty())
                .map(|s| b.text(format!("hs:{}", e.uuid), s)),
            expanded,
        },
        K::ModelRefusal => Pill::Refusal {
            label: e.label.clone(),
            detail,
        },
        _ => {
            // A notification is toned by its priority, an info line by its
            // level; a warning-level info line tints the whole row.
            let icon_tone = match (e.kind, e.priority.as_deref(), e.info_level.as_deref()) {
                (K::Notification, Some("high"), _) => Tone::Amber,
                (K::Notification, Some("immediate"), _) => Tone::Red,
                (K::Notification, Some("low" | "medium"), _) => Tone::Muted,
                (K::Info, _, Some("notice")) => Tone::Muted,
                (K::Info, _, Some("suggestion")) => Tone::Sky,
                (K::Info, _, Some("warning")) => Tone::Amber,
                _ => base_tone,
            };
            let row_tone = if e.kind == K::Info && e.info_level.as_deref() == Some("warning") {
                Tone::Amber
            } else {
                Tone::Muted
            };
            Pill::Plain {
                icon,
                icon_tone,
                row_tone,
                label: e.label.clone(),
                count: e.count.filter(|c| *c > 1.0),
                detail,
            }
        }
    };
    Some(SystemRow {
        uuid: e.uuid.clone(),
        kind: e.kind,
        pill,
    })
}

/// `RATE_LIMIT_TYPE_LABEL[type] ?? "limit"`.
fn rate_limit_tier(t: &str) -> &'static str {
    match t {
        "five_hour" => "5-hour limit",
        "seven_day" => "Weekly limit",
        "seven_day_opus" => "Weekly Opus limit",
        "seven_day_sonnet" => "Weekly Sonnet limit",
        "seven_day_overage_included" => "Weekly limit (overage incl.)",
        "overage" => "Extra-usage limit",
        _ => "limit",
    }
}

/// `rateLimitEventPct`: `floor(round(u × 10⁴) / 100)`, clamped to 0–100.
fn rate_limit_pct(u: f64) -> f64 {
    let p = ((u * 1e4).round() / 100.0).floor();
    // `Math.round` is half-up; f64::round is half-away-from-zero, which
    // differs only for negative halves, and the clamp floors those to 0.
    p.clamp(0.0, 100.0)
}

#[cfg(test)]
mod tests;
