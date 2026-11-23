//! U01j: the queue mirror and the send actions.
//!
//! - `queue:updated`: the server's queue snapshot replaces the local mirror
//!   wholesale (`queue`), and `sdkQueuedTurns` the SDK-side count.
//! - `send`: the optimistic user bubble (dimmed `pending`), the suggestion /
//!   goal badges, then `POST /input`; a failure rolls the bubble back and
//!   raises the error banner, a `queued` reply drops the bubble (the queue
//!   strip shows it instead).
//! - `enqueue` (`forceQueue`), `cancelQueued` / `editQueued` (DELETE the
//!   row; an edit gets it back), `reorderQueued`, `sendQueuedNow`,
//!   `sendAllQueuedNow`: round trips the `queue:updated` echo reflects.
//! - `interrupt` (the "N queued messages will still run" pill), `takeOver`.
//! - `renameTitle`, `setGoal` / `clearGoal`: optimistic, reverted on a
//!   failure to the value the call started from.
//! - `submitFeedback`.
//!
//! The promise-valued ones (`send`, `enqueue`, `editQueued`, `renameTitle`,
//! `setGoal`, `clearGoal`, `submitFeedback`) end with an
//! [`Effect::ActionResolved`] (see `effect.rs`). `requestRecap` /
//! `dismissRecap` were ported ahead of this slice (U01c, `apply.rs`), and
//! `dismissFeedback` with U01i's dismissals (`status.rs`).

use claudius_agent::js::trim as js_trim;
use serde_json::{Map, Value, json};

use crate::account::{error_message, http_error};
use crate::apply::Cx;
use crate::effect::{Action, Effect, FetchOutcome};
use crate::env::ClientEnv;
use crate::event::JsObject;
use crate::state::{ChatState, GoalState, SessionRecap, Then};
use crate::text::{as_str, prop, to_js_string, truthy};
use crate::{AttachedImage, DisplayBlock, DisplayMessage, JsThrow, Role, SystemEntry};
use crate::{SystemEntryKind, types::num};

const JSON_HEADERS: &[(&str, &str)] = &[("Content-Type", "application/json")];

/// An image handed to `send`: `id` and `ordinal` are minted when missing
/// (a fresh uuid, the 1-based position).
#[derive(Debug, Clone, PartialEq)]
pub struct SendImage {
    pub id: Option<String>,
    pub ordinal: Option<f64>,
    pub data: String,
    pub media_type: String,
}

/// `send`'s `opts`.
#[derive(Debug, Clone, Default, PartialEq, Eq)]
pub struct SendOpts {
    pub as_slash_command: bool,
    pub from_suggestion: bool,
    pub from_goal: bool,
    /// Sent only when not empty.
    pub inline_pastes: Vec<String>,
    /// The composer shows its own hint, so a network failure raises no
    /// banner.
    pub reports_failure_inline: bool,
}

/// `submitFeedback`'s `input`.
#[derive(Debug, Clone, Default, PartialEq, Eq)]
pub struct FeedbackInput {
    pub rating: Option<String>,
    pub comment: String,
    pub attach_transcript: Option<bool>,
}

/// What a queue action's fetch continues with.
#[derive(Debug, Clone, PartialEq)]
pub(crate) enum QueueThen {
    /// `send`'s POST: the optimistic bubble's uuid (when it showed one) and
    /// whether a network failure raises the banner.
    Send {
        bubble: Option<String>,
        banner: bool,
    },
    Enqueue,
    EditQueued {
        qid: String,
    },
    Interrupt,
    /// `renameTitle`'s POST, and the title the call started from.
    Rename {
        prev: Value,
    },
    /// `setGoal` / `clearGoal`'s POST, and the goal the call started from.
    Goal {
        prev: Box<Option<GoalState>>,
        action: Action,
    },
    Feedback,
}

fn resolved(action: Action, outcome: Value) -> Effect {
    Effect::ActionResolved { action, outcome }
}

/// `x && x.length` is truthy: a non-empty array or string, or an object
/// whose own `length` is truthy.
fn has_length(v: Option<&Value>) -> bool {
    match v {
        Some(Value::Array(a)) => !a.is_empty(),
        Some(Value::String(s)) => !s.is_empty(),
        Some(o @ Value::Object(_)) => truthy(prop(Some(o), "length")),
        _ => false,
    }
}

