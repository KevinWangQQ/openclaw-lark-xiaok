#!/usr/bin/env node
// scripts/migrate-config.mjs — Phase 2.4 config migrator.
//
// Rewrites ~/.openclaw/openclaw.json to fold the retired `feishu-bot-social`
// plugin entry into `plugins.entries["openclaw-lark"].config.social`, and
// expands `channels.feishu.spinnerStyle` into `channels.feishu.spinnerPhrases`
// using examples/spinner-phrases-{jarvis,lyra}.example.json.
//
// Usage:
//   node scripts/migrate-config.mjs                              # dry-run, prints summary
//   node scripts/migrate-config.mjs --apply                      # write changes
//   node scripts/migrate-config.mjs --apply --config <path>      # custom config path
//   node scripts/migrate-config.mjs --apply --force              # overwrite existing social block
//
// Idempotent: re-runs are no-ops once migrated.

import { readFileSync, writeFileSync, renameSync, existsSync } from 'node:fs';
import { homedir } from 'node:os';
import { join, dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const FORK_ROOT = resolve(__dirname, '..');

const args = process.argv.slice(2);
const argv = {
  apply: args.includes('--apply'),
  force: args.includes('--force'),
  help:  args.includes('-h') || args.includes('--help'),
  config: (() => {
    const i = args.indexOf('--config');
    return i >= 0 ? args[i + 1] : join(homedir(), '.openclaw', 'openclaw.json');
  })(),
};

if (argv.help) {
  console.log(readFileSync(import.meta.url ? fileURLToPath(import.meta.url) : './migrate-config.mjs', 'utf8')
    .split('\n').slice(0, 18).join('\n'));
  process.exit(0);
}

function loadJson(path) {
  return JSON.parse(readFileSync(path, 'utf8'));
}

function loadPhrasePool(style) {
  const path = join(FORK_ROOT, 'examples', `spinner-phrases-${style}.example.json`);
  if (!existsSync(path)) return null;
  return JSON.parse(readFileSync(path, 'utf8'));
}

function migrate(input) {
  const cfg = JSON.parse(JSON.stringify(input));
  const changes = [];

  // 1. Move feishu-bot-social entry into openclaw-lark.config.social
  const fbsEntry = cfg.plugins?.entries?.['feishu-bot-social'];
  if (fbsEntry) {
    cfg.plugins.entries['openclaw-lark'] ??= {};
    cfg.plugins.entries['openclaw-lark'].config ??= {};

    if (cfg.plugins.entries['openclaw-lark'].config.social && !argv.force) {
      throw new Error(
        'plugins.entries["openclaw-lark"].config.social already exists; ' +
        'pass --force to overwrite, or remove plugins.entries["feishu-bot-social"] manually.'
      );
    }

    cfg.plugins.entries['openclaw-lark'].config.social = fbsEntry.config ?? {};
    changes.push('moved feishu-bot-social.config → openclaw-lark.config.social');

    if (fbsEntry.hooks) {
      cfg.plugins.entries['openclaw-lark'].hooks = {
        ...(cfg.plugins.entries['openclaw-lark'].hooks ?? {}),
        ...fbsEntry.hooks,
      };
      changes.push('moved feishu-bot-social.hooks → openclaw-lark.hooks (allowConversationAccess)');
    }

    delete cfg.plugins.entries['feishu-bot-social'];
    changes.push('deleted plugins.entries["feishu-bot-social"]');
  }

  // 2. Drop "feishu-bot-social" from plugins.allow
  if (Array.isArray(cfg.plugins?.allow)) {
    const before = cfg.plugins.allow.length;
    cfg.plugins.allow = cfg.plugins.allow.filter(id => id !== 'feishu-bot-social');
    if (cfg.plugins.allow.length !== before) {
      changes.push('removed "feishu-bot-social" from plugins.allow');
    }
  }

  // 3. Expand channels.feishu.spinnerStyle → channels.feishu.spinnerPhrases
  const feishu = cfg.channels?.feishu;
  if (feishu && typeof feishu.spinnerStyle === 'string') {
    if (Array.isArray(feishu.spinnerPhrases) && feishu.spinnerPhrases.length > 0 && !argv.force) {
      changes.push(`note: spinnerStyle="${feishu.spinnerStyle}" left in place — spinnerPhrases already populated (use --force to override)`);
    } else {
      const style = feishu.spinnerStyle;
      const pool = loadPhrasePool(style);
      if (Array.isArray(pool)) {
        feishu.spinnerPhrases = pool;
        delete feishu.spinnerStyle;
        changes.push(`expanded channels.feishu.spinnerStyle="${style}" → spinnerPhrases (${pool.length} entries from examples/spinner-phrases-${style}.example.json)`);
      } else {
        changes.push(`warning: no examples/spinner-phrases-${style}.example.json — spinnerStyle="${style}" left in place`);
      }
    }
  }

  return { cfg, changes };
}

function main() {
  if (!existsSync(argv.config)) {
    console.error(`✗ config not found: ${argv.config}`);
    process.exit(1);
  }

  const input = loadJson(argv.config);
  const { cfg: output, changes } = migrate(input);

  if (changes.length === 0) {
    console.log(`✓ no migration needed: ${argv.config} is already on the fork schema`);
    process.exit(0);
  }

  console.log(`→ ${argv.apply ? 'applying' : 'dry-run for'}: ${argv.config}`);
  for (const c of changes) console.log(`  • ${c}`);

  if (!argv.apply) {
    console.log('\n(dry run — pass --apply to write changes)');
    process.exit(0);
  }

  // Atomic write with timestamped backup.
  const ts = new Date().toISOString().replace(/[:.]/g, '-').replace(/Z$/, '');
  const backupPath = `${argv.config}.bak-fork-migration-${ts}`;
  const tmpPath = `${argv.config}.tmp-${ts}`;

  writeFileSync(backupPath, readFileSync(argv.config));
  console.log(`→ backup: ${backupPath}`);

  writeFileSync(tmpPath, JSON.stringify(output, null, 2) + '\n');
  renameSync(tmpPath, argv.config);
  console.log(`✓ wrote: ${argv.config}`);
}

main();
