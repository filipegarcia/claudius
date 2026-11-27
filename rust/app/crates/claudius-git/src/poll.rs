//! The status poll: `lib/client/git-poll.ts`'s spacing and
//! `lib/client/useGitStatus.ts`'s self-scheduling chain, as a state machine
//! the view drives (it starts the fetches and the timers this asks for).

/// `GIT_POLL_SLOW_FACTOR` (git-poll.ts:20).
pub const GIT_POLL_SLOW_FACTOR: f64 = 3.;
/// `GIT_POLL_MAX_MS` (git-poll.ts:22).
pub const GIT_POLL_MAX_MS: f64 = 60_000.;
/// `useGitStatus(workspaceId, intervalMs = 4000)`.
pub const GIT_POLL_INTERVAL_MS: f64 = 4000.;

fn non_negative(n: Option<f64>) -> f64 {
    match n {
        Some(n) if n.is_finite() && n > 0. => n,
        _ => 0.,
    }
}

/// `nextGitPollDelayMs` (git-poll.ts:33): at least `base`, stretched to 3×
/// the last refresh's duration, capped at a minute.
pub fn next_git_poll_delay_ms(base: f64, last_duration: Option<f64>) -> f64 {
    let base = non_negative(Some(base));
    let slow = non_negative(last_duration) * GIT_POLL_SLOW_FACTOR;
    GIT_POLL_MAX_MS.min(base.max(slow))
}

/// `useGitStatus`'s effect (useGitStatus.ts:46): at most one request in
/// flight, the next tick armed only once it settles.
///
/// * [`StatusPoll::run`] is `run(force)`: a background run never aborts
///   (or stacks on) a running request; a forced one (`refresh()`)
///   supersedes it. Either clears an armed timer.
/// * [`StatusPoll::settled`] is the request's `finally`: a superseded
///   request's answer is dropped, the current one arms the next tick
///   [`next_git_poll_delay_ms`] later (after an error too).
/// * [`StatusPoll::tick`] is the timer: it lapses while the window is
///   hidden; [`StatusPoll::visible`] restarts the chain.
#[derive(Clone, Debug, Default, PartialEq)]
pub struct StatusPoll {
    interval_ms: f64,
    next_id: u64,
    in_flight: Option<u64>,
    timer: Option<u64>,
    disposed: bool,
}

impl StatusPoll {
    pub fn new(interval_ms: f64) -> Self {
        StatusPoll {
            interval_ms,
            ..StatusPoll::default()
        }
    }

    /// The request to start, if any (its id). `aborted` is the one it
    /// supersedes.
    pub fn run(&mut self, force: bool) -> Option<u64> {
        if self.disposed {
            return None;
        }
        if self.in_flight.is_some() && !force {
            return None;
        }
        self.timer = None;
        self.next_id += 1;
        self.in_flight = Some(self.next_id);
        Some(self.next_id)
    }

    /// Whether `id` is still the request whose answer counts.
    pub fn is_current(&self, id: u64) -> bool {
        !self.disposed && self.in_flight == Some(id)
    }

    /// Request `id` settled after `duration_ms`: the timer to arm (its id
    /// and delay), or `None` for a superseded request.
    pub fn settled(&mut self, id: u64, duration_ms: f64) -> Option<(u64, f64)> {
        if !self.is_current(id) {
            return None;
        }
        self.in_flight = None;
        self.next_id += 1;
        self.timer = Some(self.next_id);
        Some((
            self.next_id,
            next_git_poll_delay_ms(self.interval_ms, Some(duration_ms)),
        ))
    }

    /// Timer `id` fired: the request to start, if the window is visible.
    pub fn tick(&mut self, id: u64, visible: bool) -> Option<u64> {
        if self.disposed || self.timer != Some(id) {
            return None;
        }
        self.timer = None;
        if visible { self.run(false) } else { None }
    }

    /// `visibilitychange` to visible: `run(false)`.
    pub fn visible(&mut self) -> Option<u64> {
        self.run(false)
    }

    /// Unmount / workspace switch: the in-flight answer is discarded.
    pub fn dispose(&mut self) {
        self.disposed = true;
        self.in_flight = None;
        self.timer = None;
    }

    pub fn in_flight(&self) -> Option<u64> {
        self.in_flight
    }

    pub fn armed(&self) -> Option<u64> {
        self.timer
    }
}
