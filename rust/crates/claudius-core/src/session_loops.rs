//! Session-only loops: what the agent armed with the harness's `CronCreate`
//! and `ScheduleWakeup` tools, reconstructed from the SDK message stream
//! (`trackScheduledLoops` in `lib/server/session.ts`, the shape and readers
//! in `lib/shared/session-loops.ts`, `isScheduleWakeupStop` in
//! `lib/shared/stop-self-paced-loop.ts`).
//!
//! The tracker is pure: database writes come back as [`LoopEffect`]s for the
//! session to run (`recordLoopTick` / `attachLoopTickTokens`), since only it
//! knows the cwd and title.

use std::sync::LazyLock;

use claudius_agent::js;
use indexmap::{IndexMap, IndexSet};
use regex::Regex;
use serde_json::{Map, Value, json};

use crate::js_num;

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum LoopKind {
    Cron,
    Wakeup,
}

impl LoopKind {
    pub fn as_str(self) -> &'static str {
        match self {
            LoopKind::Cron => "cron",
            LoopKind::Wakeup => "wakeup",
        }
    }
}

/// `SessionLoop`.
#[derive(Clone, Debug, PartialEq)]
pub struct SessionLoop {
    pub kind: LoopKind,
    /// The cron id (from CronCreate's result) or the wake-up's tool_use id.
    pub id: String,
    pub tool_use_id: String,
    pub cron: Option<String>,
    pub human_schedule: Option<String>,
    pub delay_seconds: Option<f64>,
    pub prompt: String,
    pub reason: Option<String>,
    pub recurring: bool,
    /// False when CronCreate's result said "session-only".
    pub durable: bool,
    /// When it was armed (the transcript's timestamp on a replay).
    pub started_at: i64,
    /// Epoch ms of the cron's next run, from the structured `CronCreate`
    /// result (SDK 0.3.299 `CronCreateOutput.nextFireAt`). A snapshot taken
    /// when the job was created: it is not updated after the job fires.
    pub next_fire_at: Option<f64>,
    /// `noop: true` on the ScheduleWakeup call; `noop_streak` counts this
    /// quiet tick and the quiet ones it superseded (0 when not `noop`).
    pub noop: bool,
    pub noop_streak: u64,
    pub cancelled: bool,
}

impl SessionLoop {
    /// The wire shape, in the key order the TS objects end up with
    /// (`reason` only when a string, `noop` / `noopStreak` only for a quiet
    /// tick, `nextFireAt` last since it's added after the fact).
    pub fn to_json(&self) -> Value {
        let mut m = Map::new();
        m.insert("kind".into(), json!(self.kind.as_str()));
        m.insert("id".into(), json!(self.id));
        m.insert("toolUseId".into(), json!(self.tool_use_id));
        m.insert("cron".into(), json!(self.cron));
        m.insert("humanSchedule".into(), json!(self.human_schedule));
        m.insert(
            "delaySeconds".into(),
            self.delay_seconds.map_or(Value::Null, js_num),
        );
        m.insert("prompt".into(), json!(self.prompt));
        if let Some(r) = &self.reason {
            m.insert("reason".into(), json!(r));
        }
        m.insert("recurring".into(), json!(self.recurring));
        m.insert("durable".into(), json!(self.durable));
        m.insert("startedAt".into(), json!(self.started_at));
        m.insert("cancelled".into(), json!(self.cancelled));
        if self.noop {
            m.insert("noop".into(), json!(true));
            m.insert("noopStreak".into(), json!(self.noop_streak));
        }
        if let Some(n) = self.next_fire_at {
            m.insert("nextFireAt".into(), js_num(n));
        }
        Value::Object(m)
    }
}

/// A database write the tracker asks for.
#[derive(Clone, Debug, PartialEq)]
pub enum LoopEffect {
    /// `recordLoopTick` for a wake-up just armed (the caller adds the
    /// session id and title).
    RecordTick {
        tool_use_id: String,
        prompt: String,
        fired_at: i64,
        noop: bool,
    },
    /// `attachLoopTickTokens`: the usage of the turn a tick was armed in.
    AttachTokens { tool_use_id: String, tokens: f64 },
}