impl ChatState {
    /// `queue:updated`: the server's snapshot replaces the mirror. Each row
    /// is `{ id: uuid, text }` plus the truthy flags; `.map` throws on a
    /// list that isn't an array or a `null` row, before anything changes.
    pub(crate) fn on_queue_updated(&mut self, ev: &JsObject) -> Result<(), JsThrow> {
        let rows = match ev.get("queue") {
            None => {
                return Err(JsThrow::type_error(
                    "Cannot read properties of undefined (reading 'map')",
                ));
            }
            Some(Value::Null) => return Err(JsThrow::read_of_null("map")),
            Some(Value::Array(rows)) => rows,
            Some(_) => return Err(JsThrow::type_error("ev.queue.map is not a function")),
        };
        let mut next = Vec::with_capacity(rows.len());
        for q in rows {
            if q.is_null() {
                return Err(JsThrow::read_of_null("uuid"));
            }
            let mut row = Map::new();
            for (from, to) in [("uuid", "id"), ("text", "text")] {
                if let Some(v) = prop(Some(q), from) {
                    row.insert(to.into(), v.clone());
                }
            }
            for flag in ["hasImages", "slash", "fromSuggestion", "fromGoal"] {
                if truthy(prop(Some(q), flag)) {
                    row.insert(flag.into(), Value::Bool(true));
                }
            }
            next.push(Value::Object(row));
        }
        self.queue = next;
        self.sdk_queued_turns = match ev.get("sdkQueuedTurns") {
            None | Some(Value::Null) => json!(0),
            Some(v) => v.clone(),
        };
        Ok(())
    }

    /// `send(text, images, opts)`: the optimistic bubble (not for a slash
    /// command), then `POST /api/sessions/{id}/input`. Resolves with a
    /// `SendResult`.
    pub fn send(
        &mut self,
        text: &str,
        images: Option<&[SendImage]>,
        opts: &SendOpts,
        env: &mut dyn ClientEnv,
    ) -> Vec<Effect> {
        let mut cx = Cx::new(env);
        let has_images = images.is_some_and(|i| !i.is_empty());
        if js_trim(text).is_empty() && !has_images {
            cx.out.push(resolved(Action::Send, json!({ "ok": true })));
            return cx.out;
        }
        let Some(id) = self.bound_id() else {
            cx.out.push(resolved(
                Action::Send,
                json!({ "ok": false, "error": "no session" }),
            ));
            return cx.out;
        };
        self.session_recap = SessionRecap::idle();
        let normalized: Option<Vec<AttachedImage>> = images.filter(|_| has_images).map(|imgs| {
            imgs.iter()
                .enumerate()
                .map(|(i, img)| AttachedImage {
                    id: img.id.clone().unwrap_or_else(|| cx.env.random_uuid()),
                    ordinal: img.ordinal.unwrap_or((i + 1) as f64),
                    data: img.data.clone(),
                    media_type: img.media_type.clone(),
                })
                .collect()
        });
        let uuid = cx.env.random_uuid();
        let bubble = !opts.as_slash_command;
        if bubble {
            let mut m =
                DisplayMessage::new(uuid.clone(), Role::User, vec![DisplayBlock::text(text)]);
            m.images = normalized.clone();
            m.created_at = Some(cx.env.now_ms());
            m.pending = Some(true);
            self.messages.push(m);
        }
        if opts.from_suggestion {
            self.suggested_uuids.insert(uuid.clone());
        }
        if opts.from_goal {
            self.goal_uuids.insert(uuid.clone());
        }
        self.prompt_suggestions.clear();
        self.errors.clear();
        self.process_exited = false;
        let mut body = Map::new();
        body.insert("text".into(), json!(text));
        if let Some(imgs) = &normalized {
            let imgs = serde_json::to_value(imgs).expect("images serialize");
            body.insert("images".into(), imgs);
        }
        body.insert("uuid".into(), json!(uuid));
        for (on, key) in [
            (opts.as_slash_command, "slash"),
            (opts.from_suggestion, "fromSuggestion"),
            (opts.from_goal, "fromGoal"),
        ] {
            if on {
                body.insert(key.into(), Value::Bool(true));
            }
        }
        if !opts.inline_pastes.is_empty() {
            body.insert("inlinePastes".into(), json!(opts.inline_pastes));
        }
        let then = QueueThen::Send {
            bubble: bubble.then_some(uuid),
            banner: !opts.reports_failure_inline,
        };
        self.post_json(&mut cx, format!("/api/sessions/{id}/input"), body, then);
        cx.out
    }

