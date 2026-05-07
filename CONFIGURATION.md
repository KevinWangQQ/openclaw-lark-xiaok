# Configuration reference

Full key list for `@lucien/openclaw-lark-extended`. Two scopes:

- **Channel** — under `channels.feishu` in `openclaw.json`
- **Plugin** — under `plugins.entries["openclaw-lark"].config` in `openclaw.json`

The runtime authority is the zod schema in
[`src/core/config-schema.js`](./src/core/config-schema.js); the static
manifest in [`openclaw.plugin.json`](./openclaw.plugin.json) declares the
same keys for host-side validation. When the two disagree, zod wins.

## Channel keys (`channels.feishu.*`)

These keys are read by the channel runtime. All are optional.

### Account credentials

These are upstream's; documented here for completeness.

| Key | Type | Default | Description |
|---|---|---|---|
| `appId` | string | — | Lark app id (use `${LARK_APP_ID}` env interpolation) |
| `appSecret` | string | — | Lark app secret |
| `encryptKey` | string | — | Optional event encryption key |
| `verificationToken` | string | — | Optional event verification token |
| `domain` | `'feishu' \| 'lark' \| <https URL>` | `'feishu'` | Selects the OAPI base URL (`open.feishu.cn` or `open.larksuite.com`) |
| `connectionMode` | `'websocket' \| 'webhook'` | `'websocket'` | Event ingress strategy |
| `accounts` | record | — | Multi-account: `accounts: { <id>: { appId, appSecret, … } }` |

### Streaming + cards

| Key | Type | Default | Description |
|---|---|---|---|
| `spinnerPhrases` ⭐ | string[] | host fallback `'Processing...'` | Phrases displayed alongside the spinner during the pre-answer streaming phase. One is picked at random per turn. Empty/unset → host fallback. See `examples/spinner-phrases-default.example.json`. |
| `typingEmoji` ⭐ | string | `'Get'` | Reaction emoji used as a typing cue. Single name (e.g. `'Get'`) or comma-separated pool (e.g. `'Get,DONE,JIAYI'`); one is picked at random per turn. |
| `replyMode` | enum/object | `'auto'` | `auto`, `static`, `streaming`, or per-channel object `{default, group, direct}` |
| `streaming` | boolean | `true` | Master streaming toggle |
| `blockStreaming` | boolean | `true` | Block-level coalescing |

### Admission + thread routing

| Key | Type | Default | Description |
|---|---|---|---|
| `allowBots` | `boolean \| 'mentions'` | `'mentions'` | Bot-sender policy. `true` = allow all; `false` = block; `'mentions'` = group requires @-mention, DM passes. Override per-group via `groups[chatId].allowBots`. |
| `replyInThread` ⭐ | `boolean \| 'enabled'` | falsy | Force agent replies into a thread for groups. Override per-group via `groups[chatId].replyInThread`. |
| `threadSession` | boolean | `false` | When true, each thread maintains its own agent session distinct from the parent chat |
| `dmPolicy` | enum | `'pairing'` | `'open'`, `'pairing'`, `'allowlist'`, `'disabled'` |
| `groupPolicy` | enum | `'allowlist'` | `'open'`, `'allowlist'`, `'disabled'` |
| `groupAllowFrom` | string \| string[] | — | Sender-id allowlist for groups (or chat-id allowlist for legacy compat) |
| `requireMention` | boolean | `false` | Group messages need an explicit @-mention to dispatch |
| `respondToMentionAll` | boolean | `false` | Treat `@all` as an @-mention of this bot |
| `groups` | record | — | Map of `oc_<chatid>` → per-group overrides. See the table below. |

### Per-group overrides (`groups[<oc_chatid>]`)

The wildcard key `'*'` applies to every group not explicitly listed.

