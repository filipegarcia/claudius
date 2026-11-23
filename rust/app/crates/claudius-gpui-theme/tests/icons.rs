//! The React icon set → GPUI Kit icons. The drift checks read the React
//! tree (`components/`, `app/`, `lib/`) and lucide-react from the repo root
//! when they are there (not on a checkout without node_modules).

use std::{
    collections::{BTreeMap, BTreeSet},
    fs,
    path::{Path, PathBuf},
    sync::Arc,
};

use claudius_gpui_theme::icons::{ICONS, IconAssets, REACT_DRAWINGS, catalog_drawing, icon};
use gpui_kit::{AssetSource, SvgRenderer, assets::IconName};

/// The repo root (`CLAUDIUS_DRIFT_ROOT` overrides it, to simulate a checkout
/// without node_modules).
fn repo_root() -> PathBuf {
    std::env::var_os("CLAUDIUS_DRIFT_ROOT")
        .map(PathBuf::from)
        .unwrap_or_else(|| Path::new(env!("CARGO_MANIFEST_DIR")).join("../../../.."))
}

/// The catalog's SVG for a path, without the vendored drawings.
fn catalog(path: &str) -> String {
    let bytes = catalog_drawing(path)
        .unwrap()
        .unwrap_or_else(|| panic!("{path} is not in the catalog"));
    String::from_utf8(bytes.into_owned()).unwrap()
}

fn svg(name: IconName) -> String {
    let bytes = IconAssets
        .load(&name.path())
        .unwrap()
        .unwrap_or_else(|| panic!("{name:?} is not served"));
    String::from_utf8(bytes.into_owned()).unwrap()
}

#[test]
fn the_table_is_sorted_and_unique() {
    for w in ICONS.windows(2) {
        assert!(w[0].0 < w[1].0, "{} then {}", w[0].0, w[1].0);
    }
}

#[test]
fn every_icon_is_served() {
    for (react, name) in ICONS {
        let s = svg(name);
        assert!(
            s.contains("<svg") && s.contains("stroke=\"currentColor\""),
            "{react}"
        );
    }
    let distinct: BTreeSet<_> = ICONS.iter().map(|(_, n)| n.path()).collect();
    assert_eq!(distinct.len(), 178);
}

#[test]
fn lookups_follow_lucide_react_s_aliases() {
    assert_eq!(icon("Loader2"), Some(IconName::LoaderCircle));
    assert_eq!(icon("AlertTriangle"), Some(IconName::TriangleAlert));
    assert_eq!(icon("TriangleAlert"), Some(IconName::TriangleAlert));
    assert_eq!(icon("History"), Some(IconName::RotateCcwClock));
    assert_eq!(icon("Trash2"), Some(IconName::Trash));
    assert_eq!(icon("Activity"), Some(IconName::Activity));
    assert_eq!(icon("Zap"), Some(IconName::Zap));
    assert_eq!(icon("Nope"), None);
}

#[test]
fn the_asset_source_falls_back_to_the_component_icons() {
    // A component icon the React UI doesn't use.
    let a = IconName::Asterisk.path();
    assert!(ICONS.iter().all(|(_, n)| n.path() != a));
    assert!(IconAssets.load(&a).unwrap().is_some());
    // Unknown paths: `Assets` answers with an error, not `Ok(None)`.
    assert!(!matches!(
        IconAssets.load("icons/not-an-icon.svg"),
        Ok(Some(_))
    ));
    let listed = IconAssets.list("icons/").unwrap();
    assert!(listed.contains(&a));
    assert!(listed.iter().any(|p| *p == IconName::RotateCcwClock.path()));
    assert!(
        listed.windows(2).all(|w| w[0] < w[1]),
        "sorted and deduplicated"
    );
}

