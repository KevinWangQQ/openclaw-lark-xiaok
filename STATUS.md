# Project status

Snapshot of the fork's current state. Updated when productionization phases
complete or live deployment changes.

Last updated: **2026-05-07** (after first live cutover + GitHub push)

## TL;DR

- Fork version: **0.1.1**
- Upstream baseline: **`@larksuite/openclaw-lark@2026.5.7`** (in sync with npm latest)
- Distribution: **internal team share** via private GitHub repo
  [`ChenyqThu/openclaw-lark-extended`](https://github.com/ChenyqThu/openclaw-lark-extended);
  npm publish not yet
- Live deployment: ✅ running on the maintainer's mac-mini gateway since
  2026-05-07 13:31 PDT, pid 4410 active, no runtime drift (the cosmetic
  package.json version banner drift will resolve on the next code-level
  deploy)

## Branches

| Branch | Tip | Purpose |
|---|---|---|
| `main` | `6cfe5d1` | Public-ready productionized fork. No private deployment data. |
| `lucien/main` | `9770e72` | Live deployment branch. `main` + private overlay (deploy/rollback/drift/upstream-watch scripts, `DEPLOY.md`, `MIGRATION.lucien.md`, private spinner phrase pools). |
| `upstream/main` | `46dfbb1` | Force-rebaselined `npm pack @larksuite/openclaw-lark@2026.5.7`. |

Tags:
- `lucien-main-pre-productionization-v1` → `1aa2628`
  (lucien/main HEAD before productionization rebase; safety anchor in case
  we ever need to compare)

## What's deployed live

- `~/.openclaw/extensions/openclaw-lark/` ← rsync of `lucien/main`
  (excluding `.git`, `node_modules`, `scripts`, `test`, `examples`,
  `MIGRATION.md`)
- `package.json` `name` = `@lucien/openclaw-lark-extended`, version 0.1.1
- Channel id `openclaw-lark` (unchanged from upstream — host routing key)
- 7 plugins active in gateway: `active-memory, browser, google,
  jarvis-skill-learner, memory-core, memory-wiki, openclaw-lark`

### Active config keys (live `~/.openclaw/openclaw.json`)

#### Channel-level (`channels.feishu.*`)
- `spinnerPhrases` — 39 phrases (private, kept on `lucien/main` only)
- `typingEmoji` — `'Get,GoGoGo,HappyDragon,Yes,SLIGHT,RoarForYou,Sigh,SMART,OK,JIAYI'`
- `groups[<chatId>].replyInThread` — per-group `'enabled'`/`'disabled'`

#### Plugin-level (`plugins.entries["openclaw-lark"].config.social.*`)
- `enabled: true` (added during cutover; required since productionization
  made the social extension opt-in)
- `adminDisplayName: "Lucien"`
- `contextTemplate: <313 chars 中文 multi-bot template>` (the original
  `本群活跃 AI Bot…` block + rule①②③④, now opt-in via this key)
- `contextGroups: ["oc_9ba7a535e94ec2f33c53f3def70e3f2d"]`
- `contextMessageCount: 20`, `contextCacheTtlMs: 60000`
- `stormThreshold: 2` (tighter than the public default of 5; reflects the
  small-group traffic profile)
- `circuitBreakerMaxOutbound: 5`, `circuitBreakerSilenceMs: 300000`
- `debugLog: true`

## Verification commands

```bash
# Static fork checks
bash scripts/smoke.sh                                       # syntax + patch markers + schema lint + npm test
bash scripts/upstream-watch.sh                              # check if npm has advanced past upstream/main
bash scripts/drift-check.sh                                 # fork ↔ live diff (must be no-drift after deploy)

# Runtime probe
curl -sS http://127.0.0.1:18789/                            # gateway health
openclaw gateway status                                     # service detail
tail -f /tmp/openclaw/openclaw-$(date +%Y-%m-%d).log        # live log
```

## Backups (rollback targets)

- Live tree: `~/.openclaw/openclaw-lark.bak-20260507T133125`
- Config: `~/.openclaw/openclaw.json.bak-prod-cutover-20260507T132834`

`bash scripts/rollback.sh` restores the most recent live-tree backup and
restarts the gateway.

## Open follow-ups (not blocking anything live)
- **`replay-feishu-event.mjs` is still a Phase 0 stub** — parses the
  fixture but does not invoke `handleFeishuMessage`. Implementing real
  replay requires mocking the Lark SDK; a future phase.
- **`src/core/config-schema.d.ts` inline duplications** inside
  `FeishuConfigSchema`'s `accounts` record carry slightly stale types
  (TypeScript users importing the named `FeishuAccountConfigSchema` /
  `FeishuGroupSchema` exports get correct typing today). Regenerates on
  the next `tsdown` publish to `dist/`.
- **GitHub Actions / CI** — no CI is configured. `npm test` + `npm run
  smoke` work locally. Consider adding a workflow when the repo gets a
  remote.
- **`usability-review.md`** is committed as a historical narrative of the
  productionization audit. Safe to delete once team has read it; not a
  publish-blocker since `npm publish` is not in scope.

## Recently completed

- 2026-05-07 — productionization phases 1–8 + b-path rebase + live cutover
  + `replyInThread: 'disabled'` schema hotfix (commits `fa118db…0b4b583`
  on main; rebased and overlaid on `lucien/main` as `f56f3ca`; hotfix
  `9770e72`).
- 2026-05-07 — upstream `2026.4.10 → 2026.5.7` absorb merge (`1aa2628`
  on lucien/main).
