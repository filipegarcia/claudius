//! Drift: fails when `app/globals.css`, or the Tailwind theme / preflight it
//! imports, changes a token this crate ports. Both stylesheets are read in
//! place (relative to `CARGO_MANIFEST_DIR`) and compared on source text.
//!
//! globals.css: every custom property it declares, anywhere, must be one
//! the crate has, with the same text in the same selector (a new token, a
//! new theme or a moved block fails too), plus the chrome rules the crate
//! reads (selection, find highlight, scrollbar, font stacks, the unlayered
//! `* { border-color }`). theme.css: each ported default's text.
//!
//! The Rust CI job checks out the repo without `node_modules`. There the
//! Tailwind half pins the version instead: `bun.lock` must resolve the
//! `tailwindcss` the golden was recorded from (`fixtures/theme_golden.json`,
//! whose `lengths.raw` / `tailwindColors` hold that theme.css's text).

use claudius_theme::chat::{self, CHAT_COL_FLUID, CHAT_TEXT_FLUID};
use claudius_theme::palette::{self, INLINE_COLORS, ThemeName};
use claudius_theme::tailwind;

fn path(rel: &str) -> String {
    format!("{}/{rel}", env!("CARGO_MANIFEST_DIR"))
}

fn read(rel: &str) -> String {
    let path = path(rel);
    std::fs::read_to_string(&path).unwrap_or_else(|e| panic!("{path}: {e}"))
}

const THEME_CSS: &str = "../../../node_modules/tailwindcss/theme.css";
const PREFLIGHT_CSS: &str = "../../../node_modules/tailwindcss/preflight.css";

fn have_node_modules() -> bool {
    std::path::Path::new(&path(THEME_CSS)).is_file()
}

/// The Tailwind version the golden was recorded from.
fn recorded_tailwind() -> String {
    let f = read("tests/fixtures/theme_golden.json");
    let v: serde_json::Value = serde_json::from_str(&f).expect("fixture json");
    v["tailwind"]
        .as_str()
        .expect("fixture tailwind version")
        .to_string()
}

/// One block: the at-rules / selectors around it, its prelude and its
/// declarations (whitespace collapsed).
#[derive(Debug)]
struct Rule {
    context: Vec<String>,
    prelude: String,
    decls: Vec<(String, String)>,
}

fn squash(s: &str) -> String {
    s.split_whitespace().collect::<Vec<_>>().join(" ")
}

fn strip_comments(css: &str) -> String {
    let mut out = String::new();
    let mut rest = css;
    while let Some(i) = rest.find("/*") {
        out.push_str(&rest[..i]);
        rest = rest[i + 2..].split_once("*/").map_or("", |(_, r)| r);
    }
    out.push_str(rest);
    out
}

/// Byte index of the first of `stops` outside strings and parentheses.
fn scan(s: &str, stops: &[u8]) -> Option<usize> {
    let (mut depth, mut quote) = (0i32, None::<u8>);
    for (i, &b) in s.as_bytes().iter().enumerate() {
        match quote {
            Some(q) if b == q => quote = None,
            Some(_) => {}
            None => match b {
                b'"' | b'\'' => quote = Some(b),
                b'(' => depth += 1,
                b')' => depth -= 1,
                _ if depth == 0 && stops.contains(&b) => return Some(i),
                _ => {}
            },
        }
    }
    None
}

fn matching_brace(s: &str) -> usize {
    let mut depth = 0;
    let mut i = 0;
    while let Some(j) = scan(&s[i..], b"{}") {
        let at = i + j;
        if s.as_bytes()[at] == b'{' {
            depth += 1;
        } else {
            if depth == 0 {
                return at;
            }
            depth -= 1;
        }
        i = at + 1;
    }
    panic!("unbalanced braces");
}

