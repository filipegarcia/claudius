//! The cards on screen, headless: every decision a click (or a key) makes,
//! read back as the POST the chat's machine sends (the fixture's effects).
//! A host view stands in for the chat route: the banner, a transcript, the
//! live ask below it, the modal layer over it, and the window's keys
//! forwarded as the shell forwards them. macOS (the CoreText text system).

#![cfg(target_os = "macos")]

use std::sync::Arc;
use std::time::Duration;

use claudius_gpui_theme::ThemeName;
use claudius_prompts::ask::{AskAnswer, AskKey, format_ask_as_prompt, questions_of};
use claudius_prompts::target::samples;
use claudius_prompts::view::TOAST_MS;
use claudius_prompts::{ChatPrompts, FixturePrompts, PromptTarget};
use gpui::{
    Context, Entity, FocusHandle, InteractiveElement as _, IntoElement, KeyDownEvent, Keystroke,
    Modifiers, ParentElement as _, Render, Styled as _, TestAppContext, TestDispatcher,
    VisualTestContext, Window, div, px, size,
};
use gpui_apple::AppleTextSystem;
use serde_json::{Value, json};

struct Host {
    prompts: ChatPrompts,
    focus: FocusHandle,
}

impl Render for Host {
    fn render(&mut self, _: &mut Window, cx: &mut Context<Self>) -> impl IntoElement {
        div()
            .track_focus(&self.focus)
            .size_full()
            .relative()
            .flex()
            .flex_col()
            .on_key_down(
                cx.listener(|this: &mut Host, e: &KeyDownEvent, window, cx| {
                    if this.prompts.key_down(e, window, cx) {
                        cx.stop_propagation();
                    }
                }),
            )
            .child(self.prompts.banner.clone())
            .child(div().flex_1().debug_selector(|| "transcript".into()))
            .child(self.prompts.inline.clone())
            .child(self.prompts.overlays.clone())
    }
}

fn app() -> TestAppContext {
    TestAppContext::build_with_text_system(
        TestDispatcher::new(0),
        None,
        Arc::new(AppleTextSystem::new()),
    )
}

fn open(
    app: &mut TestAppContext,
    fixture: Arc<FixturePrompts>,
) -> (Entity<Host>, &mut VisualTestContext) {
    app.update(|cx| {
        gpui_kit::init(cx);
        claudius_gpui_theme::init(ThemeName::Dark, cx);
    });
    let target: Arc<dyn PromptTarget> = fixture;
    let (host, cx) = app.add_window_view(|window, cx| {
        let focus = cx.focus_handle();
        window.focus(&focus, cx);
        Host {
            prompts: ChatPrompts::new(target, ThemeName::Dark, cx),
            focus,
        }
    });
    cx.simulate_resize(size(px(1280.), px(800.)));
    settle(cx);
    (host, cx)
}

fn settle(cx: &mut VisualTestContext) {
    for _ in 0..3 {
        cx.run_until_parked();
        cx.update(|window, cx| {
            window.refresh();
            window.draw(cx).clear(cx);
        });
    }
    cx.run_until_parked();
}

fn drawn(cx: &mut VisualTestContext, selector: &'static str) -> bool {
    cx.debug_bounds(selector).is_some()
}

fn click(cx: &mut VisualTestContext, selector: &'static str) {
    let b = cx
        .debug_bounds(selector)
        .unwrap_or_else(|| panic!("{selector} is drawn"));
    cx.simulate_click(b.center(), Modifiers::none());
    settle(cx);
}

/// Past the arm window, so a key counts.
fn arm(cx: &mut VisualTestContext) {
    cx.executor().advance_clock(Duration::from_millis(500));
    settle(cx);
}

fn keys(cx: &mut VisualTestContext, keystrokes: &str) {
    cx.simulate_keystrokes(keystrokes);
    settle(cx);
}

fn prompts(host: &Entity<Host>, cx: &mut VisualTestContext) -> ChatPrompts {
    cx.read(|cx| host.read(cx).prompts.clone())
}

fn toast(host: &Entity<Host>, cx: &mut VisualTestContext) -> Option<String> {
    let p = prompts(host, cx);
    cx.read(|cx| p.overlays.read(cx).toast().map(str::to_owned))
}

