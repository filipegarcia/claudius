//! Page routing: the workspace cookie and the redirects that today live in
//! `proxy.ts` and in the redirect-only server components (N02).
//!
//! This is the router's fallback. It answers the rules below and hands
//! everything else to [`crate::proxy::handler`], so pages, assets and the
//! HMR socket still reach Next.
//!
//! | Rule | Request | Answer | Replaces |
//! |---|---|---|---|
//! | R1 | `/` | the active workspace, else the first one, else `/welcome` | `app/page.tsx` |
//! | R2 | a bare scoped path (`/git`) | `/<cookie><path>`, else the active workspace's | `proxy.ts` job 2, the 20 stubs |
//! | R3 | `/<wks_id>/…` | pass through, with the id written back to the cookie | `proxy.ts` job 1 |
//! | R4 | `/<wks_id>/…`, unknown id | `/` | `app/[workspaceId]/layout.tsx` |
//! | R5 | `/welcome` with a workspace | `/` | `app/welcome/page.tsx` |
//! | R6 | `/customize/<id>/chat`, unknown id | `/customize` | `app/customize/[id]/chat/page.tsx` |
//!
//! Since N03a / N03b those pages read nothing on the server: they make the
//! same decisions in the browser (`components/nav/WorkspaceRedirects.tsx`, and
//! the customization chat page), so Next without Rust in front keeps working.
//! Behind this router they never get to: every rule above answers first.
//!
//! Deliberate differences from the TS:
//! - **Always a 307.** Next sends the server components' `redirect()` as a
//!   200 with a meta refresh when the redirect escapes the root `<Suspense>`
//!   (`app-render.js`), and as a flight redirect on a router fetch. No test
//!   pins the page status, and the browser ends up at the same URL.
//! - **R3 and R2 run for every method**, as Next's proxy does. The rules that
//!   read a store (R1, R4, R5, R6) stand in for a *page render*, so they run
//!   only for `GET` / `HEAD`; anything else falls through to Next and its 405.
//! - A store read that fails is a 500 here. The TS throws, which Next renders
//!   as its own 500 page.
//!
//! `_rsc` survives a redirect that drops the rest of the query: Next 16
//! validates it (`experimental.validateRSCRequestHeaders`) and a missing
//! value costs an extra round trip.
//!
//! While Next still runs behind this, `proxy.ts` writes the same cookie on a
//! request that passes through, so the answer carries two identical
//! `claudius.workspace` headers. `proxy.ts` stays while Next alone must keep
//! working (N03b, until T03); deleting it (N04) removes the duplicate.

use axum::extract::{Request, State};
use axum::http::{HeaderMap, Method, StatusCode, header};
use axum::response::{IntoResponse, Response};
use claudius_core::{customizations, workspaces as store};

use crate::AppState;
use crate::workspaces::{COOKIE, MAX_AGE, read_active_cookie, utc_string};

/// The top-level segments that live under `app/[workspaceId]/`. A bare one
/// (`/git`) belongs to a workspace, so it is redirected under its id.
/// `a_scoped_name_per_workspace_route` keeps this equal to the directory.
pub const SCOPED: [&str; 20] = [
    "agents",
    "assets",
    "cost",
    "database",
    "dev",
    "docker",
    "files",
    "git",
    "hooks",
    "keybindings",
    "mcp",
    "memory",
    "notebooks",
    "permissions",
    "pipeline",
    "schedule",
    "sessions",
    "skills",
    "tracker",
    "workspace",
];

/// The two scoped names whose stub takes a catch-all (`[[...rest]]`), so a
/// bare path at any depth under them redirects. The other 18 stubs are one
/// page each, and a deeper path has no route at all (Next's 404).
const CATCH_ALL: [&str; 2] = ["sessions", "dev"];

/// `wks_<12 hex>`, the shape `workspaces-store.ts` mints and `proxy.ts`
/// matches, so a page named e.g. `wkstest` can't be taken for an id.
fn is_workspace_id(s: &str) -> bool {
    s.len() == 16
        && s.starts_with("wks_")
        && s[4..]
            .bytes()
            .all(|b| b.is_ascii_digit() || (b'a'..=b'f').contains(&b))
}

/// `proxy.ts`'s matcher, `/((?!api/|_next/|.*\.).*)`: everything but the API,
/// Next's internals and any path with a `.` in it (asset requests).
fn matcher(path: &str) -> bool {
    let rest = path.strip_prefix('/').unwrap_or(path);
    !rest.starts_with("api/") && !rest.starts_with("_next/") && !rest.contains('.')
}

