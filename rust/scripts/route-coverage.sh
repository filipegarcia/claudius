#!/usr/bin/env bash
# Route coverage: classify every Next `app/api/**/route.ts` against the Rust
# front door and write rust/ROUTES.md.
#
#   rust/scripts/route-coverage.sh           # regenerate rust/ROUTES.md
#   rust/scripts/route-coverage.sh --check   # exit 1 if ROUTES.md is stale or
#                                            # a Rust route is missing methods
#
# Classification of each TS route (path + exported methods):
#   rust       — a Rust handler owns the path (methods compared, see below);
#                a method routed to `crate::proxy::handler` (`get(list)
#                .post(crate::proxy::handler)`) counts as handled and is
#                noted "→ Next"
#   proxied    — an explicit `any(crate::proxy::handler)` route forwards it
#   501        — caught by the `/api/sessions/{id}/{*rest}` not-ported guard
#   next-only  — no Rust route; reaches Next through the fallback proxy
#
# A `rust` row whose Rust route lacks some TS methods is flagged PARTIAL: axum
# answers 405 for those methods instead of falling through to Next, so the
# request is lost. --check fails on any PARTIAL row.
set -euo pipefail
here="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
# ROUTE_COVERAGE_REPO points the script at another checkout (used by tests).
repo="${ROUTE_COVERAGE_REPO:-$(cd "$here/../.." && pwd)}"
exec python3 - "$repo" "$@" <<'PY'
import os, re, sys

repo = sys.argv[1]
check = "--check" in sys.argv[2:]
api_dir = os.path.join(repo, "app", "api")
server_src = os.path.join(repo, "rust", "crates", "claudius-server", "src")
out_path = os.path.join(repo, "rust", "ROUTES.md")
METHODS = ("GET", "POST", "PUT", "PATCH", "DELETE")

# ── TS routes ────────────────────────────────────────────────────────────────
def ts_methods(src: str) -> list[str]:
    found = set()
    for m in METHODS:
        if re.search(rf"export\s+(async\s+)?function\s+{m}\b", src) or re.search(rf"export\s+const\s+{m}\b", src):
            found.add(m)
    for block in re.findall(r"export\s*\{([^}]*)\}", src):
        for m in METHODS:
            if re.search(rf"\b{m}\b", block):
                found.add(m)
    return [m for m in METHODS if m in found]

def ts_segments(rel_dir: str) -> list[tuple[str, str]]:
    segs = []
    for part in rel_dir.split("/"):
        if re.fullmatch(r"\[\[\.\.\.[^\]]+\]\]", part) or re.fullmatch(r"\[\.\.\.[^\]]+\]", part):
            segs.append(("catchall", part))
        elif re.fullmatch(r"\[[^\]]+\]", part):
            segs.append(("param", part))
        else:
            segs.append(("lit", part))
    return segs

ts_routes = []
for root, _dirs, files in os.walk(api_dir):
    if "route.ts" in files:
        rel = os.path.relpath(root, api_dir).replace(os.sep, "/")
        with open(os.path.join(root, "route.ts"), encoding="utf-8") as f:
            src = f.read()
        ts_routes.append({"path": "/api/" + rel, "segs": [("lit", "api")] + ts_segments(rel), "methods": ts_methods(src)})
ts_routes.sort(key=lambda r: r["path"])

# ── Rust routes ──────────────────────────────────────────────────────────────
ROUTE_RE = re.compile(r'\.route\(\s*"([^"]+)"\s*,\s*((?:[^()]|\((?:[^()]|\([^()]*\))*\))*)\)', re.S)

def rust_segments(path: str) -> list[tuple[str, str]]:
    segs = []
    for part in path.strip("/").split("/"):
        if part.startswith("{*"):
            segs.append(("catchall", part))
        elif part.startswith("{"):
            segs.append(("param", part))
        else:
            segs.append(("lit", part))
    return segs

rust_routes = []
for name in sorted(os.listdir(server_src)):
    if not name.endswith(".rs"):
        continue
    with open(os.path.join(server_src, name), encoding="utf-8") as f:
        src = f.read()
    for path, handler in ROUTE_RE.findall(src):
        handler = " ".join(handler.split())
        calls = re.findall(r"\b(get|post|put|patch|delete)\(\s*([^()]*?)\s*\)", handler)
        to_next = sorted({m.upper() for m, h in calls if "proxy::handler" in h}, key=METHODS.index)
        if "proxy::handler" in handler and all("proxy::handler" in h for _, h in calls):
            kind, methods = "proxied", []
        elif "not_ported" in handler:
            kind, methods = "501", []
        else:
            kind = "rust"
            methods = sorted({m.upper() for m in re.findall(r"\b(get|post|put|patch|delete)\(", handler)}, key=METHODS.index)
        rust_routes.append({"path": path, "segs": rust_segments(path), "kind": kind, "methods": methods, "to_next": to_next, "file": name})

