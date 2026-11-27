//! [`TranscriptView`]: the transcript on screen. One GPUI `list` item per
//! [`Row`] (virtualized, variable heights: only the rows near the viewport
//! are laid out), its markdown through gpui-component's `TextView` with
//! the parsed states in a [`MarkdownCache`].
//!
//! The view reads its session's `ChatState` from a [`TranscriptSource`]
//! and rebuilds the rows on each change notification (several queued ones
//! coalesce into one rebuild). The list is spliced where the rows changed,
//! so a streaming delta re-lays out only the growing row.
//!
//! **Stick to the bottom** (`MessageList.tsx`'s pin gate): the list follows
//! the tail while the user is at the bottom; a scroll up stops it, and it
//! resumes once they are back at the bottom (GPUI's `FollowMode::Tail`).
//! A new prompt (`lastUserUuid` changing after the replay) jumps to the
//! bottom, as the React list's activation anchor does. "Jump to latest"
//! shows while the list isn't following.

use std::sync::Arc;

use claudius_client::Role;
use claudius_gpui_theme::{ThemeName, code, density, fonts, hsla, icons};
use claudius_theme::chat::ChatSize;
use claudius_theme::{Rgba, Theme as Tokens, color, tailwind};
use futures::StreamExt as _;
use gpui_kit::component::Icon;
use gpui_kit::component::text::{MarkdownExtensions, TextView, TextViewStyle};
use gpui_kit::prelude::FluentBuilder as _;
use gpui_kit::{
    AnyElement, Context, Div, FollowMode, FontWeight, HighlightStyle, Hsla,
    InteractiveElement as _, IntoElement, ListAlignment, ListState, ParentElement as _, Render,
    SharedString, StatefulInteractiveElement as _, Styled as _, Task, Window, div, list, px,
    relative,
};

use crate::markdown::{MarkdownCache, MarkdownStats};
use crate::rows::{
    AssistantBlock, AssistantRow, Fold, Pill, Placeholder, RateTone, Row, RowBuilder, SystemRow,
    ThinkingBody, Toggle, Tone, ToolRow, ToolStatus, Transcript, UserRow, UserSegment, ViewOptions,
};
use crate::source::TranscriptSource;
use crate::verbose::{self, Verbose};

/// Rows laid out past each edge of the viewport.
const OVERDRAW: f32 = 800.;

/// The palette colors and Tailwind steps the rows use.
#[derive(Clone, Copy)]
struct Colors {
    background: Rgba,
    foreground: Rgba,
    panel: Rgba,
    panel_2: Rgba,
    border: Rgba,
    muted: Rgba,
    accent: Rgba,
}

impl Colors {
    fn of(theme: ThemeName) -> Colors {
        let p = Tokens::of(theme).palette;
        Colors {
            background: p.background,
            foreground: p.foreground,
            panel: p.panel,
            panel_2: p.panel_2,
            border: p.border,
            muted: p.muted,
            accent: p.accent,
        }
    }
}

/// A palette color.
fn h(c: Rgba) -> Hsla {
    hsla(c)
}

/// Tailwind's `/N` on a color.
fn a(c: Rgba, pct: f64) -> Hsla {
    hsla(color::with_opacity(c, pct))
}

/// A Tailwind step (`amber-300`).
fn step(name: &str) -> Rgba {
    tailwind::color(name).unwrap_or_else(|| panic!("{name} is a Tailwind step"))
}

fn tone(c: &Colors, t: Tone) -> Hsla {
    match t {
        Tone::Muted => h(c.muted),
        Tone::Emerald => h(step("emerald-400")),
        Tone::Sky => h(step("sky-400")),
        Tone::Amber => h(step("amber-400")),
        Tone::Violet => h(step("violet-400")),
        Tone::Red => h(step("red-400")),
    }
}

fn icon(name: &str, size: f32, color: Hsla) -> Option<Icon> {
    icons::icon(name).map(|i| Icon::new(i).size(px(size)).text_color(color))
}

fn text_px(d: Div, size: f32, line: f32) -> Div {
    d.text_size(px(size)).line_height(px(line))
}

/// `formatMessageTime`'s `short` (and `shortWithSeconds`) in en-US: the
/// time on the day of `now`, else with the date.
pub fn message_stamp(at_ms: f64, now_ms: f64, seconds: bool) -> Option<String> {
    use chrono::{Local, TimeZone as _};
    if !at_ms.is_finite() {
        return None;
    }
    let at = Local.timestamp_millis_opt(at_ms as i64).single()?;
    let now = Local.timestamp_millis_opt(now_ms as i64).single()?;
    let time = if seconds { "%I:%M:%S %p" } else { "%I:%M %p" };
    let fmt = if at.date_naive() == now.date_naive() {
        time.to_owned()
    } else {
        format!("%b %-d, {time}")
    };
    Some(at.format(&fmt).to_string())
}

/// The transcript of one session.
pub struct TranscriptView {
    source: Arc<dyn TranscriptSource>,
    session_id: String,
    theme: ThemeName,
    opts: ViewOptions,
    builder: RowBuilder,
    transcript: Transcript,
    list: ListState,
    md: MarkdownCache,
    ext: MarkdownExtensions,
    /// `lastUserUuid` at the last jump to the bottom.
    anchored_user: Option<String>,
    /// The stamps' "today" (the wall clock when `None`).
    now_ms: Option<f64>,
    style: Option<(ThemeName, u32, TextViewStyle)>,
    rebuilds: usize,
    _listen: Task<()>,
}