/// The posts, as `(path after the session, body JSON)`.
fn posts(t: &FixturePrompts) -> Vec<(String, Value)> {
    t.posts()
        .into_iter()
        .map(|(url, body)| {
            let path = url
                .strip_prefix("/api/sessions/s1/")
                .unwrap_or(&url)
                .to_owned();
            (path, serde_json::from_str(&body).unwrap_or(Value::Null))
        })
        .collect()
}

fn permission_fixture(extra: &[Value]) -> Arc<FixturePrompts> {
    let t = FixturePrompts::new("s1");
    t.event(samples::permission_bash("p1"));
    for e in extra {
        t.event(e.clone());
    }
    t
}

// ---- The permission card -------------------------------------------------

#[test]
fn allow_once_and_allow_always_post_their_decisions() {
    let t = permission_fixture(&[samples::permission_edit("p2")]);
    let mut app = app();
    let (_, cx) = open(&mut app, t.clone());
    assert!(drawn(cx, "permission-modal"));
    assert!(drawn(cx, "permission-always-rule"));
    click(cx, "permission-allow-once");
    assert_eq!(
        posts(&t),
        [(
            "permission".into(),
            json!({ "requestId": "p1", "decision": { "kind": "allow_once" } })
        )]
    );
    // The next queued request comes up fresh.
    assert!(drawn(cx, "permission-modal"));
    assert!(drawn(cx, "permission-agent-badge"));
    t.clear_effects();
    click(cx, "permission-allow-session");
    assert_eq!(
        posts(&t),
        [(
            "permission".into(),
            json!({ "requestId": "p2", "decision": { "kind": "allow_always_session" } })
        )]
    );
    assert!(!drawn(cx, "permission-modal"));
}

#[test]
fn always_project_and_user_save_to_their_settings() {
    for (button, dest) in [
        ("permission-allow-project", "projectSettings"),
        ("permission-allow-user", "userSettings"),
    ] {
        let t = permission_fixture(&[]);
        let mut app = app();
        let (_, cx) = open(&mut app, t.clone());
        let b = cx.debug_bounds(button).expect("drawn");
        cx.simulate_click(b.center(), Modifiers::none());
        settle(cx);
        assert_eq!(
            posts(&t),
            [(
                "permission".into(),
                json!({ "requestId": "p1", "decision": { "kind": "allow_always_save", "destination": dest } })
            )]
        );
    }
}

#[test]
fn deny_with_feedback_sends_the_typed_message() {
    let t = permission_fixture(&[]);
    let mut app = app();
    let (_, cx) = open(&mut app, t.clone());
    assert!(!drawn(cx, "permission-deny-panel"));
    click(cx, "permission-deny-toggle");
    assert!(drawn(cx, "permission-deny-panel"));
    // The feedback box took focus (`autoFocus`).
    cx.simulate_input("use a PR");
    settle(cx);
    click(cx, "permission-deny-with-feedback");
    assert_eq!(
        posts(&t),
        [(
            "permission".into(),
            json!({ "requestId": "p1", "decision": { "kind": "deny", "message": "use a PR" } })
        )]
    );
}

#[test]
fn deny_with_empty_feedback_and_deny_without_feedback_send_no_message() {
    for button in ["permission-deny-with-feedback", "permission-deny-plain"] {
        let t = permission_fixture(&[]);
        let mut app = app();
        let (_, cx) = open(&mut app, t.clone());
        click(cx, "permission-deny-toggle");
        let b = cx.debug_bounds(button).expect("drawn");
        cx.simulate_click(b.center(), Modifiers::none());
        settle(cx);
        assert_eq!(
            posts(&t),
            [(
                "permission".into(),
                json!({ "requestId": "p1", "decision": { "kind": "deny" } })
            )]
        );
    }
}

#[test]
fn the_queue_count_shows_one_of_n_and_counts_down() {
    let t = permission_fixture(&[
        samples::permission_edit("p2"),
        samples::permission_bash("p3"),
    ]);
    let mut app = app();
    let (host, cx) = open(&mut app, t.clone());
    let label = |host: &Entity<Host>, cx: &mut VisualTestContext| {
        let p = prompts(host, cx);
        cx.read(|cx| {
            p.overlays
                .read(cx)
                .permission()
                .and_then(|v| v.read(cx).card().queue_label.clone())
        })
    };
    assert!(drawn(cx, "permission-queue-count"));
    assert_eq!(label(&host, cx).as_deref(), Some("1 of 3"));
    click(cx, "permission-allow-once");
    assert_eq!(label(&host, cx).as_deref(), Some("1 of 2"));
    click(cx, "permission-allow-once");
    assert_eq!(label(&host, cx), None);
    assert!(!drawn(cx, "permission-queue-count"));
}

