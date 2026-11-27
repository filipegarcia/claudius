//! Replays `tests/fixtures/client_session_golden.json`, recorded from the
//! real `useSession` hook (react-dom 19 in node, fake EventSource / fetch /
//! clock / timers) by `rust/scripts/client-session-golden.mjs`, through
//! `ChatState`.
//!
//! Each scenario starts with its recorded prelude (U01k): a fresh
//! `ChatState` for the stream URL's tab id is mounted on the scenario's page
//! URL (with its `sessionStorage` and default cwd), which arms the poll and
//! boots (the open-tabs lookup, the boot guard, the create, the bind), and
//! the stream it opened reports `open` unless the scenario says not to.
//! Then every step runs as the recorder ran it: `hidden` sets
//! `document.hidden`, the clock moves by `dt`, firing each timer that falls
//! due (`timer_fired`), then the step's input goes in: an SSE message on a
//! stream (`event_source_message`; the newest unless `source` names one),
//! an `open` / `error` callback (`event_source_open` / `_error`), a
//! `visibilitychange`, or an action. Every fetch an effect starts is
//! answered with the recorded response at the same position, in issue
//! order, until none is left.
//!
//! After the prelude and each step the whole snapshot is compared with the
//! recorded one (as canonical text: keys sorted, JS number text), and so
//! are the fetches (method, url, headers, body), the timer log (set /
//! clear / fire), the window events, the history writes (`replaceState`
//! and U01k's `location.assign`), the console output, the streams opened
//! and closed, and `sessionStorage`.
//!
//! The fixture is recorded from the TS in the tree, which main's
//! 2026-11-23 merge changed after the slices before U01k were ported:
//! [`DRIFT`] lists the snapshot keys of the steps that still show it (to
//! port: U01q). Each listed key must differ, and nothing else in its step.
//!
//! U01d's scenarios (after U01c's 27) feed `sdk` messages in the SDK's
//! shapes: unstreamed and streamed turns, stream edge cases, interleaved
//! subagent output, aborted and errored results, the rate-limit /
//! high-demand / model-unavailable texts, results without an assistant
//! message, fast-mode edges, odd payloads, usage across models and the
//! tool rail's cap.
//!
//! U01g's `task-` scenarios add the todo actions. A promise-valued action's
//! step (`updateTodoItem`, and U01n / U01j's `queue-` actions) also records
//! what its promise resolved to (`resolved`), which the harness compares
//! with the [`Effect::ActionResolved`] the port gives (and its action).

use std::collections::VecDeque;

use claudius_client::FixedEnv;
use claudius_client::effect::{Action, Effect, FetchOutcome, ReadyState, StreamId, TimerId};
use claudius_client::lifecycle::Mount;
use claudius_client::state::ChatState;
use claudius_core::js_string;
use serde_json::{Map, Value, json};

fn fixture() -> Value {
    let path = concat!(
        env!("CARGO_MANIFEST_DIR"),
        "/tests/fixtures/client_session_golden.json"
    );
    js_string::parse(&std::fs::read_to_string(path).unwrap()).unwrap()
}

fn canon(v: &Value) -> String {
    match v {
        Value::Object(m) => {
            let mut keys: Vec<&String> = m.keys().collect();
            keys.sort();
            let body: Vec<String> = keys
                .iter()
                .map(|k| format!("{}:{}", js_string::stringify(&json!(k)), canon(&m[*k])))
                .collect();
            format!("{{{}}}", body.join(","))
        }
        Value::Array(a) => format!("[{}]", a.iter().map(canon).collect::<Vec<_>>().join(",")),
        Value::Number(n) => claudius_agent::js::number_to_string(n.as_f64().unwrap()),
        v => js_string::stringify(v),
    }
}

fn list<'a>(step: &'a Value, key: &str) -> &'a [Value] {
    step.get(key)
        .and_then(Value::as_array)
        .map_or(&[], Vec::as_slice)
}

/// A timer the harness clock runs.
struct Armed {
    id: TimerId,
    due: f64,
    ms: f64,
    repeat: bool,
}

/// What one step did, in the recorder's shape.
#[derive(Default)]
struct Log {
    fetches: Vec<Value>,
    timers: Vec<Value>,
    window_events: Vec<Value>,
    history: Vec<Value>,
    logs: Vec<Value>,
    /// `EventSource`s opened and closed (U01k).
    streams: Vec<Value>,
    /// The promise values the step's action resolved with (U01n / U01j).
    resolved: Vec<Value>,
}