impl TranscriptView {
    pub fn new(
        source: Arc<dyn TranscriptSource>,
        session_id: impl Into<String>,
        theme: ThemeName,
        cx: &mut Context<Self>,
    ) -> Self {
        let session_id = session_id.into();
        let mut changes = source.subscribe();
        let id = session_id.clone();
        let listen = cx.spawn(async move |this, cx| {
            while let Some(change) = changes.next().await {
                let mut mine = change.session_id == id;
                // Coalesce what queued meanwhile into one rebuild.
                while let Ok(c) = changes.try_recv() {
                    mine |= c.session_id == id;
                }
                if mine && this.update(cx, |this, cx| this.refresh(cx)).is_err() {
                    break;
                }
            }
        });
        let list = ListState::new(0, ListAlignment::Top, px(OVERDRAW));
        list.set_follow_mode(FollowMode::Tail);
        let this = cx.entity().downgrade();
        list.set_scroll_handler(move |_, _, cx| {
            // Repaint the "Jump to latest" button's state.
            let _ = this.update(cx, |_, cx| cx.notify());
        });
        let mut view = TranscriptView {
            source,
            session_id,
            theme,
            opts: ViewOptions::default(),
            builder: RowBuilder::default(),
            transcript: Transcript {
                placeholder: Placeholder::Splash,
                rows: Vec::new(),
                last_user_uuid: String::new(),
                replaying: false,
            },
            list,
            md: MarkdownCache::default(),
            ext: MarkdownExtensions::default().raw_html(false),
            anchored_user: None,
            now_ms: None,
            style: None,
            rebuilds: 0,
            _listen: listen,
        };
        view.refresh(cx);
        view
    }

    pub fn session_id(&self) -> &str {
        &self.session_id
    }

    pub fn transcript(&self) -> &Transcript {
        &self.transcript
    }

    pub fn list_state(&self) -> &ListState {
        &self.list
    }

    /// Whether the list follows the tail (sticks to the bottom).
    pub fn following(&self) -> bool {
        self.list.is_following_tail()
    }

    pub fn markdown_stats(&self) -> MarkdownStats {
        self.md.stats()
    }

    /// How many times the rows were rebuilt.
    pub fn rebuilds(&self) -> usize {
        self.rebuilds
    }

    pub fn verbose(&self) -> Verbose {
        self.opts.verbose
    }

    pub fn options(&self) -> &ViewOptions {
        &self.opts
    }

    pub fn theme(&self) -> ThemeName {
        self.theme
    }

    pub fn set_theme(&mut self, theme: ThemeName, cx: &mut Context<Self>) {
        if self.theme != theme {
            self.theme = theme;
            cx.notify();
        }
    }

    /// Fixes the stamps' "today" (the screenshots and tests).
    pub fn set_now(&mut self, now_ms: f64, cx: &mut Context<Self>) {
        self.now_ms = Some(now_ms);
        cx.notify();
    }

    /// Changes the level. Cards whose default follows the level forget
    /// their clicks when `expand_all` flips (`ThinkingBlock` / `ToolCall`
    /// re-apply `defaultOpen`).
    pub fn set_verbose(&mut self, level: Verbose, cx: &mut Context<Self>) {
        if level == self.opts.verbose {
            return;
        }
        if verbose::expand_all(level) != verbose::expand_all(self.opts.verbose) {
            self.opts.toggled.retain(|k| !Toggle::follows_level(k));
        }
        self.opts.verbose = level;
        self.refresh(cx);
    }

    /// `session.catchingUp` (U04b's switch lifecycle feeds it).
    pub fn set_catching_up(&mut self, on: bool, cx: &mut Context<Self>) {
        if self.opts.catching_up != on {
            self.opts.catching_up = on;
            self.refresh(cx);
        }
    }

    /// Flips a card, fold or toggle ([`Toggle::key`]).
    pub fn toggle(&mut self, key: String, cx: &mut Context<Self>) {
        if !self.opts.toggled.remove(&key) {
            self.opts.toggled.insert(key);
        }
        self.refresh(cx);
    }

    /// Scrolls to the bottom and follows the tail again.
    pub fn jump_to_latest(&mut self, cx: &mut Context<Self>) {
        self.list.set_follow_mode(FollowMode::Tail);
        cx.notify();
    }

    /// Reads the session again and splices the list where rows changed.
    ///
    /// A reply's text blocks are marked expanded while it streams, so it
    /// doesn't fold under the reader when it finishes ("Show less" folds
    /// it).
    pub fn refresh(&mut self, cx: &mut Context<Self>) {
        let mut built = None;
        let (builder, opts) = (&mut self.builder, &mut self.opts);
        let found = self.source.read(&self.session_id, &mut |state| {
            for m in &state.messages {
                if m.role == Role::Assistant && m.streaming == Some(true) {
                    for i in 0..m.blocks.len() {
                        opts.toggled.insert(Toggle::Fold(m.uuid.clone(), i).key());
                    }
                }
            }
            built = Some(builder.build(state, opts));
        });
        let next = match built {
            Some(t) if found => t,
            _ => Transcript {
                placeholder: Placeholder::Splash,
                rows: Vec::new(),
                last_user_uuid: String::new(),
                replaying: false,
            },
        };
        self.rebuilds += 1;
        let old = std::mem::replace(&mut self.transcript, next);
        self.splice(&old.rows);
        let t = &self.transcript;
        if !t.replaying && Some(&t.last_user_uuid) != self.anchored_user.as_ref() {
            if self.anchored_user.is_some() {
                self.list.set_follow_mode(FollowMode::Tail);
            }
            self.anchored_user = Some(t.last_user_uuid.clone());
        }
        cx.notify();
    }

