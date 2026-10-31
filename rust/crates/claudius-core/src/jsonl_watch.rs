//! The watching half of `Session.startJsonlWatcher` / `stopJsonlWatcher` /
//! `scheduleJsonlResync` (lib/server/session.ts): watch a directory for
//! changes to one file and coalesce them into calls of a `fire` callback, so
//! turns another client writes to a session's JSONL (`claude --resume <id>`
//! in a terminal) reach open tabs without a reload.
//!
//! The session glue lives in [`crate::session::Session::start_jsonl_watcher`].

use std::ffi::{OsStr, OsString};
use std::path::{Path, PathBuf};
use std::time::Duration;

use notify::{Event, EventKind, RecommendedWatcher, RecursiveMode, Watcher};
use tokio::sync::mpsc;
use tokio::time::Instant;
use tokio_util::sync::CancellationToken;

/// `scheduleJsonlResync`'s timer: "comfortably below human-noticeable latency
/// and well above the OS event burst window".
pub const RESYNC_DEBOUNCE: Duration = Duration::from_millis(200);

/// What a timer firing did.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Fired {
    /// Started a resync.
    Started,
    /// A resync is already running: re-arm the timer.
    Busy,
    /// The session is gone: stop.
    Gone,
}

/// A running watch. Dropping it (`stopJsonlWatcher`) cancels a pending
/// timer at once and closes the OS watcher on a detached thread: closing an
/// FSEvents stream joins notify's run-loop thread, which can sit in an
/// fseventsd call for seconds (minutes under heavy file churn), and the
/// caller is usually a runtime thread.
pub struct JsonlWatch {
    watcher: Option<RecommendedWatcher>,
    stop: CancellationToken,
}

impl Drop for JsonlWatch {
    fn drop(&mut self) {
        self.stop.cancel();
        if let Some(watcher) = self.watcher.take() {
            // A failed spawn drops the closure, and the watcher, right here.
            let _ = std::thread::Builder::new()
                .name("jsonl-watch-stop".into())
                .spawn(move || drop(watcher));
        }
    }
}

#[derive(Debug)]
enum Signal {
    Change,
    Error,
}

/// `fs.watch(dir, listener)` filtered on `filename === file_name`: watch the
/// directory, not the file, because the file may not exist yet and
/// atomic-rename writes replace its inode.
///
/// Each change (re)starts a [`RESYNC_DEBOUNCE`] timer; when it fires,
/// `fire` runs, and the timer re-arms if it reports [`Fired::Busy`]. A
/// watcher error calls `on_error` (the TS `"error"` listener, which stops
/// the watcher) and ends the timer task.
///
/// Returns `None` when the watch can't start (e.g. `dir` doesn't exist yet),
/// where `fs.watch` throws and the TS code carries on without a watcher.
/// Must be called inside a Tokio runtime.
pub fn watch(
    dir: &Path,
    file_name: &str,
    fire: impl FnMut() -> Fired + Send + 'static,
    on_error: impl FnOnce() + Send + 'static,
) -> Option<JsonlWatch> {
    // FSEvents reports canonical paths (`/private/var/…` for `/var/…`); the
    // other backends report paths under the directory as given.
    let mut dirs = vec![dir.to_path_buf()];
    if let Ok(canonical) = dir.canonicalize()
        && canonical != dir
    {
        dirs.push(canonical);
    }
    let target = OsString::from(file_name);
    let (tx, rx) = mpsc::unbounded_channel();
    let mut watcher = notify::recommended_watcher(move |res: notify::Result<Event>| {
        let signal = match res {
            Ok(ev) if is_change_to(&ev, &dirs, &target) => Signal::Change,
            Ok(_) => return,
            Err(_) => Signal::Error,
        };
        let _ = tx.send(signal);
    })
    .ok()?;
    watcher.watch(dir, RecursiveMode::NonRecursive).ok()?;
    let stop = CancellationToken::new();
    tokio::spawn(coalesce(rx, stop.clone(), fire, on_error));
    Some(JsonlWatch {
        watcher: Some(watcher),
        stop,
    })
}

/// Whether a watch event touches `<one of dirs>/<target>` — the listener's
/// `filename === target`, where `filename` is relative to the watched
/// directory (so a same-named file in a subdirectory doesn't count). Access
/// events don't count either: inotify reports opens and closes, so the
/// resync's own read would re-trigger it forever, and libuv doesn't watch
/// them.
fn is_change_to(ev: &Event, dirs: &[PathBuf], target: &OsStr) -> bool {
    if matches!(ev.kind, EventKind::Access(_)) {
        return false;
    }
    ev.paths.iter().any(|p| {
        p.file_name() == Some(target) && p.parent().is_some_and(|d| dirs.iter().any(|w| w == d))
    })
}