struct Harness<'f> {
    state: ChatState,
    env: FixedEnv,
    timers: Vec<Armed>,
    /// The recorded fetches of the current step, answered in order.
    replies: &'f [Value],
    log: Log,
    data: String,
    at: String,
    /// The streams the machine opened, by the recorder's index.
    sources: Vec<StreamId>,
}

impl<'f> Harness<'f> {
    fn run(&mut self, effects: Vec<Effect>) {
        let mut queue: VecDeque<Effect> = effects.into();
        while let Some(e) = queue.pop_front() {
            match e {
                Effect::Fetch(req) => {
                    let n = self.log.fetches.len();
                    let mut got = Map::new();
                    got.insert("method".into(), json!(req.method));
                    got.insert("url".into(), json!(req.url));
                    if !req.headers.is_empty() {
                        let h: Map<String, Value> = req
                            .headers
                            .iter()
                            .map(|(k, v)| ((*k).to_owned(), json!(v)))
                            .collect();
                        got.insert("headers".into(), Value::Object(h));
                    }
                    if let Some(b) = &req.body {
                        got.insert("body".into(), json!(b));
                    }
                    let Some(want) = self.replies.get(n) else {
                        panic!("{}: unrecorded fetch #{n}: {}", self.at, Value::Object(got));
                    };
                    let outcome = if let Some(r) = want.get("reject") {
                        got.insert("reject".into(), r.clone());
                        FetchOutcome::Failed(r.as_str().unwrap().to_owned())
                    } else {
                        let r = &want["response"];
                        got.insert("response".into(), r.clone());
                        FetchOutcome::Response {
                            status: r["status"].as_u64().unwrap() as u16,
                            body: r["body"].as_str().unwrap().to_owned(),
                        }
                    };
                    self.log.fetches.push(Value::Object(got));
                    queue.extend(self.state.fetch_settled(req.id, outcome, &mut self.env));
                }
                Effect::SetTimer { id, ms, repeat } => {
                    self.log.timers.push(json!({
                        "op": "set",
                        "id": id.0,
                        "kind": if repeat { "interval" } else { "timeout" },
                        "ms": claudius_client::types::num::to_value(ms),
                    }));
                    self.timers.push(Armed {
                        id,
                        due: self.env.now + ms,
                        ms,
                        repeat,
                    });
                }
                Effect::ClearTimer { id } => {
                    self.log.timers.push(json!({ "op": "clear", "id": id.0 }));
                    self.timers.retain(|t| t.id != id);
                }
                Effect::WindowEvent { name, detail } => {
                    self.log
                        .window_events
                        .push(json!({ "type": name, "detail": detail }));
                }
                Effect::ReplaceUrl { url } => {
                    self.log
                        .history
                        .push(json!({ "op": "replaceState", "url": url }));
                }
                Effect::BadPayload { error } => {
                    self.log.logs.push(json!({
                        "level": "error",
                        "text": format!("bad SSE payload {error} {}", self.data),
                    }));
                }
                Effect::ConsoleWarn { text } => {
                    self.log.logs.push(json!({ "level": "warn", "text": text }));
                }
                Effect::ActionResolved { action, outcome } => {
                    self.log.resolved.push(resolution(&action, outcome));
                }
                Effect::UnhandledRejection { error } => {
                    self.log
                        .logs
                        .push(json!({ "level": "unhandledRejection", "text": error }));
                }
                Effect::OpenEventSource { id, url } => {
                    let es = self.sources.len();
                    self.sources.push(id);
                    self.log
                        .streams
                        .push(json!({ "op": "open", "es": es, "url": url }));
                }
                Effect::CloseEventSource { id } => {
                    let es = self.sources.iter().position(|s| *s == id).unwrap();
                    self.log.streams.push(json!({ "op": "close", "es": es }));
                }
                Effect::AssignUrl { url } => {
                    self.log.history.push(json!({ "op": "assign", "url": url }));
                }
            }
        }
    }