/// `finiteMs`: a positive number.
fn finite_ms(v: Option<&Value>) -> Option<f64> {
    v.and_then(Value::as_f64)
        .filter(|f| f.is_finite() && *f > 0.0)
}

/// `readCronNextFireAt(toolUseResult)` (SDK 0.3.299): the `nextFireAt` on
/// the `tool_use_result` riding the user message that carries a
/// `CronCreate` tool_result. A non-object, a missing field and anything
/// but a finite positive number read as none.
pub fn read_cron_next_fire_at(tool_use_result: Option<&Value>) -> Option<f64> {
    finite_ms(tool_use_result?.get("nextFireAt"))
}

/// `isScheduleWakeupStop`: a strict `stop: true`.
pub fn is_schedule_wakeup_stop(input: Option<&Value>) -> bool {
    input.and_then(|i| i.get("stop")) == Some(&Value::Bool(true))
}

/// `WAKEUP_STALE_GRACE_MS`: how long past its fire moment a wake-up still
/// shows.
pub const WAKEUP_STALE_GRACE_MS: f64 = 60_000.0;

/// `isStaleWakeup(loop, now)`: a wake-up (with a delay) whose fire moment,
/// `startedAt + delaySeconds * 1000` in JS doubles, is more than
/// [`WAKEUP_STALE_GRACE_MS`] before `now`. A cron never is.
pub fn is_stale_wakeup(l: &SessionLoop, now: f64) -> bool {
    if l.kind != LoopKind::Wakeup {
        return false;
    }
    let Some(delay) = l.delay_seconds else {
        return false;
    };
    let fire_at = l.started_at as f64 + delay * 1000.0;
    now > fire_at + WAKEUP_STALE_GRACE_MS
}

/// `scheduledLoopCancelPrompt(loop)` (`lib/shared/stop-self-paced-loop.ts`):
/// what the user side sends to have the agent cancel a loop. A cron is
/// deleted by its id; a self-paced loop is stopped with `ScheduleWakeup`'s
/// `stop: true`.
pub fn cancel_prompt(l: &SessionLoop) -> String {
    match l.kind {
        LoopKind::Wakeup => "Please stop the self-paced loop by calling `ScheduleWakeup` with `stop: true`. Reply with one short line confirming it's stopped \u{2014} don't run any other tools.".to_owned(),
        LoopKind::Cron => format!(
            "Please cancel the scheduled loop with id `{}` by calling `CronDelete` on it. Reply with one short line confirming it's cancelled \u{2014} don't run any other tools.",
            l.id
        ),
    }
}

/// `/job\s+([a-z0-9]+)\s*\(([^)]+)\)/i` as V8 runs it: `\s` is JS
/// whitespace (U+FEFF yes, U+0085 no) and, without the `u` flag, case
/// folding never maps a non-ASCII letter onto ASCII.
static JOB_RE: LazyLock<Regex> = LazyLock::new(|| {
    const WS: &str = r"[\t\n\x0B\x0C\r \u{A0}\u{1680}\u{2000}-\u{200A}\u{2028}\u{2029}\u{202F}\u{205F}\u{3000}\u{FEFF}]";
    Regex::new(&format!(r"[jJ][oO][bB]{WS}+([a-zA-Z0-9]+){WS}*\(([^)]+)\)")).unwrap()
});

/// `/session[- ]only/i` (ASCII-only folding, as above).
fn says_session_only(text: &str) -> bool {
    let lower = text.to_ascii_lowercase();
    lower.contains("session-only") || lower.contains("session only")
}

/// A tool_result's text: a string, or its truthy `text` blocks joined.
fn result_text(content: Option<&Value>) -> String {
    match content {
        Some(Value::String(s)) => s.clone(),
        Some(Value::Array(blocks)) => {
            let mut text = String::new();
            for c in blocks {
                if c.get("type").and_then(Value::as_str) == Some("text")
                    && let Some(t) = c.get("text").filter(|t| js::truthy(t))
                {
                    text.push_str(&js::to_string(Some(t)));
                }
            }
            text
        }
        _ => String::new(),
    }
}

