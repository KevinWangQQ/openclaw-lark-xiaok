import { describe, it, expect, beforeEach, vi } from 'vitest';
import {
  formatContextBlock,
  DEFAULT_CONTEXT_TEMPLATE,
  renderTemplate,
  ContextCache,
} from '../src/extensions/feishu-social/context.js';
import {
  setUserName,
  clearUserNameCacheAll,
} from '../src/tools/oapi/im/name-resolver.js';

const fakeRegistry = {
  getDisplayBots: () => [],
  getMembers: () => [],
  findByOpenId: () => null,
  findByAppId: () => null,
};

describe('renderTemplate', () => {
  it('substitutes known placeholders', () => {
    expect(renderTemplate('Hello {name}, count={n}', { name: 'world', n: 3 }))
      .toBe('Hello world, count=3');
  });

  it('leaves unknown placeholders intact', () => {
    expect(renderTemplate('keep {unknown}', {})).toBe('keep {unknown}');
  });

  it('keeps the literal when a referenced var is missing', () => {
    expect(renderTemplate('a={a} b={b}', { a: 1 })).toBe('a=1 b={b}');
  });
});

describe('DEFAULT_CONTEXT_TEMPLATE', () => {
  it('is a non-empty string', () => {
    expect(typeof DEFAULT_CONTEXT_TEMPLATE).toBe('string');
    expect(DEFAULT_CONTEXT_TEMPLATE.length).toBeGreaterThan(0);
  });

  it('has no Jarvis / Lucien / Lyra / 蛋姐 / 小K persona references', () => {
    expect(DEFAULT_CONTEXT_TEMPLATE).not.toMatch(/Jarvis|Lucien|Lyra|蛋姐|小K/);
  });

  it('does not bake in a multi-bot anti-loop rule (that is opt-in via examples/social-context-templates/multi-bot-zh.txt)', () => {
    expect(DEFAULT_CONTEXT_TEMPLATE).not.toMatch(/不要主动发起 Bot 间来回对话|Bot 间来回/);
  });
});

describe('formatContextBlock with default template', () => {
  it('renders a block with no Jarvis/Lucien even when the registry is empty', () => {
    const block = formatContextBlock({
      messages: [],
      registry: fakeRegistry,
      chatId: 'oc_test',
      cfg: {},
    });
    expect(block).toMatch(/Group chat context/);
    expect(block).not.toMatch(/Jarvis|Lucien|Lyra/);
  });
});

describe('formatContextBlock with custom template', () => {
  it('substitutes adminName from cfg', () => {
    const block = formatContextBlock({
      messages: [],
      registry: fakeRegistry,
      chatId: 'oc_test',
      cfg: { contextTemplate: 'admin: {adminName}', adminDisplayName: 'Alice' },
    });
    expect(block).toBe('admin: Alice');
  });

  it("falls back to 'the admin' when adminDisplayName is unset", () => {
    const block = formatContextBlock({
      messages: [],
      registry: fakeRegistry,
      chatId: 'oc_test',
      cfg: { contextTemplate: 'admin: {adminName}' },
    });
    expect(block).toBe('admin: the admin');
  });

  it('passes count + time placeholders', () => {
    const block = formatContextBlock({
      messages: [{ msg_type: 'text' }, { msg_type: 'text' }],
      registry: fakeRegistry,
      chatId: 'oc_test',
      cfg: { contextTemplate: 'count={count} time={time}' },
    });
    expect(block).toMatch(/^count=2 time=\d{2}:\d{2}$/);
  });

  it('ignores empty-string contextTemplate and uses the default', () => {
    const block = formatContextBlock({
      messages: [],
      registry: fakeRegistry,
      chatId: 'oc_test',
      cfg: { contextTemplate: '   ' },
    });
    expect(block).toMatch(/Group chat context/);
  });
});

// ──────────────────────────────────────────────────────────────────────
// Phase 2: human sender cascade
// (mention → memberCache → user-name cache → last-8 fallback)
// ──────────────────────────────────────────────────────────────────────

