//! Replays `fixtures/theme_golden.json`, recorded by
//! `rust/scripts/theme-golden.mjs`: what Chromium computes for
//! `app/globals.css` compiled by Tailwind's own compiler, and what the real
//! client TS (`theme.ts`, `chat-size.ts`, `prompt-colors.ts`, the layout
//! bootstrap, the `/theme` and `/color` cases) does with storage.
//!
//! Colors are compared on Chromium's own sRGB conversion
//! (`rgb(from <c> r g b / alpha)`, six significant digits from its f32
//! math) within [`TOL`], and, when opaque, on the exact 8-bit pixel it
//! paints. Lengths are compared as Chromium serializes them (`%.6g` px).

use std::collections::{BTreeSet, HashMap, HashSet};

use claudius_theme::chat::{self, ChatSize, ChatSizeStore};
use claudius_theme::client::{self, Host, StorageError, ThemeCommand};
use claudius_theme::color::{self, Rgba};
use claudius_theme::palette::{self, INLINE_COLORS, Palette, Theme, ThemeName};
use claudius_theme::prompt::{self, ColorCommand, ComposerState, PromptColor};
use claudius_theme::tailwind;
use serde_json::{Value, json};

/// The largest channel difference allowed. Chromium converts in f32 and
/// prints six significant digits: its own OKLab round trip of 9/255 reads
/// 0.0352996, and 1.0055044 prints as `1.0055`. 1e-5 covers both; 3e-6
/// doesn't.
const TOL: f64 = 1e-5;

fn fixture() -> &'static Value {
    static F: std::sync::OnceLock<Value> = std::sync::OnceLock::new();
    F.get_or_init(|| {
        let path = concat!(
            env!("CARGO_MANIFEST_DIR"),
            "/tests/fixtures/theme_golden.json"
        );
        serde_json::from_str(&std::fs::read_to_string(path).expect("fixture"))
            .expect("fixture json")
    })
}

fn s(v: &Value) -> &str {
    v.as_str().unwrap_or_else(|| panic!("not a string: {v}"))
}

/// `color(srgb r g b[ / a])` as Chromium serializes it.
fn parse_srgb(text: &str) -> [f64; 4] {
    let inner = text
        .strip_prefix("color(srgb ")
        .and_then(|t| t.strip_suffix(')'))
        .unwrap_or_else(|| panic!("{text}"));
    let (rgb, a) = inner.split_once(" / ").unwrap_or((inner, "1"));
    let c: Vec<f64> = rgb.split(' ').map(|x| x.parse().unwrap()).collect();
    [c[0], c[1], c[2], a.parse().unwrap()]
}

fn assert_srgb(what: &str, got: Rgba, chromium: &str) {
    let want = parse_srgb(chromium);
    let have = [got.r, got.g, got.b, got.a].map(f64::from);
    for i in 0..4 {
        assert!(
            (have[i] - want[i]).abs() <= TOL,
            "{what}: {have:?} vs Chromium {chromium}"
        );
    }
}

fn assert_px(what: &str, got: Rgba, px: &Value) {
    let want: Vec<u64> = px
        .as_array()
        .unwrap()
        .iter()
        .map(|v| v.as_u64().unwrap())
        .collect();
    if want[3] == 255 {
        assert_eq!(
            got.to_rgba8().map(u64::from).to_vec(),
            want,
            "{what}: painted pixel"
        );
    }
}

/// `%.6g`, as Chromium serializes a computed length.
fn fmt6(x: f64) -> String {
    if x == 0.0 {
        return "0".into();
    }
    let exp = x.abs().log10().floor() as i32;
    let trim = |t: String| {
        if t.contains('.') {
            t.trim_end_matches('0').trim_end_matches('.').to_string()
        } else {
            t
        }
    };
    if !(-4..6).contains(&exp) {
        let m = format!("{:.5e}", x);
        let (mant, e) = m.split_once('e').unwrap();
        let e: i32 = e.parse().unwrap();
        return format!(
            "{}e{}{:02}",
            trim(mant.to_string()),
            if e < 0 { '-' } else { '+' },
            e.abs()
        );
    }
    // Rounding can carry into a new digit (999999.5): re-check the exponent.
    let fixed = format!("{:.*}", (5 - exp).max(0) as usize, x);
    trim(fixed)
}

fn px(x: f64) -> String {
    format!("{}px", fmt6(x))
}

fn theme_for(key: &str) -> Theme {
    Theme::of(ThemeName::for_attribute(if key == "(none)" {
        None
    } else {
        Some(key)
    }))
}

/// The source text a palette / series / inline variable has once `var()`s
/// are substituted, for a theme.
fn var_source(name: ThemeName, var: &str) -> &'static str {
    let var = INLINE_COLORS
        .iter()
        .find(|(a, _)| *a == var)
        .map_or(var, |(_, v)| &v[4..v.len() - 1]);
    name.source()
        .entries()
        .into_iter()
        .chain(name.series_source().entries())
        .find(|(n, _)| *n == var)
        .unwrap_or_else(|| panic!("{var} not in the crate"))
        .1
}