fn parse_body(body: &str, context: &[String], out: &mut Vec<Rule>) -> Vec<(String, String)> {
    let mut decls = Vec::new();
    let mut rest = body;
    loop {
        rest = rest.trim_start();
        if rest.is_empty() {
            return decls;
        }
        match scan(rest, b";{") {
            Some(i) if rest.as_bytes()[i] == b'{' => {
                let prelude = squash(&rest[..i]);
                let inner = &rest[i + 1..];
                let end = matching_brace(inner);
                let mut ctx = context.to_vec();
                ctx.push(prelude.clone());
                let d = parse_body(&inner[..end], &ctx, out);
                out.push(Rule {
                    context: context.to_vec(),
                    prelude,
                    decls: d,
                });
                rest = &inner[end + 1..];
            }
            stop => {
                let end = stop.unwrap_or(rest.len());
                let chunk = rest[..end].trim();
                if !chunk.starts_with('@')
                    && let Some((name, value)) = chunk.split_once(':')
                {
                    decls.push((squash(name), squash(value)));
                }
                rest = &rest[(end + 1).min(rest.len())..];
            }
        }
    }
}

fn parse(css: &str) -> Vec<Rule> {
    let mut out = Vec::new();
    let top = parse_body(&strip_comments(css), &[], &mut out);
    assert!(top.is_empty(), "declarations outside a block: {top:?}");
    out
}

/// `(context > prelude, property, value)`.
type Decl = (String, String, String);

fn flatten(rules: &[Rule]) -> Vec<Decl> {
    let mut v = Vec::new();
    for r in rules {
        let mut at = r.context.clone();
        at.push(r.prelude.clone());
        for (n, val) in &r.decls {
            v.push((at.join(" > "), n.clone(), val.clone()));
        }
    }
    v
}

fn theme_sel(t: ThemeName) -> String {
    format!(":root[data-theme=\"{}\"]", t.id())
}

fn quote_family(f: &str) -> String {
    if f.contains(' ') {
        format!("\"{f}\"")
    } else {
        f.to_string()
    }
}

fn stack(first: &str, rest: &[&str]) -> String {
    std::iter::once(first.to_string())
        .chain(rest.iter().map(|f| quote_family(f)))
        .collect::<Vec<_>>()
        .join(", ")
}

/// Every custom property globals.css should declare, from the crate.
fn expected_custom_properties() -> Vec<Decl> {
    let mut v = Vec::new();
    let mut push = |at: String, name: &str, value: String| v.push((at, name.to_string(), value));
    for t in ThemeName::ALL {
        let sel = if t == ThemeName::DEFAULT {
            format!(":root, {}", theme_sel(t))
        } else {
            theme_sel(t)
        };
        for (n, val) in t.source().entries() {
            push(sel.clone(), n, val.to_string());
        }
    }
    for dark in [true, false] {
        let group: Vec<String> = ThemeName::ALL
            .into_iter()
            .filter(|t| t.is_dark() == dark)
            .map(theme_sel)
            .collect();
        let sel = if dark {
            format!(":root, {}", group.join(", "))
        } else {
            group.join(", ")
        };
        let src = if dark {
            &palette::SERIES_DARK
        } else {
            &palette::SERIES_LIGHT
        };
        for (n, val) in src.entries() {
            push(sel.clone(), n, val.to_string());
        }
    }
    for (n, val) in INLINE_COLORS {
        push("@theme inline".into(), n, val.to_string());
    }
    push(
        "@theme inline".into(),
        "--font-sans",
        tailwind::FONT_SANS_SOURCE.into(),
    );
    push(
        "@theme inline".into(),
        "--font-mono",
        tailwind::FONT_MONO_SOURCE.into(),
    );
    push(
        ":root".into(),
        "--chat-col",
        format!("{}rem", chat::CHAT_COL_REM),
    );
    push(
        ":root".into(),
        "--chat-text",
        format!("{}rem", chat::CHAT_TEXT_REM),
    );
    let media = format!(
        "@media (min-width: {}px) > :root",
        chat::FLUID_MIN_VIEWPORT_PX
    );
    push(media.clone(), "--chat-col", CHAT_COL_FLUID.source());
    push(media, "--chat-text", CHAT_TEXT_FLUID.source());
    push(
        ":root".into(),
        "--titlebar-height",
        format!("{}px", palette::TITLEBAR_HEIGHT_PX),
    );
    push(
        "html[data-electron]".into(),
        "--titlebar-height",
        format!("{}px", palette::TITLEBAR_HEIGHT_ELECTRON_PX),
    );
    v
}

