# Changelog

Release history for `@lucien/openclaw-lark-extended`. Tracks fork-side
versions; the upstream baseline at each release is noted in parentheses.

## 0.2.0 — name-resolver refactor + unified message tool (upstream baseline `@larksuite/openclaw-lark@2026.5.7`)

Substantial release. Resolves the long-standing 张冠李戴 (mis-attribution)
issue in group-chat summaries: human senders without `@-mention` events used
to fall back to `用户(${id.slice(-8)})` in the group-context block injected
into the system prompt, leading the agent to guess attributions when paraphrasing.

### 🔴 Core fix — group context block now resolves real names (Phase 2)

`src/extensions/feishu-social/context.js` + `index.js` + new `uat-fetch.js`:

- Hook 1 (`message_received`) now stashes `{accountId, ts}` per chatId in
  `SHARED.lastChatContext` (5 min TTL). Hook 2 (`before_prompt_build`) reads
  this to obtain a UAT ticket for the group's account, since the host's
  `PluginHookAgentContext` carries no accountId.
- New ~80 LOC `uat-fetch.js` does raw `fetch` to
  `/contact/v3/users/basic_batch` using the bot owner's stored UAT token
  (looked up via `core/token-store.getStoredToken(appId, ownerOpenId)`).
  Bypasses `ToolClient` (whose `legacy-plugin guard` and
  `assertOwnerAccessStrict` are too eager for a hot-loop hook).
- `formatMessageTimeline` cascade for human senders now goes:
  `sender.name` → mention prefill → `memberCache` → shared user-name cache
  → `用户(last8)` final fallback.
- `ContextCache.computeOnce(chatId, fn)` adds inflight single-flight so two
  concurrent hooks for the same chat don't double-fire UAT (mirrors the
  existing `tokenInflight` pattern).
- 3-second wall-clock budget (`Promise.race`) on the enrich pre-pass keeps
  the hook well under the host's 15-second timeout. Permission-error log
  is throttled to once per 30 min per accountId.

### Name-resolver as a shared library (Phase 0)

New `src/tools/oapi/im/name-resolver.js`. Public API:

- `resolveUserName(accountId, openId)` — sync read from the shared cache
- `setUserName(accountId, openId, name)` / `peekUserName(...)` — safe-set + raw read
- `prefillUserNamesFromMentions(accountId, items)` — free name harvest from event mentions
- `batchResolveUserNames({client, accountId, openIds, log})` — UAT
  `contact/v3/users/basic_batch` (chunks of 10), writes via safe-set
- `resolveChatName(accountId, chatId)` / `batchResolveChatNames({...})` — new
  account-scoped chat-name cache (TTL 60 min, size 200) with automatic
  warm-up of p2p target user names
- `enrichSendersInPlace({messages, accountId, batchResolve, registry,
  memberCache, log})` — DI-friendly cascade helper used by the extension's
  enrich pre-pass; testable without SDK mocking
- `clearUserNameCacheAll()` / `clearChatNameCache()` — test isolation

The previous private LRU in `src/tools/oapi/im/user-name-uat.js` was collapsed
into the shared cache at `src/messaging/inbound/user-name-cache-store.js#getUserNameCache(accountId)`
so inbound TAT mention prefill and tool-layer UAT batch resolution write
into the same place. `user-name-uat.js` becomes a thin re-export shim
(`getUATUserName` / `setUATUserNames` / `batchResolveUserNamesAsUser`
preserved for any caller still importing by name).

### Unified `message` tool — read action dispatcher (Phase 3)

`src/tools/oapi/im/message.js` Type.Union extends from `send`/`reply` to 7+
actions. Read actions delegate to existing implementations via extracted
`executeXxx(params, ctx)` callables in `message-read.js` and `chat/members.js`.
The standalone tools (`feishu_im_user_get_messages`,
`_get_thread_messages`, `_search_messages`, `feishu_chat_members`) stay
registered for back-compat but their descriptions now lead with
`[DEPRECATED — prefer message tool action=...]` so an LLM seeing both gravitates
to the unified entry.

Schema source-of-truth lives in new `src/tools/oapi/im/message-schema.js`,
a leaf module (only depends on `@sinclair/typebox`) so vitest tests can
validate without loading message.js's heavier CJS dependency chain.

### Four orthogonal read primitives (Phase 4)

The set is now: `list`, `get`, `search`, `thread`, `members`, plus four new:

- `message action=mget` — batch get message details via
  `/im/v1/messages/mget`. Returns enrichment-applied list.
- `message action=reactions` — read reactions list via
  `/im/v1/messages/:id/reactions` (note: NO `/list` suffix on this endpoint).
  Reactor open_ids are batch-resolved through the shared name-resolver so
  `operator.operator_name` comes back populated.
- `message action=resolve_url` — pure-regex IM URL → ids parser (lives in
  new `src/tools/oapi/im/url-parser.js` as a leaf module). IM-only;
  cloud-doc URLs return `{resolved:false, reason:"not_im_url"}` and let the
  agent route to a drive tool. Encrypted-token applink URLs intentionally
  out of scope (would need an async unwrap call).
