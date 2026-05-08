import { describe, it, expect } from 'vitest';
import { Value } from '@sinclair/typebox/value';
import { FeishuImMessageSchema } from '../src/tools/oapi/im/message-schema.js';
import { parseImUrl } from '../src/tools/oapi/im/url-parser.js';

// Phase 3 schema-validation suite. Source-of-truth lives in message-schema.js
// (a leaf module — only depends on @sinclair/typebox) so vitest can load it
// without triggering message.js's heavy CJS dep chain (which transitively
// pulls core/lark-client → core/version and crashes ESM resolution).

// NOTE: send / reply variants use Type.Unsafe (via StringEnum) for
// receive_id_type / msg_type, which TypeBox Value.Check can't introspect.
// Those branches are unchanged Phase 0 baseline code, so we focus this suite
// on the 5 new read actions added in Phase 3 (list/get/search/thread/members).
describe('FeishuImMessageSchema — Phase 3 read action variants', () => {
  it('accepts {action:list} with no filters (all fields optional)', () => {
    expect(Value.Check(FeishuImMessageSchema, { action: 'list' })).toBe(true);
  });

  it('accepts {action:list, chat_id, relative_time, page_size}', () => {
    expect(
      Value.Check(FeishuImMessageSchema, {
        action: 'list',
        chat_id: 'oc_xxx',
        relative_time: 'today',
        page_size: 30,
      })
    ).toBe(true);
  });

  it('accepts {action:get, message_id}', () => {
    expect(
      Value.Check(FeishuImMessageSchema, { action: 'get', message_id: 'om_xxx' })
    ).toBe(true);
  });

  it('rejects {action:get} without message_id', () => {
    expect(Value.Check(FeishuImMessageSchema, { action: 'get' })).toBe(false);
  });

  it('accepts {action:search, query, sender_ids}', () => {
    expect(
      Value.Check(FeishuImMessageSchema, {
        action: 'search',
        query: 'hello',
        sender_ids: ['ou_a', 'ou_b'],
      })
    ).toBe(true);
  });

  it('accepts {action:thread, thread_id}', () => {
    expect(
      Value.Check(FeishuImMessageSchema, { action: 'thread', thread_id: 'omt_xxx' })
    ).toBe(true);
  });

  it('rejects {action:thread} without thread_id', () => {
    expect(Value.Check(FeishuImMessageSchema, { action: 'thread' })).toBe(false);
  });

  it('accepts {action:members, chat_id}', () => {
    expect(
      Value.Check(FeishuImMessageSchema, { action: 'members', chat_id: 'oc_xxx' })
    ).toBe(true);
  });

  it('rejects {action:members} without chat_id', () => {
    expect(Value.Check(FeishuImMessageSchema, { action: 'members' })).toBe(false);
  });

  it('rejects unknown action', () => {
    expect(
      Value.Check(FeishuImMessageSchema, { action: 'unknown_action' })
    ).toBe(false);
  });

  // ── Phase 4 ──
  it('accepts {action:mget, message_ids: [...]}', () => {
    expect(
      Value.Check(FeishuImMessageSchema, {
        action: 'mget',
        message_ids: ['om_a', 'om_b'],
      })
    ).toBe(true);
  });

  it('rejects {action:mget} without message_ids', () => {
    expect(Value.Check(FeishuImMessageSchema, { action: 'mget' })).toBe(false);
  });

  it('rejects {action:mget, message_ids: []} (minItems:1)', () => {
    expect(
      Value.Check(FeishuImMessageSchema, { action: 'mget', message_ids: [] })
    ).toBe(false);
  });

  it('accepts {action:reactions, message_id}', () => {
    expect(
      Value.Check(FeishuImMessageSchema, {
        action: 'reactions',
        message_id: 'om_xxx',
      })
    ).toBe(true);
  });

  it('rejects {action:reactions} without message_id', () => {
    expect(Value.Check(FeishuImMessageSchema, { action: 'reactions' })).toBe(false);
  });

  it('accepts {action:resolve_url, url}', () => {
    expect(
      Value.Check(FeishuImMessageSchema, {
        action: 'resolve_url',
        url: 'https://abc.feishu.cn/im/...?msg_id=om_xxx',
      })
    ).toBe(true);
  });

  it('rejects {action:resolve_url} without url', () => {
    expect(Value.Check(FeishuImMessageSchema, { action: 'resolve_url' })).toBe(false);
  });
});

// ──────────────────────────────────────────────────────────────────────
// Phase 4: parseImUrl — pure regex, IM-only
// ──────────────────────────────────────────────────────────────────────

describe('parseImUrl', () => {
  it('extracts message_id and chat_id from a query-string URL', () => {
    const r = parseImUrl('https://acme.feishu.cn/im/chat?msg_id=om_aaaaaa&chat_id=oc_bbbbbb');
    expect(r.resolved).toBe(true);
    expect(r.message_id).toBe('om_aaaaaa');
    expect(r.chat_id).toBe('oc_bbbbbb');
  });

  it('extracts thread_id when present', () => {
    const r = parseImUrl('https://acme.feishu.cn/im/something?thread=omt_xyz123');
    expect(r.resolved).toBe(true);
    expect(r.thread_id).toBe('omt_xyz123');
  });

  it('extracts chat_id from /messenger/chat/oc_... path', () => {
    const r = parseImUrl('https://acme.feishu.cn/messenger/chat/oc_abcdef');
    expect(r.resolved).toBe(true);
    expect(r.chat_id).toBe('oc_abcdef');
  });

  it('handles Lark international hosts', () => {
    const r = parseImUrl('https://x.larksuite.com/im/...?msg_id=om_lark1');
    expect(r.resolved).toBe(true);
    expect(r.message_id).toBe('om_lark1');
  });

  it('rejects cloud-doc URLs (architect §7 — drive tool territory)', () => {
    const r = parseImUrl('https://acme.feishu.cn/wiki/wikabcd?from=share');
    expect(r.resolved).toBe(false);
    expect(r.reason).toBe('not_im_url');
  });

  it('rejects non-Feishu hosts', () => {
    const r = parseImUrl('https://example.com/im/foo?msg_id=om_x');
    expect(r.resolved).toBe(false);
    expect(r.reason).toBe('not_feishu_host');
  });

  it('rejects empty input', () => {
    expect(parseImUrl('').reason).toBe('empty_input');
    expect(parseImUrl(null).reason).toBe('empty_input');
    expect(parseImUrl(undefined).reason).toBe('empty_input');
  });

  it('rejects IM-shaped path with no recognisable id', () => {
    const r = parseImUrl('https://acme.feishu.cn/im/landing');
    expect(r.resolved).toBe(false);
    expect(r.reason).toBe('no_id_found');
  });

  it('rejects malformed URL', () => {
    const r = parseImUrl('not a url');
    expect(r.resolved).toBe(false);
  });
});
