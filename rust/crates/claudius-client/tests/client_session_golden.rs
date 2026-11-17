//! Replays `tests/fixtures/client_session_golden.json`, recorded from the
//! real `useSession` hook (react-dom 19 in node, fake EventSource / fetch /
//! clock / timers) by `rust/scripts/client-session-golden.mjs`, through
//! `ChatState`.
//!
//! Each scenario starts from its recorded prelude (mount, bind, the stream's
//! `open`). The boot and the bind are U01k's, so the harness seeds their
//! outcome instead: a fresh `ChatState` for the stream URL's tab id, with
//! the cells the prelude changed copied from its snapshot (only the ones
//! `seed` knows; any other is a failure), the poll timer the mount armed,
//! and the recorded clock and uuid count. Then every step runs as the
//! recorder ran it: `hidden` sets `document.hidden`, the clock moves by
//! `dt`, firing each timer that falls due (`timer_fired`), then the step's
//! SSE message (`on_message`) or action goes in. Every fetch an effect starts is answered with the recorded
//! response at the same position, in issue order, until none is left.
//!
//! After each step the whole snapshot is compared with the recorded one
//! (as canonical text: keys sorted, JS number text), and so are the
//! fetches (method, url, headers, body), the timer log (set / clear / fire),
//! the window events, the history writes and the console output. Only
//! `storage` is not: the boot guard's sessionStorage marker is U01k's (the
//! harness checks that it is the only key written).
//!
//! U01d's scenarios (after U01c's 27) feed `sdk` messages in the SDK's
//! shapes: unstreamed and streamed turns, stream edge cases, interleaved
//! subagent output, aborted and errored results, the rate-limit /
//! high-demand / model-unavailable texts, results without an assistant
//! message, fast-mode edges, odd payloads, usage across models and the
//! tool rail's cap.

use std::collections::VecDeque;

use claudius_client::FixedEnv;
use claudius_client::effect::{Effect, FetchOutcome, TimerId};
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
                Effect::UnhandledRejection { error } => {
                    self.log
                        .logs
                        .push(json!({ "level": "unhandledRejection", "text": error }));
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

/// The boot's outcome (U01k): copy the cells the prelude changed.
fn seed(state: &mut ChatState, key: &str, v: &Value, scenario: &str) {
    match key {
        "sessionId" => state.session_id = v.as_str().map(str::to_owned),
        "cwd" => state.cwd = v.clone(),
        "sessions" => state.sessions = v.as_array().unwrap().clone(),
        "accountsConfigured" => state.accounts_configured = v.as_f64().unwrap(),
        "advisorModel" => state.advisor_model = v.as_str().map(str::to_owned),
        "suggestedUuids" | "goalUuids" => {
            let set = v
                .as_array()
                .unwrap()
                .iter()
                .map(|u| u.as_str().unwrap().to_owned())
                .collect();
            if key == "goalUuids" {
                state.goal_uuids = set;
            } else {
                state.suggested_uuids = set;
            }
        }
        _ => panic!("{scenario}: the prelude changed `{key}`, which the harness can't seed (U01k)"),
    }
}

fn diff_keys(got: &Value, want: &Value) -> Vec<String> {
    let (g, w) = (got.as_object().unwrap(), want.as_object().unwrap());
    let mut out = Vec::new();
    for (k, wv) in w {
        let gv = g.get(k).cloned().unwrap_or(Value::Null);
        if canon(&gv) != canon(wv) {
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

#[test]
fn replays_the_ts_golden() {
    let fx = fixture();
    let scenarios = fx["scenarios"].as_array().unwrap();
    // U01c's 27, then U01d's.
    assert!(scenarios.len() >= 39, "{} scenarios", scenarios.len());
    let mut failures = Vec::new();
    let mut steps = 0;
    for sc in scenarios {
        let name = sc["name"].as_str().unwrap();
        let prelude = &sc["prelude"];
        let url = prelude["eventSource"].as_str().unwrap();
        let tab = url.split("tabId=").nth(1).unwrap();
        let mut state = ChatState::new(tab);
        let fresh = state.snapshot();
        let mut expected = prelude["state"].clone();
        for (k, v) in expected.as_object().unwrap() {
            if canon(&fresh[k]) != canon(v) {
                seed(&mut state, k, v, name);
            }
        }
        let d = diff_keys(&state.snapshot(), &expected);
        assert!(
            d.is_empty(),
            "{name}: seeded prelude differs:\n{}",
            d.join("\n")
        );
        // The mount arms the poll first; it's the prelude's only timer.
        let poll = state.start_sessions_poll();
        let recorded: Vec<&Value> = list(prelude, "timers").iter().collect();
        assert_eq!(recorded.len(), 1, "{name}: prelude timers {recorded:?}");
        let Effect::SetTimer { id, ms, repeat } = poll[0] else {
            panic!("{name}: the poll armed {poll:?}");
        };
        assert_eq!(
            canon(recorded[0]),
            canon(&json!({ "op": "set", "id": id.0, "kind": "interval", "ms": ms })),
            "{name}"
        );
        assert!(repeat);
        let now = prelude["at"].as_f64().unwrap();
        let mut env = FixedEnv::new(now);
        env.uuids = prelude["uuids"].as_u64().unwrap();
        let mut h = Harness {
            state,
            env,
            timers: vec![Armed {
                id,
                due: now + ms,
                ms,
                repeat,
            }],
            replies: &[],
            log: Log::default(),
            data: String::new(),
            at: String::new(),
        };

        for (i, step) in sc["steps"].as_array().unwrap().iter().enumerate() {
            steps += 1;
            let input = step
                .get("data")
                .or_else(|| step.get("action"))
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
                let fx = h.state.on_message(data, &mut h.env);
                h.run(fx);
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
                    d if d.starts_with("dismiss") => {
                        dismiss(&mut h.state, d);
                        Vec::new()
                    }
                    other => panic!("{}: no port of the action {other}", h.at),
                };
                h.run(fx);
            }
            let at = h.at.clone();
            assert_eq!(h.env.now, step["at"].as_f64().unwrap(), "{at}: clock");
            for (k, v) in step["state"].as_object().unwrap() {
                expected[k] = v.clone();
            }
            let d = diff_keys(&h.state.snapshot(), &expected);
            if !d.is_empty() {
                failures.push(format!("{at}: state differs\n{}", d.join("\n")));
                // The logs of a step whose state is off would only repeat it.
                continue;
            }
            // The only sessionStorage writer so far is the boot guard
            // (U01k), clearing its marker once the replay settles.
            if let Some(storage) = step.get("storage").and_then(Value::as_object) {
                let keys: Vec<&String> = storage.keys().collect();
                assert!(
                    keys.iter().all(|k| *k == "claudius:boot-pending"),
                    "{at}: sessionStorage {keys:?}: a writer the port doesn't cover"
                );
            }
            let log = std::mem::take(&mut h.log);
            for (what, got, key) in [
                ("fetches", &log.fetches, "fetches"),
                ("timers", &log.timers, "timers"),
                ("window events", &log.window_events, "windowEvents"),
                ("history", &log.history, "history"),
                ("logs", &log.logs, "logs"),
            ] {
                check_list(&at, what, got, list(step, key), &mut failures);
            }
        }
    }
    assert!(
        failures.is_empty(),
        "{} of {steps} steps differ:\n{}",
        failures.len(),
        failures.join("\n")
    );
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
        other => panic!("no port of the action {other}"),
    }
}