    fn splice(&mut self, old: &[Row]) {
        let new = &self.transcript.rows;
        if self.list.item_count() != old.len() {
            self.list.reset(new.len());
            return;
        }
        let prefix = old.iter().zip(new).take_while(|(a, b)| a.same(b)).count();
        let suffix = old[prefix..]
            .iter()
            .rev()
            .zip(new[prefix..].iter().rev())
            .take_while(|(a, b)| a.same(b))
            .count();
        let old_range = prefix..old.len() - suffix;
        let count = new.len() - suffix - prefix;
        if old_range.is_empty() && count == 0 {
            return;
        }
        let same_keys = old_range.len() == count
            && old[old_range.clone()]
                .iter()
                .zip(&new[prefix..prefix + count])
                .all(|(a, b)| a.key() == b.key());
        if same_keys {
            self.list.remeasure_items(old_range);
        } else {
            self.list.splice(old_range, count);
        }
    }

    fn md_style(&mut self, text_px: f32) -> TextViewStyle {
        let key = (self.theme, text_px.to_bits());
        if let Some((t, s, style)) = &self.style
            && (*t, *s) == key
        {
            return style.clone();
        }
        let c = Colors::of(self.theme);
        let code_block = fonts::code_style()
            .bg(h(hex(code::CODE_BLOCK_BACKGROUND)))
            .text_color(h(hex(code::FOREGROUND)))
            .border_color(h(c.border))
            .rounded(px(8.))
            .text_size(px(text_px * density::CODE_EM as f32))
            .line_height(relative(1.5));
        let style = TextViewStyle {
            code_block,
            inline_code: HighlightStyle {
                background_color: Some(h(c.panel_2)),
                ..Default::default()
            },
            is_dark: self.theme.is_dark(),
            ..Default::default()
        };
        self.style = Some((key.0, key.1, style.clone()));
        style
    }

    fn markdown(
        &mut self,
        key: String,
        text: &Arc<str>,
        text_px: f32,
        cx: &mut Context<Self>,
    ) -> AnyElement {
        let state = self.md.get(&key, text, cx);
        TextView::new(&state)
            .selectable(true)
            .style(self.md_style(text_px))
            .markdown_extensions(self.ext.clone())
            .w_full()
            .into_any_element()
    }

    fn render_row(&mut self, ix: usize, window: &mut Window, cx: &mut Context<Self>) -> AnyElement {
        let Some(row) = self.transcript.rows.get(ix).cloned() else {
            return div().into_any_element();
        };
        let c = Colors::of(self.theme);
        let (col, text) = density::chat_column(window.viewport_size().width, ChatSize::default());
        let text = f32::from(text);
        let body = match row {
            Row::Older { loading } => centered_note(
                &c,
                if loading {
                    "Loading older messages…"
                } else {
                    "Scroll up for older messages"
                },
                1.0,
            ),
            Row::Beginning => centered_note(&c, "Beginning of conversation", 0.6),
            Row::System(s) => self.system(&s, &c, cx).py(px(4.)),
            Row::User(u) => self.user(&u, &c, text, cx).py(px(8.)),
            Row::Assistant(m) => self.assistant(&m, &c, text, cx).py(px(8.)),
            Row::Working { disconnected } => working(&c, disconnected).py(px(8.)),
        };
        div()
            .w_full()
            .px(px(16.))
            .child(div().mx_auto().w_full().max_w(col).child(body))
            .into_any_element()
    }

    fn stamp(&self, at: Option<f64>) -> Option<String> {
        // `alwaysShowStamp` (the hover reveal is U07's): ultra-verbose.
        if self.opts.verbose != Verbose::UltraVerbose {
            return None;
        }
        let now = self
            .now_ms
            .unwrap_or_else(|| claudius_core::now_ms() as f64);
        message_stamp(at?, now, true)
    }

    fn user(&mut self, u: &UserRow, c: &Colors, text: f32, cx: &mut Context<Self>) -> Div {
        let mut bubble = div()
            .debug_selector(|| "user-bubble".into())
            .max_w(relative(0.8))
            .min_w_0()
            .rounded(px(16.))
            .border_1()
            .border_color(h(c.border))
            .bg(h(c.panel_2))
            .px(px(16.))
            .py(px(8.))
            .text_size(px(text))
            .line_height(px(24.))
            .text_color(h(c.foreground))
            .flex()
            .flex_col()
            .when(u.pending, |d| d.opacity(0.5));
        if u.goal_badge || u.suggested_badge {
            let (name, label, color) = if u.goal_badge {
                ("Target", "GOAL", h(c.accent))
            } else {
                ("Sparkles", "SUGGESTED", h(c.muted))
            };
            bubble = bubble.child(
                text_px(div(), 10., 14.)
                    .mb(px(4.))
                    .flex()
                    .items_center()
                    .justify_end()
                    .gap(px(4.))
                    .text_color(color)
                    .children(icon(name, 12., color))
                    .child(label),
            );
        }
        if let Some((preview, open)) = &u.peer {
            let key = Toggle::Peer(u.uuid.clone()).key();
            bubble = bubble.child(
                div()
                    .id(SharedString::from(format!("peer-{}", u.uuid)))
                    .debug_selector(|| "peer-header".into())
                    .flex()
                    .items_center()
                    .gap(px(6.))
                    .cursor_pointer()
                    .text_size(px(12.))
                    .text_color(h(c.muted))
                    .children(icon("Users", 12., h(c.accent)))
                    .child(div().min_w_0().child(preview.clone()))
                    .child(if *open { "▾" } else { "▸" })
                    .on_click(cx.listener(move |this, _, _, cx| this.toggle(key.clone(), cx))),
            );
        }
        for (n, seg) in u.body.iter().enumerate() {
            let el = match seg {
                UserSegment::Markdown { text: t, fold } => {
                    self.folded_text(&u.uuid, n, "u", t, fold, text, c, cx)
                }
                UserSegment::Plain { text: t } => div()
                    .whitespace_normal()
                    .child(t.to_string())
                    .into_any_element(),
                UserSegment::Bash {
                    command,
                    stdout,
                    stderr,
                    open,
                } => self.bash(&u.uuid, n, command, stdout, stderr, *open, c, cx),
            };
            bubble = bubble.child(el);
        }
        if u.footer
            && let Some(stamp) = self.stamp(u.created_at)
        {
            bubble = bubble.child(
                text_px(div(), 10., 14.)
                    .mt(px(4.))
                    .flex()
                    .justify_end()
                    .font_family(fonts::MONO)
                    .text_color(a(c.muted, 60.))
                    .child(stamp),
            );
        }
        div()
            .debug_selector(|| "user-row".into())
            .flex()
            .justify_end()
            .child(bubble)
    }

