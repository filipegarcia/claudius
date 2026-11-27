//! The chat's prompt layer: what ChatSurface mounts over and into the chat
//! (ChatSurface.tsx:3091-3185, MessageList.tsx:742, ChatSurface.tsx:2520).
//!
//! - [`PromptOverlays`]: the plan overlay, the permission card, the
//!   elicitation card (only while no permission card is up), the
//!   resurrected ask modal (only while no live ask is) and the toast.
//! - [`InlineAsk`]: the live ask, at the end of the transcript.
//! - [`PlanBanner`](super::PlanBanner): the plan-mode strip.
//!
//! Each reads the chat through its [`PromptTarget`] and answers through it.

use std::rc::Rc;
use std::sync::Arc;
use std::time::{Duration, Instant};

use claudius_gpui_theme::ThemeName;
use futures::StreamExt as _;
use gpui_kit::{
    App, AppContext as _, Context, Entity, InteractiveElement as _, IntoElement, KeyDownEvent,
    ParentElement as _, Render, Styled as _, Subscription, Task, Window, div, px,
};
use serde_json::{Value, json};

use super::ask::{AskEvent, AskView};
use super::elicitation::{ElicitationEvent, ElicitationView};
use super::permission::{PermissionEvent, PermissionView};
use super::plan::{PlanEvent, PlanView};
use super::style::{Colors, h};
use crate::ask::{
    AskKey, AskMode, Reopen, ResurrectedAsk, answers_json, format_ask_as_prompt, questions_of,
    reopen_ask,
};
use crate::elicitation::{ElicitationCard, ElicitationDecision, elicitation_shows, escape_cancels};
use crate::permission::{
    Decision, PermissionAction, PermissionCard, escape_denies, focuses_decline,
};
use crate::plan::PendingPlan;
use crate::target::{PromptState, PromptTarget};

/// `showToast`'s default duration (ChatSurface.tsx:1156).
pub const TOAST_MS: u64 = 2200;

/// The focused text field's text, `None` when the focus isn't a text field
/// (the composer, U07, answers it). `isTypingInField` and the ask modal's
/// `inField` read it.
pub type FieldProbe = Rc<dyn Fn(&Window, &App) -> Option<String>>;

/// Starts listening to a target's changes; `f` runs after each that
/// changed what the cards read ([`PromptState`], and the
/// `disableAutoMode` answer, which can land under a shown card). A
/// streaming reply changes the chat up to 60 times a second and the
/// prompts not at all.
pub(crate) fn listen<T: 'static>(
    target: &Arc<dyn PromptTarget>,
    cx: &mut Context<T>,
    f: fn(&mut T, &mut Context<T>),
) -> Task<()> {
    let mut changes = target.changes();
    let target = target.clone();
    cx.spawn(async move |this, cx| {
        let mut last: Option<(PromptState, bool)> = None;
        while changes.next().await.is_some() {
            let now = (PromptState::read(&*target), target.auto_mode_disabled());
            if last.as_ref() == Some(&now) {
                continue;
            }
            last = Some(now);
            if this.update(cx, f).is_err() {
                break;
            }
        }
    })
}

/// The modal prompts over the chat pane.
pub struct PromptOverlays {
    target: Arc<dyn PromptTarget>,
    colors: Colors,
    state: PromptState,
    permission: Option<Entity<PermissionView>>,
    elicitation: Option<Entity<ElicitationView>>,
    plan: Option<Entity<PlanView>>,
    /// The reopened ask (ChatSurface's `resurrectedAsk`), and its card while
    /// it shows.
    resurrected: Option<ResurrectedAsk>,
    resurrected_view: Option<Entity<AskView>>,
    toast: Option<String>,
    toast_task: Option<Task<()>>,
    /// When each shown request armed (ms on the executor's clock).
    armed: Vec<(String, f64)>,
    epoch: Instant,
    /// A `defaultToNo` permission card waiting to take focus.
    focus_decline: bool,
    field_probe: Option<FieldProbe>,
    /// The links the elicitation card opened (most recent last).
    opened: Vec<String>,
    subs: Vec<(String, Subscription)>,
    _listen: Task<()>,
}