#[test]
fn the_auto_mode_tip_switches_to_auto_and_allows_once() {
    let t = permission_fixture(&[]);
    let mut app = app();
    let (_, cx) = open(&mut app, t.clone());
    assert!(drawn(cx, "permission-auto-mode-tip"));
    click(cx, "permission-auto-mode-switch");
    assert_eq!(
        posts(&t),
        [
            ("mode".into(), json!({ "mode": "auto" })),
            (
                "permission".into(),
                json!({ "requestId": "p1", "decision": { "kind": "allow_once" } })
            ),
        ]
    );
}

#[test]
fn the_auto_mode_tip_hides_in_auto_mode_and_when_disabled() {
    let t = permission_fixture(&[]);
    t.update(|s| s.permission_mode = Some(json!("auto")));
    let mut app = app();
    let (_, cx) = open(&mut app, t);
    assert!(drawn(cx, "permission-modal"));
    assert!(!drawn(cx, "permission-auto-mode-tip"));

    let t = FixturePrompts::with("s1", true, None);
    t.event(samples::permission_bash("p1"));
    let mut app2 = self::app();
    let (_, cx) = open(&mut app2, t);
    assert!(!drawn(cx, "permission-auto-mode-tip"));
}

#[test]
fn escape_denies_once_armed_but_not_a_held_key() {
    let t = permission_fixture(&[samples::permission_edit("p2")]);
    let mut app = app();
    let (_, cx) = open(&mut app, t.clone());
    // Within the arm window: meant for something else.
    keys(cx, "escape");
    assert!(posts(&t).is_empty());
    arm(cx);
    // A held Escape (auto-repeat) never denies.
    cx.simulate_event(KeyDownEvent {
        keystroke: Keystroke::parse("escape").unwrap(),
        is_held: true,
        prefer_character_input: false,
    });
    settle(cx);
    assert!(posts(&t).is_empty());
    keys(cx, "escape");
    assert_eq!(
        posts(&t),
        [(
            "permission".into(),
            json!({ "requestId": "p1", "decision": { "kind": "deny" } })
        )]
    );
    // The next card armed anew.
    keys(cx, "escape");
    assert_eq!(posts(&t).len(), 1);
}

#[test]
fn default_to_no_opens_on_the_decline_and_focuses_it() {
    let t = FixturePrompts::new("s1");
    let mut req = samples::permission_bash("p1");
    req["defaultToNo"] = json!(true);
    t.event(req);
    let mut app = app();
    let (host, cx) = open(&mut app, t);
    assert!(drawn(cx, "permission-deny-panel"));
    assert!(!drawn(cx, "permission-auto-mode-tip"));
    let p = prompts(&host, cx);
    let focused = cx.update(|window, cx| {
        let v = p.overlays.read(cx).permission().cloned().expect("shown");
        v.read(cx).decline_handle().is_focused(window)
    });
    assert!(focused);
}

// ---- The plan ---------------------------------------------------------------

fn plan_fixture() -> Arc<FixturePrompts> {
    let t = FixturePrompts::new("s1");
    t.update(|s| s.permission_mode = Some(json!("plan")));
    t.event(samples::plan("plan-1"));
    t
}

#[test]
fn accepting_the_plan_posts_accept_and_toasts() {
    let t = plan_fixture();
    let mut app = app();
    let (host, cx) = open(&mut app, t.clone());
    assert!(drawn(cx, "plan-overlay"));
    assert!(drawn(cx, "plan-mode-banner"));
    click(cx, "plan-overlay-accept");
    assert_eq!(
        posts(&t),
        [(
            "plan".into(),
            json!({ "requestId": "plan-1", "decision": { "kind": "accept" } })
        )]
    );
    assert!(!drawn(cx, "plan-overlay"));
    assert_eq!(
        toast(&host, cx).as_deref(),
        Some("Plan accepted \u{2014} switched to acceptEdits")
    );
    assert!(drawn(cx, "chat-toast"));
    cx.executor().advance_clock(Duration::from_millis(TOAST_MS));
    settle(cx);
    assert_eq!(toast(&host, cx), None);
}

