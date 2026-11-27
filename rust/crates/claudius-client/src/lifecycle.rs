//! Mount, boot, switch and create (U01k): how a chat pane gets a session.
//!
//! - **Mount** ([`ChatState::mount`]): the hook's mount effects, in their
//!   order: the 30 s poll, then the boot. The boot reads `?new=1`,
//!   `?session=`, `?at=` and `?prompt=` off the page URL; `?new=1` strips the
//!   session params (`replaceState`). Without a `?session=` it asks
//!   `/api/sessions/open-tabs` for the last active tab. A session to resume
//!   goes through the crash-loop guard (`boot_guard`): a session whose last
//!   boot never rendered is skipped (the "didn't open last time" notice,
//!   [`SkippedBoot`]), else this boot is marked. Then `createSession` resumes
//!   it, or creates a fresh one in the default cwd. Once that resolves, a
//!   skipped boot is pinned to the fresh session, and a `?prompt=` seed is
//!   stripped from the URL and POSTed to `/input` once the turn is idle.
//! - **createSession**: supersede any switch in flight (`switchGen`), close
//!   the stream, unbind, `resetState`, show "Catching up…" for a resume,
//!   and `POST /api/sessions`; on success bind the id, take the reply's
//!   `cwd` and refresh the session list. A failure (connection lost, an
//!   HTTP error with the route's `{ error, name }`, a reply that isn't
//!   JSON) goes to `errors` and `createError`. `createNewSession` (the
//!   promise's id), `createSessionAt` and `createNewSessionWithDraft` call it.
//! - **switchSession**: the same cut, then `POST /api/sessions { resume }`
//!   (its outcome ignored), bind and refresh, unless a newer transition
//!   started meanwhile.
//! - **Commit effects**: what the hook's `useEffect`s do after a render
//!   that changed their inputs. A new bound session seeds the suggested /
//!   goal badge sets (`/suggested-messages`, `/goal-messages`, dropped if
//!   the session changes before they land); on a chat route (`/`,
//!   `/wks_<hex>`, `/customize/cust_<hex>/chat`) the URL writer reflects it
//!   as `?session=<id>` (dropping `?at=`) after 500 ms, unless a navigation
//!   started meanwhile ([`ChatState::navigation_intent`]) or the page left
//!   the chat route; a replayed session clears its boot marker
//!   (`clearBootAttemptFor`); and the skipped-boot notice is dropped for
//!   good once another session is bound. Every input ends with the
//!   commit's check.
//! - `openSkippedBootSession` ("Open anyway": the force flag, then a page
//!   load at `?session=<skipped>`), `dismissSkippedBootSession`, the
//!   `refreshSessions` action, and the unmount cleanup.
//!
//! Not ported: the legacy `sessionStorage` queue migration
//! (`migrateLegacySessionStorageQueue`, `claudius.queue.<id>`): it drains
//! what the pre-server-queue web client stashed, which a native client
//! never wrote.

use serde_json::{Map, Value, json};

use crate::apply::Cx;
use crate::boot_guard::{
    BOOT_FORCE_KEY, SkippedBoot, clear_boot_attempt_for, consume_forced_resume, mark_boot_attempt,
    scope_skipped_boot, should_skip_resume,
};
use crate::effect::{Action, Effect, FetchOutcome};
use crate::effort_wait::NO_EFFORT_WAIT;
use crate::env::with_storage;
use crate::state::{AfterRefresh, ChatState, SessionRecap, Then, TimerFn};
use crate::text::{prop, to_js_string, truthy};
use crate::{ClientEnv, JsRecord, JsThrow};

/// What the page hands the hook at mount.
#[derive(Debug, Clone, Copy, PartialEq)]
pub struct Mount<'a> {
    /// `window.location.href`: the boot reads its `?session=`, `?at=`,
    /// `?new=` and `?prompt=`.
    pub href: &'a str,
    /// `performance.timeOrigin`: this page load's id for the boot guard.
    pub page_load: f64,
}

/// A lifecycle fetch's continuation.
#[derive(Debug, Clone, PartialEq, Eq)]
pub(crate) enum LifeThen {
    /// The boot's `/api/sessions/open-tabs` lookup.
    OpenTabs {
        at: Option<String>,
        seed: Option<String>,
    },
    /// `createSession`'s POST, for the transition `seq`.
    Create { seq: u64, by: CreateBy },
    /// `switchSession`'s wake POST.
    Switch { seq: u64, id: String },
    /// `bindToSession`'s `/advisor` read.
    Advisor { id: String },
    /// A badge seed (`/goal-messages` when `goal`, else
    /// `/suggested-messages`), from the commit `seq`.
    Badges { goal: bool, seq: u64 },
    /// The `?prompt=` seed's `/input` POST (no `.catch`).
    SeedInput,
}

/// Who awaits a `createSession`.
#[derive(Debug, Clone, PartialEq, Eq)]
pub(crate) enum CreateBy {
    /// The boot, with the session it skipped and the `?prompt=` seed.
    Boot {
        skipped: Option<String>,
        seed: Option<String>,
    },
    /// `createNewSession()`, whose promise has the id.
    NewSession,
    /// `createSessionAt` / `createNewSessionWithDraft` (void).
    Quiet,
}

/// A create whose session is bound, waiting for its list refresh.
#[derive(Debug, Clone, PartialEq, Eq)]
pub(crate) struct Created {
    by: CreateBy,
    id: String,
}

/// The URL writer's armed write: its timer, the session it reflects, and
/// whether a navigation started since (`navigated`).
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct UrlWrite {
    timer: crate::effect::TimerId,
    session: String,
    navigated: bool,
}

/// What the effects saw at the last commit.
#[derive(Debug, Clone, PartialEq, Eq)]
pub(crate) struct Committed {
    session_id: Option<String>,
    pathname: Option<String>,
    replaying: bool,
    /// Bumped each time the badge effects re-run (their cleanup's
    /// `cancelled`).
    badges_gen: u64,
}

const PREFIX: &str = "create session failed";

/// `sessionStartConnectionLost()`.
fn session_start_connection_lost() -> String {
    format!("{PREFIX}: connection lost \u{2014} couldn't reach Claudius")
}

/// `sessionStartHttpError(status, detail)`: `detail?.trim()` throws on a
/// truthy non-string (the route's `error` as sent, without a `name`).
fn session_start_http_error(status: u16, detail: Option<&Value>) -> Result<String, JsThrow> {
    let d = match detail {
        None => None,
        Some(Value::String(s)) => Some(claudius_agent::js::trim(s).to_owned()),
        Some(_) => return Err(JsThrow::type_error("detail?.trim is not a function")),
    };
    let d = d.filter(|d| !d.is_empty());
    Ok(match (status >= 500, d) {
        (true, Some(d)) => format!("{PREFIX}: server error ({status}) \u{2014} {d}"),
        (true, None) => format!("{PREFIX}: server error ({status})"),
        (false, Some(d)) => format!("{PREFIX}: {d}"),
        (false, None) => format!("{PREFIX}: {status}"),
    })
}

/// `new URL(href)` with its search params edited, as `url.toString()`; an
/// href that doesn't parse is `None` (the TS's `catch { /* ignore */ }`).
/// URLSearchParams re-serializes the whole query on every edit, and an
/// empty one drops the `?`.
fn edit_query(href: &str, f: impl FnOnce(&mut Vec<(String, String)>)) -> Option<String> {
    let mut url = url::Url::parse(href).ok()?;
    let mut pairs: Vec<(String, String)> = url
        .query_pairs()
        .map(|(k, v)| (k.into_owned(), v.into_owned()))
        .collect();
    f(&mut pairs);
    if pairs.is_empty() {
        url.set_query(None);
    } else {
        url.query_pairs_mut().clear().extend_pairs(&pairs);
    }
    Some(url.to_string())
}

/// `searchParams.delete(key)`.
fn delete(pairs: &mut Vec<(String, String)>, key: &str) {
    pairs.retain(|(k, _)| k != key);
}

