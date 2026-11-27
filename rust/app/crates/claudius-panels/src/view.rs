//! [`RailPanel`]: the chat's right rail on screen (`BackgroundTasksPanel`,
//! `w-64 lg:w-72`, `border-l`, `bg-[var(--panel)]`): the Activity header,
//! the pinned usage card, the session card, the context bar, the token
//! tiles and the collapsible sections, with the classes of the TSX (the
//! rows' `rounded-md border px-2 py-1.5`, the `text-[10px]` / `[11px]`
//! sizes, the `TASK_TONES` tints).
//!
//! The view reads its [`RailTarget`]'s state on each change into a
//! [`RailModel`] and redraws only when that model (or the form, the
//! picker's open state) changed. It keeps what the components keep in
//! React state: the sections' collapsed prefs (`localStorage`, handed in
//! and reported back as [`RailEvent::Pref`]), the add-todos form, the
//! loops being cancelled, when the card first saw a session (`boundAt`),
//! and the clocks: the 1 Hz one the rows' timers read and the usage
//! card's minute one.
//!
//! The SessionCard's model picker is the status line's (U09a): the card's
//! header opens and closes [`StatusLineView`]'s model popover, and its
//! chevron follows it; the context bar reads the status line's context
//! poll.
//!
//! Named seams (events the host may wire, or nothing): "Open" / "Message"
//! on an earlier subagent, a shell's output viewer (BashViewer), the
//! context overlay, the cost overlay ("Details", the metrics row) and the
//! notifications drawer are not drawn here.

use std::collections::HashSet;
use std::sync::Arc;
use std::time::Duration;

use claudius_client::queue::SendOpts;
use claudius_client::state::ChatState;
use claudius_core::js_string::{from_units, units};
use claudius_gpui_theme::{ThemeName, fonts};
use claudius_status::StatusLineView;
use claudius_status::view::Popup;
use futures::StreamExt as _;
use gpui_kit::component::input::{Input, InputEvent, InputState};
use gpui_kit::prelude::FluentBuilder as _;
use gpui_kit::{
    AnyElement, AppContext as _, Context, Div, Entity, EventEmitter, FontWeight, Hsla,
    InteractiveElement as _, IntoElement, MouseButton, ParentElement as _, Render,
    StatefulInteractiveElement as _, Styled as _, Subscription, Task, Window, div, px,
};

use crate::card::{Card, ContextBar, ContextSummary};
use crate::look::{Ink, Look, Paint};
use crate::paint::{Colors, boxed, icon, id, sel, step, step_a, tip, upper};
use crate::rail::{self, Header, Prefs, RailModel, RailView, Section, collapsed_key};
use crate::rows::{
    BashRow, EarlierRow, EditRow, LoopRow, ProcessRow, RecentRow, SystemRow, TaskRow, ToolRow,
};
use crate::target::{RailTarget, outcome};
use crate::todos::{AddForm, FormKey, FormStep, ROW_MAX_LEN, ROW_PLACEHOLDER, add_todos_prompt};
use crate::usage::{
    MiniWindow, PLAN_USAGE_COLLAPSED_KEY, PlanCard, SONNET_TARGET, UsageRow, UsageTone,
};

/// What the rail asks its host for.
#[derive(Clone, Debug, PartialEq)]
pub enum RailEvent {
    /// A `localStorage` write to persist (`"1"` / `"0"`).
    Pref { key: String, value: String },
    /// "Message" on an earlier subagent: the composer draft to drop in
    /// (`messageSubagentDraft`), not sent.
    Draft(String),
    /// "Open" on an earlier subagent: its Task call's tool-use id.
    OpenTask(String),
    /// A shell row's command: its output viewer (`BashViewer`).
    OpenBash(String),
    /// The context bar (`onOpenContext`).
    OpenContext,
}

/// The add-todos form and its inputs (one per row).
struct AddTodos {
    form: AddForm,
    inputs: Vec<Entity<InputState>>,
    subs: Vec<Subscription>,
    task: Option<Task<()>>,
}

/// The rail of one chat.
pub struct RailPanel {
    target: Arc<dyn RailTarget>,
    status: Option<Entity<StatusLineView>>,
    theme: ThemeName,
    fixed_now: Option<f64>,
    usage_now: f64,
    prefs: Prefs,
    model: Option<RailModel>,
    bound_at: Option<f64>,
    picker_open: bool,
    /// The picker's state when the card's header was pressed (its popover
    /// closes itself on that press).
    picker_down_open: bool,
    context: Option<ContextSummary>,
    add: Option<AddTodos>,
    cancelling: HashSet<String>,
    confirm_stop_all: bool,
    message_wired: bool,
    ticker: Option<Task<()>>,
    ticks: usize,
    renders: usize,
    /// The rail's width in the shell's window (`w-64 lg:w-72`).
    width: f32,
    _listen: Option<Task<()>>,
    _status_sub: Option<Subscription>,
}

impl EventEmitter<RailEvent> for RailPanel {}

impl RailPanel {
    /// Over `target`, with the `localStorage` entries the rail reads
    /// (`claudius.activity.*`, `claudius.rateLimitWarningPct`) and the
    /// status line whose picker the card opens.
    pub fn new(
        target: Arc<dyn RailTarget>,
        status: Option<Entity<StatusLineView>>,
        theme: ThemeName,
        prefs: Prefs,
        cx: &mut Context<Self>,
    ) -> Self {
        // With a status line, the rail re-reads when it does: it redraws
        // on every change of the same feed, so the rail's own redraw lands
        // in that one update (a second listener would draw each streamed
        // chunk twice). Without one, the rail listens itself.
        let status_sub = status
            .as_ref()
            .map(|s| cx.observe(s, |this: &mut Self, _, cx| this.refresh(cx)));
        let listen = status.is_none().then(|| {
            let mut changes = target.changes();
            cx.spawn(async move |this, cx| {
                while changes.next().await.is_some() {
                    if this.update(cx, |this, cx| this.refresh(cx)).is_err() {
                        break;
                    }
                }
            })
        });
        let mut view = RailPanel {
            target,
            status,
            theme,
            fixed_now: None,
            usage_now: claudius_core::now_ms() as f64,
            prefs,
            model: None,
            bound_at: None,
            picker_open: false,
            picker_down_open: false,
            context: None,
            add: None,
            cancelling: HashSet::new(),
            confirm_stop_all: false,
            message_wired: false,
            ticker: None,
            ticks: 0,
            renders: 0,
            width: rail::rail_width(1024.),
            _listen: listen,
            _status_sub: status_sub,
        };
        view.refresh(cx);
        view
    }

    pub fn set_theme(&mut self, theme: ThemeName, cx: &mut Context<Self>) {
        if self.theme != theme {
            self.theme = theme;
            cx.notify();
        }
    }

    /// Fixes the clock (each tick then moves it a second) and shows clock
    /// times in UTC: the tests and the screenshots.
    pub fn set_now(&mut self, now_ms: f64, cx: &mut Context<Self>) {
        self.fixed_now = Some(now_ms);
        self.usage_now = now_ms;
        self.refresh(cx);
    }

    /// The rail's clock: the fixed one, else the wall clock.
    pub fn clock_ms(&self) -> f64 {
        self.fixed_now
            .unwrap_or_else(|| claudius_core::now_ms() as f64)
    }

    /// Whether the host drops "Message"'s draft into the composer (the
    /// button shows only then, as `onMessageTask` gates it).
    pub fn set_message_wired(&mut self, on: bool, cx: &mut Context<Self>) {
        if self.message_wired != on {
            self.message_wired = on;
            cx.notify();
        }
    }

    /// The rail as it draws now (`None`: no chat).
    pub fn model(&self) -> Option<&RailModel> {
        self.model.as_ref()
    }

    pub fn prefs(&self) -> &Prefs {
        &self.prefs
    }

    /// The add-todos form, while open.
    pub fn add_form(&self) -> Option<&AddForm> {
        self.add.as_ref().map(|a| &a.form)
    }

    pub fn cancelling(&self) -> &HashSet<String> {
        &self.cancelling
    }

    pub fn confirming_stop_all(&self) -> bool {
        self.confirm_stop_all
    }

    pub fn bound_at(&self) -> Option<f64> {
        self.bound_at
    }

    /// Whether the one-second clock runs (while there's a chat).
    pub fn ticking(&self) -> bool {
        self.ticker.is_some()
    }

    pub fn ticks(&self) -> usize {
        self.ticks
    }

    /// How many times the rail drew.
    pub fn renders(&self) -> usize {
        self.renders
    }

    /// The window's width, which sets the rail's (the shell sizes the
    /// rail's cached box with [`RailPanel::width`] before it draws).
    pub fn set_viewport_width(&mut self, viewport_width: f32) {
        self.width = rail::rail_width(viewport_width);
    }

    /// The rail's width (`w-64 lg:w-72`) in the window last given.
    pub fn width(&self) -> f32 {
        self.width
    }

    /// A `localStorage` write: kept, reported, and the rail re-read.
    pub fn set_pref(&mut self, key: &str, value: &str, cx: &mut Context<Self>) {
        if self.prefs.get(key).map(String::as_str) == Some(value) {
            return;
        }
        self.prefs.insert(key.to_owned(), value.to_owned());
        cx.emit(RailEvent::Pref {
            key: key.to_owned(),
            value: value.to_owned(),
        });
        self.refresh(cx);
    }

    /// `CollapsibleSection`'s toggle (CollapsibleSection.tsx:59).
    pub fn toggle_section(&mut self, key: &str, cx: &mut Context<Self>) {
        let next = !rail::is_collapsed(&self.prefs, key);
        self.set_pref(&collapsed_key(key), if next { "1" } else { "0" }, cx);
    }

    /// The header's "N running" (`revealBackground`): opens the section
    /// that holds them.
    pub fn reveal_background(&mut self, cx: &mut Context<Self>) {
        let Some(r) = self.model.as_ref().and_then(|m| m.header.running.clone()) else {
            return;
        };
        self.set_pref(&collapsed_key(r.reveal), "0", cx);
    }

    /// The usage card's minimize / expand (`writeCollapsed`).
    pub fn set_plan_collapsed(&mut self, collapsed: bool, cx: &mut Context<Self>) {
        self.set_pref(
            PLAN_USAGE_COLLAPSED_KEY,
            if collapsed { "1" } else { "0" },
            cx,
        );
    }