    /// Move the clock by `ms`, firing what falls due on the way.
    fn advance(&mut self, ms: f64) {
        let target = self.env.now + ms;
        let next = |timers: &[Armed]| {
            (0..timers.len())
                .filter(|&i| timers[i].due <= target)
                .min_by(|&a, &b| {
                    let (a, b) = (&timers[a], &timers[b]);
                    a.due.total_cmp(&b.due).then(a.id.cmp(&b.id))
                })
        };
        while let Some(i) = next(&self.timers) {
            let id = self.timers[i].id;
            self.env.now = self.timers[i].due;
            if self.timers[i].repeat {
                self.timers[i].due += self.timers[i].ms.max(1.0);
            } else {
                self.timers.remove(i);
            }
            self.log.timers.push(json!({ "op": "fire", "id": id.0 }));
            let fx = self.state.timer_fired(id, &mut self.env);
            self.run(fx);
        }
        self.env.now = target;
    }
}

/// The steps whose snapshot still shows main's 2026-11-23 changes to
/// `use-session.ts`, which the slices before U01k haven't followed yet
/// (U01q): `(scenario, step, key)`. Each key must differ from the
/// recording, and nothing else in the step.
const DRIFT: &[(&str, usize, &str)] = &[
    // `MODEL_UNAVAILABLE_MESSAGE` names Fable 5.2, and
    // `modelUnavailableMessage` names the Fable the prose names.
    (
        "rate-limit, high-demand and model-unavailable texts",
        8,
        "messages",
    ),
    (
        "rate-limit, high-demand and model-unavailable texts",
        9,
        "messages",
    ),
    // A `model_changed` from another source to another model drops the
    // "Switched to X" notice.
    (
        "status-model_changed and the advisor",
        6,
        "chatCommandModelNotice",
    ),
    (
        "status-model_changed and the advisor",
        9,
        "chatCommandModelNotice",
    ),
];

/// The recorder's page URL when a scenario names none, and its
/// `performance.timeOrigin` (`NOW - 5000`).
const DEFAULT_URL: &str = "http://localhost:3000/?session=sess-1";

fn diff_keys(got: &Value, want: &Value, drift: &[&str]) -> Vec<String> {
    let (g, w) = (got.as_object().unwrap(), want.as_object().unwrap());
    let mut out = Vec::new();
    for (k, wv) in w {
        let gv = g.get(k).cloned().unwrap_or(Value::Null);
        let same = canon(&gv) == canon(wv);
        if drift.contains(&k.as_str()) {
            if same {
                out.push(format!(
                    "  {k}: listed in DRIFT, but now matches (unlist it)"
                ));
            }
        } else if !same {
            out.push(format!(
                "  {k}:\n    got  {}\n    want {}",
                canon(&gv),
                canon(wv)
            ));
        }
    }
    for k in g.keys().filter(|k| !w.contains_key(*k)) {
        out.push(format!("  {k}: not in the hook's state"));
    }
    out
}

fn check_list(at: &str, what: &str, got: &[Value], want: &[Value], failures: &mut Vec<String>) {
    let (g, w): (Vec<String>, Vec<String>) = (
        got.iter().map(canon).collect(),
        want.iter().map(canon).collect(),
    );
    if g != w {
        failures.push(format!(
            "{at}: {what} differ\n    got  {}\n    want {}",
            g.join("\n         "),
            w.join("\n         ")
        ));
    }
}

/// `sessionStorage` as the recorder dumps it.
fn storage_of(env: &FixedEnv) -> Value {
    Value::Object(
        env.storage
            .0
            .iter()
            .map(|(k, v)| (k.clone(), json!(v)))
            .collect(),
    )
}

