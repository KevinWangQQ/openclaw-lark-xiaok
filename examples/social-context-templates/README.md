# Social context templates

These are sample templates for the optional `feishu-social` extension. The
extension renders a string into the agent's system prompt at every turn (via
the `before_prompt_build` hook) when `social.enabled` is `true` and the chat is
listed in `social.contextGroups`.

## How to use

1. Pick a template (or write your own).
2. Read the file content into your `openclaw.json`:

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
            "contextTemplate": "<paste the file contents here as a single JSON string>"
          }
        }
      }
    }
  }
}
```

If `contextTemplate` is omitted, the built-in `DEFAULT_CONTEXT_TEMPLATE`
defined in `src/extensions/feishu-social/context.js` is used. It matches
`default-en.txt` here.

## Available placeholders

The renderer in `context.js` substitutes `{name}` tokens from the data it
builds for each turn. Any token not in this list is left as the literal `{name}`.

| Placeholder | Source |
|---|---|
| `{time}` | Current local time, formatted `HH:MM` |
| `{count}` | Number of messages rendered in the timeline |
| `{timeline}` | Formatted timeline (one line per message) |
| `{members}` | Member registry @-map (one line per known member) |
| `{groupBots}` | Bot registry block (one line per known bot, with @-tag and id metadata) |
| `{botCount}` | Number of bots in `{groupBots}` |
| `{adminName}` | `social.adminDisplayName`, defaults to `'the admin'` |

## Shipped variants

### `default-en.txt`

Neutral English block: members + recent timeline + an @-format reminder.
Suitable for any group chat. Does not mention multi-bot framing or assume
a specific admin name. This is what the extension uses when
`contextTemplate` is unset.

### `multi-bot-zh.txt`

The original Chinese template designed for rooms with multiple AI bots and
an explicit human operator. Includes the bot list, member map, timeline,
and four interaction rules — including an anti-loop rule that asks the
agent to not initiate bot-to-bot back-and-forth. Set `adminDisplayName` to
your name so rule ③ reads correctly.