/// `searchParams.set(key, value)`: the first `key` takes the value and the
/// others go, or it is appended.
fn set(pairs: &mut Vec<(String, String)>, key: &str, value: &str) {
    let mut seen = false;
    pairs.retain_mut(|(k, v)| {
        if k != key {
            return true;
        }
        let first = !seen;
        seen = true;
        if first {
            *v = value.to_owned();
        }
        first
    });
    if !seen {
        pairs.push((key.to_owned(), value.to_owned()));
    }
}

/// The routes the chat lives at: `/`, `/wks_<hex>` and
/// `/customize/cust_<hex>/chat` (each with an optional trailing `/`).
fn is_chat_root(path: &str) -> bool {
    fn hex(s: &str) -> bool {
        !s.is_empty() && s.bytes().all(|b| matches!(b, b'0'..=b'9' | b'a'..=b'f'))
    }
    if path == "/" {
        return true;
    }
    if let Some(id) = path.strip_prefix("/wks_") {
        return hex(id.strip_suffix('/').unwrap_or(id));
    }
    path.strip_prefix("/customize/cust_")
        .map(|rest| rest.strip_suffix('/').unwrap_or(rest))
        .and_then(|rest| rest.strip_suffix("/chat"))
        .is_some_and(hex)
}

/// `searchParams.get(key) || undefined`.
fn param(href: &str, key: &str) -> Option<String> {
    let url = url::Url::parse(href).ok()?;
    let v = url
        .query_pairs()
        .find(|(k, _)| k == key)
        .map(|(_, v)| v.into_owned());
    v.filter(|v| !v.is_empty())
}

/// A truthy string id (`if (!id)` lets `""` through as unbound).
fn bound(id: &Option<String>) -> Option<String> {
    id.clone().filter(|id| !id.is_empty())
}

impl ChatState {
    /// The hook's mount (its effects in order): arm the 30 s poll, then
    /// boot (see the module docs).
    pub fn mount(&mut self, m: Mount<'_>, env: &mut dyn ClientEnv) -> Vec<Effect> {
        let mut cx = Cx::new(env);
        self.location = m.href.to_owned();
        self.page_load = m.page_load;
        self.committed = Some(Committed {
            session_id: self.session_id.clone(),
            pathname: self.pathname.clone(),
            replaying: self.replaying,
            badges_gen: 0,
        });
        self.set_timer(&mut cx.out, TimerFn::SessionsPoll, 30_000.0, true);
        self.boot(&mut cx);
        self.commit(&mut cx);
        cx.out
    }

    /// The unmount cleanups, in the hook's order: the badge seeds are
    /// cancelled, the poll stops, and the boot's cleanup supersedes any
    /// transition in flight, closes the stream and disarms the recovery and
    /// badge timers. The commit effects, the visibility listener and the
    /// stream callbacks stop running after it.
    pub fn unmount(&mut self) -> Vec<Effect> {
        let mut out = Vec::new();
        self.committed = None;
        if let Some(w) = self.url_write.take() {
            self.clear_timer(&mut out, w.timer);
        }
        let polls: Vec<_> = self
            .armed_timers()
            .filter(|(_, f)| *f == TimerFn::SessionsPoll)
            .map(|(id, _)| id)
            .collect();
        for id in polls {
            self.clear_timer(&mut out, id);
        }
        self.unmounted = true;
        self.switch_gen += 1;
        if let Some(es) = self.event_source {
            self.close_stream(es, &mut out);
        }
        // A closed `EventSource` fires nothing more: a callback the host
        // still delivers is for a stream the machine no longer knows.
        self.streams.clear();
        self.cancel_stream_recovery(&mut out);
        if let Some(t) = self.badge_timer.take() {
            self.clear_timer(&mut out, t);
        }
        out
    }

    /// The page navigated without the machine (a router push): the new
    /// `window.location.href`, which the boot, the URL writer and "Open
    /// anyway" read.
    pub fn set_location(&mut self, href: impl Into<String>) {
        self.location = href.into();
    }

    /// A render with a new committed route (`usePathname()`): the URL
    /// writer re-runs.
    pub fn set_pathname(&mut self, pathname: Option<&str>, env: &mut dyn ClientEnv) -> Vec<Effect> {
        let mut cx = Cx::new(env);
        self.pathname = pathname.map(str::to_owned);
        self.commit(&mut cx);
        cx.out
    }

    /// The user or the app started a navigation (an anchor click, a
    /// Navigation API `navigate`, a `markNavigating()` push): a pending
    /// `?session=` write is dropped.
    pub fn navigation_intent(&mut self) {
        if let Some(w) = &mut self.url_write {
            w.navigated = true;
        }
    }

    /// The URL writer's timer: write `?session=` (and drop `?at=`) unless a
    /// navigation started, the page left the chat route, or it's there.
    pub(crate) fn url_write_fired(&mut self, cx: &mut Cx<'_>) {
        let Some(w) = self.url_write.take() else {
            return;
        };
        if w.navigated {
            return;
        }
        let Ok(url) = url::Url::parse(&self.location) else {
            return;
        };
        if !is_chat_root(url.path()) {
            return;
        }
        let current = url
            .query_pairs()
            .find(|(k, _)| k == "session")
            .map(|(_, v)| v.into_owned());
        if current.as_deref() == Some(w.session.as_str())
            && !url.query_pairs().any(|(k, _)| k == "at")
        {
            return;
        }
        let href = self.location.clone();
        if let Some(next) = edit_query(&href, |q| {
            set(q, "session", &w.session);
            delete(q, "at");
        }) {
            self.replace_url(next, cx);
        }
    }

    /// `switchSession(id)`: cut the outgoing session, wake `id` on the
    /// server, then bind it (unless a newer transition started).
    pub fn switch_session(&mut self, id: &str, env: &mut dyn ClientEnv) -> Vec<Effect> {
        let mut cx = Cx::new(env);
        if self.session_id.as_deref() == Some(id) {
            return cx.out;
        }
        self.switch_gen += 1;
        let seq = self.switch_gen;
        self.cut_session(&mut cx);
        self.catching_up = true;
        let body = claudius_core::js_string::stringify(&json!({ "resume": id }));
        self.fetch(
            &mut cx,
            "POST",
            "/api/sessions".into(),
            vec![("Content-Type", "application/json")],
            Some(body),
            Then::Life(LifeThen::Switch {
                seq,
                id: id.to_owned(),
            }),
        );
        self.commit(&mut cx);
        cx.out
    }

    /// `createNewSession()`: a fresh session in the default cwd; its
    /// promise's id (or `null`) is an [`Action::CreateNewSession`].
    pub fn create_new_session(&mut self, env: &mut dyn ClientEnv) -> Vec<Effect> {
        let mut cx = Cx::new(env);
        let opts = self.default_cwd_opts();
        self.create_session(opts, CreateBy::NewSession, &mut cx);
        self.commit(&mut cx);
        cx.out
    }

    /// `createSessionAt(cwd)`.
    pub fn create_session_at(&mut self, cwd: &str, env: &mut dyn ClientEnv) -> Vec<Effect> {
        let mut cx = Cx::new(env);
        let mut opts = Map::new();
        opts.insert("cwd".into(), json!(cwd));
        self.create_session(opts, CreateBy::Quiet, &mut cx);
        self.commit(&mut cx);
        cx.out
    }

    /// `createNewSessionWithDraft(draftText)`: a fresh session whose
    /// composer the server seeds with the draft.
    pub fn create_new_session_with_draft(
        &mut self,
        draft: &str,
        env: &mut dyn ClientEnv,
    ) -> Vec<Effect> {
        let mut cx = Cx::new(env);
        let mut opts = Map::new();
        if !draft.is_empty() {
            opts.insert("initialDraftText".into(), json!(draft));
        }
        opts.extend(self.default_cwd_opts());
        self.create_session(opts, CreateBy::Quiet, &mut cx);
        self.commit(&mut cx);
        cx.out
    }

