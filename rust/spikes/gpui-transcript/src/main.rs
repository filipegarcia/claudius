//! U00a confirming spike (throwaway): a GPUI + gpui-component transcript and
//! composer fed in-process by `claudius-core`.
//!
//! ```text
//! gpui-transcript [--transcript FILE.jsonl | --synthetic N] [--gallery]
//!                 [--bench | --selftest] [--scroll-px N] [--stream-deltas N]
//!                 [--fake-bin PATH] [--raw-replay N] [--row-cap BYTES]
//!                 [--stateful-rows] [--select-row N] [--gallery-scroll PX]
//! gpui-transcript --gen-synthetic N OUT.jsonl
//! gpui-transcript --math-report
//! ```
//! A real transcript is only read (through a symlink in a temp sandbox).

mod app;
mod core_feed;
mod gallery;
mod math;
mod model;
mod stats;
mod synth;

use std::path::PathBuf;
use std::sync::OnceLock;
use std::time::Instant;

use gpui_kit::*;

static MAIN_START: OnceLock<Instant> = OnceLock::new();
static EXEC_TO_MAIN_MS: OnceLock<f64> = OnceLock::new();

pub fn main_start() -> Instant {
    *MAIN_START.get().expect("main start")
}

pub fn exec_to_main_ms() -> f64 {
    *EXEC_TO_MAIN_MS.get().unwrap_or(&f64::NAN)
}

/// Wall time from `exec` (the kernel's process start) to `main`.
fn measure_exec_to_main() -> f64 {
    // SAFETY: proc_pidinfo fills a proc_bsdinfo for our own pid.
    unsafe {
        let mut info: libc::proc_bsdinfo = std::mem::zeroed();
        let n = libc::proc_pidinfo(
            libc::getpid(),
            libc::PROC_PIDTBSDINFO,
            0,
            &mut info as *mut _ as *mut libc::c_void,
            std::mem::size_of::<libc::proc_bsdinfo>() as i32,
        );
        if n <= 0 {
            return f64::NAN;
        }
        let start = info.pbi_start_tvsec as f64 + info.pbi_start_tvusec as f64 / 1e6;
        let now = std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .unwrap()
            .as_secs_f64();
        (now - start) * 1000.
    }
}

struct Args {
    transcript: Option<PathBuf>,
    synthetic: usize,
    gallery: bool,
    mode: app::Mode,
    scroll_px: f32,
    stream_deltas: usize,
    stream_delay_ms: u64,
    fake_bin: Option<PathBuf>,
    gallery_scroll: f32,
    raw_replay: Option<usize>,
}

fn parse_args() -> Args {
    let mut a = Args {
        transcript: None,
        synthetic: 10_000,
        gallery: false,
        mode: app::Mode::Interactive,
        scroll_px: 60.,
        stream_deltas: 600,
        stream_delay_ms: 16,
        fake_bin: None,
        gallery_scroll: 0.,
        raw_replay: None,
    };
    let mut it = std::env::args().skip(1);
    while let Some(k) = it.next() {
        match k.as_str() {
            "--transcript" => a.transcript = it.next().map(PathBuf::from),
            "--synthetic" => a.synthetic = it.next().and_then(|v| v.parse().ok()).unwrap_or(10_000),
            "--gallery" => a.gallery = true,
            "--bench" => a.mode = app::Mode::Bench,
            "--selftest" => a.mode = app::Mode::Selftest,
            "--scroll-px" => a.scroll_px = it.next().and_then(|v| v.parse().ok()).unwrap_or(60.),
            "--stream-deltas" => {
                a.stream_deltas = it.next().and_then(|v| v.parse().ok()).unwrap_or(600)
            }
            "--stream-delay-ms" => {
                a.stream_delay_ms = it.next().and_then(|v| v.parse().ok()).unwrap_or(16)
            }
            "--fake-bin" => a.fake_bin = it.next().map(PathBuf::from),
            "--row-cap" => {
                let cap = it.next().and_then(|v| v.parse().ok()).expect("--row-cap N");
                model::ROW_CAP.set(cap).ok();
            }
            "--select-row" => {
                let n = it
                    .next()
                    .and_then(|v| v.parse().ok())
                    .expect("--select-row N");
                app::SELECT_ROW.set(n).ok();
            }
            "--stateful-rows" => {
                app::STATEFUL_ROWS.store(true, std::sync::atomic::Ordering::Relaxed)
            }
            "--raw-replay" => a.raw_replay = it.next().and_then(|v| v.parse().ok()),
            "--gallery-scroll" => {
                a.gallery_scroll = it.next().and_then(|v| v.parse().ok()).unwrap_or(0.)
            }
            "--gen-synthetic" => {
                let n: usize = it.next().and_then(|v| v.parse().ok()).expect("N");
                let out = it.next().expect("OUT");
                std::fs::write(&out, synth::generate(n)).expect("write");
                std::process::exit(0);
            }
            "--math-report" => {
                math_report();
                std::process::exit(0);
            }
            other => panic!("unknown argument {other}"),
        }
    }
    a
}

/// RaTeX layout+SVG time and box size per formula, for the KaTeX comparison.
fn math_report() {
    let out_dir = PathBuf::from("/tmp/u00a-math");
    let _ = std::fs::create_dir_all(&out_dir);
    let mut rows = Vec::new();
    for (i, f) in math::FORMULAS.iter().enumerate() {
        // Warm once, then time the second run.
        let _ = math::render(f, true, 16. * math::KATEX_SCALE, gpui_kit::black());
        let t = Instant::now();
        let nodes = ratex_parser::parse(f).expect("parse");
        let lbox = ratex_layout::layout(&nodes, &ratex_layout::LayoutOptions::default());
        let list = ratex_layout::to_display_list(&lbox);
        let svg = ratex_svg::render_to_svg(
            &list,
            &ratex_svg::SvgOptions {
                font_size: 40.,
                padding: 4.,
                embed_glyphs: true,
                ..Default::default()
            },
        );
        let us = t.elapsed().as_micros();
        std::fs::write(out_dir.join(format!("ratex-{i}.svg")), &svg).ok();
        rows.push(serde_json::json!({
            "i": i, "tex": f, "us": us,
            "width_em": list.width, "height_em": list.height, "depth_em": list.depth,
        }));
    }
    println!("{}", serde_json::Value::Array(rows));
}