impl PromptOverlays {
    pub fn new(target: Arc<dyn PromptTarget>, theme: ThemeName, cx: &mut Context<Self>) -> Self {
        let listen = listen(&target, cx, Self::sync);
        let mut this = PromptOverlays {
            target,
            colors: Colors::of(theme),
            state: PromptState::default(),
            permission: None,
            elicitation: None,
            plan: None,
            resurrected: None,
            resurrected_view: None,
            toast: None,
            toast_task: None,
            armed: Vec::new(),
            epoch: cx.background_executor().now(),
            focus_decline: false,
            field_probe: None,
            opened: Vec::new(),
            subs: Vec::new(),
            _listen: listen,
        };
        this.sync(cx);
        this
    }

    pub fn set_theme(&mut self, theme: ThemeName, cx: &mut Context<Self>) {
        let colors = Colors::of(theme);
        if colors.background == self.colors.background && colors.dark == self.colors.dark {
            return;
        }
        self.colors = colors;
        if let Some(v) = &self.permission {
            v.update(cx, |v, _| v.set_colors(colors));
        }
        if let Some(v) = &self.elicitation {
            v.update(cx, |v, _| v.set_colors(colors));
        }
        if let Some(v) = &self.plan {
            v.update(cx, |v, _| v.set_colors(colors));
        }
        let label = self.target.session_label();
        if let Some(v) = &self.resurrected_view {
            v.update(cx, |v, _| v.set_colors(colors, label));
        }
        cx.notify();
    }

    /// The composer's seam: what the focused text field holds.
    pub fn set_field_probe(&mut self, probe: FieldProbe) {
        self.field_probe = Some(probe);
    }

    pub fn state(&self) -> &PromptState {
        &self.state
    }

    pub fn permission(&self) -> Option<&Entity<PermissionView>> {
        self.permission.as_ref()
    }

    pub fn elicitation(&self) -> Option<&Entity<ElicitationView>> {
        self.elicitation.as_ref()
    }

    pub fn plan(&self) -> Option<&Entity<PlanView>> {
        self.plan.as_ref()
    }

    pub fn resurrected(&self) -> Option<&Entity<AskView>> {
        self.resurrected_view.as_ref()
    }

    pub fn toast(&self) -> Option<&str> {
        self.toast.as_deref()
    }

    /// The links opened so far.
    pub fn opened(&self) -> &[String] {
        &self.opened
    }

    fn now_ms(&self, cx: &App) -> f64 {
        (cx.background_executor().now() - self.epoch).as_secs_f64() * 1000.
    }

    fn arm(&mut self, request_id: &str, cx: &App) {
        let at = self.now_ms(cx);
        self.armed.retain(|(id, _)| id != request_id);
        self.armed.push((request_id.to_owned(), at));
    }

    fn armed_at(&self, request_id: &str) -> Option<f64> {
        self.armed
            .iter()
            .find(|(id, _)| id == request_id)
            .map(|(_, at)| *at)
    }

    fn unsubscribe(&mut self, key: &str) {
        self.subs.retain(|(k, _)| k != key);
    }

