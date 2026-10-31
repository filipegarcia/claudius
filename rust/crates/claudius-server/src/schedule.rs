//! `/api/schedule/**` (G07b): ports of `app/api/schedule/route.ts` (GET,
//! POST), `[id]/route.ts` (GET, PATCH, DELETE), `[id]/run-now/route.ts`
//! (POST) and `[id]/runs/route.ts` (GET), over the process-wide
//! [`claudius_core::scheduler`] and its store.
//!
//! **One scheduler.** Next boots its own scheduler on the same `jobs.json`
//! whenever it starts (`instrumentation.ts`), and these routes are where a
//! job is armed, re-armed, disarmed and run: they have to reach the
//! scheduler that is running. So Rust answers them only when it runs the
//! scheduler itself (`--scheduler` / `CLAUDIUS_SCHEDULER=1`:
//! [`scheduler::enabled`]); otherwise each request goes to Next unchanged
//! (or, without a Next, gets the proxy's 404 as before). Answered here while
//! Next's scheduler runs, a create would save a job no timer fires, an edit
//! would leave Next's timer on the old cron (and an enabled-again job with
//! none), a run-now would run beside Next's run of the same job instead of
//! being `skipped`, its live stream (still Next's, G07c) would find no run,
//! and every run would read `attached: false`.
//! `/api/schedule/session-loops` (G07c) goes to Next too: `{id}` would take
//! it.
//!
//! * `GET /api/schedule`: `{jobs}` as stored (a store that doesn't read is
//!   Next's empty 500).
//! * `POST /api/schedule {name, cron, prompt, model?, cwd?, enabled?}`: in
//!   this order, a blank or nullish `name` is 400 `name required`, a falsy
//!   `cron` `cron required`, a blank or nullish `prompt` `prompt required`
//!   (a `name` or `prompt` that isn't a string, or a truthy `cron` that isn't
//!   one, throws), then `validateCron`'s error, then `unknown cwd` unless the
//!   cwd is a registered one (no string: the first trusted root). The job
//!   (`id`, the trimmed `name`, the trimmed `cron`, the raw `prompt`, a
//!   truthy `model` as given, `cwd`, `enabled` unless it's `false`,
//!   `createdAt` and `updatedAt`) is saved and, when enabled, armed; the 201
//!   body is the job as built, without the `nextRunAt` arming wrote.
//! * `GET /api/schedule/:id`: the job, or 404 `not found`.
//! * `PATCH /api/schedule/:id`: `updatedAt`, then each known field of the
//!   right type (a `cron` validated, `model: null` or `""` dropping it, a
//!   `cwd` resolved like POST's), merged into the job as stored; 404 when
//!   there's no such job (after the 400s). The result is armed if enabled
//!   (truthy), else disarmed.
//! * `DELETE /api/schedule/:id`: disarm, then delete the job and its run
//!   files: `{ok: true}`, or 404.
//! * `POST /api/schedule/:id/run-now`: run the job now (enabled or not, no
//!   re-arm) and answer 202 `{runId}` once the run has ended, or 404. The
//!   run is its own task, so a client that leaves doesn't cut it short (TS's
//!   promise runs on).
//! * `GET /api/schedule/:id/runs?limit=`: the newest `Number(limit || "50")
//!   || 50` runs (`slice(-limit)`), each `running` one with `attached` (a
//!   client has its live stream open); a `null` run line in the window
//!   throws.
//!
//! Each route boots the scheduler first, as the TS ones do; `main` already
//! has, so it's a no-op. Bodies are bare `await req.json()`s read as
//! `JSON.parse` reads them: a number literal past f64 is Infinity, a
//! truthy non-string for the checks and `null` where it is stored (as
//! `JSON.stringify` writes it).

use std::future::Future;
use std::pin::Pin;
use std::sync::Arc;