    /// `enqueue(text, images)`: stage a message even while idle
    /// (`forceQueue`). Resolves with a `SendResult`.
    pub fn enqueue(
        &mut self,
        text: &str,
        images: Option<&[AttachedImage]>,
        env: &mut dyn ClientEnv,
    ) -> Vec<Effect> {
        let mut cx = Cx::new(env);
        let trimmed = js_trim(text);
        let images = images.filter(|i| !i.is_empty());
        if trimmed.is_empty() && images.is_none() {
            cx.out
                .push(resolved(Action::Enqueue, json!({ "ok": true })));
            return cx.out;
        }
        let Some(id) = self.bound_id() else {
            cx.out.push(resolved(
                Action::Enqueue,
                json!({ "ok": false, "error": "no session" }),
            ));
            return cx.out;
        };
        let mut body = Map::new();
        body.insert("text".into(), json!(trimmed));
        if let Some(imgs) = images {
            let imgs = serde_json::to_value(imgs).expect("images serialize");
            body.insert("images".into(), imgs);
        }
        body.insert("forceQueue".into(), Value::Bool(true));
        let url = format!("/api/sessions/{id}/input");
        self.post_json(&mut cx, url, body, QueueThen::Enqueue);
        cx.out
    }

    /// `cancelQueued(qid)`: `DELETE` the row; the echo shows the removal.
    pub fn cancel_queued(&mut self, qid: &str, env: &mut dyn ClientEnv) -> Vec<Effect> {
        self.fire_and_forget("DELETE", &format!("queue/{qid}"), None, false, env)
    }

    /// `editQueued(qid)`: `DELETE` the row, which answers with its full
    /// content. Resolves with `{ text, images? }`, or `null`.
    pub fn edit_queued(&mut self, qid: &str, env: &mut dyn ClientEnv) -> Vec<Effect> {
        let mut cx = Cx::new(env);
        let Some(id) = self.bound_id() else {
            let action = Action::EditQueued { qid: qid.into() };
            cx.out.push(resolved(action, Value::Null));
            return cx.out;
        };
        self.fetch(
            &mut cx,
            "DELETE",
            format!("/api/sessions/{id}/queue/{qid}"),
            Vec::new(),
            None,
            Then::Queue(QueueThen::EditQueued { qid: qid.into() }),
        );
        cx.out
    }

    /// `reorderQueued(qid, dir)`: `-1` moves the row up, anything else
    /// down.
    pub fn reorder_queued(&mut self, qid: &str, dir: f64, env: &mut dyn ClientEnv) -> Vec<Effect> {
        let direction = if dir == -1.0 { "up" } else { "down" };
        let body = json!({ "direction": direction });
        self.fire_and_forget("POST", &format!("queue/{qid}/move"), Some(body), false, env)
    }

    /// `sendQueuedNow(qid)`: run this row as the very next turn.
    pub fn send_queued_now(&mut self, qid: &str, env: &mut dyn ClientEnv) -> Vec<Effect> {
        self.fire_and_forget("POST", &format!("queue/{qid}/send-now"), None, false, env)
    }

    /// `sendAllQueuedNow()`: flush the whole queue into the running turn.
    pub fn send_all_queued_now(&mut self, env: &mut dyn ClientEnv) -> Vec<Effect> {
        self.fire_and_forget("POST", "queue/send-all", None, false, env)
    }

    /// `takeOver()`: claim the write lock for this tab. The `holder_changed`
    /// echo updates `readOnly`; nothing catches a network failure.
    pub fn take_over(&mut self, env: &mut dyn ClientEnv) -> Vec<Effect> {
        let body = json!({ "tabId": self.my_tab_id });
        self.fire_and_forget("PATCH", "holder", Some(body), true, env)
    }

    /// `interrupt()`: `POST /interrupt`; once it answers (any status) the
    /// turn is over here, and the reply's `stillQueued` uuids raise a pill.
    /// Nothing catches a network failure, and then the turn stays pending.
    pub fn interrupt(&mut self, env: &mut dyn ClientEnv) -> Vec<Effect> {
        let mut cx = Cx::new(env);
        let Some(id) = self.bound_id() else {
            return cx.out;
        };
        self.fetch(
            &mut cx,
            "POST",
            format!("/api/sessions/{id}/interrupt"),
            Vec::new(),
            None,
            Then::Queue(QueueThen::Interrupt),
        );
        cx.out
    }

