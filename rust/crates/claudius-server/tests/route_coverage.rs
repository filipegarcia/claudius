//! `rust/scripts/route-coverage.sh`: ROUTES.md must stay in sync with the
//! routers, and the classifier must catch 405-prone partial routes.

use std::path::{Path, PathBuf};
use std::process::Command;

fn script() -> PathBuf {
    PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("../../scripts/route-coverage.sh")
}

fn run(repo: Option<&Path>, args: &[&str]) -> (bool, String, String) {
    let mut cmd = Command::new("bash");
    cmd.arg(script()).args(args);
    if let Some(r) = repo {
        cmd.env("ROUTE_COVERAGE_REPO", r);
    }
    let out = cmd.output().expect("run route-coverage.sh");
    (
        out.status.success(),
        String::from_utf8_lossy(&out.stdout).into(),
        String::from_utf8_lossy(&out.stderr).into(),
    )
}

#[test]
fn routes_md_is_current() {
    let (ok, _, err) = run(None, &["--check"]);
    assert!(ok, "{err}\nregenerate with rust/scripts/route-coverage.sh");
}

#[test]
fn classifier_handles_partial_orphan_catchall_and_501() {
    let root = tempfile::tempdir().unwrap();
    let r = root.path();
    let route = |rel: &str, body: &str| {
        let dir = r.join("app/api").join(rel);
        std::fs::create_dir_all(&dir).unwrap();
        std::fs::write(dir.join("route.ts"), body).unwrap();
    };
    route(
        "things",
        "export async function GET() {}\nexport async function POST() {}\n",
    );
    route("things/[id]", "export const DELETE = () => {};\n");
    route("sessions/[id]/recap", "export async function POST() {}\n");
    route("sessions/export/[id]", "export { handler as GET };\n");
    route("other", "export async function GET() {}\n");
    let src = r.join("rust/crates/claudius-server/src");
    std::fs::create_dir_all(&src).unwrap();
    std::fs::write(
        src.join("lib.rs"),
        r#"Router::new()
        .route("/api/things", get(list))
        .route(
            "/api/things/{thing}",
            axum::routing::delete(remove),
        )
        .route("/api/sessions/export/{*rest}", any(crate::proxy::handler))
        .route("/api/sessions/{id}/{*rest}", any(not_ported))
        .route("/api/ghost", post(ghost))"#,
    )
    .unwrap();

    let (ok, stdout, _) = run(Some(r), &[]);
    assert!(ok);
    assert!(
        stdout.contains("rust 2 · proxied 1 · 501 1 · next-only 1 · PARTIAL 1 · orphans 1"),
        "{stdout}"
    );
    let md = std::fs::read_to_string(r.join("rust/ROUTES.md")).unwrap();
    assert!(
        md.contains("| `/api/things` | GET,POST | PARTIAL — missing POST (axum answers 405) |"),
        "{md}"
    );
    assert!(
        md.contains("| `/api/things/[id]` | DELETE |  |"),
        "param names are ignored"
    );
    assert!(
        md.contains("| `/api/sessions/export/[id]` | GET | via `/api/sessions/export/{*rest}` |")
    );
    assert!(
        md.contains("| `/api/sessions/[id]/recap` | POST | via `/api/sessions/{id}/{*rest}` |")
    );
    assert!(md.contains("**Rust routes with no Next counterpart:** `/api/ghost`"));

    let (ok, _, err) = run(Some(r), &["--check"]);
    assert!(!ok, "PARTIAL + orphan must fail --check");
    assert!(
        err.contains("PARTIAL routes: /api/things") && err.contains("/api/ghost"),
        "{err}"
    );
}
