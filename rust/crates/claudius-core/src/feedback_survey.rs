//! The CLI-style feedback nudge (S26): `lib/server/feedback-survey.ts` and
//! the decision half of session.ts `maybeOfferFeedbackSurvey`.
//!
//! The CLI shows its session-quality survey "when eligible", with the
//! `feedbackSurveyRate` probability, but only in its TUI: it never reaches
//! the SDK as an event. So Claudius rolls its own after each turn. A turn
//! that ended in an error never offers it, nor does a session nobody typed
//! into in this process, and the whole process offers it at most once per
//! [`SURVEY_MIN_INTERVAL_MS`].
//!
//! In TS the throttle is module state, one per process. Here it's a
//! [`FeedbackSurvey`] that also owns the clock and the roll, with
//! [`FeedbackSurvey::global`] shared by every session, so tests can pin
//! both. The roll is a `Math.random()` stand-in: the nudge is cosmetic.

use std::sync::{Arc, LazyLock, Mutex};

use serde_json::{Value, json};

use crate::settings::{self, Scope};

/// `DEFAULT_FEEDBACK_SURVEY_RATE`: the SDK's suggested starting
/// probability, used when the setting is absent or not a finite number.
pub const DEFAULT_FEEDBACK_SURVEY_RATE: f64 = 0.05;

/// `SURVEY_MIN_INTERVAL_MS`: the minimum gap between nudges across the
/// whole process (6 h).
pub const SURVEY_MIN_INTERVAL_MS: i64 = 6 * 60 * 60 * 1000;

/// The `surface` the nudge carries, and `submitFeedback`'s default one.
pub const FEEDBACK_SURFACE: &str = "claudius";

/// `coerceSurveyRate(raw)`: a finite number clamped into [0, 1], anything
/// else the default. `None` is `undefined`. A JSON number is always finite
/// here: `js::json_parse` reads the `1e400` that JS takes for `Infinity` as
/// `null`, which gets the default as `Infinity` does.
pub fn coerce_survey_rate(raw: Option<&Value>) -> f64 {
    let Some(rate) = raw.and_then(Value::as_f64) else {
        return DEFAULT_FEEDBACK_SURVEY_RATE;
    };
    if rate < 0.0 {
        return 0.0;
    }
    if rate > 1.0 {
        return 1.0;
    }
    rate
}

/// `SurveyDecisionInput`. Times are `Date.now()` milliseconds.
#[derive(Clone, Copy, Debug, Default, PartialEq)]
pub struct SurveyDecisionInput {
    /// The probability, normally in [0, 1].
    pub rate: f64,
    /// The turn that just finished ended in an error.
    pub is_error: bool,
    /// A real user prompt was seen in this process.
    pub saw_user_input: bool,
    pub now: i64,
    pub last_shown_at: i64,
    /// `None`: [`SURVEY_MIN_INTERVAL_MS`].
    pub min_interval_ms: Option<i64>,
    /// A pinned roll; `None` draws `math_random`.
    pub random: Option<f64>,
}

/// `shouldOfferSurvey(opts)`. `math_random` is the `Math.random()` behind an
/// absent `random`, drawn only once every other gate has passed.
pub fn should_offer_survey(opts: &SurveyDecisionInput, math_random: impl FnOnce() -> f64) -> bool {
    let min_interval_ms = opts.min_interval_ms.unwrap_or(SURVEY_MIN_INTERVAL_MS);
    if opts.is_error || !opts.saw_user_input {
        return false;
    }
    if opts.rate <= 0.0 {
        return false;
    }
    if throttled(opts.now, opts.last_shown_at, min_interval_ms) {
        return false;
    }
    let roll = opts.random.unwrap_or_else(math_random);
    roll < opts.rate
}

/// `now - lastShownAt < minIntervalMs`, in JS number arithmetic.
fn throttled(now: i64, last_shown_at: i64, min_interval_ms: i64) -> bool {
    (now as f64 - last_shown_at as f64) < min_interval_ms as f64
}

