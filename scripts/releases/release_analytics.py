#!/usr/bin/env python3
"""
Anthropic Release Analytics
════════════════════════════
Fetches release metadata from Anthropic's SDK GitHub repos and Claude Code,
then computes rich metrics: cadence, changelog sizes, velocity trends, and more.

Usage:
    python release_analytics.py
    GITHUB_TOKEN=ghp_xxx python release_analytics.py   # avoids rate limits

Optional flags:
    --stable-only   exclude pre-release versions from gap/cadence analysis
    --json          dump raw data as JSON to stdout after the report
    --no-color      disable ANSI colors
"""

import requests
import sys
import os
import re
import json
import time as _time
import argparse
from datetime import datetime, timezone, timedelta
from collections import defaultdict, Counter
from statistics import mean, median, stdev
from typing import Optional

# ─── CLI ─────────────────────────────────────────────────────────────────────

parser = argparse.ArgumentParser(add_help=True, description=__doc__)
parser.add_argument("--stable-only", action="store_true")
parser.add_argument("--json",        action="store_true")
parser.add_argument("--no-color",    action="store_true")
ARGS = parser.parse_args()

# ─── Colors ──────────────────────────────────────────────────────────────────

USE_COLOR = sys.stdout.isatty() and not ARGS.no_color

def _c(code: str, text: str) -> str:
    return f"\033[{code}m{text}\033[0m" if USE_COLOR else text

def BOLD(t):    return _c("1",    t)
def DIM(t):     return _c("2",    t)
def GREEN(t):   return _c("32",   t)
def YELLOW(t):  return _c("33",   t)
def BLUE(t):    return _c("34",   t)
def CYAN(t):    return _c("36",   t)
def RED(t):     return _c("31",   t)
def MAGENTA(t): return _c("35",   t)
def WHITE(t):   return _c("97",   t)

# ─── Config ───────────────────────────────────────────────────────────────────

GITHUB_TOKEN = os.environ.get("GITHUB_TOKEN", "")
GH_HEADERS   = {
    "Accept":     "application/vnd.github.v3+json",
    "User-Agent": "anthropic-release-analytics/1.0",
}
if GITHUB_TOKEN:
    GH_HEADERS["Authorization"] = f"Bearer {GITHUB_TOKEN}"

# Ordered list of (label, github_repo, emoji)
GITHUB_REPOS = [
    ("Python SDK",     "anthropics/anthropic-sdk-python",     "🐍"),
    ("TypeScript SDK", "anthropics/anthropic-sdk-typescript",  "📘"),
    ("Java SDK",       "anthropics/anthropic-sdk-java",        "☕"),
    ("Go SDK",         "anthropics/anthropic-sdk-go",          "🐹"),
    ("Ruby SDK",       "anthropics/anthropic-sdk-ruby",        "💎"),
    ("C# SDK",         "anthropics/anthropic-sdk-csharp",      "🔷"),
    ("PHP SDK",        "anthropics/anthropic-sdk-php",         "🐘"),
    ("Claude Code",    "anthropics/claude-code",               "⚡"),
]

# npm packages: only used when GitHub releases are absent or insufficient
NPM_PACKAGES = [
    ("@anthropic-ai/claude-code", "Claude Code", "⚡"),
    ("@anthropic-ai/sdk",         "TS SDK",       "📘"),
]

# ─── Semver ───────────────────────────────────────────────────────────────────

_SEMVER_RE = re.compile(
    r"[vV]?(\d+)\.(\d+)\.(\d+)(?:[.\-](.+))?$"
)

def parse_semver(tag: str) -> Optional[tuple]:
    """Return (major, minor, patch, pre) or None."""
    m = _SEMVER_RE.search(tag)
    if not m:
        return None
    major, minor, patch, pre = m.groups()
    return int(major), int(minor), int(patch), pre

