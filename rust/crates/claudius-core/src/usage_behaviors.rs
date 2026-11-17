//! The usage extras (S16): `extractUsageBehaviors`
//! (`lib/shared/usage-behaviors.ts`), `extractWeeklyUsedSkills`
//! (`lib/shared/skill-usage.ts`), and [`FullUsageMemo`], the session's
//! memoized `skipBehaviors: false` usage call (`Session.fetchFullUsage`).
//!
//! The usage response is the CLI's JSON, so every check here is a JS
//! property read on a parsed value: a field of anything but a plain object
//! is `undefined`. Numbers pass through as parsed; the routes print them
//! with [`claudius_agent::js::stringify`].

use std::future::Future;
use std::sync::{Arc, Mutex};

use futures::future::{BoxFuture, FutureExt, Shared};
use serde_json::{Value, json};
use tokio::sync::oneshot;

/// `USAGE_BEHAVIOR_COPY`'s keys, in its order: the behaviours with copy to
/// render. Any other key is dropped.
pub const USAGE_BEHAVIOR_KEYS: [&str; 9] = [
    "cache_miss",
    "long_context",
    "subagent_heavy",
    "high_parallel",
    "cron",
    "max_effort",
    "workflow",
    "always_on_context",
    "large_tool_results",
];

/// `Session.FULL_USAGE_TTL_MS`: how long a settled scan is shared.
pub const FULL_USAGE_TTL_MS: i64 = 30_000;

/// `typeof raw === "object"` and truthy: a JSON object or array.
fn object_like(v: &Value) -> bool {
    v.is_object() || v.is_array()
}

/// `num(v)`: a finite number as is, else 0. JSON numbers are always finite.
fn num(v: Option<&Value>) -> Value {
    match v {
        Some(n @ Value::Number(_)) => n.clone(),
        _ => json!(0),
    }
}

/// `extractRecommendations(raw)` (SDK 0.3.305 `behaviors.{day,week}
/// .recommendations`): the CLI's own wording for one recommended change.
/// An entry needs a string `key`, a string `title` that isn't blank once
/// trimmed and a finite number `pct`; `detail` rides along only when it is
/// a string that isn't blank once trimmed.
fn extract_recommendations(raw: Option<&Value>) -> Vec<Value> {
    let Some(Value::Array(list)) = raw else {
        return Vec::new();
    };
    let mut out = Vec::new();
    for r in list {
        // An array entry has no `key`, so it's dropped like a primitive.
        let Some(o) = r.as_object() else { continue };
        let Some(key) = o.get("key").and_then(Value::as_str) else {
            continue;
        };
        let Some(title) = o
            .get("title")
            .and_then(Value::as_str)
            .filter(|t| !claudius_agent::js::trim(t).is_empty())
        else {
            continue;
        };
        let Some(pct @ Value::Number(_)) = o.get("pct") else {
            continue;
        };
        let mut m = serde_json::Map::new();
        m.insert("key".into(), json!(key));
        m.insert("pct".into(), pct.clone());
        m.insert("title".into(), json!(title));
        if let Some(detail) = o
            .get("detail")
            .and_then(Value::as_str)
            .filter(|d| !claudius_agent::js::trim(d).is_empty())
        {
            m.insert("detail".into(), json!(detail));
        }
        out.push(Value::Object(m));
    }
    out
}

