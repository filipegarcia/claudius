//! The window: a virtualized transcript (GPUI `list` + gpui-component
//! `TextView` markdown per row, window-level selection across rows) and a
//! composer, plus the gallery tab. `--bench` and `--selftest` drive it.

use std::cell::RefCell;
use std::rc::Rc;
use std::time::{Duration, Instant};

use futures::StreamExt as _;
use gpui_kit::component::{
    ActiveTheme as _,
    button::{Button, ButtonVariants as _},
    h_flex,
    input::{InputEvent, Textarea, TextareaState},
    text::{MarkdownExtensions, TextView, TextViewState},
    v_flex,
};
use gpui_kit::prelude::FluentBuilder as _;
use gpui_kit::*;
use serde_json::{Value, json};

use crate::core_feed::{Cmd, Feed};
use crate::model::{Change, Kind, Transcript};
use crate::stats;

/// `--stateful-rows`: each row owns a `TextViewState` created (and parsed)
/// when the row arrives, instead of a stateless `TextView` that parses when
/// the row first scrolls into view. gpui-component 0.10 has no public way to
/// give a state its markdown extensions up front (the element applies them
/// at layout, which parses again), so this mode renders without the math
/// plugins.
/// `--select-row N`: the row the selftest's drag starts in (default: the
/// first assistant row that opens with a paragraph).
pub static SELECT_ROW: std::sync::OnceLock<usize> = std::sync::OnceLock::new();

pub static STATEFUL_ROWS: std::sync::atomic::AtomicBool = std::sync::atomic::AtomicBool::new(false);

#[derive(Clone, Copy, PartialEq, Eq)]
pub enum Tab {
    Transcript,
    Gallery,
}

#[derive(Clone, Copy, PartialEq, Eq, Debug)]
pub enum Mode {
    Interactive,
    Bench,
    Selftest,
}

/// One painted frame, ms. `cpu` is the main thread's CPU time over the same
/// span as `work` (render start → paint end), so it excludes time the thread
/// spent descheduled on a loaded machine. `top` is the first visible row.
#[derive(Clone, Copy)]
pub struct Frame {
    pub interval: f64,
    pub work: f64,
    pub cpu: f64,
    pub top: usize,
}

/// CPU time consumed by the calling thread, ms.
pub fn thread_cpu_ms() -> f64 {
    let mut ts = libc::timespec {
        tv_sec: 0,
        tv_nsec: 0,
    };
    // SAFETY: writes one timespec.
    unsafe { libc::clock_gettime(libc::CLOCK_THREAD_CPUTIME_ID, &mut ts) };
    ts.tv_sec as f64 * 1000. + ts.tv_nsec as f64 / 1e6
}

/// Frame timestamps written by the end-of-tree canvas.
#[derive(Default)]
pub struct FrameLog {
    pub render_start: Option<Instant>,
    pub render_cpu: f64,
    pub top: usize,
    pub last_paint_end: Option<Instant>,
    pub first_paint: Option<Instant>,
    pub frames: Vec<Frame>,
    pub recording: bool,
    /// Event→pixel latencies (core receipt → paint end), ms.
    pub latencies: Vec<f64>,
    pub pending: Vec<Instant>,
}

#[derive(Clone, Copy, PartialEq, Debug)]
enum Phase {
    Loading,
    Warm(u32),
    Scroll,
    StreamWait,
    Streaming,
    Selftest(u32),
    Done,
}