    #[allow(clippy::too_many_arguments)]
    fn bash(
        &mut self,
        uuid: &str,
        n: usize,
        command: &str,
        stdout: &str,
        stderr: &str,
        open: bool,
        c: &Colors,
        cx: &mut Context<Self>,
    ) -> AnyElement {
        let key = Toggle::Bash(uuid.to_owned(), n).key();
        let amber = step("amber-500");
        let mono = |d: Div| {
            text_px(d, 12., 18.)
                .font_family(fonts::MONO)
                .whitespace_normal()
        };
        div()
            .debug_selector(|| "bash-block".into())
            .my(px(4.))
            .rounded(px(8.))
            .border_1()
            .border_color(a(amber, 30.))
            .bg(a(hex(code::CODE_BLOCK_BACKGROUND), 40.))
            .flex()
            .flex_col()
            .child(
                mono(div())
                    .id(SharedString::from(format!("bash-{uuid}-{n}")))
                    .flex()
                    .items_center()
                    .gap(px(8.))
                    .px(px(8.))
                    .py(px(4.))
                    .border_b_1()
                    .border_color(a(amber, 20.))
                    .bg(a(amber, 5.))
                    .text_color(h(step("amber-300")))
                    .cursor_pointer()
                    .children(icon("Terminal", 12., h(step("amber-300"))))
                    .child(format!("$ {command}"))
                    .on_click(cx.listener(move |this, _, _, cx| this.toggle(key.clone(), cx))),
            )
            .when(open, |d| {
                let empty = stdout.is_empty() && stderr.is_empty();
                d.child(
                    div()
                        .px(px(8.))
                        .py(px(6.))
                        .when(!stdout.is_empty(), |d| {
                            d.child(
                                mono(div())
                                    .text_color(h(c.foreground))
                                    .child(stdout.to_owned()),
                            )
                        })
                        .when(!stderr.is_empty(), |d| {
                            d.child(
                                mono(div())
                                    .text_color(h(step("red-400")))
                                    .child(stderr.to_owned()),
                            )
                        })
                        .when(empty, |d| {
                            d.child(
                                mono(div())
                                    .italic()
                                    .text_color(h(c.muted))
                                    .child("(no output)"),
                            )
                        }),
                )
            })
            .into_any_element()
    }

    /// A markdown block, folded behind "Show more" past the fold size.
    #[allow(clippy::too_many_arguments)]
    fn folded_text(
        &mut self,
        uuid: &str,
        index: usize,
        kind: &str,
        full: &Arc<str>,
        fold: &Fold,
        text: f32,
        c: &Colors,
        cx: &mut Context<Self>,
    ) -> AnyElement {
        let (key, shown, button) = match fold {
            Fold::Whole => (format!("{kind}:{uuid}:{index}"), full.clone(), None),
            Fold::Expanded => (
                format!("{kind}:{uuid}:{index}"),
                full.clone(),
                Some("Show less".to_owned()),
            ),
            Fold::Folded {
                shown,
                hidden_bytes,
            } => (
                format!("fold:{kind}:{uuid}:{index}"),
                shown.clone(),
                Some(format!("Show more ({})", kb(*hidden_bytes))),
            ),
        };
        let md = self.markdown(key, &shown, text, cx);
        let Some(label) = button else {
            return md;
        };
        let toggle = Toggle::Fold(uuid.to_owned(), index).key();
        div()
            .flex()
            .flex_col()
            .child(md)
            .child(
                div().flex().child(
                    text_px(div(), 11., 16.)
                        .id(SharedString::from(format!("fold-{uuid}-{index}")))
                        .debug_selector(move || {
                            if matches!(label.as_str(), "Show less") {
                                "fold-less".into()
                            } else {
                                "fold-more".into()
                            }
                        })
                        .mt(px(4.))
                        .px(px(8.))
                        .py(px(2.))
                        .rounded(px(6.))
                        .border_1()
                        .border_color(h(c.border))
                        .bg(h(c.panel_2))
                        .text_color(h(c.muted))
                        .cursor_pointer()
                        .hover(|s| s.text_color(h(c.foreground)))
                        .child(match fold {
                            Fold::Folded { hidden_bytes, .. } => {
                                format!("Show more ({})", kb(*hidden_bytes))
                            }
                            _ => "Show less".to_owned(),
                        })
                        .on_click(
                            cx.listener(move |this, _, _, cx| this.toggle(toggle.clone(), cx)),
                        ),
                ),
            )
            .into_any_element()
    }