    /// Re-reads the chat and brings the cards in line with it.
    fn sync(&mut self, cx: &mut Context<Self>) {
        let state = PromptState::read(&*self.target);
        let colors = self.colors;

        // The permission card, one per request.
        match &state.permission {
            Some(req) => {
                let card = PermissionCard::new(
                    req,
                    Some(state.permission_count),
                    state.auto_mode_available(self.target.auto_mode_disabled()),
                );
                let same = self
                    .permission
                    .as_ref()
                    .is_some_and(|v| v.read(cx).card.request_id == card.request_id);
                if same {
                    let v = self.permission.clone().expect("checked");
                    v.update(cx, |v, cx| v.refresh(card, cx));
                } else {
                    self.arm(&card.request_id, cx);
                    self.focus_decline = card.default_to_no;
                    let v = cx.new(|cx| PermissionView::new(card, colors, cx));
                    let sub = cx.subscribe(&v, |this: &mut Self, v, e: &PermissionEvent, cx| {
                        let id = v.read(cx).card.request_id.clone();
                        let PermissionEvent::Act(action) = e.clone();
                        this.on_permission(id, action);
                    });
                    self.unsubscribe("permission");
                    self.subs.push(("permission".into(), sub));
                    self.permission = Some(v);
                }
            }
            None => {
                self.permission = None;
                self.focus_decline = false;
                self.unsubscribe("permission");
            }
        }

        // The elicitation card, only while no permission card is up.
        match (
            &state.elicitation,
            elicitation_shows(state.permission.is_some(), state.elicitation.is_some()),
        ) {
            (Some(req), true) => {
                let origin = self.target.own_origin();
                let card =
                    ElicitationCard::new(req, Some(state.elicitation_count), origin.as_deref());
                let same = self
                    .elicitation
                    .as_ref()
                    .is_some_and(|v| v.read(cx).card.request_id == card.request_id);
                if same {
                    let v = self.elicitation.clone().expect("checked");
                    v.update(cx, |v, cx| v.refresh(card, cx));
                } else {
                    self.arm(&format!("elicitation:{}", card.request_id), cx);
                    let v = cx.new(|_| ElicitationView::new(card, colors));
                    let sub = cx.subscribe(&v, |this: &mut Self, v, e: &ElicitationEvent, cx| {
                        let id = v.read(cx).card.request_id.clone();
                        match e.clone() {
                            ElicitationEvent::Resolve(d) => this.resolve_elicitation(id, d),
                            ElicitationEvent::Open(url) => {
                                cx.open_url(&url);
                                this.opened.push(url);
                            }
                        }
                    });
                    self.unsubscribe("elicitation");
                    self.subs.push(("elicitation".into(), sub));
                    self.elicitation = Some(v);
                }
            }
            _ => {
                self.elicitation = None;
                self.unsubscribe("elicitation");
            }
        }

        // The plan overlay, unkeyed while a plan is pending.
        match PendingPlan::from_state(&state.plan) {
            Some(plan) => match &self.plan {
                Some(v) => v.update(cx, |v, cx| v.refresh(plan, cx)),
                None => {
                    let v = cx.new(|_| PlanView::new(plan, colors));
                    let sub = cx.subscribe(&v, |this: &mut Self, _, e: &PlanEvent, cx| {
                        let PlanEvent::Resolve(r) = e.clone();
                        let decision = r.decision.clone();
                        this.target
                            .act(Box::new(move |s, env| s.resolve_plan(&decision, env)));
                        this.show_toast(r.toast.to_owned(), cx);
                    });
                    self.unsubscribe("plan");
                    self.subs.push(("plan".into(), sub));
                    self.plan = Some(v);
                }
            },
            None => {
                self.plan = None;
                self.unsubscribe("plan");
            }
        }

        // Only the shown cards' arm times are kept.
        let mut live = Vec::new();
        if let Some(v) = &self.permission {
            live.push(v.read(cx).card.request_id.clone());
        }
        if let Some(v) = &self.elicitation {
            live.push(format!("elicitation:{}", v.read(cx).card.request_id));
        }
        self.armed.retain(|(id, _)| live.contains(id));

        self.state = state;
        self.sync_resurrected(cx);
        cx.notify();
    }

    /// The resurrected modal shows only while no live ask is in flight; it
    /// unmounts (and loses its picks) while one is.
    fn sync_resurrected(&mut self, cx: &mut Context<Self>) {
        let shows =
            crate::ask::resurrected_shows(self.state.ask.is_some(), self.resurrected.is_some());
        if !shows {
            self.resurrected_view = None;
            self.unsubscribe("resurrected");
            return;
        }
        if self.resurrected_view.is_some() {
            return;
        }
        let r = self.resurrected.clone().expect("shows");
        let (colors, label) = (self.colors, self.target.session_label());
        let v = cx.new(|_| {
            AskView::new(
                r.request_id.clone(),
                r.questions.clone(),
                AskMode::Modal,
                label,
                colors,
            )
        });
        let sub = cx.subscribe(&v, |this: &mut Self, _, e: &AskEvent, cx| {
            let Some(r) = this.resurrected.take() else {
                return;
            };
            if let AskEvent::Submit(answers) = e {
                this.target
                    .send_prompt(format_ask_as_prompt(&r.questions, answers));
            }
            this.sync_resurrected(cx);
            cx.notify();
        });
        self.subs.push(("resurrected".into(), sub));
        self.resurrected_view = Some(v);
    }

    fn on_permission(&mut self, request_id: String, action: PermissionAction) {
        match action {
            PermissionAction::Resolve(d) => {
                let decision = d.to_json();
                self.target.act(Box::new(move |s, env| {
                    s.resolve_permission(&request_id, &decision, env)
                }));
            }
            PermissionAction::SwitchToAutoAndAllow => {
                self.target
                    .act(Box::new(|s, env| s.set_permission_mode("auto", env)));
                let decision = Decision::AllowOnce.to_json();
                self.target.act(Box::new(move |s, env| {
                    s.resolve_permission(&request_id, &decision, env)
                }));
            }
        }
    }