pub struct Spike {
    pub mode: Mode,
    tab: Tab,
    t: Transcript,
    list: ListState,
    composer: Entity<TextareaState>,
    sends: usize,
    states: Vec<Entity<TextViewState>>,
    cmd: tokio::sync::mpsc::UnboundedSender<Cmd>,
    ext: MarkdownExtensions,
    gallery: Entity<crate::gallery::Gallery>,
    log: Rc<RefCell<FrameLog>>,
    phase: Phase,
    replay_done_at: Option<Instant>,
    transcript_frame_at: Option<Instant>,
    scroll_px: f32,
    scroll_last_top: (usize, f32),
    scroll_stuck: u32,
    scroll_frames: Vec<Frame>,
    scroll_started: Option<Instant>,
    scroll_px_total: f32,
    stream_frames: Vec<Frame>,
    stream_started: Option<Instant>,
    stream_deltas: usize,
    out: serde_json::Map<String, Value>,
    pub refresh: Option<Duration>,
    _feed: Task<()>,
    _subs: Vec<Subscription>,
}

impl Spike {
    pub fn new(
        mode: Mode,
        tab: Tab,
        feed: Feed,
        scroll_px: f32,
        gallery_scroll: f32,
        window: &mut Window,
        cx: &mut Context<Self>,
    ) -> Self {
        let Feed { mut events, cmd } = feed;
        let feed_task = cx.spawn(async move |this, cx| {
            while let Some(batch) = events.next().await {
                if this.update(cx, |this, cx| this.apply(batch, cx)).is_err() {
                    break;
                }
            }
        });
        let composer = cx.new(|cx| {
            TextareaState::new(window, cx)
                .auto_grow(1, 6)
                .placeholder("Message (⌘↩ to send; type `stream` to stream a reply)")
        });
        let sub = cx.subscribe_in(
            &composer,
            window,
            |this: &mut Self, _, ev: &InputEvent, window, cx| {
                if let InputEvent::PressEnter {
                    secondary: true, ..
                } = ev
                {
                    this.send(window, cx);
                }
            },
        );
        let fg = cx.theme().foreground;
        let text_px = f32::from(cx.theme().font_size);
        let ext = MarkdownExtensions::default()
            .plugin(crate::math::InlineMath { color: fg, text_px })
            .plugin(crate::math::BlockMath { color: fg, text_px });
        let gallery = cx.new(|cx| crate::gallery::Gallery::new(ext.clone(), mode, window, cx));
        if tab == Tab::Gallery {
            gallery.update(cx, |g, cx| g.set_visible(true, cx));
        }
        if gallery_scroll > 0. {
            gallery.read(cx).scroll_to(gallery_scroll);
        }
        let list = ListState::new(0, ListAlignment::Top, px(600.));
        list.set_follow_mode(FollowMode::Tail);
        let mut out = serde_json::Map::new();
        out.insert("mode".into(), json!(format!("{mode:?}")));
        Self {
            mode,
            tab,
            t: Transcript::default(),
            list,
            composer,
            sends: 0,
            states: Vec::new(),
            cmd,
            ext,
            gallery,
            log: Rc::new(RefCell::new(FrameLog::default())),
            phase: if mode == Mode::Interactive {
                Phase::Done
            } else {
                Phase::Loading
            },
            replay_done_at: None,
            transcript_frame_at: None,
            scroll_px,
            scroll_last_top: (usize::MAX, 0.),
            scroll_stuck: 0,
            scroll_frames: Vec::new(),
            scroll_started: None,
            scroll_px_total: 0.,
            stream_frames: Vec::new(),
            stream_started: None,
            stream_deltas: 0,
            out,
            refresh: None,
            _feed: feed_task,
            _subs: vec![sub],
        }
    }

    fn send(&mut self, window: &mut Window, cx: &mut Context<Self>) {
        let text = self.composer.read(cx).value().to_string();
        if text.trim().is_empty() {
            return;
        }
        let _ = self.cmd.send(Cmd::Send(text));
        self.sends += 1;
        self.composer
            .update(cx, |s, cx| s.set_value("", window, cx));
        self.list.scroll_to_end();
    }