#[test]
fn palettes_match_chromium() {
    let f = fixture();
    let themes = f["themes"].as_object().unwrap();
    assert_eq!(
        themes.len(),
        9,
        "7 themes + no attribute + an unknown value"
    );
    for (key, vars) in themes {
        let theme = theme_for(key);
        let vars = vars.as_array().unwrap();
        assert_eq!(vars.len(), 14);
        for v in vars {
            let var = s(&v["var"]);
            let what = format!("{key} {var}");
            assert_eq!(
                s(&v["value"]),
                var_source(theme.name, var),
                "{what}: source text"
            );
            let got = theme
                .palette
                .var(var)
                .unwrap_or_else(|| panic!("{what}: no such palette var"));
            assert_srgb(&what, got, s(&v["srgb"]));
            assert_px(&what, got, &v["px"]);
        }
    }
}

#[test]
fn theme_previews_and_labels_match_the_ts() {
    let list = fixture()["client"]["theme"]["themes"].as_array().unwrap();
    let ids: Vec<&str> = list.iter().map(|t| s(&t["id"])).collect();
    assert_eq!(ids, ThemeName::ALL.map(ThemeName::id));
    for (t, name) in list.iter().zip(ThemeName::ALL) {
        assert_eq!(s(&t["label"]), name.label());
        let (bg, accent) = name.preview();
        assert_eq!(
            (s(&t["preview"]["bg"]), s(&t["preview"]["accent"])),
            (bg, accent),
            "{}",
            name.id()
        );
    }
}

#[test]
fn tailwind_colors_match_chromium() {
    let f = fixture();
    let got: Vec<&str> = f["tailwindColors"]
        .as_array()
        .unwrap()
        .iter()
        .map(|c| s(&c["var"]))
        .collect();
    let ours: Vec<String> = tailwind::COLORS
        .iter()
        .map(|(n, _)| format!("--color-{n}"))
        .collect();
    assert_eq!(got, ours, "the palette colors the UI uses");
    let mut out_of_gamut = 0;
    for (c, (name, source)) in f["tailwindColors"]
        .as_array()
        .unwrap()
        .iter()
        .zip(tailwind::COLORS)
    {
        assert_eq!(s(&c["value"]), source, "{name}");
        let rgba = tailwind::color(name).unwrap();
        assert_srgb(name, rgba, s(&c["srgb"]));
        assert_px(name, rgba, &c["px"]);
        out_of_gamut += usize::from(!rgba.in_gamut());
    }
    assert!(
        out_of_gamut > 10,
        "the clip in to_rgba8 is exercised ({out_of_gamut})"
    );
}

fn mix_target(theme: &Theme, var: &str) -> Rgba {
    theme
        .palette
        .var(var)
        .or_else(|| var.strip_prefix("--color-").and_then(tailwind::color))
        .unwrap_or_else(|| panic!("{var}: not a crate color"))
}

#[test]
fn opacity_mixes_match_chromium() {
    let f = fixture();
    let mixes = f["mixes"].as_array().unwrap();
    let mut seen = 0;
    for m in mixes {
        let theme = Theme::of(ThemeName::from_id(s(&m["theme"])).unwrap());
        let expr = s(&m["expr"]);
        let what = format!("{} {expr}", theme.name.id());
        let got = if expr == palette::SCROLLBAR_THUMB_HOVER {
            theme.scrollbar_thumb_hover
        } else {
            let rest = expr.strip_prefix("color-mix(in oklab, var(").unwrap();
            let (var, rest) = rest.split_once(") ").unwrap();
            let pct: f64 = rest
                .strip_suffix("%, transparent)")
                .unwrap()
                .parse()
                .unwrap();
            color::with_opacity(mix_target(&theme, var), pct)
        };
        assert_srgb(&what, got, s(&m["srgb"]));
        assert_px(&what, got, &m["px"]);
        seen += 1;
    }
    assert_eq!(seen, 7 * (mixes.len() / 7));
    assert!(
        mixes
            .iter()
            .any(|m| s(&m["expr"]) == palette::SCROLLBAR_THUMB_HOVER)
    );
}

/// Splits `a, b` at its top-level comma.
fn split_top(s: &str) -> (&str, &str) {
    let mut depth = 0;
    for (i, c) in s.char_indices() {
        match c {
            '(' => depth += 1,
            ')' => depth -= 1,
            ',' if depth == 0 => return (s[..i].trim(), s[i + 1..].trim()),
            _ => {}
        }
    }
    panic!("no comma in {s}");
}

