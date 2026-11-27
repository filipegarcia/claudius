//! [`PromptTarget`]: what the cards read from a chat and the actions they
//! call on it, next to claudius-chat's `TranscriptSource` and the
//! composer's target. The cards read the chat's `ChatState` (the pending
//! prompts, their counts, the permission mode) and answer through
//! claudius-client's actions (`resolve_permission`, `resolve_elicitation`,
//! `submit_ask_answer`, `resolve_plan`, `set_permission_mode`, `send`),
//! each a closure over `(&mut ChatState, &mut dyn ClientEnv)` whose
//! `Vec<Effect>` the target hands to its runner.
//!
//! Over U04b's `LiveChat` (`state()`, `act(f)`, `changes()`) it is:
//!
//! ```ignore
//! impl PromptTarget for LivePrompts {
//!     fn read(&self, f: &mut dyn FnMut(&ChatState)) { f(&self.chat.state()) }
//!     fn act(&self, f: Act) { self.chat.act(move |s, env| f(s, env)); }
//!     fn changes(&self) -> BoxStream<'static, ()> {
//!         futures::stream::unfold(self.chat.changes(), |mut rx| async move {
//!             rx.changed().await.ok().map(|_| ((), rx))
//!         })
//!         .boxed()
//!     }
//!     fn auto_mode_disabled(&self) -> bool { self.disable_auto_mode }
//! }
//! ```
//!
//! [`FixturePrompts`] holds a state the tests and the screenshots set
//! prompts on (through the real `ChatState::on_message`), and records
//! every effect the actions return.

use std::collections::HashMap;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Mutex};

use claudius_client::effect::{Effect, FetchRequest};
use claudius_client::queue::SendOpts;
use claudius_client::state::ChatState;
use claudius_client::{ClientEnv, FixedEnv};
use futures::StreamExt as _;
use futures::channel::mpsc::{UnboundedSender, unbounded};
use futures::stream::BoxStream;
use serde_json::Value;

/// An action on the chat's machine.
pub type Act = Box<dyn FnOnce(&mut ChatState, &mut dyn ClientEnv) -> Vec<Effect> + Send>;

/// What the prompt cards need from a chat.
pub trait PromptTarget: Send + Sync + 'static {
    /// Calls `f` with the chat's state.
    fn read(&self, f: &mut dyn FnMut(&ChatState));

    /// Runs `f` on the machine, after every earlier call, and runs the
    /// effects it returns.
    fn act(&self, f: Act);

    /// Wakes after each state change.
    fn changes(&self) -> BoxStream<'static, ()>;

    /// The `disableAutoMode` setting (`useDisableAutoMode(cwd)`): the
    /// permission card's auto-mode tip is hidden.
    fn auto_mode_disabled(&self) -> bool {
        false
    }

    /// `tabLabelFor(sessionId, sessions, sessionTitle)`: the ask header's
    /// session chip.
    fn session_label(&self) -> Option<String> {
        None
    }

    /// The app's own origin, which an elicitation link may not open (the
    /// page's `window.location.origin`); `None` for none.
    fn own_origin(&self) -> Option<String> {
        None
    }

    /// `handleSend(text)` for a resurrected ask's answers. The text starts
    /// with `> `, so none of the composer's slash / bash dispatch applies:
    /// it is `send(text)`.
    fn send_prompt(&self, text: String) {
        self.act(Box::new(move |s, env| {
            s.send(&text, None, &SendOpts::default(), env)
        }));
    }
}

/// The prompts a chat shows, as the cards read them.
#[derive(Clone, Debug, Default, PartialEq)]
pub struct PromptState {
    pub session_id: Option<String>,
    /// `pendingPermission` and `pendingPermissionCount`.
    pub permission: Option<Value>,
    pub permission_count: usize,
    pub elicitation: Option<Value>,
    pub elicitation_count: usize,
    /// `pendingAsk`.
    pub ask: Option<Value>,
    /// `pendingPlan` (`null`: none).
    pub plan: Value,
    /// `permissionMode`, when a string.
    pub permission_mode: Option<String>,
}