    fn resolve_elicitation(&mut self, request_id: String, d: ElicitationDecision) {
        let decision = d.to_json();
        self.target.act(Box::new(move |s, env| {
            s.resolve_elicitation(&request_id, &decision, env)
        }));
    }

    /// `showToast(msg)`: shown for [`TOAST_MS`]; a newer toast owns the timer.
    pub fn show_toast(&mut self, msg: String, cx: &mut Context<Self>) {
        self.toast = Some(msg);
        let timer = cx
            .background_executor()
            .timer(Duration::from_millis(TOAST_MS));
        self.toast_task = Some(cx.spawn(async move |this, cx| {
            timer.await;
            let _ = this.update(cx, |this, cx| {
                this.toast = None;
                this.toast_task = None;
                cx.notify();
            });
        }));
        cx.notify();
    }

    /// A transcript ask row's "Reopen" (`onReopenAsk`); `true` when the live
    /// ask is the one asked for (the caller scrolls it into view).
    pub fn reopen_ask(&mut self, tool_use_id: &str, input: &Value, cx: &mut Context<Self>) -> bool {
        let live = self
            .state
            .ask
            .as_ref()
            .and_then(|a| a.get("toolUseId"))
            .and_then(Value::as_str)
            .map(str::to_owned);
        match reopen_ask(live.as_deref(), tool_use_id, input) {
            Reopen::ScrollToInline => true,
            Reopen::Toast(msg) => {
                self.show_toast(msg.to_owned(), cx);
                false
            }
            Reopen::Resurrect(r) => {
                self.resurrected = Some(r);
                self.resurrected_view = None;
                self.unsubscribe("resurrected");
                self.sync_resurrected(cx);
                cx.notify();
                false
            }
        }
    }

    /// A key the window saw (the cards' `window` keydown listeners);
    /// whether a card took it.
    pub fn key_down(
        &mut self,
        event: &KeyDownEvent,
        window: &mut Window,
        cx: &mut Context<Self>,
    ) -> bool {
        let ks = &event.keystroke;
        let m = ks.modifiers;
        let plain = !(m.control || m.alt || m.platform || m.function);
        let now = self.now_ms(cx);
        let mut handled = false;
        if ks.key == "escape" {
            if let Some(v) = self.plan.clone() {
                handled |= v.update(cx, |v, cx| v.escape(window, cx));
            }
            if let Some(v) = self.permission.clone() {
                let id = v.read(cx).card.request_id.clone();
                if escape_denies(event.is_held, now, self.armed_at(&id)) {
                    v.update(cx, |v, cx| v.resolve(Decision::Deny(None), cx));
                    handled = true;
                }
            }
            if let Some(v) = self.elicitation.clone() {
                let id = v.read(cx).card.request_id.clone();
                if escape_cancels(
                    event.is_held,
                    now,
                    self.armed_at(&format!("elicitation:{id}")),
                ) {
                    v.update(cx, |v, cx| v.resolve(ElicitationDecision::Cancel, cx));
                    handled = true;
                }
            }
        }
        if let Some(v) = self.resurrected_view.clone() {
            let key = match ks.key.as_str() {
                "escape" => Some(AskKey::Escape),
                "down" if plain => Some(AskKey::Down),
                "up" if plain => Some(AskKey::Up),
                "enter" if plain && !m.shift => Some(AskKey::Enter),
                "tab" if plain && !m.shift => Some(AskKey::Tab),
                k if plain && k.len() == 1 && k.as_bytes()[0].is_ascii_digit() && k != "0" => {
                    Some(AskKey::Digit(k.as_bytes()[0] - b'0'))
                }
                _ => None,
            };
            if let Some(key) = key {
                let in_field = v.read(cx).other_focused(window, cx)
                    || self
                        .field_probe
                        .as_ref()
                        .is_some_and(|p| p(window, cx).is_some());
                handled |= v.update(cx, |v, cx| v.key(key, in_field, cx));
            }
        }
        handled
    }

    fn typing(&self, window: &Window, cx: &App) -> bool {
        let value = self.field_probe.as_ref().and_then(|p| p(window, cx));
        crate::arm::is_typing_in_field(value.as_deref())
    }
}