    fn apply(&mut self, batch: Vec<(Value, Instant)>, cx: &mut Context<Self>) {
        let mut changes = Vec::new();
        let before = self.t.rows.len();
        let mut extended: Vec<usize> = Vec::new();
        for (ev, at) in &batch {
            let n = changes.len();
            self.t.fold(ev, &mut changes);
            for c in &changes[n..] {
                match c {
                    Change::Extended { ix, .. } => {
                        extended.push(*ix);
                        self.log.borrow_mut().pending.push(*at);
                        self.stream_deltas += 1;
                    }
                    Change::Finalized(ix) => extended.push(*ix),
                    Change::ReplayDone => {
                        self.replay_done_at.get_or_insert(Instant::now());
                    }
                    Change::TurnDone => {
                        if matches!(self.phase, Phase::Streaming | Phase::StreamWait) {
                            self.finish_stream();
                        }
                    }
                    Change::Appended => {}
                }
            }
        }
        let after = self.t.rows.len();
        if STATEFUL_ROWS.load(std::sync::atomic::Ordering::Relaxed) {
            for ix in self.states.len()..after {
                let text = self.t.rows[ix].text.clone();
                self.states
                    .push(cx.new(|cx| TextViewState::markdown(&text, cx).selectable(true)));
            }
            for &ix in &extended {
                let text = self.t.rows[ix].text.clone();
                self.states[ix].update(cx, |s, cx| s.set_text(&text, cx));
            }
        }
        if after > before {
            self.list.splice(before..before, after - before);
        }
        extended.sort_unstable();
        extended.dedup();
        for ix in extended {
            if ix < before {
                self.list.remeasure_items(ix..ix + 1);
            }
        }
        cx.notify();
    }

    fn row_text_view(&self, ix: usize) -> TextView {
        if let Some(state) = self.states.get(ix) {
            return TextView::new(state).selectable(true);
        }
        let row = &self.t.rows[ix];
        TextView::markdown(("row", ix), row.text.clone())
            .selectable(true)
            .markdown_extensions(self.ext.clone())
    }

    fn render_row(
        &mut self,
        ix: usize,
        _window: &mut Window,
        cx: &mut Context<Self>,
    ) -> AnyElement {
        let theme = cx.theme();
        let row = &self.t.rows[ix];
        let body = |this: &Self| this.row_text_view(ix);
        let el = match row.kind {
            Kind::User => {
                let inner = if let Some(image) = &row.image {
                    img(image.clone())
                        .max_w(px(420.))
                        .max_h(px(320.))
                        .into_any_element()
                } else {
                    body(self).into_any_element()
                };
                div().px_4().py_2().flex().justify_end().child(
                    div()
                        .max_w(px(640.))
                        .rounded_lg()
                        .bg(theme.secondary)
                        .px_3()
                        .py_2()
                        .child(inner),
                )
            }
            Kind::Assistant => div().px_4().py_2().child(body(self)),
            Kind::Thinking => div()
                .px_4()
                .py_1()
                .text_sm()
                .text_color(theme.muted_foreground)
                .child(body(self)),
            Kind::Tool => div().px_4().py_1().child(
                v_flex()
                    .rounded_md()
                    .border_1()
                    .border_color(theme.border)
                    .child(
                        div()
                            .px_3()
                            .py_1()
                            .text_sm()
                            .bg(theme.muted)
                            .child(row.title.clone().unwrap_or_default()),
                    )
                    .when(!row.text.is_empty(), |d| {
                        d.child(div().px_2().child(body(self)))
                    }),
            ),
            Kind::ToolResult => div()
                .px_4()
                .py_1()
                .text_xs()
                .text_color(theme.muted_foreground)
                .child(body(self)),
            Kind::Meta => div()
                .px_4()
                .py_1()
                .text_xs()
                .text_color(theme.muted_foreground)
                .child(row.text.clone()),
        };
        el.into_any_element()
    }

    // ───────────────────────── bench / selftest driver ─────────────────────────