impl Harness<'_> {
    /// Compare what the prelude or a step did with its record; `expected`
    /// is the full recorded snapshot so far.
    fn check(
        &mut self,
        rec: &Value,
        expected: &mut Value,
        storage: &mut Value,
        drift: &[&str],
        failures: &mut Vec<String>,
    ) {
        let at = self.at.clone();
        assert_eq!(self.env.now, rec["at"].as_f64().unwrap(), "{at}: clock");
        for (k, v) in rec["state"].as_object().unwrap() {
            expected[k] = v.clone();
        }
        let d = diff_keys(&self.state.snapshot(), expected, drift);
        if !d.is_empty() {
            failures.push(format!("{at}: state differs\n{}", d.join("\n")));
            // The logs of a step whose state is off would only repeat it.
            self.log = Log::default();
            return;
        }
        if let Some(s) = rec.get("storage") {
            *storage = s.clone();
        }
        check_list(
            &at,
            "sessionStorage",
            &[storage_of(&self.env)],
            std::slice::from_ref(storage),
            failures,
        );
        let log = std::mem::take(&mut self.log);
        for (what, got, key) in [
            ("fetches", &log.fetches, "fetches"),
            ("timers", &log.timers, "timers"),
            ("window events", &log.window_events, "windowEvents"),
            ("history", &log.history, "history"),
            ("logs", &log.logs, "logs"),
            ("streams", &log.streams, "streams"),
        ] {
            check_list(&at, what, got, list(rec, key), failures);
        }
        // U01n / U01j: the promise value of an action that has one.
        let want: Vec<Value> = rec.get("resolved").map_or_else(Vec::new, |v| {
            vec![json!({ "action": rec["action"], "outcome": v })]
        });
        check_list(&at, "resolved", &log.resolved, &want, failures);
    }

    /// The stream a step's callback is for: `source`, else the newest.
    fn source(&self, step: &Value) -> StreamId {
        match step.get("source").and_then(Value::as_u64) {
            Some(i) => self.sources[i as usize],
            None => *self.sources.last().expect("a stream is open"),
        }
    }
}