    /// "/model sonnet" (`onChangeModel(OPUS_OVERLOAD_NUDGE_SONNET_TARGET)`).
    pub fn pick_sonnet(&mut self) {
        self.target.act(Box::new(|s, env| {
            s.set_model(Some(SONNET_TARGET), None, env)
        }));
    }

    /// "/effort medium" (`onChangeEffort("medium")`).
    pub fn pick_effort_medium(&mut self) {
        self.target
            .act(Box::new(|s, env| s.set_effort("medium", false, env)));
    }

    /// The card's header (`setPickerOpen((o) => !o)`): the status line's
    /// model popover.
    pub fn toggle_picker(&mut self, cx: &mut Context<Self>) {
        if let Some(s) = &self.status {
            s.update(cx, |s, cx| s.toggle(Popup::Model, cx));
        }
    }

    fn picker_pressed(&mut self) {
        self.picker_down_open = self.picker_open;
    }

    fn picker_clicked(&mut self, cx: &mut Context<Self>) {
        // An open popover closed itself on the press (a press outside it).
        if self.picker_down_open {
            if let Some(s) = &self.status {
                s.update(cx, |s, cx| s.close(cx));
            }
        } else {
            self.toggle_picker(cx);
        }
    }

    /// A todo's checkbox (`onUpdateItem(id, "complete" | "reopen")`).
    pub fn toggle_todo(&mut self, item_id: &str, cx: &mut Context<Self>) {
        let Some(row) = self
            .model
            .as_ref()
            .and_then(|m| m.todos.body.rows.iter().find(|r| r.id == item_id))
        else {
            return;
        };
        let (action, id) = (row.toggle.0, item_id.to_owned());
        self.target
            .act(Box::new(move |s, env| s.update_todo_item(&id, action, env)));
        cx.notify();
    }

    /// A todo's × (`onUpdateItem(id, "delete")`).
    pub fn delete_todo(&mut self, item_id: &str) {
        let id = item_id.to_owned();
        self.target.act(Box::new(move |s, env| {
            s.update_todo_item(&id, "delete", env)
        }));
    }

    /// The eraser (`session.clearTodos`).
    pub fn clear_todos(&mut self) {
        self.target.act(Box::new(|s, env| s.clear_todos(env)));
    }

    /// The `+` (`setAddTodosOpen((v) => !v)`).
    pub fn toggle_add(&mut self, window: &mut Window, cx: &mut Context<Self>) {
        if self.add.take().is_none() {
            self.add = Some(AddTodos {
                form: AddForm::default(),
                inputs: Vec::new(),
                subs: Vec::new(),
                task: None,
            });
            self.sync_inputs(window, cx);
            self.focus_row(0, window, cx);
        }
        self.refresh(cx);
        cx.notify();
    }

    /// Types into a row (the input's value, then its `onChange`).
    pub fn set_add_row(
        &mut self,
        i: usize,
        text: &str,
        window: &mut Window,
        cx: &mut Context<Self>,
    ) {
        let Some(input) = self.add.as_ref().and_then(|a| a.inputs.get(i)).cloned() else {
            return;
        };
        let text = text.to_owned();
        input.update(cx, |s, cx| s.set_value(text, window, cx));
        self.row_changed(i, cx);
    }

    fn row_changed(&mut self, i: usize, cx: &mut Context<Self>) {
        let Some(add) = self.add.as_mut() else { return };
        let Some(input) = add.inputs.get(i) else {
            return;
        };
        let value = input.read(cx).value().to_string();
        // `maxLength={200}`, in UTF-16 units.
        let u = units(&value);
        let value = if u.len() > ROW_MAX_LEN {
            from_units(&u[..ROW_MAX_LEN])
        } else {
            value
        };
        add.form.set_row(i, &value);
        cx.notify();
    }

    /// "Add another".
    pub fn add_row(&mut self, window: &mut Window, cx: &mut Context<Self>) {
        let Some(add) = self.add.as_mut() else { return };
        let i = add.form.add_row();
        self.sync_inputs(window, cx);
        self.focus_row(i, window, cx);
        cx.notify();
    }

    /// A row's ×.
    pub fn remove_row(&mut self, i: usize, window: &mut Window, cx: &mut Context<Self>) {
        let Some(add) = self.add.as_mut() else { return };
        if add.form.rows.len() <= 1 {
            add.form.remove_row(i);
        } else if i < add.inputs.len() {
            add.form.remove_row(i);
            add.inputs.remove(i);
            drop(add.subs.remove(i));
        }
        self.sync_inputs(window, cx);
        cx.notify();
    }

    /// A key in row `i` (`onKey`).
    pub fn row_key(&mut self, i: usize, key: FormKey, window: &mut Window, cx: &mut Context<Self>) {
        let Some(add) = self.add.as_mut() else { return };
        if key == FormKey::Backspace && add.form.rows.len() > 1 && i < add.inputs.len() {
            // The input goes with its row.
            if add.form.rows.get(i).is_some_and(String::is_empty) {
                add.inputs.remove(i);
                drop(add.subs.remove(i));
            }
        }
        match add.form.key(i, key) {
            FormStep::Nothing => {}
            FormStep::Focus(j) => {
                self.sync_inputs(window, cx);
                self.focus_row(j, window, cx);
            }
            FormStep::Submit => self.submit_add(cx),
            FormStep::Cancel => self.cancel_add(cx),
        }
        cx.notify();
    }

    /// Cancel (and Escape).
    pub fn cancel_add(&mut self, cx: &mut Context<Self>) {
        if self.add.take().is_some() {
            self.refresh(cx);
            cx.notify();
        }
    }

    /// "Add" (and ⌘/Ctrl+Enter): `onAddTodos(texts)`, the form closing
    /// once the prompt went and keeping its error when it didn't.
    pub fn submit_add(&mut self, cx: &mut Context<Self>) {
        let Some(add) = self.add.as_mut() else { return };
        if add.form.submitting {
            return;
        }
        let Some(texts) = add.form.begin_submit() else {
            cx.notify();
            return;
        };
        for i in &add.inputs {
            i.update(cx, |s, cx| s.set_disabled(true, cx));
        }
        let Some(prompt) = add_todos_prompt(&texts) else {
            // Nothing to send: `onAddTodos` returns, the form closes.
            self.add = None;
            self.refresh(cx);
            return;
        };
        let rx = self.target.send(prompt, SendOpts::default());
        let task = cx.spawn(async move |this, cx| {
            let res = rx.await.ok();
            let _ = this.update(cx, |this, cx| this.add_sent(outcome(res.as_ref()), cx));
        });
        if let Some(add) = self.add.as_mut() {
            add.task = Some(task);
        }
        cx.notify();
    }

    fn add_sent(&mut self, res: Result<(), String>, cx: &mut Context<Self>) {
        match res {
            Ok(()) => {
                self.add = None;
                self.refresh(cx);
            }
            Err(e) => {
                if let Some(add) = self.add.as_mut() {
                    add.form
                        .end_submit(Some(format!("couldn't add todos: {e}")));
                    add.task = None;
                    for i in &add.inputs {
                        i.update(cx, |s, cx| s.set_disabled(false, cx));
                    }
                }
            }
        }
        cx.notify();
    }

    /// One input per row, each over its row's value.
    fn sync_inputs(&mut self, window: &mut Window, cx: &mut Context<Self>) {
        let Some(add) = self.add.as_mut() else { return };
        while add.inputs.len() > add.form.rows.len() {
            add.inputs.pop();
            add.subs.pop();
        }
        while add.inputs.len() < add.form.rows.len() {
            let value = add.form.rows[add.inputs.len()].clone();
            let input = cx.new(|cx| {
                InputState::new(window, cx)
                    .placeholder(ROW_PLACEHOLDER)
                    .default_value(value)
            });
            let sub = cx.subscribe_in(
                &input,
                window,
                |this: &mut Self, input, ev: &InputEvent, window, cx| {
                    let Some(i) = this
                        .add
                        .as_ref()
                        .and_then(|a| a.inputs.iter().position(|e| e == input))
                    else {
                        return;
                    };
                    match ev {
                        InputEvent::Change => this.row_changed(i, cx),
                        InputEvent::PressEnter {
                            secondary: true, ..
                        } => this.row_key(i, FormKey::Submit, window, cx),
                        InputEvent::PressEnter { .. } => {
                            this.row_key(i, FormKey::Enter, window, cx)
                        }
                        _ => {}
                    }
                },
            );
            add.inputs.push(input);
            add.subs.push(sub);
        }
        for (i, input) in add.inputs.iter().enumerate() {
            let want = add.form.rows[i].clone();
            if input.read(cx).value().as_ref() != want.as_str() {
                input.update(cx, |s, cx| s.set_value(want, window, cx));
            }
        }
    }

    fn focus_row(&self, i: usize, window: &mut Window, cx: &mut Context<Self>) {
        if let Some(input) = self.add.as_ref().and_then(|a| a.inputs.get(i)) {
            input.update(cx, |s, cx| s.focus(window, cx));
        }
    }

    /// A row's stop (`stopTask(taskId)`): the rail's own POST, best effort.
    pub fn stop_task(&mut self, task_id: &str) {
        let Some(sid) = self.model.as_ref().and_then(|m| m.session_id.clone()) else {
            return;
        };
        if let Some(req) = rail::stop_task_request(&sid, task_id) {
            drop(self.target.fetch(req));
        }
    }

    /// Stop-all's button: asks first (`confirm(...)`), inline.
    pub fn ask_stop_all(&mut self, cx: &mut Context<Self>) {
        let can = self
            .model
            .as_ref()
            .is_some_and(|m| m.header.stop_all.is_some());
        if can && !self.confirm_stop_all {
            self.confirm_stop_all = true;
            cx.notify();
        }
    }

    /// The confirm's "Stop all": every stoppable task.
    pub fn confirm_stop_all(&mut self, cx: &mut Context<Self>) {
        if !std::mem::take(&mut self.confirm_stop_all) {
            return;
        }
        let ids = self
            .model
            .as_ref()
            .filter(|m| m.header.stop_all.is_some())
            .map(|m| m.stoppable.clone())
            .unwrap_or_default();
        for id in ids {
            self.stop_task(&id);
        }
        cx.notify();
    }

    pub fn cancel_stop_all(&mut self, cx: &mut Context<Self>) {
        if std::mem::take(&mut self.confirm_stop_all) {
            cx.notify();
        }
    }