impl PromptState {
    /// Reads the heads of the queues off a state.
    pub fn of(s: &ChatState) -> PromptState {
        PromptState {
            session_id: s.session_id.clone(),
            permission: s.pending_permissions.first().map(|p| p.0.clone()),
            permission_count: s.pending_permissions.len(),
            elicitation: s.pending_elicitations.first().map(|p| p.0.clone()),
            elicitation_count: s.pending_elicitations.len(),
            ask: s.pending_asks.first().map(|p| p.0.clone()),
            plan: s.pending_plan.clone(),
            permission_mode: s
                .permission_mode
                .as_ref()
                .and_then(Value::as_str)
                .map(str::to_owned),
        }
    }

    /// Reads it from a target.
    pub fn read(target: &dyn PromptTarget) -> PromptState {
        let mut out = PromptState::default();
        target.read(&mut |s| out = PromptState::of(s));
        out
    }

    /// The permission card's `autoModeAvailable`
    /// (`!autoModeDisabled && permissionMode !== "auto"`).
    pub fn auto_mode_available(&self, disabled: bool) -> bool {
        !disabled && self.permission_mode.as_deref() != Some("auto")
    }
}

/// A chat over a fixed clock whose prompts are set by events.
pub struct FixturePrompts {
    inner: Mutex<Inner>,
    subscribers: Mutex<Vec<UnboundedSender<()>>>,
    auto_mode_disabled: AtomicBool,
    session_label: Option<String>,
}

struct Inner {
    state: ChatState,
    env: FixedEnv,
    effects: Vec<Effect>,
}

impl FixturePrompts {
    /// A chat bound to `session_id` (its actions need one), in `default`
    /// mode.
    pub fn new(session_id: &str) -> Arc<Self> {
        Self::with(session_id, false, None)
    }

    /// With the `disableAutoMode` setting and a session label.
    pub fn with(
        session_id: &str,
        auto_mode_disabled: bool,
        session_label: Option<&str>,
    ) -> Arc<Self> {
        let mut state = ChatState::new(format!("tab-{session_id}"));
        state.session_id = Some(session_id.to_owned());
        Arc::new(FixturePrompts {
            inner: Mutex::new(Inner {
                state,
                env: FixedEnv::new(1_795_683_600_000.0),
                effects: Vec::new(),
            }),
            subscribers: Mutex::new(Vec::new()),
            auto_mode_disabled: AtomicBool::new(auto_mode_disabled),
            session_label: session_label.map(str::to_owned),
        })
    }

    /// Applies one server event (its JSON), as the SSE handler does.
    pub fn event(&self, ev: Value) {
        {
            let mut i = self.inner.lock().unwrap();
            let Inner { state, env, .. } = &mut *i;
            let _ = state.on_message(&ev.to_string(), env);
        }
        self.notify();
    }

    /// The `disableAutoMode` setting's answer landing (the hook's state
    /// changing under a shown card).
    pub fn set_auto_mode_disabled(&self, disabled: bool) {
        self.auto_mode_disabled.store(disabled, Ordering::Relaxed);
        self.notify();
    }

    /// Changes the state directly (a mode, a cleared plan).
    pub fn update(&self, f: impl FnOnce(&mut ChatState)) {
        f(&mut self.inner.lock().unwrap().state);
        self.notify();
    }

    /// Every effect the actions returned, in order.
    pub fn effects(&self) -> Vec<Effect> {
        self.inner.lock().unwrap().effects.clone()
    }

    /// The fetches among them, as `(url, body)`.
    pub fn posts(&self) -> Vec<(String, String)> {
        self.effects()
            .into_iter()
            .filter_map(|e| match e {
                Effect::Fetch(FetchRequest { url, body, .. }) => {
                    Some((url, body.unwrap_or_default()))
                }
                _ => None,
            })
            .collect()
    }

    /// Forgets the recorded effects.
    pub fn clear_effects(&self) {
        self.inner.lock().unwrap().effects.clear();
    }

    pub fn state(&self) -> PromptState {
        PromptState::read(self)
    }

    fn notify(&self) {
        self.subscribers
            .lock()
            .unwrap()
            .retain(|tx| tx.unbounded_send(()).is_ok());
    }
}

impl PromptTarget for FixturePrompts {
    fn read(&self, f: &mut dyn FnMut(&ChatState)) {
        f(&self.inner.lock().unwrap().state);
    }

    fn act(&self, f: Act) {
        {
            let mut i = self.inner.lock().unwrap();
            let Inner {
                state,
                env,
                effects,
            } = &mut *i;
            let out = f(state, env);
            effects.extend(out);
        }
        self.notify();
    }

