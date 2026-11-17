//! `lib/client/stream-recovery.ts`: the backoff for rebuilding a session
//! stream the browser gave up on, when a reconnect must rebuild the
//! transcript instead of merging the replay, and the "Reconnecting"
//! badge's debounce.

/// `STREAM_RECOVERY_MAX_DELAY_MS`: the longest gap between attempts.
pub const STREAM_RECOVERY_MAX_DELAY_MS: f64 = 30_000.0;

/// `STREAM_REBUILD_AFTER_MS`: an outage longer than this rebuilds.
pub const STREAM_REBUILD_AFTER_MS: f64 = 15_000.0;

/// `STREAM_BADGE_AFTER_MS`: how long the stream is down before the
/// "Reconnecting" badge shows.
pub const STREAM_BADGE_AFTER_MS: f64 = 4_000.0;

/// `streamRecoveryDelayMs(attempt)`: 1 s doubling per consecutive failure
/// (`attempt` floored), capped at 30 s; a negative or non-finite attempt
/// waits the first step.
pub fn stream_recovery_delay_ms(attempt: f64) -> f64 {
    if !attempt.is_finite() || attempt < 0.0 {
        return 1_000.0;
    }
    let step = attempt.floor().min(5.0);
    STREAM_RECOVERY_MAX_DELAY_MS.min(1_000.0 * 2f64.powf(step))
}

/// `shouldRebuildTranscript(downMs)`: down longer than
/// [`STREAM_REBUILD_AFTER_MS`], or for a non-finite time.
pub fn should_rebuild_transcript(down_ms: f64) -> bool {
    !down_ms.is_finite() || down_ms > STREAM_REBUILD_AFTER_MS
}
