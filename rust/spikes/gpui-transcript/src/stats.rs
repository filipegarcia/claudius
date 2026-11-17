//! Percentiles, frame drops, memory and load, as JSON.

use serde_json::{Value, json};

fn pct(sorted: &[f64], p: f64) -> f64 {
    if sorted.is_empty() {
        return f64::NAN;
    }
    let ix = ((p / 100.) * (sorted.len() - 1) as f64).round() as usize;
    sorted[ix.min(sorted.len() - 1)]
}

fn r2(x: f64) -> f64 {
    (x * 100.).round() / 100.
}

pub fn summary(xs: &[f64]) -> Value {
    let mut v: Vec<f64> = xs.iter().copied().filter(|x| x.is_finite()).collect();
    v.sort_by(|a, b| a.partial_cmp(b).unwrap());
    let mean = if v.is_empty() {
        f64::NAN
    } else {
        v.iter().sum::<f64>() / v.len() as f64
    };
    json!({
        "n": v.len(),
        "p50": r2(pct(&v, 50.)), "p95": r2(pct(&v, 95.)), "p99": r2(pct(&v, 99.)),
        "max": r2(v.last().copied().unwrap_or(f64::NAN)), "mean": r2(mean),
    })
}

/// `frames`: (interval between frame completions, render→paint work), ms.
pub fn frames(frames: &[(f64, f64)], refresh_ms: f64) -> Value {
    let intervals: Vec<f64> = frames.iter().map(|f| f.0).collect();
    let work: Vec<f64> = frames.iter().map(|f| f.1).collect();
    // A frame "drops" when it took longer than 1.5 vsyncs; `missed_vsyncs`
    // counts every refresh that showed a stale frame.
    let dropped = intervals.iter().filter(|i| **i > refresh_ms * 1.5).count();
    let missed: f64 = intervals
        .iter()
        .map(|i| ((i / refresh_ms).round() - 1.).max(0.))
        .sum();
    let total_ms: f64 = intervals.iter().sum();
    let over_budget = work.iter().filter(|w| **w > refresh_ms).count();
    json!({
        "frames": frames.len(),
        "interval_ms": summary(&intervals),
        "work_ms": summary(&work),
        "dropped_frames": dropped,
        "dropped_pct": r2(100. * dropped as f64 / frames.len().max(1) as f64),
        "missed_vsyncs": missed,
        "work_over_budget": over_budget,
        "avg_fps": r2(1000. * frames.len() as f64 / total_ms.max(1.)),
    })
}

pub fn memory() -> Value {
    // SAFETY: plain libc calls into zeroed out-params.
    unsafe {
        let mut ru: libc::rusage = std::mem::zeroed();
        libc::getrusage(libc::RUSAGE_SELF, &mut ru);
        let mut info: libc::rusage_info_v2 = std::mem::zeroed();
        let ok = libc::proc_pid_rusage(
            libc::getpid(),
            libc::RUSAGE_INFO_V2,
            &mut info as *mut _ as *mut libc::rusage_info_t,
        ) == 0;
        let mb = |b: u64| r2(b as f64 / 1_048_576.);
        json!({
            // macOS reports ru_maxrss in bytes.
            "peak_rss_mb": mb(ru.ru_maxrss as u64),
            "rss_now_mb": if ok { json!(mb(info.ri_resident_size)) } else { Value::Null },
            "phys_footprint_mb": if ok { json!(mb(info.ri_phys_footprint)) } else { Value::Null },
        })
    }
}

pub fn load_avg() -> Value {
    let mut l = [0f64; 3];
    // SAFETY: writes 3 doubles.
    unsafe { libc::getloadavg(l.as_mut_ptr(), 3) };
    json!([r2(l[0]), r2(l[1]), r2(l[2])])
}

/// `pmset -g therm` (CPU speed limit / thermal warning level), as text.
pub fn thermal() -> Value {
    let out = std::process::Command::new("/usr/bin/pmset")
        .args(["-g", "therm"])
        .output();
    let text = out
        .map(|o| String::from_utf8_lossy(&o.stdout).to_string())
        .unwrap_or_default();
    json!(
        text.lines()
            .map(str::trim)
            .filter(|l| !l.is_empty() && !l.starts_with("Note"))
            .collect::<Vec<_>>()
            .join("; ")
    )
}