/// The non-variable declarations the crate reads.
fn expected_chrome() -> Vec<Decl> {
    let d = |at: &str, n: &str, v: String| (at.to_string(), n.to_string(), v);
    let px = |n: f64| format!("{n}px");
    vec![
        d("*", "border-color", "var(--border)".into()),
        d("::selection", "background", palette::SELECTION.into()),
        d(
            ":root[data-theme=\"synthwave\"] ::selection",
            "background",
            palette::SELECTION_SYNTHWAVE.into(),
        ),
        d(
            "::highlight(transcript-find)",
            "background-color",
            palette::FIND_HIGHLIGHT.into(),
        ),
        d(
            "::highlight(transcript-find)",
            "color",
            palette::FIND_HIGHLIGHT_TEXT.into(),
        ),
        d(
            "::highlight(transcript-find-current)",
            "background-color",
            palette::FIND_HIGHLIGHT_CURRENT.into(),
        ),
        d(
            "::highlight(transcript-find-current)",
            "color",
            palette::FIND_HIGHLIGHT_TEXT.into(),
        ),
        d(
            ".scroll-thin::-webkit-scrollbar",
            "width",
            px(palette::SCROLLBAR_PX),
        ),
        d(
            ".scroll-thin::-webkit-scrollbar",
            "height",
            px(palette::SCROLLBAR_PX),
        ),
        d(
            ".scroll-thin::-webkit-scrollbar-thumb",
            "background",
            "var(--border)".into(),
        ),
        d(
            ".scroll-thin::-webkit-scrollbar-thumb",
            "border-radius",
            px(palette::SCROLLBAR_THUMB_RADIUS_PX),
        ),
        d(
            ".scroll-thin::-webkit-scrollbar-thumb:hover",
            "background",
            palette::SCROLLBAR_THUMB_HOVER.into(),
        ),
        d(
            "html[data-electron] body",
            "padding-top",
            "var(--titlebar-height)".into(),
        ),
        d(
            "body",
            "font-family",
            stack("var(--font-sans)", &tailwind::BODY_FONT_FALLBACKS),
        ),
        d(
            ".shiki-host pre.shiki, .shiki-host pre",
            "font-family",
            stack("var(--font-mono)", &tailwind::CODE_FONT_FALLBACKS),
        ),
    ]
}

/// What differs between globals.css and the crate, one line per problem.
fn globals_mismatches(css: &str) -> Vec<String> {
    let decls = flatten(&parse(css));
    let mut problems = Vec::new();
    let mut have: Vec<Decl> = decls
        .iter()
        .filter(|(_, n, _)| n.starts_with("--"))
        .cloned()
        .collect();
    let mut want = expected_custom_properties();
    have.sort();
    want.sort();
    for d in &have {
        if !want.contains(d) {
            problems.push(format!("globals.css has {d:?}, the crate doesn't"));
        }
    }
    for d in &want {
        if !have.contains(d) {
            problems.push(format!("the crate has {d:?}, globals.css doesn't"));
        }
    }
    for d in expected_chrome() {
        if !decls.contains(&d) {
            problems.push(format!("globals.css no longer has {d:?}"));
        }
    }
    let mut ids: Vec<String> = Vec::new();
    for (at, _, _) in &decls {
        let mut rest = at.as_str();
        while let Some(i) = rest.find("data-theme=\"") {
            let tail = &rest[i + 12..];
            let id = &tail[..tail.find('"').unwrap_or(0)];
            if !ids.iter().any(|x| x == id) {
                ids.push(id.to_string());
            }
            rest = tail;
        }
    }
    ids.sort();
    let mut ours: Vec<String> = ThemeName::ALL.iter().map(|t| t.id().to_string()).collect();
    ours.sort();
    if ids != ours {
        problems.push(format!("data-theme ids {ids:?} vs the crate's {ours:?}"));
    }
    problems
}

#[test]
fn globals_css_matches_the_crate() {
    let problems = globals_mismatches(&read("../../../app/globals.css"));
    assert!(
        problems.is_empty(),
        "app/globals.css drifted from claudius-theme:\n{}",
        problems.join("\n")
    );
}