use axum::Router;
use axum::body::Bytes;
use axum::extract::{Path, RawQuery, Request, State};
use axum::handler::Handler;
use axum::http::{StatusCode, header};
use axum::response::{IntoResponse, Response};
use axum::routing::{any, get, post};
use claudius_agent::js;
use claudius_core::scheduler::{self, Scheduler};
use claudius_core::scheduler_store::{JobPatch, JsValue, StoreError};
use claudius_core::{cron, js_num, log, now_ms, trusted_cwd};
use serde_json::{Map, Value, json};

use crate::AppState;
use crate::body::{JsonBody, thrown};
use crate::session_transcript::search_param;

pub fn router() -> Router<AppState> {
    Router::new()
        .route("/api/schedule", get(owned(list)).post(owned(create)))
        // G07c, still Next's: `{id}` below would take it.
        .route("/api/schedule/session-loops", any(crate::proxy::handler))
        .route(
            "/api/schedule/{id}",
            get(owned(job_get))
                .patch(owned(job_patch))
                .delete(owned(job_delete)),
        )
        .route("/api/schedule/{id}/run-now", post(owned(run_now)))
        .route("/api/schedule/{id}/runs", get(owned(runs)))
}

type Answer = Pin<Box<dyn Future<Output = Response> + Send>>;

/// `h` when this process runs the scheduler; otherwise the request goes to
/// Next unchanged (see the module doc).
fn owned<H, T>(h: H) -> impl Fn(State<AppState>, Request) -> Answer + Clone + Send + Sync + 'static
where
    H: Handler<T, AppState>,
    T: 'static,
{
    move |State(app): State<AppState>, req: Request| -> Answer {
        let h = h.clone();
        Box::pin(async move {
            if !scheduler::enabled() {
                return crate::proxy::handler(State(app), req).await;
            }
            h.call(req, app).await
        })
    }
}

/// `NextResponse.json(body, {status})`.
fn json_text(status: StatusCode, body: &Value) -> Response {
    (
        status,
        [(header::CONTENT_TYPE, "application/json")],
        js::stringify(body),
    )
        .into_response()
}

fn error(status: StatusCode, msg: &str) -> Response {
    json_text(status, &json!({"error": msg}))
}

fn not_found() -> Response {
    error(StatusCode::NOT_FOUND, "not found")
}

/// Where the TS handler throws: Next's empty 500, with what it threw logged.
fn threw(route: &str, what: &dyn std::fmt::Display) -> Response {
    tracing::error!(target: log::API, "[api/{route}] {what}");
    thrown()
}

/// A store call that threw.
fn failed(route: &str, e: &StoreError) -> Response {
    threw(route, e)
}

/// `await scheduler.boot()`: `None` where it threw (logged; the empty 500).
fn boot(route: &str) -> Option<&'static Arc<Scheduler>> {
    let sched = scheduler::scheduler();
    match sched.boot() {
        Ok(()) => Some(sched),
        Err(e) => {
            failed(route, &e);
            None
        }
    }
}

/// Stands in for Infinity (a number literal past f64) where only its type
/// or truthiness is read: a truthy number.
const INFINITE: f64 = f64::MAX;

/// `await req.json()`, uncaught: `None` is the empty 500 (V8's `SyntaxError`
/// logged, as Next logs it). The first value is the body as `JSON.parse`
/// gives it with Infinity as `null` (what `JSON.stringify` writes for it);
/// the second has each Infinity as [`INFINITE`], for the type and truthiness
/// checks.
fn read_body(route: &str, bytes: &[u8]) -> Option<(Value, Value)> {
    let parsed = match JsonBody::parse_or_message(bytes) {
        Ok(v) => v,
        Err(msg) => {
            threw(route, &format!("SyntaxError: {msg}"));
            return None;
        }
    };
    // Over the text `Body.json()` parses (both BOMs gone).
    let text = JsonBody::text(bytes);
    let checked = JsonBody::lenient_overflow(text.as_bytes(), parsed.clone(), &json!(INFINITE));
    Some((parsed, checked))
}