    fn drive(&mut self, window: &mut Window, cx: &mut Context<Self>) {
        if self.mode == Mode::Interactive || self.phase == Phase::Done {
            return;
        }
        window.request_animation_frame();
        match self.phase {
            Phase::Loading => {
                if let (Some(done), true) =
                    (self.replay_done_at, self.transcript_frame_at.is_none())
                {
                    // This frame shows the fully replayed transcript.
                    self.transcript_frame_at = Some(Instant::now());
                    self.out.insert("rows".into(), json!(self.t.rows.len()));
                    self.out
                        .insert("events_received".into(), json!(self.t.events));
                    self.out
                        .insert("sdk_events".into(), json!(self.t.sdk_events));
                    let start = crate::main_start();
                    self.out
                        .insert("replay_done_ms_after_main".into(), json!(ms(done - start)));
                    self.list.set_follow_mode(FollowMode::Normal);
                    // The selftest's drag starts at the top left, so put an
                    // assistant row there (a user row is a right-aligned bubble).
                    let top = if self.mode == Mode::Selftest {
                        SELECT_ROW.get().copied().unwrap_or_else(|| {
                            // First assistant row that opens with a paragraph.
                            self.t
                                .rows
                                .iter()
                                .position(|r| {
                                    r.kind == Kind::Assistant
                                        && r.text.chars().next().is_some_and(char::is_alphabetic)
                                })
                                .unwrap_or(0)
                        })
                    } else {
                        0
                    };
                    self.list.scroll_to(ListOffset {
                        item_ix: top,
                        offset_in_item: px(0.),
                    });
                    self.phase = if self.mode == Mode::Selftest {
                        Phase::Selftest(0)
                    } else {
                        Phase::Warm(0)
                    };
                }
            }
            Phase::Warm(n) => {
                if n >= 30 {
                    self.phase = Phase::Scroll;
                    self.scroll_started = Some(Instant::now());
                    self.log.borrow_mut().recording = true;
                    self.log.borrow_mut().frames.clear();
                } else {
                    self.phase = Phase::Warm(n + 1);
                }
            }
            Phase::Scroll => {
                let top = self.list.logical_scroll_top();
                let key = (top.item_ix, f32::from(top.offset_in_item));
                if key == self.scroll_last_top {
                    self.scroll_stuck += 1;
                } else {
                    self.scroll_stuck = 0;
                    self.scroll_last_top = key;
                }
                if self.scroll_stuck >= 20 {
                    // Reached the end.
                    let elapsed = self.scroll_started.unwrap().elapsed();
                    let mut log = self.log.borrow_mut();
                    // Drop the 20 stuck frames at the end.
                    let n = log.frames.len().saturating_sub(20);
                    self.scroll_frames = log.frames[..n].to_vec();
                    log.frames.clear();
                    drop(log);
                    self.out
                        .insert("scroll_secs".into(), json!(elapsed.as_secs_f64()));
                    self.out
                        .insert("scroll_px_total".into(), json!(self.scroll_px_total));
                    self.out
                        .insert("scroll_last_item".into(), json!(top.item_ix));
                    self.phase = Phase::StreamWait;
                    self.list.set_follow_mode(FollowMode::Tail);
                    self.list.scroll_to_end();
                    let _ = self
                        .cmd
                        .send(Cmd::Send("stream: the benchmark reply".into()));
                    self.stream_started = Some(Instant::now());
                    self.stream_deltas = 0;
                    self.log.borrow_mut().latencies.clear();
                    self.log.borrow_mut().pending.clear();
                } else {
                    // A trackpad-style pixel scroll through the window's input path.
                    let b = self.list.viewport_bounds();
                    let pos = b.center();
                    let dy = self.scroll_px;
                    self.scroll_px_total += dy;
                    window.on_next_frame(move |window, cx| {
                        window.dispatch_event(
                            PlatformInput::Scroll(ScrollEvent {
                                position: pos,
                                delta: ScrollDelta::Pixels(point(px(0.), px(-dy))),
                                modifiers: Modifiers::default(),
                                touch_phase: TouchPhase::Moved,
                                source: ScrollSource::Pointer,
                            }),
                            cx,
                        );
                    });
                }
            }
            Phase::StreamWait => {
                if self.stream_deltas > 0 {
                    self.phase = Phase::Streaming;
                    self.log.borrow_mut().frames.clear();
                }
            }
            Phase::Streaming => {}
            Phase::Selftest(n) => {
                self.selftest_ime(n, window, cx);
                self.selftest_drag(n, window, cx);
                if n == 60 {
                    let sel = gpui_kit::base::TextSelection::selected_text(window, cx);
                    self.out
                        .insert("selection_chars".into(), json!(sel.chars().count()));
                    self.out.insert(
                        "selection_head".into(),
                        json!(sel.chars().take(120).collect::<String>()),
                    );
                }
                if n == 80 {
                    self.selftest_check(window, cx);
                }
                if n > 80 && (self.gallery.read(cx).probe_done() || n >= 2400) {
                    self.selftest_finish(cx);
                    return;
                }
                self.phase = Phase::Selftest(n + 1);
            }
            Phase::Done => {}
        }
    }

