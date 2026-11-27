//! Scroll and stream bench of the transcript, headless (an offscreen
//! window; the frame is GPUI's `draw`: render, layout, prepaint and paint
//! into the scene, without presenting it), on the U00a spike's synthetic
//! long transcript. Each frame's main-thread CPU time, so compare with the
//! ADR's U00a "CPU per frame" numbers.
//!
//! `cargo run --release -p claudius-chat --example bench` (from rust/app).
//! macOS only.

#[cfg(target_os = "macos")]
fn main() -> anyhow::Result<()> {
    bench::run()
}

#[cfg(not(target_os = "macos"))]
fn main() {
    eprintln!("the bench draws with Metal's text system: macOS only");
}

#[cfg(target_os = "macos")]
mod bench {
    use std::sync::Arc;
    use std::time::Instant;

    use claudius_chat::TranscriptView;
    use claudius_chat::fixture::{DEMO_START_MS, FixtureTranscripts};
    use claudius_chat::script::{self, Script};
    use claudius_gpui_theme::{ThemeName, icons::IconAssets};
    use gpui::{
        AnyWindowHandle, AppContext as _, Bounds, Entity, HeadlessAppContext, ListOffset,
        WindowBounds, WindowOptions, px, size,
    };
    use gpui_apple::{AppleTextSystem, metal_renderer::MetalHeadlessRenderer};

    /// This thread's CPU time, ms (the ADR's "CPU per frame": immune to
    /// the machine's load, which only stretches wall time).
    fn cpu_ms() -> f64 {
        let mut ts = libc::timespec {
            tv_sec: 0,
            tv_nsec: 0,
        };
        // SAFETY: `ts` is a valid, writable timespec.
        unsafe { libc::clock_gettime(libc::CLOCK_THREAD_CPUTIME_ID, &mut ts) };
        ts.tv_sec as f64 * 1000.0 + ts.tv_nsec as f64 / 1e6
    }

    fn pct(sorted: &[f64], p: f64) -> f64 {
        if sorted.is_empty() {
            return f64::NAN;
        }
        let i = ((sorted.len() - 1) as f64 * p).round() as usize;
        sorted[i]
    }

    fn report(name: &str, mut ms: Vec<f64>) {
        ms.sort_by(f64::total_cmp);
        let over = ms.iter().filter(|&&m| m > 8.33).count();
        println!(
            "{name}: {} frames, CPU ms p50/p95/p99/max {:.2}/{:.2}/{:.2}/{:.2}, over 8.33 ms: {:.1}%",
            ms.len(),
            pct(&ms, 0.5),
            pct(&ms, 0.95),
            pct(&ms, 0.99),
            ms.last().copied().unwrap_or(f64::NAN),
            100.0 * over as f64 / ms.len().max(1) as f64,
        );
    }

    /// One frame: the queued work, then a draw. Its main-thread CPU, ms.
    fn frame(cx: &mut HeadlessAppContext, handle: AnyWindowHandle) -> f64 {
        let t = cpu_ms();
        cx.run_until_parked();
        cx.update_window(handle, |_, window, cx| {
            window.refresh();
            window.draw(cx).clear(cx);
        })
        .expect("the window");
        cpu_ms() - t
    }

    fn open(
        cx: &mut HeadlessAppContext,
        src: &Arc<FixtureTranscripts>,
        session: &'static str,
    ) -> (AnyWindowHandle, Entity<TranscriptView>) {
        let source: Arc<dyn claudius_chat::TranscriptSource> = src.clone();
        cx.update(|cx| {
            gpui_kit::open_window(
                WindowOptions {
                    window_bounds: Some(WindowBounds::Windowed(Bounds {
                        origin: Default::default(),
                        size: size(px(1280.), px(900.)),
                    })),
                    focus: false,
                    show: false,
                    ..Default::default()
                },
                cx,
                |_, cx| cx.new(|cx| TranscriptView::new(source, session, ThemeName::Dark, cx)),
            )
        })
        .expect("a window")
    }

    fn scroll(
        cx: &mut HeadlessAppContext,
        src: &Arc<FixtureTranscripts>,
        step: f32,
        frames: usize,
    ) {
        let (handle, view) = open(cx, src, "long");
        for _ in 0..4 {
            frame(cx, handle);
        }
        let rows = cx.update(|cx| view.read(cx).transcript().rows.len());
        cx.update(|cx| {
            view.read(cx).list_state().scroll_to(ListOffset {
                item_ix: 0,
                offset_in_item: px(0.),
            })
        });
        frame(cx, handle);
        let mut ms = Vec::with_capacity(frames);
        for _ in 0..frames {
            cx.update(|cx| view.read(cx).list_state().scroll_by(px(step)));
            ms.push(frame(cx, handle));
        }
        let stats = cx.update(|cx| view.read(cx).markdown_stats());
        let top = cx.update(|cx| view.read(cx).list_state().logical_scroll_top().item_ix);
        report(
            &format!("scroll {step} px/frame over {rows} rows (reached row {top})"),
            ms,
        );
        println!("  markdown: {stats:?}");
        cx.update_window(handle, |_, window, _| window.remove_window())
            .ok();
    }

