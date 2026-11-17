#!/bin/zsh
# Runs the --bench mode N times (default 3) and prints one BENCH_JSON line per
# run. Extra args go to the binary, e.g.:
#   scripts/bench.sh 3 --synthetic 10000 --scroll-px 100
#   scripts/bench.sh 3 --transcript ~/.claude/projects/<dir>/<uuid>.jsonl
# Release build first: cargo build --release (and the fake CLI in rust/:
# cargo build --release -p claudius-agent --bin claudius-fake-claude).
set -u
here=${0:A:h}/..
n=${1:-3}; shift
for i in $(seq 1 $n); do
  "$here/target/release/gpui-transcript" --bench "$@" 2>/dev/null | grep '^BENCH_JSON ' | sed 's/^BENCH_JSON //'
done