    /// A loop's × (`onCancelScheduledLoop`): "cancelling…" at once, then
    /// the prompt; `send` reports instead of throwing, so it never rolls
    /// back.
    pub fn cancel_loop(&mut self, loop_id: &str, cx: &mut Context<Self>) {
        let mut prompt = None;
        self.target.read(&mut |s: &ChatState| {
            prompt = s
                .scheduled_loops
                .get(loop_id)
                .map(crate::tasks::scheduled_loop_cancel_prompt);
        });
        let Some(prompt) = prompt else { return };
        if !self.cancelling.insert(loop_id.to_owned()) {
            return;
        }
        drop(self.target.send(prompt, SendOpts::default()));
        self.refresh(cx);
    }

    /// Re-reads the chat; redraws when what shows changed.
    fn refresh(&mut self, cx: &mut Context<Self>) {
        let now = self.clock_ms();
        if now - self.usage_now >= 60_000.0 {
            self.usage_now = now;
        }
        let mut picker_open = false;
        if let Some(st) = &self.status {
            let v = st.read(cx);
            picker_open = v.open() == Some(Popup::Model);
            self.context =
                v.props()
                    .and_then(|p| p.context_percent)
                    .map(|percentage| ContextSummary {
                        percentage,
                        total_tokens: None,
                        max_tokens: None,
                    });
        }
        let target = self.target.clone();
        let utc = self.fixed_now.is_some();
        let mut bound = self.bound_at;
        let mut next = None;
        target.read(&mut |s: &ChatState| {
            // `boundAt`: when a session first showed, then kept.
            if bound.is_none() && s.session_id.as_deref().is_some_and(|x| !x.is_empty()) {
                bound = Some(now);
            }
            let v = RailView {
                prefs: &self.prefs,
                now,
                usage_now: self.usage_now,
                add_open: self.add.is_some(),
                cancelling: &self.cancelling,
                bound_at: bound,
                context: self.context.as_ref(),
            };
            next = Some(if utc {
                rail::rail(s, v, &chrono::Utc)
            } else {
                rail::rail(s, v, &chrono::Local)
            });
        });
        self.bound_at = bound;
        if self
            .model
            .as_ref()
            .is_none_or(|m| m.header.stop_all.is_none())
        {
            self.confirm_stop_all = false;
        }
        if next != self.model || picker_open != self.picker_open {
            self.model = next;
            self.picker_open = picker_open;
            cx.notify();
        }
        self.sync_ticker(cx);
    }

    fn sync_ticker(&mut self, cx: &mut Context<Self>) {
        let needs = self.model.is_some();
        if needs == self.ticker.is_some() {
            return;
        }
        self.ticker = needs.then(|| {
            cx.spawn(async move |this, cx| {
                loop {
                    cx.background_executor().timer(Duration::from_secs(1)).await;
                    let alive = this.update(cx, |this, cx| {
                        this.ticks += 1;
                        if let Some(n) = this.fixed_now.as_mut() {
                            *n += 1000.0;
                        }
                        this.refresh(cx);
                    });
                    if alive.is_err() {
                        break;
                    }
                }
            })
        });
    }
}

impl Render for RailPanel {
    fn render(&mut self, window: &mut Window, cx: &mut Context<Self>) -> impl IntoElement {
        self.renders += 1;
        let c = Colors::of(self.theme);
        let Some(m) = self.model.clone() else {
            return div().into_any_element();
        };
        let width = rail::rail_width(f32::from(window.viewport_size().width));
        let scroll = div()
            .id("rail-scroll")
            .debug_selector(|| "rail-scroll".into())
            .flex()
            .flex_col()
            .flex_1()
            .min_h_0()
            .overflow_y_scroll()
            .px(px(8.))
            .pt(px(8.))
            .pb(px(8.))
            .child(session_card(self, &m.card, &c, cx))
            .child(context_bar(&m.context, &c, cx))
            .child(token_meter(&m.tokens, &c))
            .child(divider(&c))
            .children(m.permission.as_ref().map(|t| permission_pending(t, &c)))
            .child(todos_section(self, &m, &c, window, cx))
            .children(m.tasks.as_ref().map(|s| tasks_section(self, s, &c, cx)))
            .children(m.system.as_ref().map(|s| system_section(self, s, &c, cx)))
            .child(tools_section(self, &m.tools, &c, cx))
            .children(m.loops.as_ref().map(|s| loops_section(self, s, &c, cx)))
            .children(m.running.as_ref().map(|s| running_section(self, s, &c, cx)))
            .when(m.history, |d| d.child(divider(&c)))
            .children(m.earlier.as_ref().map(|s| earlier_section(self, s, &c, cx)))
            .children(m.edits.as_ref().map(|s| edits_section(self, s, &c, cx)))
            .children(m.recent.as_ref().map(|s| recent_section(self, s, &c, cx)));
        div()
            .id("right-rail")
            .debug_selector(|| "right-rail".into())
            .flex()
            .flex_col()
            .h_full()
            .w(px(width))
            .flex_none()
            .border_l_1()
            .border_color(c.border())
            .bg(c.panel())
            .text_color(c.fg())
            .child(header(self, &m.header, &c, cx))
            .when(self.confirm_stop_all, |d| {
                d.child(stop_all_confirm(m.header.stop_all.unwrap_or(0), &c, cx))
            })
            .children(m.plan.as_ref().map(|p| plan_card(p, &c, cx)))
            .child(scroll)
            .into_any_element()
    }
}

fn text(size: f32) -> Div {
    let line = match size as u32 {
        12 => 16.,
        11 => 15.,
        10 => 14.,
        9 => 12.,
        _ => size + 3.,
    };
    div().text_size(px(size)).line_height(px(line))
}

fn mono(size: f32) -> Div {
    text(size).font_family(fonts::MONO)
}

/// `mb-3 border-t border-[var(--border)]/40`.
fn divider(c: &Colors) -> Div {
    div()
        .mb(px(12.))
        .border_t_1()
        .border_color(c.at(Paint::Border, 40.))
}

/// A small icon button (`rounded p-0.5 text-[var(--muted)]`).
fn icon_button(
    name: &str,
    sel_name: String,
    title: &'static str,
    c: &Colors,
    hover: Hsla,
) -> gpui_kit::Stateful<Div> {
    div()
        .id(id(sel_name.clone()))
        .debug_selector(sel(sel_name))
        .flex()
        .flex_none()
        .items_center()
        .justify_center()
        .rounded(px(4.))
        .p(px(2.))
        .cursor_pointer()
        .text_color(c.muted())
        .hover(move |d| d.text_color(hover))
        .children(icon(name, 12., c.muted()))
        .tooltip(tip(title))
}

fn header(this: &RailPanel, h: &Header, c: &Colors, cx: &mut Context<RailPanel>) -> AnyElement {
    let mut row = div()
        .debug_selector(|| "activity-header".into())
        .flex()
        .flex_none()
        .items_center()
        .gap(px(8.))
        .h(px(36.))
        .border_b_1()
        .border_color(c.border())
        .bg(c.panel())
        .px(px(12.))
        .text_size(px(12.))
        .line_height(px(16.))
        .children(icon("Activity", 14., c.accent()))
        .child(div().font_weight(FontWeight::MEDIUM).child("Activity"));
    if h.disconnected {
        row = row.child(
            div()
                .id("activity-disconnected")
                .debug_selector(|| "activity-disconnected".into())
                .flex()
                .items_center()
                .gap(px(4.))
                .text_size(px(10.))
                .font_weight(FontWeight::MEDIUM)
                .text_color(step("amber-300"))
                .children(icon("WifiOff", 12., step("amber-300")))
                .child("Reconnecting\u{2026}")
                .tooltip(tip("Lost the live connection to this session \u{2014} reconnecting. What's shown here may be behind until it's back.")),
        );
    } else if let Some(w) = h.working {
        row = row.children(icon("Loader2", 12., c.accent())).child(
            div()
                .debug_selector(|| "activity-working".into())
                .text_size(px(10.))
                .font_weight(FontWeight::MEDIUM)
                .text_color(c.accent())
                .child(w),
        );
    }
    if let Some(r) = &h.running {
        row = row.child(
            div()
                .id("activity-running-cue")
                .debug_selector(|| "activity-running-cue".into())
                .ml_auto()
                .flex()
                .items_center()
                .gap(px(4.))
                .rounded(px(4.))
                .px(px(4.))
                .text_size(px(10.))
                .font_weight(FontWeight::MEDIUM)
                .text_color(c.accent())
                .cursor_pointer()
                .hover(|d| d.bg(c.at(Paint::Panel2, 100.)))
                .children(icon(
                    if r.agents { "Bot" } else { "Terminal" },
                    12.,
                    c.accent(),
                ))
                .child(format!("{} running", r.count))
                .tooltip(tip(r.title))
                .on_click(cx.listener(|this, _, _, cx| this.reveal_background(cx))),
        );
    }
    if h.stop_all.is_some() {
        row = row.child(
            icon_button(
                "CircleStop",
                "stop-all-tasks".into(),
                "Stop all running tasks",
                c,
                step("red-400"),
            )
            .on_click(cx.listener(|this, _, _, cx| this.ask_stop_all(cx))),
        );
    }
    let _ = this;
    row.child(
        div()
            .debug_selector(|| "activity-attention".into())
            .text_color(c.muted())
            .map(|d| {
                if h.running.is_some() {
                    d.ml(px(4.))
                } else {
                    d.ml_auto()
                }
            })
            .child(h.attention.to_string()),
    )
    .into_any_element()
}

fn stop_all_confirm(n: usize, c: &Colors, cx: &mut Context<RailPanel>) -> AnyElement {
    let button = |name: &'static str, label: &'static str| {
        div()
            .id(name)
            .debug_selector(move || name.into())
            .rounded(px(4.))
            .px(px(8.))
            .py(px(2.))
            .cursor_pointer()
            .child(label)
    };
    div()
        .debug_selector(|| "stop-all-confirm".into())
        .flex()
        .flex_none()
        .items_center()
        .gap(px(6.))
        .border_b_1()
        .border_color(step_a("red-500", 30.))
        .bg(step_a("red-500", 10.))
        .px(px(12.))
        .py(px(6.))
        .text_size(px(11.))
        .line_height(px(15.))
        .text_color(step("red-200"))
        .child(div().flex_1().min_w_0().child(rail::stop_all_question(n)))
        .child(
            button("stop-all-yes", "Stop all")
                .bg(step_a("red-500", 30.))
                .font_weight(FontWeight::MEDIUM)
                .on_click(cx.listener(|this, _, _, cx| this.confirm_stop_all(cx))),
        )
        .child(
            button("stop-all-no", "Cancel")
                .text_color(c.muted())
                .on_click(cx.listener(|this, _, _, cx| this.cancel_stop_all(cx))),
        )
        .into_any_element()
}