    fn assistant(
        &mut self,
        m: &AssistantRow,
        c: &Colors,
        text: f32,
        cx: &mut Context<Self>,
    ) -> Div {
        let amber = step("amber-500");
        let red = step("red-500");
        let badge = |label: String, border: Hsla, bg: Hsla, fg: Hsla| {
            text_px(div(), 10., 14.)
                .rounded(px(6.))
                .border_1()
                .border_color(border)
                .bg(bg)
                .px(px(6.))
                .py(px(2.))
                .text_color(fg)
                .child(label)
        };
        let header = text_px(div(), 11., 16.)
            .mb(px(4.))
            .flex()
            .items_center()
            .gap(px(8.))
            .font_weight(FontWeight::MEDIUM)
            .text_color(h(c.muted))
            .child(div().size(px(6.)).rounded_full().bg(h(c.accent)))
            .child("Claude")
            .when(m.streaming_live, |d| {
                d.child(
                    div()
                        .debug_selector(|| "streaming-label".into())
                        .text_size(px(10.))
                        .opacity(0.6)
                        .child("streaming…"),
                )
            })
            .when(m.aborted, |d| {
                d.child(badge(
                    "Interrupted".into(),
                    a(amber, 30.),
                    a(amber, 10.),
                    h(step("amber-300")),
                ))
            })
            .when_some(m.error_label.clone(), |d, label| {
                d.child(badge(label, a(red, 40.), a(red, 10.), h(step("red-300"))))
            })
            .when_some(self.stamp(m.created_at), |d, stamp| {
                d.child(
                    div()
                        .ml_auto()
                        .font_family(fonts::MONO)
                        .text_size(px(10.))
                        .opacity(0.6)
                        .child(stamp),
                )
            });
        let mut body = div()
            .flex()
            .flex_col()
            .gap(px(4.))
            .text_size(px(text))
            .line_height(px(28.))
            .text_color(h(c.foreground))
            .when(m.error_label.is_some(), |d| {
                d.rounded(px(6.))
                    .border_l_2()
                    .border_color(a(red, 50.))
                    .bg(a(red, 5.))
                    .pl(px(12.))
            });
        for b in &m.blocks {
            let el = match b {
                AssistantBlock::Text {
                    index,
                    text: t,
                    fold,
                } => self.folded_text(&m.uuid, *index, "t", t, fold, text, c, cx),
                AssistantBlock::Thinking {
                    index,
                    label,
                    open,
                    body,
                } => thinking(&m.uuid, *index, label, *open, body, c, cx),
                AssistantBlock::Tool(t) => tool(t, c),
            };
            body = body.child(el);
        }
        if m.rate_limit_hit || m.opus_high_demand {
            let label = if m.rate_limit_hit {
                "Rate limit reached"
            } else {
                "Opus is in high demand"
            };
            body = body.child(badge(
                label.into(),
                a(amber, 30.),
                a(amber, 10.),
                h(step("amber-300")),
            ));
        }
        div()
            .debug_selector(|| "assistant-message".into())
            .flex()
            .flex_col()
            .child(header)
            .child(body)
    }