/// The per-session loop state.
#[derive(Clone, Debug, Default)]
pub struct LoopTracker {
    /// By stable loop id, in JS `Map` order (a replaced value keeps its
    /// slot; a deleted key's slot goes).
    loops: IndexMap<String, SessionLoop>,
    /// CronCreate calls awaiting their result, by tool_use id.
    pending: IndexMap<String, SessionLoop>,
    /// `ScheduleWakeup { stop: true }` calls already applied.
    applied_wakeup_stops: IndexSet<String>,
    /// Ticks armed this turn, awaiting the turn's `result`.
    pending_tick_attribution: Vec<String>,
}

impl LoopTracker {
    /// `getScheduledLoops`.
    pub fn loops(&self) -> Vec<SessionLoop> {
        self.loops.values().cloned().collect()
    }

    /// CronCreate calls still waiting for their result.
    pub fn pending(&self) -> Vec<SessionLoop> {
        self.pending.values().cloned().collect()
    }

    pub fn applied_wakeup_stops(&self) -> Vec<String> {
        self.applied_wakeup_stops.iter().cloned().collect()
    }

    pub fn pending_tick_attribution(&self) -> &[String] {
        &self.pending_tick_attribution
    }

    /// What `end()` drops.
    pub fn clear(&mut self) {
        *self = Self::default();
    }

