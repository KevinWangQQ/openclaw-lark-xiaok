#!/usr/bin/env bash
# scripts/smoke.sh — static checks against a fork or staging tree.
# Usage:
#   bash scripts/smoke.sh                       # check the fork repo (default)
#   bash scripts/smoke.sh /path/to/extension    # check a specific tree
#   SKIP_PATCHES=1 bash scripts/smoke.sh        # skip patch markers (e.g. upstream/main)

set -uo pipefail

TARGET="${1:-$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)}"
fail=0

echo "→ smoke target: $TARGET"

echo "→ node --check on every .js"
while IFS= read -r f; do
  if ! node --check "$f" 2>/dev/null; then
    echo "  syntax error: $f"
    fail=1
  fi
done < <(find "$TARGET" -name '*.js' -not -path '*/node_modules/*' -not -path '*/.git/*' -not -path '*/scripts/*')

patch_check() {
  local label="$1" pattern="$2" file="$3" expected="$4"
  local path="$TARGET/$file"
  if [[ ! -f "$path" ]]; then
    printf "  %-12s missing: %s ✗\n" "$label" "$file"
    fail=1
    return
  fi
  local count
  count=$(grep -c "$pattern" "$path" 2>/dev/null)
  count=${count:-0}
  if [[ "$count" -ge "$expected" ]]; then
    printf "  %-12s %s ≥ %s ✓\n" "$label" "$count" "$expected"
  else
    printf "  %-12s %s < %s ✗  (%s)\n" "$label" "$count" "$expected" "$file"
    fail=1
  fi
}

if [[ "${SKIP_PATCHES:-0}" == "1" ]]; then
  echo "→ skipping patch markers (SKIP_PATCHES=1)"
else
  echo "→ patch grep verifications"
  patch_check "patch1"  "Non-OAuth card action"  "src/channel/event-handlers.js"             2
  patch_check "patch2"  "Patch 2"                 "src/messaging/inbound/dispatch-context.js" 1
  patch_check "patch4b" "Patch 4b"                "src/card/streaming-card-controller.js"     2
  patch_check "patch5z" "SPINNER_PHRASES_ZH"      "src/card/builder.js"                       1
  patch_check "patch5l" "SPINNER_PHRASES_LYRA"    "src/card/builder.js"                       1
  patch_check "patch5s" "spinnerStyle"            "src/card/builder.js"                       5
  patch_check "patch5c" "spinnerStyle"            "src/card/streaming-card-controller.js"     3
  patch_check "patch7"  "getTypingEmojiType"      "src/messaging/outbound/typing.js"          2
fi

if [[ $fail -eq 1 ]]; then
  echo "✗ smoke failures"
  exit 1
fi

echo "✓ smoke ok"
