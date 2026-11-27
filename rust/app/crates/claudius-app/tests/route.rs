//! Routing: every React page route parses from and formats to its URL, and
//! the redirect rules (`claudius_server::pages::decide`, the workspace
//! layout's guard) land where the browser would.

use claudius_app::route::{
    DevPage, Resolution, Route, SCOPED, WorkspacePage, Workspaces, is_workspace_id, resolve,
    resolve_step,
};

const A: &str = "wks_3f2a9c81d0e4";
const B: &str = "wks_7b41e05c92aa";

struct Store {
    ids: Vec<&'static str>,
    active: Option<&'static str>,
}

impl Workspaces for Store {
    fn exists(&self, id: &str) -> bool {
        self.ids.contains(&id)
    }
    fn active(&self) -> Option<String> {
        self.active
            .filter(|a| self.exists(a))
            .or_else(|| self.ids.first().copied())
            .map(str::to_owned)
    }
    fn first(&self) -> Option<String> {
        self.ids.first().map(|s| (*s).to_owned())
    }
}

fn two() -> Store {
    Store {
        ids: vec![A, B],
        active: Some(B),
    }
}

fn none() -> Store {
    Store {
        ids: vec![],
        active: None,
    }
}

fn page(p: WorkspacePage) -> Route {
    Route::page(A, p)
}

/// One of every page, with and without its parameters.
fn every_route() -> Vec<Route> {
    let mut out = vec![
        Route::chat(A),
        page(WorkspacePage::Chat {
            session: Some("3e9a7c41-0b2d-4e8f-8c6a-1d2e3f405162".into()),
        }),
        page(WorkspacePage::Agents),
        page(WorkspacePage::Assets),
        page(WorkspacePage::Cost),
        page(WorkspacePage::Database),
        page(WorkspacePage::Docker),
        page(WorkspacePage::Files {
            root: None,
            path: None,
        }),
        page(WorkspacePage::Files {
            root: Some("extra 1".into()),
            path: Some("src/app & co/é.rs".into()),
        }),
        page(WorkspacePage::Files {
            root: None,
            path: Some("README.md".into()),
        }),
        page(WorkspacePage::Git),
        page(WorkspacePage::GitFile {
            path: "lib/a b.ts".into(),
            mode: Some("staged".into()),
        }),
        page(WorkspacePage::GitFile {
            path: "x.rs".into(),
            mode: None,
        }),
        page(WorkspacePage::Hooks),
        page(WorkspacePage::Keybindings),
        page(WorkspacePage::Mcp),
        page(WorkspacePage::Memory),
        page(WorkspacePage::Notebooks),
        page(WorkspacePage::Permissions),
        page(WorkspacePage::Pipeline),
        page(WorkspacePage::Schedule),
        page(WorkspacePage::Sessions),
        page(WorkspacePage::Session {
            id: "8c1f2d3e-4a5b-4c6d-8e7f-90a1b2c3d4e5".into(),
            dir: None,
        }),
        page(WorkspacePage::Session {
            id: "8c1f2d3e".into(),
            dir: Some("/Users/demo/my project".into()),
        }),
        page(WorkspacePage::Skills),
        page(WorkspacePage::Tracker),
        page(WorkspacePage::Workspace),
        Route::Welcome,
        Route::Settings,
        Route::Plugins,
        Route::Usage,
        Route::Community,
        Route::Doctor { section: None },
        Route::Doctor {
            section: Some("prompt-audit".into()),
        },
        Route::ReleaseNotes,
        Route::Updater,
        Route::Customize,
        Route::CustomizeSettings,
        Route::CustomizeDetail { id: "cus_1".into() },
        Route::CustomizeChat { id: "cus_1".into() },
    ];
    out.extend(
        DevPage::ALL
            .into_iter()
            .map(|d| page(WorkspacePage::Dev(d))),
    );
    out
}

#[test]
fn every_page_round_trips_through_its_url() {
    let routes = every_route();
    assert_eq!(routes.len(), 40 + DevPage::ALL.len());
    for route in routes {
        let url = route.path();
        assert_eq!(Route::parse(&url), Some(route.clone()), "{url}");
        // And through the redirect rules, with its workspace existing (the
        // splash is only for a store with none).
        let store = if route == Route::Welcome {
            none()
        } else {
            two()
        };
        assert_eq!(resolve(&url, &store), route, "{url}");
        assert!(!route.title().is_empty());
    }
}

