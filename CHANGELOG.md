# Changelog

Release history for `@lucien/openclaw-lark-extended`. Tracks fork-side
versions; the upstream baseline at each release is noted in parentheses.

## 0.1.0 — initial public release (upstream baseline `@larksuite/openclaw-lark@2026.5.7`)

First release of the fork as a standalone package. All changes below are
deltas relative to upstream `2026.5.7`.

### Channel config schema completion

- `openclaw.plugin.json` `channelConfigs.feishu.schema` was previously
  empty `{ "type": "object" }`. Now declares:
  - `spinnerPhrases` (array of strings)
  - `typingEmoji` (string, single or comma-separated pool)
  - `replyInThread` (`boolean | 'enabled'`)
  - `allowBots` (`boolean | 'mentions'`) — surfaces upstream's runtime key
  - `threadSession` (boolean) — surfaces upstream's runtime key
  - `groups[<chatId>]` (object) — per-group overrides for `replyInThread`,
    `allowBots`, plus the existing zod-side group fields
- `src/core/config-schema.js` (zod) gains `spinnerPhrases`, `typingEmoji`,
  and `replyInThread` (account + group level).

### Optional `feishu-social` extension

In-tree at `src/extensions/feishu-social/`. **Disabled by default.**
Activate via `plugins.entries["openclaw-lark"].config.social.enabled: true`.

When enabled, registers three hooks (`message_received`,
`before_prompt_build`, `message_sending`) that provide:

- Group-context injection into the agent's system prompt with a
  parameterized template (`social.contextTemplate` + `social.adminDisplayName`)
- Sender-name registry consulted as a last-resort name resolver from
  `enrich.js` (chains after upstream user/bot OAPI)
- Storm-guard: bot-inbound debounce + outbound circuit breaker to protect
  against multi-bot reply loops; window sizes are configurable
  (`stormWindowMs`, `circuitWindowMs`)
- `@<alias>` → `<at user_id="…">…</at>` rewriting using the user's
  `wiki-bots.json` registry

Public surface from `index.js`:

- `module.exports = plugin` (default export)
- `registerFeishuSocial(api)` (named export consumed by openclaw-lark glue)
- `lookupMemberName(openId)` (consumed by `enrich.js`)

### Other fork-only patches preserved from prior maintenance

These were already on the fork before productionization and remain on
`main`. Each is opt-in via existing config keys:

- **Patch 1** — non-OAuth card actions forward to the agent as a
  synthetic message (`src/channel/event-handlers.js`)
- **Patch 2** — per-group `replyInThread` (`src/messaging/inbound/dispatch-context.js`)
- **Patch 4b** — streaming card store path corrected from
  `/agents/main/` to `/agents/<id>/` based on session key
  (`src/card/streaming-card-controller.js`)
- **Patch 5** — `randomSpinnerPhrase(cfg)` reads from
  `channels.feishu.spinnerPhrases` (`src/card/builder.js`)
- **Patch 7** — `getTypingEmojiType(cfg)` reads from
  `channels.feishu.typingEmoji` with random pool support
  (`src/messaging/outbound/typing.js`)
- **Phase 4** — group sender prefix `[name](open_id)` for multi-sender
  disambiguation (`src/messaging/inbound/dispatch-builders.js`)
- **Phase 4-fix** — sender-name fallback chains through `feishu-social`
  registry when both upstream OAPI paths return empty
  (`src/messaging/inbound/enrich.js`)

### Renamed and removed

- npm package: `@larksuite/openclaw-lark` → `@lucien/openclaw-lark-extended`
- Extension `plugin.id`: `'feishu-bot-social'` → `'feishu-social'`
- Examples renamed:
  `spinner-phrases-jarvis.example.json` → `spinner-phrases-default.example.json`
  (neutral English) + `spinner-phrases-playful-zh.example.json` (generic
  playful Chinese, no agent name)
- Removed: `examples/spinner-phrases-lyra.example.json` (private persona
  variant retained on the maintainer's `lucien/main` branch only)
- All `Jarvis` / `Lucien` / `Lyra` / `小K` references stripped from
  source code, comments, log lines, and the runtime context template.

### Upstream baseline note

The fork tracks upstream by force-rebaselining `upstream/main` from each
new npm release. As of this 0.1.0, upstream/main = `2026.5.7`, which itself
introduces:

- Self-echo filter (`event-handlers.js`)
- `senderIsBot` field on parsed events (`parse.js`, `types.d.ts`)
- `resolveBotName` against `/open-apis/bot/v3/bots/basic_batch` (`user-name-cache.js`)
- `allowBots` admission policy with default `'mentions'` (`gate.js`,
  `config-schema.js`)
- New plugin manifest `contracts.tools` array

These flow through unchanged.
