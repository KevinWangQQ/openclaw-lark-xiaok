# Migration — adopting the openclaw-lark fork

This fork absorbs the former `feishu-bot-social` plugin into
`src/extensions/feishu-social/` and replaces the hardcoded spinner phrase
sets with config-driven `channels.feishu.spinnerPhrases`.

After deploying the fork to `~/.openclaw/extensions/openclaw-lark/`, you must
migrate `~/.openclaw/openclaw.json` once. The migration is idempotent.

## What changes in `openclaw.json`

| Before | After |
|---|---|
| `plugins.allow: [..., "feishu-bot-social", ...]` | remove `"feishu-bot-social"` from the array |
| `plugins.entries["feishu-bot-social"]` with `config: {…}` and `hooks: {allowConversationAccess: true}` | move `config` to `plugins.entries["openclaw-lark"].config.social`; move `hooks` to `plugins.entries["openclaw-lark"].hooks`; delete the `feishu-bot-social` entry |
| `channels.feishu.spinnerStyle: "jarvis"` (or `"lyra"`) | remove `spinnerStyle`; add `channels.feishu.spinnerPhrases: [...]` from `examples/spinner-phrases-jarvis.example.json` (or `…-lyra.example.json`) |

## How to run the migration

```
node scripts/migrate-config.mjs                      # dry-run — print the diff, write nothing
node scripts/migrate-config.mjs --apply              # write changes; backup file alongside
node scripts/migrate-config.mjs --apply --config /path/to/openclaw.json   # custom path
```

The script:
- Refuses to write if `plugins.entries["openclaw-lark"].config.social` already
  exists and the `feishu-bot-social` entry is gone (already migrated; rerun with
  `--force` to overwrite).
- Backs up the original to `<openclaw.json>.bak-fork-migration-<timestamp>`
  before writing.
- Performs an atomic write (`.tmp` → `rename`).

## One-time data bootstrap (already done by deploy)

`~/.openclaw/feishu-social/wiki-bots.json` must exist and hold the user's bot
+ member registry (the one previously bundled at
`feishu-bot-social/data/wiki-bots.json`). The deploy script copies it once if
missing; it is gitignored to keep real production identifiers out of the repo.

## Rollback

Restore from the timestamped backup:

```
mv ~/.openclaw/openclaw.json ~/.openclaw/openclaw.json.broken
mv ~/.openclaw/openclaw.json.bak-fork-migration-* ~/.openclaw/openclaw.json
openclaw gateway restart
```

## Retiring the discrete `feishu-bot-social` install

Once `migrate-config.mjs` has run and the gateway is restarted, the
`~/.openclaw/extensions/feishu-bot-social/` directory is no longer loaded by
OpenClaw. It is safe to leave on disk for a few days as a forensic reference
and then `trash`.