// ------------------------------------------------------------- plan usage

/// `CARD_TONES` and the card's text color (`currentColor`).
fn card_look(c: &Colors, t: UsageTone) -> (Hsla, Hsla, Hsla) {
    match t {
        UsageTone::Ok => (c.border(), c.at(Paint::Panel2, 40.), c.fg()),
        UsageTone::Warning => (
            step_a("amber-500", 30.),
            step_a("amber-500", 10.),
            step("amber-200"),
        ),
        UsageTone::Rejected => (
            step_a("red-500", 30.),
            step_a("red-500", 10.),
            step("red-200"),
        ),
    }
}

/// `BAR_TONES`.
fn bar_tone(t: UsageTone) -> Hsla {
    match t {
        UsageTone::Ok => step("emerald-500"),
        UsageTone::Warning => step("amber-400"),
        UsageTone::Rejected => step("red-500"),
    }
}

fn with_alpha(h: Hsla, a: f32) -> Hsla {
    Hsla { a: h.a * a, ..h }
}

fn plan_card(p: &PlanCard, c: &Colors, cx: &mut Context<RailPanel>) -> AnyElement {
    let wrap = div().flex_none().mx(px(8.)).mt(px(8.));
    match p {
        PlanCard::Collapsed {
            worst,
            stale,
            shown,
            title,
        } => {
            let (border, bg, fg) = card_look(c, *worst);
            let icon_el = if *worst == UsageTone::Ok {
                icon("Gauge", 12., with_alpha(fg, 0.7))
            } else {
                icon("AlertTriangle", 12., fg)
            };
            wrap.child(
                div()
                    .id("plan-usage-card")
                    .debug_selector(|| "plan-usage-card".into())
                    .flex()
                    .w_full()
                    .items_center()
                    .gap(px(6.))
                    .rounded(px(6.))
                    .border_1()
                    .border_color(border)
                    .bg(bg)
                    .text_color(fg)
                    .px(px(8.))
                    .py(px(6.))
                    .text_size(px(11.))
                    .line_height(px(15.))
                    .cursor_pointer()
                    .children(icon_el)
                    .child(div().font_weight(FontWeight::MEDIUM).child("Usage"))
                    .child(
                        div()
                            .ml_auto()
                            .flex()
                            .min_w_0()
                            .items_baseline()
                            .gap(px(8.))
                            .when(*stale, |d| d.opacity(0.6))
                            .children(shown.iter().map(mini_window)),
                    )
                    .children(icon("ChevronDown", 12., with_alpha(fg, 0.6)))
                    .tooltip(tip(title.clone()))
                    .on_click(cx.listener(|this, _, _, cx| this.set_plan_collapsed(false, cx))),
            )
            .into_any_element()
        }
        PlanCard::Open {
            worst,
            stale,
            subscription,
            as_of,
            rows,
            sonnet,
            effort,
            threshold,
        } => {
            let (border, bg, fg) = card_look(c, *worst);
            let icon_el = if *worst == UsageTone::Ok {
                icon("Gauge", 12., with_alpha(fg, 0.7))
            } else {
                icon("AlertTriangle", 12., fg)
            };
            let lever = |name: &'static str, label: &'static str| {
                div()
                    .id(name)
                    .debug_selector(move || name.into())
                    .rounded(px(4.))
                    .border_1()
                    .border_color(with_alpha(fg, 0.3))
                    .bg(with_alpha(fg, 0.1))
                    .px(px(4.))
                    .font_weight(FontWeight::MEDIUM)
                    .cursor_pointer()
                    .child(label)
            };
            let levers = (*sonnet || *effort || *threshold).then(|| {
                div()
                    .mt(px(6.))
                    .flex()
                    .flex_wrap()
                    .items_center()
                    .gap(px(4.))
                    .border_t_1()
                    .border_color(with_alpha(fg, 0.1))
                    .pt(px(6.))
                    .child(div().opacity(0.7).child("Slow your burn:"))
                    .when(*sonnet, |d| {
                        d.child(
                            lever("plan-usage-sonnet", "/model sonnet")
                                .tooltip(tip(format!("Switch this session to {SONNET_TARGET}")))
                                .on_click(cx.listener(|this, _, _, _| this.pick_sonnet())),
                        )
                    })
                    .when(*effort, |d| {
                        d.child(
                            lever("plan-usage-effort", "/effort medium")
                                .tooltip(tip("Step reasoning effort down to medium"))
                                .on_click(cx.listener(|this, _, _, _| this.pick_effort_medium())),
                        )
                    })
                    .when(*threshold, |d| {
                        d.child(
                            lever("plan-usage-threshold", "change threshold").tooltip(tip(
                                "Change the utilization % at which usage warnings fire",
                            )),
                        )
                    })
            });
            wrap.child(
                div()
                    .debug_selector(|| "plan-usage-card".into())
                    .rounded(px(6.))
                    .border_1()
                    .border_color(border)
                    .bg(bg)
                    .text_color(fg)
                    .px(px(8.))
                    .py(px(6.))
                    .text_size(px(10.))
                    .line_height(px(16.))
                    .child(
                        div()
                            .mb(px(4.))
                            .flex()
                            .items_center()
                            .gap(px(6.))
                            .children(icon_el)
                            .child(div().font_weight(FontWeight::MEDIUM).child("Usage"))
                            .children(subscription.as_ref().map(|s| {
                                div()
                                    .debug_selector(|| "plan-usage-subscription".into())
                                    .rounded(px(4.))
                                    .border_1()
                                    .border_color(with_alpha(fg, 0.2))
                                    .px(px(4.))
                                    .text_size(px(9.))
                                    .opacity(0.7)
                                    .child(s.clone())
                            }))
                            .child(
                                div()
                                    .ml_auto()
                                    .flex()
                                    .items_center()
                                    .gap(px(6.))
                                    .children(as_of.as_ref().map(|t| {
                                        div()
                                            .id("plan-usage-as-of")
                                            .opacity(0.7)
                                            .child(t.clone())
                                            .tooltip(tip("The usage endpoint didn't respond on the last attempt \u{2014} showing the last known values."))
                                    }))
                                    .child(
                                        div()
                                            .id("plan-usage-minimize")
                                            .debug_selector(|| "plan-usage-minimize".into())
                                            .rounded(px(4.))
                                            .p(px(2.))
                                            .opacity(0.7)
                                            .cursor_pointer()
                                            .children(icon("Minus", 12., fg))
                                            .tooltip(tip("Minimize to one line"))
                                            .on_click(cx.listener(|this, _, _, cx| {
                                                this.set_plan_collapsed(true, cx)
                                            })),
                                    ),
                            ),
                    )
                    .child(
                        div()
                            .flex()
                            .flex_col()
                            .gap(px(6.))
                            .when(*stale, |d| d.opacity(0.6))
                            .children(rows.iter().map(|r| usage_row(r, c, fg))),
                    )
                    .children(levers),
            )
            .into_any_element()
        }
    }
}

fn mini_window(w: &MiniWindow) -> Div {
    let tone = match w.tone {
        UsageTone::Ok => None,
        UsageTone::Warning => Some(step("amber-300")),
        UsageTone::Rejected => Some(step("red-400")),
    };
    div()
        .debug_selector(sel(format!("plan-usage-mini-window-{}", w.key)))
        .flex()
        .items_baseline()
        .gap(px(4.))
        .whitespace_nowrap()
        .child(div().opacity(0.7).child(w.label.clone()))
        .child(
            div()
                .font_family(fonts::MONO)
                .font_weight(FontWeight::MEDIUM)
                .when_some(tone, |d, t| d.text_color(t))
                .child(w.value.clone()),
        )
}

fn usage_row(r: &UsageRow, c: &Colors, fg: Hsla) -> Div {
    div()
        .debug_selector(sel(format!("plan-usage-window-{}", r.key)))
        .child(
            div()
                .flex()
                .items_baseline()
                .justify_between()
                .gap(px(8.))
                .child(div().truncate().child(r.label.clone()))
                .child(
                    div()
                        .flex_none()
                        .font_family(fonts::MONO)
                        .font_weight(FontWeight::MEDIUM)
                        .child(r.value.clone()),
                ),
        )
        .child(
            div()
                .mt(px(2.))
                .h(px(4.))
                .w_full()
                .overflow_hidden()
                .rounded_full()
                .bg(c.panel())
                .child(
                    div()
                        .debug_selector(sel(format!("plan-usage-bar-{}", r.key)))
                        .h_full()
                        .rounded_full()
                        .bg(bar_tone(r.tone))
                        .w(gpui_kit::relative((r.bar_pct / 100.0) as f32)),
                ),
        )
        .children(r.reset.as_ref().map(|(at, countdown)| {
            div()
                .mt(px(2.))
                .flex()
                .items_center()
                .gap(px(4.))
                .opacity(0.7)
                .children(icon("Timer", 10., fg))
                .child(
                    div()
                        .debug_selector(sel(format!("plan-usage-reset-{}", r.key)))
                        .flex()
                        .min_w_0()
                        .truncate()
                        .child(at.clone())
                        .children(countdown.as_ref().map(|cd| {
                            div()
                                .flex()
                                .child(" \u{b7} ")
                                .child(div().font_family(fonts::MONO).child(cd.clone()))
                        })),
                )
        }))
}

// ------------------------------------------------------------ the card

fn pill(c: &Colors, look: Option<Look>) -> Div {
    let (border, bg, fg) = match look {
        Some(l) => (c.ink(l.border), c.ink(l.bg), c.ink(l.text)),
        None => (c.border(), c.panel(), c.muted()),
    };
    div()
        .flex()
        .flex_none()
        .items_center()
        .gap(px(4.))
        .whitespace_nowrap()
        .rounded(px(4.))
        .border_1()
        .border_color(border)
        .bg(bg)
        .text_color(fg)
        .px(px(6.))
        .text_size(px(9.))
        .line_height(px(13.))
}