#[test]
fn accepting_an_edited_plan_sends_the_edit() {
    let t = plan_fixture();
    let mut app = app();
    let (host, cx) = open(&mut app, t.clone());
    click(cx, "plan-overlay-edit");
    assert!(drawn(cx, "plan-overlay-editor"));
    assert!(drawn(cx, "plan-overlay-discard"));
    cx.simulate_input("\n4. Ship it.");
    settle(cx);
    let p = prompts(&host, cx);
    let label = cx.read(|cx| {
        let v = p.overlays.read(cx).plan().cloned().expect("shown");
        let v = v.read(cx);
        v.form().accept_label(&v.plan().plan)
    });
    assert_eq!(label, "Accept edited plan");
    click(cx, "plan-overlay-accept");
    let sent = posts(&t);
    assert_eq!(sent.len(), 1);
    let decision = &sent[0].1["decision"];
    assert_eq!(decision["kind"], "accept");
    assert!(
        decision["editedPlan"]
            .as_str()
            .unwrap()
            .contains("4. Ship it."),
        "{decision}"
    );
    assert_eq!(
        toast(&host, cx).as_deref(),
        Some("Edited plan accepted \u{2014} switched to acceptEdits")
    );
}

#[test]
fn discarding_the_edits_accepts_the_original() {
    let t = plan_fixture();
    let mut app = app();
    let (_, cx) = open(&mut app, t.clone());
    click(cx, "plan-overlay-edit");
    cx.simulate_input("scratch");
    settle(cx);
    click(cx, "plan-overlay-discard");
    assert!(drawn(cx, "plan-overlay-preview"));
    click(cx, "plan-overlay-accept");
    assert_eq!(
        posts(&t),
        [(
            "plan".into(),
            json!({ "requestId": "plan-1", "decision": { "kind": "accept" } })
        )]
    );
}

#[test]
fn rejecting_and_dismissing_the_plan_post_their_rejects() {
    for (button, decision, msg) in [
        (
            "plan-overlay-reject",
            json!({ "kind": "reject" }),
            "Plan rejected \u{2014} keep iterating",
        ),
        (
            "plan-overlay-close",
            json!({ "kind": "reject", "message": "User dismissed the plan." }),
            "Plan dismissed \u{2014} still in plan mode",
        ),
    ] {
        let t = plan_fixture();
        let mut app = app();
        let (host, cx) = open(&mut app, t.clone());
        let b = cx.debug_bounds(button).expect("drawn");
        cx.simulate_click(b.center(), Modifiers::none());
        settle(cx);
        assert_eq!(
            posts(&t),
            [(
                "plan".into(),
                json!({ "requestId": "plan-1", "decision": decision })
            )]
        );
        assert_eq!(toast(&host, cx).as_deref(), Some(msg));
    }
}

#[test]
fn the_plan_minimizes_to_a_pill_and_ignores_escape() {
    let t = plan_fixture();
    let mut app = app();
    let (_, cx) = open(&mut app, t.clone());
    arm(cx);
    keys(cx, "escape");
    assert!(drawn(cx, "plan-overlay"));
    click(cx, "plan-overlay-minimize");
    assert!(!drawn(cx, "plan-overlay"));
    click(cx, "plan-overlay-restore");
    assert!(drawn(cx, "plan-overlay"));
    assert!(posts(&t).is_empty());
}

#[test]
fn the_banner_exits_plan_mode() {
    let t = FixturePrompts::new("s1");
    t.update(|s| s.permission_mode = Some(json!("plan")));
    let mut app = app();
    let (_, cx) = open(&mut app, t.clone());
    assert!(drawn(cx, "plan-mode-banner"));
    click(cx, "plan-mode-exit");
    assert_eq!(posts(&t), [("mode".into(), json!({ "mode": "default" }))]);
    assert!(!drawn(cx, "plan-mode-banner"));
}

// ---- The elicitation ------------------------------------------------------

fn type_into(cx: &mut VisualTestContext, selector: &'static str, text: &str) {
    click(cx, selector);
    cx.simulate_input(text);
    settle(cx);
}