#[test]
fn general_mixes_match_chromium() {
    let f = fixture();
    let theme = Theme::of(ThemeName::Dark);
    let rows = f["extraMixes"].as_array().unwrap();
    assert!(rows.len() >= 8);
    for m in rows {
        let expr = s(&m["expr"]);
        let inner = expr
            .strip_prefix("color-mix(in oklab, ")
            .and_then(|e| e.strip_suffix(')'))
            .unwrap();
        let (a, b) = split_top(inner);
        let side = |t: &str| {
            let (c, pct) = t.rsplit_once(' ').unwrap();
            let pct: f64 = pct.strip_suffix('%').unwrap().parse().unwrap();
            let c = match c.strip_prefix("var(").and_then(|v| v.strip_suffix(')')) {
                Some(var) => mix_target(&theme, var),
                None => color::parse(c).unwrap(),
            };
            (c, pct)
        };
        let ((ca, pa), (cb, pb)) = (side(a), side(b));
        let got = color::mix_oklab(ca, pa, cb, pb).unwrap();
        assert_srgb(expr, got, s(&m["srgb"]));
        assert_px(expr, got, &m["px"]);
    }
    // Both at 0% is invalid CSS (no Chromium value to record).
    assert_eq!(
        color::mix_oklab(theme.palette.accent, 0.0, theme.palette.panel, 0.0),
        None
    );
    assert_eq!(
        color::with_opacity(theme.palette.accent, 100.0),
        theme.palette.accent
    );
}

#[test]
fn color_literals_match_chromium() {
    for l in fixture()["literals"].as_array().unwrap() {
        let text = s(&l["text"]);
        let parsed = color::parse(text);
        // A named color and oklab() are valid CSS but no token uses them.
        if !l["valid"].as_bool().unwrap() || text == "red" || text.starts_with("oklab(") {
            assert_eq!(parsed, None, "{text}");
            continue;
        }
        let got = parsed.unwrap_or_else(|| panic!("{text}: Chromium takes it"));
        assert_srgb(text, got, s(&l["srgb"]));
        assert_px(text, got, &l["px"]);
    }
}

#[test]
fn composer_frame_matches_chromium() {
    let f = fixture();
    let rows = f["composer"].as_array().unwrap();
    assert_eq!(rows.len(), 7 * 24);
    for r in rows {
        let theme = Theme::of(ThemeName::from_id(s(&r["theme"])).unwrap());
        let prompt_color = r["promptColor"].as_str().map(|hex| {
            PromptColor::ALL
                .into_iter()
                .find(|c| c.hex() == hex)
                .expect("a prompt color")
        });
        let state = ComposerState {
            prompt_color,
            wide_drop_target: r["wideDropTarget"].as_bool().unwrap(),
            drag_over: r["dragOver"].as_bool().unwrap(),
            bash_mode: r["isBashMode"].as_bool().unwrap(),
            focused: r["focusWithin"].as_bool().unwrap(),
        };
        assert_eq!(r["focus"], r["focusWithin"], "the probe's focus took");
        let what = format!("{} {state:?}", theme.name.id());
        assert_eq!(
            prompt::inline_border(&state).map(PromptColor::hex),
            r["inline"].as_str(),
            "{what}"
        );
        let frame = prompt::composer_frame(&theme, &state);
        assert_srgb(&format!("{what} border"), frame.border, s(&r["borderSrgb"]));
        assert_srgb(
            &format!("{what} background"),
            frame.background,
            s(&r["backgroundSrgb"]),
        );
    }
}

#[test]
fn chrome_colors_match_chromium() {
    let f = fixture();
    for (key, c) in f["chrome"].as_object().unwrap() {
        let theme = theme_for(key);
        for b in c["borders"].as_array().unwrap() {
            assert_srgb(
                &format!("{key} {}", s(&b["class"])),
                theme.border_color(None),
                s(&b["srgb"]),
            );
        }
        assert_srgb(
            &format!("{key} ::selection"),
            theme.selection,
            s(&c["selection"]["srgb"]),
        );
        assert_eq!(s(&c["titlebar"]), px(palette::TITLEBAR_HEIGHT_PX));
        assert_eq!(
            s(&c["titlebarElectron"]),
            px(palette::TITLEBAR_HEIGHT_ELECTRON_PX)
        );
        assert_eq!(
            s(&c["bodyPaddingElectron"]),
            px(palette::TITLEBAR_HEIGHT_ELECTRON_PX)
        );
    }
    // The inline color is the only way to change a border.
    let t = Theme::of(ThemeName::Paper);
    assert_eq!(
        t.border_color(Some(PromptColor::Red.rgba())),
        PromptColor::Red.rgba()
    );
}

/// Chromium's `font-family` serialization: a name that isn't one CSS
/// identifier is quoted.
fn families(list: &[&str]) -> String {
    let ident = |n: &str| {
        n.chars()
            .all(|c| c.is_ascii_alphanumeric() || c == '-' || c == '_')
            && !n.starts_with(|c: char| c.is_ascii_digit())
    };
    list.iter()
        .map(|n| {
            if ident(n) {
                n.to_string()
            } else {
                format!("\"{n}\"")
            }
        })
        .collect::<Vec<_>>()
        .join(", ")
}

