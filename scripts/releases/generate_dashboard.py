#!/usr/bin/env python3
"""
Generate site/releases.html from release_data.json
Run from claudius/scripts/releases/:
    python3 generate_dashboard.py
Reads:  scripts/releases/release_data.json
Writes: site/releases.html
"""

import json
import calendar
import pathlib
from collections import defaultdict
from datetime import (
    date as date_cls,
    datetime as datetime_cls,
    timedelta as td_cls,
    timezone as tz_cls,
)

# ─── Paths (always relative to this script) ──────────────────────────────────
SCRIPT_DIR  = pathlib.Path(__file__).resolve().parent
DATA_FILE   = SCRIPT_DIR / "release_data.json"
SITE_DIR    = SCRIPT_DIR.parent.parent / "site"
OUTPUT_FILE = SITE_DIR / "releases.html"

with open(DATA_FILE) as f:
    repos = json.load(f)

# Anchors the time-axis (heatmap "today", predictor countdowns, spline window).
# Uses the real current date so the daily CI refresh actually advances the calendar.
TODAY = date_cls.today()

# When this snapshot was generated. Surfaced two ways:
#   - GENERATED_AT (UTC string) in the stale-data note, and
#   - GENERATED_AT_MS (epoch ms) embedded for the JS, so the Release
#     Predictor can recompute "overdue / due soon / days ago" against the
#     viewer's real clock (Date.now()) instead of freezing the status at
#     build time. The release DATA is still a snapshot, but the time-axis
#     advances as the page ages.
GENERATED_AT_DT = datetime_cls.now(tz_cls.utc)
GENERATED_AT    = GENERATED_AT_DT.strftime("%Y-%m-%d %H:%M UTC")
GENERATED_AT_MS = int(GENERATED_AT_DT.timestamp() * 1000)

# ─── Helpers ──────────────────────────────────────────────────────────────────

def pct(arr, p):
    if not arr: return 0
    s = sorted(arr)
    idx = (p / 100) * (len(s) - 1)
    lo, hi = int(idx), min(int(idx) + 1, len(s) - 1)
    return s[lo] + (idx - lo) * (s[hi] - s[lo])

def fmt_h(h):
    if h < 1:   return f"{h*60:.0f}m"
    if h < 24:  return f"{h:.1f}h"
    if h < 168: return f"{h/24:.1f}d"
    return f"{h/168:.1f}wk"

def fmt_month(ym):
    y, m = ym.split("-")
    return f"{calendar.month_abbr[int(m)]} '{y[2:]}"

# ─── Augment gaps ─────────────────────────────────────────────────────────────

for r in repos:
    gh = [g["hours"] for g in r.get("gaps", [])]
    r["_gh"] = gh
    r["gap_min_d"]  = min(gh) / 24 if gh else 0
    r["gap_p25_d"]  = pct(gh, 25)  / 24 if gh else 0
    r["gap_med_d"]  = pct(gh, 50)  / 24 if gh else 0
    r["gap_p75_d"]  = pct(gh, 75)  / 24 if gh else 0
    r["gap_max_d"]  = min(max(gh) / 24, 95) if gh else 0

# ─── Monthly timeline ─────────────────────────────────────────────────────────

all_months   = sorted(set(m for r in repos for m in r.get("months", {})))
month_labels = [fmt_month(m) for m in all_months]

def cumulative(repo):
    total, out = 0, []
    for m in all_months:
        total += repo.get("months", {}).get(m, 0)
        out.append(total)
    return out

# ─── Labels, colors, URLs ────────────────────────────────────────────────────

SHORT = {
    "🐍 Python SDK":     "Python",
    "📘 TypeScript SDK": "TypeScript",
    "☕ Java SDK":       "Java",
    "🐹 Go SDK":         "Go",
    "💎 Ruby SDK":       "Ruby",
    "🔷 C# SDK":         "C#",
    "🐘 PHP SDK":        "PHP",
    "⚡ Claude Code":    "Claude Code",
    "🤖 Agent SDK":      "Agent SDK",
    "📘 TS SDK [npm]":   "TS (npm)",
}
short = [SHORT.get(r["label"], r["label"]) for r in repos]

REPO_URLS = {
    "🐍 Python SDK":     ("https://github.com/anthropics/anthropic-sdk-python",    "github"),
    "📘 TypeScript SDK": ("https://github.com/anthropics/anthropic-sdk-typescript", "github"),
    "☕ Java SDK":       ("https://github.com/anthropics/anthropic-sdk-java",       "github"),
    "🐹 Go SDK":         ("https://github.com/anthropics/anthropic-sdk-go",         "github"),
    "💎 Ruby SDK":       ("https://github.com/anthropics/anthropic-sdk-ruby",       "github"),
    "🔷 C# SDK":         ("https://github.com/anthropics/anthropic-sdk-csharp",     "github"),
    "🐘 PHP SDK":        ("https://github.com/anthropics/anthropic-sdk-php",        "github"),
    "⚡ Claude Code":    ("https://github.com/anthropics/claude-code",              "github"),
    "🤖 Agent SDK":      ("https://github.com/anthropics/claude-agent-sdk-typescript", "github"),
    "📘 TS SDK [npm]":   ("https://www.npmjs.com/package/@anthropic-ai/sdk",        "npm"),
}

repo_links_html = " ".join(
    f'<a class="repo-link repo-link--{kind}" href="{url}" target="_blank" rel="noopener">'
    f'{SHORT.get(label, label)}</a>'
    for label, (url, kind) in REPO_URLS.items()
    if label in {r["label"] for r in repos}
)

# Claudius palette for multi-repo charts (varied, readable on dark bg)
PALETTE = [
    "#f0f0f3",  # off-white (Python — kept distinct from Claude Code's orange)
    "#60a5fa",  # blue
    "#34d399",  # emerald
    "#c084fc",  # purple
    "#f472b6",  # pink
    "#22d3ee",  # cyan
    "#fbbf24",  # amber
    "#d97757",  # terracotta orange (Claude Code hero line)
    "#86efac",  # light green
    "#a78bfa",  # violet (Agent SDK / 10th series)
]

def rgba(hex_c, a=1.0):
    h = hex_c.lstrip("#")
    r2, g2, b2 = int(h[0:2], 16), int(h[2:4], 16), int(h[4:6], 16)
    return f"rgba({r2},{g2},{b2},{a})"

colors_solid = [PALETTE[i % len(PALETTE)] for i in range(len(repos))]
colors_mid   = [rgba(c, 0.75) for c in colors_solid]
colors_soft  = [rgba(c, 0.35) for c in colors_solid]

# ─── Daily data ───────────────────────────────────────────────────────────────
# Reconstruct every release date from gaps (from_date of first gap + all to_dates)

all_daily  = defaultdict(int)
repo_daily = {}

for r in repos:
    lbl   = SHORT.get(r["label"], r["label"])
    gaps  = r.get("gaps", [])
    dates = set()
    for i, g in enumerate(gaps):
        if i == 0:
            dates.add(g["from_date"][:10])
        dates.add(g["to_date"][:10])
    latest = r.get("latest_date", "")[:10]
    if latest:
        dates.add(latest)
    rd = defaultdict(int)
    for d in dates:
        rd[d] += 1
        all_daily[d] += 1
    repo_daily[lbl] = dict(rd)

# ─── 7-day rolling sum for spline ─────────────────────────────────────────────

spline_start = (TODAY - td_cls(days=545)).isoformat()
spline_days  = sorted(d for d in all_daily if d >= spline_start)

if spline_days:
    sd = date_cls.fromisoformat(spline_days[0])
    ed = TODAY
    full_range = []
    d = sd
    while d <= ed:
        full_range.append(d.isoformat())
        d += td_cls(days=1)
else:
    full_range = []

raw_counts = [all_daily.get(d, 0) for d in full_range]