    fn stream(cx: &mut HeadlessAppContext, history_events: usize) {
        let src = FixtureTranscripts::new();
        let mut history = script::synthetic("live", history_events, DEMO_START_MS);
        let (_, demo_stream) = script::demo("live", DEMO_START_MS + 1e9, 16.0);
        let mut s = Script::new("live", DEMO_START_MS + 2e9);
        s.user("Stream a long reply.").running(true);
        history.extend(s.lines());
        // The demo reply's deltas, three times over (a ~600-word reply).
        let deltas: Vec<_> = demo_stream
            .iter()
            .filter(|l| l.data.contains("text_delta"))
            .cloned()
            .collect();
        let mut stream: Vec<_> = demo_stream
            .iter()
            .take_while(|l| !l.data.contains("text_delta"))
            .cloned()
            .collect();
        let times: usize = std::env::var("BENCH_STREAM_X")
            .ok()
            .and_then(|s| s.parse().ok())
            .unwrap_or(3);
        for _ in 0..times {
            stream.extend(deltas.iter().cloned());
        }
        src.insert_streaming("live", &history, stream);
        let src = Arc::new(src);
        let (handle, view) = open(cx, &src, "live");
        for _ in 0..4 {
            frame(cx, handle);
        }
        let rows = cx.update(|cx| view.read(cx).transcript().rows.len());
        let (mut ms, mut apply, mut view_ms) = (Vec::new(), Vec::new(), Vec::new());
        while src.remaining("live") > 0 {
            let t = cpu_ms();
            src.advance("live");
            let applied = cpu_ms();
            frame(cx, handle);
            let end = cpu_ms();
            ms.push(end - t);
            apply.push(applied - t);
            view_ms.push(end - applied);
        }
        report(
            "  of which claudius-client's apply (ChatState::on_message)",
            apply,
        );
        report("  of which the view (rows rebuild, splice, draw)", view_ms);
        let stats = cx.update(|cx| view.read(cx).markdown_stats());
        let following = cx.update(|cx| view.read(cx).following());
        report(
            &format!("stream (delta to drawn frame) over {rows} rows, following {following}"),
            ms,
        );
        println!("  markdown: {stats:?}");
        cx.update_window(handle, |_, window, _| window.remove_window())
            .ok();
    }

    pub fn run() -> anyhow::Result<()> {
        let events: usize = std::env::var("BENCH_EVENTS")
            .ok()
            .and_then(|s| s.parse().ok())
            .unwrap_or(22_000);
        let mut cx = HeadlessAppContext::with_platform(
            Arc::new(AppleTextSystem::new()),
            Arc::new(IconAssets),
            || Ok(Some(Box::new(MetalHeadlessRenderer::new()?))),
        );
        cx.update(|cx| {
            gpui_kit::init(cx);
            claudius_gpui_theme::init(ThemeName::Dark, cx);
        });
        let t = Instant::now();
        let src = FixtureTranscripts::new();
        src.insert("long", &script::synthetic("long", events, DEMO_START_MS));
        let src = Arc::new(src);
        println!(
            "replayed {events} synthetic events in {:.0} ms",
            t.elapsed().as_secs_f64() * 1000.0
        );
        {
            use claudius_chat::TranscriptSource as _;
            use claudius_chat::rows::{RowBuilder, ViewOptions};
            let mut b = RowBuilder::default();
            let opts = ViewOptions::default();
            let mut times = Vec::new();
            let n: usize = std::env::var("BENCH_ROWS")
                .ok()
                .and_then(|s| s.parse().ok())
                .unwrap_or(20);
            for _ in 0..n {
                src.read("long", &mut |state| {
                    let t = cpu_ms();
                    let out = b.build(state, &opts);
                    times.push(cpu_ms() - t);
                    std::hint::black_box(out);
                });
            }
            report("rows() rebuild of the whole transcript", times);
            if n > 20 {
                return Ok(());
            }
        }
        if std::env::var_os("BENCH_STREAM_ONLY").is_none() {
            scroll(&mut cx, &src, 100.0, 1500);
            scroll(&mut cx, &src, 40.0, 1500);
        }
        let repeat: usize = std::env::var("BENCH_STREAM_REPEAT")
            .ok()
            .and_then(|s| s.parse().ok())
            .unwrap_or(1);
        for _ in 0..repeat {
            stream(&mut cx, events);
        }
        Ok(())
    }
}