/// A floating window is an NSPanel, which AppKit hides whenever the app is
/// not active; on a shared desktop that would stop its frames. Keep it on
/// screen and on whichever Space is active (incl. a full-screen app's).
fn keep_visible(window: &Window) {
    use objc2::runtime::{AnyObject, Bool};
    use raw_window_handle::{HasWindowHandle, RawWindowHandle};
    let Ok(handle) = HasWindowHandle::window_handle(window) else {
        return;
    };
    let RawWindowHandle::AppKit(h) = handle.as_raw() else {
        return;
    };
    // SAFETY: a live NSView on the main thread; plain AppKit setters.
    unsafe {
        let view = h.ns_view.as_ptr() as *mut AnyObject;
        let win: *mut AnyObject = objc2::msg_send![view, window];
        if win.is_null() {
            return;
        }
        let _: () = objc2::msg_send![win, setHidesOnDeactivate: Bool::NO];
        // CanJoinAllSpaces (1 << 0) | FullScreenAuxiliary (1 << 8)
        let _: () = objc2::msg_send![win, setCollectionBehavior: (1usize << 0) | (1usize << 8)];
        let _: () = objc2::msg_send![win, orderFrontRegardless];
    }
}

fn default_fake_bin() -> PathBuf {
    // The root workspace's build of the scripted CLI.
    let here = PathBuf::from(env!("CARGO_MANIFEST_DIR"));
    for p in [
        "../../target/release/claudius-fake-claude",
        "../../target/debug/claudius-fake-claude",
    ] {
        let c = here.join(p);
        if c.exists() {
            return c;
        }
    }
    panic!(
        "build the fake CLI first: cargo build -p claudius-agent --bin claudius-fake-claude (in rust/)"
    );
}

fn main() {
    MAIN_START.set(Instant::now()).ok();
    EXEC_TO_MAIN_MS.set(measure_exec_to_main()).ok();
    let args = parse_args();

    let root = std::env::temp_dir().join(format!("u00a-run-{}", std::process::id()));
    let sb = core_feed::isolate(&root);
    let (transcript, id) = match &args.transcript {
        Some(p) => {
            let id = p
                .file_stem()
                .and_then(|s| s.to_str())
                .expect("<uuid>.jsonl")
                .to_string();
            (std::fs::canonicalize(p).expect("transcript"), id)
        }
        None => {
            let p = root.join("synthetic.jsonl");
            std::fs::write(&p, synth::generate(args.synthetic)).expect("synthetic");
            (p, synth::SESSION_ID.to_string())
        }
    };
    let script = root.join("fake-script.json");
    std::fs::write(
        &script,
        synth::stream_script(args.stream_deltas, args.stream_delay_ms).to_string(),
    )
    .expect("script");
    let fake = args.fake_bin.clone().unwrap_or_else(default_fake_bin);
    let feed = core_feed::start(&sb, &transcript, &id, &fake, &script, args.raw_replay);

    let mode = args.mode;
    let tab = if args.gallery {
        app::Tab::Gallery
    } else {
        app::Tab::Transcript
    };
    let scroll_px = args.scroll_px;
    let gallery_scroll = args.gallery_scroll;
    let mut feed = Some(feed);
    let sandbox = root.clone();
    gpui_kit::application()
        .with_assets(gpui_kit::assets::Assets)
        .run(move |cx| {
            gpui_kit::init(cx);
            cx.activate(true);
            // `run` does not return on macOS (the app exits from AppKit), so
            // remove the sandbox from the quit hook.
            let sandbox = sandbox.clone();
            cx.on_app_quit(move |_| {
                let _ = std::fs::remove_dir_all(&sandbox);
                async {}
            })
            .detach();
            // Measuring runs float above the (shared, busy) desktop so they
            // are never occluded, and lift GPUI's inactive / low-power /
            // thermal frame caps (30 / 30 / 60 fps) to measure the toolkit
            // itself; the caps are reported next to the numbers.
            let measuring = mode != app::Mode::Interactive;
            let defaults = WindowOptions::default();
            let opts = WindowOptions {
                kind: if measuring {
                    WindowKind::Floating
                } else {
                    WindowKind::Normal
                },
                inactive_frame_interval: if measuring {
                    None
                } else {
                    defaults.inactive_frame_interval
                },
                low_power_frame_interval: if measuring {
                    None
                } else {
                    defaults.low_power_frame_interval
                },
                thermal_frame_interval: if measuring {
                    None
                } else {
                    defaults.thermal_frame_interval
                },
                window_bounds: Some(WindowBounds::centered(size(px(1280.), px(860.)), cx)),
                titlebar: Some(TitlebarOptions {
                    title: Some("U00a GPUI transcript spike".into()),
                    ..Default::default()
                }),
                ..Default::default()
            };
            let feed = feed.take().expect("feed");
            gpui_kit::open_window(opts, cx, move |window, cx| {
                if measuring {
                    keep_visible(window);
                }
                cx.new(|cx| app::Spike::new(mode, tab, feed, scroll_px, gallery_scroll, window, cx))
            })
            .expect("window");
        });
    let _ = std::fs::remove_dir_all(&root);
}