impl Render for PromptOverlays {
    fn render(&mut self, window: &mut Window, cx: &mut Context<Self>) -> impl IntoElement {
        // `defaultToNo`: the decline takes focus once, unless the user is
        // typing in a field.
        if self.focus_decline {
            self.focus_decline = false;
            if let Some(v) = &self.permission {
                let typing = self.typing(window, cx);
                let (go, handle) = {
                    let v = v.read(cx);
                    (focuses_decline(&v.card, typing), v.decline.clone())
                };
                if go {
                    window.focus(&handle, cx);
                }
            }
        }
        let c = self.colors;
        div()
            .debug_selector(|| "prompt-overlays".into())
            .absolute()
            .top_0()
            .left_0()
            .size_full()
            .children(self.plan.clone())
            .children(self.permission.clone())
            .children(self.elicitation.clone())
            .children(self.resurrected_view.clone())
            .children(self.toast.clone().map(|t| {
                div()
                    .absolute()
                    .bottom(px(96.))
                    .left_0()
                    .w_full()
                    .flex()
                    .justify_center()
                    .child(
                        div()
                            .debug_selector(|| "chat-toast".into())
                            .rounded(px(6.))
                            .border_1()
                            .border_color(h(c.border))
                            .bg(h(c.panel))
                            .px(px(12.))
                            .py(px(6.))
                            .text_size(px(12.))
                            .text_color(h(c.foreground))
                            .shadow_2xl()
                            .child(t),
                    )
            }))
    }
}

/// The live ask at the end of the transcript (MessageList's
/// `pendingAsk`), one card per request.
pub struct InlineAsk {
    target: Arc<dyn PromptTarget>,
    colors: Colors,
    view: Option<Entity<AskView>>,
    _sub: Option<Subscription>,
    _listen: Task<()>,
}

impl InlineAsk {
    pub fn new(target: Arc<dyn PromptTarget>, theme: ThemeName, cx: &mut Context<Self>) -> Self {
        let listen = listen(&target, cx, Self::sync);
        let mut this = InlineAsk {
            target,
            colors: Colors::of(theme),
            view: None,
            _sub: None,
            _listen: listen,
        };
        this.sync(cx);
        this
    }

    pub fn view(&self) -> Option<&Entity<AskView>> {
        self.view.as_ref()
    }

    pub fn set_theme(&mut self, theme: ThemeName, cx: &mut Context<Self>) {
        self.colors = Colors::of(theme);
        let (colors, label) = (self.colors, self.target.session_label());
        if let Some(v) = &self.view {
            v.update(cx, |v, _| v.set_colors(colors, label));
        }
        cx.notify();
    }

    fn sync(&mut self, cx: &mut Context<Self>) {
        let state = PromptState::read(&*self.target);
        let Some(ask) = state.ask else {
            self.view = None;
            self._sub = None;
            cx.notify();
            return;
        };
        let id = ask
            .get("requestId")
            .and_then(Value::as_str)
            .unwrap_or_default()
            .to_owned();
        if self
            .view
            .as_ref()
            .is_some_and(|v| v.read(cx).request_id() == id)
        {
            return;
        }
        let questions = questions_of(ask.get("questions"));
        if questions.is_empty() {
            self.view = None;
            self._sub = None;
            cx.notify();
            return;
        }
        let (colors, label) = (self.colors, self.target.session_label());
        let v = cx.new(|_| AskView::new(id, questions, AskMode::Inline, label, colors));
        let sub = cx.subscribe(&v, |this: &mut Self, v, e: &AskEvent, cx| {
            let id = v.read(cx).request_id().to_owned();
            let answers = match e {
                AskEvent::Submit(a) => answers_json(a),
                // Cancel = decline-but-graceful: empty answers.
                AskEvent::Cancel | AskEvent::Dismiss => json!([]),
            };
            this.target.act(Box::new(move |s, env| {
                s.submit_ask_answer(&id, &answers, env)
            }));
            let _ = cx;
        });
        self.view = Some(v);
        self._sub = Some(sub);
        cx.notify();
    }
}

impl Render for InlineAsk {
    fn render(&mut self, _: &mut Window, _: &mut Context<Self>) -> impl IntoElement {
        div().w_full().children(self.view.clone())
    }
}