def rolling(data, w=7):
    out = []
    for i in range(len(data)):
        out.append(sum(data[max(0, i-w+1):i+1]))
    return out

smoothed_counts = rolling(raw_counts, 7)

js_spline_dates  = json.dumps(full_range)
js_spline_counts = json.dumps(smoothed_counts)

# ─── Contribution calendar (GitHub-style, last 2 years) ──────────────────────

cal_end   = TODAY
cal_start = cal_end - td_cls(days=364*2)
while cal_start.weekday() != 0:
    cal_start -= td_cls(days=1)

cal_weeks = []
d = cal_start
while d <= cal_end + td_cls(days=6):
    week = []
    for _ in range(7):
        ds = d.isoformat()
        count = all_daily.get(ds, 0)
        week.append((ds, count, d > cal_end))
        d += td_cls(days=1)
    cal_weeks.append(week)

# GitHub-standard orientation: oldest week on the left, most recent on the right.

CELL  = 17   # px — slightly wider so single-digit counts fit comfortably
GAP   = 3
DOW_W = 30

# Terracotta-scale contribution colours
def cal_color(n):
    if n == 0: return "#111114"
    if n == 1: return "#3a1a0b"
    if n == 2: return "#6b2e14"
    if n <= 4: return "#a84830"
    return "#d97757"

DOW_LABELS = ["Mon", "", "Wed", "", "Fri", "", "Sun"]

prev_month = None
month_bar_parts = [f'<div style="flex:0 0 {DOW_W}px;"></div>']
for week in cal_weeks:
    iso = week[0][0]
    m   = iso[5:7]
    if m != prev_month:
        label = calendar.month_abbr[int(m)]
        month_bar_parts.append(
            f'<div style="flex:0 0 {CELL}px;color:#6b6b75;font-size:10px;'
            f'font-weight:600;white-space:nowrap;overflow:visible;">{label}</div>'
        )
        prev_month = m
    else:
        month_bar_parts.append(f'<div style="flex:0 0 {CELL}px;"></div>')

dow_col_parts = []
for i in range(7):
    dow_col_parts.append(
        f'<div style="flex:0 0 {CELL}px;height:{CELL}px;line-height:{CELL}px;'
        f'font-size:10px;color:#6b6b75;text-align:right;padding-right:5px;">'
        f'{DOW_LABELS[i]}</div>'
    )

week_col_parts = []
for week in cal_weeks:
    day_parts = []
    for iso, count, is_future in week:
        if is_future:
            day_parts.append(
                f'<div style="width:{CELL}px;height:{CELL}px;flex:0 0 {CELL}px;"></div>'
            )
        else:
            bg   = cal_color(count)
            tip  = f"{iso}: {count} release{'s' if count != 1 else ''}" if count else iso
            text = str(count) if count > 0 else ""
            # Lighter text on the brighter top-level cell, slightly dimmer on dark ones
            tc   = "rgba(255,255,255,0.9)" if count >= 5 else "rgba(255,255,255,0.7)"
            day_parts.append(
                f'<div title="{tip}" style="width:{CELL}px;height:{CELL}px;'
                f'flex:0 0 {CELL}px;background:{bg};border-radius:2px;'
                f'cursor:default;box-sizing:content-box;'
                f'display:flex;align-items:center;justify-content:center;'
                f'font-size:9px;font-weight:700;color:{tc};line-height:1;">'
                f'{text}</div>'
            )
    week_col_parts.append(
        f'<div style="display:flex;flex-direction:column;gap:{GAP}px;flex:0 0 {CELL}px;">'
        f'{"".join(day_parts)}</div>'
    )

contrib_html = f"""
<div style="display:inline-flex;flex-direction:column;gap:5px;">
  <div style="display:flex;flex-direction:row;gap:{GAP}px;">
    {"".join(month_bar_parts)}
  </div>
  <div style="display:flex;flex-direction:row;gap:{GAP}px;">
    <div style="display:flex;flex-direction:column;gap:{GAP}px;flex:0 0 {DOW_W}px;">
      {"".join(dow_col_parts)}
    </div>
    {"".join(week_col_parts)}
  </div>
</div>
"""

# ─── Release predictor data ───────────────────────────────────────────────────

pred_data = []
for i, r in enumerate(repos):
    gaps   = r.get("gaps", [])
    latest = r.get("latest_date", "")[:10]
    if not latest or not gaps:
        continue

    last_date  = date_cls.fromisoformat(latest)
    days_since = (TODAY - last_date).days

    cutoff_30  = (TODAY - td_cls(days=30)).isoformat()
    cutoff_90  = (TODAY - td_cls(days=90)).isoformat()
    recent_30  = sum(1 for g in gaps if g["to_date"][:10] >= cutoff_30)
    recent_90  = sum(1 for g in gaps if g["to_date"][:10] >= cutoff_90)

    if recent_30 >= 2:
        release_rate_per_day = recent_30 / 30
    elif recent_90 >= 3:
        release_rate_per_day = recent_90 / 90
    else:
        release_rate_per_day = r.get("per_week", 1) / 7

    avg_gap_days   = 1 / release_rate_per_day if release_rate_per_day > 0 else 30
    pressure       = days_since / avg_gap_days
    predicted_next = last_date + td_cls(days=int(avg_gap_days))
    days_until_next = (predicted_next - TODAY).days

    spark = []
    for k in range(13, -1, -1):
        ds = (TODAY - td_cls(days=k)).isoformat()
        spark.append(repo_daily.get(SHORT.get(r["label"], r["label"]), {}).get(ds, 0))

    pred_data.append({
        "label":           SHORT.get(r["label"], r["label"]),
        "color":           PALETTE[i % len(PALETTE)],
        "latest_date":     latest,
        "days_since":      days_since,
        "avg_gap_days":    round(avg_gap_days, 1),
        "recent_30":       recent_30,
        "pressure":        round(min(pressure, 3.0), 3),
        "predicted_next":  predicted_next.isoformat(),
        "days_until_next": days_until_next,
        "total":           r["total"],
        "spark":           spark,
    })

pred_data.sort(key=lambda x: -x["pressure"])
js_pred = json.dumps(pred_data)

# ─── Monthly heatmap (pure flexbox) ──────────────────────────────────────────

MH_CELL  = 36   # legacy fixed width — cells now flex to fill the container
MH_H     = 28
MH_GAP   = 2
MH_LABEL = 90

max_monthly = max(
    (r.get("months", {}).get(m, 0) for r in repos for m in all_months),
    default=1,
)

# Terracotta monthly heat scale
def heat_bg(n):
    if n == 0: return "#131316"
    ratio = n / max_monthly
    if ratio <= 0.15: return "#2a1309"
    if ratio <= 0.35: return "#5c2b14"
    if ratio <= 0.60: return "#9d4220"
    if ratio <= 0.80: return "#bf5a2f"
    return "#d97757"

def heat_fg(n):
    if n == 0: return "#2a2a31"
    ratio = n / max_monthly
    return "#fff" if ratio > 0.3 else "#e8c4b3"

# ─── Stat cards ──────────────────────────────────────────────────────────────

total_all = sum(r["total"] for r in repos)
fastest   = max(repos, key=lambda r: r["per_week"])
prolific  = max(repos, key=lambda r: r["total"])
oldest    = min(repos, key=lambda r: r["first_date"])

all_gaps_flat = [(SHORT.get(r["label"], r["label"]), g)
                 for r in repos for g in r.get("gaps", [])]
slowest_ever  = max(all_gaps_flat, key=lambda x: x[1]["hours"]) if all_gaps_flat else None

repos_with_cl = [r for r in repos if r.get("cl_present")]
biggest_cl    = max(repos_with_cl, key=lambda r: r["cl_max"]) if repos_with_cl else None