describe('formatContextBlock — Phase 2 sender name cascade', () => {
  beforeEach(() => clearUserNameCacheAll());

  function userMsg({ id, name, mentions = [] }) {
    return {
      msg_type: 'text',
      create_time: '1700000000000',
      sender: name ? { id, sender_type: 'user', name } : { id, sender_type: 'user' },
      mentions,
      body: { content: JSON.stringify({ text: 'hi' }) },
    };
  }

  it('uses sender.name when set (simulates post-enrich state)', () => {
    const messages = [userMsg({ id: 'ou_aaaaaaaa11111111', name: 'EnrichedAlice' })];
    const block = formatContextBlock({
      messages,
      registry: fakeRegistry,
      chatId: 'oc_test',
      cfg: { contextTemplate: '{timeline}' },
    });
    expect(block).toMatch(/EnrichedAlice/);
    expect(block).not.toMatch(/用户\(/);
  });

  it('falls back through mention prefill when sender.name is missing', () => {
    const messages = [
      userMsg({
        id: 'ou_bbbbbbbb22222222',
        mentions: [{ id: { open_id: 'ou_bbbbbbbb22222222' }, name: 'MentionBob' }],
      }),
    ];
    const block = formatContextBlock({
      messages,
      registry: fakeRegistry,
      chatId: 'oc_test',
      cfg: { contextTemplate: '{timeline}' },
    });
    expect(block).toMatch(/MentionBob/);
  });

  it('falls back through memberCache when sender.name and mention prefill are missing', () => {
    const messages = [userMsg({ id: 'ou_cccccccc33333333' })];
    const memberCache = {
      getName: (id) => (id === 'ou_cccccccc33333333' ? 'MemberCarol' : null),
    };
    const block = formatContextBlock({
      messages,
      registry: fakeRegistry,
      chatId: 'oc_test',
      cfg: { contextTemplate: '{timeline}' },
      memberCache,
    });
    expect(block).toMatch(/MemberCarol/);
  });

  it('falls back through the shared user-name cache via accountId', () => {
    setUserName('acct-xyz', 'ou_dddddddd44444444', 'CachedDan');
    const messages = [userMsg({ id: 'ou_dddddddd44444444' })];
    const block = formatContextBlock({
      messages,
      registry: fakeRegistry,
      chatId: 'oc_test',
      cfg: { contextTemplate: '{timeline}' },
      accountId: 'acct-xyz',
    });
    expect(block).toMatch(/CachedDan/);
  });

  it('renders 用户(last8) when every cascade tier misses', () => {
    const messages = [userMsg({ id: 'ou_eeeeeeee55555555' })];
    const block = formatContextBlock({
      messages,
      registry: fakeRegistry,
      chatId: 'oc_test',
      cfg: { contextTemplate: '{timeline}' },
    });
    expect(block).toMatch(/用户\(55555555\)/);
  });
});

// ──────────────────────────────────────────────────────────────────────
// Phase 2: ContextCache.computeOnce inflight single-flight
// ──────────────────────────────────────────────────────────────────────

describe('ContextCache.computeOnce', () => {
  it('runs the producer fn exactly once for concurrent same-chatId callers', async () => {
    const cache = new ContextCache(60000);
    let fnCalls = 0;
    let resolveProducer;
    const producer = () =>
      new Promise((resolve) => {
        fnCalls++;
        resolveProducer = () => resolve('OK');
      });

    const p1 = cache.computeOnce('oc_x', producer);
    const p2 = cache.computeOnce('oc_x', producer);
    const p3 = cache.computeOnce('oc_x', producer);
    resolveProducer();
    const [r1, r2, r3] = await Promise.all([p1, p2, p3]);
    expect(fnCalls).toBe(1);
    expect(r1).toBe('OK');
    expect(r2).toBe('OK');
    expect(r3).toBe('OK');
    // Subsequent call hits the regular minute-keyed cache → still 1 invocation
    const r4 = await cache.computeOnce('oc_x', producer);
    expect(fnCalls).toBe(1);
    expect(r4).toBe('OK');
  });

  it('does not cache falsy producer results, allowing the next call to retry', async () => {
    const cache = new ContextCache(60000);
    let fnCalls = 0;
    const producer = async () => {
      fnCalls++;
      return null;
    };
    const r1 = await cache.computeOnce('oc_y', producer);
    expect(r1).toBeNull();
    const r2 = await cache.computeOnce('oc_y', producer);
    expect(fnCalls).toBe(2);
    expect(r2).toBeNull();
  });

  it('clears inflight on producer rejection so the next call retries', async () => {
    const cache = new ContextCache(60000);
    let fnCalls = 0;
    const producer = async () => {
      fnCalls++;
      throw new Error('boom');
    };
    await expect(cache.computeOnce('oc_z', producer)).rejects.toThrow('boom');
    await expect(cache.computeOnce('oc_z', producer)).rejects.toThrow('boom');
    expect(fnCalls).toBe(2);
  });
});