/// Every non-color theme variable the crate ports, with its source text as
/// Chromium reads it once `var()` is substituted.
fn crate_tokens() -> Vec<(String, String)> {
    let next_font = |names: [&str; 2]| {
        names
            .iter()
            .map(|n| format!("\"{n}\""))
            .collect::<Vec<_>>()
            .join(", ")
    };
    let mut t: Vec<(String, String)> = vec![
        ("--font-sans".into(), next_font(tailwind::FONT_SANS)),
        ("--font-mono".into(), next_font(tailwind::FONT_MONO)),
        (
            "--default-font-family".into(),
            next_font(tailwind::FONT_SANS),
        ),
        (
            "--default-mono-font-family".into(),
            next_font(tailwind::FONT_MONO),
        ),
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
    ];
    for l in tailwind::CONTAINERS.iter().chain(&tailwind::RADII) {
        t.push((l.name.into(), l.source.into()));
    }
    for x in &tailwind::TEXT {
        t.push((x.size.name.into(), x.size.source.into()));
        t.push((
            format!("{}--line-height", x.size.name),
            x.line_height_source.into(),
        ));
    }
    let toks = tailwind::WEIGHTS.iter().map(|(t, _)| t);
    let toks = toks.chain(tailwind::TRACKING.iter().map(|(t, _)| t));
    let toks = toks.chain(tailwind::LEADING.iter().map(|(t, _)| t));
    let toks = toks
        .chain(tailwind::BLUR.iter().map(|(t, _)| t))
        .chain(&tailwind::ANIMATIONS);
    for tok in toks {
        t.push((tok.name.into(), tok.source.into()));
    }
    t
}

#[test]
fn the_crate_ports_exactly_the_theme_vars_the_ui_uses() {
    let f = fixture();
    let used: BTreeSet<&str> = f["themeVars"].as_array().unwrap().iter().map(s).collect();
    let mut ours: BTreeSet<String> = crate_tokens().into_iter().map(|(n, _)| n).collect();
    ours.extend(tailwind::COLORS.iter().map(|(n, _)| format!("--color-{n}")));
    // `@theme inline`'s `--color-*` aliases are absent: no utility the UI
    // writes uses them (it writes `bg-[var(--panel)]`), so Tailwind emits none.
    assert!(INLINE_COLORS.iter().all(|(n, _)| !used.contains(n)));
    let ours: BTreeSet<&str> = ours.iter().map(String::as_str).collect();
    assert_eq!(
        used, ours,
        "a re-recorded fixture shows the UI now uses a different token set"
    );
    let raw = f["lengths"]["raw"].as_object().unwrap();
    for (name, source) in crate_tokens() {
        assert_eq!(s(&raw[&name]), source, "{name}");
    }
}

#[test]
fn lengths_match_chromium() {
    let l = &fixture()["lengths"];
    let len = l["len"].as_object().unwrap();
    assert_eq!(s(&len["--spacing"]), px(tailwind::SPACING.px()));
    for x in tailwind::CONTAINERS.iter().chain(&tailwind::RADII) {
        assert_eq!(s(&len[x.name]), px(x.px()), "{}", x.name);
    }
    for (tok, v) in &tailwind::BLUR {
        assert_eq!(s(&len[tok.name]), px(*v), "{}", tok.name);
    }
    let text = l["text"].as_array().unwrap();
    assert_eq!(text.len(), tailwind::TEXT.len());
    for (r, x) in text.iter().zip(&tailwind::TEXT) {
        assert_eq!(s(&r["size"]), x.name);
        assert_eq!(s(&r["fontSize"]), px(x.size_px()), "text-{}", x.name);
        assert_eq!(
            s(&r["lineHeight"]),
            px(x.line_height_px()),
            "text-{} line height",
            x.name
        );
        assert_eq!(
            x.line_height_source,
            format!("calc({} / {})", x.line_height.0, x.line_height.1)
        );
        assert_eq!(x.size.source, format!("{}rem", x.size.rem));
    }
    for (r, (tok, w)) in l["weights"]
        .as_array()
        .unwrap()
        .iter()
        .zip(&tailwind::WEIGHTS)
    {
        assert_eq!(
            (s(&r["var"]), s(&r["computed"])),
            (tok.name, w.to_string().as_str())
        );
        assert_eq!(tok.source, w.to_string());
    }
    for (r, (tok, em)) in l["tracking"]
        .as_array()
        .unwrap()
        .iter()
        .zip(&tailwind::TRACKING)
    {
        let want = if *em == 0.0 {
            "normal".to_string()
        } else {
            px(em * 16.0)
        };
        assert_eq!((s(&r["var"]), s(&r["computed"])), (tok.name, want.as_str()));
        assert_eq!(tok.source, format!("{em}em"));
    }
    for (r, (tok, ratio)) in l["leading"]
        .as_array()
        .unwrap()
        .iter()
        .zip(&tailwind::LEADING)
    {
        assert_eq!(
            (s(&r["var"]), s(&r["computed"])),
            (tok.name, px(ratio * 16.0).as_str())
        );
        assert_eq!(tok.source, ratio.to_string());
    }
    let steps = l["spacing"].as_array().unwrap();
    assert!(steps.len() > 40);
    for r in steps {
        let step = r["step"].as_f64().unwrap();
        assert_eq!(
            s(&r["computed"]),
            px(tailwind::spacing_px(step)),
            "step {step}"
        );
    }
    let radii: HashMap<&str, &str> = l["radii"]
        .as_array()
        .unwrap()
        .iter()
        .map(|r| (s(&r["class"]), s(&r["computed"])))
        .collect();
    assert_eq!(radii["rounded"], px(tailwind::ROUNDED_REM * 16.0));
    assert_eq!(radii["rounded-none"], "0px");
    for (class, r) in ["sm", "md", "lg", "xl", "2xl"].iter().zip(&tailwind::RADII) {
        assert_eq!(radii[format!("rounded-{class}").as_str()], px(r.px()));
    }
    // `calc(infinity * 1px)`: Chromium clamps it to its largest length.
    let full: f64 = radii["rounded-full"]
        .strip_suffix("px")
        .unwrap()
        .parse()
        .unwrap();
    assert!(full > 1e7 && tailwind::ROUNDED_FULL_PX.is_infinite());
    assert_eq!(
        tailwind::TRANSITION_DURATION.source,
        format!("{}ms", tailwind::TRANSITION_DURATION_MS)
    );
    let b = tailwind::TRANSITION_EASING_BEZIER;
    assert_eq!(
        tailwind::TRANSITION_EASING.source,
        format!("cubic-bezier({}, {}, {}, {})", b[0], b[1], b[2], b[3])
    );
    assert_eq!(s(&l["rootFont"]["fontSize"]), px(tailwind::REM_PX));
    assert_eq!(
        s(&l["rootFont"]["lineHeight"]),
        px(tailwind::REM_PX * tailwind::ROOT_LINE_HEIGHT)
    );
}