#[test]
fn replays_the_ts_golden() {
    let fx = fixture();
    let scenarios = fx["scenarios"].as_array().unwrap();
    // U01c's 27, then U01d's.
    assert!(scenarios.len() >= 39, "{} scenarios", scenarios.len());
    // Every scenario's tab id is the same (`getRandomValues` is counted
    // from 0 per scenario); a boot that opens no stream has no URL to show it.
    let any_url = scenarios
        .iter()
        .find_map(|sc| sc["prelude"]["eventSource"].as_str())
        .unwrap();
    let tab = any_url.split("tabId=").nth(1).unwrap().to_owned();
    let mut failures = Vec::new();
    let mut steps = 0;
    let mut drift_seen = 0;
    for sc in scenarios {
        let name = sc["name"].as_str().unwrap();
        let prelude = &sc["prelude"];
        if let Some(url) = prelude["eventSource"].as_str() {
            assert_eq!(url.split("tabId=").nth(1), Some(tab.as_str()), "{name}");
        }
        let now = fx["now"].as_f64().unwrap();
        let mut env = FixedEnv::new(now);
        let mut storage = json!({});
        if let Some(preset) = sc.get("storage").and_then(Value::as_object) {
            for (k, v) in preset {
                env.storage
                    .0
                    .insert(k.clone(), v.as_str().unwrap().to_owned());
            }
            storage = Value::Object(preset.clone());
        }
        let mut state = ChatState::new(tab.clone());
        state.default_cwd = sc
            .get("defaultCwd")
            .and_then(Value::as_str)
            .map(str::to_owned);
        state.pathname = sc
            .get("pathname")
            .and_then(Value::as_str)
            .map(str::to_owned);
        let mut h = Harness {
            state,
            env,
            timers: Vec::new(),
            replies: list(prelude, "fetches"),
            log: Log::default(),
            data: String::new(),
            at: format!("{name} / prelude"),
            sources: Vec::new(),
        };
        let href = sc.get("url").and_then(Value::as_str).unwrap_or(DEFAULT_URL);
        let fx_mount = h.state.mount(
            Mount {
                href,
                page_load: now - 5000.0,
            },
            &mut h.env,
        );
        h.run(fx_mount);
        let no_open = sc.get("noOpen").and_then(Value::as_bool).unwrap_or(false);
        if let (Some(&es), false) = (h.sources.last(), no_open) {
            let fx_open = h.state.event_source_open(es, &mut h.env);
            h.run(fx_open);
        }
        assert_eq!(
            h.env.uuids,
            prelude["uuids"].as_u64().unwrap(),
            "{name}: uuids"
        );
        let mut expected = json!({});
        h.check(prelude, &mut expected, &mut storage, &[], &mut failures);

        for (i, step) in sc["steps"].as_array().unwrap().iter().enumerate() {
            steps += 1;
            let input = step
                .get("data")
                .or_else(|| step.get("action"))
                .or_else(|| step.get("es"))
                .or_else(|| step.get("visibility"))
                .or_else(|| step.get("pathname"))
                .or_else(|| step.get("pushState"))
                .map_or_else(|| "wait".to_owned(), canon);
            h.at = format!(
                "{name} / step {i} ({})",
                input.chars().take(80).collect::<String>()
            );
            h.replies = list(step, "fetches");
            h.log = Log::default();
            h.data = step
                .get("data")
                .and_then(Value::as_str)
                .unwrap_or_default()
                .to_owned();
            if let Some(hidden) = step.get("hidden").and_then(Value::as_bool) {
                h.state.hidden = hidden;
            }
            h.advance(step.get("dt").and_then(Value::as_f64).unwrap_or(1000.0));
            if let Some(data) = step.get("data").and_then(Value::as_str) {
                let es = h.source(step);
                let fx = h.state.event_source_message(es, data, &mut h.env);
                h.run(fx);
            } else if let Some(kind) = step.get("es").and_then(Value::as_str) {
                let es = h.source(step);
                let fx = match kind {
                    "open" => h.state.event_source_open(es, &mut h.env),
                    "error" => {
                        let rs = match step["readyState"].as_u64().unwrap() {
                            0 => ReadyState::Connecting,
                            1 => ReadyState::Open,
                            _ => ReadyState::Closed,
                        };
                        h.state.event_source_error(es, rs, &mut h.env)
                    }
                    other => panic!("{}: es {other}", h.at),
                };
                h.run(fx);
            } else if let Some(v) = step.get("visibility").and_then(Value::as_str) {
                let fx = h.state.visibility_changed(v == "hidden", &mut h.env);
                h.run(fx);
            } else if let Some(p) = step.get("pathname").and_then(Value::as_str) {
                let fx = h.state.set_pathname(Some(p), &mut h.env);
                h.run(fx);
            } else if step.get("navIntent").is_some() {
                h.state.navigation_intent();
            } else if let Some(to) = step.get("pushState").and_then(Value::as_str) {
                let href = url::Url::parse(&h.state.location)
                    .unwrap()
                    .join(to)
                    .unwrap();
                h.state.set_location(href.as_str());
                h.log.history.push(json!({ "op": "pushState", "url": to }));
            } else if let Some(action) = step.get("action").and_then(Value::as_str) {
                let args = list(step, "args");
                let fx = match action {
                    "requestRecap" => {
                        let origin = args.first().and_then(Value::as_str);
                        h.state.request_recap(origin, &mut h.env)
                    }
                    "dismissRecap" => {
                        h.state.dismiss_recap();
                        Vec::new()
                    }
                    "resolvePermission" | "resolveElicitation" | "submitAskAnswer" => {
                        let id = args[0].as_str().unwrap();
                        let (s, env) = (&mut h.state, &mut h.env);
                        match action {
                            "resolvePermission" => s.resolve_permission(id, &args[1], env),
                            "resolveElicitation" => s.resolve_elicitation(id, &args[1], env),
                            _ => s.submit_ask_answer(id, &args[1], env),
                        }
                    }
                    "resolvePlan" => h.state.resolve_plan(&args[0], &mut h.env),
                    "setPermissionMode" => {
                        let mode = args[0].as_str().unwrap();
                        h.state.set_permission_mode(mode, &mut h.env)
                    }
                    "setModel" | "setEffort" | "setUltracode" | "setFast" | "setAdvisorModel"
                    | "reEnableAdvisor" | "setAgent" => status_action(&mut h, action, args),
                    "loadOlder" => h.state.load_older(&mut h.env),
                    "clearTodos" => h.state.clear_todos(&mut h.env),
                    "updateTodoItem" => {
                        let s = |i: usize| args[i].as_str().unwrap();
                        h.state.update_todo_item(s(0), s(1), &mut h.env)
                    }
                    q if QUEUE_ACTIONS.contains(&q) => queue_action(&mut h, q, args),
                    l if LIFE_ACTIONS.contains(&l) => life_action(&mut h, l, args),
                    d if d.starts_with("dismiss") => {
                        dismiss(&mut h.state, d);
                        Vec::new()
                    }
                    other => panic!("{}: no port of the action {other}", h.at),
                };
                h.run(fx);
            }
            let drift: Vec<&str> = DRIFT
                .iter()
                .filter(|(s, n, _)| *s == name && *n == i)
                .map(|(_, _, k)| *k)
                .collect();
            drift_seen += drift.len();
            h.check(step, &mut expected, &mut storage, &drift, &mut failures);
            if !drift.is_empty() {
                // The recording, not the port, carries on.
                let want = expected.clone();
                h.state = rebase(&h.state, &want, &drift);
            }
        }
    }
    assert_eq!(drift_seen, DRIFT.len(), "a DRIFT entry names no step");
    assert!(
        failures.is_empty(),
        "{} of {steps} steps differ:\n{}",
        failures.len(),
        failures.join("\n")
    );
}