- `chat action=resolve_p2p` — batch open_id → P2P chat_id reverse lookup via
  `/im/v1/chat_p2p/batch_query`. Promotes a private helper that previously
  lived in `message-read.resolveP2PChatId`.

The ruled-out compound tools (group summary, mention queries, around-context,
activity stats) remain agent responsibility — schemas don't lock in any one
usage shape.

### Sentinel cache semantics (post-deploy hotfix series, all merged in 0.2.0)

Multiple iterations during the 2026-05-07 verification round refined how
empty-name responses interact with the shared cache. Final state:

- TAT inbound batch (`src/messaging/inbound/user-name-cache.js`) writes via
  the new safe-set rule — never overwrites a real cached name with the `''`
  sentinel; only sentinels truly missing IDs (and only when the response
  itself was non-empty). TAT users/batch frequently returns entries with
  empty name fields, so this prevents systematic poisoning of the shared
  cache.
- UAT batch (`name-resolver.js#batchResolveUserNames`) dedup checks
  `cache.get()` truthy instead of `cache.has()`. Sentinels are treated as
  miss, so UAT retries them. Once UAT resolves the real name,
  `setUserNameSafe` overwrites the sentinel.
- Reactions endpoint path corrected: `/reactions/list` → `/reactions`
  (was 404'ing because the GET endpoint has no `/list` suffix; POST same
  path = create, DELETE `/reactions/:reaction_id` = delete).
- `client.invoke + sdk.request` is the canonical pattern for new endpoints
  (mirrors `user-name-uat.js`). The earlier `invokeByPath` path tripped a
  JSON-parse error on Feishu's HTML 404 page; switching unblocks both
  reactions and `chat resolve_p2p`.
- `chat resolve_p2p` response handling: tries multiple plausible field
  names (`chatter_id` / `open_id` / `user_id` / `id`) and falls back to
  positional alignment with the request order.

### Tests

94 vitest cases (37 prior + 57 new across Phase 0/2/3/4 + sentinel hotfix).
All pass. Smoke (`bash scripts/smoke.sh`) green; `pnpm test` green.

### Live cutover record (2026-05-07)

- Initial cutover at `bash scripts/deploy.sh` from `lucien/main` rev
  `80fc4b7` (Phase 0–4 stack). Backup
  `~/.openclaw/openclaw-lark.bak-20260507T172150`.
- Five hotfix iterations followed (0768885 / 0677e98 / 18eb3d8 / eb5446e /
  f3f9b45) over ~90 minutes, refining the reactions / resolve_p2p / cache
  sentinel paths against live verification feedback.
- Final cutover backup `~/.openclaw/openclaw-lark.bak-20260507T190634`.
  Gateway pid alive on `127.0.0.1:18789`. drift-check ✓ no drift.
- Verification — Jarvis confirmed: B1 (timeline real names ≥95%) PASS,
  B2 (5/5 attribution accuracy) PASS, all 7 dispatcher actions PASS
  including reactions `operator_name` populated.

## 0.1.1 — schema permissiveness hotfix (upstream baseline `@larksuite/openclaw-lark@2026.5.7`)

Hotfix during the first live cutover (2026-05-07). The 0.1.0 schema declared
`replyInThread` as `boolean | 'enabled'`, but real-world configs already use
`'disabled'` to mean "explicitly off" (semantically the same as `false` to the
runtime, which only checks `=== true || === 'enabled'`). Strict schema
validation aborted gateway start.

- `openclaw.plugin.json`: `replyInThread` enum extended to `['enabled', 'disabled']`
  in both account and per-group schema.
- `src/core/config-schema.js` zod: `ReplyInThreadSchema` becomes
  `boolean | 'enabled' | 'disabled'`.
- `src/core/config-schema.d.ts`: matching union update on the named exports.
- `CONFIGURATION.md`: `replyInThread` row updated to list both string values.

Runtime behavior unchanged — the `resolveReplyInThread` helper still treats
anything other than `true` / `'enabled'` as falsy (do not force thread).

### Live cutover record (2026-05-07)

- 13:29 PDT — first `bash scripts/deploy.sh` from `lucien/main` (post-rebase
  onto productionized `main`). Atomic swap succeeded; gateway restart aborted
  on `replyInThread: 'disabled'` schema validation.
- 13:31 PDT — schema hotfix above committed (`9770e72` on lucien/main /
  `6cfe5d1` on main); second `deploy.sh` succeeded. Gateway pid 4410 active,
  HTTP 200 on `127.0.0.1:18789`.
- 13:54 / 13:55 PDT canary — DM streaming + group context injection (20 msgs
  fetched, member-cache prefetch 10 members, registry loaded 8 bots, sender
  identity correct including `@小K`-style alias resolution and explicit
  open_id surfacing) all confirmed.
- Backups: `~/.openclaw/openclaw-lark.bak-20260507T133125` (live tree),
  `~/.openclaw/openclaw.json.bak-prod-cutover-20260507T132834` (config).

## 0.1.0 — initial release (upstream baseline `@larksuite/openclaw-lark@2026.5.7`)

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