#[test]
fn font_stacks_match_chromium() {
    let fonts = &fixture()["lengths"]["fonts"];
    assert_eq!(s(&fonts["html"]), families(&tailwind::FONT_SANS));
    assert_eq!(s(&fonts["sans"]), families(&tailwind::FONT_SANS));
    assert_eq!(s(&fonts["body"]), families(&tailwind::body_font_family()));
    assert_eq!(s(&fonts["mono"]), families(&tailwind::FONT_MONO));
    assert_eq!(s(&fonts["code"]), families(&tailwind::FONT_MONO));
    assert_eq!(s(&fonts["shiki"]), families(&tailwind::code_font_family()));
}

#[test]
fn chat_column_matches_chromium() {
    let rows = fixture()["chatColumn"].as_array().unwrap();
    assert!(
        rows.iter().any(|r| r["viewport"] == 1535) && rows.iter().any(|r| r["viewport"] == 1536)
    );
    for r in rows {
        let w = r["viewport"].as_f64().unwrap();
        assert_eq!(r["innerWidth"], r["viewport"]);
        let (col, text) = chat::chat_column(w);
        assert_eq!(
            (s(&r["col"]), s(&r["text"])),
            (px(col).as_str(), px(text).as_str()),
            "viewport {w}"
        );
        // An override wins at every width; an unset one leaves the stylesheet's.
        let size = ChatSize {
            col_rem: Some(40.5),
            text_px: None,
        };
        assert_eq!(chat::chat_column_with(w, size), (648.0, text));
        assert_eq!(
            chat::chat_column_with(
                w,
                ChatSize {
                    col_rem: None,
                    text_px: Some(20.0)
                }
            ),
            (col, 20.0)
        );
    }
    assert_eq!(
        chat::CHAT_COL_FLUID.source(),
        "clamp(60rem, 32rem + 30vw, 96rem)"
    );
    assert_eq!(
        chat::CHAT_TEXT_FLUID.source(),
        "clamp(1.0625rem, 0.6rem + 0.5vw, 1.75rem)"
    );
}

// ------------------------------- client -------------------------------

/// The recorder's stub browser: storage that throws for the listed keys
/// (`*` for every call, `set:<key>` for that write), a call log in the same
/// shape, and `documentElement.dataset`.
#[derive(Default)]
struct LogHost {
    store: HashMap<String, String>,
    throws: HashSet<String>,
    log: Vec<Value>,
    dataset: HashMap<String, String>,
}

impl LogHost {
    fn new(values: &[(&str, &Value)], throws: &Value) -> LogHost {
        let mut h = LogHost::default();
        for (k, v) in values {
            if let Some(v) = v.as_str() {
                h.store.insert(k.to_string(), v.to_string());
            }
        }
        h.throws = throws.as_array().map_or_else(HashSet::new, |a| {
            a.iter().map(|t| s(t).to_string()).collect()
        });
        h
    }
}