    /// `renameTitle(title)`: show the trimmed title at once, revert it on a
    /// failure, refresh the session list on a success.
    pub fn rename_title(&mut self, title: &str, env: &mut dyn ClientEnv) -> Vec<Effect> {
        let mut cx = Cx::new(env);
        let Some(id) = self.bound_id() else {
            let no = json!({ "ok": false, "error": "no active session" });
            cx.out.push(resolved(Action::RenameTitle, no));
            return cx.out;
        };
        let trimmed = js_trim(title);
        if trimmed.is_empty() {
            let no = json!({ "ok": false, "error": "title required" });
            cx.out.push(resolved(Action::RenameTitle, no));
            return cx.out;
        }
        let prev = std::mem::replace(&mut self.session_title, json!(trimmed));
        let mut body = Map::new();
        body.insert("sessionId".into(), json!(id));
        body.insert("title".into(), json!(trimmed));
        let url = "/api/sessions/rename".to_owned();
        self.post_json(&mut cx, url, body, QueueThen::Rename { prev });
        cx.out
    }

    /// `setGoal(text)`: a blank text is `clearGoal()`; otherwise the new
    /// goal shows at once (not achieved, `setAt` now) and reverts on a
    /// failure.
    pub fn set_goal(&mut self, text: &str, env: &mut dyn ClientEnv) -> Vec<Effect> {
        let mut cx = Cx::new(env);
        let Some(id) = self.bound_id() else {
            let no = json!({ "ok": false, "error": "no active session" });
            cx.out.push(resolved(Action::SetGoal, no));
            return cx.out;
        };
        let trimmed = js_trim(text);
        if trimmed.is_empty() {
            // `return clearGoal()`: its POST, settling this call.
            self.post_goal(&mut cx, &id, None, Action::SetGoal);
            return cx.out;
        }
        let goal = GoalState {
            text: json!(trimmed),
            achieved: false,
            summary: Value::Null,
            set_at: num::to_value(cx.env.now_ms()),
            achieved_at: Value::Null,
        };
        self.post_goal(&mut cx, &id, Some(goal), Action::SetGoal);
        cx.out
    }

    /// `clearGoal()`: drop the goal at once and revert on a failure.
    pub fn clear_goal(&mut self, env: &mut dyn ClientEnv) -> Vec<Effect> {
        let mut cx = Cx::new(env);
        let Some(id) = self.bound_id() else {
            let no = json!({ "ok": false, "error": "no active session" });
            cx.out.push(resolved(Action::ClearGoal, no));
            return cx.out;
        };
        self.post_goal(&mut cx, &id, None, Action::ClearGoal);
        cx.out
    }

    /// `submitFeedback(input)`: forward the nudge's rating / comment. The
    /// banner stays up (`dismissFeedback` closes it). Resolves with
    /// `{ ok, stored, forwarded, reason? }`.
    pub fn submit_feedback(
        &mut self,
        input: &FeedbackInput,
        env: &mut dyn ClientEnv,
    ) -> Vec<Effect> {
        let mut cx = Cx::new(env);
        let Some(id) = self.bound_id() else {
            cx.out
                .push(resolved(Action::SubmitFeedback, feedback_failed()));
            return cx.out;
        };
        let mut body = Map::new();
        body.insert("sessionId".into(), json!(id));
        if let Some(r) = &input.rating {
            body.insert("rating".into(), json!(r));
        }
        body.insert("comment".into(), json!(input.comment));
        if let Some(a) = input.attach_transcript {
            body.insert("attachTranscript".into(), json!(a));
        }
        let url = "/api/feedback".to_owned();
        self.post_json(&mut cx, url, body, QueueThen::Feedback);
        cx.out
    }

    // ---------------------------------------------------------- plumbing

    fn post_json(
        &mut self,
        cx: &mut Cx<'_>,
        url: String,
        body: Map<String, Value>,
        then: QueueThen,
    ) {
        let body = claudius_agent::js::stringify(&Value::Object(body));
        let headers = JSON_HEADERS.to_vec();
        self.fetch(cx, "POST", url, headers, Some(body), Then::Queue(then));
    }