cards = [
    ("Total Releases", f"{total_all:,}", "across all tracked repos"),
    ("Fastest Cadence",
     SHORT.get(fastest["label"], fastest["label"]),
     f"{fastest['per_week']:.1f} releases / week"),
    ("Most Prolific",
     SHORT.get(prolific["label"], prolific["label"]),
     f"{prolific['total']} total releases"),
    ("Oldest Project",
     SHORT.get(oldest["label"], oldest["label"]),
     f"since {oldest['first_date'][:10]}"),
    ("Biggest Changelog",
     SHORT.get(biggest_cl["label"], biggest_cl["label"]) if biggest_cl else "—",
     f"{biggest_cl['cl_max']:,} chars" if biggest_cl else ""),
    ("Longest Drought",
     SHORT.get(slowest_ever[0], slowest_ever[0]) if slowest_ever else "—",
     f"{fmt_h(slowest_ever[1]['hours'])}" if slowest_ever else ""),
]

cards_html = "\n".join(
    f"""<div class="stat-card">
  <div class="stat-body">
    <div class="stat-value">{value}</div>
    <div class="stat-title">{title}</div>
    <div class="stat-sub">{sub}</div>
  </div>
</div>"""
    for title, value, sub in cards
)

# ─── Monthly heatmap HTML ────────────────────────────────────────────────────

# Cells flex to share the available width so the whole grid fits on screen
# without a horizontal scrollbar.
def mh_cell(bg, fg, text, tip=""):
    tip_attr = f' title="{tip}"' if tip else ""
    return (
        f'<div{tip_attr} style="flex:1 1 0;min-width:0;height:{MH_H}px;'
        f'background:{bg};color:{fg};border-radius:4px;font-size:11px;font-weight:600;'
        f'display:flex;align-items:center;justify-content:center;cursor:default;">'
        f'{text}</div>'
    )

# Label every 3rd month so the headers stay legible at narrow cell widths.
LABEL_EVERY = 3
month_header_parts = [
    f'<div style="flex:0 0 {MH_LABEL}px;min-width:{MH_LABEL}px;"></div>'
]
for idx, m in enumerate(all_months):
    label = fmt_month(m) if idx % LABEL_EVERY == 0 else ""
    month_header_parts.append(
        f'<div style="flex:1 1 0;min-width:0;font-size:10px;'
        f'font-weight:600;color:#6b6b75;white-space:nowrap;overflow:visible;'
        f'text-align:center;padding-bottom:4px;">{label}</div>'
    )

data_row_parts = []
for i, r in enumerate(repos):
    row_cells = [
        f'<div style="flex:0 0 {MH_LABEL}px;min-width:{MH_LABEL}px;height:{MH_H}px;'
        f'display:flex;align-items:center;justify-content:flex-end;'
        f'padding-right:10px;font-size:12px;font-weight:600;color:#9a9aa3;">'
        f'{short[i]}</div>'
    ]
    for m in all_months:
        n   = r.get("months", {}).get(m, 0)
        bg  = heat_bg(n)
        fg  = heat_fg(n)
        tip = f"{short[i]} {fmt_month(m)}: {n} release{'s' if n != 1 else ''}"
        row_cells.append(mh_cell(bg, fg, str(n) if n else "", tip))
    data_row_parts.append(
        f'<div style="display:flex;flex-direction:row;gap:{MH_GAP}px;">{"".join(row_cells)}</div>'
    )

heatmap_html = f"""
<div style="display:flex;flex-direction:column;gap:{MH_GAP}px;width:100%;">
  <div style="display:flex;flex-direction:row;gap:{MH_GAP}px;">{"".join(month_header_parts)}</div>
  {"".join(data_row_parts)}
</div>
"""

# ─── JS data ─────────────────────────────────────────────────────────────────

js_short    = json.dumps(short)
js_colors   = json.dumps(colors_solid)
js_colors_m = json.dumps(colors_mid)
js_colors_s = json.dumps(colors_soft)
js_totals      = json.dumps([r["total"] for r in repos])
js_per_week    = json.dumps([round(r["per_week"], 2) for r in repos])
js_stable      = json.dumps([r["stable_count"] for r in repos])
js_pre         = json.dumps([r["pre_count"] for r in repos])
js_cl_avg      = json.dumps([round(r.get("cl_avg", 0)) for r in repos])
js_cl_max      = json.dumps([r.get("cl_max", 0) for r in repos])
js_gap_min     = json.dumps([round(r["gap_min_d"], 2) for r in repos])
js_gap_p25     = json.dumps([round(r["gap_p25_d"], 2) for r in repos])
js_gap_med     = json.dumps([round(r["gap_med_d"], 2) for r in repos])
js_gap_p75     = json.dumps([round(r["gap_p75_d"], 2) for r in repos])
js_gap_max     = json.dumps([round(r["gap_max_d"], 2) for r in repos])
js_gap_avg     = json.dumps([round(r.get("avg_gap_h", 0) / 24, 2) for r in repos])
js_vel_first   = json.dumps([round(r.get("vel_first", 0), 2) for r in repos])
js_vel_second  = json.dumps([round(r.get("vel_second", 0), 2) for r in repos])
js_vtype_major = json.dumps([r.get("vtypes", {}).get("major", 0) for r in repos])
js_vtype_minor = json.dumps([r.get("vtypes", {}).get("minor", 0) for r in repos])
js_vtype_patch = json.dumps([r.get("vtypes", {}).get("patch", 0) for r in repos])
js_vtype_pre   = json.dumps([r.get("vtypes", {}).get("pre", 0) for r in repos])
DAYS_ORDER = ["Monday","Tuesday","Wednesday","Thursday","Friday","Saturday","Sunday"]
all_dow    = {d: sum(r.get("dow", {}).get(d, 0) for r in repos) for d in DAYS_ORDER}
js_dow_labels  = json.dumps([d[:3] for d in DAYS_ORDER])
js_dow_vals    = json.dumps([all_dow[d] for d in DAYS_ORDER])
js_months      = json.dumps(month_labels)
js_cum         = json.dumps([cumulative(r) for r in repos])
js_streaks     = json.dumps([r.get("streak", 0) for r in repos])

# ─── Write HTML ───────────────────────────────────────────────────────────────

