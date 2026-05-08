import { describe, it, expect } from 'vitest';
import { Value } from '@sinclair/typebox/value';
import { FeishuImMessageSchema } from '../src/tools/oapi/im/message-schema.js';

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
});
