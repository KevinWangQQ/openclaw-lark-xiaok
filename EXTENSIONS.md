# Extensions

This fork ships one optional in-tree extension: `feishu-social`. It is
disabled by default. The rest of the channel runtime (DM/group dispatch,
streaming cards, OAuth flows, OAPI tools) is unchanged from upstream.

## `feishu-social`

Optional capability for **multi-user Feishu group chats** where the agent
benefits from awareness of other senders. Three behaviors:

1. **Group-context injection** — fetches the group's recent message
   history at every turn and renders it into the agent's system prompt
   (via the `before_prompt_build` hook).
2. **Sender-name registry** — when upstream's user/bot OAPI returns no
   display name (missing scope, unknown bot, etc.), the channel's
   `enrich.js` consults this extension's local registry to find a name.
3. **Storm-guard** — counts bot-inbound @-mentions and agent outbound
   replies; trips a debounce + circuit breaker to protect against
   bot-to-bot reply loops in busy multi-bot rooms.

### Enable

```jsonc
{
  "plugins": {
    "entries": {
      "openclaw-lark": {
        "config": {
          "social": {
            "enabled": true,
            "contextGroups": ["oc_xxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx"],
            "adminDisplayName": "Your Name",
            "alertReceiverOpenId": "ou_xxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx"
          }
        }
      }
    }
  }
}
```

When `social.enabled` is anything other than `true`, the extension
short-circuits and registers nothing. A fresh install of this package
behaves identically to upstream until you opt in.

### Hook contract

Source: [`src/extensions/feishu-social/index.js`](./src/extensions/feishu-social/index.js).

| Hook | Type | What it does | Configurable via |
|---|---|---|---|
| `message_received` | observer | (a) Prefetches `chatMembers` for every `oc_*` group the bot sees, throttled per-chat. (b) For chats in `social.contextGroups`: counts bot inbound @-mentions for the storm guard and records the latest mention so the next prompt-build can render an addressee block. | `contextGroups`, `stormThreshold`, `stormWindowMs`, `alertReceiverOpenId` |
| `before_prompt_build` | promise → `{appendSystemContext}` | For chats in `social.contextGroups`: fetches the recent timeline, formats the context block via `contextTemplate`, and returns it for accumulating-merge into the system prompt. | `contextGroups`, `contextMessageCount`, `contextCacheTtlMs`, `contextTemplate`, `adminDisplayName` |
| `message_sending` | observer → optional `{content}` | Rewrites `@<alias>` substrings to native `<at user_id="…">…</at>` tags using the bot registry, then increments the outbound circuit-breaker counter and invalidates the chat's context cache so the agent's own reply is visible in the next turn's history block. | `wikiBotsPath`, `botOverrides`, `circuitBreakerMaxOutbound`, `circuitWindowMs`, `circuitBreakerSilenceMs` |

### Sender-name lookup (cross-module)

`src/messaging/inbound/enrich.js` resolves sender display names through
this chain:

1. Upstream user OAPI (`resolveUserName`) — if `senderIsBot` is false
2. Upstream bot OAPI (`resolveBotName`) — if `senderIsBot` is true (added by upstream `2026.5.7`)
3. **`feishu-social.lookupMemberName(openId)`** — consulted only when both
   upstream paths return no name. Reads from:
   - the in-memory chatMembers cache (Phase 7), populated by the
     `message_received` prefetch
   - the user's `wiki-bots.json` member entries

This last step is a no-op when `social.enabled` is false (the registry is
never loaded).

### Customizing the context block

The default neutral template (`DEFAULT_CONTEXT_TEMPLATE` in
`src/extensions/feishu-social/context.js`) is a single English block listing
chat members and the recent timeline. You can replace it with your own
template via `social.contextTemplate`:

```jsonc
{
  "plugins": {
    "entries": {
      "openclaw-lark": {
        "config": {
          "social": {
            "enabled": true,
            "contextTemplate": "[Group · {time}]\n\nMembers:\n{members}\n\nRecent ({count}):\n{timeline}\n[/Group]"
          }
        }
      }
    }
  }
}
```

Available placeholders are documented in [`CONFIGURATION.md`](./CONFIGURATION.md#context-template-placeholders) and in
[`examples/social-context-templates/README.md`](./examples/social-context-templates/README.md).

A richer multi-bot Chinese variant is shipped as
[`examples/social-context-templates/multi-bot-zh.txt`](./examples/social-context-templates/multi-bot-zh.txt) — paste its contents
into `social.contextTemplate` to use.

### Registry data — `wiki-bots.json`

The extension expects a registry file at `social.wikiBotsPath` (default
`~/.openclaw/feishu-social/wiki-bots.json`). Schema:

```jsonc
{
  "bots": {
    "<agent-id>": {
      "agentId": "<agent-id>",
      "name": "Agent Name",
      "emoji": "🤖",
      "openId": "ou_xxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx",
      "appId": "cli_xxxxxxxxxxxxxxxxxxxx",
      "owner": { "name": "Owner", "openId": "ou_xxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx" },
      "aliases": ["alias1"]
    }
  },
  "members": {
    "ou_xxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx": {
      "openId": "ou_xxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx",
      "name": "Person Name",
      "aliases": ["nickname1"]
    }
  }
}
```

See [`examples/wiki-bots.example.json`](./examples/wiki-bots.example.json).
The file is user-supplied and typically contains real Lark identifiers —
keep it gitignored at your install path.

### Disable

Either remove `social` from your `openclaw.json` or set:

```jsonc
{
  "plugins": {
    "entries": {
      "openclaw-lark": {
        "config": {
          "social": { "enabled": false }
        }
      }
    }
  }
}
```

Then `openclaw gateway restart`. The extension's hooks unregister and the
runtime returns to upstream-equivalent behavior on the next event.