    fn finish_stream(&mut self) {
        let elapsed = self.stream_started.map(|s| s.elapsed()).unwrap_or_default();
        let mut log = self.log.borrow_mut();
        self.stream_frames = std::mem::take(&mut log.frames);
        self.out
            .insert("stream_secs".into(), json!(elapsed.as_secs_f64()));
        self.out
            .insert("stream_deltas".into(), json!(self.stream_deltas));
        self.out
            .insert("stream_latency_ms".into(), stats::summary(&log.latencies));
        drop(log);
        self.phase = Phase::Done;
    }

    fn report(&mut self, cx: &mut Context<Self>) {
        let refresh_ms = self
            .refresh
            .map(|d| d.as_secs_f64() * 1000.)
            .unwrap_or(f64::NAN);
        self.out
            .insert("refresh_hz".into(), json!(1000. / refresh_ms));
        for (key, frames) in [
            ("scroll", &self.scroll_frames),
            ("stream", &self.stream_frames),
        ] {
            let pairs: Vec<(f64, f64)> = frames.iter().map(|f| (f.interval, f.work)).collect();
            let mut v = stats::frames(&pairs, refresh_ms);
            let cpu: Vec<f64> = frames.iter().map(|f| f.cpu).collect();
            v["work_cpu_ms"] = stats::summary(&cpu);
            v["work_cpu_over_budget"] = json!(cpu.iter().filter(|c| **c > refresh_ms).count());
            // The ten slowest frames: where they were (row index, kind and
            // text length of the first visible rows; no content).
            let mut slow: Vec<&Frame> = frames.iter().collect();
            slow.sort_by(|a, b| {
                b.cpu
                    .partial_cmp(&a.cpu)
                    .unwrap_or(std::cmp::Ordering::Equal)
            });
            v["slowest"] = json!(
                slow.iter()
                    .take(10)
                    .map(|f| {
                        let rows: Vec<Value> = (f.top..(f.top + 4).min(self.t.rows.len()))
                            .map(|ix| json!([ix, format!("{:?}", self.t.rows[ix].kind), self.t.rows[ix].text.len()]))
                            .collect();
                        json!({"work": (f.work * 100.).round() / 100., "cpu": (f.cpu * 100.).round() / 100., "rows": rows})
                    })
                    .collect::<Vec<_>>()
            );
            self.out.insert(key.into(), v);
        }
        let log = self.log.borrow();
        let start = crate::main_start();
        if let Some(fp) = log.first_paint {
            self.out
                .insert("first_frame_ms_after_main".into(), json!(ms(fp - start)));
        }
        if let Some(t) = self.transcript_frame_at {
            self.out.insert(
                "transcript_frame_ms_after_main".into(),
                json!(ms(t - start)),
            );
        }
        drop(log);
        self.out
            .insert("exec_to_main_ms".into(), json!(crate::exec_to_main_ms()));
        self.out.insert("mem".into(), stats::memory());
        self.out.insert("load_avg".into(), stats::load_avg());
        self.out.insert("thermal".into(), stats::thermal());
        println!("BENCH_JSON {}", Value::Object(self.out.clone()));
        let _ = self.cmd.send(Cmd::Quit);
        cx.quit();
    }