html = f"""<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8"/>
<meta name="viewport" content="width=device-width, initial-scale=1.0"/>
<title>SDK Release Analytics — Claudius</title>
<link rel="icon" href="favicon.ico" sizes="32x32"/>
<link rel="icon" type="image/png" sizes="48x48" href="favicon-48.png"/>
<link rel="icon" type="image/svg+xml" href="icon.svg"/>
<link rel="apple-touch-icon" href="apple-icon.png"/>
<script src="https://cdn.jsdelivr.net/npm/chart.js@4.4.4/dist/chart.umd.min.js"></script>
<style>
  *, *::before, *::after {{ box-sizing: border-box; margin: 0; padding: 0; }}
  :root {{
    --bg:      #0b0b0c;
    --surface: #0e0e10;
    --card:    #131316;
    --card2:   #1a1a1f;
    --border:  #2a2a31;
    --text:    #e7e7ea;
    --muted:   #9a9aa3;
    --accent:  #d97757;
  }}
  html {{ scroll-behavior: smooth; background: var(--bg); }}
  body {{
    background: var(--bg);
    color: var(--text);
    font-family: ui-sans-serif, system-ui, -apple-system, "Segoe UI", Inter, sans-serif;
    font-size: 14px;
    line-height: 1.5;
    padding: 0 0 80px;
  }}

  /* ── Header ── */
  header {{
    background: linear-gradient(135deg, #0b0b0c 0%, #1c0f08 50%, #0b0b0c 100%);
    border-bottom: 1px solid #2a2a31;
    padding: 36px 40px 28px;
    position: relative;
    overflow: hidden;
  }}
  header::before {{
    content: "";
    position: absolute; inset: 0;
    background: radial-gradient(ellipse at 60% 40%, rgba(217,119,87,0.12) 0%, transparent 65%);
    pointer-events: none;
  }}
  .header-inner {{ position: relative; z-index: 1; }}
  .header-nav {{
    display: flex; align-items: center; gap: 6px; margin-bottom: 24px;
  }}
  .header-nav a {{
    font-size: 0.8rem; color: var(--muted); text-decoration: none;
    transition: color 0.15s;
  }}
  .header-nav a:hover {{ color: var(--text); }}
  .header-nav span {{ color: #3a3a42; font-size: 0.8rem; }}
  header h1 {{
    font-size: 2rem; font-weight: 700; letter-spacing: -0.025em;
    background: linear-gradient(90deg, #e7e7ea 30%, #d97757 70%, #e8a98d 100%);
    -webkit-background-clip: text; -webkit-text-fill-color: transparent; background-clip: text;
  }}
  header p {{ color: var(--muted); margin-top: 6px; font-size: 0.9rem; }}
  .stale-note {{
    color: #e8a98d; margin-top: 8px; font-size: 0.8rem;
    background: rgba(217,119,87,0.08); border: 1px solid rgba(217,119,87,0.22);
    border-radius: 8px; padding: 6px 12px; display: inline-block;
  }}
  .badge {{
    display: inline-block; background: rgba(217,119,87,0.15);
    border: 1px solid rgba(217,119,87,0.35); color: #d97757;
    border-radius: 999px; padding: 2px 10px; font-size: 0.72rem;
    margin-left: 10px; vertical-align: middle; font-weight: 600; letter-spacing: 0.05em;
  }}
  .repo-links {{ display: flex; flex-wrap: wrap; gap: 7px; margin-top: 18px; }}
  .repo-link {{
    display: inline-flex; align-items: center; gap: 4px;
    border-radius: 6px; padding: 4px 11px; font-size: 0.78rem; font-weight: 500;
    text-decoration: none; transition: opacity 0.15s, transform 0.15s;
  }}
  .repo-link:hover {{ opacity: 0.8; transform: translateY(-1px); }}
  .repo-link--github {{
    background: rgba(255,255,255,0.05); border: 1px solid rgba(255,255,255,0.10); color: #c0c0c8;
  }}
  .repo-link--github::before {{ content: "⎇"; margin-right: 2px; opacity: 0.5; }}
  .repo-link--npm {{
    background: rgba(217,119,87,0.10); border: 1px solid rgba(217,119,87,0.25); color: #d97757;
  }}
  .repo-link--npm::before {{ content: "⬡"; margin-right: 2px; opacity: 0.65; }}

  /* ── Layout ── */
  .page {{ max-width: 1400px; margin: 0 auto; padding: 0 24px; }}
  .section-title {{
    font-size: 0.7rem; font-weight: 700; text-transform: uppercase;
    letter-spacing: 0.09em; color: var(--muted); margin: 36px 0 14px;
    display: flex; align-items: center; gap: 8px;
  }}
  .section-title::after {{
    content: ""; flex: 1; height: 1px; background: var(--border);
  }}

  /* ── Stat cards ── */
  .stat-grid {{
    display: grid; grid-template-columns: repeat(auto-fit, minmax(200px, 1fr));
    gap: 12px; margin: 24px 0;
  }}
  .stat-card {{
    background: var(--card); border: 1px solid var(--border); border-radius: 10px;
    padding: 16px 18px; display: flex; gap: 13px; align-items: flex-start;
    transition: border-color 0.2s, transform 0.15s;
  }}
  .stat-card:hover {{ border-color: var(--accent); transform: translateY(-2px); }}
  .stat-icon {{ font-size: 1.5rem; line-height: 1; padding-top: 2px; }}
  .stat-value {{ font-size: 1.1rem; font-weight: 700; color: var(--text); }}
  .stat-title {{
    font-size: 0.75rem; color: var(--muted); text-transform: uppercase;
    letter-spacing: 0.05em; margin-top: 2px;
  }}
  .stat-sub {{ font-size: 0.82rem; color: var(--accent); margin-top: 3px; opacity: 0.85; }}

  /* ── Chart grid ── */
  .chart-grid {{ display: grid; gap: 14px; }}
  .chart-grid.cols-2 {{ grid-template-columns: 1fr 1fr; }}
  .chart-grid.cols-1 {{ grid-template-columns: 1fr; }}
  .chart-card {{
    background: var(--card); border: 1px solid var(--border); border-radius: 10px;
    padding: 18px 20px 14px; position: relative;
  }}
  .chart-card.wide {{ grid-column: 1 / -1; }}
  .chart-card h3 {{
    font-size: 0.78rem; font-weight: 600; color: var(--muted);
    text-transform: uppercase; letter-spacing: 0.06em; margin-bottom: 14px;
  }}
  .chart-card canvas {{ display: block; }}

  /* ── Activity Pulse (spline) ── */
  .pulse-card {{
    background: var(--surface);
    border: 1px solid var(--border);
    border-radius: 10px;
    padding: 0;
    overflow: hidden;
    position: relative;
  }}
  .pulse-header {{
    display: flex; justify-content: space-between; align-items: center;
    padding: 14px 20px 10px;
  }}
  .pulse-header h3 {{
    font-size: 0.78rem; font-weight: 600; color: var(--muted);
    text-transform: uppercase; letter-spacing: 0.06em;
  }}
  .pulse-stat {{
    font-size: 0.78rem; color: var(--accent); font-weight: 600;
  }}

  /* ── Release predictor ── */
  .pred-top-row {{
    display: flex;
    justify-content: center;
    flex-wrap: wrap;
    gap: 11px;
    margin-bottom: 11px;
  }}
  .pred-top-row .pred-card {{
    width: 320px;
    max-width: 100%;
  }}
  .pred-grid {{
    display: grid;
    grid-template-columns: repeat(auto-fill, minmax(280px, 1fr));
    gap: 11px;
  }}
  .pred-card {{
    background: var(--card); border: 1px solid var(--border);
    border-radius: 10px; padding: 14px 16px;
    transition: border-color 0.2s;
  }}
  .pred-card:hover {{ border-color: var(--accent); }}
  .pred-top {{
    display: flex; justify-content: space-between; align-items: center;
    margin-bottom: 10px;
  }}
  .pred-name {{ font-weight: 700; font-size: 0.95rem; }}
  .pred-badge {{
    font-size: 0.68rem; font-weight: 700; border-radius: 999px;
    padding: 2px 9px; letter-spacing: 0.03em;
  }}
  .pred-badge.green  {{ background: rgba(34,197,94,0.12);  color: #4ade80; border: 1px solid rgba(34,197,94,0.25);  }}
  .pred-badge.yellow {{ background: rgba(234,179,8,0.12);  color: #fbbf24; border: 1px solid rgba(234,179,8,0.25);  }}
  .pred-badge.orange {{ background: rgba(217,119,87,0.15); color: #d97757; border: 1px solid rgba(217,119,87,0.3);  }}
  .pred-badge.red    {{ background: rgba(239,68,68,0.12);  color: #f87171; border: 1px solid rgba(239,68,68,0.25);  }}
  .pred-meta {{ font-size: 0.77rem; color: var(--muted); margin-bottom: 8px; line-height: 1.65; }}
  .pred-meta strong {{ color: var(--text); }}
  .pred-bar-bg {{
    background: var(--bg); border-radius: 999px; height: 5px;
    overflow: hidden; margin: 6px 0 4px;
  }}
  .pred-bar-fill {{ height: 100%; border-radius: 999px; transition: width 0.3s; }}
  .pred-pressure {{
    font-size: 0.7rem; color: var(--muted);
    display: flex; justify-content: space-between;
  }}
  .pred-spark {{ margin-top: 10px; }}

  /* ── Contribution calendar ── */
  .cal-wrap {{ overflow-x: auto; padding-bottom: 4px; }}

  /* ── Monthly heatmap ── */
  .hm-wrap {{ padding-bottom: 4px; }}
  .hm-legend {{
    display: flex; align-items: center; gap: 8px; margin-top: 14px;
    font-size: 0.74rem; color: var(--muted);
  }}
  .hm-legend span {{ width: 20px; height: 15px; border-radius: 3px; display: inline-block; }}

  /* ── Footer ── */
  footer {{
    text-align: center; padding: 32px 24px 0;
    font-size: 0.78rem; color: #3a3a42;
    border-top: 1px solid var(--border); margin-top: 56px;
  }}
  footer a {{ color: #6b6b75; text-decoration: none; }}
  footer a:hover {{ color: var(--muted); }}

  /* ── Responsive ── */
  @media (max-width: 900px) {{
    .chart-grid.cols-2 {{ grid-template-columns: 1fr; }}
    .pred-grid {{ grid-template-columns: 1fr; }}
  }}
  @media (max-width: 600px) {{
    header {{ padding: 20px; }}
    header h1 {{ font-size: 1.5rem; }}
    .page {{ padding: 0 12px; }}
  }}
</style>
</head>
<body>

<header>
  <div class="header-inner">
    <nav class="header-nav">
      <a href="/">Claudius</a>
      <span>/</span>
      <a href="/releases.html">SDK Releases</a>
    </nav>
    <h1>SDK Release Analytics <span class="badge">Snapshot</span></h1>
    <p>Release cadence, changelog depth, velocity trends &amp; version breakdown across all Anthropic SDKs and Claude Code</p>
    <p class="stale-note">⚠ These are stale numbers — this page is a snapshot that only refreshes when Claudius redeploys, not in real time. Last regenerated {GENERATED_AT}.</p>
    <div class="repo-links">
      {repo_links_html}
    </div>
  </div>
</header>

<div class="page">

  <!-- ── Stat cards ── -->
  <div class="section-title">Highlights</div>
  <div class="stat-grid">{cards_html}</div>

  <!-- ── Activity Pulse ── -->
  <div class="section-title">Activity Pulse</div>
  <div class="pulse-card">
    <div class="pulse-header">
      <h3>Daily release activity — 7-day rolling sum, all repos</h3>
      <span class="pulse-stat" id="pulse-peak-label"></span>
    </div>
    <canvas id="pulse" height="90"></canvas>
  </div>

  <!-- ── Release Predictor ── -->
  <div class="section-title">Release Predictor</div>
  <div class="pred-top-row" id="pred-grid-top"></div>
  <div class="pred-grid" id="pred-grid"></div>

  <!-- ── Daily contribution calendar ── -->
  <div class="section-title">Daily Release Heatmap — last 2 years</div>
  <div class="chart-card">
    <h3>Releases per day across all repos (hover for details)</h3>
    <div class="cal-wrap">
      {contrib_html}
    </div>
    <div style="display:flex;align-items:center;gap:6px;margin-top:12px;font-size:0.74rem;color:#6b6b75;">
      Less
      <span style="display:inline-block;width:17px;height:17px;background:#111114;border-radius:2px;border:1px solid #2a2a31;"></span>
      <span style="display:inline-block;width:17px;height:17px;background:#3a1a0b;border-radius:2px;"></span>
      <span style="display:inline-block;width:17px;height:17px;background:#6b2e14;border-radius:2px;"></span>
      <span style="display:inline-block;width:17px;height:17px;background:#a84830;border-radius:2px;"></span>
      <span style="display:inline-block;width:17px;height:17px;background:#d97757;border-radius:2px;"></span>
      More
    </div>
  </div>

  <!-- ── Timeline ── -->
  <div class="section-title">Cumulative Releases Over Time</div>
  <div class="chart-grid cols-1">
    <div class="chart-card">
      <h3>Cumulative releases — all repos</h3>
      <canvas id="timeline" height="100"></canvas>
    </div>
  </div>

  <!-- ── Volume + velocity ── -->
  <div class="section-title">Volume &amp; Cadence</div>
  <div class="chart-grid cols-2">
    <div class="chart-card">
      <h3>Total releases by repo</h3>
      <canvas id="totals" height="220"></canvas>
    </div>
    <div class="chart-card">
      <h3>Releases per week (lifetime avg)</h3>
      <canvas id="velocity" height="220"></canvas>
    </div>
  </div>

  <!-- ── Version types + Day of week ── -->
  <div class="section-title">Release Composition &amp; Timing</div>
  <div class="chart-grid cols-2">
    <div class="chart-card">
      <h3>Version type breakdown</h3>
      <canvas id="vtypes" height="220"></canvas>
    </div>
    <div class="chart-card">
      <h3>Day-of-week distribution (all repos)</h3>
      <canvas id="dow" height="220"></canvas>
    </div>
  </div>

  <!-- ── Gap + Changelogs ── -->
  <div class="section-title">Gap Distribution &amp; Changelog Depth</div>
  <div class="chart-grid cols-2">
    <div class="chart-card">
      <h3>Time between releases — box plot (days)</h3>
      <canvas id="gaps" height="260"></canvas>
    </div>
    <div class="chart-card">
      <h3>Changelog size — avg vs max (chars)</h3>
      <canvas id="changelogs" height="260"></canvas>
    </div>
  </div>

  <!-- ── Velocity trend + Streaks ── -->
  <div class="section-title">Velocity Trend &amp; Streaks</div>
  <div class="chart-grid cols-2">
    <div class="chart-card">
      <h3>Velocity trend — first half vs second half (/wk)</h3>
      <canvas id="veltrend" height="240"></canvas>
    </div>
    <div class="chart-card">
      <h3>Hottest 7-day streak (max releases in any week)</h3>
      <canvas id="streaks" height="240"></canvas>
    </div>
  </div>

  <!-- ── Monthly heatmap ── -->
  <div class="section-title">Monthly Release Heatmap</div>
  <div class="chart-card">
    <h3>Releases per month — per repo</h3>
    <div class="hm-wrap">{heatmap_html}</div>
    <div class="hm-legend">
      <span>Scale:</span>
      <span style="background:#131316;border:1px solid #2a2a31;"></span>0
      <span style="background:#2a1309;"></span>1–2
      <span style="background:#5c2b14;"></span>3–6
      <span style="background:#bf5a2f;"></span>7–12
      <span style="background:#d97757;"></span>13+
    </div>
  </div>

</div>

<footer>
  Data fetched from GitHub Releases &amp; npm registry ·
  <a href="https://github.com/anthropics" target="_blank" rel="noopener">Anthropic on GitHub</a> ·
  Part of <a href="/">Claudius</a>
</footer>

<script>
// ── Embedded data ──────────────────────────────────────────────────────────
const LABELS     = {js_short};
const COLORS     = {js_colors};
const COLORS_MID = {js_colors_m};
const COLORS_SFT = {js_colors_s};
const totals     = {js_totals};
const perWeek    = {js_per_week};
const stable     = {js_stable};
const pre        = {js_pre};
const clAvg      = {js_cl_avg};
const clMax      = {js_cl_max};
const gapMin     = {js_gap_min};
const gapP25     = {js_gap_p25};
const gapMed     = {js_gap_med};
const gapP75     = {js_gap_p75};
const gapMax     = {js_gap_max};
const gapAvg     = {js_gap_avg};
const velFirst   = {js_vel_first};
const velSecond  = {js_vel_second};
const vMajor     = {js_vtype_major};
const vMinor     = {js_vtype_minor};
const vPatch     = {js_vtype_patch};
const vPre       = {js_vtype_pre};
const dowLabels  = {js_dow_labels};
const dowVals    = {js_dow_vals};
const monthLabels= {js_months};
const cumData    = {js_cum};
const streaks    = {js_streaks};
const SPLINE_DATES  = {js_spline_dates};
const SPLINE_COUNTS = {js_spline_counts};
const PRED_DATA     = {js_pred};
const GENERATED_AT_MS = {GENERATED_AT_MS};

// ── Chart defaults ─────────────────────────────────────────────────────────
Chart.defaults.color          = '#9a9aa3';
Chart.defaults.borderColor    = '#2a2a31';
Chart.defaults.font.family    = "ui-sans-serif, system-ui, -apple-system, 'Segoe UI', sans-serif";
Chart.defaults.font.size      = 12;
Chart.defaults.plugins.legend.labels.boxWidth = 12;
Chart.defaults.plugins.legend.labels.padding  = 16;
const GRID  = {{ color: 'rgba(255,255,255,0.04)' }};
const TICKS = {{ color: '#6b6b75' }};

// ── 0. Activity Pulse spline (terracotta) ──────────────────────────────────
(function() {{
  const canvas = document.getElementById('pulse');
  const ctx    = canvas.getContext('2d');

  function buildGradient() {{
    const h = canvas.offsetHeight || 90;
    const g = ctx.createLinearGradient(0, 0, 0, h);
    g.addColorStop(0,   'rgba(217,119,87,0.55)');
    g.addColorStop(0.55,'rgba(217,119,87,0.14)');
    g.addColorStop(1,   'rgba(217,119,87,0.0)');
    return g;
  }}

  const N = Math.ceil(SPLINE_DATES.length / 14);
  const tickLabels = SPLINE_DATES.map((d, i) => {{
    if (i % N !== 0) return '';
    const dt = new Date(d);
    return dt.toLocaleDateString('en-US', {{ month: 'short', year: '2-digit' }});
  }});

  const peak    = Math.max(...SPLINE_COUNTS);
  const peakIdx = SPLINE_COUNTS.indexOf(peak);
  document.getElementById('pulse-peak-label').textContent =
    'Peak: ' + peak + ' releases · week of ' + SPLINE_DATES[peakIdx];

  const chart = new Chart(ctx, {{
    type: 'line',
    data: {{
      labels: SPLINE_DATES,
      datasets: [{{
        data: SPLINE_COUNTS,
        borderColor: '#d97757',
        borderWidth: 1.5,
        backgroundColor: buildGradient(),
        fill: true,
        tension: 0.4,
        pointRadius: 0,
        pointHoverRadius: 4,
        pointHoverBackgroundColor: '#d97757',
      }}]
    }},
    options: {{
      responsive: true,
      maintainAspectRatio: true,
      interaction: {{ mode: 'index', intersect: false }},
      plugins: {{
        legend: {{ display: false }},
        tooltip: {{
          backgroundColor: 'rgba(11,11,12,0.95)',
          borderColor: '#2a2a31',
          borderWidth: 1,
          callbacks: {{
            title: ctx => ctx[0].label,
            label: ctx => ` ${{ctx.raw}} releases (7-day sum)`,
          }}
        }}
      }},
      scales: {{
        x: {{
          grid: {{ color: 'rgba(255,255,255,0.02)' }},
          ticks: {{ color: '#4a4a54', maxTicksLimit: 14, maxRotation: 0,
            callback: (val, i) => tickLabels[i] || ''
          }},
          border: {{ color: 'transparent' }},
        }},
        y: {{
          grid: {{ color: 'rgba(255,255,255,0.03)' }},
          ticks: {{ color: '#4a4a54', maxTicksLimit: 4 }},
          border: {{ color: 'transparent' }},
          min: 0,
        }},
      }}
    }}
  }});

  window.addEventListener('resize', () => {{
    chart.data.datasets[0].backgroundColor = buildGradient();
    chart.update('none');
  }});
}})();

// ── 1. Release Predictor cards ─────────────────────────────────────────────
(function() {{
  const grid    = document.getElementById('pred-grid');
  const topGrid = document.getElementById('pred-grid-top');

  // Claude Code + Agent SDK get their own centered row on top.
  const TOP_LABELS = ['Claude Code', 'Agent SDK'];
  const topData  = TOP_LABELS.map(l => PRED_DATA.find(r => r.label === l)).filter(Boolean);
  const restData = PRED_DATA.filter(r => !TOP_LABELS.includes(r.label));

  // ── Live recompute ──────────────────────────────────────────────────
  // The page is a snapshot; its release DATA is frozen at build time. But
  // "overdue / due soon / days ago / pressure" are time-relative, so we
  // advance them by the real elapsed time since the page was generated,
  // using the embedded build epoch and the viewer's Date.now(). Clamp to
  // >= 0 so a viewer clock running behind the build clock can't UNDERshoot
  // the build-time status.
  const elapsedDays  = Math.max(0, (Date.now() - GENERATED_AT_MS) / 86400000);
  const livePressure = r => Math.min((r.days_since + elapsedDays) / r.avg_gap_days, 3.0);

  // Re-rank the lower grid by LIVE pressure (most overdue first): uniform
  // elapsed time lifts shorter-cadence repos faster, so the order can
  // legitimately drift from the build-time sort as the page ages. The top
  // row (Claude Code, Agent SDK) stays pinned in its fixed order.
  restData.sort((a, b) => livePressure(b) - livePressure(a));

  function pressureColor(p) {{
    if (p < 0.5)  return ['green',  '🟢 Just released'];
    if (p < 0.85) return ['green',  '✅ On track'];
    if (p < 1.0)  return ['yellow', '🕐 Due soon'];
    if (p < 1.5)  return ['orange', '⏰ Overdue'];
    return              ['red',    '🔴 Long overdue'];
  }}

  function barColor(p) {{
    if (p < 0.7)  return '#22c55e';
    if (p < 1.0)  return '#eab308';
    if (p < 1.5)  return '#d97757';
    return '#ef4444';
  }}

  function fmtDate(iso) {{
    if (!iso) return '—';
    const d = new Date(iso);
    return d.toLocaleDateString('en-US', {{ month: 'short', day: 'numeric', year: 'numeric' }});
  }}

  function renderCard(r, container) {{
    // Live values (advanced by elapsedDays) — NOT the frozen build-time
    // r.pressure / r.days_since / r.days_until_next.
    const pressure   = livePressure(r);
    const daysSince  = Math.floor(r.days_since + elapsedDays);
    const daysToNext = Math.round(r.days_until_next - elapsedDays);
    const [badgeClass, badgeText] = pressureColor(pressure);
    const barPct  = Math.min(pressure * 100, 100).toFixed(1);
    const bColor  = barColor(pressure);
    const daysSinceStr = daysSince <= 0 ? 'today' :
                         daysSince === 1 ? '1 day ago' :
                         daysSince + ' days ago';
    const nextStr = daysToNext < 0
      ? 'was ' + Math.abs(daysToNext) + 'd ago'
      : daysToNext === 0 ? 'today!'
      : 'in ~' + daysToNext + 'd (' + fmtDate(r.predicted_next) + ')';

    const sparkId = 'spark-' + r.label.replace(/[^a-z0-9]/gi, '_');

    const card = document.createElement('div');
    card.className = 'pred-card';
    card.innerHTML = `
      <div class="pred-top">
        <span class="pred-name" style="color:${{r.color}}">${{r.label}}</span>
        <span class="pred-badge ${{badgeClass}}">${{badgeText}}</span>
      </div>
      <div class="pred-meta">
        <strong>Last release:</strong> ${{fmtDate(r.latest_date)}} (${{daysSinceStr}})<br>
        <strong>Cadence:</strong> every ~${{r.avg_gap_days}}d &nbsp;·&nbsp; ${{r.recent_30}} releases last 30d<br>
        <strong>Next expected:</strong> ${{nextStr}}
      </div>
      <div class="pred-bar-bg">
        <div class="pred-bar-fill" style="width:${{barPct}}%;background:${{bColor}};"></div>
      </div>
      <div class="pred-pressure">
        <span>Release pressure</span>
        <span style="color:${{bColor}};font-weight:600;">${{(pressure * 100).toFixed(0)}}%</span>
      </div>
      <div class="pred-spark">
        <canvas id="${{sparkId}}" height="28" style="width:100%;display:block;"></canvas>
      </div>`;
    container.appendChild(card);

    requestAnimationFrame(() => {{
      const sc   = document.getElementById(sparkId);
      if (!sc) return;
      const sctx = sc.getContext('2d');
      const sg   = sctx.createLinearGradient(0, 0, 0, 28);
      sg.addColorStop(0, r.color + 'aa');
      sg.addColorStop(1, r.color + '11');
      new Chart(sctx, {{
        type: 'line',
        data: {{
          labels: r.spark.map((_, i) => (i - 13) + 'd'),
          datasets: [{{
            data: r.spark,
            borderColor: r.color,
            borderWidth: 1.5,
            backgroundColor: sg,
            fill: true,
            tension: 0.4,
            pointRadius: 0,
          }}]
        }},
        options: {{
          responsive: false,
          plugins: {{ legend: {{ display: false }}, tooltip: {{ enabled: false }} }},
          animation: false,
          scales: {{ x: {{ display: false }}, y: {{ display: false, min: 0 }} }}
        }}
      }});
    }});
  }}

  topData.forEach(r => renderCard(r, topGrid));
  restData.forEach(r => renderCard(r, grid));
}})();

// ── 2. Timeline ─────────────────────────────────────────────────────────────
// On hover, draw each line's name directly on it (at the hovered point) so
// every series is identifiable without scanning the legend.
const timelineLabels = {{
  id: 'timelineLabels',
  afterDatasetsDraw(chart) {{
    const active = chart.getActiveElements();
    if (!active || !active.length) return;
    const ctx  = chart.ctx;
    const area = chart.chartArea;
    const padX = 5, h = 16;
    ctx.save();
    ctx.font = "700 11px ui-sans-serif, system-ui, -apple-system, 'Segoe UI', sans-serif";
    ctx.textBaseline = 'middle';
    active.forEach(a => {{
      const meta = chart.getDatasetMeta(a.datasetIndex);
      if (meta.hidden) return;
      const ds = chart.data.datasets[a.datasetIndex];
      const pt = meta.data[a.index];
      if (!pt) return;
      const text = ds.label;
      const w = ctx.measureText(text).width;
      // place to the right of the point, flip to the left near the edge
      let x, align;
      if (pt.x + 10 + w + padX * 2 < area.right) {{
        x = pt.x + 10; align = 'left';
      }} else {{
        x = pt.x - 10; align = 'right';
      }}
      ctx.textAlign = align;
      const bx = align === 'left' ? x - padX : x - w - padX;
      ctx.fillStyle = 'rgba(11,11,12,0.85)';
      ctx.beginPath();
      ctx.roundRect(bx, pt.y - h / 2, w + padX * 2, h, 4);
      ctx.fill();
      ctx.fillStyle = ds.borderColor;
      ctx.fillText(text, x, pt.y);
    }});
    ctx.restore();
  }}
}};

new Chart(document.getElementById('timeline'), {{
  type: 'line',
  plugins: [timelineLabels],
  data: {{
    labels: monthLabels,
    datasets: LABELS.map((lbl, i) => ({{
      label: lbl,
      data: cumData[i],
      borderColor: COLORS[i],
      backgroundColor: 'transparent',
      borderWidth: 2, pointRadius: 0, pointHoverRadius: 5, tension: 0.35,
    }}))
  }},
  options: {{
    responsive: true,
    layout: {{ padding: {{ top: 14 }} }},
    interaction: {{ mode: 'index', intersect: false }},
    plugins: {{
      legend: {{ position: 'right', labels: {{ font: {{ size: 11 }} }} }},
      tooltip: {{
        callbacks: {{
          title: ctx => 'Through ' + ctx[0].label,
          label: ctx => ` ${{ctx.dataset.label}}: ${{ctx.raw}} total`,
        }}
      }}
    }},
    scales: {{
      x: {{ grid: GRID, ticks: {{ ...TICKS, maxTicksLimit: 18, maxRotation: 0 }} }},
      y: {{ grid: GRID, ticks: TICKS, title: {{ display: true, text: 'Cumulative releases', color: '#6b6b75' }} }},
    }}
  }}
}});

// ── 3. Total releases ───────────────────────────────────────────────────────
(function() {{
  const order = totals.map((v, i) => i).sort((a, b) => totals[b] - totals[a]);
  new Chart(document.getElementById('totals'), {{
    type: 'bar',
    data: {{
      labels: order.map(i => LABELS[i]),
      datasets: [
        {{ label: 'Stable',      data: order.map(i => stable[i]), backgroundColor: order.map(i => COLORS_MID[i]), borderColor: order.map(i => COLORS[i]), borderWidth: 1, borderRadius: 4 }},
        {{ label: 'Pre-release', data: order.map(i => pre[i]),    backgroundColor: 'rgba(154,154,163,0.25)', borderColor: 'rgba(154,154,163,0.45)', borderWidth: 1, borderRadius: 4 }},
      ]
    }},
    options: {{
      responsive: true, plugins: {{ legend: {{ position: 'top' }} }},
      scales: {{
        x: {{ stacked: true, grid: GRID, ticks: {{ ...TICKS, maxRotation: 30 }} }},
        y: {{ stacked: true, grid: GRID, ticks: TICKS }},
      }}
    }}
  }});
}})();

// ── 4. Per-week velocity ────────────────────────────────────────────────────
(function() {{
  const order = perWeek.map((v, i) => i).sort((a, b) => perWeek[b] - perWeek[a]);
  new Chart(document.getElementById('velocity'), {{
    type: 'bar',
    data: {{
      labels: order.map(i => LABELS[i]),
      datasets: [{{ label: 'Releases / week', data: order.map(i => perWeek[i]), backgroundColor: order.map(i => COLORS_MID[i]), borderColor: order.map(i => COLORS[i]), borderWidth: 1, borderRadius: 4 }}]
    }},
    options: {{
      responsive: true, plugins: {{ legend: {{ display: false }} }},
      scales: {{
        x: {{ grid: GRID, ticks: {{ ...TICKS, maxRotation: 30 }} }},
        y: {{ grid: GRID, ticks: TICKS, title: {{ display: true, text: 'releases / week', color: '#6b6b75' }} }},
      }}
    }}
  }});
}})();

// ── 5. Version types ─────────────────────────────────────────────────────────
new Chart(document.getElementById('vtypes'), {{
  type: 'bar',
  data: {{
    labels: LABELS,
    datasets: [
      {{ label: 'Major', data: vMajor, backgroundColor: 'rgba(239,68,68,0.75)',   borderRadius: 3 }},
      {{ label: 'Minor', data: vMinor, backgroundColor: 'rgba(251,191,36,0.75)',  borderRadius: 3 }},
      {{ label: 'Patch', data: vPatch, backgroundColor: 'rgba(52,211,153,0.75)',  borderRadius: 3 }},
      {{ label: 'Pre',   data: vPre,   backgroundColor: 'rgba(154,154,163,0.4)', borderRadius: 3 }},
    ]
  }},
  options: {{
    responsive: true, plugins: {{ legend: {{ position: 'top' }} }},
    scales: {{
      x: {{ stacked: true, grid: GRID, ticks: {{ ...TICKS, maxRotation: 30 }} }},
      y: {{ stacked: true, grid: GRID, ticks: TICKS }},
    }}
  }}
}});

// ── 6. Day of week ──────────────────────────────────────────────────────────
new Chart(document.getElementById('dow'), {{
  type: 'bar',
  data: {{
    labels: dowLabels,
    datasets: [{{
      label: 'Releases', data: dowVals,
      backgroundColor: dowVals.map((_, i) => i >= 5 ? 'rgba(154,154,163,0.3)' : 'rgba(217,119,87,0.7)'),
      borderColor:      dowVals.map((_, i) => i >= 5 ? '#6b6b75' : '#d97757'),
      borderWidth: 1, borderRadius: 5,
    }}]
  }},
  options: {{
    responsive: true,
    plugins: {{ legend: {{ display: false }}, tooltip: {{ callbacks: {{ label: ctx => ` ${{ctx.raw}} releases` }} }} }},
    scales: {{
      x: {{ grid: GRID, ticks: TICKS }},
      y: {{ grid: GRID, ticks: TICKS, title: {{ display: true, text: 'releases', color: '#6b6b75' }} }},
    }}
  }}
}});

// ── 7. Gap box-plot ──────────────────────────────────────────────────────────
(function() {{
  const order = gapMed.map((v,i) => i).sort((a,b) => gapMed[a] - gapMed[b]);
  new Chart(document.getElementById('gaps'), {{
    type: 'bar',
    data: {{
      labels: order.map(i => LABELS[i]),
      datasets: [
        {{ label: 'Min→Max range', data: order.map(i => [gapMin[i], gapMax[i]]), backgroundColor: order.map(i => COLORS_SFT[i]), borderColor: order.map(i => COLORS_SFT[i]), borderWidth: 1, borderRadius: 2, barThickness: 18 }},
        {{ label: 'Q1→Q3 (IQR)',   data: order.map(i => [gapP25[i], gapP75[i]]), backgroundColor: order.map(i => COLORS_MID[i]), borderColor: order.map(i => COLORS[i]),     borderWidth: 1, borderRadius: 2, barThickness: 10 }},
        {{ label: 'Median', type: 'scatter', data: order.map((origI, ci) => ({{ x: ci, y: gapMed[origI] }})), backgroundColor: '#e7e7ea', borderColor: '#e7e7ea', pointRadius: 4, pointStyle: 'rectRot' }},
      ]
    }},
    options: {{
      responsive: true, interaction: {{ mode: 'index', intersect: false }},
      plugins: {{
        legend: {{ position: 'top' }},
        tooltip: {{ callbacks: {{ label: ctx => {{
          if (ctx.datasetIndex === 2) return ` Median: ${{ctx.parsed.y.toFixed(1)}}d`;
          const [lo, hi] = ctx.raw;
          return ` ${{ctx.dataset.label}}: ${{lo.toFixed(1)}}d – ${{hi.toFixed(1)}}d`;
        }} }} }}
      }},
      scales: {{
        x: {{ grid: GRID, ticks: {{ ...TICKS, maxRotation: 30 }}, stacked: false }},
        y: {{ grid: GRID, ticks: TICKS, title: {{ display: true, text: 'days between releases', color: '#6b6b75' }}, min: 0 }},
      }}
    }}
  }});
}})();

// ── 8. Changelog sizes ──────────────────────────────────────────────────────
(function() {{
  const reps = LABELS.map((l, i) => ({{ l, i, avg: clAvg[i], max: clMax[i] }}))
    .filter(r => r.avg > 0).sort((a, b) => b.avg - a.avg);
  new Chart(document.getElementById('changelogs'), {{
    type: 'bar',
    data: {{
      labels: reps.map(r => r.l),
      datasets: [
        {{ label: 'Avg changelog', data: reps.map(r => r.avg), backgroundColor: reps.map(r => COLORS_MID[r.i]), borderColor: reps.map(r => COLORS[r.i]), borderWidth: 1, borderRadius: 4 }},
        {{ label: 'Max changelog', data: reps.map(r => r.max), backgroundColor: reps.map(r => COLORS_SFT[r.i]), borderColor: reps.map(r => COLORS[r.i]), borderWidth: 1, borderRadius: 4 }},
      ]
    }},
    options: {{
      responsive: true, plugins: {{ legend: {{ position: 'top' }} }},
      scales: {{
        x: {{ grid: GRID, ticks: {{ ...TICKS, maxRotation: 30 }} }},
        y: {{ grid: GRID, ticks: TICKS, title: {{ display: true, text: 'characters', color: '#6b6b75' }} }},
      }}
    }}
  }});
}})();

// ── 9. Velocity trend ───────────────────────────────────────────────────────
(function() {{
  const filtered = LABELS.map((l, i) => ({{ l, i, vf: velFirst[i], vs: velSecond[i] }}))
    .filter(r => r.vf > 0 || r.vs > 0);
  new Chart(document.getElementById('veltrend'), {{
    type: 'bar',
    data: {{
      labels: filtered.map(r => r.l),
      datasets: [
        {{ label: 'First half',  data: filtered.map(r => r.vf), backgroundColor: 'rgba(154,154,163,0.4)', borderColor: '#9a9aa3', borderWidth: 1, borderRadius: 4 }},
        {{ label: 'Second half', data: filtered.map(r => r.vs),
          backgroundColor: filtered.map(r => r.vs > r.vf*1.15 ? 'rgba(52,211,153,0.7)' : r.vs < r.vf*0.85 ? 'rgba(239,68,68,0.7)' : 'rgba(217,119,87,0.7)'),
          borderColor:     filtered.map(r => r.vs > r.vf*1.15 ? '#34d399' : r.vs < r.vf*0.85 ? '#ef4444' : '#d97757'),
          borderWidth: 1, borderRadius: 4 }},
      ]
    }},
    options: {{
      responsive: true,
      plugins: {{
        legend: {{ position: 'top' }},
        tooltip: {{ callbacks: {{ afterLabel: ctx => {{
          if (ctx.datasetIndex !== 1) return '';
          const r = filtered[ctx.dataIndex];
          const delta = ((r.vs - r.vf) / (r.vf || 1) * 100).toFixed(0);
          return ` Δ ${{delta > 0 ? '+' : ''}}${{delta}}% vs first half`;
        }} }} }}
      }},
      scales: {{
        x: {{ grid: GRID, ticks: {{ ...TICKS, maxRotation: 30 }} }},
        y: {{ grid: GRID, ticks: TICKS, title: {{ display: true, text: 'releases / week', color: '#6b6b75' }} }},
      }}
    }}
  }});
}})();

// ── 10. Hottest streaks ──────────────────────────────────────────────────────
(function() {{
  const order = streaks.map((v,i) => i).sort((a,b) => streaks[b] - streaks[a]);
  new Chart(document.getElementById('streaks'), {{
    type: 'bar',
    data: {{
      labels: order.map(i => LABELS[i]),
      datasets: [{{ label: 'Max releases in 7 days', data: order.map(i => streaks[i]), backgroundColor: order.map(i => COLORS_MID[i]), borderColor: order.map(i => COLORS[i]), borderWidth: 1, borderRadius: 4 }}]
    }},
    options: {{
      responsive: true, plugins: {{ legend: {{ display: false }} }},
      scales: {{
        x: {{ grid: GRID, ticks: {{ ...TICKS, maxRotation: 30 }} }},
        y: {{ grid: GRID, ticks: TICKS, title: {{ display: true, text: 'releases in best week', color: '#6b6b75' }} }},
      }}
    }}
  }});
}})();

</script>
</body>
</html>"""

with open(OUTPUT_FILE, "w") as f:
    f.write(html)

print(f"✓  {OUTPUT_FILE} written")
print(f"   Spline covers {len(full_range)} days  |  Contrib cal: {len(cal_weeks)} week-columns")
print(f"   Predictor cards: {len(pred_data)} repos")