#[test]
fn the_elicitation_form_validates_then_submits() {
    let t = FixturePrompts::new("s1");
    t.event(samples::elicitation_form("e1"));
    let mut app = app();
    let (host, cx) = open(&mut app, t.clone());
    assert!(drawn(cx, "mcp-elicitation-modal"));
    assert!(drawn(cx, "mcp-elicitation-server"));
    // Required fields empty: the errors show, nothing is sent.
    click(cx, "mcp-elicitation-submit");
    assert!(posts(&t).is_empty());
    assert!(drawn(cx, "mcp-elicitation-error-title"));
    assert!(drawn(cx, "mcp-elicitation-error-priority"));
    // Typing clears that field's error.
    type_into(cx, "mcp-elicitation-field-title", "Port");
    assert!(!drawn(cx, "mcp-elicitation-error-title"));
    click(cx, "mcp-elicitation-option-priority-3");
    click(cx, "mcp-elicitation-option-labels-2");
    type_into(cx, "mcp-elicitation-field-estimate", "5");
    let p = prompts(&host, cx);
    let errors = cx.read(|cx| {
        p.overlays
            .read(cx)
            .elicitation()
            .map(|v| v.read(cx).form().errors.clone())
    });
    assert_eq!(errors, Some(Vec::new()));
    click(cx, "mcp-elicitation-submit");
    assert_eq!(
        posts(&t),
        [(
            "elicitation".into(),
            json!({
                "requestId": "e1",
                "decision": {
                    "action": "accept",
                    "content": { "title": "Port", "priority": "high", "estimate": 5, "labels": ["port"], "notify": true }
                }
            })
        )]
    );
    assert!(!drawn(cx, "mcp-elicitation-modal"));
}

#[test]
fn a_bad_number_and_a_short_title_block_the_submit() {
    let t = FixturePrompts::new("s1");
    t.event(samples::elicitation_form("e1"));
    let mut app = app();
    let (_, cx) = open(&mut app, t.clone());
    type_into(cx, "mcp-elicitation-field-title", "ab");
    click(cx, "mcp-elicitation-option-priority-1");
    type_into(cx, "mcp-elicitation-field-estimate", "99");
    click(cx, "mcp-elicitation-submit");
    assert!(posts(&t).is_empty());
    assert!(drawn(cx, "mcp-elicitation-error-title"));
    assert!(drawn(cx, "mcp-elicitation-error-estimate"));
    assert!(!drawn(cx, "mcp-elicitation-error-priority"));
}

#[test]
fn declining_and_escape_answer_the_elicitation() {
    let t = FixturePrompts::new("s1");
    t.event(samples::elicitation_form("e1"));
    t.event(samples::elicitation_form("e2"));
    let mut app = app();
    let (_, cx) = open(&mut app, t.clone());
    assert!(drawn(cx, "mcp-elicitation-queue-count"));
    click(cx, "mcp-elicitation-decline");
    assert_eq!(
        posts(&t),
        [(
            "elicitation".into(),
            json!({ "requestId": "e1", "decision": { "action": "decline" } })
        )]
    );
    t.clear_effects();
    keys(cx, "escape");
    assert!(posts(&t).is_empty(), "within the arm window");
    arm(cx);
    keys(cx, "escape");
    assert_eq!(
        posts(&t),
        [(
            "elicitation".into(),
            json!({ "requestId": "e2", "decision": { "action": "cancel" } })
        )]
    );
}

#[test]
fn the_url_variant_opens_the_link_and_accepts() {
    let t = FixturePrompts::new("s1");
    t.event(samples::elicitation_url("e1", Some("el-1")));
    let mut app = app();
    let (_, cx) = open(&mut app, t.clone());
    assert!(drawn(cx, "mcp-elicitation-host"));
    click(cx, "mcp-elicitation-open");
    assert_eq!(
        cx.opened_url().as_deref(),
        Some("https://github.com/login/oauth/authorize?client_id=abc")
    );
    assert_eq!(
        posts(&t),
        [(
            "elicitation".into(),
            json!({ "requestId": "e1", "decision": { "action": "accept" } })
        )]
    );
}

#[test]
fn a_url_without_an_elicitation_id_waits_for_done() {
    let t = FixturePrompts::new("s1");
    t.event(samples::elicitation_url("e1", None));
    let mut app = app();
    let (_, cx) = open(&mut app, t.clone());
    click(cx, "mcp-elicitation-open");
    assert!(cx.opened_url().is_some());
    assert!(posts(&t).is_empty());
    assert!(drawn(cx, "mcp-elicitation-done"));
    click(cx, "mcp-elicitation-done");
    assert_eq!(
        posts(&t),
        [(
            "elicitation".into(),
            json!({ "requestId": "e1", "decision": { "action": "accept" } })
        )]
    );
}

