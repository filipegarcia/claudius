#!/usr/bin/env python3
"""Turn a Playwright JSON report from the Rust parity run into
rust/parity/e2e-status.md.

    python3 rust/scripts/parity-report.py RUST_JSON [--baseline TS_JSON] [--out PATH]

RUST_JSON   `PLAYWRIGHT_JSON_OUTPUT_NAME` output of `bun run test:e2e:rust -- --reporter=list,json`
            (wrap the TS baseline run in rust/scripts/keep-tree.sh and
            rust/scripts/clean-env.sh too, like test:e2e:rust does)
--baseline  JSON from the *normal* (TS backend) config over the same specs.
            A test that also fails there is `pre-existing`, not a port bug.

Each failing test gets a category:
  pre-existing      also fails against the TS backend (needs --baseline)
  501:<route>       the test's trace shows a Rust 501 (not-ported) response
  proxy-error       the trace shows a 502 from the Rust proxy
  api-error:<code>  the trace shows another 4xx/5xx from /api (first one wins)
  behavior          none of the above: the Rust backend behaves differently
  flaky             passed on retry
Traces come from `retain-on-failure` (test-results/**/trace.zip). Their
network log is the only reliable link between a UI failure and the route
behind it. Any later Playwright run wipes test-results/, so:
  - run the TS baseline with `--output /tmp/<somewhere>` to keep the Rust
    traces, and
  - every report also writes rust/parity/e2e-status.json. When a test's trace
    is gone, its /api errors are taken from the previous e2e-status.json, so
    re-running the report (e.g. adding --baseline later) keeps the categories.
"""

from __future__ import annotations

import argparse
import json
import os
import re
import sys
import zipfile
from collections import Counter, defaultdict
from datetime import date

UUID = re.compile(r"[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}")
WKS = re.compile(r"wks_[0-9a-f]{12}")


def norm_route(path: str) -> str:
    path = path.split("?", 1)[0]
    path = UUID.sub(":id", path)
    return WKS.sub(":wks", path)


def walk_tests(suite, file_hint=None):
    """Yield (file, title_path, test) for every test in a JSON-reporter suite tree."""
    file = suite.get("file") or file_hint
    for spec in suite.get("specs", []):
        for test in spec.get("tests", []):
            yield file, spec.get("title", ""), test
    for child in suite.get("suites", []):
        prefix = child.get("title", "")
        for f, title, test in walk_tests(child, file):
            yield f, (f"{prefix} › {title}" if prefix and prefix != f and not prefix.endswith(".ts") else title), test


def load(path):
    with open(path, encoding="utf-8") as f:
        data = json.load(f)
    out = {}
    for suite in data.get("suites", []):
        for file, title, test in walk_tests(suite):
            key = (file, title)
            out[key] = test
    return data, out


def trace_api_errors(test) -> list[tuple[int, str]] | None:
    """(status, route) for every /api response >= 400 in the test's traces;
    None when no trace file exists any more."""
    seen, errors, found = set(), [], False
    for result in test.get("results", []):
        for att in result.get("attachments", []):
            path = att.get("path") or ""
            if att.get("name") != "trace" or not path.endswith(".zip") or not os.path.exists(path):
                continue
            found = True
            try:
                with zipfile.ZipFile(path) as z:
                    for name in z.namelist():
                        if not name.endswith(".network"):
                            continue
                        for line in z.read(name).decode("utf-8", "replace").splitlines():
                            try:
                                ev = json.loads(line)
                            except ValueError:
                                continue
                            snap = ev.get("snapshot") or {}
                            url = (snap.get("request") or {}).get("url", "")
                            status = (snap.get("response") or {}).get("status", 0)
                            m = re.match(r"https?://[^/]+(/api/[^?#]*)", url)
                            if m and isinstance(status, int) and status >= 400:
                                key = (status, norm_route(m.group(1)))
                                if key not in seen:
                                    seen.add(key)
                                    errors.append(key)
            except zipfile.BadZipFile:
                continue
    return errors if found else None


def first_error(test) -> str:
    for result in test.get("results", []):
        err = result.get("error") or {}
        msg = err.get("message") or ""
        if msg:
            msg = re.sub(r"\x1b\[[0-9;]*m", "", msg)
            line = next((l.strip() for l in msg.splitlines() if l.strip()), "")
            return line[:160]
    return ""


def categorize(test, baseline_failed: bool | None, cached: list | None) -> tuple[str, list[tuple[int, str]]]:
    status = test.get("status")
    if status == "flaky":
        return "flaky", []
    if baseline_failed:
        return "pre-existing", []
    errs = trace_api_errors(test)
    if errs is None:
        errs = [tuple(e) for e in cached] if cached else []
    for code, route in errs:
        if code == 501:
            return f"501:{route}", errs
    for code, route in errs:
        if code == 502:
            return "proxy-error", errs
    if errs:
        return f"api-error:{errs[0][0]}", errs
    return "behavior", errs