/// What the rules decided.
#[derive(Debug, PartialEq, Eq)]
pub(crate) enum Action {
    /// Serve it (here: hand it to Next).
    Pass,
    /// 307 to this `Location`.
    Redirect(String),
}

#[derive(Debug, PartialEq, Eq)]
pub(crate) struct Decision {
    pub(crate) action: Action,
    /// R3's `Set-Cookie`, which rides along with whatever R4 decided.
    pub(crate) set_cookie: Option<String>,
}

impl Decision {
    fn pass() -> Decision {
        Decision {
            action: Action::Pass,
            set_cookie: None,
        }
    }
    fn to(location: impl Into<String>) -> Decision {
        Decision {
            action: Action::Redirect(location.into()),
            set_cookie: None,
        }
    }
}

/// The stores the rules read, so [`decide`] can be tested without them.
pub(crate) trait Env {
    fn workspace_exists(&self, id: &str) -> anyhow::Result<bool>;
    /// `resolveActiveWorkspace()`: the cookie's workspace, else the store's
    /// `activeId` hint, else the first one.
    fn active_workspace(&self, cookie: Option<&str>) -> anyhow::Result<Option<String>>;
    fn first_workspace(&self) -> anyhow::Result<Option<String>>;
    fn customization_exists(&self, id: &str) -> anyhow::Result<bool>;
}

/// The real stores.
pub(crate) struct Stores;

impl Env for Stores {
    fn workspace_exists(&self, id: &str) -> anyhow::Result<bool> {
        Ok(store::get_raw(id)?.is_some())
    }
    fn active_workspace(&self, cookie: Option<&str>) -> anyhow::Result<Option<String>> {
        Ok(store::resolve_active(cookie)?.map(|w| w.id))
    }
    fn first_workspace(&self) -> anyhow::Result<Option<String>> {
        Ok(store::list()?.into_iter().next().map(|w| w.id))
    }
    fn customization_exists(&self, id: &str) -> anyhow::Result<bool> {
        Ok(matches!(customizations::get_customization(id), Ok(Some(_))))
    }
}

/// `?…` as it arrived, for a redirect that keeps the query. `?session=X` is
/// what the chat root boots from.
fn whole_query(query: &str) -> String {
    if query.is_empty() {
        String::new()
    } else {
        format!("?{query}")
    }
}

/// A redirect the TS writes as `redirect("/")` drops the query. Keep `_rsc`:
/// it identifies a router payload request, not page state.
fn rsc_only(query: &str) -> String {
    for pair in query.split('&') {
        if pair == "_rsc" || pair.starts_with("_rsc=") {
            return format!("?{pair}");
        }
    }
    String::new()
}

/// `/customize/<id>/chat` → `<id>`.
fn customize_chat_id(path: &str) -> Option<&str> {
    let rest = path.strip_prefix("/customize/")?;
    let id = rest.strip_suffix("/chat")?;
    (!id.is_empty() && !id.contains('/')).then_some(id)
}

/// The rules, in the order the TS applies them: the proxy first, then the
/// page's own server component. `page` is false for a method that can't be a
/// page render.
pub(crate) fn decide(
    env: &dyn Env,
    path: &str,
    query: &str,
    cookie: Option<&str>,
    page: bool,
) -> anyhow::Result<Decision> {
    if !matcher(path) {
        return Ok(Decision::pass());
    }
    let first = path.split('/').nth(1).unwrap_or("");

    // R3 + R4: the URL carries a workspace id.
    if is_workspace_id(first) {
        let set_cookie = (cookie != Some(first)).then(|| {
            format!(
                "{COOKIE}={first}; Path=/; Expires={}; Max-Age={MAX_AGE}; SameSite=lax",
                utc_string(claudius_core::now_ms() + MAX_AGE * 1000)
            )
        });
        let action = if page && !env.workspace_exists(first)? {
            Action::Redirect(format!("/{}", rsc_only(query)))
        } else {
            Action::Pass
        };
        return Ok(Decision { action, set_cookie });
    }

    // R2: a bare scoped path.
    if SCOPED.contains(&first) {
        if let Some(id) = cookie.filter(|c| is_workspace_id(c)) {
            return Ok(Decision::to(format!("/{id}{path}{}", whole_query(query))));
        }
        let stubbed = CATCH_ALL.contains(&first) || path == format!("/{first}");
        if page && stubbed {
            return Ok(match env.active_workspace(cookie)? {
                Some(id) => Decision::to(format!("/{id}{path}{}", whole_query(query))),
                // The bare stubs send a workspace-less install to `/`
                // (`BareRouteRedirect`, was `redirectToWorkspaceRoute`),
                // where R1 renders or redirects onward.
                None => Decision::to(format!("/{}", whole_query(query))),
            });
        }
        return Ok(Decision::pass());
    }

    if !page {
        return Ok(Decision::pass());
    }

    // R1: the chat root.
    if path == "/" {
        if let Some(id) = env.active_workspace(cookie)? {
            return Ok(Decision::to(format!("/{id}{}", whole_query(query))));
        }
        if let Some(id) = env.first_workspace()? {
            return Ok(Decision::to(format!("/{id}{}", whole_query(query))));
        }
        return Ok(Decision::to(format!("/welcome{}", rsc_only(query))));
    }

    // R5: the first-run splash, once onboarding is done.
    if path == "/welcome" {
        if env.first_workspace()?.is_some() {
            return Ok(Decision::to(format!("/{}", rsc_only(query))));
        }
        return Ok(Decision::pass());
    }

    // R6: a customization's chat.
    if let Some(id) = customize_chat_id(path)
        && !env.customization_exists(id)?
    {
        return Ok(Decision::to(format!("/customize{}", rsc_only(query))));
    }

    Ok(Decision::pass())
}