    /// `openSkippedBootSession()` ("Open anyway"): flag the skipped session
    /// as forced for the next boot and load the page at it.
    pub fn open_skipped_boot_session(&mut self, env: &mut dyn ClientEnv) -> Vec<Effect> {
        let Some(id) = self.skipped_boot_session() else {
            return Vec::new();
        };
        with_storage(env, |s| {
            let _ = s.set_item(BOOT_FORCE_KEY, &id);
        });
        let Some(url) = edit_query(&self.location, |q| {
            delete(q, "new");
            set(q, "session", &id);
        }) else {
            return Vec::new();
        };
        vec![Effect::AssignUrl { url }]
    }

    /// `dismissSkippedBootSession()`.
    pub fn dismiss_skipped_boot_session(&mut self) {
        self.skipped_boot = None;
    }

    /// The `refreshSessions()` action: its promise's merged list is an
    /// [`Action::RefreshSessions`].
    pub fn refresh_session_list(&mut self, env: &mut dyn ClientEnv) -> Vec<Effect> {
        let mut cx = Cx::new(env);
        self.refresh_sessions(AfterRefresh::Resolve, &mut cx);
        cx.out
    }

    // ---------------------------------------------------------- the boot

    fn boot(&mut self, cx: &mut Cx<'_>) {
        let href = self.location.clone();
        let force_new = param(&href, "new").as_deref() == Some("1");
        let resume = (!force_new).then(|| param(&href, "session")).flatten();
        let at = (!force_new).then(|| param(&href, "at")).flatten();
        let seed = param(&href, "prompt");
        if force_new
            && let Some(url) = edit_query(&href, |q| {
                for k in ["new", "session", "at"] {
                    delete(q, k);
                }
            })
        {
            self.replace_url(url, cx);
        }
        if resume.is_none() && !force_new {
            self.fetch(
                cx,
                "GET",
                "/api/sessions/open-tabs".into(),
                Vec::new(),
                None,
                Then::Life(LifeThen::OpenTabs { at, seed }),
            );
            return;
        }
        self.continue_boot(resume, at, seed, cx);
    }

    /// The boot after the open-tabs lookup: the crash-loop guard, then the
    /// create.
    fn continue_boot(
        &mut self,
        mut resume: Option<String>,
        at: Option<String>,
        seed: Option<String>,
        cx: &mut Cx<'_>,
    ) {
        if self.unmounted {
            return;
        }
        let mut resume_at = at;
        let mut skipped = None;
        if let Some(r) = resume.clone() {
            let load = self.page_load;
            let forced = with_storage(cx.env, |s| consume_forced_resume(&r, s));
            let now = cx.env.now_ms();
            if with_storage(cx.env, |s| should_skip_resume(&r, s, now, forced, load)) {
                self.skipped_boot = Some(SkippedBoot {
                    id: r.clone(),
                    fresh_id: None,
                });
                skipped = Some(r);
                resume = None;
                resume_at = None;
                let href = self.location.clone();
                if let Some(url) = edit_query(&href, |q| {
                    delete(q, "session");
                    delete(q, "at");
                }) {
                    self.replace_url(url, cx);
                }
            } else {
                let now = cx.env.now_ms();
                with_storage(cx.env, |s| mark_boot_attempt(&r, s, now, load));
            }
        }
        let opts = match resume {
            Some(r) => {
                let mut o = Map::new();
                o.insert("resume".into(), json!(r));
                if let Some(a) = resume_at {
                    o.insert("resumeSessionAt".into(), json!(a));
                }
                o
            }
            None => self.default_cwd_opts(),
        };
        self.create_session(opts, CreateBy::Boot { skipped, seed }, cx);
    }

    /// `defaultCwdRef.current ? { cwd } : {}`.
    fn default_cwd_opts(&self) -> Map<String, Value> {
        let mut o = Map::new();
        if let Some(cwd) = bound(&self.default_cwd) {
            o.insert("cwd".into(), json!(cwd));
        }
        o
    }

    /// `window.history.replaceState(…, "", url)`.
    fn replace_url(&mut self, url: String, cx: &mut Cx<'_>) {
        self.location = url.clone();
        cx.out.push(Effect::ReplaceUrl { url });
    }

    // ---------------------------------------------------------- transitions

    /// The hard cut both transitions start with: close the stream, unbind
    /// (so actions in the meantime fail soft) and clear the pane.
    fn cut_session(&mut self, cx: &mut Cx<'_>) {
        if let Some(es) = self.event_source.take() {
            self.close_stream(es, &mut cx.out);
        }
        self.session_id = None;
        self.reset_state();
    }

    /// `createSession(opts)`.
    fn create_session(&mut self, opts: Map<String, Value>, by: CreateBy, cx: &mut Cx<'_>) {
        self.switch_gen += 1;
        let seq = self.switch_gen;
        self.cut_session(cx);
        self.catching_up = truthy(opts.get("resume"));
        self.create_error = None;
        let body = claudius_core::js_string::stringify(&Value::Object(opts));
        self.fetch(
            cx,
            "POST",
            "/api/sessions".into(),
            vec![("Content-Type", "application/json")],
            Some(body),
            Then::Life(LifeThen::Create { seq, by }),
        );
    }

    pub(crate) fn life_settled(&mut self, then: LifeThen, outcome: FetchOutcome, cx: &mut Cx<'_>) {
        match then {
            LifeThen::OpenTabs { at, seed } => {
                // `typeof data.activeId === "string" && data.activeId`; a
                // failure of any kind creates fresh.
                let active = outcome
                    .ok()
                    .then(|| outcome.json())
                    .flatten()
                    .and_then(|d| {
                        prop(Some(&d), "activeId")
                            .and_then(Value::as_str)
                            .map(str::to_owned)
                    })
                    .filter(|a| !a.is_empty());
                self.continue_boot(active, at, seed, cx);
            }
            LifeThen::Create { seq, by } => self.create_settled(seq, by, &outcome, cx),
            LifeThen::Switch { seq, id } => {
                // The wake POST's outcome is ignored: the stream route
                // resumes the session itself.
                if seq != self.switch_gen {
                    return;
                }
                self.bind(&id, false, cx);
                self.refresh_sessions(AfterRefresh::Nothing, cx);
            }
            LifeThen::Advisor { id } => {
                if !outcome.ok() || self.session_id.as_deref() != Some(id.as_str()) {
                    return;
                }
                // `res.json().catch(() => null)`, then `if (!body) return`.
                let Some(body) = outcome.json().filter(claudius_agent::js::truthy) else {
                    return;
                };
                self.advisor_model = prop(Some(&body), "model")
                    .and_then(Value::as_str)
                    .filter(|m| !m.is_empty())
                    .map(str::to_owned);
            }
            LifeThen::Badges { goal, seq } => {
                // The effect's cleanup (`cancelled`) ran: another session.
                if self.committed.as_ref().map(|c| c.badges_gen) != Some(seq) || !outcome.ok() {
                    return;
                }
                let Some(Value::Array(incoming)) = outcome
                    .json()
                    .and_then(|d| prop(Some(&d), "uuids").cloned())
                else {
                    return;
                };
                let set = if goal {
                    &mut self.goal_uuids
                } else {
                    &mut self.suggested_uuids
                };
                for u in incoming {
                    if let Value::String(u) = u {
                        set.insert(u);
                    }
                }
            }
            LifeThen::SeedInput => {
                if let FetchOutcome::Failed(error) = outcome {
                    cx.out.push(Effect::UnhandledRejection { error });
                }
            }
        }
    }