    /// The goal POST (`{ goal: text }`, or `null` to clear), after showing
    /// `goal` at once.
    fn post_goal(&mut self, cx: &mut Cx<'_>, id: &str, goal: Option<GoalState>, action: Action) {
        let sent = goal.as_ref().map_or(Value::Null, |g| g.text.clone());
        let prev = std::mem::replace(&mut self.goal, goal);
        let mut body = Map::new();
        body.insert("goal".into(), sent);
        let url = format!("/api/sessions/{id}/goal");
        self.post_json(
            cx,
            url,
            body,
            QueueThen::Goal {
                prev: Box::new(prev),
                action,
            },
        );
    }

    /// A `void` action's fetch on `/api/sessions/{id}/{route}`, its reply
    /// unread; `uncaught`: nothing catches a network failure.
    fn fire_and_forget(
        &mut self,
        method: &'static str,
        route: &str,
        body: Option<Value>,
        uncaught: bool,
        env: &mut dyn ClientEnv,
    ) -> Vec<Effect> {
        let mut cx = Cx::new(env);
        let Some(id) = self.bound_id() else {
            return cx.out;
        };
        let headers = if body.is_some() {
            JSON_HEADERS.to_vec()
        } else {
            Vec::new()
        };
        let body = body.map(|b| claudius_agent::js::stringify(&b));
        let url = format!("/api/sessions/{id}/{route}");
        self.fetch(
            &mut cx,
            method,
            url,
            headers,
            body,
            Then::Answer { uncaught },
        );
        cx.out
    }

    /// A queue action's fetch settled.
    pub(crate) fn queue_settled(
        &mut self,
        then: QueueThen,
        outcome: &FetchOutcome,
        cx: &mut Cx<'_>,
    ) {
        match then {
            QueueThen::Send { bubble, banner } => self.send_settled(bubble, banner, outcome, cx),
            QueueThen::Enqueue => {
                let value = match outcome {
                    FetchOutcome::Failed(_) => json!({ "ok": false, "error": "network" }),
                    FetchOutcome::Response { status, .. } if !outcome.ok() => {
                        json!({ "ok": false, "error": format!("http {status}") })
                    }
                    FetchOutcome::Response { .. } => json!({ "ok": true }),
                };
                cx.out.push(resolved(Action::Enqueue, value));
            }
            QueueThen::EditQueued { qid } => {
                let body = outcome.ok().then(|| outcome.json()).flatten();
                let value = match body.as_ref().and_then(|b| as_str(prop(Some(b), "text"))) {
                    Some(text) => {
                        let mut row = json!({ "text": text });
                        let images = body.as_ref().and_then(|b| prop(Some(b), "images"));
                        if has_length(images) {
                            row["images"] = images.cloned().unwrap_or_default();
                        }
                        row
                    }
                    None => Value::Null,
                };
                cx.out.push(resolved(Action::EditQueued { qid }, value));
            }
            QueueThen::Interrupt => self.interrupt_settled(outcome, cx),
            QueueThen::Rename { prev } => {
                let value = self.revert_on_failure(outcome, |s| s.session_title = prev);
                if value["ok"] == json!(true) {
                    self.refresh_sessions(crate::state::AfterRefresh::Nothing, cx);
                }
                cx.out.push(resolved(Action::RenameTitle, value));
            }
            QueueThen::Goal { prev, action } => {
                let value = self.revert_on_failure(outcome, |s| s.goal = *prev);
                cx.out.push(resolved(action, value));
            }
            QueueThen::Feedback => {
                let value = feedback_outcome(outcome);
                cx.out.push(resolved(Action::SubmitFeedback, value));
            }
        }
    }

    /// The `try { ... if (!res.ok) { revert; return { ok: false, error } }
    /// return { ok: true } } catch (err) { revert; ... }` of `renameTitle`
    /// and the goal actions.
    fn revert_on_failure(
        &mut self,
        outcome: &FetchOutcome,
        revert: impl FnOnce(&mut Self),
    ) -> Value {
        match outcome {
            FetchOutcome::Failed(e) => {
                revert(self);
                json!({ "ok": false, "error": error_message(e) })
            }
            FetchOutcome::Response { status, .. } if !outcome.ok() => {
                revert(self);
                http_error(*status, Some(&outcome.json().unwrap_or_else(|| json!({}))))
            }
            FetchOutcome::Response { .. } => json!({ "ok": true }),
        }
    }