#[test]
fn an_unsafe_link_is_not_offered() {
    let t = FixturePrompts::new("s1");
    let mut req = samples::elicitation_url("e1", Some("el-1"));
    req["url"] = json!("javascript:alert(1)");
    t.event(req);
    let mut app = app();
    let (_, cx) = open(&mut app, t.clone());
    assert!(drawn(cx, "mcp-elicitation-unsafe-url"));
    click(cx, "mcp-elicitation-open");
    assert!(cx.opened_url().is_none());
    assert!(posts(&t).is_empty());
}

#[test]
fn the_elicitation_waits_while_a_permission_card_is_up() {
    let t = FixturePrompts::new("s1");
    t.event(samples::elicitation_form("e1"));
    t.event(samples::permission_bash("p1"));
    let mut app = app();
    let (_, cx) = open(&mut app, t.clone());
    assert!(drawn(cx, "permission-modal"));
    assert!(!drawn(cx, "mcp-elicitation-modal"));
    click(cx, "permission-allow-once");
    assert!(drawn(cx, "mcp-elicitation-modal"));
}

// ---- AskUserQuestion ------------------------------------------------------

#[test]
fn the_live_ask_answers_two_questions_inline() {
    let t = FixturePrompts::with("s1", false, Some("Port the shell"));
    t.event(samples::ask_two("a1"));
    let mut app = app();
    let (_, cx) = open(&mut app, t.clone());
    assert!(drawn(cx, "ask-user-question-inline"));
    assert!(drawn(cx, "ask-session-label"));
    assert!(drawn(cx, "ask-tab-0") && drawn(cx, "ask-tab-1"));
    assert!(!drawn(cx, "ask-minimize"));
    // Q1, single-select: "Other" with text (its field takes focus).
    click(cx, "ask-option-other");
    assert!(drawn(cx, "ask-other-input"));
    cx.simulate_input("  Redis  ");
    settle(cx);
    click(cx, "ask-next");
    // Q2, multi-select: two picks.
    assert!(drawn(cx, "ask-multiselect-badge"));
    click(cx, "ask-option-0");
    click(cx, "ask-option-2");
    click(cx, "ask-submit");
    assert_eq!(
        posts(&t),
        [(
            "ask-answer".into(),
            json!({ "requestId": "a1", "answers": [{ "label": null, "custom": "Redis" }, { "selected": ["Chat", "Files"] }] })
        )]
    );
    assert!(!drawn(cx, "ask-user-question-inline"));
}

#[test]
fn the_live_ask_takes_no_keys_and_cancels_with_empty_answers() {
    let t = FixturePrompts::new("s1");
    t.event(samples::ask_two("a1"));
    let mut app = app();
    let (host, cx) = open(&mut app, t.clone());
    arm(cx);
    keys(cx, "1 enter escape");
    assert!(posts(&t).is_empty());
    assert!(drawn(cx, "ask-user-question-inline"));
    // The card itself ignores the modal's keys inline.
    let p = prompts(&host, cx);
    let taken = cx.update(|_, cx| {
        let v = p.inline.read(cx).view().cloned().expect("shown");
        v.update(cx, |v, cx| v.key(AskKey::Digit(1), false, cx))
    });
    assert!(!taken);
    click(cx, "ask-cancel");
    assert_eq!(
        posts(&t),
        [(
            "ask-answer".into(),
            json!({ "requestId": "a1", "answers": [] })
        )]
    );
}

#[test]
fn a_resurrected_ask_sends_its_answers_as_a_prompt() {
    let t = FixturePrompts::new("s1");
    let mut app = app();
    let (host, cx) = open(&mut app, t.clone());
    let input = json!({ "questions": samples::ask_two("old")["questions"].clone() });
    let p = prompts(&host, cx);
    let live = cx.update(|_, cx| p.reopen_ask("toolu_old", &input, cx));
    assert!(!live);
    settle(cx);
    assert!(drawn(cx, "ask-backdrop"));
    assert!(drawn(cx, "ask-minimize"));
    // The modal's keys: 1 picks, Enter goes on, then submits.
    keys(cx, "1 enter 2 3 enter");
    let questions = questions_of(input.get("questions"));
    let answers = [
        AskAnswer {
            label: Some(Some("SQLite".into())),
            ..Default::default()
        },
        AskAnswer {
            selected: Some(vec!["Git".into(), "Files".into()]),
            ..Default::default()
        },
    ];
    let text = format_ask_as_prompt(&questions, &answers);
    let sent = posts(&t);
    assert!(!sent.is_empty());
    assert!(
        sent.iter().any(|(_, body)| body
            .as_object()
            .is_some_and(|m| m.values().any(|v| *v == json!(text)))),
        "{sent:?} carries {text:?}"
    );
    assert!(sent.iter().all(|(path, _)| path != "ask-answer"));
    assert!(!drawn(cx, "ask-backdrop"));
}

