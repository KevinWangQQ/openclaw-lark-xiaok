# Spike — disabling mid-turn append for groups (Phase 5)

> Phase 5 of the fork plan asks for a way to stop the runtime from folding
> consecutive group messages from different senders into one in-flight turn
> (fork plan §6.2, Bug B). The plan reserves the option to ship a plugin-level
> wrapper around `src/messaging/inbound/dispatch.js` if the runtime doesn't
> expose a config knob. After spiking, **a config knob exists** — no plugin
> patch needs to ship.

## What the plugin already does

Every inbound feishu message goes through `enqueueFeishuChatTask` in
`src/channel/chat-queue.js`, which serializes per `(accountId, chatId, threadId)`.
A second message arriving while a task is in flight chains via `prev.then(task, task)` —
it does NOT fold into the running task; it queues for after.

So at the *plugin* layer, A's turn finishes before B's turn starts. The
"mid-turn append" symptom must originate further down, in the runtime's
reply dispatcher.

## What the runtime exposes

`node_modules/openclaw/dist/runtime-schema-BK6Uhz38.js` declares the
`messages.queue` schema. Excerpt:

```
messages.queue.mode      — "steer" | "queue" | "followup" | "collect" | "steer-backlog" | "interrupt"
messages.queue.byChannel — Per-channel queue mode overrides keyed by provider id
                           (for example telegram, discord, slack). Use this when one
                           channel's traffic pattern needs different queue behavior
                           than global defaults.
messages.queue.debounceMs / debounceMsByChannel
messages.queue.cap / drop
```

`mode = "steer"` is the current global setting in `~/.openclaw/openclaw.json`
and is exactly the source of mid-turn append: queued messages get injected at
the next model boundary in the same active run. From the schema's own help:

> "Use 'steer' to inject all queued steering messages at the next model boundary;
>  'queue' is legacy one-at-a-time steering;
>  'followup' runs later;
>  'collect' batches later;
>  'steer-backlog' does both;
>  'interrupt' aborts the active run."

## Recommendation

Add a per-channel override in `~/.openclaw/openclaw.json`:

```json
"messages": {
  "queue": {
    "mode": "steer",
    "byChannel": {
      "feishu": "queue"
    },
    "debounceMs": 500
  }
}
```

This makes the feishu channel use the legacy serial queue regardless of the
global mode. Each new message triggers a fresh dispatch after the previous
one finishes. Bug B is resolved without writing or deploying any plugin code.

## Tradeoff: DM behavior changes too

`byChannel` is keyed by provider id (`feishu`), not by chat id. The runtime
does **not** expose a per-group override; the schema's `byChannel` is the
finest granularity available. Setting `feishu: "queue"` therefore also
applies to feishu DMs.

For Lucien's setup the tradeoff is small:
- DM with Jarvis loses the ability to steer a long answer mid-stream by
  typing a follow-up. The follow-up will still be processed, but as a fresh
  reply after the current one completes.
- Groups stop folding multi-sender bursts into a single turn — the desired
  fix for Bug B.

Phase 4's `[name](open_id):` sender labeling already mitigates the *symptom*
(the agent can disambiguate even if appended), so the user can pick:

1. **Keep `mode: "steer"`, rely on Phase 4 sender labels** — minimum
   behavior change; trust the agent to handle multi-sender turns correctly
   thanks to the open-id annotation.
2. **Add `byChannel.feishu: "queue"`** — full hard-block on append at the
   runtime layer, plus Phase 4 sender labels as defense-in-depth.

Recommended: ship Phase 4 first, observe behavior in groups for a few days,
then decide whether the residual mid-turn append risk warrants flipping the
queue mode.

## What's NOT in scope for this fork

Per-group queue mode (e.g. `messages.queue.byGroup` keyed by `oc_*` chat id)
would require a runtime schema change. If empirically Phase 4 + group-wide
`byChannel.feishu: "queue"` is too coarse and DMs need to stay on `steer`,
file an upstream feature request at `larksuite/openclaw` for per-group
queue overrides — the schema's `byChannel` design suggests that direction
is plausible, but it's not currently exposed.

## Companion config snippet for `migrate-config.mjs`

The migrator does **not** apply this change automatically (DM tradeoff is
non-trivial). Users who want it can append the snippet above to the
`messages.queue` block in their `openclaw.json` after running the migrator.
A note has been added to `MIGRATION.md` so users see the option.