    fn send_settled(
        &mut self,
        bubble: Option<String>,
        banner: bool,
        outcome: &FetchOutcome,
        cx: &mut Cx<'_>,
    ) {
        let drop_bubble = |s: &mut Self| {
            if let Some(uuid) = &bubble {
                s.messages.retain(|m| &m.uuid != uuid);
            }
        };
        let value = match outcome {
            FetchOutcome::Failed(_) => {
                if banner {
                    self.errors
                        .push(json!("send failed: couldn't reach Claudius"));
                }
                drop_bubble(self);
                json!({ "ok": false, "error": "network" })
            }
            FetchOutcome::Response { status, .. } if !outcome.ok() => {
                // A 503 says why the SDK process couldn't be restarted.
                let mut detail = status.to_string();
                if *status == 503
                    && let Some(e) =
                        prop(outcome.json().as_ref(), "error").filter(|e| truthy(Some(e)))
                {
                    detail = to_js_string(e).unwrap_or_default();
                }
                self.errors.push(json!(format!("send failed: {detail}")));
                drop_bubble(self);
                json!({ "ok": false, "error": format!("http {status}") })
            }
            FetchOutcome::Response { .. } => {
                // Queued: the strip shows it until the drain sends it.
                if truthy(prop(outcome.json().as_ref(), "queued")) {
                    drop_bubble(self);
                }
                json!({ "ok": true })
            }
        };
        cx.out.push(resolved(Action::Send, value));
    }

    fn interrupt_settled(&mut self, outcome: &FetchOutcome, cx: &mut Cx<'_>) {
        if let FetchOutcome::Failed(error) = outcome {
            cx.out.push(Effect::UnhandledRejection {
                error: error.clone(),
            });
            return;
        }
        self.set_pending_tracked(false, cx);
        // `data.stillQueued` on a `null` body throws into the silent catch.
        let still: usize = match prop(outcome.json().as_ref(), "stillQueued") {
            Some(Value::Array(ids)) => ids.iter().filter(|v| v.is_string()).count(),
            _ => 0,
        };
        if still > 0 {
            let s = if still == 1 { "" } else { "s" };
            let label = format!("Stop: {still} queued message{s} will still run");
            let uuid = cx.env.random_uuid();
            self.system_entries.push(SystemEntry::new(
                uuid,
                self.last_assistant_uuid.clone(),
                SystemEntryKind::Info,
                label,
            ));
        }
    }
}

/// `{ ok: false, stored: false, forwarded: false }`.
fn feedback_failed() -> Value {
    json!({ "ok": false, "stored": false, "forwarded": false })
}

