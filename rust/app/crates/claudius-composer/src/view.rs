//! [`ComposerView`]: the composer on screen, under the transcript, as
//! `ChatSurface.tsx` stacks it: `PromptSuggestions`, `QueueIndicator`,
//! then `PromptInput` (the frame with the `!` chip, the editor, the Queue
//! / Stop / Send buttons, and the footer's notices, hints and character
//! count).
//!
//! The editor is gpui-component's `Textarea` (IME, undo, selection, soft
//! wrap, auto-grow). The key rules run before its bindings: a keystroke
//! interceptor hands every key the composer has a rule for to
//! [`Composer::key`] while the editor has focus, and stops it when the rule
//! takes it (`preventDefault`). Every other key, and a key the rule passes
//! on (Shift+Enter's newline, a lone Escape), reaches the editor as usual.
//!
//! The view runs the model's [`Out`]s against its [`ComposerTarget`]: calls
//! and fetches on tasks whose results come back into the model, timers on
//! the executor's clock.
//!
//! Seams: the paste hook (`Textarea::on_paste`) and the paperclip are
//! where U07c's attachments come in; the pickers (U07b) open over the box
//! from [`Composer::picker`].

use std::collections::HashMap;
use std::sync::Arc;
use std::time::{Duration, Instant, SystemTime, UNIX_EPOCH};

use claudius_client::effect::{FetchOutcome, TimerId};
use claudius_gpui_theme::{ThemeName, density, fonts, hsla, icons};
use claudius_theme::chat::ChatSize;
use claudius_theme::prompt::{ComposerState, PromptColor, composer_frame};
use claudius_theme::{Rgba, Theme as Tokens, color, tailwind};
use futures::StreamExt as _;
use gpui_kit::component::Icon;
use gpui_kit::component::input::{Input, InputEvent, InputState, Textarea, TextareaState};
use gpui_kit::prelude::FluentBuilder as _;
use gpui_kit::{
    AnyElement, AppContext as _, Context, Div, Entity, EntityInputHandler as _, FocusHandle,
    Focusable as _, FontWeight, Hsla, InteractiveElement as _, IntoElement, Keystroke,
    ParentElement as _, Render, StatefulInteractiveElement as _, Styled as _, Subscription, Task,
    Window, div, px,
};
use serde_json::json;

use crate::model::{Composer, Key, Out, SessionView};
use crate::rules::{self, HintState};
use crate::target::{ComposerTarget, SessionCall};

/// The editor's rows: one when empty, growing to the TS's 320 px cap.
const MAX_ROWS: usize = 12;

#[derive(Clone, Copy)]
struct Colors {
    foreground: Rgba,
    panel: Rgba,
    panel_2: Rgba,
    border: Rgba,
    muted: Rgba,
    accent: Rgba,
}

fn h(c: Rgba) -> Hsla {
    hsla(c)
}

/// Tailwind's `/N`.
fn a(c: Rgba, pct: f64) -> Hsla {
    hsla(color::with_opacity(c, pct))
}

fn step(name: &str) -> Rgba {
    tailwind::color(name).unwrap_or_else(|| panic!("{name} is a Tailwind step"))
}

fn icon(name: &str, size: f32, color: Hsla) -> Option<Icon> {
    icons::icon(name).map(|i| Icon::new(i).size(px(size)).text_color(color))
}

/// The composer view.
pub struct ComposerView {
    target: Arc<dyn ComposerTarget>,
    model: Composer,
    view: SessionView,
    editor: Entity<TextareaState>,
    sudo: Entity<InputState>,
    theme: ThemeName,
    applied_rev: u64,
    placeholder: &'static str,
    disabled: bool,
    /// ChatSurface's toast (`onNotice`), until the next send.
    toast: Option<String>,
    started: Instant,
    timers: HashMap<TimerId, Task<()>>,
    focus_on_bind: bool,
    _subs: Vec<Subscription>,
    _listen: Task<()>,
}

