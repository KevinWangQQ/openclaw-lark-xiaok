#!/usr/bin/env bash
# scripts/deploy.sh — sync fork → staging → live, with atomic backup + gateway restart.
# Usage:
#   bash scripts/deploy.sh                  # full deploy (staging → live)
#   bash scripts/deploy.sh --staging-only   # populate staging, leave live untouched

set -euo pipefail

FORK="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
STAGING="$HOME/.openclaw/extensions/openclaw-lark-next"
LIVE="$HOME/.openclaw/extensions/openclaw-lark"
TS="$(date +%Y%m%dT%H%M%S)"
BACKUP="$HOME/.openclaw/openclaw-lark.bak-${TS}"

STAGING_ONLY=0
for arg in "$@"; do
  case "$arg" in
    --staging-only) STAGING_ONLY=1 ;;
    -h|--help) sed -n '2,7p' "${BASH_SOURCE[0]}"; exit 0 ;;
    *) echo "unknown arg: $arg" >&2; exit 2 ;;
  esac
done

echo "→ rsync fork → staging ($STAGING)"
rsync -a --delete \
  --exclude='.git' \
  --exclude='node_modules' \
  --exclude='scripts' \
  --exclude='test' \
  --exclude='examples' \
  --exclude='MIGRATION.md' \
  "$FORK/" "$STAGING/"

echo "→ smoke staging"
bash "$FORK/scripts/smoke.sh" "$STAGING"

if [[ $STAGING_ONLY -eq 1 ]]; then
  echo "✓ staging ready: $STAGING (live untouched)"
  exit 0
fi

echo "→ backup live → $BACKUP"
rsync -a --delete "$LIVE/" "$BACKUP/"

echo "→ atomic swap staging → live (preserving live node_modules)"
rsync -a --delete --exclude='node_modules' "$STAGING/" "$LIVE/"

echo "→ restart gateway"
openclaw gateway restart

sleep 3
echo "→ health check"
openclaw gateway status

echo "✓ deploy done. backup at: $BACKUP"