/// The `feedback_survey` event (`FeedbackSurveyEvent`).
pub fn feedback_survey_event(session_id: &str) -> Value {
    json!({"type": "feedback_survey", "sessionId": session_id, "surface": FEEDBACK_SURFACE})
}

type Clock = Box<dyn Fn() -> i64 + Send + Sync>;
type Roll = Box<dyn Fn() -> f64 + Send + Sync>;

/// feedback-survey.ts's module state (`lastShownAt` behind
/// `getLastSurveyShownAt` / `noteSurveyShown` / `resetSurveyThrottle`), plus
/// the `Date.now` and `Math.random` that `maybeOfferFeedbackSurvey` reads.
pub struct FeedbackSurvey {
    last_shown_at: Mutex<i64>,
    clock: Clock,
    random: Roll,
}

impl FeedbackSurvey {
    /// A throttle that has never shown the nudge, on `clock` and `random`.
    pub fn new(
        clock: impl Fn() -> i64 + Send + Sync + 'static,
        random: impl Fn() -> f64 + Send + Sync + 'static,
    ) -> FeedbackSurvey {
        FeedbackSurvey {
            last_shown_at: Mutex::new(0),
            clock: Box::new(clock),
            random: Box::new(random),
        }
    }

    /// The process-wide throttle every session shares by default: the wall
    /// clock and a `Math.random()` stand-in.
    pub fn global() -> Arc<FeedbackSurvey> {
        static GLOBAL: LazyLock<Arc<FeedbackSurvey>> = LazyLock::new(|| {
            Arc::new(FeedbackSurvey::new(crate::now_ms, crate::cron::math_random))
        });
        GLOBAL.clone()
    }

    /// `getLastSurveyShownAt()`.
    pub fn last_shown_at(&self) -> i64 {
        *self.last_shown_at.lock().unwrap()
    }

    /// `noteSurveyShown(now)`.
    pub fn note_shown(&self, now: i64) {
        *self.last_shown_at.lock().unwrap() = now;
    }

    /// `resetSurveyThrottle()`.
    pub fn reset(&self) {
        self.note_shown(0);
    }

    /// The decision in `maybeOfferFeedbackSurvey(message)` after a `result`,
    /// for a session that has (`saw_user_input`) or hasn't seen a real
    /// prompt. `true` means the nudge is due and the throttle is already
    /// stamped; the session then broadcasts [`feedback_survey_event`].
    ///
    /// Like TS, the cheap gates run first (an `is_error: true` result, no
    /// prompt, the throttle), so the user settings are only read when the
    /// nudge could fire. Then the rate, the throttle again (another session
    /// may have shown it meanwhile; here the check and the stamp are one
    /// step) and the roll.
    pub fn maybe_offer(&self, message: &Value, saw_user_input: bool, cwd: &str) -> bool {
        let is_error = message.get("is_error") == Some(&Value::Bool(true));
        if is_error || !saw_user_input {
            return false;
        }
        let now = (self.clock)();
        if throttled(now, self.last_shown_at(), SURVEY_MIN_INTERVAL_MS) {
            return false;
        }
        let Some(raw) = user_settings_rate(cwd) else {
            return false;
        };
        let rate = coerce_survey_rate(raw.as_ref());
        let mut last = self.last_shown_at.lock().unwrap();
        let input = SurveyDecisionInput {
            rate,
            is_error,
            saw_user_input,
            now,
            last_shown_at: *last,
            min_interval_ms: None,
            random: None,
        };
        let offer = should_offer_survey(&input, || (self.random)());
        if offer {
            *last = now;
        }
        offer
    }
}