impl ComposerView {
    pub fn new(
        target: Arc<dyn ComposerTarget>,
        theme: ThemeName,
        window: &mut Window,
        cx: &mut Context<Self>,
    ) -> Self {
        let placeholder = rules::placeholder(false, false);
        let editor = cx.new(|cx| {
            TextareaState::new(window, cx)
                .auto_grow(1, MAX_ROWS)
                .submit_on_enter(true)
                .placeholder(placeholder)
        });
        let sudo = cx.new(|cx| {
            InputState::new(window, cx)
                .masked(true)
                .placeholder("Password")
        });
        let on_edit = cx.subscribe_in(&editor, window, |this, _, ev: &InputEvent, window, cx| {
            if matches!(ev, InputEvent::Change) {
                this.on_editor_change(window, cx);
            }
        });
        let on_sudo = cx.subscribe_in(&sudo, window, |this, _, ev: &InputEvent, window, cx| {
            if let InputEvent::PressEnter { .. } = ev {
                this.submit_sudo(window, cx);
            }
        });
        let focus = editor.read(cx).focus_handle(cx);
        let weak = cx.entity().downgrade();
        let intercept = cx.intercept_keystrokes(move |ev, window, cx| {
            if !focus.is_focused(window) {
                return;
            }
            let Some(view) = weak.upgrade() else { return };
            let handled = view.update(cx, |v, cx| v.on_keystroke(&ev.keystroke, window, cx));
            if handled {
                cx.stop_propagation();
            }
        });
        // The draft still waiting on the debounce goes out when the view
        // does (the TS's unmount flush) or the app quits (its `pagehide`).
        let on_release = cx.on_release(|this: &mut Self, _| this.flush_on_exit());
        let on_quit = cx.on_app_quit(|this: &mut Self, _| {
            this.flush_on_exit();
            async {}
        });
        let mut changes = target.subscribe();
        let listen = cx.spawn_in(window, async move |this, cx| {
            while let Some(change) = changes.next().await {
                let mut mine = vec![change.session_id];
                while let Ok(more) = changes.try_recv() {
                    mine.push(more.session_id);
                }
                let ok = this.update_in(cx, |this, window, cx| {
                    if this
                        .model
                        .session_id()
                        .is_some_and(|s| mine.iter().any(|m| m == s))
                    {
                        this.reread(window, cx);
                    }
                });
                if ok.is_err() {
                    break;
                }
            }
        });
        ComposerView {
            target,
            model: Composer::new(),
            view: SessionView::default(),
            editor,
            sudo,
            theme,
            applied_rev: 0,
            placeholder,
            disabled: false,
            toast: None,
            started: Instant::now(),
            timers: HashMap::new(),
            focus_on_bind: true,
            _subs: vec![on_edit, on_sudo, intercept, on_release, on_quit],
            _listen: listen,
        }
    }

    // ------------------------------------------------------------ reads

    pub fn model(&self) -> &Composer {
        &self.model
    }

    /// The bound session as last read.
    pub fn session(&self) -> &SessionView {
        &self.view
    }

    pub fn editor(&self) -> &Entity<TextareaState> {
        &self.editor
    }

    /// The sudo modal's password field.
    pub fn sudo_input(&self) -> &Entity<InputState> {
        &self.sudo
    }

    pub fn toast(&self) -> Option<&str> {
        self.toast.as_deref()
    }

    /// `flushPendingDraft(ref, { unloading: true })`: fire and forget.
    fn flush_on_exit(&mut self) {
        for out in self.model.unmount(true) {
            if let Out::Fetch(req) = out {
                drop(self.target.fetch(req));
            }
        }
    }

    // ----------------------------------------------------------- inputs

    /// Binds the composer to a session (the chat route's active tab), or
    /// none. The composer stays mounted across tab switches, as
    /// PromptInput does.
    pub fn set_session(&mut self, id: Option<&str>, window: &mut Window, cx: &mut Context<Self>) {
        if self.model.session_id() == id {
            return;
        }
        let outs = self.model.bind(id);
        self.reread(window, cx);
        self.run(outs, window, cx);
        if self.focus_on_bind && id.is_some() {
            let focus = self.focus_handle(cx);
            window.focus(&focus, cx);
        }
    }

    /// Whether binding a session moves focus into the box (on, as
    /// PromptInput's auto-focus; the shell turns it off while another
    /// editor is open).
    pub fn set_focus_on_bind(&mut self, on: bool) {
        self.focus_on_bind = on;
    }

    pub fn set_theme(&mut self, theme: ThemeName, cx: &mut Context<Self>) {
        if self.theme != theme {
            self.theme = theme;
            cx.notify();
        }
    }

    /// Clicks and keys, for tests and hosts: Send / Queue.
    pub fn submit(&mut self, window: &mut Window, cx: &mut Context<Self>) {
        self.toast = None;
        let outs = self.model.submit(&self.view);
        self.run(outs, window, cx);
    }

    /// Replaces the draft (`draftInjection`'s replace mode: a prefill, a
    /// lifted message); the replaced one is one Up press away.
    pub fn inject(&mut self, text: &str, window: &mut Window, cx: &mut Context<Self>) {
        let outs = self.model.inject(text, Vec::new(), false);
        self.run(outs, window, cx);
    }