/// `body?.key?.trim()`: `Ok(None)` for nullish (or no object), the trimmed
/// text for a string, `Err` where `.trim` isn't a function (it throws).
fn trimmed<'a>(body: &'a Value, key: &str) -> Result<Option<&'a str>, ()> {
    match &body[key] {
        Value::Null => Ok(None),
        Value::String(s) => Ok(Some(js::trim(s))),
        _ => Err(()),
    }
}

fn key(id: String) -> JsValue {
    Some(Value::String(id))
}

/// `GET /api/schedule`.
async fn list() -> Response {
    const ROUTE: &str = "schedule";
    let Some(sched) = boot(ROUTE) else {
        return thrown();
    };
    match sched.store().list_jobs() {
        Ok(jobs) => json_text(StatusCode::OK, &json!({ "jobs": jobs })),
        Err(e) => failed(ROUTE, &e),
    }
}

/// `POST /api/schedule`.
async fn create(body: Bytes) -> Response {
    const ROUTE: &str = "schedule";
    let Some(sched) = boot(ROUTE) else {
        return thrown();
    };
    let Some((b, checked)) = read_body(ROUTE, &body) else {
        return thrown();
    };
    let name = match trimmed(&checked, "name") {
        Ok(Some(n)) if !n.is_empty() => n.to_owned(),
        Ok(_) => return error(StatusCode::BAD_REQUEST, "name required"),
        Err(()) => return threw(ROUTE, &"TypeError: body?.name?.trim is not a function"),
    };
    if !js::truthy(&checked["cron"]) {
        return error(StatusCode::BAD_REQUEST, "cron required");
    }
    match trimmed(&checked, "prompt") {
        Ok(Some(p)) if !p.is_empty() => {}
        Ok(_) => return error(StatusCode::BAD_REQUEST, "prompt required"),
        Err(()) => return threw(ROUTE, &"TypeError: body?.prompt?.trim is not a function"),
    }
    // `validateCron(input)` starts with `input.trim()`.
    let Value::String(cron_in) = &checked["cron"] else {
        return threw(ROUTE, &"TypeError: input.trim is not a function");
    };
    let cron = match cron::validate_cron(cron_in) {
        Ok(c) => c,
        Err(e) => return error(StatusCode::BAD_REQUEST, &e),
    };
    // The agent spawns here: only a registered directory.
    let Some(cwd) = trusted_cwd::resolve_trusted_cwd(b["cwd"].as_str()) else {
        return error(StatusCode::BAD_REQUEST, "unknown cwd");
    };
    let now = js_num(now_ms() as f64);
    let enabled = checked["enabled"] != Value::Bool(false);
    let mut job = Map::new();
    job.insert("id".into(), json!(uuid::Uuid::new_v4().to_string()));
    job.insert("name".into(), json!(name));
    job.insert("cron".into(), json!(cron));
    job.insert("prompt".into(), b["prompt"].clone());
    // `body.model || undefined`: any truthy value, as given.
    if js::truthy(&checked["model"]) {
        job.insert("model".into(), b["model"].clone());
    }
    job.insert("cwd".into(), json!(cwd));
    job.insert("enabled".into(), json!(enabled));
    job.insert("createdAt".into(), now.clone());
    job.insert("updatedAt".into(), now);
    let job = Value::Object(job);
    if let Err(e) = sched.store().save_job(job.clone()) {
        return failed(ROUTE, &e);
    }
    if enabled && let Err(e) = sched.arm(&job) {
        return failed(ROUTE, &e);
    }
    json_text(StatusCode::CREATED, &job)
}

/// `GET /api/schedule/:id`.
async fn job_get(Path(id): Path<String>) -> Response {
    const ROUTE: &str = "schedule/[id]";
    let Some(sched) = boot(ROUTE) else {
        return thrown();
    };
    match sched.store().get_job(&key(id)) {
        Ok(Some(job)) => json_text(StatusCode::OK, &job),
        Ok(None) => not_found(),
        Err(e) => failed(ROUTE, &e),
    }
}