#[test]
fn urls_format_as_the_react_links() {
    assert_eq!(Route::chat(A).path(), format!("/{A}"));
    assert_eq!(page(WorkspacePage::Git).path(), format!("/{A}/git"));
    assert_eq!(
        page(WorkspacePage::Files {
            root: Some("r".into()),
            path: Some("src/app".into()),
        })
        .path(),
        format!("/{A}/files?root=r&path=src%2Fapp")
    );
    assert_eq!(
        page(WorkspacePage::GitFile {
            path: "a b.rs".into(),
            mode: Some("worktree".into()),
        })
        .path(),
        format!("/{A}/git/file?path=a+b.rs&mode=worktree")
    );
    assert_eq!(
        page(WorkspacePage::Chat {
            session: Some("s1".into())
        })
        .path(),
        format!("/{A}?session=s1")
    );
    assert_eq!(
        page(WorkspacePage::Session {
            id: "a/b".into(),
            dir: None
        })
        .path(),
        format!("/{A}/sessions/a%2Fb")
    );
    assert_eq!(
        page(WorkspacePage::Dev(DevPage::ChatWorkflowCompleted)).path(),
        format!("/{A}/dev/chat-workflow-completed")
    );
    assert_eq!(
        Route::Doctor {
            section: Some("prompt-audit".into())
        }
        .path(),
        "/doctor?section=prompt-audit"
    );
    assert_eq!(
        Route::CustomizeChat { id: "x".into() }.path(),
        "/customize/x/chat"
    );
}

#[test]
fn parse_reads_queries_and_drops_what_no_page_has() {
    assert_eq!(
        Route::parse(&format!("/{A}/files?path=a%20b&root=r#frag")),
        Some(page(WorkspacePage::Files {
            root: Some("r".into()),
            path: Some("a b".into()),
        }))
    );
    // An unknown mode is dropped; an empty session is none.
    assert_eq!(
        Route::parse(&format!("/{A}/git/file?path=x&mode=bogus")),
        Some(page(WorkspacePage::GitFile {
            path: "x".into(),
            mode: None,
        }))
    );
    assert_eq!(
        Route::parse(&format!("/{A}?session=")),
        Some(Route::chat(A))
    );
    // `/` and a bare scoped path need the redirect rules.
    assert_eq!(Route::parse("/"), None);
    for name in SCOPED {
        assert_eq!(Route::parse(&format!("/{name}")), None, "{name}");
    }
    // No page: an unknown inner page, a dev page that doesn't exist, a
    // deeper global path.
    assert_eq!(Route::parse(&format!("/{A}/nope")), None);
    assert_eq!(Route::parse(&format!("/{A}/dev/nope")), None);
    assert_eq!(Route::parse(&format!("/{A}/git/file/x")), None);
    assert_eq!(Route::parse("/doctor/x"), None);
    assert_eq!(Route::parse("/settings/x"), None);
}

#[test]
fn workspace_ids_are_the_store_shape() {
    assert!(is_workspace_id(A));
    assert!(!is_workspace_id("wks_3F2A9C81D0E4"));
    assert!(!is_workspace_id("wks_3f2a9c81d0e"));
    assert!(!is_workspace_id("wks_3f2a9c81d0e4f"));
    assert!(!is_workspace_id("ws_3f2a9c81d0e4a"));
    assert!(!is_workspace_id("wks_3f2a9c81d0eg"));
}

#[test]
fn r1_the_root_opens_the_active_workspace_or_the_splash() {
    assert_eq!(
        resolve_step("/", &two()),
        Resolution::Redirect(format!("/{B}"))
    );
    assert_eq!(
        resolve_step("/?session=s1", &two()),
        Resolution::Redirect(format!("/{B}?session=s1"))
    );
    assert_eq!(resolve("/", &two()), Route::chat(B));
    // A stale hint falls back to the first.
    let stale = Store {
        ids: vec![A, B],
        active: Some("wks_000000000000"),
    };
    assert_eq!(resolve("/", &stale), Route::chat(A));
    assert_eq!(
        resolve_step("/", &none()),
        Resolution::Redirect("/welcome".into())
    );
    assert_eq!(resolve("/", &none()), Route::Welcome);
}