    // IME, at the component boundary: the calls macOS's NSTextInputClient
    // bridge makes for a Japanese preedit ("nihongo" → にほんご), a
    // conversion (→ 日本語) and the commit, straight into the composer's
    // `EntityInputHandler`. The OS IME itself (candidate window, marked-text
    // underline) is a manual check.
    fn selftest_ime(&mut self, n: u32, window: &mut Window, cx: &mut Context<Self>) {
        let composer = self.composer.clone();
        let rec = match n {
            20 => {
                composer.update(cx, |s, cx| s.focus(window, cx));
                return;
            }
            22 | 24 | 26 => {
                let (key, value, marked) = composer.update(cx, |s, cx| {
                    let key = match n {
                        22 => {
                            s.replace_and_mark_text_in_range(
                                None,
                                "にほんご",
                                Some(4..4),
                                window,
                                cx,
                            );
                            "preedit"
                        }
                        24 => {
                            s.replace_and_mark_text_in_range(
                                None,
                                "日本語",
                                Some(3..3),
                                window,
                                cx,
                            );
                            "convert"
                        }
                        _ => {
                            s.replace_text_in_range(None, "日本語", window, cx);
                            "commit"
                        }
                    };
                    (key, s.value().to_string(), s.marked_text_range(window, cx))
                });
                json!({"step": key, "value": value, "marked_utf16": marked.map(|r| [r.start, r.end])})
            }
            28 => {
                let caret = composer.update(cx, |s, cx| {
                    let b = Bounds::new(point(px(0.), px(0.)), size(px(600.), px(40.)));
                    s.bounds_for_range(0..3, b, window, cx)
                });
                composer.update(cx, |s, cx| s.set_value("", window, cx));
                // Nothing else sends before frame 28 in a selftest, so any
                // send would have come from the IME commit.
                json!({"step": "after", "candidate_bounds_some": caret.is_some(), "sends": self.sends})
            }
            _ => return,
        };
        let entry = self
            .out
            .entry("ime_component_path")
            .or_insert_with(|| json!([]));
        if let Some(a) = entry.as_array_mut() {
            a.push(rec);
        }
    }

    // Selection across messages + copy, through the window's input path:
    // hover, press, ten drag moves and a release, one per frame like a user.
    fn selftest_drag(&mut self, n: u32, window: &mut Window, cx: &mut Context<Self>) {
        let b = self.list.viewport_bounds();
        let from = point(b.origin.x + px(24.), b.origin.y + px(12.));
        let to = point(
            b.origin.x + b.size.width * 0.6,
            b.origin.y + b.size.height * 0.7,
        );
        let ev = match n {
            38 => {
                window.blur(cx);
                self.out.insert(
                    "select_drag".into(),
                    json!({"from": [f32::from(from.x), f32::from(from.y)], "to": [f32::from(to.x), f32::from(to.y)]}),
                );
                let top = self.list.logical_scroll_top();
                self.out
                    .insert("select_first_row".into(), json!(top.item_ix));
                PlatformInput::MouseMove(MouseMoveEvent {
                    position: from,
                    pressed_button: None,
                    modifiers: Modifiers::default(),
                })
            }
            40 => PlatformInput::MouseDown(MouseDownEvent {
                button: MouseButton::Left,
                position: from,
                modifiers: Modifiers::default(),
                click_count: 1,
                first_mouse: false,
            }),
            41..=50 => {
                let f = (n - 40) as f32 / 10.;
                PlatformInput::MouseMove(MouseMoveEvent {
                    position: point(from.x + (to.x - from.x) * f, from.y + (to.y - from.y) * f),
                    pressed_button: Some(MouseButton::Left),
                    modifiers: Modifiers::default(),
                })
            }
            51 => PlatformInput::MouseUp(MouseUpEvent {
                button: MouseButton::Left,
                position: to,
                modifiers: Modifiers::default(),
                click_count: 1,
            }),
            _ => return,
        };
        window.on_next_frame(move |window, cx| {
            window.dispatch_event(ev, cx);
        });
    }