def semver_type(tag: str) -> str:
    """Classify a version bump as major/minor/patch/pre/unknown vs previous."""
    sv = parse_semver(tag)
    if sv is None:
        return "unknown"
    major, minor, patch, pre = sv
    if pre:
        return "pre"
    if minor == 0 and patch == 0:
        return "major"
    if patch == 0:
        return "minor"
    return "patch"

def is_prerelease_tag(tag: str) -> bool:
    """Guess whether a version tag is a pre-release."""
    sv = parse_semver(tag)
    if sv and sv[3]:               # has pre-release suffix
        return True
    low = tag.lower()
    return any(k in low for k in ("alpha", "beta", "rc", "dev", "preview", "canary", "nightly"))

# ─── Fetching ─────────────────────────────────────────────────────────────────

def _gh_get(url: str, params: dict = None):
    try:
        r = requests.get(url, headers=GH_HEADERS, params=params, timeout=20)
        if r.status_code == 404:
            return None
        if r.status_code == 403:
            print(f"\n  {RED('⚠  Rate-limited')} — set GITHUB_TOKEN for 5000 req/hr")
            return []
        r.raise_for_status()
        return r.json()
    except requests.RequestException as e:
        print(f"\n  {RED('Error')}: {e}")
        return []


def fetch_github_releases(repo: str, max_pages: int = 20):
    """Fetch all non-draft releases for a GitHub repo (pages of 100)."""
    out = []
    for page in range(1, max_pages + 1):
        data = _gh_get(
            f"https://api.github.com/repos/{repo}/releases",
            {"per_page": 100, "page": page},
        )
        if data is None:
            return None          # repo 404
        if not data:
            break
        out.extend(data)
        if len(data) < 100:
            break
        if not GITHUB_TOKEN:
            _time.sleep(0.15)   # be polite to unauthenticated API
    return out


def fetch_npm(package: str) -> Optional[dict]:
    try:
        r = requests.get(
            f"https://registry.npmjs.org/{package}",
            timeout=20,
            headers={"Accept": "application/json"},
        )
        return r.json() if r.ok else None
    except Exception:
        return None

# ─── Normalisation ────────────────────────────────────────────────────────────

def _dt(s: str) -> datetime:
    return datetime.fromisoformat(s.replace("Z", "+00:00"))


def normalise_github(releases_raw: list) -> list:
    out = []
    for r in releases_raw:
        if r.get("draft"):
            continue
        pub = r.get("published_at") or r.get("created_at")
        if not pub:
            continue
        tag  = r.get("tag_name", "")
        body = r.get("body") or ""
        out.append({
            "tag":      tag,
            "name":     r.get("name") or tag,
            "date":     _dt(pub),
            "cl_chars": len(body),
            "cl_lines": body.count("\n") + 1 if body else 0,
            "cl_body":  body[:800],
            "pre":      r.get("prerelease", False) or is_prerelease_tag(tag),
            "url":      r.get("html_url", ""),
            "ver_type": semver_type(tag),
        })
    out.sort(key=lambda x: x["date"])
    return out


def normalise_npm(data: dict) -> list:
    """Extract releases from npm registry (no changelog text available)."""
    time_map = data.get("time", {})
    out = []
    for ver, ts in time_map.items():
        if ver in ("created", "modified"):
            continue
        try:
            dt = _dt(ts)
        except ValueError:
            continue
        out.append({
            "tag":      ver,
            "name":     ver,
            "date":     dt,
            "cl_chars": 0,
            "cl_lines": 0,
            "cl_body":  "",
            "pre":      is_prerelease_tag(ver),
            "url":      f"https://www.npmjs.com/package/{data.get('name','')}/v/{ver}",
            "ver_type": semver_type(ver),
        })
    out.sort(key=lambda x: x["date"])
    return out

# ─── Metrics ─────────────────────────────────────────────────────────────────