/// `PATCH /api/schedule/:id`.
async fn job_patch(Path(id): Path<String>, body: Bytes) -> Response {
    const ROUTE: &str = "schedule/[id]";
    let Some(sched) = boot(ROUTE) else {
        return thrown();
    };
    // Only types are read, so Infinity is its stand-in throughout.
    let Some((_, b)) = read_body(ROUTE, &body) else {
        return thrown();
    };
    // `body.cron` (no `?.`): a `null` body throws.
    if b.is_null() {
        return threw(
            ROUTE,
            &"TypeError: Cannot read properties of null (reading 'cron')",
        );
    }
    // Known fields only, merged into the job as stored at write time.
    let mut patch: JobPatch = vec![("updatedAt".into(), Some(js_num(now_ms() as f64)))];
    if let Value::String(c) = &b["cron"] {
        match cron::validate_cron(c) {
            Ok(c) => patch.push(("cron".into(), Some(json!(c)))),
            Err(e) => return error(StatusCode::BAD_REQUEST, &e),
        }
    }
    for field in ["name", "prompt"] {
        if let Value::String(s) = &b[field] {
            patch.push((field.into(), Some(json!(s))));
        }
    }
    if let Value::Bool(on) = &b["enabled"] {
        patch.push(("enabled".into(), Some(json!(on))));
    }
    // `body.model === null` (present and `null`), else a string, `""` as
    // `undefined`.
    match b.get("model") {
        Some(Value::Null) => patch.push(("model".into(), None)),
        Some(Value::String(m)) => patch.push(("model".into(), (!m.is_empty()).then(|| json!(m)))),
        _ => {}
    }
    if let Value::String(c) = &b["cwd"] {
        // Same rule as POST: the agent spawns here.
        let Some(cwd) = trusted_cwd::resolve_trusted_cwd(Some(c)) else {
            return error(StatusCode::BAD_REQUEST, "unknown cwd");
        };
        patch.push(("cwd".into(), Some(json!(cwd))));
    }
    let id = key(id);
    let next = match sched.store().patch_job(&id, &patch) {
        Ok(Some(next)) => next,
        Ok(None) => return not_found(),
        Err(e) => return failed(ROUTE, &e),
    };
    if js::truthy(&next["enabled"]) {
        if let Err(e) = sched.arm(&next) {
            return failed(ROUTE, &e);
        }
    } else {
        sched.disarm(&id);
    }
    json_text(StatusCode::OK, &next)
}

/// `DELETE /api/schedule/:id`.
async fn job_delete(Path(id): Path<String>) -> Response {
    const ROUTE: &str = "schedule/[id]";
    let Some(sched) = boot(ROUTE) else {
        return thrown();
    };
    let id = key(id);
    sched.disarm(&id);
    match sched.store().delete_job(&id) {
        Ok(true) => json_text(StatusCode::OK, &json!({"ok": true})),
        Ok(false) => not_found(),
        Err(e) => failed(ROUTE, &e),
    }
}

/// `POST /api/schedule/:id/run-now`.
async fn run_now(Path(id): Path<String>) -> Response {
    const ROUTE: &str = "schedule/[id]/run-now";
    let Some(sched) = boot(ROUTE).cloned() else {
        return thrown();
    };
    // Its own task: a dropped request mustn't leave the job in flight.
    let run = tokio::spawn(async move { sched.run_now(&key(id)).await });
    match run.await {
        Ok(Ok(Some(run_id))) => json_text(StatusCode::ACCEPTED, &json!({ "runId": run_id })),
        Ok(Ok(None)) => not_found(),
        Ok(Err(e)) => failed(ROUTE, &e),
        Err(e) => threw(ROUTE, &e),
    }
}