def exact(ts, rs) -> bool:
    if len(ts) != len(rs):
        return False
    return all(a[0] == b[0] and (a[0] != "lit" or a[1] == b[1]) for a, b in zip(ts, rs))

def catchall_match(ts, rs) -> bool:
    """Rust route ending in {*rest} matches TS paths with >=1 extra segment."""
    if not rs or rs[-1][0] != "catchall" or len(ts) < len(rs):
        return False
    for a, b in zip(ts, rs[:-1]):
        if b[0] == "lit" and (a[0] != "lit" or a[1] != b[1]):
            return False
        if b[0] == "param" and a[0] == "catchall":
            return False
    return True

def specificity(rs):
    # axum: static segments beat params beat catch-alls, earlier segments first.
    return [0 if s[0] == "lit" else 1 if s[0] == "param" else 2 for s in rs]

rows, used = [], set()
for ts in ts_routes:
    match = next((r for r in rust_routes if exact(ts["segs"], r["segs"])), None)
    if match is None:
        cands = [r for r in rust_routes if catchall_match(ts["segs"], r["segs"])]
        match = min(cands, key=lambda r: specificity(r["segs"])) if cands else None
    if match is None:
        rows.append({**ts, "status": "next-only", "note": ""})
        continue
    used.add(match["path"])
    if match["kind"] == "rust":
        missing = [m for m in ts["methods"] if m not in match["methods"]]
        extra = [m for m in match["methods"] if m not in ts["methods"]]
        note = []
        if missing:
            note.append("PARTIAL — missing " + ",".join(missing) + " (axum answers 405)")
        if extra:
            note.append("extra " + ",".join(extra))
        if match["to_next"]:
            note.append(",".join(match["to_next"]) + " → Next")
        rows.append({**ts, "status": "rust", "note": "; ".join(note), "partial": bool(missing)})
    else:
        rows.append({**ts, "status": match["kind"], "note": f'via `{match["path"]}`' if match["path"] != ts["path"] else ""})

# The 501 guard stays mounted with no TS route left under it: a `/:id/*`
# route TS adds later must not reach Next (which would resume a second CLI).
RUST_ONLY_OK = {"/api/rust/health", "/api/sessions/{id}/{*rest}"}
orphans = [r for r in rust_routes if r["path"] not in used and r["path"] not in RUST_ONLY_OK]

# ── Report ───────────────────────────────────────────────────────────────────
order = ["rust", "proxied", "501", "next-only"]
counts = {k: sum(1 for r in rows if r["status"] == k) for k in order}
partial = [r for r in rows if r.get("partial")]
lines = [
    "# Route coverage",
    "",
    "Generated by `rust/scripts/route-coverage.sh`. Do not edit by hand.",
    "",
    f"{len(rows)} Next API routes:",
    f"- **{counts['rust']}** served by Rust (`rust`)",
    f"- **{counts['proxied']}** explicitly proxied to Next (`proxied`)",
    f"- **{counts['501']}** answer 501 because they need a live session (`501`)",
    f"- **{counts['next-only']}** still Next-only through the fallback proxy (`next-only`)",
    "",
]
if partial:
    lines += ["**PARTIAL routes (some methods answer 405):** " + ", ".join(f"`{r['path']}`" for r in partial), ""]
if orphans:
    lines += ["**Rust routes with no Next counterpart:** " + ", ".join(f"`{r['path']}`" for r in orphans), ""]
for status in order:
    group = [r for r in rows if r["status"] == status]
    if not group:
        continue
    lines += [f"## {status} ({len(group)})", "", "| Route | Methods | Note |", "|---|---|---|"]
    for r in group:
        lines.append(f"| `{r['path']}` | {','.join(r['methods']) or '—'} | {r['note']} |")
    lines.append("")
report = "\n".join(lines)

if check:
    current = open(out_path, encoding="utf-8").read() if os.path.exists(out_path) else ""
    problems = []
    if current != report:
        problems.append("rust/ROUTES.md is stale — run rust/scripts/route-coverage.sh")
    if partial:
        problems.append("PARTIAL routes: " + ", ".join(r["path"] for r in partial))
    if orphans:
        problems.append("Rust routes with no Next counterpart: " + ", ".join(r["path"] for r in orphans))
    for p in problems:
        print("route-coverage: " + p, file=sys.stderr)
    sys.exit(1 if problems else 0)

with open(out_path, "w", encoding="utf-8") as f:
    f.write(report)
print(f"wrote rust/ROUTES.md — rust {counts['rust']} · proxied {counts['proxied']} · 501 {counts['501']} · next-only {counts['next-only']}"
      + (f" · PARTIAL {len(partial)}" if partial else "") + (f" · orphans {len(orphans)}" if orphans else ""))
PY