    /// `/color`'s optimistic set for the bound session (the slash
    /// command's dispatch is U07b's).
    pub fn set_prompt_color(&mut self, color: Option<PromptColor>, cx: &mut Context<Self>) {
        self.model.set_prompt_color(color);
        cx.notify();
    }

    /// The Stop button.
    pub fn interrupt(&mut self, window: &mut Window, cx: &mut Context<Self>) {
        let outs = self.model.interrupt();
        self.run(outs, window, cx);
    }

    fn act(
        &mut self,
        window: &mut Window,
        cx: &mut Context<Self>,
        f: impl FnOnce(&mut Composer) -> Vec<Out>,
    ) {
        let outs = f(&mut self.model);
        self.run(outs, window, cx);
    }

    fn reread(&mut self, window: &mut Window, cx: &mut Context<Self>) {
        let mut view = SessionView::default();
        if let Some(id) = self.model.session_id() {
            self.target.read(id, &mut |s| view = SessionView::of(s));
        }
        self.view = view;
        self.sync_editor(window, cx);
        cx.notify();
    }

    fn now_ms(&self) -> f64 {
        self.started.elapsed().as_secs_f64() * 1000.0
    }

    fn on_keystroke(
        &mut self,
        ks: &Keystroke,
        window: &mut Window,
        cx: &mut Context<Self>,
    ) -> bool {
        let m = &ks.modifiers;
        let key = match ks.key.as_str() {
            "enter" => "Enter",
            "up" => "ArrowUp",
            "down" => "ArrowDown",
            "escape" => "Escape",
            "tab" => "Tab",
            "c" if m.control => "c",
            _ => return false,
        };
        let k = Key {
            key: key.into(),
            code: if key == "c" {
                "KeyC".into()
            } else {
                String::new()
            },
            ctrl: m.control,
            meta: m.platform,
            alt: m.alt,
            shift: m.shift,
        };
        let (sel, composing) = self.editor.update(cx, |s, cx| {
            let r = s.selected_range();
            let composing = s.marked_text_range(window, cx).is_some();
            (r, composing)
        });
        let sel = crate::model::Selection {
            start: sel.start,
            end: sel.end,
        };
        let now = self.now_ms();
        let outcome = self.model.key(&k, sel, &self.view, now, composing);
        let mut handled = outcome.handled;
        self.toast = if outcome.out.iter().any(|o| {
            matches!(
                o,
                Out::Call {
                    call: SessionCall::Send { .. },
                    ..
                }
            )
        }) {
            None
        } else {
            self.toast.take()
        };
        self.run(outcome.out, window, cx);
        if let Some(forward) = outcome.move_focus {
            if forward {
                window.focus_next(cx);
            } else {
                window.focus_prev(cx);
            }
            handled = true;
        }
        handled
    }

    fn on_editor_change(&mut self, window: &mut Window, cx: &mut Context<Self>) {
        let (value, caret, composing) = self.editor.update(cx, |s, cx| {
            let composing = s.marked_text_range(window, cx).is_some();
            (s.value(), s.cursor(), composing)
        });
        let outs = self.model.edited(&value, caret, composing);
        self.run(outs, window, cx);
    }

    fn submit_sudo(&mut self, window: &mut Window, cx: &mut Context<Self>) {
        let password = self.sudo.read(cx).value().to_string();
        // Drop it from the field at once; only the request carries it.
        self.sudo.update(cx, |s, cx| s.set_value("", window, cx));
        let outs = self.model.sudo_submit(&password);
        self.run(outs, window, cx);
    }

    /// Applies the model's own text writes and the editor's props.
    fn sync_editor(&mut self, window: &mut Window, cx: &mut Context<Self>) {
        let rev = self.model.text_rev();
        if rev != self.applied_rev {
            self.applied_rev = rev;
            let value = self.model.value().to_owned();
            let caret = self.model.caret();
            self.editor.update(cx, |s, cx| {
                if s.value().as_ref() != value {
                    s.set_value(value, window, cx);
                }
                s.set_selected_range(caret..caret, cx);
            });
        }
        let disabled = self.model.input_disabled(&self.view);
        if disabled != self.disabled {
            self.disabled = disabled;
            self.editor.update(cx, |s, cx| s.set_disabled(disabled, cx));
        }
        let placeholder = rules::placeholder(self.view.ready, self.view.pending);
        if placeholder != self.placeholder {
            self.placeholder = placeholder;
            self.editor
                .update(cx, |s, cx| s.set_placeholder(placeholder, window, cx));
        }
    }