    /// `createSession`'s reply.
    fn create_settled(&mut self, seq: u64, by: CreateBy, outcome: &FetchOutcome, cx: &mut Cx<'_>) {
        let reply = match outcome {
            FetchOutcome::Failed(_) => Err(session_start_connection_lost()),
            FetchOutcome::Response { status, .. } if !outcome.ok() => {
                Err(match http_error(*status, outcome.json().as_ref()) {
                    Ok(msg) => msg,
                    Err(thrown) => thrown.message,
                })
            }
            FetchOutcome::Response { body, .. } => match outcome.json() {
                None => {
                    let text = body.strip_prefix('\u{feff}').unwrap_or(body);
                    Err(claudius_agent::js::json_parse_error(text).unwrap_or_default())
                }
                Some(Value::Null) => Err(
                    "Cannot destructure property 'id' of '(intermediate value)' as it is null."
                        .to_owned(),
                ),
                Some(v) => Ok((
                    prop(Some(&v), "id").cloned(),
                    prop(Some(&v), "cwd").cloned(),
                )),
            },
        };
        if seq != self.switch_gen {
            // A newer create or switch superseded this one.
            self.resolve_create(by, None, cx);
            return;
        }
        match reply {
            Ok((id, cwd)) => {
                // Deliberate: an id that isn't a string binds its JS string.
                let id = match id {
                    Some(Value::String(s)) => s,
                    Some(v) => to_js_string(&v).unwrap_or_default(),
                    None => "undefined".to_owned(),
                };
                self.bind(&id, false, cx);
                if let Some(Value::String(c)) = cwd
                    && !c.is_empty()
                {
                    self.cwd = Value::String(c);
                }
                self.refresh_sessions(AfterRefresh::Created(Created { by, id }), cx);
            }
            Err(msg) => {
                self.catching_up = false;
                self.errors.push(json!(msg));
                self.create_error = Some(msg);
                self.resolve_create(by, None, cx);
            }
        }
    }

    /// `await refreshSessions(); return id`.
    pub(crate) fn created(&mut self, c: Created, cx: &mut Cx<'_>) {
        self.resolve_create(c.by, Some(c.id), cx);
    }

    /// `createSession` resolved with `created` (`null` as `None`).
    fn resolve_create(&mut self, by: CreateBy, created: Option<String>, cx: &mut Cx<'_>) {
        match by {
            CreateBy::NewSession => cx.out.push(Effect::ActionResolved {
                action: Action::CreateNewSession,
                outcome: created.map_or(Value::Null, Value::String),
            }),
            CreateBy::Quiet => {}
            CreateBy::Boot { skipped, seed } => self.boot_created(skipped, seed, created, cx),
        }
    }

    /// The boot after its create: pin a skipped boot's notice to the fresh
    /// session (or drop it with none), and start a `?prompt=` seed.
    fn boot_created(
        &mut self,
        skipped: Option<String>,
        seed: Option<String>,
        created: Option<String>,
        cx: &mut Cx<'_>,
    ) {
        let created = created.filter(|c| !c.is_empty());
        if let Some(skipped) = skipped
            && !self.unmounted
            && self.skipped_boot.as_ref().is_some_and(|p| p.id == skipped)
        {
            self.skipped_boot = created.clone().map(|fresh| SkippedBoot {
                id: skipped,
                fresh_id: Some(fresh),
            });
        }
        if let (Some(_), Some(seed)) = (created, seed) {
            self.prompt_seed = Some((seed, cx.env.now_ms()));
            self.prompt_seed_fired(true, cx);
        }
    }

    /// The `?prompt=` seed: wait (100 ms steps, up to 5 s) for a bound
    /// session, strip `?prompt=` from the URL, then from 600 ms on (every
    /// 250 ms while a turn runs) POST it to `/input` once idle.
    pub(crate) fn prompt_seed_fired(&mut self, wait: bool, cx: &mut Cx<'_>) {
        let Some((seed, start)) = self.prompt_seed.clone() else {
            return;
        };
        if wait {
            if bound(&self.session_id).is_none() && cx.env.now_ms() - start < 5000.0 {
                self.set_timer(
                    &mut cx.out,
                    TimerFn::PromptSeed { wait: true },
                    100.0,
                    false,
                );
                return;
            }
            let href = self.location.clone();
            if let Some(url) = edit_query(&href, |q| delete(q, "prompt")) {
                self.replace_url(url, cx);
            }
            self.set_timer(
                &mut cx.out,
                TimerFn::PromptSeed { wait: false },
                600.0,
                false,
            );
        } else if self.pending {
            self.set_timer(
                &mut cx.out,
                TimerFn::PromptSeed { wait: false },
                250.0,
                false,
            );
        } else {
            self.prompt_seed = None;
            if let Some(id) = bound(&self.session_id) {
                let body = claudius_core::js_string::stringify(&json!({ "text": seed }));
                self.fetch(
                    cx,
                    "POST",
                    format!("/api/sessions/{id}/input"),
                    vec![("Content-Type", "application/json")],
                    Some(body),
                    Then::Life(LifeThen::SeedInput),
                );
            }
        }
    }

    // ---------------------------------------------------------- commits

    /// The effects a render runs after an input changed what they watch
    /// (see the module docs). A no-op before `mount` and after `unmount`.
    pub(crate) fn commit(&mut self, cx: &mut Cx<'_>) {
        let Some(prev) = self.committed.clone() else {
            return;
        };
        let session_changed = prev.session_id != self.session_id;
        let route_changed = session_changed || prev.pathname != self.pathname;
        let mut seq = prev.badges_gen;
        if session_changed {
            seq += 1;
            for goal in [false, true] {
                let (set, route) = if goal {
                    (&mut self.goal_uuids, "goal-messages")
                } else {
                    (&mut self.suggested_uuids, "suggested-messages")
                };
                set.clear();
                if let Some(id) = bound(&self.session_id) {
                    self.fetch(
                        cx,
                        "GET",
                        format!("/api/sessions/{id}/{route}"),
                        Vec::new(),
                        None,
                        Then::Life(LifeThen::Badges { goal, seq }),
                    );
                }
            }
        }
        if route_changed {
            if let Some(w) = self.url_write.take() {
                self.clear_timer(&mut cx.out, w.timer);
            }
            if let (true, Some(id)) = (
                self.pathname.as_deref().is_some_and(is_chat_root),
                bound(&self.session_id),
            ) {
                let timer = self.set_timer(&mut cx.out, TimerFn::UrlWriter, 500.0, false);
                self.url_write = Some(UrlWrite {
                    timer,
                    session: id,
                    navigated: false,
                });
            }
        }
        if (session_changed || prev.replaying != self.replaying)
            && !self.replaying
            && let Some(id) = bound(&self.session_id)
        {
            with_storage(cx.env, |s| clear_boot_attempt_for(&id, s));
        }
        if self.skipped_boot.is_some()
            && scope_skipped_boot(self.skipped_boot.clone(), self.session_id.as_deref()).is_none()
        {
            self.skipped_boot = None;
        }
        self.committed = Some(Committed {
            session_id: self.session_id.clone(),
            pathname: self.pathname.clone(),
            replaying: self.replaying,
            badges_gen: seq,
        });
    }