impl Host for LogHost {
    fn get_item(&mut self, key: &str) -> Result<Option<String>, StorageError> {
        if self.throws.contains(key) || self.throws.contains("*") {
            return Err(StorageError);
        }
        self.log.push(json!(["getItem", key]));
        Ok(self.store.get(key).cloned())
    }
    fn set_item(&mut self, key: &str, value: &str) -> Result<(), StorageError> {
        if self.throws.contains(&format!("set:{key}")) || self.throws.contains("*") {
            return Err(StorageError);
        }
        self.log.push(json!(["setItem", key, value]));
        self.store.insert(key.into(), value.into());
        Ok(())
    }
    fn remove_item(&mut self, key: &str) -> Result<(), StorageError> {
        if self.throws.contains(&format!("remove:{key}")) || self.throws.contains("*") {
            return Err(StorageError);
        }
        self.log.push(json!(["removeItem", key]));
        self.store.remove(key);
        Ok(())
    }
    fn set_dataset(&mut self, key: &str, value: &str) {
        self.dataset.insert(key.into(), value.into());
    }
    fn set_style_property(&mut self, name: &str, value: &str) {
        self.log.push(json!(["setProperty", name, value]));
    }
    fn remove_style_property(&mut self, name: &str) {
        self.log.push(json!(["removeProperty", name]));
    }
    fn dispatch_event(&mut self, name: &str) {
        self.log.push(json!(["dispatchEvent", name]));
    }
}

fn opt_str(v: &Value) -> Option<&str> {
    v.as_str()
}

fn num(v: &Value) -> f64 {
    match v.get("$num").and_then(Value::as_str) {
        Some("NaN") => f64::NAN,
        Some("Infinity") => f64::INFINITY,
        Some("-Infinity") => f64::NEG_INFINITY,
        Some("-0") => -0.0,
        Some(other) => panic!("{other}"),
        None => v.as_f64().unwrap(),
    }
}

/// `{colRem, textPx}` with JS number text (`36`, not `36.0`).
fn size_json(size: ChatSize) -> Value {
    let n = |v: Option<f64>| match v {
        Some(x) if x.fract() == 0.0 => json!(x as i64),
        Some(x) => json!(x),
        None => Value::Null,
    };
    json!({ "colRem": n(size.col_rem), "textPx": n(size.text_px) })
}

#[test]
fn theme_storage_matches_the_ts() {
    let t = &fixture()["client"]["theme"];
    assert_eq!(s(&t["storageKey"]), client::THEME_STORAGE_KEY);
    assert_eq!(s(&t["default"]), ThemeName::DEFAULT.id());
    assert_eq!(s(&t["sameTabEvent"]), client::THEME_CHANGED_EVENT);
    assert_eq!(s(&t["readNoWindow"]), ThemeName::DEFAULT.id());
    assert_eq!(s(&t["ssr"]), ThemeName::DEFAULT.id());
    for r in t["read"].as_array().unwrap() {
        let mut h = LogHost::new(&[(client::THEME_STORAGE_KEY, &r["saved"])], &Value::Null);
        assert_eq!(
            client::read_theme(&mut h).id(),
            s(&r["out"]),
            "saved {}",
            r["saved"]
        );
    }
    let mut h = LogHost::new(&[], &json!(["*"]));
    assert_eq!(client::read_theme(&mut h).id(), s(&t["readThrows"]));
    for r in t["apply"].as_array().unwrap() {
        let mut h = LogHost::default();
        client::apply_theme(&mut h, s(&r["id"]));
        assert_eq!(
            h.dataset.get("theme").map(String::as_str),
            opt_str(&r["dataTheme"])
        );
    }
    assert!(t["applyNoDocument"].is_null());
    let want: Vec<Value> = client::THEME_SUBSCRIBE_EVENTS
        .iter()
        .map(|e| json!(["addEventListener", e]))
        .chain(
            client::THEME_SUBSCRIBE_EVENTS
                .iter()
                .map(|e| json!(["removeEventListener", e])),
        )
        .collect();
    assert_eq!(t["subscribe"].as_array().unwrap(), &want);
    for r in t["set"].as_array().unwrap() {
        let mut h = LogHost::new(&[], &r["throws"]);
        client::set_theme(&mut h, s(&r["id"]));
        assert_eq!(&Value::Array(h.log), &r["log"], "setTheme {}", r["id"]);
    }
}

#[test]
fn layout_bootstrap_matches_the_ts() {
    let rows = fixture()["client"]["bootstrap"].as_array().unwrap();
    assert!(rows.len() > 50);
    for r in rows {
        let mut h = LogHost::new(
            &[
                (client::THEME_STORAGE_KEY, &r["theme"]),
                (chat::COL_KEY, &r["col"]),
                (chat::TEXT_KEY, &r["text"]),
            ],
            &r["throws"],
        );
        client::bootstrap(&mut h, s(&r["ua"]));
        let what = format!("{r}");
        assert_eq!(
            h.dataset.get("theme").map(String::as_str),
            opt_str(&r["dataTheme"]),
            "{what}"
        );
        assert_eq!(
            h.dataset.get("electron").map(String::as_str),
            opt_str(&r["electron"]),
            "{what}"
        );
        assert_eq!(&Value::Array(h.log), &r["log"], "{what}");
    }
    // A prototype name passes the bootstrap but shows the dark values.
    assert_eq!(client::bootstrap_theme_attr(Some("toString")), "toString");
    assert_eq!(ThemeName::for_attribute(Some("toString")), ThemeName::Dark);
}

