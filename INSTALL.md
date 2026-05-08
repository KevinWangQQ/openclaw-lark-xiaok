# Install

A first-time walkthrough for `@xiaok/openclaw-lark-extended`. If you are
already running upstream `@larksuite/openclaw-lark` and want to migrate,
read this AND [`MIGRATION.md`](./MIGRATION.md).

## Prerequisites

- Node.js ≥ 22 (`node -v`)
- OpenClaw ≥ `2026.3.22` (`openclaw -v`)
- A Lark/Feishu app with the API scopes your bot needs (messaging, doc,
  calendar, etc. — see upstream README for the full scope catalog)

## 1. Install the package

```bash
openclaw plugins install @xiaok/openclaw-lark-extended
```

That's the recommended path: OpenClaw's plugin manager wires up the install
location and writes the `plugins.allow` entry in `~/.openclaw/openclaw.json`
for you.

If you prefer manual:

```bash
npm install -g @xiaok/openclaw-lark-extended
# then add the plugin id to plugins.allow in ~/.openclaw/openclaw.json:
#   "plugins": { "allow": ["openclaw-lark"], ... }
```

The plugin id remains `openclaw-lark` (same as upstream); only the npm
package name differs.

## 2. Wire the channel into `openclaw.json`

Minimum config to receive Feishu DMs:

```jsonc
{
  "channels": {
    "feishu": {
      "domain": "feishu",
      "accounts": {
        "default": {
          "appId": "${LARK_APP_ID}",
          "appSecret": "${LARK_APP_SECRET}",
          "encryptKey": "${LARK_ENCRYPT_KEY}",
          "verificationToken": "${LARK_VERIFICATION_TOKEN}"
        }
      }
    }
  },
  "plugins": {
    "allow": ["openclaw-lark"]
  }
}
```

Set the four env vars in your shell or systemd unit file. Avoid committing
real credentials — the `${VAR}` indirection in the config above pulls them
from the runtime environment.

For a fuller example with optional channel keys (spinnerPhrases,
typingEmoji, replyInThread, per-group overrides, allowBots) and the social
extension, copy [`examples/openclaw.example.json`](./examples/openclaw.example.json)
and trim what you don't need.

## 3. Restart OpenClaw

```bash
openclaw gateway restart
openclaw gateway status
```

Status should show `feishu` channel connected. Send a DM to your Lark bot —
you should see a streaming card reply.

## 4. (Optional) Enable the `feishu-social` extension

Disabled by default. To turn on the group-context injection, sender
registry, and storm-guard, add to your `openclaw.json`:

```jsonc
{
  "plugins": {
    "entries": {
      "openclaw-lark": {
        "config": {
          "social": {
            "enabled": true,
            "contextGroups": ["oc_xxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx"],
            "adminDisplayName": "Your Name"
          }
        }
      }
    }
  }
}
```

Then drop a `wiki-bots.json` (your member + bot registry) at the path the
extension expects:

```bash
mkdir -p ~/.openclaw/feishu-social
cp examples/wiki-bots.example.json ~/.openclaw/feishu-social/wiki-bots.json
# edit with your real openIds + names
```

See [`EXTENSIONS.md`](./EXTENSIONS.md) for the full hook contract,
configuration table, and the available context-template placeholders.

## Verify

```bash
# 1. Static check (syntax + patch markers)
bash scripts/smoke.sh

# 2. Replay a fixture (Feishu inbound parse path)
node scripts/replay-feishu-event.mjs test/fixtures/feishu/dm_text.example.json

# 3. End-to-end: DM your bot and confirm a streaming reply with model + token
#    footer in the card. If you enabled social, send a message in a tracked
#    group and confirm the agent has the group context (timeline, members)
#    available in the reply.
```

If smoke or replay fails, check that `openclaw plugins list` shows
`openclaw-lark` in the `enabled` set and that your shell exposes the four
`LARK_*` env vars.

## Troubleshooting

- **Channel doesn't register**: confirm `plugins.allow` includes
  `"openclaw-lark"`, not the npm package name.
- **"social extension not loaded"**: that log line is normal when
  `social.enabled` is false (the default). Set it to `true` if you want
  the extension active.
- **DM reply works, group reply doesn't**: check `channels.feishu.allowBots`
  (defaults to `'mentions'` upstream) and that the group is in
  `channels.feishu.groups` if you've narrowed admission via `groupPolicy`.