    /// Runs what the model asked for.
    fn run(&mut self, outs: Vec<Out>, window: &mut Window, cx: &mut Context<Self>) {
        for out in outs {
            match out {
                Out::Call { token, call } => {
                    let Some(id) = self.model.session_id().map(str::to_owned) else {
                        // `useSession`'s unbound answers.
                        if let Some(t) = token {
                            let v = match call {
                                SessionCall::Send { .. } => {
                                    json!({"ok": false, "error": "no session"})
                                }
                                _ => serde_json::Value::Null,
                            };
                            let more = self.model.call_resolved(t, Some(v), epoch_ms());
                            self.run(more, window, cx);
                        }
                        continue;
                    };
                    let rx = self.target.call(&id, call);
                    if let Some(t) = token {
                        cx.spawn_in(window, async move |this, cx| {
                            let v = rx.await.ok();
                            this.update_in(cx, |this, window, cx| {
                                let more = this.model.call_resolved(t, v, epoch_ms());
                                this.run(more, window, cx);
                            })
                            .ok();
                        })
                        .detach();
                    }
                }
                Out::Fetch(req) => {
                    let id = req.id;
                    let rx = self.target.fetch(req);
                    cx.spawn_in(window, async move |this, cx| {
                        let outcome = rx
                            .await
                            .unwrap_or_else(|_| FetchOutcome::Failed("aborted".into()));
                        this.update_in(cx, |this, window, cx| {
                            let more = this.model.fetch_settled(id, &outcome);
                            this.run(more, window, cx);
                        })
                        .ok();
                    })
                    .detach();
                }
                Out::SetTimer { id, ms } => {
                    let delay = Duration::from_secs_f64(ms.max(0.0) / 1000.0);
                    let task = cx.spawn_in(window, async move |this, cx| {
                        cx.background_executor().timer(delay).await;
                        this.update_in(cx, |this, window, cx| {
                            this.timers.remove(&id);
                            let more = this.model.timer_fired(id);
                            this.run(more, window, cx);
                        })
                        .ok();
                    });
                    self.timers.insert(id, task);
                }
                Out::ClearTimer { id } => {
                    self.timers.remove(&id);
                }
                Out::Notice(msg) => self.toast = Some(msg),
            }
        }
        self.sync_editor(window, cx);
        cx.notify();
    }

    // ----------------------------------------------------------- render

    fn colors(&self) -> Colors {
        let p = Tokens::of(self.theme).palette;
        Colors {
            foreground: p.foreground,
            panel: p.panel,
            panel_2: p.panel_2,
            border: p.border,
            muted: p.muted,
            accent: p.accent,
        }
    }

    fn suggestions(&self, c: &Colors, text: f32, cx: &mut Context<Self>) -> Option<AnyElement> {
        if self.view.suggestions.is_empty() {
            return None;
        }
        let chips = self.view.suggestions.iter().enumerate().map(|(i, s)| {
            let pick = s.clone();
            div()
                .id(("suggestion", i))
                .debug_selector(move || format!("composer-suggestion-{i}"))
                .max_w_full()
                .truncate()
                .rounded_full()
                .border_1()
                .border_color(h(c.border))
                .bg(h(c.panel_2))
                .px(px(12.))
                .py(px(4.))
                .text_size(px(text * 0.86))
                .text_color(h(c.foreground))
                .hover(|d| d.bg(h(c.panel)))
                .cursor_pointer()
                .child(s.clone())
                .on_click(cx.listener(move |this, _, window, cx| {
                    let pick = pick.clone();
                    this.act(window, cx, |m| m.pick_suggestion(&pick));
                }))
        });
        Some(
            div()
                .debug_selector(|| "composer-suggestions".into())
                .w_full()
                .pb(px(8.))
                .child(
                    div()
                        .mb(px(4.))
                        .flex()
                        .items_center()
                        .gap(px(4.))
                        .text_size(px(text * 0.71))
                        .text_color(h(c.muted))
                        .children(icon("Sparkles", 12., h(c.muted)))
                        .child("SUGGESTED FOLLOW-UPS"),
                )
                .child(div().flex().flex_wrap().gap(px(6.)).children(chips))
                .into_any_element(),
        )
    }