/// After a [`DRIFT`] step, carry on from the TS's value of the drifted
/// cells, so the steps after it compare what they change themselves.
fn rebase(state: &ChatState, want: &Value, keys: &[&str]) -> ChatState {
    let mut s = state.clone();
    for k in keys {
        match *k {
            "messages" => s.messages = serde_json::from_value(want[*k].clone()).unwrap(),
            "chatCommandModelNotice" => s.chat_command_model_notice = want[*k].clone(),
            other => panic!("DRIFT key {other} can't be rebased"),
        }
    }
    s
}

/// The lifecycle actions U01k ports.
const LIFE_ACTIONS: &[&str] = &[
    "switchSession",
    "createNewSession",
    "createSessionAt",
    "createNewSessionWithDraft",
    "openSkippedBootSession",
    "refreshSessions",
];

fn life_action(h: &mut Harness<'_>, action: &str, args: &[Value]) -> Vec<Effect> {
    let s = |i: usize| args.get(i).and_then(Value::as_str).unwrap_or_default();
    let (state, env) = (&mut h.state, &mut h.env);
    match action {
        "switchSession" => state.switch_session(s(0), env),
        "createNewSession" => state.create_new_session(env),
        "createSessionAt" => state.create_session_at(s(0), env),
        "createNewSessionWithDraft" => state.create_new_session_with_draft(s(0), env),
        "openSkippedBootSession" => state.open_skipped_boot_session(env),
        "refreshSessions" => state.refresh_session_list(env),
        other => unreachable!("{other}"),
    }
}

/// U01i's status actions.
fn status_action(h: &mut Harness<'_>, action: &str, args: &[Value]) -> Vec<Effect> {
    let s = |i: usize| args.get(i).and_then(Value::as_str);
    let b = |i: usize| args.get(i).and_then(Value::as_bool).unwrap_or(false);
    match action {
        "setModel" => h.state.set_model(s(0), s(1), &mut h.env),
        "setEffort" => {
            let only = args
                .get(1)
                .and_then(|o| o.get("sessionOnly"))
                .and_then(Value::as_bool);
            h.state
                .set_effort(s(0).unwrap(), only.unwrap_or(false), &mut h.env)
        }
        "setUltracode" => h.state.set_ultracode(b(0), &mut h.env),
        "setFast" => h.state.set_fast(b(0), &mut h.env),
        "setAdvisorModel" => h.state.set_advisor_model(s(0), &mut h.env),
        "reEnableAdvisor" => h.state.re_enable_advisor(s(0).unwrap(), &mut h.env),
        "setAgent" => h.state.set_agent(s(0), &mut h.env),
        other => unreachable!("{other}"),
    }
}

/// U01i's `dismiss*` actions.
fn dismiss(state: &mut ChatState, action: &str) {
    match action {
        "dismissFeedback" => state.dismiss_feedback(),
        "dismissOpusOverloadNudge" => state.dismiss_opus_overload_nudge(),
        "dismissLongContextCreditsNudge" => state.dismiss_long_context_credits_nudge(),
        "dismissAuthFailedNudge" => state.dismiss_auth_failed_nudge(),
        "dismissTokenExpiringNudge" => state.dismiss_token_expiring_nudge(),
        "dismissFastModeNotice" => state.dismiss_fast_mode_notice(),
        "dismissChatCommandModelNotice" => state.dismiss_chat_command_model_notice(),
        "dismissModelSwitchNotice" => state.dismiss_model_switch_notice(),
        "dismissAdvisorDisabledNotice" => state.dismiss_advisor_disabled_notice(),
        "dismissAutoModeOffNotice" => state.dismiss_auto_mode_off_notice(),
        "dismissTodosAutoCleared" => state.dismiss_todos_auto_cleared(),
        "dismissSkippedBootSession" => state.dismiss_skipped_boot_session(),
        other => panic!("no port of the action {other}"),
    }
}

/// The actions U01n / U01j port.
const QUEUE_ACTIONS: &[&str] = &[
    "moveToActiveAccount",
    "effortChangeWouldWait",
    "send",
    "enqueue",
    "cancelQueued",
    "editQueued",
    "reorderQueued",
    "sendQueuedNow",
    "sendAllQueuedNow",
    "interrupt",
    "takeOver",
    "renameTitle",
    "setGoal",
    "clearGoal",
    "submitFeedback",
];

