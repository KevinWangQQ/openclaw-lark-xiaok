#!/usr/bin/env node
// scripts/replay-feishu-event.mjs — load a Feishu fixture and dispatch it through
// the plugin's handlers without booting the gateway.
//
// Phase 0 stub: validates fixture shape and lists what would be invoked.
// Phase 2 fills in the real api/runtime/cfg stubs (port from
// feishu-bot-social/test/integration.js:80-84,152-155).
//
// Usage:
//   node scripts/replay-feishu-event.mjs test/fixtures/feishu/dm_text.json

import { readFileSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const FORK_ROOT = resolve(__dirname, '..');

const fixturePath = process.argv[2];
if (!fixturePath) {
  console.error('usage: node scripts/replay-feishu-event.mjs <fixture-path>');
  process.exit(2);
}

const absPath = resolve(process.cwd(), fixturePath);
const fixture = JSON.parse(readFileSync(absPath, 'utf8'));

console.log('→ fixture:', absPath);
console.log('→ kind:', fixture.kind ?? '(unset)');

if (!fixture.kind) {
  console.error('fixture missing required field "kind" (one of: inbound_message, card_action, message_sending)');
  process.exit(1);
}

switch (fixture.kind) {
  case 'inbound_message': {
    const ev = fixture.event ?? {};
    const msg = ev.message ?? {};
    const sender = ev.sender?.sender_id ?? {};
    console.log(`  chat_id=${msg.chat_id} chat_type=${msg.chat_type} sender_open_id=${sender.open_id}`);
    console.log('  TODO Phase 2: invoke handleFeishuMessage from src/messaging/inbound/handler.js');
    break;
  }
  case 'card_action': {
    const op = fixture.event?.operator ?? {};
    console.log(`  operator_open_id=${op.open_id} action=${JSON.stringify(fixture.event?.action ?? {})}`);
    console.log('  TODO Phase 2: invoke handleCardActionEvent from src/channel/event-handlers.js');
    break;
  }
  case 'message_sending': {
    console.log(`  channelId=${fixture.ctx?.channelId} content=${JSON.stringify(fixture.event?.content ?? '')}`);
    console.log('  TODO Phase 2: invoke message_sending hook from src/extensions/feishu-social/index.js');
    break;
  }
  default:
    console.error(`unknown fixture.kind: ${fixture.kind}`);
    process.exit(1);
}

console.log('✓ fixture parsed (Phase 0 stub — handler invocation lands in Phase 2)');
console.log(`  fork root: ${FORK_ROOT}`);