    fn queue_button(
        &self,
        id: (&'static str, usize),
        icon_name: &str,
        label: &str,
        enabled: bool,
        c: &Colors,
    ) -> gpui_kit::Stateful<Div> {
        div()
            .id(id)
            .flex()
            .items_center()
            .gap(px(4.))
            .rounded(px(4.))
            .px(px(6.))
            .py(px(2.))
            .text_size(px(10.))
            .text_color(h(c.muted))
            .children(icon(icon_name, 12., h(c.muted)))
            .child(label.to_uppercase())
            .when(enabled, |d| {
                d.cursor_pointer()
                    .hover(|d| d.bg(h(c.panel_2)).text_color(h(c.foreground)))
            })
            .when(!enabled, |d| d.opacity(0.3))
    }

    fn queue_strip(&self, c: &Colors, cx: &mut Context<Self>) -> Option<AnyElement> {
        let queue = &self.view.queue;
        let sdk = self.view.sdk_queued_turns;
        if queue.is_empty() && sdk == 0.0 {
            return None;
        }
        let n = queue.len();
        let header = (!queue.is_empty()).then(|| {
            div()
                .flex()
                .items_center()
                .gap(px(4.))
                .text_size(px(10.))
                .text_color(h(c.muted))
                .children(icon("Hourglass", 12., h(c.muted)))
                .child(rules::QUEUE_HEADER.to_uppercase())
                .when(n > 1, |d| {
                    d.child(
                        div()
                            .id("queue-send-all-now")
                            .debug_selector(|| "queue-send-all-now".into())
                            .ml(px(4.))
                            .flex()
                            .items_center()
                            .gap(px(4.))
                            .px(px(6.))
                            .py(px(2.))
                            .rounded(px(4.))
                            .underline()
                            .cursor_pointer()
                            .hover(|d| d.text_color(h(c.foreground)))
                            .children(icon("Send", 12., h(c.muted)))
                            .child(rules::SEND_ALL_NOW)
                            .on_click(cx.listener(|this, _, window, cx| {
                                this.act(window, cx, Composer::queue_send_all);
                            })),
                    )
                })
        });
        let rows = queue.iter().enumerate().map(|(i, q)| {
            let (e1, e2, up, down, now, rm) = (
                q.id.clone(),
                q.id.clone(),
                q.id.clone(),
                q.id.clone(),
                q.id.clone(),
                q.id.clone(),
            );
            div()
                .debug_selector(move || format!("queue-item-{i}"))
                .flex()
                .items_center()
                .gap(px(4.))
                .rounded(px(6.))
                .border_1()
                .border_dashed()
                .border_color(h(c.border))
                .bg(a(c.panel, 40.))
                .px(px(8.))
                .py(px(4.))
                .text_size(px(12.))
                .child(
                    div()
                        .id(("queue-text", i))
                        .flex_1()
                        .min_w_0()
                        .truncate()
                        .text_color(h(c.muted))
                        .hover(|d| d.text_color(h(c.foreground)))
                        .cursor_text()
                        .child(q.text.clone())
                        .on_click(cx.listener(move |this, _, window, cx| {
                            let id = e1.clone();
                            this.act(window, cx, |m| m.queue_edit(&id));
                        })),
                )
                .child(
                    self.queue_button(("queue-up", i), "ArrowUp", "Up", i > 0, c)
                        .debug_selector(move || format!("queue-up-{i}"))
                        .when(i > 0, |d| {
                            d.on_click(cx.listener(move |this, _, window, cx| {
                                let id = up.clone();
                                this.act(window, cx, |m| m.queue_move(&id, -1.0));
                            }))
                        }),
                )
                .child(
                    self.queue_button(("queue-down", i), "ArrowDown", "Down", i + 1 < n, c)
                        .debug_selector(move || format!("queue-down-{i}"))
                        .when(i + 1 < n, |d| {
                            d.on_click(cx.listener(move |this, _, window, cx| {
                                let id = down.clone();
                                this.act(window, cx, |m| m.queue_move(&id, 1.0));
                            }))
                        }),
                )
                .child(
                    self.queue_button(("queue-now", i), "Send", "Send now", true, c)
                        .debug_selector(move || format!("queue-send-now-{i}"))
                        .on_click(cx.listener(move |this, _, window, cx| {
                            let id = now.clone();
                            this.act(window, cx, |m| m.queue_send_now(&id));
                        })),
                )
                .child(
                    self.queue_button(("queue-edit", i), "Pencil", "Edit", true, c)
                        .debug_selector(move || format!("queue-edit-{i}"))
                        .on_click(cx.listener(move |this, _, window, cx| {
                            let id = e2.clone();
                            this.act(window, cx, |m| m.queue_edit(&id));
                        })),
                )
                .child(
                    self.queue_button(("queue-remove", i), "X", "Remove", true, c)
                        .debug_selector(move || format!("queue-remove-{i}"))
                        .on_click(cx.listener(move |this, _, window, cx| {
                            let id = rm.clone();
                            this.act(window, cx, |m| m.queue_remove(&id));
                        })),
                )
        });
        let amber = step("amber-500");
        let sdk_row = (sdk > 0.0).then(|| {
            div()
                .debug_selector(|| "sdk-queued-turns".into())
                .flex()
                .items_center()
                .gap(px(6.))
                .rounded(px(6.))
                .border_1()
                .border_dashed()
                .border_color(a(amber, 30.))
                .bg(a(amber, 10.))
                .px(px(8.))
                .py(px(4.))
                .text_size(px(10.))
                .text_color(h(step("amber-200")))
                .children(icon("CornerDownRight", 12., h(step("amber-200"))))
                .child(rules::sdk_queued_turns_label(sdk).to_uppercase())
        });
        Some(
            div()
                .debug_selector(|| "queue-indicator".into())
                .w_full()
                .flex()
                .flex_col()
                .gap(px(4.))
                .pb(px(8.))
                .children(header)
                .children(rows)
                .children(sdk_row)
                .into_any_element(),
        )
    }

    fn footer(&self, c: &Colors, text: f32, cx: &mut Context<Self>) -> Div {
        let muted70 = a(c.muted, 70.);
        let amber = h(step("amber-400"));
        let left: AnyElement = if let Some(n) = self.model.send_failed_notice() {
            div()
                .debug_selector(|| "composer-send-failed-notice".into())
                .text_color(amber)
                .child(n.to_owned())
                .into_any_element()
        } else if let Some(n) = self.model.invisible_notice() {
            div()
                .debug_selector(|| "composer-invisible-notice".into())
                .child(n.to_owned())
                .into_any_element()
        } else if let Some((hint, state)) = self.model.hint() {
            match state {
                HintState::Active => div()
                    .id("composer-hint")
                    .debug_selector(|| "composer-keyword-hint-active".into())
                    .flex()
                    .gap(px(4.))
                    .text_color(h(c.accent))
                    .cursor_pointer()
                    .child(hint.label)
                    .child(div().text_color(muted70).child("\u{b7} ignore"))
                    .on_click(cx.listener(|this, _, _, cx| {
                        this.model.dismiss_hint();
                        cx.notify();
                    }))
                    .into_any_element(),
                HintState::Ignored => div()
                    .id("composer-hint")
                    .debug_selector(|| "composer-keyword-hint-ignored".into())
                    .flex()
                    .gap(px(4.))
                    .text_color(h(c.muted))
                    .cursor_pointer()
                    .child(hint.ignored_label.unwrap_or_default())
                    .child(div().text_color(muted70).child("\u{b7} undo"))
                    .on_click(cx.listener(|this, _, _, cx| {
                        this.model.restore_hint();
                        cx.notify();
                    }))
                    .into_any_element(),
            }
        } else {
            let queued = self.view.queue.len();
            div()
                .flex()
                .items_center()
                .gap(px(6.))
                .child(rules::queue_hint(self.view.pending, queued))
                .when(self.view.pending && queued > 0, |d| {
                    d.child(
                        div()
                            .id("composer-send-now-hint")
                            .debug_selector(|| "composer-queue-send-now-hint".into())
                            .text_color(h(c.muted))
                            .underline()
                            .cursor_pointer()
                            .hover(|d| d.text_color(h(c.foreground)))
                            .child(rules::SEND_NOW_HINT)
                            .on_click(cx.listener(|this, _, window, cx| {
                                this.act(window, cx, Composer::queue_send_all);
                            })),
                    )
                })
                .into_any_element()
        };
        let images = self.model.images().len();
        div()
            .debug_selector(|| "composer-footer".into())
            .mt(px(6.))
            .px(px(4.))
            .flex()
            .items_center()
            .justify_between()
            .text_size(px(text * 0.79))
            .text_color(muted70)
            .child(left)
            .child(
                div()
                    .flex()
                    .items_center()
                    .gap(px(8.))
                    .when(images > 0, |d| {
                        d.child(
                            div()
                                .flex()
                                .items_center()
                                .gap(px(4.))
                                .children(icon("ImageIcon", text * 0.79 * 1.1, muted70))
                                .child(images.to_string()),
                        )
                    })
                    .child(
                        div()
                            .debug_selector(|| "composer-chars".into())
                            .font_family(fonts::MONO)
                            .child(format!("{} chars", rules::utf16_len(self.model.value()))),
                    ),
            )
    }

    fn sudo_modal(&self, c: &Colors, cx: &mut Context<Self>) -> Option<AnyElement> {
        let cmd = self.model.sudo_prompt()?.to_owned();
        let running = self.model.bash_running();
        Some(
            div()
                .debug_selector(|| "composer-sudo-modal".into())
                .mb(px(8.))
                .w_full()
                .rounded(px(16.))
                .border_1()
                .border_color(h(c.border))
                .bg(h(c.panel))
                .p(px(16.))
                .flex()
                .flex_col()
                .gap(px(8.))
                .child(
                    div()
                        .text_size(px(14.))
                        .font_weight(FontWeight::SEMIBOLD)
                        .child("Run with sudo"),
                )
                .child(
                    div()
                        .rounded(px(6.))
                        .border_1()
                        .border_color(h(c.border))
                        .bg(h(c.panel_2))
                        .px(px(8.))
                        .py(px(6.))
                        .font_family(fonts::MONO)
                        .text_size(px(12.))
                        .text_color(h(c.foreground))
                        .child(cmd),
                )
                .child(Input::new(&self.sudo).disabled(running))
                .child(
                    div()
                        .flex()
                        .justify_end()
                        .gap(px(8.))
                        .child(
                            div()
                                .id("composer-sudo-cancel")
                                .px(px(12.))
                                .py(px(4.))
                                .text_size(px(14.))
                                .text_color(h(c.muted))
                                .cursor_pointer()
                                .child("Cancel")
                                .on_click(cx.listener(|this, _, window, cx| {
                                    this.model.sudo_cancel();
                                    this.sudo.update(cx, |s, cx| s.set_value("", window, cx));
                                    cx.notify();
                                })),
                        )
                        .child(
                            div()
                                .id("composer-sudo-run")
                                .debug_selector(|| "composer-sudo-run".into())
                                .px(px(12.))
                                .py(px(4.))
                                .rounded(px(6.))
                                .border_1()
                                .border_color(h(c.border))
                                .bg(a(step("amber-500"), 15.))
                                .text_size(px(14.))
                                .text_color(h(step("amber-300")))
                                .cursor_pointer()
                                .child(if running { "Running\u{2026}" } else { "Run" })
                                .on_click(cx.listener(|this, _, window, cx| {
                                    this.submit_sudo(window, cx);
                                })),
                        ),
                )
                .child(
                    div().text_size(px(11.)).text_color(h(c.muted)).child(
                        "The password is sent once over a local request and never persisted.",
                    ),
                )
                .into_any_element(),
        )
    }

    fn frame(&self, c: &Colors, text: f32, window: &mut Window, cx: &mut Context<Self>) -> Div {
        let tokens = Tokens::of(self.theme);
        let bash = self.model.is_bash_mode();
        let focused = self.focus_handle(cx).is_focused(window);
        let frame = composer_frame(
            &tokens,
            &ComposerState {
                prompt_color: self.model.prompt_color(),
                wide_drop_target: true,
                drag_over: false,
                bash_mode: bash,
                focused,
            },
        );
        let pending = self.view.pending;
        let send_disabled = self.model.send_button_disabled(&self.view);
        let amber400 = h(step("amber-400"));
        let chip = bash.then(|| {
            div()
                .debug_selector(|| "composer-bash-chip".into())
                .h(px(28.))
                .flex_none()
                .flex()
                .items_center()
                .gap(px(4.))
                .rounded(px(6.))
                .border_1()
                .border_color(h(c.border))
                .bg(a(step("amber-500"), 10.))
                .px(px(8.))
                .font_family(fonts::MONO)
                .text_size(px(11.))
                .font_weight(FontWeight::SEMIBOLD)
                .text_color(amber400)
                .when(self.model.bash_running(), |d| {
                    d.children(icon("Hourglass", 12., amber400))
                })
                .child("BASH")
        });
        let editor = Textarea::new(&self.editor)
            .appearance(false)
            .disabled(self.disabled)
            .on_paste(|_, _, _| false);
        let editor = if bash {
            editor.font_family(fonts::MONO).text_size(px(text * 0.93))
        } else {
            editor.text_size(px(text))
        };
        let queue_btn = pending.then(|| {
            div()
                .id("composer-queue")
                .debug_selector(|| "composer-queue".into())
                .h(px(32.))
                .flex_none()
                .flex()
                .items_center()
                .gap(px(4.))
                .rounded_full()
                .border_1()
                .border_color(h(c.border))
                .bg(a(c.accent, 15.))
                .px(px(12.))
                .text_size(px(12.))
                .text_color(h(c.accent))
                .children(icon("Hourglass", 14., h(c.accent)))
                .child("Queue")
                .when(send_disabled, |d| d.opacity(0.4))
                .when(!send_disabled, |d| {
                    d.cursor_pointer()
                        .hover(|d| d.bg(a(c.accent, 25.)))
                        .on_click(cx.listener(|this, _, window, cx| this.submit(window, cx)))
                })
        });
        let end_btn = if pending {
            div()
                .id("composer-interrupt")
                .debug_selector(|| "composer-interrupt".into())
                .size(px(32.))
                .flex_none()
                .flex()
                .items_center()
                .justify_center()
                .rounded_full()
                .bg(a(step("red-500"), 90.))
                .cursor_pointer()
                .hover(|d| d.bg(h(step("red-500"))))
                .children(icon("Square", 14., gpui_kit::white()))
                .on_click(cx.listener(|this, _, window, cx| this.interrupt(window, cx)))
        } else {
            div()
                .id("composer-send")
                .debug_selector(|| "composer-send".into())
                .size(px(32.))
                .flex_none()
                .flex()
                .items_center()
                .justify_center()
                .rounded_full()
                .bg(h(c.accent))
                .children(icon("ArrowUp", 16., gpui_kit::white()))
                .when(send_disabled, |d| d.opacity(0.4))
                .when(!send_disabled, |d| {
                    d.cursor_pointer()
                        .hover(|d| d.opacity(0.9))
                        .on_click(cx.listener(|this, _, window, cx| this.submit(window, cx)))
                })
        };
        div()
            .debug_selector(|| "composer-frame".into())
            .flex()
            .items_end()
            .gap(px(8.))
            .rounded(px(16.))
            .border_1()
            .border_color(h(frame.border))
            .bg(h(frame.background))
            .px(px(12.))
            .py(px(8.))
            .children(chip)
            .child(
                div()
                    .id("composer-attach")
                    .size(px(28.))
                    .flex_none()
                    .flex()
                    .items_center()
                    .justify_center()
                    .rounded(px(6.))
                    .hover(|d| d.bg(h(c.panel)))
                    .children(icon("Paperclip", 16., h(c.muted))),
            )
            .child(
                div()
                    .debug_selector(|| "composer-input".into())
                    .flex_1()
                    .min_w_0()
                    .text_color(h(c.foreground))
                    .line_height(gpui_kit::relative(1.7))
                    .child(editor),
            )
            .children(queue_btn)
            .child(end_btn)
    }
}

/// `Date.now()`.
fn epoch_ms() -> f64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map_or(0.0, |d| d.as_secs_f64() * 1000.0)
}

