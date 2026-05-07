#!/usr/bin/env bash
# scripts/upstream-watch.sh — flag when @larksuite/openclaw-lark on npm has
# moved past the version pinned on the fork's upstream/main branch.
#
# Silent and exit 0 when in sync. Exits 1 with a hint when behind.
#
# Usage:
#   bash scripts/upstream-watch.sh         # silent if in sync
#   bash scripts/upstream-watch.sh --json  # machine-readable output

set -uo pipefail

FORK="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
JSON=0
for arg in "$@"; do
  case "$arg" in
    --json) JSON=1 ;;
    -h|--help) sed -n '2,11p' "${BASH_SOURCE[0]}"; exit 0 ;;
    *) echo "unknown arg: $arg" >&2; exit 2 ;;
  esac
done

# Pinned version: read upstream/main's package.json from the git work tree.
PINNED=$(git -C "$FORK" show upstream/main:package.json 2>/dev/null \
  | node -e "process.stdout.write(JSON.parse(require('fs').readFileSync(0,'utf8')).version)" 2>/dev/null)

if [[ -z "$PINNED" ]]; then
  echo "✗ failed to read upstream/main:package.json version from $FORK" >&2
  exit 2
fi

# Latest on npm.
LATEST=$(npm view @larksuite/openclaw-lark version 2>/dev/null)
if [[ -z "$LATEST" ]]; then
  echo "✗ npm view failed (offline or registry error)" >&2
  exit 2
fi

if [[ "$PINNED" == "$LATEST" ]]; then
  if [[ $JSON -eq 1 ]]; then
    printf '{"status":"in-sync","pinned":"%s","latest":"%s"}\n' "$PINNED" "$LATEST"
  else
    echo "✓ in sync: upstream/main pinned $PINNED, npm latest $LATEST"
  fi
  exit 0
fi

if [[ $JSON -eq 1 ]]; then
  printf '{"status":"behind","pinned":"%s","latest":"%s"}\n' "$PINNED" "$LATEST"
else
  cat <<EOF
⚠ upstream advanced
  pinned (upstream/main):  $PINNED
  npm latest:              $LATEST

  to absorb upstream:
    cd $FORK
    npm pack @larksuite/openclaw-lark@$LATEST --pack-destination /tmp
    git checkout upstream/main
    tar -xzf /tmp/larksuite-openclaw-lark-$LATEST.tgz --strip-components=1
    git add . && git commit -m "upstream: @larksuite/openclaw-lark@$LATEST"
    git checkout -b feature/upstream-$LATEST lucien/main
    git merge upstream/main          # resolve conflicts in the 5 patch hot-zones
    bash scripts/smoke.sh            # verify all patches still apply
    bash scripts/replay-feishu-event.mjs test/fixtures/feishu/*.json   # fixture replay
    git checkout lucien/main && git merge --no-ff feature/upstream-$LATEST
EOF
fi
exit 1