fn session_card(this: &RailPanel, k: &Card, c: &Colors, cx: &mut Context<RailPanel>) -> AnyElement {
    let picker = this.status.is_some();
    let open = this.picker_open;
    let head = div()
        .child(
            div()
                .flex()
                .items_center()
                .gap(px(6.))
                .children(icon("CircuitBoard", 12., c.accent()))
                .child(
                    div()
                        .debug_selector(|| "session-card-model".into())
                        .min_w_0()
                        .truncate()
                        .font_family(fonts::MONO)
                        .child(k.model.clone()),
                )
                .when(picker, |d| {
                    d.child(
                        div()
                            .ml_auto()
                            .flex_none()
                            .debug_selector(|| "session-card-chevron".into())
                            .children(icon(
                                if open { "ChevronUp" } else { "ChevronDown" },
                                12.,
                                c.muted(),
                            )),
                    )
                }),
        )
        .child(
            div()
                .mt(px(6.))
                .flex()
                .flex_wrap()
                .items_center()
                .gap(px(4.))
                .child(
                    pill(c, None)
                        .id("session-card-effort-pill")
                        .debug_selector(|| "session-card-effort-pill".into())
                        .children(icon("Gauge", 10., c.muted()))
                        .child(k.effort.label.unwrap_or_default())
                        .when(k.effort.waits, |d| {
                            d.child(
                                div()
                                    .opacity(0.8)
                                    .child(format!("\u{b7} {}", crate::card::EFFORT_WAIT_NOTE)),
                            )
                        })
                        .tooltip(tip(k.effort.title.clone())),
                )
                .when(k.ultracode, |d| {
                    d.child(
                        pill(
                            c,
                            Some(Look {
                                border: Ink::at(Paint::Accent, 40.),
                                bg: Ink::at(Paint::Accent, 10.),
                                text: Ink::of(Paint::Accent),
                            }),
                        )
                        .id("session-card-ultracode")
                        .children(icon("Workflow", 10., c.accent()))
                        .child("workflows")
                        .tooltip(tip("Dynamic Workflows: xhigh effort + parallel subagents")),
                    )
                })
                .when(k.fast, |d| {
                    d.child(
                        pill(c, Some(Look::tint("amber-500", 30., 10., "amber-200")))
                            .id("session-card-fast")
                            .children(icon("Zap", 10., step("amber-200")))
                            .child("fast")
                            .tooltip(tip("Fast mode: accelerated responses")),
                    )
                })
                .children(k.advisor.as_ref().map(|(label, title)| {
                    pill(c, None)
                        .id("session-card-advisor-pill")
                        .debug_selector(|| "session-card-advisor-pill".into())
                        .children(icon("Lightbulb", 10., c.muted()))
                        .child(format!("advisor: {label}"))
                        .tooltip(tip(title.clone()))
                }))
                .child({
                    let l = k.mode_look;
                    pill(c, Some(l))
                        .debug_selector(|| "session-card-mode-pill".into())
                        .children(icon("ShieldCheck", 10., c.ink(l.text)))
                        .child(k.mode.clone())
                }),
        );
    let head = if picker {
        div()
            .id("model-picker-trigger")
            .debug_selector(|| "model-picker-trigger".into())
            .w_full()
            .rounded_t(px(6.))
            .px(px(8.))
            .pb(px(6.))
            .pt(px(8.))
            .text_size(px(11.))
            .line_height(px(15.))
            .cursor_pointer()
            .when(open, |d| d.bg(c.at(Paint::Panel2, 80.)))
            .hover(|d| d.bg(c.at(Paint::Panel2, 80.)))
            .child(head)
            .on_mouse_down(
                MouseButton::Left,
                cx.listener(|this, _, _, _| this.picker_pressed()),
            )
            .on_click(cx.listener(|this, _, _, cx| this.picker_clicked(cx)))
            .into_any_element()
    } else {
        div()
            .px(px(8.))
            .pb(px(6.))
            .pt(px(8.))
            .text_size(px(11.))
            .line_height(px(15.))
            .child(head)
            .into_any_element()
    };
    div()
        .debug_selector(|| "session-card".into())
        .relative()
        .mb(px(12.))
        .rounded(px(6.))
        .border_1()
        .border_color(c.border())
        .bg(c.at(Paint::Panel2, 40.))
        .child(head)
        .child(
            div()
                .px(px(8.))
                .pb(px(8.))
                .children(k.cwd.as_ref().map(|(short, full)| {
                    div()
                        .id("session-card-cwd")
                        .debug_selector(|| "session-card-cwd".into())
                        .flex()
                        .items_center()
                        .gap(px(4.))
                        .text_size(px(10.))
                        .line_height(px(14.))
                        .text_color(c.muted())
                        .children(icon("Folder", 12., c.muted()))
                        .child(
                            div()
                                .min_w_0()
                                .truncate()
                                .font_family(fonts::MONO)
                                .child(short.clone()),
                        )
                        .tooltip(tip(full.clone()))
                }))
                .child(
                    div()
                        .debug_selector(|| "session-card-metrics".into())
                        .flex()
                        .gap(px(12.))
                        .text_size(px(10.))
                        .line_height(px(14.))
                        .text_color(c.muted())
                        .when(k.cwd.is_some(), |d| d.mt(px(4.)))
                        .child(k.turns.clone())
                        .child(
                            div()
                                .debug_selector(|| "session-card-elapsed".into())
                                .child(k.elapsed.clone()),
                        ),
                ),
        )
        .into_any_element()
}

fn context_bar(k: &ContextBar, c: &Colors, cx: &mut Context<RailPanel>) -> AnyElement {
    div()
        .id("context-bar")
        .debug_selector(|| "context-bar".into())
        .mb(px(12.))
        .w_full()
        .rounded(px(6.))
        .border_1()
        .border_color(c.border())
        .bg(c.at(Paint::Panel2, 40.))
        .px(px(8.))
        .py(px(6.))
        .cursor_pointer()
        .hover(|d| d.bg(c.at(Paint::Panel2, 80.)))
        .child(
            div()
                .mb(px(4.))
                .flex()
                .items_center()
                .justify_between()
                .text_size(px(10.))
                .line_height(px(14.))
                .text_color(c.muted())
                .child("Context")
                .child(
                    div()
                        .debug_selector(|| "context-bar-label".into())
                        .font_family(fonts::MONO)
                        .child(k.label.clone()),
                ),
        )
        .child(
            div()
                .h(px(6.))
                .w_full()
                .overflow_hidden()
                .rounded_full()
                .bg(c.panel())
                .child(
                    div()
                        .debug_selector(|| "context-bar-fill".into())
                        .h_full()
                        .bg(c.ink(k.fill))
                        .w(gpui_kit::relative((k.width_pct / 100.0) as f32)),
                ),
        )
        .tooltip(tip(k.title.clone()))
        .on_click(cx.listener(|_, _, _, cx| cx.emit(RailEvent::OpenContext)))
        .into_any_element()
}

