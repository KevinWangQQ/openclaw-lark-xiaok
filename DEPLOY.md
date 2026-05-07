# Deploy runbook

Companion to `MIGRATION.md`. Walks through the first cutover from the
unmanaged runtime to the fork, plus subsequent upgrades.

## First-time deploy (one-shot)

Pre-checks (everything is local + reversible up to step 6):

```bash
cd ~/Projects/openclaw-lark-fork

# 1. Verify all 5 patches still apply on lucien/main.
bash scripts/smoke.sh
# → ✓ smoke ok

# 2. Verify upstream is in sync (we're at 2026.4.10).
bash scripts/upstream-watch.sh
# → ✓ in sync: upstream/main pinned 2026.4.10, npm latest 2026.4.10

# 3. Verify drift-check identifies the expected fork → live differences.
#    Will report drift on: index.js, openclaw.plugin.json, builder.js,
#    streaming-card-controller.js, dispatch-builders.js, src/extensions/
bash scripts/drift-check.sh
```

Stage and validate without touching live:

```bash
# 4. Populate ~/.openclaw/extensions/openclaw-lark-next/ from the fork.
bash scripts/deploy.sh --staging-only

# 5. Optional: drift-check between staging and fork (should be clean).
bash scripts/drift-check.sh --staging
# → ✓ no drift
```

Migrate config (dry run, then apply):

```bash
# 6. Dry-run the openclaw.json migration. Reports 5 changes.
node scripts/migrate-config.mjs

# 7. Apply when satisfied. Backup is timestamped automatically.
node scripts/migrate-config.mjs --apply
```

Cutover (this is the irreversible step — but a fresh backup is taken):

```bash
# 8. Atomic swap staging → live + gateway restart.
bash scripts/deploy.sh
# → backup taken to ~/.openclaw/openclaw-lark.bak-<timestamp>/
# → gateway restarted, status checked
```

Post-deploy live validation (canary order: low blast radius first):

```bash
# 9. DM Jarvis: receives a streaming reply. Confirm:
#    - footer shows model + tokens (Patch 4b live)
#    - typing emoji animates from your configured pool (Patch 7 live)
#    - spinner phrase rotates from channels.feishu.spinnerPhrases (Patch 5b live)

# 10. In a low-traffic group with replyInThread: enabled,
#     send two messages with a small gap between them. Confirm:
#     - Patch 2: replies land in a thread
#     - Phase 3: the second message's history block contains the first reply
#     - Phase 4: each user turn shows [name](ou_…): prefix in agent responses

# 11. Click a card button; confirm action forwards to the agent (Patch 1).

# 12. Run drift-check after gateway settles:
bash scripts/drift-check.sh
# → ✓ no drift
```

Rollback if anything regresses:

```bash
bash scripts/rollback.sh
# Restores the most recent ~/.openclaw/openclaw-lark.bak-<ts>/ and restarts
# the gateway. The migrate-config backup file alongside openclaw.json is also
# preserved — restore it manually if you need the pre-migration config.
```

## Subsequent upgrades

When `npm view @larksuite/openclaw-lark version` advances past `upstream/main`'s
pinned version (caught by `scripts/upstream-watch.sh`), absorb the new release
in the fork repo first, never via `openclaw plugins update`:

```bash
cd ~/Projects/openclaw-lark-fork
LATEST=$(npm view @larksuite/openclaw-lark version)

git checkout upstream/main
npm pack @larksuite/openclaw-lark@$LATEST --pack-destination /tmp
tar -xzf /tmp/larksuite-openclaw-lark-$LATEST.tgz --strip-components=1
git add . && git commit -m "upstream: @larksuite/openclaw-lark@$LATEST"

git checkout -b feature/upstream-$LATEST lucien/main
git merge upstream/main
# ↑ resolve conflicts in the 5 patch hot-zones:
#   src/channel/event-handlers.js          (Patch 1)
#   src/messaging/inbound/dispatch-context.js (Patch 2)
#   src/card/streaming-card-controller.js  (Patch 4b + 5b)
#   src/card/builder.js                    (Patch 5b)
#   src/messaging/outbound/typing.js       (Patch 7)
# Plus possibly:
#   src/messaging/inbound/dispatch-builders.js (Phase 4 sender label)
#   index.js                               (Phase 2 social wiring)

bash scripts/smoke.sh                      # verify all patches still grep
bash scripts/replay-feishu-event.mjs test/fixtures/feishu/dm_text.example.json

git checkout lucien/main
git merge --no-ff feature/upstream-$LATEST -m "merge feature/upstream-$LATEST"

bash scripts/deploy.sh --staging-only      # populate staging
bash scripts/drift-check.sh --staging      # confirm clean
bash scripts/deploy.sh                     # atomic swap + restart
```

If a patch is fully absorbed upstream (e.g. upstream natively gains a
configurable typing emoji, removing the need for Patch 7), drop the patch
commit during merge with `git rm`, document the retirement in the merge
commit message, and run smoke (note: smoke.sh's expected count for that
patch will need updating).

## Daily ops (once jobs.json is re-enabled)

Add to `~/.openclaw/cron/jobs.json`:

```jsonc
{
  "id": "fork-drift-check",
  "command": "bash ~/Projects/openclaw-lark-fork/scripts/drift-check.sh",
  "schedule": "0 9 * * *",
  "enabled": true
},
{
  "id": "fork-upstream-watch",
  "command": "bash ~/Projects/openclaw-lark-fork/scripts/upstream-watch.sh",
  "schedule": "30 9 * * *",
  "enabled": true
}
```

Both scripts are silent + exit 0 on healthy state, noisy + exit 1 when
attention is needed. Pair them with whatever notification routing the cron
runtime supports.
