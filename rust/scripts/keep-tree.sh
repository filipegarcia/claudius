#!/bin/sh
# Run a command (an e2e run), then undo the screenshots it wrote into the
# working tree.
#
#   rust/scripts/keep-tree.sh bun run test:e2e:rust -- <specs>
#
# Many specs write PNGs into docs/ and site/screenshots/ unconditionally, so
# one full parity run leaves ~150 binary diffs. After the command finishes,
# this restores every path under those dirs that was clean *before* the run:
# modified tracked files are checked out, and new untracked files are
# deleted. Paths that were already dirty are left alone, so existing edits
# survive. Exits with the command's status.
set -u
cd "$(git rev-parse --show-toplevel)" || exit 2
before=$(mktemp)
after=$(mktemp)
snapshot() {
  git status --porcelain --untracked-files=all -- docs site/screenshots
}
snapshot | sort >"$before"
"$@"
rc=$?
snapshot | sort >"$after"
# Lines only in $after = paths the run dirtied. Porcelain: "XY path".
comm -13 "$before" "$after" | while IFS= read -r line; do
  st=$(printf '%s' "$line" | cut -c1-2)
  path=$(printf '%s' "$line" | cut -c4-)
  # A path already dirty before the run shows up here again only if its
  # status letters changed; skip anything that was listed before.
  if cut -c4- "$before" | grep -qxF -- "$path"; then continue; fi
  case "$st" in
    '??') rm -f -- "$path" ;;
    ' M' | ' D') git checkout -q -- "$path" ;;
    *) echo "keep-tree: left $st $path" >&2; continue ;;
  esac
  echo "keep-tree: restored $path"
done
# Drop now-empty dirs the run created.
find docs site/screenshots -type d -empty -delete 2>/dev/null
rm -f "$before" "$after"
exit "$rc"