| Key | Type | Default | Description |
|---|---|---|---|
| `enabled` | boolean | `true` | Disable this specific group |
| `replyInThread` ⭐ | `boolean \| 'enabled'` | inherits | Override the account-level `replyInThread` |
| `allowBots` | `boolean \| 'mentions'` | inherits | Override the account-level `allowBots` |
| `groupPolicy` | enum | inherits | Per-group `'open'` / `'allowlist'` / `'disabled'` |
| `requireMention` | boolean | inherits | |
| `respondToMentionAll` | boolean | inherits | |
| `allowFrom` | string \| string[] | — | Sender-id allowlist for this group |
| `tools` | `{allow?, deny?}` | — | Tool-policy override |
| `skills` | string[] | — | Per-group skill bindings |
| `systemPrompt` | string | — | Per-group system-prompt extra |

⭐ = added by this fork; everything else is inherited from upstream.

## Plugin keys — `plugins.entries["openclaw-lark"].config.social.*`

The optional `feishu-social` extension. **Disabled by default.** All keys
sit under `social.*`; nothing here loads unless `social.enabled` is `true`.

| Key | Type | Default | Description |
|---|---|---|---|
| `enabled` | boolean | `false` | Master switch. When false, no hooks register and the registry stays unloaded — clean install behaves exactly like upstream. |
| `contextGroups` | string[] | `[]` | List of `oc_*` chat IDs where the extension fetches recent history and injects a context block into the system prompt |
| `contextMessageCount` | number | `20` | Messages per fetch (clamped 5..100) |
| `contextCacheTtlMs` | number | `60000` | Per-chat context cache TTL in ms |
| `contextTemplate` | string | built-in `DEFAULT_CONTEXT_TEMPLATE` | Override the system-prompt block template. See `examples/social-context-templates/` and the placeholder list below. |
| `adminDisplayName` | string | `'the admin'` | Substituted for `{adminName}` in `contextTemplate`. Used by `multi-bot-zh.txt` rule ③. |
| `stormThreshold` | number | `5` | Bot-inbound @-mentions inside `stormWindowMs` that trip the storm debounce |
| `stormWindowMs` | number | `30000` | Window for the bot-inbound count |
| `circuitBreakerMaxOutbound` | number | `5` | Outbound replies inside `circuitWindowMs` that open the circuit breaker |
| `circuitWindowMs` | number | `60000` | Window for the outbound count |
| `circuitBreakerSilenceMs` | number | `300000` | How long the circuit stays open once tripped |
| `alertReceiverOpenId` | string | — | Admin open_id to DM when storm-debounce fires; if unset, no DM is sent |
| `botOverrides` | object | `{}` | Bot metadata overrides keyed by agentId (merged on top of `wiki-bots.json` entries) |
| `wikiBotsPath` | string | `~/.openclaw/feishu-social/wiki-bots.json` | Path to the user-supplied bot+member registry |
| `logDir` | string | `~/.openclaw/feishu-social/logs/` | Directory for the extension's debug log |
| `debugLog` | boolean | `true` | Toggle the extension's verbose log file |

### Context template placeholders

`social.contextTemplate` is a string with `{name}` substitutions. The
renderer fills these from each turn's data; unknown placeholders are left
literal.

| Placeholder | Source |
|---|---|
| `{time}` | Current local time `HH:MM` |
| `{count}` | Message count rendered in `{timeline}` |
| `{timeline}` | Formatted message timeline (one line per message) |
| `{members}` | Member registry @-map (one line per known member) |
| `{groupBots}` | Bot registry block (one line per bot, with @-tag and id) |
| `{botCount}` | Number of bots in `{groupBots}` |
| `{adminName}` | Value of `social.adminDisplayName` (`'the admin'` default) |

See [`EXTENSIONS.md`](./EXTENSIONS.md) for the hook contract this
configuration drives.

## Examples

- [`examples/openclaw.example.json`](./examples/openclaw.example.json) — minimal openclaw.json snippet
- [`examples/wiki-bots.example.json`](./examples/wiki-bots.example.json) — bot+member registry schema reference
- [`examples/spinner-phrases-default.example.json`](./examples/spinner-phrases-default.example.json) — neutral English starter pool
- [`examples/spinner-phrases-playful-zh.example.json`](./examples/spinner-phrases-playful-zh.example.json) — playful Chinese starter pool
- [`examples/social-context-templates/`](./examples/social-context-templates/) — context template variants and renderer placeholder reference