#[test]
fn r2_a_bare_scoped_path_joins_the_active_workspace() {
    assert_eq!(
        resolve_step("/git/file?path=x&mode=staged", &two()),
        Resolution::Redirect(format!("/{B}/git/file?path=x&mode=staged"))
    );
    assert_eq!(
        resolve("/files?path=src", &two()),
        Route::page(
            B,
            WorkspacePage::Files {
                root: None,
                path: Some("src".into()),
            }
        )
    );
    assert_eq!(
        resolve("/sessions/abc", &two()),
        Route::page(
            B,
            WorkspacePage::Session {
                id: "abc".into(),
                dir: None
            }
        )
    );
    // The row link's `?dir=` (the session's cwd) survives the redirect.
    assert_eq!(
        resolve("/sessions/abc?dir=%2FUsers%2Fdemo%2Fa%20b", &two()),
        Route::page(
            B,
            WorkspacePage::Session {
                id: "abc".into(),
                dir: Some("/Users/demo/a b".into()),
            }
        )
    );
    assert_eq!(
        resolve("/sessions/abc?dir=", &two()),
        Route::page(
            B,
            WorkspacePage::Session {
                id: "abc".into(),
                dir: None
            }
        )
    );
    // A scoped page that doesn't exist is a 404 under the workspace.
    assert_eq!(
        resolve("/git/nope", &two()),
        Route::NotFound {
            path: format!("/{B}/git/nope")
        }
    );
    // With no workspace: the stubs go to `/` (then the splash), deeper
    // paths have no page.
    assert_eq!(
        resolve_step("/git?x=1", &none()),
        Resolution::Redirect("/?x=1".into())
    );
    assert_eq!(resolve("/git", &none()), Route::Welcome);
    assert_eq!(resolve("/sessions/a/b", &none()), Route::Welcome);
    assert_eq!(resolve("/dev/chat-ask", &none()), Route::Welcome);
    assert_eq!(
        resolve("/git/file", &none()),
        Route::NotFound {
            path: "/git/file".into()
        }
    );
}

#[test]
fn r4_and_the_guard_send_an_unknown_workspace_home() {
    assert_eq!(
        resolve_step("/wks_000000000000/git?x=1", &two()),
        Resolution::Redirect("/".into())
    );
    assert_eq!(resolve("/wks_000000000000/git", &two()), Route::chat(B));
    // Not the id shape: still `[workspaceId]`, still unknown.
    assert_eq!(
        resolve_step("/my-project", &two()),
        Resolution::Redirect("/".into())
    );
    assert_eq!(resolve("/my-project/git", &none()), Route::Welcome);
    // A known workspace's unknown page is a 404.
    assert_eq!(
        resolve(&format!("/{A}/nope"), &two()),
        Route::NotFound {
            path: format!("/{A}/nope")
        }
    );
}

#[test]
fn r5_the_splash_leaves_once_a_workspace_exists() {
    assert_eq!(
        resolve_step("/welcome", &two()),
        Resolution::Redirect("/".into())
    );
    assert_eq!(resolve("/welcome", &two()), Route::chat(B));
    assert_eq!(resolve("/welcome", &none()), Route::Welcome);
    // The global pages need no workspace.
    assert_eq!(resolve("/settings", &none()), Route::Settings);
    assert_eq!(resolve("/usage", &two()), Route::Usage);
}

#[test]
fn route_memory_keeps_the_pathname_only() {
    let p = WorkspacePage::Files {
        root: Some("r".into()),
        path: Some("x".into()),
    };
    assert_eq!(
        p.without_query(),
        WorkspacePage::Files {
            root: None,
            path: None,
        }
    );
    assert_eq!(p.inner_pathname(), "/files");
    assert_eq!(p.inner_path(), "/files?root=r&path=x");
    assert_eq!(
        WorkspacePage::Chat {
            session: Some("s".into())
        }
        .without_query(),
        WorkspacePage::Chat { session: None }
    );
    // A path parameter isn't a query: it stays; `?dir=` goes.
    let s = WorkspacePage::Session {
        id: "s".into(),
        dir: None,
    };
    assert_eq!(s.without_query(), s);
    let with_dir = WorkspacePage::Session {
        id: "s".into(),
        dir: Some("/p".into()),
    };
    assert_eq!(with_dir.without_query(), s);
}

#[test]
fn placeholders_name_their_parameters() {
    let r = page(WorkspacePage::GitFile {
        path: "a.rs".into(),
        mode: None,
    });
    assert_eq!(r.title(), "Git file");
    assert_eq!(
        r.params(),
        vec![
            ("workspace", A.to_owned()),
            ("path", "a.rs".to_owned()),
            ("mode", "(none)".to_owned()),
        ]
    );
    assert_eq!(Route::Settings.params(), vec![]);
    assert_eq!(
        Route::NotFound { path: "/x".into() }.params(),
        vec![("path", "/x".to_owned())]
    );
    assert!(page(WorkspacePage::Git).is_workspace_scoped());
    assert!(!Route::Settings.is_workspace_scoped());
    assert_eq!(page(WorkspacePage::Git).workspace(), Some(A));
    assert_eq!(Route::Plugins.workspace(), None);
}