/// `scheduleJsonlResync`: a trailing debounce. `clearTimeout` + `setTimeout`
/// on every change; when the timer fires, `fire`, re-arming while it reports
/// [`Fired::Busy`].
async fn coalesce(
    mut rx: mpsc::UnboundedReceiver<Signal>,
    stop: CancellationToken,
    mut fire: impl FnMut() -> Fired,
    on_error: impl FnOnce(),
) {
    let mut deadline: Option<Instant> = None;
    loop {
        let timer = async {
            match deadline {
                Some(at) => tokio::time::sleep_until(at).await,
                None => std::future::pending().await,
            }
        };
        tokio::select! {
            biased;
            _ = stop.cancelled() => return,
            signal = rx.recv() => match signal {
                Some(Signal::Change) => deadline = Some(Instant::now() + RESYNC_DEBOUNCE),
                Some(Signal::Error) => {
                    on_error();
                    return;
                }
                None => return,
            },
            _ = timer => match fire() {
                Fired::Started => deadline = None,
                Fired::Busy => deadline = Some(Instant::now() + RESYNC_DEBOUNCE),
                Fired::Gone => return,
            },
        }
    }
}

#[cfg(test)]
mod tests {
    use std::sync::atomic::{AtomicUsize, Ordering};
    use std::sync::{Arc, Mutex};

    use notify::event::{AccessKind, AccessMode, CreateKind, DataChange, ModifyKind, RenameMode};

    use super::*;

    fn ev(kind: EventKind, paths: &[&str]) -> Event {
        paths
            .iter()
            .fold(Event::new(kind), |e, p| e.add_path(PathBuf::from(p)))
    }

    #[test]
    fn only_changes_to_the_file_directly_in_the_dir_count() {
        let dirs = [PathBuf::from("/w/proj"), PathBuf::from("/private/w/proj")];
        let target = OsStr::new("abc.jsonl");
        let write = EventKind::Modify(ModifyKind::Data(DataChange::Any));
        let yes = [
            ev(write, &["/w/proj/abc.jsonl"]),
            ev(write, &["/private/w/proj/abc.jsonl"]),
            ev(EventKind::Create(CreateKind::File), &["/w/proj/abc.jsonl"]),
            ev(
                EventKind::Remove(notify::event::RemoveKind::Any),
                &["/w/proj/abc.jsonl"],
            ),
            // Atomic-rename write: the temp file becomes the target.
            ev(
                EventKind::Modify(ModifyKind::Name(RenameMode::Both)),
                &["/w/proj/abc.jsonl.tmp", "/w/proj/abc.jsonl"],
            ),
            ev(EventKind::Any, &["/w/proj/abc.jsonl"]),
            ev(EventKind::Other, &["/w/proj/abc.jsonl"]),
        ];
        for e in &yes {
            assert!(is_change_to(e, &dirs, target), "{e:?}");
        }
        let no = [
            ev(write, &["/w/proj/other.jsonl"]),
            ev(write, &["/w/proj/abc.jsonl.tmp"]),
            ev(write, &["/w/proj/abc/abc.jsonl"]),
            ev(write, &["/w/proj/sub/abc.jsonl"]),
            ev(write, &["/elsewhere/abc.jsonl"]),
            ev(write, &[]),
            ev(
                EventKind::Access(AccessKind::Open(AccessMode::Any)),
                &["/w/proj/abc.jsonl"],
            ),
            ev(
                EventKind::Access(AccessKind::Close(AccessMode::Read)),
                &["/w/proj/abc.jsonl"],
            ),
            ev(
                EventKind::Access(AccessKind::Close(AccessMode::Write)),
                &["/w/proj/abc.jsonl"],
            ),
        ];
        for e in &no {
            assert!(!is_change_to(e, &dirs, target), "{e:?}");
        }
    }

    /// A paused-clock harness around [`coalesce`]: `fire` replies from a
    /// script (then `Started`) and logs the virtual time of each call.
    struct Harness {
        tx: mpsc::UnboundedSender<Signal>,
        stop: CancellationToken,
        fired: Arc<Mutex<Vec<Duration>>>,
        errors: Arc<AtomicUsize>,
        task: tokio::task::JoinHandle<()>,
        t0: Instant,
    }

    fn harness(script: &[Fired]) -> Harness {
        let (tx, rx) = mpsc::unbounded_channel();
        let stop = CancellationToken::new();
        let fired = Arc::new(Mutex::new(Vec::new()));
        let errors = Arc::new(AtomicUsize::new(0));
        let t0 = Instant::now();
        let mut replies = std::collections::VecDeque::from(script.to_vec());
        let log = fired.clone();
        let errs = errors.clone();
        let task = tokio::spawn(coalesce(
            rx,
            stop.clone(),
            move || {
                log.lock().unwrap().push(t0.elapsed());
                replies.pop_front().unwrap_or(Fired::Started)
            },
            move || {
                errs.fetch_add(1, Ordering::SeqCst);
            },
        ));
        Harness {
            tx,
            stop,
            fired,
            errors,
            task,
            t0,
        }
    }