    fn system(&mut self, s: &SystemRow, c: &Colors, cx: &mut Context<Self>) -> Div {
        let key = Toggle::Pill(s.uuid.clone()).key();
        let toggle_id = SharedString::from(format!("pill-{}", s.uuid));
        let base = text_px(div(), 11., 16.).text_color(h(c.muted));
        match &s.pill {
            Pill::Plain {
                icon: name,
                icon_tone,
                row_tone,
                label,
                count,
                detail,
            } => base
                .debug_selector(|| "pill".into())
                .flex()
                .items_center()
                .gap(px(8.))
                .text_color(tone(c, *row_tone))
                .children(icon(name, 12., tone(c, *icon_tone)))
                .child(label.clone())
                .when_some(*count, |d, n| {
                    d.child(
                        text_px(div(), 10., 14.)
                            .rounded_full()
                            .bg(h(c.panel_2))
                            .px(px(6.))
                            .py(px(2.))
                            .opacity(0.8)
                            .child(format!("×{n}")),
                    )
                })
                .when_some(detail.clone(), |d, t| {
                    d.child(div().opacity(0.7).child(format!("— {t}")))
                }),
            Pill::Compaction {
                label,
                stats,
                detail,
                summary,
                expanded,
                earlier_saved_in,
            } => {
                let open = *expanded;
                let line = |c: &Colors| div().h(px(1.)).flex_1().bg(h(c.border));
                base.debug_selector(|| "compaction-divider".into())
                    .my(px(12.))
                    .w_full()
                    .flex()
                    .flex_col()
                    .child(
                        div()
                            .flex()
                            .items_center()
                            .gap(px(12.))
                            .child(line(c))
                            .child(
                                div()
                                    .flex()
                                    .items_center()
                                    .gap(px(8.))
                                    .children(icon("GitMerge", 14., tone(c, Tone::Violet)))
                                    .child(
                                        div().font_weight(FontWeight::MEDIUM).child(label.clone()),
                                    )
                                    .when_some(stats.clone(), |d, t| {
                                        d.child(div().opacity(0.7).child(format!("· {t}")))
                                    })
                                    .when_some(detail.clone(), |d, t| {
                                        d.child(div().opacity(0.7).child(format!("— {t}")))
                                    })
                                    .when(summary.is_some(), |d| {
                                        d.child(
                                            text_px(div(), 10., 14.)
                                                .id(toggle_id.clone())
                                                .rounded(px(4.))
                                                .border_1()
                                                .border_color(h(c.border))
                                                .bg(h(c.panel_2))
                                                .px(px(6.))
                                                .py(px(2.))
                                                .cursor_pointer()
                                                .child(if open {
                                                    "Hide summary"
                                                } else {
                                                    "Show summary"
                                                })
                                                .on_click(cx.listener(move |this, _, _, cx| {
                                                    this.toggle(key.clone(), cx)
                                                })),
                                        )
                                    }),
                            )
                            .child(line(c)),
                    )
                    .when_some(earlier_saved_in.clone(), |d, path| {
                        d.child(
                            text_px(div(), 10., 14.)
                                .mt(px(4.))
                                .flex()
                                .justify_center()
                                .opacity(0.8)
                                .child(format!("Earlier messages aren't loaded. Saved in {path}")),
                        )
                    })
                    .when(open, |d| {
                        d.child(
                            text_px(div(), 11., 20.)
                                .mt(px(8.))
                                .p(px(12.))
                                .rounded(px(6.))
                                .border_1()
                                .border_color(h(c.border))
                                .bg(a(c.panel, 40.))
                                .text_color(a(c.foreground, 80.))
                                .whitespace_normal()
                                .child(summary.as_deref().unwrap_or_default().to_owned()),
                        )
                    })
            }
            Pill::Reset {
                label,
                detail,
                at_ms,
            } => {
                let line = |c: &Colors| div().h(px(1.)).flex_1().bg(h(c.border));
                let stamp = at_ms.and_then(|t| message_stamp(t, self.now_ms.unwrap_or(t), false));
                base.debug_selector(|| "reset-divider".into())
                    .my(px(12.))
                    .flex()
                    .items_center()
                    .gap(px(12.))
                    .child(line(c))
                    .children(icon("Eraser", 14., tone(c, Tone::Violet)))
                    .child(div().font_weight(FontWeight::MEDIUM).child(label.clone()))
                    .when_some(detail.clone(), |d, t| {
                        d.child(div().opacity(0.7).child(format!("— {t}")))
                    })
                    .when_some(stamp, |d, t| d.child(div().opacity(0.6).child(t)))
                    .child(line(c))
            }
            Pill::RateLimit {
                headline,
                tone: t,
                resets_at: _,
            } => {
                let (fg, ic) = match t {
                    RateTone::Rejected => (h(step("red-300")), h(step("red-400"))),
                    RateTone::Warning => (h(step("amber-300")), h(step("amber-400"))),
                    RateTone::Plain => (h(c.muted), h(c.muted)),
                };
                base.debug_selector(|| "rate-limit-pill".into())
                    .flex()
                    .items_center()
                    .gap(px(8.))
                    .text_color(fg)
                    .children(icon("AlertTriangle", 12., ic))
                    .child(headline.clone())
            }
            Pill::Reminder {
                title,
                body,
                expanded,
            } => base
                .debug_selector(|| "reminder-pill".into())
                .flex()
                .flex_col()
                .child(
                    div()
                        .id(toggle_id)
                        .flex()
                        .items_center()
                        .gap(px(8.))
                        .px(px(4.))
                        .py(px(2.))
                        .rounded(px(4.))
                        .cursor_pointer()
                        .hover(|s| s.bg(a(c.panel_2, 40.)))
                        .children(icon("Bell", 12., h(c.muted)))
                        .child(div().opacity(0.9).child("System reminder"))
                        .child(div().opacity(0.6).child(format!("— {title}")))
                        .child(div().opacity(0.5).child(if *expanded { "▾" } else { "▸" }))
                        .on_click(cx.listener(move |this, _, _, cx| this.toggle(key.clone(), cx))),
                )
                .when(*expanded, |d| {
                    d.child(
                        text_px(div(), 10.5, 20.)
                            .ml(px(20.))
                            .mt(px(4.))
                            .p(px(8.))
                            .rounded(px(6.))
                            .border_1()
                            .border_color(h(c.border))
                            .bg(a(c.panel, 40.))
                            .text_color(a(c.foreground, 75.))
                            .whitespace_normal()
                            .child(body.to_string()),
                    )
                }),
            Pill::HookFailure {
                label,
                detail,
                stderr,
                expanded,
            } => {
                let has_stderr = stderr.as_deref().is_some_and(|s| !s.is_empty());
                base.debug_selector(|| "hook-failure-pill".into())
                    .text_color(h(step("red-300")))
                    .flex()
                    .flex_col()
                    .child(
                        div()
                            .id(toggle_id)
                            .flex()
                            .items_center()
                            .gap(px(8.))
                            .px(px(4.))
                            .py(px(2.))
                            .rounded(px(4.))
                            .when(has_stderr, |d| {
                                d.cursor_pointer()
                                    .hover(|s| s.bg(a(step("red-500"), 10.)))
                                    .on_click(cx.listener(move |this, _, _, cx| {
                                        this.toggle(key.clone(), cx)
                                    }))
                            })
                            .children(icon("AlertCircle", 12., h(step("red-400"))))
                            .child(label.clone())
                            .when_some(detail.clone(), |d, t| {
                                d.child(div().opacity(0.7).child(format!("— {t}")))
                            })
                            .when(has_stderr, |d| {
                                d.child(div().opacity(0.5).child(if *expanded {
                                    "▾"
                                } else {
                                    "▸"
                                }))
                            }),
                    )
                    .when(*expanded && has_stderr, |d| {
                        d.child(
                            text_px(div(), 10.5, 18.)
                                .ml(px(20.))
                                .mt(px(4.))
                                .p(px(8.))
                                .rounded(px(6.))
                                .border_1()
                                .border_color(a(step("red-500"), 30.))
                                .bg(a(step("red-500"), 5.))
                                .font_family(fonts::MONO)
                                .whitespace_normal()
                                .child(stderr.as_deref().unwrap_or_default().to_owned()),
                        )
                    })
            }
            Pill::Refusal { label, detail } => base
                .debug_selector(|| "refusal-pill".into())
                .my(px(4.))
                .flex()
                .items_start()
                .gap(px(8.))
                .rounded(px(6.))
                .border_1()
                .border_color(a(step("red-500"), 30.))
                .bg(a(step("red-500"), 5.))
                .px(px(8.))
                .py(px(6.))
                .children(icon("ShieldAlert", 14., h(step("red-400"))))
                .child(
                    div()
                        .min_w_0()
                        .flex_1()
                        .child(div().text_color(h(c.foreground)).child(label.clone()))
                        .when_some(detail.clone(), |d, t| d.child(div().mt(px(2.)).child(t))),
                ),
        }
    }