/// `(await readSettings("user", cwd).catch(() => ({}))).feedbackSurveyRate`:
/// a read or parse failure is `{}`. `Some(None)` is `undefined`. `None` is
/// a file holding `null`, where the property read throws and the catch-all
/// drops the nudge.
fn user_settings_rate(cwd: &str) -> Option<Option<Value>> {
    settings::read_settings_js(Scope::User, cwd)
        .unwrap_or_else(|_| Some(serde_json::Map::new()))
        .map(|mut m| m.remove("feedbackSurveyRate"))
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::sync::atomic::{AtomicUsize, Ordering};

    fn decide(rate: f64, now: i64, last: i64) -> SurveyDecisionInput {
        SurveyDecisionInput {
            rate,
            saw_user_input: true,
            now,
            last_shown_at: last,
            ..Default::default()
        }
    }

    #[test]
    fn the_roll_is_drawn_only_past_every_gate() {
        let draws = AtomicUsize::new(0);
        let roll = |v: f64| {
            let d = &draws;
            move || {
                d.fetch_add(1, Ordering::SeqCst);
                v
            }
        };
        let day = 86_400_000;
        assert!(!should_offer_survey(&decide(0.0, day, 0), roll(0.0)));
        assert!(!should_offer_survey(&decide(1.0, day, day - 1), roll(0.0)));
        let mut err = decide(1.0, day, 0);
        err.is_error = true;
        assert!(!should_offer_survey(&err, roll(0.0)));
        let mut quiet = decide(1.0, day, 0);
        quiet.saw_user_input = false;
        assert!(!should_offer_survey(&quiet, roll(0.0)));
        let mut pinned = decide(0.5, day, 0);
        pinned.random = Some(0.4);
        assert!(should_offer_survey(&pinned, roll(0.9)));
        assert_eq!(draws.load(Ordering::SeqCst), 0);
        assert!(should_offer_survey(&decide(0.5, day, 0), roll(0.4)));
        assert!(!should_offer_survey(&decide(0.5, day, 0), roll(0.5)));
        assert_eq!(draws.load(Ordering::SeqCst), 2);
    }

    #[test]
    fn the_interval_edge_and_a_clock_near_the_epoch() {
        let six_h = SURVEY_MIN_INTERVAL_MS;
        assert!(should_offer_survey(&decide(1.0, six_h, 0), || 0.0));
        assert!(!should_offer_survey(&decide(1.0, six_h - 1, 0), || 0.0));
        let mut custom = decide(1.0, 10, 5);
        custom.min_interval_ms = Some(5);
        assert!(should_offer_survey(&custom, || 0.0));
        custom.min_interval_ms = Some(6);
        assert!(!should_offer_survey(&custom, || 0.0));
        // Extreme times don't overflow: JS subtracts doubles.
        assert!(should_offer_survey(
            &decide(1.0, i64::MAX, i64::MIN),
            || 0.0
        ));
        assert!(!should_offer_survey(
            &decide(1.0, i64::MIN, i64::MAX),
            || 0.0
        ));
    }

    #[test]
    fn rates_coerce_like_the_ts() {
        assert_eq!(coerce_survey_rate(None), DEFAULT_FEEDBACK_SURVEY_RATE);
        assert_eq!(coerce_survey_rate(Some(&json!("0.5"))), 0.05);
        assert_eq!(coerce_survey_rate(Some(&json!(null))), 0.05);
        assert_eq!(coerce_survey_rate(Some(&json!(-3))), 0.0);
        assert_eq!(coerce_survey_rate(Some(&json!(7))), 1.0);
        assert_eq!(coerce_survey_rate(Some(&json!(0.25))), 0.25);
        assert_eq!(coerce_survey_rate(Some(&json!(1))), 1.0);
        assert_eq!(coerce_survey_rate(Some(&json!(0))), 0.0);
    }

    #[test]
    fn the_global_throttle_is_shared() {
        assert!(Arc::ptr_eq(
            &FeedbackSurvey::global(),
            &FeedbackSurvey::global()
        ));
        let global = FeedbackSurvey::global();
        let rolls: Vec<f64> = (0..16).map(|_| (global.random)()).collect();
        assert!(rolls.iter().all(|r| (0.0..1.0).contains(r)), "{rolls:?}");
        assert!(rolls.iter().any(|r| *r != rolls[0]), "{rolls:?}");
        assert!(((global.clock)() - crate::now_ms()).abs() < 60_000);
        let s = FeedbackSurvey::new(|| 42, || 0.0);
        assert_eq!(s.last_shown_at(), 0);
        s.note_shown(7);
        assert_eq!(s.last_shown_at(), 7);
        s.reset();
        assert_eq!(s.last_shown_at(), 0);
    }
}