fn token_meter(tiles: &[(&'static str, String); 4], c: &Colors) -> AnyElement {
    div()
        .mb(px(12.))
        .flex()
        .gap(px(4.))
        .children(tiles.iter().map(|(label, value)| {
            let accent = *label == "$";
            let name = if accent { "cost" } else { label };
            div()
                .debug_selector(sel(format!("token-tile-{name}")))
                .flex_1()
                .min_w_0()
                .rounded(px(6.))
                .border_1()
                .map(|d| {
                    if accent {
                        d.border_color(c.at(Paint::Accent, 30.))
                            .bg(c.at(Paint::Accent, 5.))
                    } else {
                        d.border_color(c.border()).bg(c.at(Paint::Panel2, 50.))
                    }
                })
                .px(px(6.))
                .py(px(4.))
                .child(
                    div()
                        .text_size(px(8.))
                        .line_height(px(11.))
                        .text_color(c.muted())
                        .child(upper(label)),
                )
                .child(
                    div()
                        .debug_selector(sel(format!("token-tile-{name}-value")))
                        .font_family(fonts::MONO)
                        .text_size(px(11.))
                        .line_height(px(11.))
                        .child(value.clone()),
                )
        }))
        .into_any_element()
}

fn permission_pending(tool: &str, _c: &Colors) -> AnyElement {
    div()
        .debug_selector(|| "permission-pending".into())
        .mb(px(12.))
        .rounded(px(6.))
        .border_1()
        .border_color(step_a("amber-500", 30.))
        .bg(step_a("amber-500", 10.))
        .px(px(8.))
        .py(px(6.))
        .text_color(step("amber-200"))
        .child(
            text(11.)
                .flex()
                .items_center()
                .gap(px(6.))
                .children(icon("Hourglass", 12., step("amber-200")))
                .child(
                    div()
                        .min_w_0()
                        .truncate()
                        .child("Waiting on your approval \u{2014} open prompt"),
                ),
        )
        .child(
            mono(10.)
                .mt(px(2.))
                .truncate()
                .opacity(0.8)
                .child(tool.to_owned()),
        )
        .into_any_element()
}

// -------------------------------------------------------------- sections

fn section<T>(
    s: &Section<T>,
    c: &Colors,
    action: Option<AnyElement>,
    body: impl FnOnce() -> AnyElement,
    cx: &mut Context<RailPanel>,
) -> AnyElement {
    let key = s.key;
    div()
        .debug_selector(sel(format!("activity-section-{key}")))
        .mb(px(12.))
        .child(
            div()
                .flex()
                .items_center()
                .gap(px(4.))
                .pb(px(4.))
                .text_size(px(10.))
                .line_height(px(14.))
                .text_color(c.muted())
                .child(
                    div()
                        .id(id(format!("activity-section-toggle-{key}")))
                        .debug_selector(sel(format!("activity-section-toggle-{key}")))
                        .flex()
                        .flex_1()
                        .items_center()
                        .gap(px(4.))
                        .px(px(4.))
                        .cursor_pointer()
                        .hover(|d| d.text_color(c.fg()))
                        .children(icon(
                            if s.collapsed {
                                "ChevronRight"
                            } else {
                                "ChevronDown"
                            },
                            12.,
                            c.muted(),
                        ))
                        .child(upper(s.label))
                        .children(s.badge.as_ref().map(|b| div().ml(px(4.)).child(b.clone())))
                        .on_click(cx.listener(move |this, _, _, cx| this.toggle_section(key, cx))),
                )
                .children(
                    action.map(|a| div().flex().flex_none().items_center().pr(px(4.)).child(a)),
                ),
        )
        .when(!s.collapsed, |d| d.child(body()))
        .into_any_element()
}

fn list(gap: f32) -> Div {
    div().flex().flex_col().gap(px(gap))
}

fn todos_section(
    this: &RailPanel,
    m: &RailModel,
    c: &Colors,
    window: &mut Window,
    cx: &mut Context<RailPanel>,
) -> AnyElement {
    let s = &m.todos;
    let add_open = s.body.add_open;
    let mini = |name: &str, sel_name: &str, title: &str, on: bool| {
        div()
            .id(id(sel_name.to_owned()))
            .debug_selector(sel(sel_name.to_owned()))
            .flex()
            .items_center()
            .justify_center()
            .size(px(16.))
            .rounded(px(4.))
            .cursor_pointer()
            .when(on, |d| d.bg(c.at(Paint::Panel2, 100.)))
            .hover(|d| d.bg(c.at(Paint::Panel2, 100.)))
            .children(icon(name, 12., if on { c.fg() } else { c.muted() }))
            .tooltip(tip(title.to_owned()))
    };
    let action = div()
        .flex()
        .items_center()
        .gap(px(2.))
        .when(s.body.clear, |d| {
            d.child(
                mini(
                    "Eraser",
                    "todos-clear-button",
                    "Clear this list \u{2014} the agent will start fresh next time it tracks todos",
                    false,
                )
                .on_click(cx.listener(|this, _, _, _| this.clear_todos())),
            )
        })
        .child(
            mini(
                "Plus",
                "todos-add-button",
                "Add tasks (asks the agent to update its todo list)",
                add_open,
            )
            .on_click(cx.listener(|this, _, window, cx| this.toggle_add(window, cx))),
        )
        .into_any_element();
    let form = this.add.as_ref().map(|a| add_form(a, c, window, cx));
    let rows: Vec<AnyElement> = s
        .body
        .rows
        .iter()
        .map(|r| {
            let (tid, did) = (r.id.clone(), r.id.clone());
            let group = format!("rail-todo-{}", r.id);
            div()
                .group(group.clone())
                .debug_selector(sel(format!("rail-todo-{}-{}", r.status, r.id)))
                .flex()
                .items_start()
                .gap(px(6.))
                .rounded(px(6.))
                .border_1()
                .border_color(c.border())
                .bg(c.at(Paint::Panel2, 40.))
                .px(px(8.))
                .py(px(6.))
                .text_size(px(11.))
                .line_height(px(14.))
                .child(
                    div()
                        .id(id(format!("rail-todo-toggle-{}", r.id)))
                        .debug_selector(sel(format!("rail-todo-toggle-{}", r.id)))
                        .flex_none()
                        .mt(px(1.))
                        .cursor_pointer()
                        .children(icon(r.icon, 12., c.ink(r.ink)))
                        .tooltip(tip(r.toggle.1))
                        .on_click(cx.listener(move |this, _, _, cx| this.toggle_todo(&tid, cx))),
                )
                .child(
                    div()
                        .debug_selector(sel(format!("rail-todo-text-{}", r.id)))
                        .min_w_0()
                        .flex_1()
                        .when(r.done, |d| d.line_through().opacity(0.6))
                        .child(r.text.clone()),
                )
                .child(
                    div()
                        .id(id(format!("rail-todo-delete-{}", r.id)))
                        .debug_selector(sel(format!("rail-todo-delete-{}", r.id)))
                        .flex_none()
                        .rounded(px(2.))
                        .p(px(2.))
                        .cursor_pointer()
                        .invisible()
                        .group_hover(group, |s| s.visible())
                        .children(icon("X", 12., c.muted()))
                        .tooltip(tip("Delete this item from the list"))
                        .on_click(cx.listener(move |this, _, _, _| this.delete_todo(&did))),
                )
                .into_any_element()
        })
        .collect();
    let empty = s.body.empty;
    div()
        .debug_selector(|| "rail-todos".into())
        .child(section(
            s,
            c,
            Some(action),
            move || {
                div()
                    .children(form)
                    .when(!rows.is_empty(), |d| d.child(list(4.).children(rows)))
                    .when(empty, |d| {
                        d.child(
                            div()
                                .debug_selector(|| "todos-empty".into())
                                .px(px(4.))
                                .py(px(4.))
                                .text_size(px(10.))
                                .line_height(px(14.))
                                .text_color(c.muted())
                                .child(crate::todos::TODOS_EMPTY),
                        )
                    })
                    .into_any_element()
            },
            cx,
        ))
        .into_any_element()
}

fn add_form(
    a: &AddTodos,
    c: &Colors,
    _window: &mut Window,
    cx: &mut Context<RailPanel>,
) -> AnyElement {
    let f = &a.form;
    let many = f.rows.len() > 1;
    let rows: Vec<AnyElement> = a
        .inputs
        .iter()
        .enumerate()
        .map(|(i, input)| {
            div()
                .flex()
                .items_center()
                .gap(px(4.))
                .child(
                    div()
                        .text_size(px(10.))
                        .text_color(c.muted())
                        .child(format!("{}.", i + 1)),
                )
                .child(
                    div()
                        .debug_selector(sel(format!("add-todo-input-{i}")))
                        .min_w_0()
                        .flex_1()
                        .capture_key_down(cx.listener(
                            move |this, ev: &gpui_kit::KeyDownEvent, window, cx| {
                                let key = ev.keystroke.key.as_str();
                                let empty = this
                                    .add
                                    .as_ref()
                                    .and_then(|a| a.form.rows.get(i))
                                    .is_some_and(String::is_empty);
                                if key == "escape" {
                                    cx.stop_propagation();
                                    this.row_key(i, FormKey::Escape, window, cx);
                                } else if key == "backspace" && empty {
                                    cx.stop_propagation();
                                    this.row_key(i, FormKey::Backspace, window, cx);
                                }
                            },
                        ))
                        .child(Input::new(input).h(px(24.)).text_size(px(11.))),
                )
                .when(many, |d| {
                    d.child(
                        icon_button(
                            "X",
                            format!("add-todo-remove-{i}"),
                            "Remove task",
                            c,
                            step("red-400"),
                        )
                        .on_click(
                            cx.listener(move |this, _, window, cx| this.remove_row(i, window, cx)),
                        ),
                    )
                })
                .into_any_element()
        })
        .collect();
    let can = f.can_submit();
    div()
        .debug_selector(|| "add-todos-form".into())
        .mb(px(4.))
        .flex()
        .flex_col()
        .gap(px(4.))
        .rounded(px(6.))
        .border_1()
        .border_color(c.border())
        .bg(c.at(Paint::Panel2, 50.))
        .p(px(8.))
        .child(list(4.).children(rows))
        .child(
            div()
                .id("add-todo-another")
                .debug_selector(|| "add-todo-another".into())
                .mt(px(4.))
                .flex()
                .items_center()
                .gap(px(4.))
                .rounded(px(4.))
                .px(px(4.))
                .text_size(px(10.))
                .line_height(px(14.))
                .text_color(c.muted())
                .cursor_pointer()
                .children(icon("Plus", 12., c.muted()))
                .child("Add another")
                .on_click(cx.listener(|this, _, window, cx| {
                    if !this.add.as_ref().is_some_and(|a| a.form.submitting) {
                        this.add_row(window, cx);
                    }
                })),
        )
        .children(f.error.as_ref().map(|e| {
            div()
                .debug_selector(|| "add-todos-error".into())
                .text_size(px(10.))
                .line_height(px(14.))
                .text_color(step("red-300"))
                .child(e.clone())
        }))
        .child(
            div()
                .mt(px(4.))
                .flex()
                .items_center()
                .gap(px(4.))
                .border_t_1()
                .border_color(c.at(Paint::Border, 40.))
                .pt(px(8.))
                .child(
                    div()
                        .text_size(px(9.))
                        .text_color(c.at(Paint::Muted, 80.))
                        .child("\u{2318}/Ctrl+Enter to send"),
                )
                .child(
                    div()
                        .ml_auto()
                        .flex()
                        .items_center()
                        .gap(px(4.))
                        .child(
                            div()
                                .id("add-todos-cancel")
                                .debug_selector(|| "add-todos-cancel".into())
                                .rounded(px(4.))
                                .px(px(8.))
                                .py(px(2.))
                                .text_size(px(10.))
                                .text_color(c.muted())
                                .cursor_pointer()
                                .child("Cancel")
                                .on_click(cx.listener(|this, _, _, cx| {
                                    if !this.add.as_ref().is_some_and(|a| a.form.submitting) {
                                        this.cancel_add(cx);
                                    }
                                })),
                        )
                        .child(
                            div()
                                .id("add-todos-submit")
                                .debug_selector(|| "add-todos-submit".into())
                                .rounded(px(4.))
                                .bg(c.accent())
                                .px(px(8.))
                                .py(px(2.))
                                .text_size(px(10.))
                                .font_weight(FontWeight::MEDIUM)
                                .text_color(gpui_kit::white())
                                .when(!can, |d| d.opacity(0.4))
                                .when(can, |d| d.cursor_pointer())
                                .child(if f.submitting {
                                    "Adding\u{2026}"
                                } else {
                                    "Add"
                                })
                                .on_click(cx.listener(move |this, _, _, cx| {
                                    if can {
                                        this.submit_add(cx);
                                    }
                                })),
                        ),
                ),
        )
        .into_any_element()
}

fn stop_button(
    sel_name: String,
    title: &'static str,
    task_id: String,
    c: &Colors,
    cx: &mut Context<RailPanel>,
) -> AnyElement {
    icon_button("CircleStop", sel_name, title, c, step("red-400"))
        .on_click(cx.listener(move |this, _, _, _| this.stop_task(&task_id)))
        .into_any_element()
}

fn tasks_section(
    _this: &RailPanel,
    s: &Section<Vec<TaskRow>>,
    c: &Colors,
    cx: &mut Context<RailPanel>,
) -> AnyElement {
    let rows: Vec<AnyElement> = s.body.iter().map(|t| task_row(t, c, cx)).collect();
    section(
        s,
        c,
        None,
        move || list(4.).children(rows).into_any_element(),
        cx,
    )
}

fn task_row(t: &TaskRow, c: &Colors, cx: &mut Context<RailPanel>) -> AnyElement {
    let fg = c.ink(t.look.text);
    boxed(c, t.look)
        .debug_selector(sel(format!("task-row-{}", t.task_id)))
        .px(px(8.))
        .py(px(6.))
        .child(
            text(12.)
                .flex()
                .items_center()
                .gap(px(6.))
                .children(icon(t.icon, 12., fg))
                .child(mono(12.).min_w_0().truncate().child(t.name.clone()))
                .children(t.nesting.as_ref().map(|(badge, title)| {
                    div()
                        .id(id(format!("task-nesting-{}", t.task_id)))
                        .flex_none()
                        .rounded(px(4.))
                        .border_1()
                        .border_color(with_alpha(fg, 0.3))
                        .px(px(4.))
                        .text_size(px(9.))
                        .font_weight(FontWeight::MEDIUM)
                        .opacity(0.8)
                        .child(badge.clone())
                        .tooltip(tip(title.clone()))
                }))
                .child(
                    div()
                        .id(id(format!("task-status-{}", t.task_id)))
                        .debug_selector(sel(format!("task-status-{}", t.task_id)))
                        .ml_auto()
                        .text_size(px(10.))
                        .child(t.status.text.clone())
                        .when_some(t.status.title, |d, title| d.tooltip(tip(title))),
                )
                .when(t.stoppable, |d| {
                    d.child(stop_button(
                        format!("task-stop-{}", t.task_id),
                        "Stop this task",
                        t.task_id.clone(),
                        c,
                        cx,
                    ))
                }),
        )
        .children(t.description.as_ref().map(|d| {
            text(10.)
                .mt(px(2.))
                .line_clamp(2)
                .opacity(0.8)
                .child(d.clone())
        }))
        .children(t.summary.as_ref().map(|d| {
            text(10.)
                .mt(px(2.))
                .line_clamp(2)
                .italic()
                .opacity(0.7)
                .child(d.clone())
        }))
        .children(t.output_file.as_ref().map(|f| {
            mono(10.)
                .mt(px(2.))
                .truncate()
                .opacity(0.6)
                .child(format!("output: {f}"))
        }))
        .child(
            text(10.)
                .mt(px(4.))
                .flex()
                .flex_wrap()
                .gap(px(8.))
                .opacity(0.7)
                .children(t.model.clone())
                .children(t.tokens.clone())
                .children(t.tools.clone())
                .children(t.elapsed.as_ref().map(|e| {
                    div()
                        .debug_selector(sel(format!("task-elapsed-{}", t.task_id)))
                        .child(e.clone())
                }))
                .children(t.last_tool.clone()),
        )
        .into_any_element()
}

fn system_section(
    _this: &RailPanel,
    s: &Section<Vec<SystemRow>>,
    c: &Colors,
    cx: &mut Context<RailPanel>,
) -> AnyElement {
    let rows: Vec<AnyElement> = s
        .body
        .iter()
        .map(|t| {
            div()
                .debug_selector(sel(format!("system-task-row-{}", t.task_id)))
                .flex()
                .items_center()
                .gap(px(6.))
                .rounded(px(6.))
                .border_1()
                .border_color(c.border())
                .bg(c.at(Paint::Panel2, 40.))
                .px(px(8.))
                .py(px(4.))
                .text_size(px(10.))
                .line_height(px(14.))
                .text_color(c.muted())
                .children(icon(t.icon, 12., c.muted()))
                .child(
                    div()
                        .min_w_0()
                        .truncate()
                        .font_family(fonts::MONO)
                        .child(t.text.clone()),
                )
                .child(div().ml_auto().flex_none().child(t.status.clone()))
                .into_any_element()
        })
        .collect();
    section(
        s,
        c,
        None,
        move || list(4.).children(rows).into_any_element(),
        cx,
    )
}

fn tools_section(
    _this: &RailPanel,
    s: &Section<Vec<ToolRow>>,
    c: &Colors,
    cx: &mut Context<RailPanel>,
) -> AnyElement {
    let rows: Vec<AnyElement> = s.body.iter().map(|e| tool_row(e, c)).collect();
    let muted = c.muted();
    section(
        s,
        c,
        None,
        move || {
            if rows.is_empty() {
                div()
                    .debug_selector(|| "tools-empty".into())
                    .px(px(8.))
                    .py(px(12.))
                    .flex()
                    .justify_center()
                    .text_size(px(10.))
                    .text_color(muted)
                    .child("No tools used yet.")
                    .into_any_element()
            } else {
                div()
                    .id("rail-tools-list")
                    .max_h(px(256.))
                    .overflow_y_scroll()
                    .pr(px(4.))
                    .flex()
                    .flex_col()
                    .gap(px(4.))
                    .children(rows)
                    .into_any_element()
            }
        },
        cx,
    )
}

fn tool_row(e: &ToolRow, c: &Colors) -> AnyElement {
    boxed(c, e.look)
        .id(id(format!("tool-row-{}", e.tool_use_id)))
        .debug_selector(sel(format!("tool-row-{}", e.tool_use_id)))
        .flex_none()
        .px(px(8.))
        .py(px(6.))
        .when(e.dim, |d| d.opacity(0.6))
        .child(
            text(12.)
                .flex()
                .items_center()
                .gap(px(6.))
                .children(icon(e.status_icon, 12., c.ink(e.icon_ink)))
                .children(icon(e.kind_icon, 12., with_alpha(c.muted(), 0.7)))
                .child(mono(12.).min_w_0().truncate().child(e.name.clone()))
                .children(e.thinking_tokens.as_ref().map(|t| {
                    div()
                        .flex_none()
                        .text_size(px(10.))
                        .text_color(step_a("sky-400", 70.))
                        .child(t.clone())
                }))
                .children(e.elapsed.as_ref().map(|t| {
                    div()
                        .ml_auto()
                        .flex_none()
                        .text_size(px(10.))
                        .text_color(c.muted())
                        .child(t.clone())
                })),
        )
        .children(e.arg.as_ref().map(|a| {
            mono(10.)
                .mt(px(2.))
                .truncate()
                .text_color(c.muted())
                .child(a.clone())
        }))
        .children(e.via.as_ref().map(|v| {
            text(10.)
                .mt(px(2.))
                .text_color(c.muted())
                .opacity(0.6)
                .child(v.clone())
        }))
        .when_some(e.title.clone(), |d, t| d.tooltip(tip(t)))
        .into_any_element()
}

fn chip9(c: &Colors) -> Div {
    div()
        .ml(px(4.))
        .flex_none()
        .rounded(px(4.))
        .bg(c.at(Paint::Panel, 60.))
        .px(px(4.))
        .text_size(px(9.))
        .line_height(px(13.))
        .opacity(0.7)
}

fn loops_section(
    _this: &RailPanel,
    s: &Section<Vec<LoopRow>>,
    c: &Colors,
    cx: &mut Context<RailPanel>,
) -> AnyElement {
    let rows: Vec<AnyElement> = s.body.iter().map(|l| loop_row(l, c, cx)).collect();
    section(
        s,
        c,
        None,
        move || list(4.).children(rows).into_any_element(),
        cx,
    )
}

fn loop_row(l: &LoopRow, c: &Colors, cx: &mut Context<RailPanel>) -> AnyElement {
    let fg = c.ink(l.look.text);
    let lid = l.id.clone();
    boxed(c, l.look)
        .id(id(format!("scheduled-loop-{}", l.id)))
        .debug_selector(sel(format!("scheduled-loop-{}", l.id)))
        .flex_none()
        .px(px(8.))
        .py(px(6.))
        .child(
            text(11.)
                .flex()
                .items_center()
                .gap(px(6.))
                .children(icon(l.icon, 12., fg))
                .child(
                    mono(11.)
                        .debug_selector(sel(format!("scheduled-loop-cadence-{}", l.id)))
                        .min_w_0()
                        .truncate()
                        .child(l.cadence.clone()),
                )
                .when(l.recurring, |d| d.child(chip9(c).child("RECURRING")))
                .children(l.next_fire.as_ref().map(|(t, title)| {
                    chip9(c)
                        .id(id(format!("loop-next-fire-{}", l.id)))
                        .child(t.clone())
                        .tooltip(tip(title.clone()))
                }))
                .when(l.durable, |d| d.child(chip9(c).child("DURABLE")))
                .children(l.noop.as_ref().map(|n| chip9(c).child(upper(n))))
                .children(l.cancel.map(|(_, title)| {
                    div()
                        .id(id(format!("scheduled-loop-cancel-{}", l.id)))
                        .debug_selector(sel(format!("scheduled-loop-cancel-{}", l.id)))
                        .ml_auto()
                        .rounded(px(4.))
                        .p(px(2.))
                        .cursor_pointer()
                        .children(icon("X", 12., c.muted()))
                        .tooltip(tip(title))
                        .on_click(cx.listener(move |this, _, _, cx| this.cancel_loop(&lid, cx)))
                }))
                .children(l.state.map(|s| {
                    div()
                        .debug_selector(sel(format!("scheduled-loop-cancelled-{}", l.id)))
                        .ml_auto()
                        .text_size(px(9.))
                        .opacity(0.6)
                        .child(upper(s))
                })),
        )
        .children(l.prompt_preview.as_ref().map(|p| {
            text(10.)
                .mt(px(2.))
                .line_clamp(2)
                .opacity(0.8)
                .child(p.clone())
        }))
        .child(
            text(9.)
                .mt(px(2.))
                .flex()
                .gap(px(8.))
                .opacity(0.6)
                .child(
                    div()
                        .debug_selector(sel(format!("scheduled-loop-armed-{}", l.id)))
                        .child(l.armed.clone()),
                )
                .children(
                    l.cron
                        .as_ref()
                        .map(|cr| div().font_family(fonts::MONO).child(cr.clone())),
                )
                .children(l.reason.as_ref().map(|r| {
                    div()
                        .min_w_0()
                        .truncate()
                        .italic()
                        .child(format!("\u{b7} {r}"))
                })),
        )
        .tooltip(tip(l.title.clone()))
        .into_any_element()
}

fn running_section(
    _this: &RailPanel,
    s: &Section<crate::rail::RunningBody>,
    c: &Colors,
    cx: &mut Context<RailPanel>,
) -> AnyElement {
    let bashes: Vec<AnyElement> = s.body.bashes.iter().map(|b| bash_row(b, c, cx)).collect();
    let procs: Vec<AnyElement> = s
        .body
        .processes
        .iter()
        .map(|t| process_row(t, c, cx))
        .collect();
    section(
        s,
        c,
        None,
        move || {
            list(4.)
                .debug_selector(|| "activity-running".into())
                .when(!bashes.is_empty(), |d| d.child(list(4.).children(bashes)))
                .when(!procs.is_empty(), |d| d.child(list(4.).children(procs)))
                .into_any_element()
        },
        cx,
    )
}

fn badge9(border: &str, text_step: &str) -> Div {
    div()
        .flex_none()
        .rounded(px(2.))
        .border_1()
        .border_color(step_a(border, 40.))
        .bg(step_a(border, 10.))
        .px(px(4.))
        .text_size(px(9.))
        .line_height(px(13.))
        .font_weight(FontWeight::MEDIUM)
        .text_color(step(text_step))
}

fn bash_row(b: &BashRow, c: &Colors, cx: &mut Context<RailPanel>) -> AnyElement {
    let fg = c.ink(b.look.text);
    let tu = b.tool_use_id.clone();
    boxed(c, b.look)
        .debug_selector(sel(format!("bash-row-{}", b.tool_use_id)))
        .px(px(8.))
        .py(px(6.))
        .child(
            text(11.)
                .flex()
                .items_center()
                .gap(px(6.))
                .children(icon("Terminal", 12., fg))
                .child(mono(11.).min_w_0().truncate().child("local_bash"))
                .children(b.timed_out.as_ref().map(|title| {
                    badge9("amber-500", "amber-300")
                        .id(id(format!("bash-timeout-{}", b.tool_use_id)))
                        .debug_selector(sel(format!("bash-timeout-badge-{}", b.tool_use_id)))
                        .child("TIMED OUT")
                        .tooltip(tip(title.clone()))
                }))
                .when(b.ends_with_agent, |d| {
                    d.child(
                        badge9("sky-500", "sky-300")
                            .id(id(format!("bash-ends-{}", b.tool_use_id)))
                            .child("ENDS WITH AGENT")
                            .tooltip(tip("Owned by a synchronous subagent \u{2014} this shell is terminated when that agent gives its final response")),
                    )
                })
                .child(
                    mono(10.)
                        .debug_selector(sel(format!("bash-elapsed-{}", b.tool_use_id)))
                        .ml_auto()
                        .flex_none()
                        .child(b.right.clone()),
                )
                .children(b.stop_task_id.clone().map(|tid| {
                    stop_button(format!("bash-stop-{}", b.tool_use_id), "Stop this shell", tid, c, cx)
                })),
        )
        .child(
            mono(10.)
                .id(id(format!("bash-command-{}", b.tool_use_id)))
                .debug_selector(sel(format!("bash-command-{}", b.tool_use_id)))
                .mt(px(2.))
                .w_full()
                .truncate()
                .opacity(0.9)
                .cursor_pointer()
                .child(b.command.clone())
                .tooltip(tip("Open output viewer"))
                .on_click(cx.listener(move |_, _, _, cx| cx.emit(RailEvent::OpenBash(tu.clone())))),
        )
        .into_any_element()
}

fn process_row(t: &ProcessRow, c: &Colors, cx: &mut Context<RailPanel>) -> AnyElement {
    let fg = c.ink(t.look.text);
    boxed(c, t.look)
        .debug_selector(sel(format!("process-row-{}", t.task_id)))
        .px(px(8.))
        .py(px(6.))
        .child(
            text(12.)
                .flex()
                .items_center()
                .gap(px(6.))
                .children(icon("Activity", 12., fg))
                .child(mono(12.).min_w_0().truncate().child(t.name.clone()))
                .child(
                    div()
                        .id(id(format!("process-status-{}", t.task_id)))
                        .ml_auto()
                        .text_size(px(10.))
                        .child(t.status.text.clone())
                        .when_some(t.status.title, |d, title| d.tooltip(tip(title))),
                )
                .when(t.stoppable, |d| {
                    d.child(stop_button(
                        format!("process-stop-{}", t.task_id),
                        "Stop this process",
                        t.task_id.clone(),
                        c,
                        cx,
                    ))
                }),
        )
        .children(t.description.as_ref().map(|d| {
            text(10.)
                .mt(px(2.))
                .line_clamp(2)
                .opacity(0.8)
                .child(d.clone())
        }))
        .into_any_element()
}

fn earlier_section(
    this: &RailPanel,
    s: &Section<Vec<EarlierRow>>,
    c: &Colors,
    cx: &mut Context<RailPanel>,
) -> AnyElement {
    let wired = this.message_wired;
    let rows: Vec<AnyElement> = s
        .body
        .iter()
        .map(|t| earlier_row(t, wired, c, cx))
        .collect();
    section(
        s,
        c,
        None,
        move || list(4.).children(rows).into_any_element(),
        cx,
    )
}

fn small_button(
    name: String,
    label: &'static str,
    title: &'static str,
    c: &Colors,
) -> gpui_kit::Stateful<Div> {
    div()
        .id(id(name.clone()))
        .debug_selector(sel(name))
        .rounded(px(4.))
        .border_1()
        .border_color(c.border())
        .bg(c.panel())
        .px(px(6.))
        .py(px(2.))
        .text_size(px(10.))
        .line_height(px(14.))
        .text_color(c.muted())
        .cursor_pointer()
        .hover(|d| d.text_color(c.fg()))
        .child(label)
        .tooltip(tip(title))
}

fn earlier_row(t: &EarlierRow, wired: bool, c: &Colors, cx: &mut Context<RailPanel>) -> AnyElement {
    let look = t.look.unwrap_or(Look::quiet(0.));
    let fg = c.ink(look.text);
    let tid = t.task_id.clone();
    boxed(c, look)
        .debug_selector(sel(format!("earlier-subagent-row-{}", t.task_id)))
        .px(px(8.))
        .py(px(4.))
        .text_size(px(10.))
        .line_height(px(14.))
        .child(
            div()
                .flex()
                .items_center()
                .gap(px(6.))
                .children(icon("Bot", 12., fg))
                .child(
                    div()
                        .id(id(format!("earlier-desc-{}", t.task_id)))
                        .min_w_0()
                        .truncate()
                        .font_family(fonts::MONO)
                        .child(t.description.clone())
                        .tooltip(tip(t.description.clone())),
                )
                .child(
                    div()
                        .id(id(format!("earlier-status-{}", t.task_id)))
                        .ml_auto()
                        .flex_none()
                        .child(t.status.text.clone())
                        .when_some(t.status.title, |d, title| d.tooltip(tip(title))),
                ),
        )
        .child(
            div()
                .mt(px(4.))
                .flex()
                .items_center()
                .gap(px(4.))
                .children(t.open.clone().map(|tu| {
                    small_button(
                        format!("earlier-subagent-open-{}", t.task_id),
                        "Open",
                        "Show this subagent's run in the conversation",
                        c,
                    )
                    .on_click(cx.listener(move |_, _, _, cx| cx.emit(RailEvent::OpenTask(tu.clone()))))
                }))
                .when(wired, |d| {
                    d.child(
                        small_button(
                            format!("earlier-subagent-message-{}", t.task_id),
                            "Message",
                            "Ask Claude to send this subagent a message \u{2014} it continues from where it stopped",
                            c,
                        )
                        .on_click(cx.listener(move |_, _, _, cx| {
                            cx.emit(RailEvent::Draft(rail::message_subagent_draft(&tid)))
                        })),
                    )
                }),
        )
        .into_any_element()
}

fn edits_section(
    _this: &RailPanel,
    s: &Section<Vec<EditRow>>,
    c: &Colors,
    cx: &mut Context<RailPanel>,
) -> AnyElement {
    let rows: Vec<AnyElement> = s
        .body
        .iter()
        .map(|r| {
            let ink = c.ink(r.ink);
            div()
                .id(id(format!("recent-edit-{}", r.tool_use_id)))
                .debug_selector(sel(format!("recent-edit-{}", r.tool_use_id)))
                .flex()
                .items_baseline()
                .gap(px(6.))
                .rounded(px(4.))
                .px(px(6.))
                .py(px(2.))
                .text_size(px(11.))
                .line_height(px(15.))
                .text_color(ink)
                .when(r.dim, |d| d.opacity(0.6))
                .hover(|d| d.bg(c.at(Paint::Panel2, 50.)))
                .children(icon("FileEdit", 12., with_alpha(ink, 0.7)))
                .child(
                    div()
                        .min_w_0()
                        .truncate()
                        .font_family(fonts::MONO)
                        .child(r.file_name.clone()),
                )
                .child(
                    div()
                        .ml_auto()
                        .text_size(px(9.))
                        .opacity(0.6)
                        .child(upper(&r.tag)),
                )
                .tooltip(tip(r.title.clone()))
                .into_any_element()
        })
        .collect();
    section(
        s,
        c,
        None,
        move || list(2.).children(rows).into_any_element(),
        cx,
    )
}

fn recent_section(
    _this: &RailPanel,
    s: &Section<Vec<RecentRow>>,
    c: &Colors,
    cx: &mut Context<RailPanel>,
) -> AnyElement {
    let rows: Vec<AnyElement> = s
        .body
        .iter()
        .map(|t| {
            let look = t.look.unwrap_or(Look::quiet(0.));
            let fg = c.ink(look.text);
            boxed(c, look)
                .debug_selector(sel(format!("recent-row-{}", t.task_id)))
                .px(px(8.))
                .py(px(4.))
                .text_size(px(10.))
                .line_height(px(14.))
                .child(
                    div()
                        .flex()
                        .items_center()
                        .gap(px(6.))
                        .children(icon(t.icon, 12., fg))
                        .child(
                            div()
                                .min_w_0()
                                .truncate()
                                .font_family(fonts::MONO)
                                .child(t.description.clone()),
                        )
                        .child(
                            div()
                                .id(id(format!("recent-status-{}", t.task_id)))
                                .ml_auto()
                                .child(t.status.text.clone())
                                .when_some(t.status.title, |d, title| d.tooltip(tip(title))),
                        ),
                )
                .into_any_element()
        })
        .collect();
    section(
        s,
        c,
        None,
        move || list(4.).children(rows).into_any_element(),
        cx,
    )
}