pub async fn handler(State(app): State<AppState>, req: Request) -> Response {
    let path = req.uri().path().to_owned();
    let query = req.uri().query().unwrap_or("").to_owned();
    let cookie = read_active_cookie(req.headers());
    let page = matches!(*req.method(), Method::GET | Method::HEAD);

    let decision = match decide(&Stores, &path, &query, cookie.as_deref(), page) {
        Ok(d) => d,
        Err(e) => {
            tracing::error!("[pages] {path}: {e}");
            return StatusCode::INTERNAL_SERVER_ERROR.into_response();
        }
    };
    let mut res = match decision.action {
        Action::Pass => crate::proxy::handler(State(app), req).await,
        Action::Redirect(location) => {
            let mut headers = HeaderMap::new();
            if let Ok(v) = location.parse() {
                headers.insert(header::LOCATION, v);
            }
            (StatusCode::TEMPORARY_REDIRECT, headers).into_response()
        }
    };
    if let Some(set) = decision.set_cookie
        && let Ok(v) = set.parse()
    {
        res.headers_mut().append(header::SET_COOKIE, v);
    }
    res
}

#[cfg(test)]
mod tests {
    use super::*;

    /// `workspaces` are the ids the store holds, in order; `active` is what
    /// `resolveActiveWorkspace()` answers for a cookie it doesn't know.
    struct Fake {
        workspaces: Vec<&'static str>,
        hint: Option<&'static str>,
        customizations: Vec<&'static str>,
    }

    impl Default for Fake {
        fn default() -> Fake {
            Fake {
                workspaces: vec!["wks_aaaaaaaaaaaa", "wks_bbbbbbbbbbbb"],
                hint: Some("wks_aaaaaaaaaaaa"),
                customizations: vec!["cust1"],
            }
        }
    }

    impl Env for Fake {
        fn workspace_exists(&self, id: &str) -> anyhow::Result<bool> {
            Ok(self.workspaces.contains(&id))
        }
        fn active_workspace(&self, cookie: Option<&str>) -> anyhow::Result<Option<String>> {
            if let Some(c) = cookie.filter(|c| self.workspaces.contains(c)) {
                return Ok(Some(c.to_owned()));
            }
            Ok(self
                .hint
                .filter(|h| self.workspaces.contains(h))
                .or(self.workspaces.first().copied())
                .map(str::to_owned))
        }
        fn first_workspace(&self) -> anyhow::Result<Option<String>> {
            Ok(self.workspaces.first().copied().map(str::to_owned))
        }
        fn customization_exists(&self, id: &str) -> anyhow::Result<bool> {
            Ok(self.customizations.contains(&id))
        }
    }

    fn get(env: &dyn Env, path: &str, query: &str, cookie: Option<&str>) -> Decision {
        decide(env, path, query, cookie, true).unwrap()
    }

    fn to(d: Decision) -> String {
        match d.action {
            Action::Redirect(l) => l,
            Action::Pass => panic!("passed through"),
        }
    }