    /// `resetState()`: the pane forgets the session it showed. The polled
    /// list, the stream health, the notices outside the session (nudges,
    /// the model-switch and advisor toasts, `createError`, the skipped
    /// boot) and the once-per-id guards stay.
    pub(crate) fn reset_state(&mut self) {
        self.ready = false;
        self.transcript_path = None;
        self.pending = false;
        self.background_tasks = json!(0);
        self.holder_tab_id = Some(Value::Null);
        self.turn_started_at = None;
        self.last_turn_completed_at = None;
        self.messages.clear();
        self.system_entries.clear();
        self.tool_progress = JsRecord::new();
        self.queue.clear();
        self.pending_permissions.clear();
        self.pending_asks.clear();
        self.pending_elicitations.clear();
        self.prompt_gone.clear();
        self.feedback_survey = None;
        self.opus_overload_nudge = None;
        self.api_retry = None;
        self.tips = Some(json!([]));
        self.session_recap = SessionRecap::idle();
        self.errors.clear();
        self.process_exited = false;
        self.slash_commands.clear();
        self.agents.clear();
        self.main_agent = Some(Value::Null);
        self.account = Some(Value::Null);
        self.skills.clear();
        self.cwd = Value::Null;
        self.agent_cwd = Some(Value::Null);
        self.usage = Value::Null;
        self.plan_usage = Value::Null;
        self.counted_usage.clear();
        self.last_rate_limit_info = None;
        self.seen_result_uuids.clear();
        self.tasks = JsRecord::new();
        self.live_background_task_ids = None;
        self.subagent_messages = JsRecord::new();
        self.pending_plan = Value::Null;
        self.fast_mode_state = Value::Null;
        self.fast_mode_disabled_reason = Value::Null;
        self.fast_mode_notice = Value::Null;
        self.chat_command_model_notice = Value::Null;
        self.auto_mode_off_notice = Value::Null;
        self.mode_change_refused_notice = Value::Null;
        self.prev_fast_mode_state = Value::Null;
        self.prompt_suggestions.clear();
        self.replaying = true;
        self.has_more_above = Some(Value::Bool(false));
        self.loading_older = false;
        self.latest_todos.clear();
        self.todos_auto_cleared = Value::Null;
        self.recent_edits.clear();
        self.background_bashes = JsRecord::new();
        self.scheduled_loops = JsRecord::new();
        self.applied_wakeup_stops.clear();
        self.tool_history.clear();
        self.session_title = Value::Null;
        self.goal = None;
        self.permission_mode = Some(json!("default"));
        self.model = Value::Null;
        self.effort = json!("auto");
        self.applied_effort = None;
        self.effort_wait = NO_EFFORT_WAIT;
        self.effort_change_waits = false;
        self.ultracode = false;
        self.fast_mode = false;
        self.advisor_model = None;
        self.scratch.clear();
        self.scope_message_id.clear();
        self.last_assistant_uuid.clear();
    }
}