#[test]
fn the_globals_check_catches_changes() {
    let css = read("../../../app/globals.css");
    let edits = [
        ("--accent: #d97757;", "--accent: #d97758;"),
        ("--series-3: #1baf7a;", "--series-3: #1baf7b;"),
        ("--border: #4a2d7a;", "--border: #4a2d7a;\n  --ring: #fff;"),
        (
            "--chat-col: clamp(60rem, 32rem + 30vw, 96rem);",
            "--chat-col: clamp(60rem, 30rem + 30vw, 96rem);",
        ),
        ("@media (min-width: 1536px)", "@media (min-width: 1600px)"),
        (
            ":root[data-theme=\"paper\"] {",
            ":root[data-theme=\"paper\"], :root[data-theme=\"sepia\"] {",
        ),
        (
            "background: rgba(217, 119, 87, 0.35);",
            "background: rgba(217, 119, 87, 0.3);",
        ),
        (
            "* {\n  border-color: var(--border);\n}",
            "@layer base { * { border-color: var(--border); } }",
        ),
        ("--titlebar-height: 32px;", "--titlebar-height: 28px;"),
        ("\"Segoe UI\", Roboto", "Roboto"),
    ];
    for (from, to) in edits {
        assert_eq!(
            css.matches(from).count(),
            1,
            "{from:?} should be in globals.css once"
        );
        let changed = css.replacen(from, to, 1);
        assert!(
            !globals_mismatches(&changed).is_empty(),
            "editing {from:?} went unnoticed"
        );
    }
}

fn theme_css_mismatches(theme_css: &str, preflight: &str) -> Vec<String> {
    let rules = parse(theme_css);
    let block = |prelude: &str| {
        rules
            .iter()
            .find(|r| r.prelude == prelude && r.context.is_empty())
            .unwrap_or_else(|| panic!("no {prelude}"))
    };
    let defaults = block("@theme default");
    let reference = block("@theme default inline reference");
    let get = |name: &str| {
        defaults
            .decls
            .iter()
            .find(|(n, _)| n == name)
            .map(|(_, v)| v.as_str())
    };
    let mut want: Vec<(String, String)> = vec![
        (
            tailwind::SPACING.name.into(),
            tailwind::SPACING.source.into(),
        ),
        (
            tailwind::TRANSITION_DURATION.name.into(),
            tailwind::TRANSITION_DURATION.source.into(),
        ),
        (
            tailwind::TRANSITION_EASING.name.into(),
            tailwind::TRANSITION_EASING.source.into(),
        ),
        (
            "--default-font-family".into(),
            tailwind::DEFAULT_FONT_FAMILY_SOURCE.into(),
        ),
        (
            "--default-mono-font-family".into(),
            tailwind::DEFAULT_MONO_FONT_FAMILY_SOURCE.into(),
        ),
    ];
    for l in tailwind::CONTAINERS.iter().chain(&tailwind::RADII) {
        want.push((l.name.into(), l.source.into()));
    }
    for t in &tailwind::TEXT {
        want.push((t.size.name.into(), t.size.source.into()));
        want.push((
            format!("{}--line-height", t.size.name),
            t.line_height_source.into(),
        ));
    }
    let toks = tailwind::WEIGHTS.iter().map(|(t, _)| t);
    let toks = toks.chain(tailwind::TRACKING.iter().map(|(t, _)| t));
    let toks = toks.chain(tailwind::LEADING.iter().map(|(t, _)| t));
    for t in toks
        .chain(tailwind::BLUR.iter().map(|(t, _)| t))
        .chain(&tailwind::ANIMATIONS)
    {
        want.push((t.name.into(), t.source.into()));
    }
    for (n, src) in tailwind::COLORS {
        want.push((format!("--color-{n}"), src.into()));
    }
    let mut problems: Vec<String> = want
        .iter()
        .filter(|(n, v)| get(n) != Some(v.as_str()))
        .map(|(n, v)| format!("{n}: theme.css has {:?}, the crate {v:?}", get(n)))
        .collect();
    // Plain `rounded` reads `--radius` from the inline reference block.
    let radius = reference
        .decls
        .iter()
        .find(|(n, _)| n == "--radius")
        .map(|(_, v)| v.as_str());
    if radius != Some(&format!("{}rem", tailwind::ROUNDED_REM)) {
        problems.push(format!("--radius is {radius:?}"));
    }
    let root = parse(preflight)
        .into_iter()
        .find(|r| r.prelude == "html, :host")
        .expect("preflight html rule");
    let lh = root
        .decls
        .iter()
        .find(|(n, _)| n == "line-height")
        .map(|(_, v)| v.clone());
    if lh != Some(tailwind::ROOT_LINE_HEIGHT.to_string()) {
        problems.push(format!("preflight line-height is {lh:?}"));
    }
    problems
}