    #[test]
    fn r1_root_resolves_a_workspace() {
        let f = Fake::default();
        // The cookie wins when the store knows it.
        assert_eq!(
            to(get(&f, "/", "", Some("wks_bbbbbbbbbbbb"))),
            "/wks_bbbbbbbbbbbb"
        );
        // A stale cookie falls back to the store's hint.
        assert_eq!(
            to(get(&f, "/", "", Some("wks_cccccccccccc"))),
            "/wks_aaaaaaaaaaaa"
        );
        // The query survives — the chat root boots from `?session=`.
        assert_eq!(
            to(get(&f, "/", "session=abc&x=1", None)),
            "/wks_aaaaaaaaaaaa?session=abc&x=1"
        );
    }

    #[test]
    fn r1_root_without_a_workspace_goes_to_welcome() {
        let f = Fake {
            workspaces: vec![],
            hint: None,
            ..Fake::default()
        };
        // `redirect("/welcome")` drops the query, but keeps `_rsc`.
        assert_eq!(to(get(&f, "/", "session=abc", None)), "/welcome");
        assert_eq!(to(get(&f, "/", "_rsc=1a2b", None)), "/welcome?_rsc=1a2b");
        assert_eq!(
            to(get(&f, "/", "session=a&_rsc=1a2b", None)),
            "/welcome?_rsc=1a2b"
        );
    }

    #[test]
    fn r1_falls_back_to_the_first_workspace_when_nothing_resolves() {
        // `activeId` points at a deleted workspace and there is no cookie:
        // `app/page.tsx` then takes `listWorkspaces()[0]`.
        struct NoActive(Fake);
        impl Env for NoActive {
            fn workspace_exists(&self, id: &str) -> anyhow::Result<bool> {
                self.0.workspace_exists(id)
            }
            fn active_workspace(&self, _: Option<&str>) -> anyhow::Result<Option<String>> {
                Ok(None)
            }
            fn first_workspace(&self) -> anyhow::Result<Option<String>> {
                self.0.first_workspace()
            }
            fn customization_exists(&self, id: &str) -> anyhow::Result<bool> {
                self.0.customization_exists(id)
            }
        }
        let f = NoActive(Fake::default());
        assert_eq!(to(get(&f, "/", "q=1", None)), "/wks_aaaaaaaaaaaa?q=1");
    }

    #[test]
    fn r2_bare_scoped_path_takes_the_cookie_without_a_store_check() {
        let f = Fake::default();
        // Any depth, and a cookie the store has never heard of (proxy.ts
        // job 2 doesn't check). R4 then sends the unknown id to `/`.
        assert_eq!(
            to(get(&f, "/git", "", Some("wks_cccccccccccc"))),
            "/wks_cccccccccccc/git"
        );
        assert_eq!(
            to(get(
                &f,
                "/sessions/abc/deep",
                "x=1",
                Some("wks_aaaaaaaaaaaa")
            )),
            "/wks_aaaaaaaaaaaa/sessions/abc/deep?x=1"
        );
    }

    #[test]
    fn r2_without_a_cookie_uses_the_active_workspace_where_a_stub_exists() {
        let f = Fake::default();
        for cookie in [None, Some("not-an-id")] {
            assert_eq!(
                to(get(&f, "/git", "", cookie)),
                "/wks_aaaaaaaaaaaa/git",
                "{cookie:?}"
            );
        }
        // The catch-all stubs cover any depth…
        assert_eq!(
            to(get(&f, "/sessions/abc", "", None)),
            "/wks_aaaaaaaaaaaa/sessions/abc"
        );
        assert_eq!(
            to(get(&f, "/dev/x/y", "", None)),
            "/wks_aaaaaaaaaaaa/dev/x/y"
        );
        // …while the other 18 are one page each: deeper has no route, so
        // Next answers (its 404).
        assert_eq!(get(&f, "/git/file", "", None).action, Action::Pass);
    }

    #[test]
    fn r2_without_any_workspace_goes_to_the_root() {
        let f = Fake {
            workspaces: vec![],
            hint: None,
            ..Fake::default()
        };
        // The bare stubs keep the query on their way to `/` (`BareRouteRedirect`).
        assert_eq!(to(get(&f, "/git", "a=1", None)), "/?a=1");
    }

    #[test]
    fn r3_writes_the_url_id_back_to_the_cookie() {
        let f = Fake::default();
        let d = get(&f, "/wks_bbbbbbbbbbbb/git", "", Some("wks_aaaaaaaaaaaa"));
        assert_eq!(d.action, Action::Pass);
        let set = d.set_cookie.unwrap();
        assert!(
            set.starts_with("claudius.workspace=wks_bbbbbbbbbbbb; Path=/; Expires="),
            "{set}"
        );
        assert!(set.ends_with("; Max-Age=31536000; SameSite=lax"), "{set}");
        // Already in sync: no cookie written.
        assert_eq!(
            get(&f, "/wks_bbbbbbbbbbbb/git", "", Some("wks_bbbbbbbbbbbb")).set_cookie,
            None
        );
    }

