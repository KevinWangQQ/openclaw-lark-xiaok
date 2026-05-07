# Migration

How to move to `@lucien/openclaw-lark-extended` from a previous setup.
Pick the section matching your starting point.

## From upstream `@larksuite/openclaw-lark`

Recommended path for users who are already running upstream and want to
adopt this fork's schema completion + optional social extension.

1. **Install the fork**:

   ```bash
   openclaw plugins install @lucien/openclaw-lark-extended
   ```

2. **No `openclaw.json` changes needed for parity behavior.** The plugin
   id (`openclaw-lark`) and the channel id (`openclaw-lark`) match
   upstream — your existing `plugins.allow` and `channels.feishu.*` config
   continues to work as-is.

3. **Optional: adopt the new channel keys**. The fork declares these in
   the channel schema; you can now set them with confidence:

   - `channels.feishu.spinnerPhrases` — array of phrases shown next to
     the loading spinner (one chosen at random per turn)
   - `channels.feishu.typingEmoji` — single name or comma-separated pool
     (e.g. `'Get,DONE'`)
   - `channels.feishu.replyInThread` — bool / `'enabled'` to force agent
     replies into a thread for groups
   - `channels.feishu.groups[<chatId>].replyInThread`,
     `channels.feishu.groups[<chatId>].allowBots` — per-group overrides

   See [`CONFIGURATION.md`](./CONFIGURATION.md) for the full table and
   [`examples/openclaw.example.json`](./examples/openclaw.example.json) for
   a copy-paste snippet.

4. **Optional: turn on the social extension**. Disabled by default.
   Enabling it requires `social.enabled: true` plus a
   `~/.openclaw/feishu-social/wiki-bots.json` registry file. Walk through
   [`EXTENSIONS.md`](./EXTENSIONS.md).

5. **Restart the gateway**:

   ```bash
   openclaw gateway restart
   ```

To go back to upstream: `openclaw plugins install @larksuite/openclaw-lark`.

## From the legacy `feishu-bot-social` plugin

The original `feishu-bot-social` plugin is retired. Its functionality is
absorbed into this fork's optional `feishu-social` extension. To migrate:

1. **Uninstall the old plugin** and remove its entry from `openclaw.json`:

   ```bash
   openclaw plugins uninstall feishu-bot-social
   ```

   In `openclaw.json`:
   - Remove `"feishu-bot-social"` from `plugins.allow`
   - Move the contents of `plugins.entries["feishu-bot-social"].config`
     into `plugins.entries["openclaw-lark"].config.social`
   - Move `plugins.entries["feishu-bot-social"].hooks.allowConversationAccess`
     into `plugins.entries["openclaw-lark"].hooks` (same key)
   - Delete the `feishu-bot-social` entry

2. **Add `social.enabled: true`** to the migrated block. The old plugin
   was always-on; the new extension is opt-in.

3. **Move your `wiki-bots.json`** to the path the extension reads:

   ```bash
   mkdir -p ~/.openclaw/feishu-social
   mv <old-path>/wiki-bots.json ~/.openclaw/feishu-social/wiki-bots.json
   ```

   Or set `social.wikiBotsPath` to wherever you keep it.

4. **Spinner phrases**: if you used the old plugin's hardcoded
   `spinnerStyle: jarvis | lyra` profile selector, that's gone. Replace
   with `channels.feishu.spinnerPhrases: [...]` populated from
   [`examples/spinner-phrases-default.example.json`](./examples/spinner-phrases-default.example.json)
   or your own list. The old phrase pools are samples in
   `examples/spinner-phrases-playful-zh.example.json`.

5. **Restart**:

   ```bash
   openclaw gateway restart
   ```

After confirming the gateway is healthy, the
`~/.openclaw/extensions/feishu-bot-social/` directory is no longer loaded
and is safe to delete.

## Behavior changes worth flagging

- **`allowBots` default is `'mentions'`** (set by upstream `2026.5.7`).
  In groups, bots that previously sent passive messages without an
  @-mention will now be filtered. Override per-group via
  `channels.feishu.groups[<chatId>].allowBots: true` if you depend on
  that traffic.
- **`social.stormThreshold` default is now `5`** (was `2` in the old
  plugin). The old default was tuned for a small low-traffic group; the
  new default is conservative for general use. Set it back to `2` if you
  need the tighter trip behavior.
- **Default context template is neutral English** — the rich Chinese
  multi-bot template is no longer a built-in default. Paste
  [`examples/social-context-templates/multi-bot-zh.txt`](./examples/social-context-templates/multi-bot-zh.txt)
  into `social.contextTemplate` (or use your own) if you want it.
- **`adminDisplayName`** defaults to `'the admin'`. The old plugin
  hardcoded `'Lucien'` in rule ③ of the context template; the new
  template uses `{adminName}` and substitutes whatever you set here.