    fn selftest_check(&mut self, window: &mut Window, cx: &mut Context<Self>) {
        // The check goes through the real pasteboard; put the user's back after.
        let saved = cx.read_from_clipboard();
        cx.write_to_clipboard(ClipboardItem::new_string("<<before-copy>>".into()));
        let handled = window.dispatch_keystroke(Keystroke::parse("cmd-c").unwrap(), cx);
        let clip = cx
            .read_from_clipboard()
            .and_then(|c| c.text())
            .unwrap_or_default();
        // And from outside the process, as a user's paste would see it.
        let pb = std::process::Command::new("/usr/bin/pbpaste")
            .output()
            .map(|o| String::from_utf8_lossy(&o.stdout).to_string())
            .unwrap_or_default();
        self.out
            .insert("pbpaste_matches_clipboard".into(), json!(pb == clip));
        // Which rows does the copied text come from?
        let top = self
            .out
            .get("select_first_row")
            .and_then(Value::as_u64)
            .unwrap_or(0) as usize;
        let mut hit_rows = Vec::new();
        for ix in top..(top + 12).min(self.t.rows.len()) {
            let probe: String = self.t.rows[ix]
                .text
                .lines()
                .map(str::trim)
                .find(|l| l.len() > 12 && !l.starts_with("```") && !l.starts_with('|'))
                .unwrap_or("")
                .chars()
                .filter(|c| c.is_alphanumeric() || *c == ' ')
                .take(12)
                .collect();
            let flat: String = clip
                .chars()
                .filter(|c| c.is_alphanumeric() || *c == ' ')
                .collect();
            if probe.len() >= 8 && flat.contains(probe.trim()) {
                hit_rows.push(ix);
            }
        }
        self.out
            .insert("copy_keystroke_handled".into(), json!(handled));
        self.out
            .insert("clipboard_chars".into(), json!(clip.chars().count()));
        self.out.insert(
            "clipboard_head".into(),
            json!(clip.chars().take(160).collect::<String>()),
        );
        self.out
            .insert("clipboard_rows_matched".into(), json!(hit_rows));
        self.out.insert(
            "selection_across_messages".into(),
            json!(clip != "<<before-copy>>" && hit_rows.len() >= 2),
        );
        if let Some(saved) = saved {
            cx.write_to_clipboard(saved);
        }
        // Switch to the gallery so the WebView sandbox probe runs.
        self.tab = Tab::Gallery;
        self.gallery.update(cx, |g, cx| g.set_visible(true, cx));
        cx.notify();
    }

    fn selftest_finish(&mut self, cx: &mut Context<Self>) {
        let g = self.gallery.read(cx);
        self.out.insert("webview".into(), g.probe_report());
        self.out.insert("math".into(), g.math_report());
        self.phase = Phase::Done;
        let _ = self.cmd.send(Cmd::Quit);
        println!("SELFTEST_JSON {}", Value::Object(self.out.clone()));
        cx.quit();
    }
}

fn ms(d: Duration) -> f64 {
    d.as_secs_f64() * 1000.
}

