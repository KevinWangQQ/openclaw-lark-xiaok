# XiaoK OpenClaw Lark Fork Sync Runbook

Repository: https://github.com/KevinWangQQ/openclaw-lark-xiaok

Remotes:
- `upstream` -> https://github.com/larksuite/openclaw-lark.git
- `jarvis` -> https://github.com/ChenyqThu/openclaw-lark-extended.git
- `origin` -> XiaoK/Kevin maintained fork

Normal sync flow:

```bash
cd /Users/kevin/.openclaw/workspace/vendor/openclaw-lark-xiaok
git fetch upstream main
git fetch jarvis main
git fetch origin main
git checkout main
git merge upstream/main
git merge jarvis/main
# resolve conflicts, keep XiaoK package metadata/repo URL
git push origin main
rsync -a --delete --exclude .git ./ ~/.openclaw/npm/node_modules/@larksuite/openclaw-lark/
```

After local sync, validate:

```bash
cd ~/.openclaw/npm/node_modules/@larksuite/openclaw-lark
node -e "require('./index.js'); require('./src/extensions/feishu-social/index.js'); require('./src/tools/oapi/im/name-resolver.js'); console.log('ok')"
```

Then reload OpenClaw Gateway with the first-class `gateway restart` tool.

Notes:
- Do not overwrite local OpenClaw config.
- Preserve our read-actions/message tool patches when resolving conflicts.
- Jarvis fork remains an inspiration remote, not the canonical deployment source.