def compute(releases: list, label: str, emoji: str = "") -> dict:
    """Compute the full metrics dictionary for one repo's releases."""
    if not releases:
        return {"error": "no releases", "label": label}

    pool = [r for r in releases if not r["pre"]] if ARGS.stable_only else releases
    if not pool:
        pool = releases   # fallback: don't be empty

    dates = [r["date"] for r in pool]

    # ── Gaps between consecutive releases ──
    gaps = []
    for i in range(1, len(pool)):
        h = (dates[i] - dates[i - 1]).total_seconds() / 3600
        gaps.append({
            "hours":     h,
            "from_tag":  pool[i - 1]["tag"],
            "to_tag":    pool[i]["tag"],
            "from_date": dates[i - 1],
            "to_date":   dates[i],
        })

    gap_hours = [g["hours"] for g in gaps]

    # ── Changelog sizes ──
    cl = [r["cl_chars"] for r in pool if r["cl_chars"] > 0]

    # ── Calendar distributions ──
    dow    = Counter(r["date"].strftime("%A") for r in pool)
    months = Counter(r["date"].strftime("%Y-%m") for r in pool)
    years  = Counter(r["date"].year for r in pool)

    # ── Overall cadence ──
    span_days  = max((dates[-1] - dates[0]).days, 1)
    span_weeks = span_days / 7
    per_week   = len(pool) / span_weeks

    # ── Hottest 7-day window ──
    best_streak, best_streak_start = 0, None
    for i, r in enumerate(pool):
        cutoff = r["date"] + timedelta(days=7)
        count  = sum(1 for s in pool[i:] if s["date"] <= cutoff)
        if count > best_streak:
            best_streak       = count
            best_streak_start = r["date"]

    # ── Version type breakdown ──
    vtypes = Counter(r["ver_type"] for r in releases)

    # ── Velocity: first vs second half ──
    mid        = len(pool) // 2
    first_half = pool[:mid]
    second_half= pool[mid:]
    vel_trend  = "n/a"
    vel_first  = vel_second = 0
    if len(first_half) >= 3 and len(second_half) >= 3:
        fd = max((first_half[-1]["date"] - first_half[0]["date"]).days, 1)
        sd = max((second_half[-1]["date"] - second_half[0]["date"]).days, 1)
        vel_first  = len(first_half)  / (fd / 7)
        vel_second = len(second_half) / (sd / 7)
        if vel_second > vel_first * 1.15:
            vel_trend = "accelerating"
        elif vel_second < vel_first * 0.85:
            vel_trend = "slowing"
        else:
            vel_trend = "steady"

    # ── Monthly hotspots: busiest month ──
    busiest_month = months.most_common(1)[0] if months else ("?", 0)

    return {
        "label":          f"{emoji} {label}".strip(),
        "total":          len(releases),
        "stable_count":   sum(1 for r in releases if not r["pre"]),
        "pre_count":      sum(1 for r in releases if r["pre"]),
        "first_date":     dates[0],
        "latest_date":    dates[-1],
        "span_days":      span_days,
        "per_week":       per_week,

        "gaps":           gaps,
        "fastest_gap":    min(gaps, key=lambda g: g["hours"]) if gaps else None,
        "slowest_gap":    max(gaps, key=lambda g: g["hours"]) if gaps else None,
        "avg_gap_h":      mean(gap_hours)   if gap_hours else 0,
        "median_gap_h":   median(gap_hours) if gap_hours else 0,
        "stdev_gap_h":    stdev(gap_hours)  if len(gap_hours) > 1 else 0,

        "cl_present":     bool(cl),
        "cl_max":         max(cl, default=0),
        "cl_min":         min(cl, default=0),
        "cl_avg":         mean(cl) if cl else 0,
        "cl_max_rel":     max(pool, key=lambda r: r["cl_chars"]) if cl else None,
        "cl_min_rel":     min((r for r in pool if r["cl_chars"] > 0),
                              key=lambda r: r["cl_chars"], default=None),

        "dow":            dow,
        "months":         months,
        "years":          years,
        "fav_dow":        dow.most_common(1)[0] if dow else ("?", 0),
        "busiest_month":  busiest_month,

        "streak":         best_streak,
        "streak_start":   best_streak_start,

        "vtypes":         vtypes,
        "vel_trend":      vel_trend,
        "vel_first":      vel_first,
        "vel_second":     vel_second,

        "releases":       pool,       # normalised pool (stable or all)
        "releases_raw":   releases,   # always all
    }

