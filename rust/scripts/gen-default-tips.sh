#!/usr/bin/env bash
# Regenerate crates/claudius-core/data/default-tips.json from the TS source of
# truth (lib/shared/tips.ts → DEFAULT_TIPS). Run after editing the TS tips.
set -euo pipefail
here="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
repo="$(cd "$here/../.." && pwd)"
out="$here/../crates/claudius-core/data/default-tips.json"
cd "$repo"
bun -e 'import { DEFAULT_TIPS } from "./lib/shared/tips.ts"; console.log(JSON.stringify(DEFAULT_TIPS, null, 2))' > "$out"
echo "wrote $out ($(grep -c '"id"' "$out") tips)"
