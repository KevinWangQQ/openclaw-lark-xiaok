# Usability review (transient — delete before npm publish)

Self-review pass after Phases 1–7 of productionization. Commit kept as a
record of what was checked; it should be removed in the same change that
runs `npm publish` so it does not ship in the package tarball.

## Audit checklist

### 1. Persona references in source / docs / examples ✓

```bash
grep -rE "Jarvis|Lucien|蛋姐|小K|Lyra|miniGG" \
  --include="*.js" --include="*.ts" --include="*.json" --include="*.md" --include="*.txt" \
  --exclude-dir=skills --exclude-dir=.git --exclude-dir=node_modules --exclude-dir=.omc .
```

Hits, all intentional:

- `CHANGELOG.md` — entry describing what was removed (historical narrative)
- `MIGRATION.md` — note that the old plugin hardcoded `'Lucien'` (migration guidance)
- `package.json` — `author: "Lucien"` (legitimate authorship metadata)
- `test/social-context.test.js` — regex strings used to assert no leakage in `DEFAULT_CONTEXT_TEMPLATE` (intentional)

### 2. Concrete real-looking identifiers ✓

```bash
grep -rE "ou_[0-9a-f]{32}|oc_[0-9a-f]{32}|p2p_jarvis|p2p_lucien" \
  --include="*.js" --include="*.ts" --include="*.json" --include="*.md" --include="*.txt" \
  --exclude-dir=skills --exclude-dir=.git --exclude-dir=node_modules --exclude-dir=.omc . \
  | grep -v "xxxxxxx"
```

→ none.

(`skills/feishu-bitable/references/record-values.md` contains upstream-supplied
example IDs; not in fork-modified scope.)

### 3. `social.*` schema → docs ✓

All 16 declared keys in `openclaw.plugin.json` `configSchema.properties.social.properties` appear in `CONFIGURATION.md`.

### 4. `channels.feishu.*` schema → docs ✓

All 6 declared keys (`spinnerPhrases`, `typingEmoji`, `replyInThread`, `allowBots`, `threadSession`, `groups`) appear in `CONFIGURATION.md`.

### 5. `package.json` sanity ✓

| Check | Status |
|---|---|
| name = `@xiaok/openclaw-lark-extended` | ✓ |
| version = `0.1.0` | ✓ |
| publishConfig.access = `public` | ✓ |
| license = `MIT` | ✓ |
| author set | ✓ |
| `npm test` wired (vitest run) | ✓ |
| `npm run smoke` wired | ✓ |
| vitest devDep present | ✓ |
| openclaw.channel.id stays `openclaw-lark` | ✓ |
| openclaw.install.npmSpec matches new package name | ✓ |

### 6. Tests ✓

```
✓ test/social-context.test.js (11 tests)
✓ test/dispatch-context.test.js (9 tests)
✓ test/typing-emoji.test.js (6 tests)
✓ test/spinner-phrase.test.js (6 tests)
✓ test/social-disabled.test.js (5 tests)
Test Files  5 passed (5)
     Tests  37 passed (37)
```

### 7. `bash scripts/smoke.sh` ✓

```
✓ all .js node --check pass
✓ patch markers (Patch 1, 2, 4b, 5, 7) present
✓ schema lint: spinnerPhrases / typingEmoji / replyInThread / allowBots / threadSession / groups all declared
✓ npm test (37 cases) green
```

## Spot checks

### `social.enabled = false` (default install) is silent

`registerFeishuSocial(api)` with empty `pluginConfig` returns immediately
after logging `[feishu-social] disabled (set social.enabled: true to activate)`.
No `api.on()` call. No registry load. Verified by `social-disabled.test.js`.

### Default context template has no persona content

`DEFAULT_CONTEXT_TEMPLATE` exported from `src/extensions/feishu-social/context.js`
matches `examples/social-context-templates/default-en.txt`. No multi-bot
framing, no anti-loop rule, no `Lucien`. The richer Chinese variant lives
only in `examples/social-context-templates/multi-bot-zh.txt` and is opt-in
via `social.contextTemplate`.

### Channel id vs npm package name

The npm package is `@xiaok/openclaw-lark-extended` but the channel id stays
`openclaw-lark` (`openclaw.plugin.json` `id` field, `package.json`
`openclaw.channel.id`). This is correct: the host routes channel events by id,
and changing it would break upstream channel registration.

## Items deliberately not addressed in this round

- **`replay-feishu-event.mjs` is still a Phase 0 stub** that parses the
  fixture and prints metadata. Bringing it to "actually invoke
  handleFeishuMessage" requires mocking the Lark SDK and several runtime
  deps; defer to a future phase. Smoke + the 5 unit-test files give
  reasonable coverage in the meantime.
- **`src/core/config-schema.d.ts` inline duplications** inside
  `FeishuConfigSchema`'s `accounts` record are left slightly out of sync
  with the source-of-truth zod (`src/core/config-schema.js`). The named
  exports `FeishuGroupSchema` and `FeishuAccountConfigSchema` are correct;
  the duplicated inline types regenerate when tsdown publishes to `dist/`.
  TypeScript users who import the named exports get correct typing today.
- **`repository.url`** in `package.json` is still TBD — the maintainer
  needs to set the public git URL when the repo goes public.
- **No CI configured.** Tests run locally on `npm test`. A simple GitHub
  Actions workflow could be added later.

## Open decisions to flag for the maintainer

1. Whether to keep `usability-review.md` (this file) in the published
   tarball or delete before `npm publish`. Recommendation: delete it from
   `main` once you're satisfied with productionization, OR add it to
   `package.json` `files` exclusions.
2. Whether to rebase `lucien/main` onto `main` after productionization is
   stable. The maintainer's deploy scripts + `wiki-bots.json` real data +
   Jarvis spinner phrases all sit on `lucien/main` only, so a periodic
   rebase preserves them as a private overlay on top of public `main`.
3. Whether to absorb 2026.5.7 + productionization into one live cutover
   (rebase `lucien/main` onto `main`, deploy from there) or keep
   productionization on `main` and live on the existing `lucien/main`
   tip (which already has the 2026.5.7 absorption merge `1aa2628`).

## Summary

Productionization phases 1–7 are complete on `main`. The branch:

- Carries upstream `2026.5.7` baseline + the schema completion + the
  optional `feishu-social` extension.
- Has zero hardcoded persona/private-deployment data in source code.
- Ships 37 passing unit tests with `npm test`.
- Has documentation for every public config key.
- Renames cleanly to `@xiaok/openclaw-lark-extended` v0.1.0 and is
  ready (modulo `repository.url`) to publish to public npm.

`lucien/main` is unchanged at `1aa2628` (the 2026.5.7 absorb merge) and
keeps the maintainer's private deploy scripts, `wiki-bots.json`,
DEPLOY/MIGRATION runbooks, and Jarvis-flavored spinner phrases.

The cutover decision (a/b/c in the plan's Phase 9) is the maintainer's
call.