/// The `!res.ok` branch: `{ error, name }` off the body (a body that isn't
/// JSON keeps the status), then `sessionStartHttpError`. `Ok` is the
/// message; `Err` is what threw on the way (its message is shown instead).
fn http_error(status: u16, body: Option<&Value>) -> Result<String, JsThrow> {
    let mut detail = None;
    if let Some(err) = prop(body, "error").filter(|e| claudius_agent::js::truthy(e)) {
        detail = Some(
            match prop(body, "name").filter(|n| claudius_agent::js::truthy(n)) {
                Some(name) => {
                    Value::String(format!("{}: {}", to_js_string(name)?, to_js_string(err)?))
                }
                None => err.clone(),
            },
        );
    }
    session_start_http_error(status, detail.as_ref())
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::FixedEnv;
    use crate::boot_guard::{BOOT_MARKER_KEY, TabStorage};
    use crate::effect::{FetchId, FetchRequest, ReadyState, StreamId, TimerId};

    const NOW: f64 = 1_000_000.0;

    fn fetches(fx: &[Effect]) -> Vec<FetchRequest> {
        fx.iter()
            .filter_map(|e| match e {
                Effect::Fetch(r) => Some(r.clone()),
                _ => None,
            })
            .collect()
    }

    fn ok(body: &str) -> FetchOutcome {
        FetchOutcome::Response {
            status: 200,
            body: body.into(),
        }
    }

    /// A mounted pane whose boot POST is in flight: its id.
    fn booting(href: &str, env: &mut FixedEnv) -> (ChatState, FetchId) {
        let mut s = ChatState::new("tab-1");
        let fx = s.mount(
            Mount {
                href,
                page_load: NOW - 5.0,
            },
            env,
        );
        let post = fetches(&fx).pop().unwrap();
        assert_eq!((post.method, post.url.as_str()), ("POST", "/api/sessions"));
        (s, post.id)
    }

    /// Settle every fetch in `fx` with `{}`-ish replies, recursively.
    fn settle_all(s: &mut ChatState, fx: Vec<Effect>, env: &mut FixedEnv) -> Vec<Effect> {
        let mut out = Vec::new();
        let mut queue = fx;
        while !queue.is_empty() {
            let mut next = Vec::new();
            for e in queue {
                if let Effect::Fetch(r) = &e {
                    next.extend(s.fetch_settled(r.id, ok("[]"), env));
                }
                out.push(e);
            }
            queue = next;
        }
        out
    }

    #[test]
    fn a_superseded_create_neither_binds_nor_reports_an_id() {
        let mut env = FixedEnv::new(NOW);
        let (mut s, boot) = booting("http://x/?session=a", &mut env);
        let first = fetches(&s.create_new_session(&mut env)).pop().unwrap();
        let second = fetches(&s.create_new_session(&mut env)).pop().unwrap();
        // The boot's and the first create's replies land after the second
        // create started: both are moot.
        assert!(
            s.fetch_settled(boot, ok(r#"{"id":"a"}"#), &mut env)
                .is_empty()
        );
        let fx = s.fetch_settled(first.id, FetchOutcome::Failed("x".into()), &mut env);
        assert_eq!(
            fx,
            vec![Effect::ActionResolved {
                action: Action::CreateNewSession,
                outcome: Value::Null
            }]
        );
        assert_eq!(s.session_id, None);
        assert!(s.errors.is_empty() && s.create_error.is_none());
        let fx = s.fetch_settled(second.id, ok(r#"{"id":"b"}"#), &mut env);
        assert_eq!(s.session_id.as_deref(), Some("b"));
        let fx = settle_all(&mut s, fx, &mut env);
        assert!(fx.contains(&Effect::ActionResolved {
            action: Action::CreateNewSession,
            outcome: json!("b"),
        }));
    }

    #[test]
    fn a_superseded_switch_doesnt_bind() {
        let mut env = FixedEnv::new(NOW);
        let (mut s, boot) = booting("http://x/?session=a", &mut env);
        let fx = s.fetch_settled(boot, ok("{}"), &mut env);
        settle_all(&mut s, fx, &mut env);
        let a = fetches(&s.switch_session("b", &mut env)).pop().unwrap();
        let b = fetches(&s.switch_session("c", &mut env)).pop().unwrap();
        assert!(s.fetch_settled(a.id, ok("{}"), &mut env).is_empty());
        assert_eq!(s.session_id, None);
        s.fetch_settled(b.id, FetchOutcome::Failed("x".into()), &mut env);
        assert_eq!(s.session_id.as_deref(), Some("c"));
        assert!(s.catching_up);
    }

    #[test]
    fn a_create_reply_without_a_string_id_binds_its_js_string() {
        for (body, id) in [
            (r#"{}"#, "undefined"),
            (r#"{"id":5}"#, "5"),
            ("[1]", "undefined"),
        ] {
            let mut env = FixedEnv::new(NOW);
            let (mut s, boot) = booting("http://x/?session=a", &mut env);
            let fx = s.fetch_settled(boot, ok(body), &mut env);
            assert_eq!(s.session_id.as_deref(), Some(id), "{body}");
            assert!(fx.iter().any(|e| matches!(e,
                Effect::OpenEventSource { url, .. } if url.starts_with(&format!("/api/sessions/{id}/stream")))));
        }
    }

    #[test]
    fn unmount_cleans_up_and_leaves_the_boot_inert() {
        let mut env = FixedEnv::new(NOW);
        let mut s = ChatState::new("tab-1");
        s.pathname = Some("/".into());
        let fx = s.mount(
            Mount {
                href: "http://x/",
                page_load: 0.0,
            },
            &mut env,
        );
        // The poll first, then the boot.
        assert_eq!(
            fx[0],
            Effect::SetTimer {
                id: TimerId(1),
                ms: 30_000.0,
                repeat: true
            }
        );
        let tabs = fetches(&fx[1..]).pop().unwrap();
        assert_eq!(tabs.url, "/api/sessions/open-tabs");
        let fx = s.unmount();
        assert_eq!(fx, vec![Effect::ClearTimer { id: TimerId(1) }]);
        // The lookup lands after the unmount: no create.
        assert!(s.fetch_settled(tabs.id, ok("{}"), &mut env).is_empty());

        // Mounted and bound, with a write, a retry and a badge armed.
        let (mut s, boot) = booting("http://x/?session=a", &mut env);
        s.pathname = Some("/".into());
        let fx = s.fetch_settled(boot, ok(r#"{"id":"a"}"#), &mut env);
        let fx = settle_all(&mut s, fx, &mut env);
        assert!(fx.contains(&Effect::SetTimer {
            id: TimerId(2),
            ms: 500.0,
            repeat: false
        }));
        let es = s.event_source.unwrap();
        s.event_source_error(es, ReadyState::Closed, &mut env);
        assert_eq!(
            s.unmount(),
            vec![
                Effect::ClearTimer { id: TimerId(2) },
                Effect::ClearTimer { id: TimerId(1) },
                Effect::CloseEventSource { id: es },
                Effect::ClearTimer { id: TimerId(4) },
                Effect::ClearTimer { id: TimerId(3) },
            ]
        );
        assert_eq!(s.armed_timers().count(), 0);
        // The stream's late callbacks and the tab's visibility do nothing.
        let replay_done = r#"{"type":"replay_done","hasMoreAbove":false}"#;
        assert!(s.event_source_open(es, &mut env).is_empty());
        assert!(s.event_source_message(es, replay_done, &mut env).is_empty());
        assert!(
            s.event_source_error(es, ReadyState::Closed, &mut env)
                .is_empty()
        );
        assert!(s.visibility_changed(false, &mut env).is_empty());
        assert!(s.replaying);
        // No more commit effects.
        s.session_id = Some("z".into());
        let mut cx = Cx::new(&mut env);
        s.commit(&mut cx);
        assert!(cx.out.is_empty());
    }

    #[test]
    fn a_prompt_seed_waits_for_a_bound_session() {
        let mut env = FixedEnv::new(NOW);
        let mut s = ChatState::new("tab-1");
        s.location = "http://x/?prompt=hi".into();
        s.prompt_seed = Some(("hi".into(), NOW));
        let mut cx = Cx::new(&mut env);
        s.prompt_seed_fired(true, &mut cx);
        let [Effect::SetTimer { id, ms, .. }] = cx.out.as_slice() else {
            panic!("{:?}", cx.out);
        };
        assert_eq!(*ms, 100.0);
        let id = *id;
        // Still unbound: wait again; bound: strip the URL, then 600 ms.
        let fx = s.timer_fired(id, &mut env);
        let [Effect::SetTimer { id, ms: 100.0, .. }] = fx.as_slice() else {
            panic!("{fx:?}");
        };
        s.session_id = Some("a".into());
        let fx = s.timer_fired(*id, &mut env);
        assert_eq!(
            fx[0],
            Effect::ReplaceUrl {
                url: "http://x/".into()
            }
        );
        let Effect::SetTimer { id, ms: 600.0, .. } = fx[1] else {
            panic!("{fx:?}");
        };
        s.pending = true;
        let fx = s.timer_fired(id, &mut env);
        let [Effect::SetTimer { id, ms: 250.0, .. }] = fx.as_slice() else {
            panic!("{fx:?}");
        };
        s.pending = false;
        let fx = s.timer_fired(*id, &mut env);
        let req = fetches(&fx).pop().unwrap();
        assert_eq!(req.url, "/api/sessions/a/input");
        assert_eq!(req.body.as_deref(), Some(r#"{"text":"hi"}"#));
        assert_eq!(s.prompt_seed, None);
        let fx = s.fetch_settled(
            req.id,
            FetchOutcome::Failed("TypeError: x".into()),
            &mut env,
        );
        assert_eq!(
            fx,
            vec![Effect::UnhandledRejection {
                error: "TypeError: x".into()
            }]
        );

        // After 5 s of no session, it goes ahead anyway (and posts nothing).
        let mut s = ChatState::new("tab-1");
        s.location = "http://x/?prompt=hi&a=1".into();
        s.prompt_seed = Some(("hi".into(), NOW - 5000.0));
        let mut cx = Cx::new(&mut env);
        s.prompt_seed_fired(true, &mut cx);
        assert_eq!(
            cx.out[0],
            Effect::ReplaceUrl {
                url: "http://x/?a=1".into()
            }
        );
        let Effect::SetTimer { id, .. } = cx.out[1] else {
            panic!();
        };
        assert!(s.timer_fired(id, &mut env).is_empty());
    }

    /// An env whose page can't use `sessionStorage`.
    struct NoStorageEnv(FixedEnv);
    impl ClientEnv for NoStorageEnv {
        fn now_ms(&mut self) -> f64 {
            self.0.now_ms()
        }
        fn random_uuid(&mut self) -> String {
            self.0.random_uuid()
        }
    }

    #[test]
    fn without_storage_the_guard_never_skips() {
        let mut env = NoStorageEnv(FixedEnv::new(NOW));
        let mut s = ChatState::new("tab-1");
        let fx = s.mount(
            Mount {
                href: "http://x/?session=a",
                page_load: 1.0,
            },
            &mut env,
        );
        let post = fetches(&fx).pop().unwrap();
        assert_eq!(post.body.as_deref(), Some(r#"{"resume":"a"}"#));
        assert_eq!(s.skipped_boot, None);
        assert!(s.open_skipped_boot_session(&mut env).is_empty());
    }

    #[test]
    fn the_guard_skips_and_open_anyway_forces_it() {
        let mut env = FixedEnv::new(NOW);
        let marker = json!({ "id": "a", "at": NOW - 10.0, "load": 7.0 }).to_string();
        env.storage.set_item(BOOT_MARKER_KEY, &marker).unwrap();
        let (mut s, boot) = booting("http://x/p?session=a&at=u&session=b&new=0#h", &mut env);
        assert_eq!(s.location, "http://x/p?new=0#h");
        assert_eq!(s.skipped_boot_session().as_deref(), Some("a"));
        let fx = s.fetch_settled(boot, ok(r#"{"id":"f"}"#), &mut env);
        settle_all(&mut s, fx, &mut env);
        assert_eq!(
            s.skipped_boot,
            Some(SkippedBoot {
                id: "a".into(),
                fresh_id: Some("f".into())
            })
        );
        s.location = "http://x/p?session=f&new=1&session=g".into();
        assert_eq!(
            s.open_skipped_boot_session(&mut env),
            vec![Effect::AssignUrl {
                url: "http://x/p?session=a".into()
            }]
        );
        assert_eq!(
            env.storage.get_item(BOOT_FORCE_KEY).unwrap().as_deref(),
            Some("a")
        );
    }

    #[test]
    fn badge_and_advisor_replies_for_a_session_left_behind_are_dropped() {
        let mut env = FixedEnv::new(NOW);
        let (mut s, boot) = booting("http://x/?session=a", &mut env);
        let fx = s.fetch_settled(boot, ok(r#"{"id":"a"}"#), &mut env);
        let reqs = fetches(&fx);
        let by = |route: &str| reqs.iter().find(|r| r.url.ends_with(route)).unwrap().id;
        let (advisor, suggested, goal) = (
            by("/advisor"),
            by("/suggested-messages"),
            by("/goal-messages"),
        );
        s.switch_session("b", &mut env);
        s.fetch_settled(advisor, ok(r#"{"model":"m"}"#), &mut env);
        s.fetch_settled(suggested, ok(r#"{"uuids":["u"]}"#), &mut env);
        s.fetch_settled(goal, ok(r#"{"uuids":["g"]}"#), &mut env);
        assert_eq!(s.advisor_model, None);
        assert!(s.suggested_uuids.is_empty() && s.goal_uuids.is_empty());
    }

    #[test]
    fn chat_roots_and_query_edits() {
        for (p, root) in [
            ("/", true),
            ("/wks_0af", true),
            ("/wks_0af/", true),
            ("/wks_", false),
            ("/wks_0AF", false),
            ("/wks_0ag", false),
            ("/customize/cust_g/chat", false),
            ("/wks_0af//", false),
            ("/wks_0af/git", false),
            ("/customize/cust_9/chat", true),
            ("/customize/cust_9/chat/", true),
            ("/customize/cust_/chat", false),
            ("/customize/cust_9/chats", false),
            ("", false),
            ("/settings", false),
        ] {
            assert_eq!(is_chat_root(p), root, "{p}");
        }
        assert_eq!(
            edit_query("http://x/?a=1", |q| delete(q, "a")).as_deref(),
            Some("http://x/")
        );
        assert_eq!(edit_query("not a url", |_| {}), None);
        let mut q = vec![
            ("s".into(), "1".into()),
            ("t".into(), "2".into()),
            ("s".into(), "3".into()),
        ];
        set(&mut q, "s", "9");
        assert_eq!(
            q,
            vec![("s".to_owned(), "9".to_owned()), ("t".into(), "2".into())]
        );
        set(&mut q, "u", "a b");
        assert_eq!(q.last().unwrap(), &("u".to_owned(), "a b".to_owned()));
        assert_eq!(param("http://x/?a=&a=2", "a"), None);
        assert_eq!(param("http://x/?a=x+y", "a").as_deref(), Some("x y"));
    }

    #[test]
    fn a_stream_the_machine_never_opened_is_ignored() {
        let mut env = FixedEnv::new(NOW);
        let mut s = ChatState::new("tab-1");
        s.session_id = Some("a".into());
        let ghost = StreamId(9);
        assert!(s.event_source_open(ghost, &mut env).is_empty());
        assert!(s.event_source_message(ghost, "{}", &mut env).is_empty());
        assert!(
            s.event_source_error(ghost, ReadyState::Closed, &mut env)
                .is_empty()
        );
        assert_eq!(s.stream_down_since, None);
    }

    /// A mounted pane bound to `id` (every fetch answered with `[]`).
    fn bound_pane(href: &str, id: &str, env: &mut FixedEnv) -> ChatState {
        let (mut s, boot) = booting(href, env);
        let fx = s.fetch_settled(boot, ok(&json!({ "id": id }).to_string()), env);
        settle_all(&mut s, fx, env);
        assert_eq!(s.session_id.as_deref(), Some(id));
        s
    }

    fn opened(fx: &[Effect]) -> Vec<StreamId> {
        fx.iter()
            .filter_map(|e| match e {
                Effect::OpenEventSource { id, .. } => Some(*id),
                _ => None,
            })
            .collect()
    }

    #[test]
    fn a_create_in_flight_at_unmount_is_moot() {
        let mut env = FixedEnv::new(NOW);
        let marker = json!({ "id": "a", "at": NOW - 10.0, "load": 7.0 }).to_string();
        env.storage.set_item(BOOT_MARKER_KEY, &marker).unwrap();
        let (mut s, boot) = booting("http://x/?session=a", &mut env);
        let notice = s.skipped_boot.clone();
        assert!(notice.is_some());
        s.unmount();
        assert!(
            s.fetch_settled(boot, ok(r#"{"id":"f"}"#), &mut env)
                .is_empty()
        );
        assert_eq!(s.session_id, None);
        // The cleaned-up boot leaves the notice alone.
        assert_eq!(s.skipped_boot, notice);
    }

    #[test]
    fn a_skipped_boot_pins_only_its_own_truthy_session() {
        let marker = json!({ "id": "a", "at": NOW - 10.0, "load": 7.0 }).to_string();
        // A `""` id is no session: the notice goes.
        let mut env = FixedEnv::new(NOW);
        env.storage.set_item(BOOT_MARKER_KEY, &marker).unwrap();
        let (mut s, boot) = booting("http://x/?session=a", &mut env);
        let fx = s.fetch_settled(boot, ok(r#"{"id":""}"#), &mut env);
        settle_all(&mut s, fx, &mut env);
        assert_eq!(s.session_id.as_deref(), Some(""));
        assert_eq!(s.skipped_boot, None);
        // A notice that isn't this boot's is left as it is.
        let mut env = FixedEnv::new(NOW);
        env.storage.set_item(BOOT_MARKER_KEY, &marker).unwrap();
        let (mut s, boot) = booting("http://x/?session=a", &mut env);
        let other = SkippedBoot {
            id: "o".into(),
            fresh_id: None,
        };
        s.skipped_boot = Some(other.clone());
        let fx = s.fetch_settled(boot, ok(r#"{"id":"f"}"#), &mut env);
        settle_all(&mut s, fx, &mut env);
        assert_eq!(s.skipped_boot, Some(other));
    }

    #[test]
    fn a_failed_resume_stops_catching_up() {
        let mut env = FixedEnv::new(NOW);
        let (mut s, boot) = booting("http://x/?session=a", &mut env);
        assert!(s.catching_up);
        s.fetch_settled(boot, FetchOutcome::Failed("TypeError: x".into()), &mut env);
        assert!(!s.catching_up);
        assert_eq!(s.create_error, Some(session_start_connection_lost()));
        assert_eq!(s.errors, vec![json!(session_start_connection_lost())]);
    }

    #[test]
    fn a_bom_reply_that_isnt_json_reports_the_text_without_it() {
        let mut env = FixedEnv::new(NOW);
        let (mut s, boot) = booting("http://x/?session=a", &mut env);
        s.fetch_settled(boot, ok("\u{feff}oops"), &mut env);
        let want = claudius_agent::js::json_parse_error("oops").unwrap();
        assert!(!want.contains('\u{feff}'));
        assert_eq!(s.create_error, Some(want));
    }

    #[test]
    fn http_error_details() {
        let cases = [
            (
                json!({ "error": 0 }),
                "create session failed: server error (500)",
            ),
            (
                json!({ "error": "boom", "name": "" }),
                "create session failed: server error (500) \u{2014} boom",
            ),
            (
                json!({ "error": "boom", "name": "Error" }),
                "create session failed: server error (500) \u{2014} Error: boom",
            ),
            (
                json!({ "error": " \n" }),
                "create session failed: server error (500)",
            ),
        ];
        for (body, want) in cases {
            assert_eq!(http_error(500, Some(&body)).unwrap(), want, "{body}");
        }
        assert_eq!(
            http_error(404, Some(&json!({ "error": "gone" }))).unwrap(),
            "create session failed: gone"
        );
        assert_eq!(http_error(404, None).unwrap(), "create session failed: 404");
        let thrown = http_error(500, Some(&json!({ "error": 5 }))).unwrap_err();
        assert_eq!(thrown.message, "detail?.trim is not a function");
    }

    #[test]
    fn an_open_tabs_failure_creates_fresh() {
        let mut env = FixedEnv::new(NOW);
        let mut s = ChatState::new("tab-1");
        let fx = s.mount(
            Mount {
                href: "http://x/",
                page_load: 1.0,
            },
            &mut env,
        );
        let tabs = fetches(&fx).pop().unwrap();
        let reply = FetchOutcome::Response {
            status: 500,
            body: r#"{"activeId":"a"}"#.into(),
        };
        let post = fetches(&s.fetch_settled(tabs.id, reply, &mut env))
            .pop()
            .unwrap();
        assert_eq!(post.body.as_deref(), Some("{}"));
    }

    #[test]
    fn the_advisor_seed_keeps_the_model_on_a_falsy_body() {
        let mut env = FixedEnv::new(NOW);
        let (mut s, boot) = booting("http://x/?session=a", &mut env);
        let fx = s.fetch_settled(boot, ok(r#"{"id":"a"}"#), &mut env);
        let advisor = fetches(&fx)
            .into_iter()
            .find(|r| r.url.ends_with("/advisor"))
            .unwrap();
        s.advisor_model = Some("from-init".into());
        s.fetch_settled(advisor.id, ok("null"), &mut env);
        assert_eq!(s.advisor_model.as_deref(), Some("from-init"));
        // A switch's advisor read, with an empty model: none.
        let wake = fetches(&s.switch_session("b", &mut env)).pop().unwrap();
        let fx = s.fetch_settled(wake.id, ok("{}"), &mut env);
        let advisor = fetches(&fx)
            .into_iter()
            .find(|r| r.url.ends_with("/advisor"))
            .unwrap();
        s.advisor_model = Some("from-init".into());
        s.fetch_settled(advisor.id, ok(r#"{"model":""}"#), &mut env);
        assert_eq!(s.advisor_model, None);
    }

    #[test]
    fn a_switched_stream_doesnt_rebuild_on_open() {
        let mut env = FixedEnv::new(NOW);
        let mut s = bound_pane("http://x/?session=a", "a", &mut env);
        let wake = fetches(&s.switch_session("b", &mut env)).pop().unwrap();
        let fx = s.fetch_settled(wake.id, ok("{}"), &mut env);
        let [es] = opened(&fx)[..] else {
            panic!("{fx:?}")
        };
        let advisor = fetches(&fx)
            .into_iter()
            .find(|r| r.url.ends_with("/advisor"))
            .unwrap();
        s.fetch_settled(advisor.id, ok(r#"{"model":"m"}"#), &mut env);
        s.event_source_open(es, &mut env);
        assert_eq!(s.advisor_model.as_deref(), Some("m"));
        assert_eq!(s.stream_status, "live");
    }

    #[test]
    fn replay_done_clears_the_boot_marker_in_its_own_commit() {
        let mut env = FixedEnv::new(NOW);
        let mut s = bound_pane("http://x/?session=a", "a", &mut env);
        assert!(env.storage.get_item(BOOT_MARKER_KEY).unwrap().is_some());
        let es = s.event_source.unwrap();
        s.event_source_open(es, &mut env);
        let done = r#"{"type":"replay_done","hasMoreAbove":false}"#;
        s.event_source_message(es, done, &mut env);
        assert_eq!(env.storage.get_item(BOOT_MARKER_KEY).unwrap(), None);
    }

    #[test]
    fn stream_callbacks_of_a_session_left_behind_are_ignored() {
        let mut env = FixedEnv::new(NOW);
        let mut s = bound_pane("http://x/?session=a", "a", &mut env);
        let old = s.event_source.unwrap();
        let wake = fetches(&s.switch_session("b", &mut env)).pop().unwrap();
        s.fetch_settled(wake.id, ok("{}"), &mut env);
        s.stream_status = "connecting";
        s.stream_down_since = Some(1.0);
        s.reconnect_attempts = 3;
        assert!(s.event_source_open(old, &mut env).is_empty());
        assert!(
            s.event_source_error(old, ReadyState::Closed, &mut env)
                .is_empty()
        );
        let done = r#"{"type":"replay_done","hasMoreAbove":false}"#;
        assert!(s.event_source_message(old, done, &mut env).is_empty());
        assert_eq!(
            (
                s.stream_status,
                s.stream_down_since,
                s.reconnect_attempts,
                s.replaying
            ),
            ("connecting", Some(1.0), 3, true)
        );
        assert_eq!(s.reconnect_timer, None);
    }

    #[test]
    fn a_dead_stream_retries_once_at_a_time_and_not_after_a_switch() {
        let mut env = FixedEnv::new(NOW);
        let mut s = bound_pane("http://x/?session=a", "a", &mut env);
        let es = s.event_source.unwrap();
        let fx = s.event_source_error(es, ReadyState::Closed, &mut env);
        let retry = s.reconnect_timer.unwrap();
        assert!(fx.contains(&Effect::SetTimer {
            id: retry,
            ms: 1000.0,
            repeat: false
        }));
        // A second report of the same failure arms nothing more.
        let fx = s.event_source_error(es, ReadyState::Closed, &mut env);
        assert!(
            !fx.iter().any(|e| matches!(e, Effect::SetTimer { .. })),
            "{fx:?}"
        );
        assert_eq!((s.reconnect_timer, s.reconnect_attempts), (Some(retry), 1));
        // The retry falls due while a switch is in flight: no rebind.
        s.switch_session("b", &mut env);
        let fx = s.timer_fired(retry, &mut env);
        assert!(opened(&fx).is_empty(), "{fx:?}");
        assert_eq!(s.session_id, None);
    }

    #[test]
    fn visibility_rebinds_a_bound_session_without_a_live_stream() {
        let mut env = FixedEnv::new(NOW);
        // A dead stream: rebound with the backoff reset.
        let mut s = bound_pane("http://x/?session=a", "a", &mut env);
        let es = s.event_source.unwrap();
        s.event_source_error(es, ReadyState::Closed, &mut env);
        assert_eq!(s.reconnect_attempts, 1);
        let fx = s.visibility_changed(false, &mut env);
        let [fresh] = opened(&fx)[..] else {
            panic!("{fx:?}")
        };
        assert_eq!(s.reconnect_timer, None);
        let fx = s.event_source_error(fresh, ReadyState::Closed, &mut env);
        let retry = s.reconnect_timer.unwrap();
        assert!(fx.contains(&Effect::SetTimer {
            id: retry,
            ms: 1000.0,
            repeat: false
        }));
        // No stream at all.
        let mut s = ChatState::new("tab-1");
        s.session_id = Some("a".into());
        let fx = s.visibility_changed(false, &mut env);
        assert_eq!(opened(&fx).len(), 1, "{fx:?}");
        // `""` is unbound: nothing to revive.
        let mut s = ChatState::new("tab-1");
        s.session_id = Some(String::new());
        let fx = s.visibility_changed(false, &mut env);
        assert!(opened(&fx).is_empty(), "{fx:?}");
        // Hidden: nothing at all.
        let mut s = ChatState::new("tab-1");
        s.session_id = Some("a".into());
        assert!(s.visibility_changed(true, &mut env).is_empty());
        assert!(s.hidden);
    }

    /// The snapshot keys the recorded events touch that `resetState`
    /// leaves alone (checked against the TS: none of them is in its list).
    const KEPT_BY_RESET: &[&str] = &[
        "runningHook",
        "longContextCreditsNudge",
        "authFailedNudge",
        "tokenExpiringNudge",
        "advisorDisabledNotice",
        "todosStale",
        "sdkQueuedTurns",
    ];

    #[test]
    fn a_cut_forgets_the_session_it_showed() {
        let text = std::fs::read_to_string(concat!(
            env!("CARGO_MANIFEST_DIR"),
            "/tests/fixtures/client_session_golden.json"
        ))
        .unwrap();
        let fixture = claudius_core::js_string::parse(&text).unwrap();
        let mut env = FixedEnv::new(NOW);
        let mut dirty = bound_pane("http://x/?session=sess-1", "sess-1", &mut env);
        let mut clean = dirty.clone();
        let mut env2 = env.clone();
        let mut n = 0;
        for sc in fixture["scenarios"].as_array().unwrap() {
            if sc["name"].as_str().unwrap().starts_with("life-") {
                continue;
            }
            for step in sc["steps"].as_array().unwrap() {
                if let Some(data) = step["data"].as_str() {
                    dirty.on_message(data, &mut env);
                    n += 1;
                }
            }
        }
        assert!(n > 1000, "{n}");
        assert_ne!(dirty.snapshot(), clean.snapshot());
        dirty.switch_session("b", &mut env);
        clean.switch_session("b", &mut env2);
        let (got, want) = (dirty.snapshot(), clean.snapshot());
        let differ: Vec<&String> = want
            .as_object()
            .unwrap()
            .iter()
            .filter(|(k, v)| got[k.as_str()] != **v)
            .map(|(k, _)| k)
            .collect();
        assert_eq!(differ, KEPT_BY_RESET, "kept by the reset");
    }
}