/// Whether `bun.lock` resolves `tailwindcss` to exactly `version`.
fn lock_pins_tailwind(lock: &str, version: &str) -> bool {
    lock.contains(&format!("\"tailwindcss\": [\"tailwindcss@{version}\""))
}

#[test]
fn tailwind_theme_matches_the_crate() {
    let recorded = recorded_tailwind();
    let lock = std::fs::read_to_string(path("../../../bun.lock")).ok();
    if let Some(lock) = &lock {
        assert!(
            lock_pins_tailwind(lock, &recorded),
            "bun.lock no longer resolves tailwindcss@{recorded}: re-record the golden"
        );
    }
    if !have_node_modules() {
        // The Rust CI job: no install, so the lockfile pin is the check.
        assert!(
            lock.is_some(),
            "neither node_modules nor bun.lock next to rust/"
        );
        eprintln!("no node_modules: checked the bun.lock pin (tailwindcss@{recorded}) only");
        return;
    }
    let pkg = read("../../../node_modules/tailwindcss/package.json");
    let installed: serde_json::Value = serde_json::from_str(&pkg).expect("package.json");
    assert_eq!(
        installed["version"].as_str(),
        Some(recorded.as_str()),
        "installed tailwindcss: re-record the golden"
    );
    let problems = theme_css_mismatches(&read(THEME_CSS), &read(PREFLIGHT_CSS));
    assert!(
        problems.is_empty(),
        "tailwindcss/theme.css drifted from claudius-theme:\n{}",
        problems.join("\n")
    );
}

#[test]
fn the_lock_pin_check_reads_bun_lock_lines() {
    let lock = r#"
        "tailwindcss": "^4",
    "@tailwindcss/node": ["@tailwindcss/node@4.2.4", "", { "dependencies": { "tailwindcss": "4.2.4" } }, "sha512-x"],
    "tailwindcss": ["tailwindcss@4.2.4", "", {}, "sha512-y"],
"#;
    assert!(lock_pins_tailwind(lock, "4.2.4"));
    assert!(!lock_pins_tailwind(lock, "4.2.5"));
    assert!(!lock_pins_tailwind(lock, "4.2"));
    assert!(!lock_pins_tailwind(
        &lock.replace("[\"tailwindcss@", "[\"x@"),
        "4.2.4"
    ));
}

#[test]
fn the_tailwind_check_catches_changes() {
    if !have_node_modules() {
        eprintln!("no node_modules: nothing to edit");
        return;
    }
    let theme = read(THEME_CSS);
    let preflight = read(PREFLIGHT_CSS);
    for (from, to) in [
        ("--spacing: 0.25rem;", "--spacing: 0.3rem;"),
        (
            "--color-red-400: oklch(70.4% 0.191 22.216);",
            "--color-red-400: oklch(70.5% 0.191 22.216);",
        ),
        (
            "--text-sm--line-height: calc(1.25 / 0.875);",
            "--text-sm--line-height: calc(1.3 / 0.875);",
        ),
        ("--radius: 0.25rem;", "--radius: 0.3rem;"),
    ] {
        assert_eq!(theme.matches(from).count(), 1, "{from:?}");
        assert!(
            !theme_css_mismatches(&theme.replacen(from, to, 1), &preflight).is_empty(),
            "{from:?}"
        );
    }
    let changed = preflight.replacen("line-height: 1.5;", "line-height: 1.4;", 1);
    assert!(!theme_css_mismatches(&theme, &changed).is_empty());
}