#[test]
fn the_vendored_drawings_replace_the_catalog_s() {
    let names: Vec<&str> = REACT_DRAWINGS.iter().map(|(n, _)| *n).collect();
    assert_eq!(
        names,
        [
            "book-open",
            "calendar",
            "calendar-clock",
            "circle-check",
            "zap"
        ]
    );
    let icon_paths: BTreeSet<_> = ICONS.iter().map(|(_, n)| n.path()).collect();
    let renderer = SvgRenderer::new(Arc::new(IconAssets));
    for (name, data) in REACT_DRAWINGS {
        let path = format!("icons/{name}.svg");
        assert!(
            icon_paths.contains(path.as_str()),
            "{name} is not a React icon"
        );
        let served = IconAssets.load(&path).unwrap().unwrap();
        assert_eq!(&*served, data, "{name}: the vendored drawing is served");
        let ours = String::from_utf8(data.to_vec()).unwrap();
        let theirs = catalog(&path);
        // Lucide's SVG wrapper, as the catalog's…
        assert_eq!(
            ours[..ours.find('>').unwrap()],
            theirs[..theirs.find('>').unwrap()],
            "{name}"
        );
        // …around a different drawing.
        assert_ne!(svg_drawing(&ours), svg_drawing(&theirs), "{name}");
        // gpui's SVG renderer draws it, and not as the catalog's.
        let ink = |svg: &str| {
            let image = renderer.render_single_frame(svg.as_bytes(), 1.0).unwrap();
            image.as_bytes(0).unwrap().to_vec()
        };
        let (ours, theirs) = (ink(&ours), ink(&theirs));
        assert!(ours.chunks(4).any(|px| px[3] > 0), "{name} draws nothing");
        assert_ne!(ours, theirs, "{name}");
    }
    // The generator owns the directory: the SVGs and lucide-react's license.
    let dir = Path::new(env!("CARGO_MANIFEST_DIR")).join("assets/icons");
    let mut files: Vec<String> = fs::read_dir(&dir)
        .unwrap()
        .map(|e| e.unwrap().file_name().into_string().unwrap())
        .collect();
    files.sort();
    let mut want: Vec<String> = names.iter().map(|n| format!("{n}.svg")).collect();
    want.push("LICENSE".into());
    want.sort();
    assert_eq!(files, want);
    let license = fs::read_to_string(dir.join("LICENSE")).unwrap();
    assert!(license.starts_with("ISC License"));
    assert!(license.contains("Lucide Icons and Contributors"));
}

/// The names `components/`, `app/` and `lib/` import from lucide-react.
fn react_imports(root: &Path) -> BTreeSet<String> {
    fn walk(dir: &Path, out: &mut Vec<PathBuf>) {
        for e in fs::read_dir(dir).unwrap() {
            let p = e.unwrap().path();
            if p.is_dir() {
                walk(&p, out);
            } else if p.extension().is_some_and(|x| x == "ts" || x == "tsx") {
                out.push(p);
            }
        }
    }
    let mut files = Vec::new();
    for d in ["components", "app", "lib"] {
        walk(&root.join(d), &mut files);
    }
    let mut names = BTreeSet::new();
    for f in files {
        let src = fs::read_to_string(&f).unwrap();
        let mut rest = src.as_str();
        while let Some(at) = rest.find("from \"lucide-react\"") {
            let head = &rest[..at];
            let open = head.rfind('{').expect("a named import");
            let close = head.rfind('}').expect("a named import");
            assert!(head[..open].trim_end().ends_with("import"), "{f:?}");
            for part in head[open + 1..close].split(',') {
                let part = part.trim().trim_start_matches("type ").trim();
                if let Some(name) = part.split(" as ").next().filter(|n| !n.is_empty()) {
                    names.insert(name.to_string());
                }
            }
            rest = &rest[at + 1..];
        }
    }
    names
}

#[test]
fn drift_the_table_has_every_icon_the_react_ui_imports() {
    let root = repo_root();
    if !root.join("components").is_dir() {
        eprintln!("no components/: skipped");
        return;
    }
    let ours: BTreeSet<String> = ICONS.iter().map(|(n, _)| n.to_string()).collect();
    assert_eq!(react_imports(&root), ours);
}

/// `(tag, attributes)` of an icon's elements, without lucide-react's `key`.
type Drawing = BTreeSet<(String, BTreeMap<String, String>)>;

fn attrs(s: &str, sep: &str, out: &mut BTreeMap<String, String>) {
    let mut rest = s;
    while let Some(q) = rest.find(sep) {
        let name = rest[..q]
            .rsplit(|c: char| c.is_whitespace() || c == ',' || c == '{')
            .next()
            .unwrap()
            .to_string();
        let v = &rest[q + sep.len()..];
        let end = v.find('"').unwrap();
        if name != "key" {
            out.insert(name, v[..end].to_string());
        }
        rest = &v[end + 1..];
    }
}