    fn placeholder(&mut self, c: &Colors, cx: &mut Context<Self>) -> AnyElement {
        let pills: Vec<SystemRow> = self
            .transcript
            .rows
            .iter()
            .filter_map(|r| match r {
                Row::System(s) => Some(s.clone()),
                _ => None,
            })
            .collect();
        let head = match self.transcript.placeholder {
            Placeholder::CatchingUp { disconnected: true } => div()
                .debug_selector(|| "catching-up-disconnected".into())
                .flex()
                .items_center()
                .gap(px(8.))
                .text_size(px(14.))
                .text_color(h(c.muted))
                .children(icon("WifiOff", 14., h(step("amber-300"))))
                .child("Disconnected — reconnecting…"),
            Placeholder::CatchingUp {
                disconnected: false,
            } => div()
                .debug_selector(|| "catching-up".into())
                .text_size(px(14.))
                .text_color(h(c.muted))
                .child("Catching up…"),
            _ => div()
                .debug_selector(|| "splash".into())
                .flex()
                .flex_col()
                .items_center()
                .gap(px(8.))
                .child(
                    div()
                        .text_size(px(30.))
                        .line_height(px(36.))
                        .font_weight(FontWeight::SEMIBOLD)
                        .text_color(h(c.foreground))
                        .child("What are we building?"),
                )
                .child(
                    div()
                        .text_size(px(13.))
                        .text_color(h(c.muted))
                        .child("Start a conversation in the composer."),
                ),
        };
        let mut col = div()
            .flex()
            .flex_1()
            .flex_col()
            .items_center()
            .justify_center()
            .px(px(32.))
            .child(head);
        if !pills.is_empty() {
            let mut list = div().mt(px(24.)).w_full().max_w(px(448.));
            for p in &pills {
                list = list.child(self.system(p, c, cx).py(px(4.)));
            }
            col = col.child(list);
        }
        col.into_any_element()
    }
}

fn hex(s: &str) -> Rgba {
    color::parse(s).unwrap_or_else(|| panic!("{s} is a color"))
}

/// "12.3 KB" for the folded tail.
pub fn kb(bytes: usize) -> String {
    let k = bytes as f64 / 1024.0;
    if k < 10.0 {
        format!("{k:.1} KB")
    } else {
        format!("{} KB", k.round() as u64)
    }
}

fn centered_note(c: &Colors, text: &'static str, opacity: f32) -> Div {
    text_px(div(), 10., 14.)
        .debug_selector(move || {
            if text.starts_with("Beginning") {
                "beginning".into()
            } else {
                "older".into()
            }
        })
        .flex()
        .justify_center()
        .py(px(8.))
        .text_color(h(c.muted))
        .opacity(opacity)
        .child(text)
}

fn working(c: &Colors, disconnected: bool) -> Div {
    let (name, ic, label) = if disconnected {
        (
            "WifiOff",
            h(step("amber-300")),
            "Disconnected — reconnecting…",
        )
    } else {
        ("Loader2", h(c.accent), "Claude is working…")
    };
    text_px(div(), 12., 16.)
        .debug_selector(|| "working-row".into())
        .flex()
        .items_center()
        .gap(px(8.))
        .children(icon(name, 14., ic))
        .child(
            div()
                .font_weight(FontWeight::MEDIUM)
                .text_color(a(c.foreground, 80.))
                .child(label),
        )
}