impl Render for Spike {
    fn render(&mut self, window: &mut Window, cx: &mut Context<Self>) -> impl IntoElement {
        let render_start = Instant::now();
        {
            let mut l = self.log.borrow_mut();
            l.render_start = Some(render_start);
            l.render_cpu = thread_cpu_ms();
            l.top = self.list.logical_scroll_top().item_ix;
        }
        if self.refresh.is_none() {
            self.refresh = window.refresh_interval(cx);
        }
        self.drive(window, cx);
        if self.phase == Phase::Done && self.mode == Mode::Bench && !self.out.contains_key("scroll")
        {
            self.report(cx);
        }
        let theme = cx.theme();
        let tab_btn = |id: &'static str, label: &'static str, tab: Tab, cur: Tab| {
            let b = Button::new(id).label(label);
            if tab == cur { b.primary() } else { b.ghost() }
        };
        let header = h_flex()
            .gap_2()
            .px_3()
            .py_2()
            .border_b_1()
            .border_color(theme.border)
            .child(
                tab_btn("tab-t", "Transcript", Tab::Transcript, self.tab).on_click(cx.listener(
                    |this, _, _, cx| {
                        this.tab = Tab::Transcript;
                        this.gallery.update(cx, |g, cx| g.set_visible(false, cx));
                        cx.notify();
                    },
                )),
            )
            .child(
                tab_btn("tab-g", "Gallery", Tab::Gallery, self.tab).on_click(cx.listener(
                    |this, _, _, cx| {
                        this.tab = Tab::Gallery;
                        this.gallery.update(cx, |g, cx| g.set_visible(true, cx));
                        cx.notify();
                    },
                )),
            )
            .child(div().flex_1())
            .child(
                div()
                    .text_xs()
                    .text_color(theme.muted_foreground)
                    .child(format!(
                        "{} rows · {} events · {:?}",
                        self.t.rows.len(),
                        self.t.events,
                        self.phase
                    )),
            );
        let body =
            match self.tab {
                Tab::Transcript => v_flex()
                    .flex_1()
                    .min_h_0()
                    .child(
                        list(self.list.clone(), cx.processor(Self::render_row))
                            .flex_1()
                            .min_h_0()
                            .w_full(),
                    )
                    .child(
                        h_flex()
                            .gap_2()
                            .p_3()
                            .border_t_1()
                            .border_color(theme.border)
                            .child(div().flex_1().child(Textarea::new(&self.composer)))
                            .child(Button::new("send").primary().label("Send").on_click(
                                cx.listener(|this, _, window, cx| this.send(window, cx)),
                            )),
                    )
                    .into_any_element(),
                Tab::Gallery => div()
                    .flex_1()
                    .min_h_0()
                    .child(self.gallery.clone())
                    .into_any_element(),
            };
        let log = self.log.clone();
        v_flex()
            .size_full()
            .bg(theme.background)
            .text_color(theme.foreground)
            .child(header)
            .child(body)
            .child(
                // Last in paint order: stamps the end of this frame's paint.
                canvas(
                    |_, _, _| {},
                    move |_, _, _, _| {
                        let now = Instant::now();
                        let mut l = log.borrow_mut();
                        l.first_paint.get_or_insert(now);
                        if l.recording {
                            let interval =
                                l.last_paint_end.map(|p| ms(now - p)).unwrap_or(f64::NAN);
                            let work = l.render_start.map(|s| ms(now - s)).unwrap_or(f64::NAN);
                            let cpu = thread_cpu_ms() - l.render_cpu;
                            let top = l.top;
                            if interval.is_finite() {
                                l.frames.push(Frame {
                                    interval,
                                    work,
                                    cpu,
                                    top,
                                });
                            }
                        }
                        let pend = std::mem::take(&mut l.pending);
                        for at in pend {
                            l.latencies.push(ms(now - at));
                        }
                        l.last_paint_end = Some(now);
                    },
                )
                .absolute()
                .size_0(),
            )
    }
}