    /// `trackScheduledLoops(message, at)`, `observed_at` being `at` or now.
    ///
    /// Where the TS method would throw (a `null` content block, a tool_use
    /// whose `input` is `null` or missing), this skips the block; blocks
    /// without a string id are skipped too (TS keys them by the raw value).
    pub fn track(&mut self, message: &Value, observed_at: i64) -> Vec<LoopEffect> {
        let mut effects = Vec::new();
        let mtype = message.get("type").and_then(Value::as_str);
        if mtype == Some("result") {
            if !self.pending_tick_attribution.is_empty() {
                let usage = message.get("usage");
                let field = |k: &str| {
                    usage
                        .and_then(|u| u.get(k))
                        .and_then(Value::as_f64)
                        .unwrap_or(0.0)
                };
                let tokens = field("input_tokens")
                    + field("output_tokens")
                    + field("cache_creation_input_tokens")
                    + field("cache_read_input_tokens");
                for tool_use_id in std::mem::take(&mut self.pending_tick_attribution) {
                    effects.push(LoopEffect::AttachTokens {
                        tool_use_id,
                        tokens,
                    });
                }
            }
            return effects;
        }
        let Some(content) = message
            .get("message")
            .and_then(|m| m.get("content"))
            .and_then(Value::as_array)
        else {
            return effects;
        };
        match mtype {
            Some("assistant") => {
                for block in content {
                    if block.get("type").and_then(Value::as_str) != Some("tool_use") {
                        continue;
                    }
                    let Some(id) = block.get("id").and_then(Value::as_str) else {
                        continue;
                    };
                    let input = block.get("input");
                    let prop = |k: &str| input.and_then(|i| i.get(k));
                    let str_prop = |k: &str| prop(k).and_then(Value::as_str);
                    match block.get("name").and_then(Value::as_str) {
                        Some("CronCreate") => {
                            let cron = str_prop("cron").unwrap_or("");
                            if cron.is_empty() || self.pending.contains_key(id) {
                                continue;
                            }
                            self.pending.insert(
                                id.to_owned(),
                                SessionLoop {
                                    kind: LoopKind::Cron,
                                    id: id.to_owned(),
                                    tool_use_id: id.to_owned(),
                                    cron: Some(cron.to_owned()),
                                    human_schedule: None,
                                    delay_seconds: None,
                                    prompt: str_prop("prompt").unwrap_or("").to_owned(),
                                    reason: None,
                                    recurring: prop("recurring") == Some(&Value::Bool(true)),
                                    durable: false,
                                    started_at: observed_at,
                                    next_fire_at: None,
                                    noop: false,
                                    noop_streak: 0,
                                    cancelled: false,
                                },
                            );
                        }
                        Some("CronDelete") => {
                            if let Some(target) = str_prop("id").filter(|s| !s.is_empty())
                                && let Some(entry) = self.loops.get_mut(target)
                            {
                                entry.cancelled = true;
                            }
                        }
                        Some("ScheduleWakeup") => {
                            if is_schedule_wakeup_stop(input) {
                                // Once per stop, and only for wake-ups armed
                                // at or before it, so a replayed stop can't
                                // end a newer loop.
                                if !self.applied_wakeup_stops.insert(id.to_owned()) {
                                    continue;
                                }
                                for v in self.loops.values_mut() {
                                    if v.kind == LoopKind::Wakeup
                                        && !v.cancelled
                                        && v.started_at <= observed_at
                                    {
                                        v.cancelled = true;
                                    }
                                }
                                continue;
                            }
                            if self.loops.contains_key(id) {
                                continue;
                            }
                            let noop = prop("noop") == Some(&Value::Bool(true));
                            // A fresh wake-up supersedes the live ones,
                            // carrying the quiet streak across.
                            let mut streak = 0;
                            let superseded: Vec<String> = self
                                .loops
                                .iter()
                                .filter(|(_, v)| v.kind == LoopKind::Wakeup && !v.cancelled)
                                .map(|(k, v)| {
                                    if noop {
                                        streak = streak.max(v.noop_streak + 1);
                                    }
                                    k.clone()
                                })
                                .collect();
                            for k in superseded {
                                self.loops.shift_remove(&k);
                            }
                            if noop && streak == 0 {
                                streak = 1;
                            }
                            let prompt = str_prop("prompt").unwrap_or("").to_owned();
                            self.loops.insert(
                                id.to_owned(),
                                SessionLoop {
                                    kind: LoopKind::Wakeup,
                                    id: id.to_owned(),
                                    tool_use_id: id.to_owned(),
                                    cron: None,
                                    human_schedule: None,
                                    delay_seconds: prop("delaySeconds").and_then(Value::as_f64),
                                    prompt: prompt.clone(),
                                    reason: str_prop("reason").map(str::to_owned),
                                    recurring: false,
                                    durable: false,
                                    started_at: observed_at,
                                    next_fire_at: None,
                                    noop,
                                    noop_streak: if noop { streak } else { 0 },
                                    cancelled: false,
                                },
                            );
                            effects.push(LoopEffect::RecordTick {
                                tool_use_id: id.to_owned(),
                                prompt,
                                fired_at: observed_at,
                                noop,
                            });
                            self.pending_tick_attribution.push(id.to_owned());
                        }
                        _ => {}
                    }
                }
            }
            Some("user") => {
                let tool_use_result = message.get("tool_use_result");
                for block in content {
                    if block.get("type").and_then(Value::as_str) != Some("tool_result") {
                        continue;
                    }
                    let Some(tid) = block.get("tool_use_id").and_then(Value::as_str) else {
                        continue;
                    };
                    let is_error = block.get("is_error").is_some_and(js::truthy);
                    let Some(pending) = self.pending.shift_remove(tid) else {
                        continue;
                    };
                    if is_error {
                        continue; // the tool failed: drop it
                    }
                    let text = result_text(block.get("content"));
                    let caps = JOB_RE.captures(&text);
                    let cron_id = caps
                        .as_ref()
                        .map_or_else(|| pending.tool_use_id.clone(), |c| c[1].to_owned());
                    let human_schedule = caps.as_ref().map(|c| c[2].to_owned());
                    let durable = !says_session_only(&text);
                    let next_fire_at = read_cron_next_fire_at(tool_use_result);
                    self.loops.insert(
                        cron_id.clone(),
                        SessionLoop {
                            id: cron_id,
                            human_schedule,
                            durable,
                            next_fire_at: next_fire_at.or(pending.next_fire_at),
                            ..pending
                        },
                    );
                }
            }
            _ => {}
        }
        effects
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn the_job_regex_reads_like_v8() {
        let id = |t: &str| {
            JOB_RE
                .captures(t)
                .map(|c| (c[1].to_owned(), c[2].to_owned()))
        };
        assert_eq!(id("job abc (x)"), Some(("abc".into(), "x".into())));
        assert_eq!(
            id("JOB AbC1 (Every minute)"),
            Some(("AbC1".into(), "Every minute".into()))
        );
        assert_eq!(id("job\u{feff}a (b)"), Some(("a".into(), "b".into())));
        assert_eq!(id("job\u{85}a (b)"), None);
        assert_eq!(id("job \u{212a}x (k)"), None);
        assert_eq!(id("\u{17f}job a (b)"), Some(("a".into(), "b".into())));
        assert!(!says_session_only("\u{17f}ession-only"));
        assert!(says_session_only("SESSION ONLY"));
    }
}