fn thinking(
    uuid: &str,
    index: usize,
    label: &'static str,
    open: bool,
    body: &ThinkingBody,
    c: &Colors,
    cx: &mut Context<TranscriptView>,
) -> AnyElement {
    let key = Toggle::Thinking(uuid.to_owned(), index).key();
    let redacted = label.starts_with("Redacted");
    div()
        .debug_selector(|| "thinking-card".into())
        .my(px(8.))
        .rounded(px(8.))
        .border_1()
        .border_color(h(c.border))
        .bg(a(c.panel, 50.))
        .flex()
        .flex_col()
        .child(
            text_px(div(), 12., 16.)
                .id(SharedString::from(format!("thinking-{uuid}-{index}")))
                .flex()
                .items_center()
                .gap(px(8.))
                .px(px(12.))
                .py(px(8.))
                .text_color(h(c.muted))
                .cursor_pointer()
                .children(icon(
                    if open { "ChevronDown" } else { "ChevronRight" },
                    14.,
                    h(c.muted),
                ))
                .children(icon(
                    if redacted { "Lock" } else { "Brain" },
                    14.,
                    h(c.muted),
                ))
                .child(label)
                .on_click(cx.listener(move |this, _, _, cx| this.toggle(key.clone(), cx))),
        )
        .when(open, |d| {
            let inner = match body {
                ThinkingBody::Text(t) => div().child(t.to_string()),
                ThinkingBody::Note(n) => div().italic().child(*n),
            };
            d.child(
                text_px(div(), 12., 16.)
                    .border_t_1()
                    .border_color(h(c.border))
                    .px(px(12.))
                    .py(px(8.))
                    .font_family(fonts::MONO)
                    .whitespace_normal()
                    .text_color(h(c.muted))
                    .child(inner),
            )
        })
        .into_any_element()
}

/// U06 draws the cards; until then one compact row: the name, the input's
/// one-line summary and the status.
fn tool(t: &ToolRow, c: &Colors) -> AnyElement {
    let (fg, bg) = match t.status {
        ToolStatus::Running => (step("amber-300"), step("amber-500")),
        ToolStatus::Done => (step("emerald-300"), step("emerald-500")),
        ToolStatus::Error => (step("red-300"), step("red-500")),
        ToolStatus::NotRun => (c.muted, c.muted),
    };
    text_px(div(), 12., 18.)
        .debug_selector(|| "tool-row".into())
        .my(px(2.))
        .flex()
        .items_center()
        .gap(px(8.))
        .rounded(px(6.))
        .border_1()
        .border_color(h(c.border))
        .bg(a(c.panel, 50.))
        .px(px(8.))
        .py(px(4.))
        .children(icon("Wrench", 12., h(c.muted)))
        .child(
            div()
                .flex_none()
                .font_family(fonts::MONO)
                .font_weight(FontWeight::MEDIUM)
                .text_color(h(c.foreground))
                .child(t.name.clone()),
        )
        .child(
            div()
                .flex_1()
                .min_w_0()
                .overflow_hidden()
                .whitespace_nowrap()
                .text_ellipsis()
                .font_family(fonts::MONO)
                .text_color(h(c.muted))
                .child(t.summary.clone()),
        )
        .child(
            text_px(div(), 10., 14.)
                .flex_none()
                .rounded_full()
                .px(px(6.))
                .py(px(1.))
                .bg(a(bg, 15.))
                .text_color(h(fg))
                .child(t.status.label()),
        )
        .into_any_element()
}

impl Render for TranscriptView {
    fn render(&mut self, _window: &mut Window, cx: &mut Context<Self>) -> impl IntoElement {
        let c = Colors::of(self.theme);
        let root = div()
            .debug_selector(|| "transcript".into())
            .relative()
            .flex()
            .flex_col()
            .flex_1()
            .min_h_0()
            .size_full()
            .bg(h(c.background))
            .text_color(h(c.foreground));
        if self.transcript.placeholder != Placeholder::List {
            self.md.evict();
            return root.child(self.placeholder(&c, cx));
        }
        let show_jump =
            !self.list.is_following_tail() && self.list.is_scrolled_to_end() != Some(true);
        let list_el = list(self.list.clone(), cx.processor(Self::render_row))
            .flex_1()
            .min_h_0()
            .w_full()
            .py(px(24.));
        self.md.evict();
        root.child(list_el)
            .child(
                div()
                    .absolute()
                    .top_0()
                    .right_0()
                    .bottom_0()
                    .w(px(12.))
                    .child(gpui_kit::component::scroll::Scrollbar::vertical(&self.list)),
            )
            .when(show_jump, |d| {
                d.child(
                    div()
                        .absolute()
                        .bottom(px(16.))
                        .left_0()
                        .right_0()
                        .flex()
                        .justify_center()
                        .child(
                            text_px(div(), 11., 16.)
                                .id("jump-to-latest")
                                .debug_selector(|| "jump-to-latest".into())
                                .flex()
                                .items_center()
                                .gap(px(4.))
                                .rounded_full()
                                .border_1()
                                .border_color(h(c.border))
                                .bg(h(c.accent))
                                .px(px(12.))
                                .py(px(4.))
                                .font_weight(FontWeight::MEDIUM)
                                .text_color(h(step("white")))
                                .cursor_pointer()
                                .children(icon("ChevronDown", 12., h(step("white"))))
                                .child("Jump to latest")
                                .on_click(cx.listener(|this, _, _, cx| this.jump_to_latest(cx))),
                        ),
                )
            })
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn kb_has_one_decimal_under_ten() {
        assert_eq!(kb(1536), "1.5 KB");
        assert_eq!(kb(20 * 1024 + 700), "21 KB");
    }

    #[test]
    fn stamps_show_the_date_only_on_another_day() {
        let at = 1_795_683_600_000.0;
        let same = message_stamp(at, at + 60_000.0, false).unwrap();
        assert!(!same.contains(','), "{same}");
        assert!(same.ends_with("AM") || same.ends_with("PM"), "{same}");
        let other = message_stamp(at, at + 3.0 * 86_400_000.0, false).unwrap();
        assert!(other.contains(", "), "{other}");
        let secs = message_stamp(at, at, true).unwrap();
        assert_eq!(secs.matches(':').count(), 2, "{secs}");
        assert_eq!(message_stamp(f64::NAN, at, false), None);
    }
}