#[test]
fn js_number_readings_match_node() {
    let rows = fixture()["client"]["numbers"].as_array().unwrap();
    assert!(rows.len() > 50);
    let same = |a: f64, b: f64| {
        (a.is_nan() && b.is_nan()) || (a == b && a.is_sign_negative() == b.is_sign_negative())
    };
    for r in rows {
        let text = s(&r["in"]);
        let (n, p) = (
            claudius_theme::js::to_number(text),
            claudius_theme::js::parse_float(text),
        );
        assert!(
            same(n, num(&r["number"])),
            "Number({text:?}) = {n}, node {}",
            r["number"]
        );
        assert!(
            same(p, num(&r["parseFloat"])),
            "parseFloat({text:?}) = {p}, node {}",
            r["parseFloat"]
        );
    }
}

#[test]
fn chat_size_matches_the_ts() {
    let c = &fixture()["client"]["chatSize"];
    let b = &c["bounds"];
    assert_eq!(
        [
            b["colMinRem"].as_f64(),
            b["colMaxRem"].as_f64(),
            b["textMinPx"].as_f64(),
            b["textMaxPx"].as_f64()
        ],
        [
            Some(chat::COL_MIN_REM),
            Some(chat::COL_MAX_REM),
            Some(chat::TEXT_MIN_PX),
            Some(chat::TEXT_MAX_PX)
        ]
    );
    assert_eq!(
        c["keys"],
        json!([chat::COL_KEY, chat::TEXT_KEY, chat::CHAT_SIZE_CHANGED_EVENT])
    );
    for (key, f) in [
        ("clampCol", chat::clamp_col as fn(f64) -> f64),
        ("clampText", chat::clamp_text),
    ] {
        for r in c[key].as_array().unwrap() {
            let got = f(num(&r["in"]));
            let want = num(&r["out"]);
            assert!(
                got == want && got.is_sign_negative() == want.is_sign_negative(),
                "{key}({}) = {got}",
                r["in"]
            );
        }
    }
    assert_eq!(c["readNoWindow"], size_json(ChatSize::default()));
    assert_eq!(c["ssr"], size_json(ChatSize::default()));
    for r in c["read"].as_array().unwrap() {
        let mut h = LogHost::new(
            &[(chat::COL_KEY, &r["saved"]), (chat::TEXT_KEY, &r["saved"])],
            &Value::Null,
        );
        assert_eq!(
            size_json(chat::read_chat_size(&mut h)),
            r["out"],
            "saved {}",
            r["saved"]
        );
    }
    for r in c["readThrows"].as_array().unwrap() {
        let mut h = LogHost::new(
            &[
                (chat::COL_KEY, &json!("50")),
                (chat::TEXT_KEY, &json!("20")),
            ],
            &r["throws"],
        );
        assert_eq!(
            size_json(chat::read_chat_size(&mut h)),
            r["out"],
            "throws {}",
            r["throws"]
        );
    }
    let mut store = ChatSizeStore::default();
    for r in c["snapshots"].as_array().unwrap() {
        let mut h = LogHost::new(
            &[(chat::COL_KEY, &r["col"]), (chat::TEXT_KEY, &r["text"])],
            &Value::Null,
        );
        let (size, same) = store.get_snapshot(&mut h);
        assert_eq!(
            (size_json(size), Value::Bool(same)),
            (r["out"].clone(), r["same"].clone()),
            "{r}"
        );
    }
    for r in c["apply"].as_array().unwrap() {
        let size = ChatSize {
            col_rem: r["size"]["colRem"].as_f64(),
            text_px: r["size"]["textPx"].as_f64(),
        };
        let mut h = LogHost::default();
        chat::apply_chat_size(&mut h, size);
        assert_eq!(&Value::Array(h.log), &r["log"], "{size:?}");
    }
    for r in c["set"].as_array().unwrap() {
        let mut h = LogHost::new(
            &[
                (chat::COL_KEY, &json!("50")),
                (chat::TEXT_KEY, &json!("20")),
            ],
            &r["throws"],
        );
        match s(&r["op"]) {
            "setColRem" => chat::set_col_rem(&mut h, num(&r["arg"])),
            "setTextPx" => chat::set_text_px(&mut h, num(&r["arg"])),
            _ => chat::reset_chat_size(&mut h),
        }
        assert_eq!(&Value::Array(h.log), &r["log"], "{r}");
    }
}