# ─── Formatting helpers ───────────────────────────────────────────────────────

def fmt_h(hours: float) -> str:
    """Format hours into a compact human duration."""
    if hours < 1:
        return f"{int(hours * 60)}m"
    if hours < 24:
        return f"{hours:.1f}h"
    if hours < 24 * 7:
        return f"{hours / 24:.1f}d"
    if hours < 24 * 30:
        return f"{hours / 168:.1f}wk"
    return f"{hours / 24:.0f}d"

def fmt_dt(dt: Optional[datetime]) -> str:
    return dt.strftime("%Y-%m-%d") if dt else "N/A"

def bar(val: float, maxval: float, width: int = 24) -> str:
    if maxval <= 0:
        return "░" * width
    n = round((val / maxval) * width)
    return "█" * n + "░" * (width - n)

def _sec(title: str):
    w = 64
    print()
    print(BOLD(CYAN("╔" + "═" * (w - 2) + "╗")))
    padded = f"  {title}"
    print(BOLD(CYAN("║")) + BOLD(WHITE(padded.ljust(w - 2))) + BOLD(CYAN("║")))
    print(BOLD(CYAN("╚" + "═" * (w - 2) + "╝")))

# ─── Report ───────────────────────────────────────────────────────────────────

DAYS = ["Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday", "Sunday"]