    #[test]
    fn r4_an_unknown_workspace_id_goes_to_the_root() {
        let f = Fake::default();
        let d = get(&f, "/wks_cccccccccccc/git", "a=1", None);
        // The cookie is still written (the proxy runs first), and the query
        // is dropped, as `redirect("/")` does.
        assert_eq!(to(d), "/");
        assert!(
            get(&f, "/wks_cccccccccccc/git", "", None)
                .set_cookie
                .is_some()
        );
        // A known id is served.
        assert_eq!(
            get(&f, "/wks_aaaaaaaaaaaa/git", "", None).action,
            Action::Pass
        );
    }

    #[test]
    fn r5_welcome_bounces_once_a_workspace_exists() {
        assert_eq!(to(get(&Fake::default(), "/welcome", "a=1", None)), "/");
        let empty = Fake {
            workspaces: vec![],
            hint: None,
            ..Fake::default()
        };
        assert_eq!(get(&empty, "/welcome", "", None).action, Action::Pass);
    }

    #[test]
    fn r6_an_unknown_customization_chat_goes_to_customize() {
        let f = Fake::default();
        assert_eq!(
            get(&f, "/customize/cust1/chat", "", None).action,
            Action::Pass
        );
        assert_eq!(
            to(get(&f, "/customize/nope/chat", "a=1", None)),
            "/customize"
        );
        // The detail page itself never redirects — it says "not found".
        assert_eq!(get(&f, "/customize/nope", "", None).action, Action::Pass);
        assert_eq!(get(&f, "/customize", "", None).action, Action::Pass);
    }

    #[test]
    fn the_matcher_skips_the_api_internals_and_assets() {
        let f = Fake::default();
        for path in [
            "/api/workspaces",
            "/_next/static/chunk",
            "/favicon.ico",
            "/icon.svg",
        ] {
            assert_eq!(get(&f, path, "", None).action, Action::Pass, "{path}");
        }
    }

    #[test]
    fn a_non_page_method_only_gets_the_proxy_rules() {
        let f = Fake::default();
        // The cookie sync and the bare-path redirect are Next-proxy jobs, so
        // they run for every method.
        let d = decide(&f, "/wks_bbbbbbbbbbbb/git", "", None, false).unwrap();
        assert_eq!((d.action, d.set_cookie.is_some()), (Action::Pass, true));
        assert_eq!(
            to(decide(&f, "/git", "", Some("wks_aaaaaaaaaaaa"), false).unwrap()),
            "/wks_aaaaaaaaaaaa/git"
        );
        // The page rules don't: Next answers (its 405).
        for path in ["/", "/welcome", "/customize/nope/chat", "/git"] {
            assert_eq!(
                decide(&f, path, "", None, false).unwrap().action,
                Action::Pass,
                "{path}"
            );
        }
        // An unknown id is served rather than redirected, so a POST to it
        // reaches the same handler it reaches today.
        assert_eq!(
            decide(&f, "/wks_cccccccccccc/x", "", None, false)
                .unwrap()
                .action,
            Action::Pass
        );
    }

    #[test]
    fn workspace_ids_match_the_minted_shape() {
        assert!(is_workspace_id("wks_0123456789ab"));
        for bad in [
            "wks_0123456789AB", // upper case hex
            "wks_0123456789a",  // too short
            "wks_0123456789abc",
            "wkstest",
            "wks_0123456789ag",
            "",
        ] {
            assert!(!is_workspace_id(bad), "{bad}");
        }
    }

    /// The list must equal the directory it mirrors, or a new scoped route
    /// would 404 on its bare path.
    #[test]
    fn a_scoped_name_per_workspace_route() {
        let dir =
            std::path::PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("../../../app/[workspaceId]");
        let mut found: Vec<String> = std::fs::read_dir(&dir)
            .expect("app/[workspaceId]")
            .filter_map(Result::ok)
            .filter(|e| e.file_type().is_ok_and(|t| t.is_dir()))
            .map(|e| e.file_name().to_string_lossy().into_owned())
            .collect();
        found.sort();
        let mut want: Vec<String> = SCOPED.iter().map(|s| s.to_string()).collect();
        want.sort();
        assert_eq!(found, want);
    }
}