#[test]
fn prompt_colors_match_the_ts() {
    let p = &fixture()["client"]["promptColors"];
    let colors = p["colors"].as_object().unwrap();
    let ours: Vec<(&str, &str)> = PromptColor::ALL
        .iter()
        .map(|c| (c.name(), c.hex()))
        .collect();
    let theirs: Vec<(&str, &str)> = colors.iter().map(|(k, v)| (k.as_str(), s(v))).collect();
    assert_eq!(theirs, ours);
    assert_eq!(p["names"], json!(PromptColor::ALL.map(PromptColor::name)));
    assert_eq!(p["resetWords"], json!(prompt::RESET_WORDS));
    for r in p["isName"].as_array().unwrap() {
        assert_eq!(
            PromptColor::from_name(s(&r["in"])).is_some(),
            r["out"].as_bool().unwrap(),
            "{}",
            r["in"]
        );
    }
    for r in p["resolve"].as_array().unwrap() {
        assert_eq!(
            prompt::resolve_prompt_color(opt_str(&r["in"])),
            opt_str(&r["out"]),
            "{}",
            r["in"]
        );
    }
}

#[test]
fn slash_theme_and_color_match_the_ts() {
    let rows = fixture()["client"]["slash"].as_array().unwrap();
    for r in rows {
        let what = format!("{r}");
        if r["error"].is_null() {
            assert_eq!(r["handled"], true, "{what}");
        }
        let mut h = LogHost::new(&[], &r["throws"]);
        let args = s(&r["args"]);
        let calls: Value = if s(&r["cmd"]) == "theme" {
            match client::theme_command(&mut h, args) {
                Ok(ThemeCommand::Applied { toast, .. }) => json!([["toast", toast]]),
                Ok(ThemeCommand::OpenSettings) => json!([["push", "/settings"]]),
                Err(StorageError) => {
                    assert!(r["error"].is_string(), "{what}");
                    Value::Null
                }
            }
        } else {
            let session = if r.get("sessionId").is_some() {
                opt_str(&r["sessionId"])
            } else {
                Some("s-1")
            };
            let current = r["current"]
                .as_str()
                .map(|n| PromptColor::from_name(n).unwrap());
            let random = r["random"].as_f64().unwrap_or(0.0);
            match prompt::color_command(session, args, current, random) {
                ColorCommand::NoSession { toast } | ColorCommand::Unknown { toast } => {
                    json!([["toast", toast]])
                }
                ColorCommand::Set {
                    session_id,
                    color,
                    url,
                    body,
                    toast,
                } => json!([
                    ["setPromptColor", { "sessionId": session_id, "name": color.map(PromptColor::name) }],
                    ["fetch", url, "POST", { "content-type": "application/json" }, body],
                    ["toast", toast],
                ]),
            }
        };
        if !calls.is_null() {
            assert_eq!(calls, r["calls"], "{what}");
        }
        assert_eq!(&Value::Array(h.log), &r["log"], "{what}");
        assert_eq!(
            h.dataset.get("theme").map(String::as_str),
            opt_str(&r["dataTheme"]),
            "{what}"
        );
    }
    let random_rows = rows
        .iter()
        .filter(|r| s(&r["cmd"]) == "color" && r.get("random").is_some())
        .count();
    assert!(random_rows >= 24);
}

/// ChatSurface's `promptColor` state (inline React state, read from the
/// source rather than recorded): per-session, and the bind-load never
/// overwrites a `/color` set mid-flight.
#[test]
fn prompt_color_state_follows_chat_surface() {
    use claudius_theme::prompt::PromptColorState;
    let mut st = PromptColorState::default();
    assert_eq!(st.active(Some("a")), None);
    assert_eq!(st.active(None), None);
    st.loaded("a", true, Some("pink"));
    assert_eq!(st.active(Some("a")), Some(PromptColor::Pink));
    assert_eq!(
        st.active(Some("b")),
        None,
        "another tab shows the default at once"
    );
    // Switching to b: its load lands.
    st.loaded("b", true, Some("RED"));
    assert_eq!(st.active(Some("b")), None, "only an exact palette name");
    st.loaded("c", true, Some("blue"));
    // The user runs /color on c, then c's (stale) load reply lands.
    st.set("c", Some(PromptColor::Green));
    st.loaded("c", true, Some("blue"));
    assert_eq!(st.active(Some("c")), Some(PromptColor::Green));
    // A non-2xx reply clears; a cleared /color is a color of None.
    st.loaded("d", false, Some("blue"));
    assert_eq!(
        st,
        PromptColorState {
            session_id: Some("d".into()),
            color: None
        }
    );
    st.set("d", None);
    assert_eq!(st.active(Some("d")), None);
    st.loaded("e", true, None);
    assert_eq!(st.session_id.as_deref(), Some("e"));
}

#[test]
fn palette_struct_covers_every_var() {
    // Every palette field is reachable by name, and the inline aliases
    // resolve to the same colors.
    for name in ThemeName::ALL {
        let p = Palette::of(name);
        for (alias, target) in INLINE_COLORS {
            assert_eq!(p.var(alias), p.var(&target[4..target.len() - 1]), "{alias}");
        }
        assert_eq!(p.var("--nope"), None);
        assert_eq!(Theme::of(name).is_dark(), name.is_dark());
    }
}