def print_report(all_m: list):
    ok = [m for m in all_m if "error" not in m]
    if not ok:
        print(RED("\nNo release data found. Check network / GITHUB_TOKEN."))
        sys.exit(1)

    # ══════════════════════════════════════════════════════════════
    print()
    print(BOLD(GREEN("╔══════════════════════════════════════════════════════════════╗")))
    print(BOLD(GREEN("║                                                              ║")))
    print(BOLD(GREEN("║            ANTHROPIC  RELEASE  ANALYTICS  📊                ║")))
    print(BOLD(GREEN("║                                                              ║")))
    print(BOLD(GREEN("╚══════════════════════════════════════════════════════════════╝")))

    # ── Summary table ────────────────────────────────────────────────────────
    _sec("📦  SUMMARY BY REPO")
    print()
    H  = ["Repo", "Total", "Stable", "Pre", "First", "Latest", "Per Wk", "Avg Gap", "Med Gap"]
    W  = [20,     6,       6,        4,     10,      10,       7,        8,         8]
    fmt = lambda cells: "  " + " │ ".join(str(c).ljust(w) for c, w in zip(cells, W))
    print(BOLD(fmt(H)))
    print("  " + "─┼─".join("─" * w for w in W))
    for m in ok:
        row = [
            m["label"][:20],
            m["total"],
            m["stable_count"],
            m["pre_count"],
            fmt_dt(m["first_date"]),
            fmt_dt(m["latest_date"]),
            f"{m['per_week']:.2f}",
            fmt_h(m["avg_gap_h"]),
            fmt_h(m["median_gap_h"]),
        ]
        print(fmt(row))

    # ── Speed records ─────────────────────────────────────────────────────────
    _sec("⚡  SPEED RECORDS")
    print()

    all_gaps = [(m["label"], g) for m in ok for g in m["gaps"]]
    if all_gaps:
        fastest  = sorted(all_gaps, key=lambda x: x[1]["hours"])[:5]
        slowest  = sorted(all_gaps, key=lambda x: x[1]["hours"], reverse=True)[:5]

        print(BOLD("  ⚡ Fastest (quickest turnaround between two consecutive releases):"))
        for i, (label, g) in enumerate(fastest):
            medal = ["🥇", "🥈", "🥉", "  ", "  "][i]
            print(f"  {medal} {CYAN(label):<28} {YELLOW(fmt_h(g['hours']))} "
                  f"  {DIM(g['from_tag'])} → {DIM(g['to_tag'])}")

        print()
        print(BOLD("  🐢 Slowest gaps (longest drought between releases):"))
        for i, (label, g) in enumerate(slowest):
            print(f"   {'😴' if i==0 else ' '} {CYAN(label):<28} {RED(fmt_h(g['hours']))} "
                  f"  {DIM(g['from_tag'])} → {DIM(g['to_tag'])}")

    # ── Changelog sizes ───────────────────────────────────────────────────────
    repos_with_cl = [m for m in ok if m["cl_present"]]
    if repos_with_cl:
        _sec("📝  CHANGELOG SIZE RECORDS")
        print()

        # Longest changelogs per repo
        print(BOLD("  📜 Biggest changelogs (most chars):"))
        biggest = sorted(repos_with_cl, key=lambda m: m["cl_max"], reverse=True)
        for i, m in enumerate(biggest[:6]):
            rel  = m["cl_max_rel"]
            date = fmt_dt(rel["date"]) if rel else "?"
            tag  = rel["tag"]         if rel else "?"
            medal = ["🏆","🥈","🥉","  ","  ","  "][i]
            cl_str = f"{m['cl_max']:,} chars"
            print(f"  {medal} {CYAN(m['label']):<28} "
                  f"{GREEN(cl_str)}  {DIM(tag)} ({date})")

        print()
        print(BOLD("  🔬 Shortest changelogs (quick patches):"))
        smallest = sorted(repos_with_cl, key=lambda m: m["cl_min"])
        for i, m in enumerate(smallest[:6]):
            rel = m["cl_min_rel"]
            tag = rel["tag"] if rel else "?"
            print(f"   {'🤏' if i==0 else '  '} {CYAN(m['label']):<28} "
                  f"{RED(str(m['cl_min']) + ' chars')}  {DIM(tag)}")

        print()
        print(BOLD("  📊 Average changelog length per repo:"))
        ranked = sorted(repos_with_cl, key=lambda m: m["cl_avg"], reverse=True)
        max_avg = ranked[0]["cl_avg"] if ranked else 1
        for m in ranked:
            b = bar(m["cl_avg"], max_avg, 28)
            print(f"  {m['label'][:22]:<22} {b}  {m['cl_avg']:.0f} chars avg")

    # ── Day-of-week distribution ───────────────────────────────────────────────
    _sec("📅  RELEASE CADENCE")
    print()

    all_dow = Counter()
    for m in ok:
        all_dow.update(m["dow"])

    print(BOLD("  📆 Day-of-week breakdown (all repos combined):"))
    max_dow = max(all_dow.values(), default=1)
    for day in DAYS:
        count   = all_dow.get(day, 0)
        weekend = " 🏖" if day in ("Saturday", "Sunday") else ""
        b       = bar(count, max_dow, 26)
        print(f"  {day[:9]:<9} {YELLOW(b)} {count:4d}{weekend}")

    print()
    print(BOLD("  🔥 Hottest week (most releases in any 7-day window):"))
    streaks = sorted(
        [(m["label"], m["streak"], m["streak_start"]) for m in ok if m["streak"] > 0],
        key=lambda x: x[1], reverse=True
    )
    for i, (label, n, start) in enumerate(streaks[:6]):
        marker = "🔥" if i == 0 else "  "
        print(f"  {marker} {CYAN(label):<28} {YELLOW(str(n))} releases "
              f"(week of {fmt_dt(start)})")

    print()
    print(BOLD("  🗓  Busiest single month per repo:"))
    for m in ok:
        mo, cnt = m["busiest_month"]
        print(f"  {m['label'][:24]:<24} {YELLOW(mo)}  ({cnt} releases that month)")

    # ── Version type breakdown ─────────────────────────────────────────────────
    _sec("🔢  VERSION TYPE BREAKDOWN")
    print()
    print(BOLD("  Releases by semver bump type (major / minor / patch / pre / unknown):"))
    for m in ok:
        vt = m["vtypes"]
        total = sum(vt.values()) or 1
        parts = []
        for k, col in [("major", RED), ("minor", YELLOW), ("patch", GREEN), ("pre", DIM), ("unknown", DIM)]:
            n = vt.get(k, 0)
            if n:
                parts.append(col(f"{k}:{n}"))
        print(f"  {m['label'][:22]:<22}  {'  '.join(parts)}")

    # ── Velocity trend ─────────────────────────────────────────────────────────
    _sec("📈  RELEASE VELOCITY")
    print()
    print(BOLD("  Releases / week (overall):"))
    max_vel = max((m["per_week"] for m in ok), default=1)
    for m in ok:
        b = bar(m["per_week"], max_vel, 28)
        print(f"  {m['label'][:22]:<22} {GREEN(b)} {m['per_week']:.2f}/wk")

    print()
    print(BOLD("  Velocity trend (first-half cadence → second-half cadence):"))
    for m in ok:
        if m["vel_trend"] == "n/a":
            continue
        if m["vel_trend"] == "accelerating":
            icon, col = "↑", GREEN
        elif m["vel_trend"] == "slowing":
            icon, col = "↓", RED
        else:
            icon, col = "→", YELLOW
        trend_str = f"{icon} {m['vel_trend']}"
        vel_str   = f"{m['vel_first']:.2f}/wk → {m['vel_second']:.2f}/wk"
        print(f"  {m['label'][:22]:<22} "
              f"{col(trend_str):<22} "
              f"{DIM(vel_str)}")

    # ── Hall of fame ───────────────────────────────────────────────────────────
    _sec("🏆  HALL OF FAME")
    print()

    most_total    = max(ok, key=lambda m: m["total"])
    fastest_pace  = max(ok, key=lambda m: m["per_week"])
    oldest        = min(ok, key=lambda m: m["first_date"])
    smallest_gaps = min(ok, key=lambda m: m["avg_gap_h"] if m["avg_gap_h"] > 0 else float("inf"))

    print(f"  🏆 Most prolific:    {BOLD(CYAN(most_total['label']))}  "
          f"→  {YELLOW(str(most_total['total']))} total releases")
    pace_str = f"{fastest_pace['per_week']:.2f}/wk"
    print(f"  ⚡ Fastest cadence:  {BOLD(CYAN(fastest_pace['label']))}  "
          f"→  {YELLOW(pace_str)}")
    print(f"  🎂 Oldest project:   {BOLD(CYAN(oldest['label']))}  "
          f"→  since {YELLOW(fmt_dt(oldest['first_date']))}")
    print(f"  🏎  Tightest cadence: {BOLD(CYAN(smallest_gaps['label']))}  "
          f"→  avg {YELLOW(fmt_h(smallest_gaps['avg_gap_h']))} between releases")

    if all_gaps:
        fastest_ever = min(all_gaps, key=lambda x: x[1]["hours"])
        slowest_ever = max(all_gaps, key=lambda x: x[1]["hours"])
        print(f"  🚀 Fastest release:  {BOLD(CYAN(fastest_ever[0]))} "
              f"{DIM(fastest_ever[1]['from_tag'])} → {DIM(fastest_ever[1]['to_tag'])} "
              f"in {YELLOW(fmt_h(fastest_ever[1]['hours']))}")
        print(f"  😴 Longest drought:  {BOLD(CYAN(slowest_ever[0]))} "
              f"({YELLOW(fmt_h(slowest_ever[1]['hours']))} gap between "
              f"{DIM(slowest_ever[1]['from_tag'])} and {DIM(slowest_ever[1]['to_tag'])})")

    if repos_with_cl:
        champion = max(repos_with_cl, key=lambda m: m["cl_avg"])
        cl_avg_str = f"{champion['cl_avg']:.0f}"
        print(f"  📝 Best changelogs:  {BOLD(CYAN(champion['label']))}  "
              f"→  {YELLOW(cl_avg_str)} chars average")

    total_all = sum(m["total"] for m in ok)
    print(f"\n  📦 Grand total: {BOLD(YELLOW(str(total_all)))} releases tracked across {len(ok)} repos")

    print()
    print(DIM("─" * 64))
    if not GITHUB_TOKEN:
        print(DIM("💡  Set GITHUB_TOKEN env var for 5 000 req/hr (vs 60 unauthenticated)"))
    if ARGS.stable_only:
        print(DIM("ℹ   --stable-only: pre-release versions excluded from gap/cadence metrics"))
    print()