/// `extractWindow(raw)`: `{requestCount, sessionCount, behaviors,
/// recommendations}`, or `None` unless `raw` is an object or array (an
/// array has none of the fields, so it's an empty window).
fn extract_window(raw: Option<&Value>) -> Option<Value> {
    let w = raw.filter(|v| object_like(v))?;
    let mut behaviors = Vec::new();
    if let Some(Value::Array(list)) = w.get("behaviors") {
        for b in list {
            // An array entry has no `key`, so it's dropped like a primitive.
            let Some(o) = b.as_object() else { continue };
            let Some(key) = o
                .get("key")
                .and_then(Value::as_str)
                .filter(|k| USAGE_BEHAVIOR_KEYS.contains(k))
            else {
                continue;
            };
            let Some(pct @ Value::Number(_)) = o.get("pct") else {
                continue;
            };
            behaviors.push(json!({"key": key, "pct": pct, "count": num(o.get("count"))}));
        }
    }
    Some(json!({
        "requestCount": num(w.get("request_count")),
        "sessionCount": num(w.get("session_count")),
        "behaviors": behaviors,
        "recommendations": extract_recommendations(w.get("recommendations")),
    }))
}

/// `extractUsageBehaviors(usageData)`: `{day, week}`, or `None` when the
/// `behaviors` section is absent, `null` or malformed. (TS first checks
/// that it's an object; anything else has no `day` here either.)
pub fn extract_usage_behaviors(usage: &Value) -> Option<Value> {
    let raw = usage.get("behaviors")?;
    let day = extract_window(raw.get("day"))?;
    let week = extract_window(raw.get("week"))?;
    Some(json!({"day": day, "week": week}))
}

/// `extractWeeklyUsedSkills(usageData)`: the names in
/// `behaviors.week.skills` that are non-empty strings, unless their `pct`
/// is a number that isn't above 0. Order and duplicates kept; any other
/// shape gives `[]`.
pub fn extract_weekly_used_skills(usage: &Value) -> Vec<String> {
    let skills = usage
        .get("behaviors")
        .and_then(|b| b.get("week"))
        .and_then(|w| w.get("skills"));
    let Some(Value::Array(skills)) = skills else {
        return Vec::new();
    };
    skills
        .iter()
        .filter_map(|s| {
            let o = s.as_object()?;
            let name = o.get("name")?.as_str().filter(|n| !n.is_empty())?;
            match o.get("pct") {
                Some(Value::Number(pct)) if !pct.as_f64().is_some_and(|p| p > 0.0) => None,
                _ => Some(name.to_owned()),
            }
        })
        .collect()
}

/// The full `/context` body: `{ ...data, weeklyUsedSkills }`. The spread
/// copies an object's entries (an existing `weeklyUsedSkills` keeps its
/// place), an array's or a string's by index, and nothing from any other
/// value.
pub fn with_weekly_used_skills(data: &Value, weekly: Option<Vec<String>>) -> Value {
    let mut merged: serde_json::Map<String, Value> =
        claudius_agent::js::entries(data).into_iter().collect();
    merged.insert("weeklyUsedSkills".into(), json!(weekly));
    Value::Object(merged)
}

/// A usage scan any number of callers can await.
pub type Scan = Shared<BoxFuture<'static, Result<Value, String>>>;

struct Entry<K> {
    key: K,
    generation: u64,
    /// When the scan succeeded; `None` while it runs.
    at: Option<i64>,
    scan: Scan,
}

struct Slot<K> {
    entry: Option<Entry<K>>,
    generations: u64,
}

/// `fullUsageMemo` + `fetchFullUsage()`: one scan per query key, shared by
/// concurrent callers, and reused for [`FULL_USAGE_TTL_MS`] after it
/// succeeds. The window runs from when the scan settled, so a scan slower
/// than the window is still shared. A failure is never reused: the next
/// call starts a new scan. A different key (a new query) never reuses the
/// old answer.
///
/// The scan runs on its own task, like a JS promise that runs whether or
/// not anyone awaits it, so a caller that goes away (a closed HTTP request)
/// doesn't cancel it for the others.
pub struct FullUsageMemo<K> {
    slot: Arc<Mutex<Slot<K>>>,
    clock: fn() -> i64,
}