/// `submitFeedback`'s reply: `j = res.json().catch(() => ({}))`, then the
/// fields `?? <default>` (a non-2xx is never `ok`, and drops `reason`). A
/// `null` body throws on the field read, into the all-false `catch`.
fn feedback_outcome(outcome: &FetchOutcome) -> Value {
    // A network failure reads as no body and not ok: all false.
    let j = outcome.json().unwrap_or_else(|| json!({}));
    if j.is_null() {
        return feedback_failed();
    }
    let or = |k: &str, d: bool| match prop(Some(&j), k) {
        None | Some(Value::Null) => Value::Bool(d),
        Some(v) => v.clone(),
    };
    let forwarded = or("forwarded", false);
    if !outcome.ok() {
        let stored = or("stored", false);
        return json!({ "ok": false, "stored": stored, "forwarded": forwarded });
    }
    let (ok, stored) = (or("ok", true), or("stored", true));
    let mut out = json!({ "ok": ok, "stored": stored, "forwarded": forwarded });
    if let Some(reason) = as_str(prop(Some(&j), "reason")).filter(|r| !r.is_empty()) {
        out["reason"] = json!(reason);
    }
    out
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::FixedEnv;
    use crate::effect::FetchId;

    fn bound() -> ChatState {
        let mut s = ChatState::new("tab-1");
        s.session_id = Some("s".into());
        s
    }

    fn reply(status: u16, body: &str) -> FetchOutcome {
        FetchOutcome::Response {
            status,
            body: body.into(),
        }
    }

    fn fetch_of(fx: &[Effect]) -> (FetchId, String, Option<String>) {
        let [Effect::Fetch(r)] = fx else {
            panic!("{fx:?}");
        };
        (r.id, format!("{} {}", r.method, r.url), r.body.clone())
    }

    #[test]
    fn actions_need_a_truthy_session() {
        let mut env = FixedEnv::new(1.0);
        for id in [None, Some(String::new())] {
            let mut s = ChatState::new("tab-1");
            s.session_id = id;
            let before = s.clone();
            let no_session = json!({ "ok": false, "error": "no session" });
            let no_active = json!({ "ok": false, "error": "no active session" });
            assert_eq!(
                s.send("hi", None, &SendOpts::default(), &mut env),
                vec![resolved(Action::Send, no_session.clone())]
            );
            assert_eq!(
                s.enqueue("hi", None, &mut env),
                vec![resolved(Action::Enqueue, no_session)]
            );
            assert_eq!(
                s.edit_queued("q", &mut env),
                vec![resolved(
                    Action::EditQueued { qid: "q".into() },
                    Value::Null
                )]
            );
            assert_eq!(
                s.rename_title("t", &mut env),
                vec![resolved(Action::RenameTitle, no_active.clone())]
            );
            assert_eq!(
                s.set_goal("g", &mut env),
                vec![resolved(Action::SetGoal, no_active.clone())]
            );
            assert_eq!(
                s.set_goal(" ", &mut env),
                vec![resolved(Action::SetGoal, no_active.clone())]
            );
            assert_eq!(
                s.clear_goal(&mut env),
                vec![resolved(Action::ClearGoal, no_active)]
            );
            assert_eq!(
                s.submit_feedback(&FeedbackInput::default(), &mut env),
                vec![resolved(Action::SubmitFeedback, feedback_failed())]
            );
            for fx in [
                s.cancel_queued("q", &mut env),
                s.reorder_queued("q", -1.0, &mut env),
                s.send_queued_now("q", &mut env),
                s.send_all_queued_now(&mut env),
                s.interrupt(&mut env),
                s.take_over(&mut env),
                s.request_recap(None, &mut env),
            ] {
                assert!(fx.is_empty(), "{fx:?}");
            }
            assert_eq!(s, before);
        }
    }

    #[test]
    fn nothing_to_send_is_not_a_failure() {
        let mut env = FixedEnv::new(1.0);
        let mut s = bound();
        let before = s.clone();
        let ok = json!({ "ok": true });
        for text in ["", " \n\t\u{a0}\u{feff}\u{2028}"] {
            assert_eq!(
                s.send(text, Some(&[]), &SendOpts::default(), &mut env),
                vec![resolved(Action::Send, ok.clone())]
            );
            assert_eq!(
                s.enqueue(text, Some(&[]), &mut env),
                vec![resolved(Action::Enqueue, ok.clone())]
            );
            assert_eq!(
                s.rename_title(text, &mut env),
                vec![resolved(
                    Action::RenameTitle,
                    json!({ "ok": false, "error": "title required" })
                )]
            );
        }
        assert_eq!(s, before);
    }

    #[test]
    fn a_blank_goal_clears_it() {
        let mut env = FixedEnv::new(1.0);
        let mut s = bound();
        s.goal = Some(GoalState {
            text: json!("old"),
            achieved: true,
            summary: Value::Null,
            set_at: json!(1),
            achieved_at: json!(2),
        });
        let (id, req, body) = fetch_of(&s.set_goal("  ", &mut env));
        assert_eq!(req, "POST /api/sessions/s/goal");
        assert_eq!(body.as_deref(), Some(r#"{"goal":null}"#));
        assert_eq!(s.goal, None);
        let fx = s.fetch_settled(id, reply(500, "{}"), &mut env);
        assert_eq!(
            fx,
            vec![resolved(
                Action::SetGoal,
                json!({ "ok": false, "error": "HTTP 500" })
            )]
        );
        assert_eq!(s.goal.as_ref().map(|g| g.text.clone()), Some(json!("old")));
    }

    #[test]
    fn a_failed_rename_reverts_to_the_title_it_started_from() {
        let mut env = FixedEnv::new(1.0);
        let mut s = bound();
        s.session_title = json!("first");
        let (id, req, body) = fetch_of(&s.rename_title("  second ", &mut env));
        assert_eq!(req, "POST /api/sessions/rename");
        assert_eq!(
            body.as_deref(),
            Some(r#"{"sessionId":"s","title":"second"}"#)
        );
        assert_eq!(s.session_title, json!("second"));
        // The server's echo lands meanwhile; the failure still goes back
        // to the title the call started from.
        s.session_title = json!("echo");
        let fx = s.fetch_settled(
            id,
            FetchOutcome::Failed("TypeError: Failed to fetch".into()),
            &mut env,
        );
        assert_eq!(
            fx,
            vec![resolved(
                Action::RenameTitle,
                json!({ "ok": false, "error": "Failed to fetch" })
            )]
        );
        assert_eq!(s.session_title, json!("first"));
    }

    #[test]
    fn an_interrupt_that_never_answers_keeps_the_turn() {
        let mut env = FixedEnv::new(5.0);
        let mut s = bound();
        s.pending = true;
        let (id, req, body) = fetch_of(&s.interrupt(&mut env));
        assert_eq!(
            (req.as_str(), body),
            ("POST /api/sessions/s/interrupt", None)
        );
        let fx = s.fetch_settled(id, FetchOutcome::Failed("TypeError: x".into()), &mut env);
        assert_eq!(
            fx,
            vec![Effect::UnhandledRejection {
                error: "TypeError: x".into()
            }]
        );
        assert!(s.pending);
        let (id, ..) = fetch_of(&s.interrupt(&mut env));
        let fx = s.fetch_settled(
            id,
            reply(200, r#"{"stillQueued":["a",5,"b",null]}"#),
            &mut env,
        );
        assert!(fx.is_empty());
        assert!(!s.pending);
        assert_eq!(
            s.system_entries[0].label,
            "Stop: 2 queued messages will still run"
        );
    }

    #[test]
    fn odd_queue_snapshots_throw_before_anything_changes() {
        let mut s = bound();
        s.queue = vec![json!({ "id": "keep" })];
        s.sdk_queued_turns = json!(3);
        let before = s.clone();
        for (queue, msg) in [
            (None, "Cannot read properties of undefined (reading 'map')"),
            (
                Some(Value::Null),
                "Cannot read properties of null (reading 'map')",
            ),
            (Some(json!("abc")), "ev.queue.map is not a function"),
            (Some(json!({})), "ev.queue.map is not a function"),
            (
                Some(json!([{ "uuid": "a" }, null])),
                "Cannot read properties of null (reading 'uuid')",
            ),
        ] {
            let mut ev = JsObject::new();
            if let Some(q) = queue {
                ev.insert("queue".into(), q);
            }
            ev.insert("sdkQueuedTurns".into(), json!(9));
            assert_eq!(s.on_queue_updated(&ev), Err(JsThrow::type_error(msg)));
            assert_eq!(s, before);
        }
    }

    #[test]
    fn edited_rows_keep_images_only_with_a_truthy_length() {
        let mut env = FixedEnv::new(1.0);
        let mut s = bound();
        for (body, want) in [
            (r#"{"text":"t","images":[]}"#, json!({ "text": "t" })),
            (
                r#"{"text":"t","images":"ab"}"#,
                json!({ "text": "t", "images": "ab" }),
            ),
            (r#"{"text":"t","images":""}"#, json!({ "text": "t" })),
            (r#"{"text":"t","images":5}"#, json!({ "text": "t" })),
            (
                r#"{"text":"t","images":{"length":0}}"#,
                json!({ "text": "t" }),
            ),
            (
                r#"{"text":"t","images":{"length":2}}"#,
                json!({ "text": "t", "images": { "length": 2 } }),
            ),
            (r#"{"text":5}"#, Value::Null),
            (r#""t""#, Value::Null),
            ("null", Value::Null),
        ] {
            let (id, req, _) = fetch_of(&s.edit_queued("q/1", &mut env));
            assert_eq!(req, "DELETE /api/sessions/s/queue/q/1");
            let fx = s.fetch_settled(id, reply(200, body), &mut env);
            assert_eq!(
                fx,
                vec![resolved(Action::EditQueued { qid: "q/1".into() }, want)],
                "{body}"
            );
        }
    }

    #[test]
    fn js_trim_matches_string_trim() {
        assert_eq!(js_trim("\u{feff}\u{a0} a b \u{2029}\u{3000}"), "a b");
        assert_eq!(js_trim("\u{85}x\u{85}"), "\u{85}x\u{85}");
        assert_eq!(js_trim("\u{180e}x"), "\u{180e}x");
    }
}