# ─── Main ─────────────────────────────────────────────────────────────────────

def main():
    print()
    print(BOLD("🔍  Fetching release data..."))
    print()

    all_metrics = []
    seen_labels = set()  # avoid double-counting repos we already fetched via GitHub

    # npm packages that supplement a GitHub repo with pre-public history
    # (GitHub repo was made public later than the npm package first appeared)
    NPM_SUPPLEMENTS = {
        "Claude Code": "@anthropic-ai/claude-code",
    }

    # ── GitHub repos ─────────────────────────────────────────────────────────
    for label, repo, emoji in GITHUB_REPOS:
        print(f"  {emoji}  {label:<20} ", end="", flush=True)
        raw = fetch_github_releases(repo)
        if raw is None:
            print(DIM("repo not found — skipping"))
            continue
        if len(raw) == 0:
            print(DIM("no public releases"))
            continue
        releases = normalise_github(raw)

        # Supplement with npm history if this repo launched on npm before GitHub
        if label in NPM_SUPPLEMENTS:
            npm_pkg  = NPM_SUPPLEMENTS[label]
            npm_data = fetch_npm(npm_pkg)
            if npm_data:
                npm_releases = normalise_npm(npm_data)
                # Deduplicate: strip leading "v" for comparison, keep GitHub entry on overlap
                gh_versions = {r["tag"].lstrip("v") for r in releases}
                added = [nr for nr in npm_releases if nr["tag"].lstrip("v") not in gh_versions]
                releases = sorted(releases + added, key=lambda r: r["date"])
                print(f"  {DIM(f'(+{len(added)} npm pre-GitHub versions)')}", end="")

        m = compute(releases, label, emoji)
        all_metrics.append(m)
        seen_labels.add(label)
        tag = f"({len(releases)} releases)" if "error" not in m else "(error)"
        print(GREEN(f"  ✓  {tag}"))

    # ── npm fallback (only if GitHub releases were absent) ───────────────────
    print()
    for pkg, label, emoji in NPM_PACKAGES:
        if label in seen_labels:
            continue
        print(f"  {emoji}  {label} (npm/{pkg}): ", end="", flush=True)
        data = fetch_npm(pkg)
        if not data:
            print(DIM("not found"))
            continue
        releases = normalise_npm(data)
        if not releases:
            print(DIM("no versions"))
            continue
        m = compute(releases, f"{label} [npm]", emoji)
        all_metrics.append(m)
        print(GREEN(f"✓  ({len(releases)} versions, no changelog text)"))

    print()

    # ── Report ────────────────────────────────────────────────────────────────
    print_report(all_metrics)

    # ── Optional JSON dump ────────────────────────────────────────────────────
    if ARGS.json:
        def _serial(o):
            if isinstance(o, datetime):
                return o.isoformat()
            if isinstance(o, Counter):
                return dict(o)
            raise TypeError(type(o))

        exportable = []
        for m in all_metrics:
            if "error" in m:
                continue
            d = {k: v for k, v in m.items() if k not in ("releases", "releases_raw")}
            exportable.append(d)
        print(json.dumps(exportable, default=_serial, indent=2))


if __name__ == "__main__":
    main()
