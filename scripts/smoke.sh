#!/usr/bin/env bash
# scripts/smoke.sh — static checks against the fork or a deployed tree.
# Usage:
#   bash scripts/smoke.sh                       # check the fork repo (default)
#   bash scripts/smoke.sh /path/to/extension    # check a specific tree
#   SKIP_PATCHES=1 bash scripts/smoke.sh        # skip patch markers (e.g. upstream/main)
#   SKIP_TESTS=1 bash scripts/smoke.sh          # skip npm test even if node_modules exists

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
done < <(find "$TARGET" -name '*.js' -not -path '*/node_modules/*' -not -path '*/.git/*' -not -path '*/scripts/*' -not -path '*/.omc/*')

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
  patch_check "patch5"  "spinnerPhrases"          "src/card/builder.js"                       1
  patch_check "patch7"  "getTypingEmojiType"      "src/messaging/outbound/typing.js"          2
fi

# Schema lint: every channels.feishu.<key> the runtime reads must be declared
# in openclaw.plugin.json's channelConfigs.feishu.schema.properties.
echo "→ schema lint: channels.feishu.* declared in plugin.json"
if [[ -f "$TARGET/openclaw.plugin.json" ]]; then
  declared=$(node -e "
    const s = require('$TARGET/openclaw.plugin.json').channelConfigs?.feishu?.schema?.properties || {};
    process.stdout.write(Object.keys(s).join('\n'));
  " 2>/dev/null || echo '')
  for key in spinnerPhrases typingEmoji replyInThread allowBots threadSession groups; do
    if echo "$declared" | grep -qx "$key"; then
      printf "  %-18s declared ✓\n" "$key"
    else
      printf "  %-18s missing in plugin.json ✗\n" "$key"
      fail=1
    fi
  done
else
  echo "  openclaw.plugin.json not found — skipping schema lint"
fi

# Optional: run vitest if node_modules is present.
if [[ "${SKIP_TESTS:-0}" != "1" && -x "$TARGET/node_modules/.bin/vitest" ]]; then
  echo "→ npm test (vitest)"
  ( cd "$TARGET" && node_modules/.bin/vitest run --reporter=basic ) || fail=1
elif [[ "${SKIP_TESTS:-0}" != "1" ]]; then
  echo "→ skipping npm test (node_modules/.bin/vitest not found; run 'pnpm install' or 'npm install' first)"
fi

if [[ $fail -eq 1 ]]; then
  echo "✗ smoke failures"
  exit 1
fi

echo "✓ smoke ok"