impl Render for ComposerView {
    fn render(&mut self, window: &mut Window, cx: &mut Context<Self>) -> impl IntoElement {
        let c = self.colors();
        let (col, text) = density::chat_column(window.viewport_size().width, ChatSize::default());
        let text = f32::from(text);
        let column = |d: Div| d.w_full().max_w(col).mx_auto();
        let suggestions = self.suggestions(&c, text, cx);
        let queue = self.queue_strip(&c, cx);
        let toast = self.toast.clone().map(|t| {
            div()
                .debug_selector(|| "composer-toast".into())
                .mb(px(6.))
                .px(px(4.))
                .text_size(px(12.))
                .text_color(h(c.muted))
                .child(t)
        });
        let sudo = self.sudo_modal(&c, cx);
        let frame = self.frame(&c, text, window, cx);
        let footer = self.footer(&c, text, cx);
        div()
            .debug_selector(|| "composer".into())
            .flex_none()
            .w_full()
            .flex()
            .flex_col()
            .children(suggestions.map(|s| column(div().px(px(16.))).child(s)))
            .children(queue.map(|q| column(div().px(px(16.))).child(q)))
            .child(
                div()
                    .w_full()
                    .border_t_1()
                    .border_color(h(c.border))
                    .bg(h(c.panel))
                    .px(px(16.))
                    .py(px(12.))
                    .child(
                        column(div())
                            .children(toast)
                            .children(sudo)
                            .child(frame)
                            .child(footer),
                    ),
            )
    }
}

impl gpui_kit::Focusable for ComposerView {
    fn focus_handle(&self, cx: &gpui_kit::App) -> FocusHandle {
        self.editor.read(cx).focus_handle(cx)
    }
}