/// lucide-react's `__iconNode = [["path", { d: "…", key: "…" }], …]`. The
/// bundler breaks a long element over lines (`[\n    "path",\n    {\n
/// d: …`), so the whitespace is collapsed first.
fn react_drawing(mjs: &str) -> Drawing {
    let start = mjs.find("__iconNode = [").unwrap();
    let body = &mjs[start..start + mjs[start..].find("];").unwrap()];
    let body = body.split_whitespace().collect::<Vec<_>>().join(" ");
    body.replace("[ \"", "[\"")
        .split("[\"")
        .skip(1)
        .map(|el| {
            let tag = &el[..el.find('"').unwrap()];
            let mut a = BTreeMap::new();
            attrs(
                &el[el.find('{').unwrap()..el.find('}').unwrap()],
                ": \"",
                &mut a,
            );
            (tag.to_string(), a)
        })
        .collect()
}

/// The catalog SVG's child elements.
fn svg_drawing(svg: &str) -> Drawing {
    let body = &svg[svg.find("<svg").unwrap()..];
    let body = &body[body.find('>').unwrap() + 1..];
    body.split('<')
        .filter(|el| !el.starts_with('/') && !el.trim().is_empty())
        .map(|el| {
            let tag = el.split_whitespace().next().unwrap();
            let mut a = BTreeMap::new();
            attrs(&el[tag.len()..], "=\"", &mut a);
            (tag.to_string(), a)
        })
        .collect()
}

#[test]
fn drift_lucide_react_names_resolve_to_these_icons() {
    let esm = repo_root().join("node_modules/lucide-react/dist/esm");
    let Ok(index) = fs::read_to_string(esm.join("lucide-react.mjs")) else {
        // A checkout without node_modules (CI): the icons were checked
        // against the version bun.lock pins.
        let Ok(lock) = fs::read_to_string(repo_root().join("bun.lock")) else {
            eprintln!("no node_modules or bun.lock: skipped");
            return;
        };
        assert!(
            lock.contains("\"lucide-react\": [\"lucide-react@1.14.0\""),
            "lucide-react moved: rerun this test with node_modules installed"
        );
        return;
    };
    // `export { default as AlertCircle, … } from './icons/circle-alert.mjs';`
    let mut file_of = BTreeMap::new();
    for line in index.lines().filter(|l| l.starts_with("export {")) {
        let Some(from) = line.find("from './icons/") else {
            continue;
        };
        let file = &line[from + 14..line.rfind(".mjs").unwrap()];
        for part in line[8..line.find('}').unwrap()].split(',') {
            if let Some((_, alias)) = part.split_once(" as ") {
                file_of.insert(alias.trim().to_string(), file.to_string());
            }
        }
    }
    // Lucide 1.x renames, same drawing.
    let renamed = BTreeMap::from([("history", "rotate-ccw-clock"), ("trash-2", "trash")]);
    let mut redrawn = BTreeSet::new();
    let mut served_redrawn = BTreeSet::new();
    for (react, name) in ICONS {
        let file = &file_of[react];
        let path = name.path();
        let stem = &path["icons/".len()..path.len() - 4];
        let expected = renamed.get(file.as_str()).copied().unwrap_or(file);
        assert_eq!(stem, expected, "{react}");
        let mjs = fs::read_to_string(esm.join(format!("icons/{file}.mjs"))).unwrap();
        let drawing = react_drawing(&mjs);
        assert!(!drawing.is_empty(), "{react}: no elements parsed");
        if drawing != svg_drawing(&catalog(&path)) {
            assert!(
                !renamed.contains_key(file.as_str()),
                "{react} was renamed, not redrawn"
            );
            redrawn.insert(stem.to_string());
        }
        if drawing != svg_drawing(&svg(name)) {
            served_redrawn.insert(stem.to_string());
        }
    }
    // Lucide 1.14 (React) vs 1.43 (GPUI Kit): the icons the catalog draws
    // differently are the vendored ones…
    eprintln!("{} redrawn: {redrawn:?}", redrawn.len());
    let vendored: BTreeSet<String> = REACT_DRAWINGS.iter().map(|(n, _)| n.to_string()).collect();
    assert_eq!(redrawn, vendored, "rerun rust/scripts/lucide-icons.mjs");
    assert_eq!(redrawn.len(), 5);
    // …so no icon is served with a drawing other than the React UI's.
    assert_eq!(served_redrawn, BTreeSet::new());
}