    fn changes(&self) -> BoxStream<'static, ()> {
        let (tx, rx) = unbounded();
        self.subscribers.lock().unwrap().push(tx);
        rx.boxed()
    }

    fn auto_mode_disabled(&self) -> bool {
        self.auto_mode_disabled.load(Ordering::Relaxed)
    }

    fn session_label(&self) -> Option<String> {
        self.session_label.clone()
    }
}

/// The chats' targets by session id (the shell's seam until U04b's live
/// chats implement [`PromptTarget`] themselves).
pub trait PromptSource: Send + Sync + 'static {
    fn target(&self, session_id: &str) -> Option<Arc<dyn PromptTarget>>;
}

/// A [`PromptSource`] over fixtures.
#[derive(Default)]
pub struct FixturePromptSource {
    targets: Mutex<HashMap<String, Arc<FixturePrompts>>>,
}

impl FixturePromptSource {
    pub fn new() -> Arc<Self> {
        Arc::new(Self::default())
    }

    /// The fixture of a session, made on first use.
    pub fn session(&self, session_id: &str) -> Arc<FixturePrompts> {
        self.targets
            .lock()
            .unwrap()
            .entry(session_id.to_owned())
            .or_insert_with(|| FixturePrompts::new(session_id))
            .clone()
    }

    /// Puts a prepared fixture in for a session.
    pub fn insert(&self, session_id: &str, target: Arc<FixturePrompts>) {
        self.targets
            .lock()
            .unwrap()
            .insert(session_id.to_owned(), target);
    }
}

impl PromptSource for FixturePromptSource {
    fn target(&self, session_id: &str) -> Option<Arc<dyn PromptTarget>> {
        let t = self.targets.lock().unwrap().get(session_id).cloned()?;
        Some(t)
    }
}

/// Sample prompts, as the server sends them (the screenshots, the app's
/// fixture and the tests).
pub mod samples {
    use serde_json::{Value, json};

    use super::FixturePrompts;

    /// The sample kinds [`seed`] knows.
    pub const KINDS: [&str; 7] = [
        "permission",
        "permission-queue",
        "plan",
        "plan-mode",
        "elicitation",
        "elicitation-url",
        "ask",
    ];

    /// Sets the samples `kinds` names (comma-separated [`KINDS`]) on a
    /// fixture; the unknown names, if any.
    pub fn seed(target: &FixturePrompts, kinds: &str) -> Vec<String> {
        let mut unknown = Vec::new();
        for kind in kinds.split(',').map(str::trim).filter(|k| !k.is_empty()) {
            match kind {
                "permission" => target.event(permission_bash("perm-1")),
                "permission-queue" => {
                    target.event(permission_bash("perm-1"));
                    target.event(permission_edit("perm-2"));
                    target.event(permission_bash("perm-3"));
                }
                "plan" => target.event(plan("plan-1")),
                "plan-mode" => target.update(|s| s.permission_mode = Some(json!("plan"))),
                "elicitation" => target.event(elicitation_form("elicit-1")),
                "elicitation-url" => target.event(elicitation_url("elicit-2", Some("el-2"))),
                "ask" => target.event(ask_two("ask-1")),
                other => unknown.push(other.to_owned()),
            }
        }
        unknown
    }

    pub fn permission_bash(id: &str) -> Value {
        json!({
            "type": "permission_request",
            "requestId": id,
            "toolName": "Bash",
            "toolUseId": format!("toolu_{id}"),
            "input": { "command": "git push --force-with-lease origin feat/rust-port", "description": "Push the branch" },
            "suggestedRules": [{ "toolName": "Bash", "ruleContent": "git push:*" }]
        })
    }

    pub fn permission_edit(id: &str) -> Value {
        json!({
            "type": "permission_request",
            "requestId": id,
            "toolName": "Edit",
            "toolUseId": format!("toolu_{id}"),
            "input": { "file_path": "src/main.rs", "old_string": "a", "new_string": "b" },
            "agentId": "explorer-2"
        })
    }

    pub fn plan(id: &str) -> Value {
        json!({
            "type": "plan_approval_request",
            "requestId": id,
            "toolUseId": format!("toolu_{id}"),
            "plan": "# Port the prompt cards\n\n1. Pure state first: the form rules, cited.\n2. A `PromptTarget` over the chat state.\n3. The GPUI cards, light and dark.\n\n- Goldens for the schema mapping and `formatAskAsPrompt`.\n- Headless tests for every decision."
        })
    }

