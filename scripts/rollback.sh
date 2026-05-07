#!/usr/bin/env bash
# scripts/rollback.sh — restore the most recent backup created by deploy.sh.
# Usage:
#   bash scripts/rollback.sh                          # restore latest bak-<ts>
#   bash scripts/rollback.sh ~/.openclaw/openclaw-lark.bak-20260506T223005   # explicit

set -euo pipefail

LIVE="$HOME/.openclaw/extensions/openclaw-lark"

if [[ $# -ge 1 ]]; then
  BACKUP="$1"
else
  BACKUP=$(ls -1dt "$HOME"/.openclaw/openclaw-lark.bak-* 2>/dev/null | grep -v '\.bak-fork-baseline-' | head -1 || true)
fi

if [[ -z "${BACKUP:-}" || ! -d "$BACKUP" ]]; then
  echo "ERROR: no backup found. expected ~/.openclaw/openclaw-lark.bak-<timestamp>/" >&2
  echo "       (the bak-fork-baseline-* snapshot is excluded — pass it explicitly if you want it)" >&2
  exit 1
fi

echo "→ rolling back from: $BACKUP"
rsync -a --delete --exclude='node_modules' "$BACKUP/" "$LIVE/"

echo "→ restart gateway"
openclaw gateway restart
sleep 3
openclaw gateway status

echo "✓ rolled back from $BACKUP"
