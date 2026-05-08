# @xiaok/openclaw-lark-extended

[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](https://opensource.org/licenses/MIT)
[![Node.js Version](https://img.shields.io/badge/node-%3E%3D22-blue.svg)](https://nodejs.org/)

> **Community fork**, not the official ByteDance plugin. The upstream is
> [`@larksuite/openclaw-lark`](https://www.npmjs.com/package/@larksuite/openclaw-lark)
> ("OpenClaw Lark/Feishu channel plugin"). This fork tracks upstream and adds:
>
> 1. **Channel config schema completion** — declares the runtime keys
>    `spinnerPhrases`, `typingEmoji`, `replyInThread`, `allowBots`,
>    `threadSession`, and per-group overrides in `openclaw.plugin.json` and
>    in the runtime zod, where upstream currently leaves the channel schema
>    empty (`{type: "object"}`).
> 2. **Optional `feishu-social` extension** — disabled by default; opt in by
>    setting `social.enabled: true`. Provides group-context injection into
>    the agent's system prompt, an optional sender-name registry consulted
>    after upstream's user/bot OAPI fails, and a storm-guard that protects
>    against bot-to-bot reply loops in multi-bot chats.
>
> Both contributions are designed to be upstream-friendly. PRs back to
> `@larksuite/openclaw-lark` are an explicit goal; until that lands, this
> fork carries them.

## Status

- Upstream baseline: **`@larksuite/openclaw-lark@2026.5.7`**
  (force-rebaselined per release; see `CHANGELOG.md`).
- Fork version: **`0.1.1`** (semver from scratch).
- Distribution: **internal team share via git repo** for now; npm publish
  is not in scope. See [`STATUS.md`](./STATUS.md) for the current state of
  the world.
- Channel id stays **`openclaw-lark`** — installation routes through the
  same host-level channel registration as upstream. Only the npm package
  name differs.

## Install

### A. Internal team share (current path — git clone)

This fork is not on npm. Clone the repo and point OpenClaw's extension
loader at the working tree.

```bash
# 1. Clone wherever you keep development repos
git clone <internal-git-url>/openclaw-lark-extended ~/Projects/openclaw-lark-extended
cd ~/Projects/openclaw-lark-extended
git checkout main                                # public-ready branch
pnpm install                                     # devDeps for tests; optional for runtime

# 2. Point OpenClaw at the working tree (one-time symlink)
mkdir -p ~/.openclaw/extensions
ln -sfn ~/Projects/openclaw-lark-extended ~/.openclaw/extensions/openclaw-lark

# 3. Enable in plugins.allow + restart
#    (channel id is 'openclaw-lark' — same as upstream)
openclaw gateway restart
```

### B. Future: published-package install (when this fork ships to npm)

```bash
# Via OpenClaw's plugin manager
openclaw plugins install @xiaok/openclaw-lark-extended

# Or via npm
npm install -g @xiaok/openclaw-lark-extended
```

This path is not currently active — the package has not been published.

### Prerequisites

- **Node.js** ≥ 22
- **OpenClaw** ≥ `2026.3.22` (peer dependency, optional)

See [`INSTALL.md`](./INSTALL.md) for the minimal `openclaw.json` snippet
and a step-by-step walkthrough including credential setup.

## Documentation

| Topic | Doc |
|---|---|
| Current project state, branches, deployment record | [`STATUS.md`](./STATUS.md) |
| First-time install + minimal config | [`INSTALL.md`](./INSTALL.md) |
| Every channel + plugin config key, defaults, examples | [`CONFIGURATION.md`](./CONFIGURATION.md) |
| Optional `feishu-social` extension — opt-in, hooks, customization | [`EXTENSIONS.md`](./EXTENSIONS.md) |
| Migrating from upstream `@larksuite/openclaw-lark` or legacy `feishu-bot-social` | [`MIGRATION.md`](./MIGRATION.md) |
| Release history relative to upstream | [`CHANGELOG.md`](./CHANGELOG.md) |
| Sample config snippets | [`examples/`](./examples/) |

## Security & risk warnings

This package integrates with OpenClaw's AI automation capabilities and
inherits the same risk profile as the upstream plugin:

- AI hallucination, unpredictable execution, prompt injection.
- After Feishu/Lark authorization, OpenClaw acts under your user identity
  within the granted scope, which can lead to data leakage or unauthorized
  operations.

The default channel config is conservative; `feishu-social` is opt-in and
disabled by default. Review your `openclaw.json` before deploying to
shared environments.

You are responsible for reviewing the source you run. By using this
package you accept that responsibility.

## Relationship to upstream

This fork:
- Re-baselines `upstream/main` from each upstream npm release (see
  `CHANGELOG.md`).
- Carries fork-only changes on `main` until they are upstreamed (or
  rejected).
- Is independent of and not endorsed by the upstream maintainers.

If you want the official, upstream-maintained plugin, install
`@larksuite/openclaw-lark` instead.

## License

MIT, inherited from upstream. See [`LICENSE`](./LICENSE).

The upstream plugin is © ByteDance Ltd. and/or its affiliates.

## Feishu/Lark Open Platform terms

When this plugin runs it calls the Lark/Feishu Open Platform APIs. To use
those APIs you must comply with the Lark/Feishu privacy policies and terms
of service. See the upstream README for the canonical link list.