/// `Number(url.searchParams.get("limit") || "50") || 50` (`""` is
/// `Number("") || 50`, the same 50).
fn run_limit(raw: Option<&str>) -> f64 {
    let n = js::to_number(raw.unwrap_or("50"));
    if n == 0.0 || n.is_nan() { 50.0 } else { n }
}

/// `r.status === "running" ? { ...r, attached: isRunAttached(r.id) } : r`
/// (`r` not `null`). A run's own `attached` keeps its place.
fn with_attached(run: Value, attached: impl Fn(&str) -> bool) -> Value {
    match run {
        Value::Object(mut r) if r.get("status").and_then(Value::as_str) == Some("running") => {
            // `liveRuns.get(r.id)`: only a string is a run's id.
            let on = r.get("id").and_then(Value::as_str).is_some_and(attached);
            r.insert("attached".into(), Value::Bool(on));
            Value::Object(r)
        }
        run => run,
    }
}

/// `GET /api/schedule/:id/runs`.
async fn runs(Path(id): Path<String>, RawQuery(query): RawQuery) -> Response {
    const ROUTE: &str = "schedule/[id]/runs";
    let Some(sched) = boot(ROUTE) else {
        return thrown();
    };
    let limit = run_limit(search_param(query.as_deref(), "limit").as_deref());
    let runs = match sched.store().list_runs(&key(id), limit) {
        Ok(r) => r,
        Err(e) => return failed(ROUTE, &e),
    };
    let mut out = Vec::with_capacity(runs.len());
    for run in runs {
        if run.is_null() {
            return threw(
                ROUTE,
                &"TypeError: Cannot read properties of null (reading 'status')",
            );
        }
        out.push(with_attached(run, |id| sched.is_run_attached(id)));
    }
    json_text(StatusCode::OK, &json!({ "runs": out }))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn the_limit_is_numbers_or_50() {
        for (raw, want) in [
            (None, 50.0),
            (Some(""), 50.0),
            (Some("0"), 50.0),
            (Some("-0"), 50.0),
            (Some("  "), 50.0),
            (Some("abc"), 50.0),
            (Some("2"), 2.0),
            (Some(" 2 "), 2.0),
            (Some("-3"), -3.0),
            (Some("2.5"), 2.5),
            (Some("0x10"), 16.0),
            (Some("Infinity"), f64::INFINITY),
            (Some("-Infinity"), f64::NEG_INFINITY),
        ] {
            assert_eq!(run_limit(raw), want, "{raw:?}");
        }
    }

    #[test]
    fn only_running_runs_get_attached() {
        let live = |id: &str| id == "live";
        assert_eq!(
            with_attached(json!({"id": "live", "status": "running"}), live),
            json!({"id": "live", "status": "running", "attached": true})
        );
        assert_eq!(
            js::stringify(&with_attached(
                json!({"attached": 1, "id": "x", "status": "running"}),
                live
            )),
            r#"{"attached":false,"id":"x","status":"running"}"#
        );
        assert_eq!(
            with_attached(json!({"id": 5, "status": "running"}), |_| true),
            json!({"id": 5, "status": "running", "attached": false})
        );
        for other in [
            json!({"id": "live", "status": "RUNNING"}),
            json!({"id": "live"}),
            json!(5),
            json!("running"),
            json!(["running"]),
        ] {
            assert_eq!(with_attached(other.clone(), live), other);
        }
    }

    #[test]
    fn trim_reads_like_optional_chaining() {
        let b = json!({"s": "  x\u{a0}", "n": null, "five": 5, "o": {}});
        assert_eq!(trimmed(&b, "s"), Ok(Some("x")));
        assert_eq!(trimmed(&b, "n"), Ok(None));
        assert_eq!(trimmed(&b, "missing"), Ok(None));
        assert_eq!(trimmed(&b, "five"), Err(()));
        assert_eq!(trimmed(&b, "o"), Err(()));
        for body in [json!(null), json!("str"), json!([1]), json!(7)] {
            assert_eq!(trimmed(&body, "s"), Ok(None), "{body}");
        }
    }
}