#[test]
fn escape_and_the_backdrop_close_the_resurrected_ask() {
    let t = FixturePrompts::new("s1");
    let mut app = app();
    let (host, cx) = open(&mut app, t.clone());
    let input = json!({ "questions": samples::ask_two("old")["questions"].clone() });
    let p = prompts(&host, cx);
    cx.update(|_, cx| p.reopen_ask("toolu_old", &input, cx));
    settle(cx);
    keys(cx, "escape");
    assert!(!drawn(cx, "ask-backdrop"));
    cx.update(|_, cx| p.reopen_ask("toolu_old", &input, cx));
    settle(cx);
    let b = cx.debug_bounds("ask-backdrop").expect("drawn");
    cx.simulate_click(
        gpui::point(b.origin.x + px(4.), b.origin.y + px(4.)),
        Modifiers::none(),
    );
    settle(cx);
    assert!(!drawn(cx, "ask-backdrop"));
    assert!(posts(&t).is_empty());
}

#[test]
fn the_resurrected_ask_waits_for_the_live_one_and_reopen_finds_the_live_one() {
    let t = FixturePrompts::new("s1");
    t.event(samples::ask_two("a1"));
    let mut app = app();
    let (host, cx) = open(&mut app, t.clone());
    let p = prompts(&host, cx);
    let input = json!({ "questions": samples::ask_two("old")["questions"].clone() });
    // The live ask's own row: it's already inline.
    assert!(cx.update(|_, cx| p.reopen_ask("toolu_a1", &input, cx)));
    // Another: kept, but not shown while the live one is up.
    assert!(!cx.update(|_, cx| p.reopen_ask("toolu_old", &input, cx)));
    settle(cx);
    assert!(!drawn(cx, "ask-backdrop"));
    click(cx, "ask-cancel");
    assert!(drawn(cx, "ask-backdrop"));
    // An input that isn't a question set: a toast.
    assert!(!cx.update(|_, cx| p.reopen_ask("toolu_x", &json!({ "nope": 1 }), cx)));
    assert_eq!(
        toast(&host, cx).as_deref(),
        Some("Couldn't recover the question \u{2014} input shape unknown")
    );
}

#[test]
fn the_preview_pane_follows_the_picked_option() {
    let t = FixturePrompts::new("s1");
    t.event(json!({
        "type": "ask_user_question",
        "requestId": "a1",
        "toolUseId": "toolu_a1",
        "questions": [{
            "question": "Which layout?",
            "header": "Layout",
            "options": [
                { "label": "Cards", "description": "", "preview": "<div class=\"grid\">cards</div>" },
                { "label": "List", "description": "", "preview": "+------+\n| row  |\n+------+" },
                { "label": "Bare", "description": "" }
            ],
            "multiSelect": false
        }]
    }));
    let mut app = app();
    let (host, cx) = open(&mut app, t.clone());
    let focused = |host: &Entity<Host>, cx: &mut VisualTestContext| {
        let p = prompts(host, cx);
        cx.read(|cx| {
            p.inline
                .read(cx)
                .view()
                .map(|v| v.read(cx).form().focused_option)
        })
    };
    assert!(drawn(cx, "ask-preview"));
    // U08b's seam: the markup shows as text until the HTML pane lands.
    assert!(drawn(cx, "ask-preview-html"));
    click(cx, "ask-option-1");
    assert_eq!(focused(&host, cx), Some(1));
    assert!(drawn(cx, "ask-preview-text"));
    assert!(!drawn(cx, "ask-preview-html"));
    // An option without a preview falls back to the first one's.
    click(cx, "ask-option-2");
    assert_eq!(focused(&host, cx), Some(2));
    assert!(drawn(cx, "ask-preview-html"));
    click(cx, "ask-submit");
    assert_eq!(
        posts(&t),
        [(
            "ask-answer".into(),
            json!({ "requestId": "a1", "answers": [{ "label": "Bare" }] })
        )]
    );
}