    pub fn elicitation_form(id: &str) -> Value {
        json!({
            "type": "mcp_elicitation_request",
            "requestId": id,
            "serverName": "linear",
            "message": "Create the issue with these details.",
            "mode": "form",
            "requestedSchema": {
                "type": "object",
                "properties": {
                    "title": { "type": "string", "title": "Title", "minLength": 3 },
                    "priority": { "type": "string", "title": "Priority", "enum": ["low", "medium", "high"], "enumNames": ["Low", "Medium", "High"] },
                    "estimate": { "type": "integer", "title": "Estimate (points)", "minimum": 1, "maximum": 13 },
                    "labels": { "type": "array", "title": "Labels", "items": { "enum": ["bug", "ui", "port"] } },
                    "notify": { "type": "boolean", "title": "Notify the team", "default": true }
                },
                "required": ["title", "priority"]
            }
        })
    }

    pub fn elicitation_url(id: &str, elicitation_id: Option<&str>) -> Value {
        let mut v = json!({
            "type": "mcp_elicitation_request",
            "requestId": id,
            "serverName": "github",
            "message": "Sign in to GitHub to continue.",
            "mode": "url",
            "url": "https://github.com/login/oauth/authorize?client_id=abc"
        });
        if let Some(e) = elicitation_id {
            v["elicitationId"] = json!(e);
        }
        v
    }

    pub fn ask_two(id: &str) -> Value {
        json!({
            "type": "ask_user_question",
            "requestId": id,
            "toolUseId": format!("toolu_{id}"),
            "questions": [
                {
                    "question": "Which storage should the cache use?",
                    "header": "Storage",
                    "options": [
                        { "label": "SQLite", "description": "One file per project, as today" },
                        { "label": "In memory", "description": "Fast, gone on restart" }
                    ],
                    "multiSelect": false
                },
                {
                    "question": "Which screens should land first?",
                    "header": "Screens",
                    "options": [
                        { "label": "Chat", "description": "Transcript and composer" },
                        { "label": "Git", "description": "Status and diffs" },
                        { "label": "Files", "description": "The tree and preview" }
                    ],
                    "multiSelect": true
                }
            ]
        })
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    #[test]
    fn the_fixture_queues_prompts_and_records_answers() {
        let t = FixturePrompts::new("s1");
        t.event(samples::permission_bash("p1"));
        t.event(samples::permission_edit("p2"));
        let st = t.state();
        assert_eq!(st.permission_count, 2);
        assert_eq!(st.permission.unwrap()["requestId"], "p1");
        t.act(Box::new(|s, env| {
            s.resolve_permission("p1", &json!({ "kind": "allow_once" }), env)
        }));
        assert_eq!(
            t.posts(),
            [(
                "/api/sessions/s1/permission".to_owned(),
                r#"{"requestId":"p1","decision":{"kind":"allow_once"}}"#.to_owned()
            )]
        );
        assert_eq!(t.state().permission.unwrap()["requestId"], "p2");
    }

    #[test]
    fn auto_mode_is_available_unless_disabled_or_on() {
        let mut st = PromptState {
            permission_mode: Some("default".into()),
            ..Default::default()
        };
        assert!(st.auto_mode_available(false));
        assert!(!st.auto_mode_available(true));
        st.permission_mode = Some("auto".into());
        assert!(!st.auto_mode_available(false));
    }

    #[test]
    fn send_prompt_sends_through_the_machine() {
        let t = FixturePrompts::new("s1");
        t.send_prompt("> Q?\nA".into());
        let posts = t.posts();
        assert_eq!(posts.len(), 1);
        assert_eq!(posts[0].0, "/api/sessions/s1/input");
        assert!(posts[0].1.contains(r#""text":"> Q?\nA""#), "{}", posts[0].1);
    }

    #[test]
    fn a_source_hands_out_its_fixtures() {
        let src = FixturePromptSource::new();
        assert!(src.target("s").is_none());
        let t = src.session("s");
        t.event(samples::plan("pl"));
        let got = src.target("s").unwrap();
        assert!(PromptState::read(&*got).plan.is_object());
    }
}