/// An `ActionResolved` in the recorder's shape: the TS action's name and
/// its promise value.
fn resolution(action: &Action, outcome: Value) -> Value {
    let name = match action {
        Action::UpdateTodoItem { .. } => "updateTodoItem",
        Action::JumpToUuid { .. } => "jumpToUuid",
        Action::MoveToActiveAccount => "moveToActiveAccount",
        Action::Send => "send",
        Action::Enqueue => "enqueue",
        Action::EditQueued { .. } => "editQueued",
        Action::RenameTitle => "renameTitle",
        Action::SetGoal => "setGoal",
        Action::ClearGoal => "clearGoal",
        Action::SubmitFeedback => "submitFeedback",
        Action::CreateNewSession => "createNewSession",
        Action::RefreshSessions => "refreshSessions",
    };
    json!({ "action": name, "outcome": outcome })
}

/// U01n / U01j's actions, with the recorder's JSON args as the typed ones.
fn queue_action(h: &mut Harness<'_>, action: &str, args: &[Value]) -> Vec<Effect> {
    use claudius_client::AttachedImage;
    use claudius_client::queue::{FeedbackInput, SendImage, SendOpts};
    let s = |i: usize| args.get(i).and_then(Value::as_str).unwrap_or_default();
    let (state, env) = (&mut h.state, &mut h.env);
    match action {
        "moveToActiveAccount" => state.move_to_active_account(env),
        "effortChangeWouldWait" => {
            let waits = state.effort_change_would_wait(s(0));
            h.log
                .resolved
                .push(json!({ "action": action, "outcome": waits }));
            Vec::new()
        }
        "send" => {
            let images: Option<Vec<SendImage>> = args.get(1).and_then(Value::as_array).map(|a| {
                a.iter()
                    .map(|i| SendImage {
                        id: i.get("id").and_then(Value::as_str).map(str::to_owned),
                        ordinal: i.get("ordinal").and_then(Value::as_f64),
                        data: i["data"].as_str().unwrap().to_owned(),
                        media_type: i["mediaType"].as_str().unwrap().to_owned(),
                    })
                    .collect()
            });
            let o = args.get(2).cloned().unwrap_or(Value::Null);
            let flag = |k: &str| o.get(k).and_then(Value::as_bool).unwrap_or(false);
            let opts = SendOpts {
                as_slash_command: flag("asSlashCommand"),
                from_suggestion: flag("fromSuggestion"),
                from_goal: flag("fromGoal"),
                inline_pastes: o
                    .get("inlinePastes")
                    .and_then(Value::as_array)
                    .map(|p| p.iter().map(|x| x.as_str().unwrap().to_owned()).collect())
                    .unwrap_or_default(),
                reports_failure_inline: flag("reportsFailureInline"),
            };
            state.send(s(0), images.as_deref(), &opts, env)
        }
        "enqueue" => {
            let images: Option<Vec<AttachedImage>> = args
                .get(1)
                .filter(|v| !v.is_null())
                .map(|v| serde_json::from_value(v.clone()).unwrap());
            state.enqueue(s(0), images.as_deref(), env)
        }
        "cancelQueued" => state.cancel_queued(s(0), env),
        "editQueued" => state.edit_queued(s(0), env),
        "reorderQueued" => state.reorder_queued(s(0), args[1].as_f64().unwrap(), env),
        "sendQueuedNow" => state.send_queued_now(s(0), env),
        "sendAllQueuedNow" => state.send_all_queued_now(env),
        "interrupt" => state.interrupt(env),
        "takeOver" => state.take_over(env),
        "renameTitle" => state.rename_title(s(0), env),
        "setGoal" => state.set_goal(s(0), env),
        "clearGoal" => state.clear_goal(env),
        "submitFeedback" => {
            let i = &args[0];
            let input = FeedbackInput {
                rating: i.get("rating").and_then(Value::as_str).map(str::to_owned),
                comment: i["comment"].as_str().unwrap().to_owned(),
                attach_transcript: i.get("attachTranscript").and_then(Value::as_bool),
            };
            state.submit_feedback(&input, env)
        }
        other => unreachable!("{other}"),
    }
}