def main() -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument("rust_json")
    ap.add_argument("--baseline")
    ap.add_argument("--out", default=os.path.join(os.path.dirname(__file__), "..", "parity", "e2e-status.md"))
    args = ap.parse_args()

    data, tests = load(args.rust_json)
    base = load(args.baseline)[1] if args.baseline else None
    json_out = os.path.splitext(args.out)[0] + ".json"
    cache = {}
    if os.path.exists(json_out):
        with open(json_out, encoding="utf-8") as f:
            for row in json.load(f).get("failures", []):
                cache[(row["file"], row["title"])] = row.get("api") or []

    per_file = defaultdict(Counter)
    failures = []
    for (file, title), test in sorted(tests.items()):
        st = test.get("status")  # expected | unexpected | flaky | skipped
        per_file[file][st] += 1
        if st in ("unexpected", "flaky"):
            bf = None
            if base is not None:
                bt = base.get((file, title))
                bf = bt is not None and bt.get("status") == "unexpected"
            cat, errs = categorize(test, bf, cache.get((file, title)))
            failures.append({"file": file, "title": title, "cat": cat, "error": first_error(test), "api": errs})

    totals = Counter()
    for c in per_file.values():
        totals.update(c)
    cats = Counter(f["cat"].split(":")[0] if f["cat"].startswith("api-error") else f["cat"] for f in failures)
    routes_501 = Counter(f["cat"][4:] for f in failures if f["cat"].startswith("501:"))
    stats = data.get("stats", {})

    lines = [
        "# e2e parity status (React UI on the Rust backend)",
        "",
        "Generated by `rust/scripts/parity-report.py`. Do not edit by hand; re-run the parity suite instead.",
        "",
        f"- Run: {date.today().isoformat()} · `bun run test:e2e:rust` · {len(per_file)} spec files · "
        f"duration {round(stats.get('duration', 0) / 60000, 1)} min",
        f"- Tests: **{totals['expected']} passed**, **{totals['unexpected']} failed**, "
        f"{totals['flaky']} flaky, {totals['skipped']} skipped",
        f"- Baseline (TS backend) comparison: {'yes' if base is not None else 'no'}",
        "",
    ]
    if failures:
        lines += ["## Failure categories", "", "| Category | Tests |", "|---|---|"]
        for cat, n in cats.most_common():
            lines.append(f"| `{cat}` | {n} |")
        lines.append("")
    if routes_501:
        lines += ["## Not-ported routes hit (501)", "", "| Route | Failing tests |", "|---|---|"]
        for route, n in routes_501.most_common():
            lines.append(f"| `{route}` | {n} |")
        lines.append("")
    if failures:
        lines += ["## Failing tests", "", "| Spec | Test | Category | First error | /api errors in trace |", "|---|---|---|---|---|"]
        for f in failures:
            api = ", ".join(f"{c} {r}" for c, r in f["api"][:4]) + (" …" if len(f["api"]) > 4 else "")
            err = f["error"].replace("|", "\\|")
            title = f["title"].replace("|", "\\|")
            lines.append(f"| `{f['file']}` | {title} | `{f['cat']}` | {err} | {api} |")
        lines.append("")
    lines += ["## Per spec file", "", "| Spec | Passed | Failed | Flaky | Skipped |", "|---|---|---|---|---|"]
    for file, c in sorted(per_file.items()):
        lines.append(f"| `{file}` | {c['expected']} | {c['unexpected']} | {c['flaky']} | {c['skipped']} |")
    lines.append("")

    os.makedirs(os.path.dirname(os.path.abspath(args.out)), exist_ok=True)
    with open(args.out, "w", encoding="utf-8") as f:
        f.write("\n".join(lines))
    with open(json_out, "w", encoding="utf-8") as f:
        json.dump({"totals": dict(totals), "failures": [{**x, "api": [list(e) for e in x["api"]]} for x in failures]}, f, indent=1)
        f.write("\n")
    print(f"wrote {os.path.relpath(args.out)}: {totals['expected']} passed, {totals['unexpected']} failed, "
          f"{totals['flaky']} flaky, {totals['skipped']} skipped · " + ", ".join(f"{k}={v}" for k, v in cats.most_common()))
    failing_files = sorted({f["file"] for f in failures if f["cat"] != "flaky"})
    with open(os.path.join(os.path.dirname(os.path.abspath(args.out)), "failing-specs.txt"), "w") as f:
        f.write("\n".join(f"tests/e2e/{x}" if not x.startswith("tests/") else x for x in failing_files) + ("\n" if failing_files else ""))
    return 0


if __name__ == "__main__":
    sys.exit(main())