impl<K: PartialEq + Clone + Send + 'static> FullUsageMemo<K> {
    /// A memo reading `clock` (`Date.now()`; tests pass their own).
    pub fn new(clock: fn() -> i64) -> Self {
        Self {
            slot: Arc::new(Mutex::new(Slot {
                entry: None,
                generations: 0,
            })),
            clock,
        }
    }

    /// The memoized scan for `key`, or a new one from `fetch`. Must be
    /// called inside a tokio runtime.
    pub fn get<F>(&self, key: &K, fetch: impl FnOnce() -> F) -> Scan
    where
        F: Future<Output = Result<Value, String>> + Send + 'static,
    {
        let (tx, rx) = oneshot::channel();
        let (generation, scan) = {
            let mut slot = self.slot.lock().unwrap();
            let now = (self.clock)();
            if let Some(e) = &slot.entry
                && e.key == *key
                && e.at.is_none_or(|at| now - at < FULL_USAGE_TTL_MS)
            {
                return e.scan.clone();
            }
            slot.generations += 1;
            let generation = slot.generations;
            let scan = async move {
                rx.await
                    .unwrap_or_else(|_| Err("usage scan dropped".to_owned()))
            }
            .boxed()
            .shared();
            slot.entry = Some(Entry {
                key: key.clone(),
                generation,
                at: None,
                scan: scan.clone(),
            });
            (generation, scan)
        };
        let fut = fetch();
        let slot = Arc::clone(&self.slot);
        let clock = self.clock;
        tokio::spawn(async move {
            let result = fut.await;
            {
                // Settle before any caller sees the result, as the memo's
                // own `.then` runs before the callers' awaits resume.
                let mut slot = slot.lock().unwrap();
                if slot
                    .entry
                    .as_ref()
                    .is_some_and(|e| e.generation == generation)
                {
                    if result.is_ok() {
                        slot.entry.as_mut().unwrap().at = Some(clock());
                    } else {
                        slot.entry = None;
                    }
                }
            }
            let _ = tx.send(result);
        });
        scan
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::sync::atomic::{AtomicI64, AtomicUsize, Ordering};

    static NOW: AtomicI64 = AtomicI64::new(1_000_000);
    fn clock() -> i64 {
        NOW.load(Ordering::SeqCst)
    }
    fn advance(ms: i64) {
        NOW.fetch_add(ms, Ordering::SeqCst);
    }

    fn usage() -> Value {
        json!({"behaviors": {"day": {"behaviors": []}, "week": {"skills": [{"name": "pdf", "pct": 12}]}}})
    }

    /// A fetch that counts its calls and answers `reply()` at once.
    fn counted(
        calls: &Arc<AtomicUsize>,
        reply: Result<Value, String>,
    ) -> impl FnOnce() -> BoxFuture<'static, Result<Value, String>> {
        let calls = Arc::clone(calls);
        move || {
            calls.fetch_add(1, Ordering::SeqCst);
            async move { reply }.boxed()
        }
    }

    // The clock is shared by these tests, so they run as one.
    #[tokio::test]
    async fn the_memo_matches_fetch_full_usage() {
        // Concurrent callers and a later one share one scan.
        let memo = FullUsageMemo::new(clock);
        let calls = Arc::new(AtomicUsize::new(0));
        let a = memo.get(&1, counted(&calls, Ok(usage())));
        let b = memo.get(&1, counted(&calls, Ok(usage())));
        assert_eq!(a.await, Ok(usage()));
        assert_eq!(b.await, Ok(usage()));
        memo.get(&1, counted(&calls, Ok(usage()))).await.unwrap();
        assert_eq!(calls.load(Ordering::SeqCst), 1);

        // The window: still shared just inside it, a new scan at it.
        advance(FULL_USAGE_TTL_MS - 1);
        memo.get(&1, counted(&calls, Ok(usage()))).await.unwrap();
        assert_eq!(calls.load(Ordering::SeqCst), 1);
        advance(1);
        memo.get(&1, counted(&calls, Ok(usage()))).await.unwrap();
        assert_eq!(calls.load(Ordering::SeqCst), 2);

        // A new query never reuses the old answer, and replaces it.
        memo.get(&2, counted(&calls, Ok(json!(2)))).await.unwrap();
        assert_eq!(calls.load(Ordering::SeqCst), 3);
        memo.get(&1, counted(&calls, Ok(usage()))).await.unwrap();
        assert_eq!(calls.load(Ordering::SeqCst), 4);

        // A failure is shared by the callers waiting on it, never reused.
        let memo = FullUsageMemo::new(clock);
        let calls = Arc::new(AtomicUsize::new(0));
        let (release, wait) = oneshot::channel::<()>();
        let c = Arc::clone(&calls);
        let first = memo.get(&1, move || {
            c.fetch_add(1, Ordering::SeqCst);
            async move {
                wait.await.ok();
                Err("scan failed".to_owned())
            }
            .boxed()
        });
        let second = memo.get(&1, counted(&calls, Ok(usage())));
        release.send(()).unwrap();
        assert_eq!(first.await, Err("scan failed".to_owned()));
        assert_eq!(second.await, Err("scan failed".to_owned()));
        assert_eq!(
            memo.get(&1, counted(&calls, Ok(usage()))).await,
            Ok(usage())
        );
        assert_eq!(calls.load(Ordering::SeqCst), 2);

        // A scan slower than the window is still shared, and the window
        // runs from when it settled.
        let memo = FullUsageMemo::new(clock);
        let calls = Arc::new(AtomicUsize::new(0));
        let (release, wait) = oneshot::channel::<()>();
        let c = Arc::clone(&calls);
        let first = memo.get(&1, move || {
            c.fetch_add(1, Ordering::SeqCst);
            async move {
                wait.await.ok();
                Ok(usage())
            }
            .boxed()
        });
        advance(45_000);
        let second = memo.get(&1, counted(&calls, Ok(usage())));
        assert_eq!(calls.load(Ordering::SeqCst), 1);
        release.send(()).unwrap();
        assert!(first.await.is_ok() && second.await.is_ok());
        advance(20_000);
        memo.get(&1, counted(&calls, Ok(usage()))).await.unwrap();
        assert_eq!(calls.load(Ordering::SeqCst), 1);
        advance(11_000);
        memo.get(&1, counted(&calls, Ok(usage()))).await.unwrap();
        assert_eq!(calls.load(Ordering::SeqCst), 2);

        // A superseded scan's late result doesn't touch the new entry.
        let memo = FullUsageMemo::new(clock);
        let calls = Arc::new(AtomicUsize::new(0));
        let (release, wait) = oneshot::channel::<()>();
        let c = Arc::clone(&calls);
        let old = memo.get(&1, move || {
            c.fetch_add(1, Ordering::SeqCst);
            async move {
                wait.await.ok();
                Err("old".to_owned())
            }
            .boxed()
        });
        memo.get(&2, counted(&calls, Ok(json!(2)))).await.unwrap();
        release.send(()).unwrap();
        assert!(old.await.is_err());
        memo.get(&2, counted(&calls, Ok(json!(2)))).await.unwrap();
        assert_eq!(calls.load(Ordering::SeqCst), 2);

        // A caller that stops waiting doesn't cancel the scan.
        let memo = FullUsageMemo::new(clock);
        let calls = Arc::new(AtomicUsize::new(0));
        let (release, wait) = oneshot::channel::<()>();
        let c = Arc::clone(&calls);
        drop(memo.get(&1, move || {
            c.fetch_add(1, Ordering::SeqCst);
            async move {
                wait.await.ok();
                Ok(json!("kept"))
            }
            .boxed()
        }));
        release.send(()).unwrap();
        assert_eq!(
            memo.get(&1, counted(&calls, Ok(usage()))).await,
            Ok(json!("kept"))
        );
        assert_eq!(calls.load(Ordering::SeqCst), 1);
    }
}
