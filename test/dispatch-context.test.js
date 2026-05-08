// Imports the pure helper directly. The full dispatch-context.js pulls in
// lark-client → version which trips vitest's ESM loader on import.meta.url.
import { describe, it, expect } from 'vitest';
import { resolveReplyInThread } from '../src/messaging/inbound/reply-in-thread.js';

describe('resolveReplyInThread precedence', () => {
  it('returns false when the cfg is empty / undefined', () => {
    expect(resolveReplyInThread({}, 'oc_x')).toBe(false);
    expect(resolveReplyInThread(undefined, 'oc_x')).toBe(false);
  });

  it('account-level true applies when no group entry exists', () => {
    expect(resolveReplyInThread({ replyInThread: true }, 'oc_x')).toBe(true);
  });

  it("the string 'enabled' is also truthy", () => {
    expect(resolveReplyInThread({ replyInThread: 'enabled' }, 'oc_x')).toBe(true);
  });

  it('account-level false stays false', () => {
    expect(resolveReplyInThread({ replyInThread: false }, 'oc_x')).toBe(false);
  });

  it('an unrecognized string is treated as false', () => {
    expect(resolveReplyInThread({ replyInThread: 'maybe' }, 'oc_x')).toBe(false);
  });

  it('the wildcard group setting overrides the account-level value', () => {
    const cfg = {
      replyInThread: true,
      groups: { '*': { replyInThread: false } },
    };
    expect(resolveReplyInThread(cfg, 'oc_unlisted')).toBe(false);
  });

  it('a per-group setting overrides both wildcard and account', () => {
    const cfg = {
      replyInThread: false,
      groups: {
        '*': { replyInThread: false },
        'oc_specific': { replyInThread: true },
      },
    };
    expect(resolveReplyInThread(cfg, 'oc_specific')).toBe(true);
    expect(resolveReplyInThread(cfg, 'oc_unlisted')).toBe(false);
  });

  it('per-group false beats account-level true', () => {
    const cfg = {
      replyInThread: true,
      groups: { 'oc_specific': { replyInThread: false } },
    };
    expect(resolveReplyInThread(cfg, 'oc_specific')).toBe(false);
  });

  it('only matches the chatId on the per-group key, not partial matches', () => {
    const cfg = {
      groups: { 'oc_aaa': { replyInThread: true } },
    };
    expect(resolveReplyInThread(cfg, 'oc_bbb')).toBe(false);
  });
});