    impl Harness {
        async fn at(&self, ms: u64) {
            tokio::time::sleep_until(self.t0 + Duration::from_millis(ms)).await;
        }
        fn change(&self) {
            self.tx.send(Signal::Change).unwrap();
        }
        fn fired_ms(&self) -> Vec<u128> {
            self.fired
                .lock()
                .unwrap()
                .iter()
                .map(Duration::as_millis)
                .collect()
        }
    }

    #[tokio::test(start_paused = true)]
    async fn a_burst_fires_once_200ms_after_its_last_event() {
        let h = harness(&[]);
        h.change();
        h.at(150).await;
        h.change();
        h.at(300).await;
        h.change();
        h.at(499).await;
        assert_eq!(h.fired_ms(), Vec::<u128>::new());
        h.at(1000).await;
        assert_eq!(h.fired_ms(), vec![500]);
        // A later change starts a new window.
        h.change();
        h.at(2000).await;
        assert_eq!(h.fired_ms(), vec![500, 1200]);
    }

    #[tokio::test(start_paused = true)]
    async fn a_busy_resync_re_arms_until_it_is_free() {
        let h = harness(&[Fired::Busy, Fired::Busy, Fired::Started]);
        h.change();
        h.at(1000).await;
        assert_eq!(h.fired_ms(), vec![200, 400, 600]);
        // A change while re-arming restarts the window from that change.
        let h = harness(&[Fired::Busy]);
        h.change();
        h.at(300).await;
        h.change();
        h.at(1000).await;
        assert_eq!(h.fired_ms(), vec![200, 500]);
    }

    #[tokio::test(start_paused = true)]
    async fn stop_cancels_a_pending_timer() {
        let h = harness(&[]);
        h.change();
        h.at(100).await;
        h.stop.cancel();
        h.at(1000).await;
        assert!(h.task.is_finished());
        assert_eq!(h.fired_ms(), Vec::<u128>::new());
    }

    #[test]
    fn dropping_the_watch_cancels_its_timer_at_once() {
        let stop = CancellationToken::new();
        drop(JsonlWatch {
            watcher: None,
            stop: stop.clone(),
        });
        assert!(stop.is_cancelled());
    }

    #[tokio::test(start_paused = true)]
    async fn an_error_reports_and_ends_without_firing() {
        let h = harness(&[]);
        h.change();
        h.tx.send(Signal::Error).unwrap();
        h.at(1000).await;
        assert!(h.task.is_finished());
        assert_eq!(h.errors.load(Ordering::SeqCst), 1);
        assert_eq!(h.fired_ms(), Vec::<u128>::new());
    }

    #[tokio::test(start_paused = true)]
    async fn a_gone_session_or_closed_watcher_ends_the_task() {
        let h = harness(&[Fired::Gone]);
        h.change();
        h.at(300).await;
        assert!(h.task.is_finished());
        assert_eq!(h.fired_ms(), vec![200]);
        let Harness {
            tx,
            task,
            errors,
            t0,
            ..
        } = harness(&[]);
        drop(tx);
        tokio::time::sleep_until(t0 + Duration::from_millis(10)).await;
        assert!(task.is_finished());
        assert_eq!(errors.load(Ordering::SeqCst), 0);
    }

    /// The real OS watcher, end to end: a write to the file fires once; other
    /// files, and dropping the watch, don't.
    #[tokio::test]
    async fn watches_the_real_filesystem() {
        let dir = tempfile::tempdir().unwrap();
        let fired = Arc::new(AtomicUsize::new(0));
        let n = fired.clone();
        let w = watch(
            dir.path(),
            "s.jsonl",
            move || {
                n.fetch_add(1, Ordering::SeqCst);
                Fired::Started
            },
            || {},
        )
        .expect("watch starts");
        // Some backends start delivering a beat after `watch` returns.
        tokio::time::sleep(Duration::from_millis(100)).await;
        std::fs::write(dir.path().join("other.jsonl"), "x\n").unwrap();
        tokio::time::sleep(Duration::from_millis(600)).await;
        assert_eq!(fired.load(Ordering::SeqCst), 0, "other files don't count");
        std::fs::write(dir.path().join("s.jsonl"), "{}\n").unwrap();
        let start = std::time::Instant::now();
        while fired.load(Ordering::SeqCst) == 0 {
            assert!(start.elapsed() < Duration::from_secs(10), "no event");
            tokio::time::sleep(Duration::from_millis(20)).await;
        }
        tokio::time::sleep(Duration::from_millis(600)).await;
        assert_eq!(fired.load(Ordering::SeqCst), 1);
        drop(w);
        std::fs::write(dir.path().join("s.jsonl"), "{}\n{}\n").unwrap();
        tokio::time::sleep(Duration::from_millis(600)).await;
        assert_eq!(fired.load(Ordering::SeqCst), 1, "dropped watch stays quiet");
    }

    #[tokio::test]
    async fn a_missing_dir_starts_no_watch() {
        let dir = tempfile::tempdir().unwrap();
        assert!(
            watch(
                &dir.path().join("nope"),
                "s.jsonl",
                || Fired::Started,
                || {}
            )
            .is_none()
        );
    }
}
