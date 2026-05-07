import { describe, it, expect, beforeEach, vi } from 'vitest';
import {
  resolveUserName,
  peekUserName,
  setUserName,
  batchResolveUserNames,
  prefillUserNamesFromMentions,
  resolveChatName,
  batchResolveChatNames,
  enrichSendersInPlace,
  clearUserNameCacheAll,
  clearChatNameCache,
} from '../src/tools/oapi/im/name-resolver.js';

const ACCT = 'acct-test';

beforeEach(() => {
  clearUserNameCacheAll();
  clearChatNameCache();
});

// ──────────────────────────────────────────────────────────────────────
// prefillUserNamesFromMentions
// ──────────────────────────────────────────────────────────────────────

describe('prefillUserNamesFromMentions', () => {
  it('writes mention names into the shared user-name cache', () => {
    const items = [
      { mentions: [{ id: { open_id: 'ou_a' }, name: 'Alice' }] },
      { mentions: [{ id: 'ou_b', name: 'Bob' }] },
      { mentions: [{ id: { open_id: 'ou_c' }, name: '' }] },
      { mentions: [] },
      {},
    ];
    const n = prefillUserNamesFromMentions(ACCT, items);
    expect(n).toBe(2);
    expect(resolveUserName(ACCT, 'ou_a')).toBe('Alice');
    expect(resolveUserName(ACCT, 'ou_b')).toBe('Bob');
    expect(resolveUserName(ACCT, 'ou_c')).toBeUndefined();
  });

  it('handles empty / non-array input without throwing', () => {
    expect(prefillUserNamesFromMentions(ACCT, [])).toBe(0);
    expect(prefillUserNamesFromMentions(ACCT, null)).toBe(0);
    expect(prefillUserNamesFromMentions(undefined, [{}])).toBe(0);
  });
});

// ──────────────────────────────────────────────────────────────────────
// '' sentinel invariants (via setUserName / peekUserName)
// ──────────────────────────────────────────────────────────────────────

describe("'' sentinel invariants", () => {
  it('never overwrites a real cached name with the empty sentinel', () => {
    setUserName(ACCT, 'ou_a', 'Alice');
    setUserName(ACCT, 'ou_a', '');
    expect(peekUserName(ACCT, 'ou_a')).toBe('Alice');
  });

  it("allows a real name to overwrite an existing '' sentinel (UAT resolves what TAT couldn't)", () => {
    setUserName(ACCT, 'ou_a', '');
    expect(peekUserName(ACCT, 'ou_a')).toBe('');
    setUserName(ACCT, 'ou_a', 'Alice');
    expect(peekUserName(ACCT, 'ou_a')).toBe('Alice');
  });

  it("writes the '' sentinel only when no entry exists", () => {
    setUserName(ACCT, 'ou_a', '');
    expect(peekUserName(ACCT, 'ou_a')).toBe('');
  });
});

// ──────────────────────────────────────────────────────────────────────
// resolveUserName
// ──────────────────────────────────────────────────────────────────────

describe('resolveUserName', () => {
  it("returns undefined for the '' sentinel so callers fall back to render-layer last-8", () => {
    setUserName(ACCT, 'ou_a', '');
    expect(resolveUserName(ACCT, 'ou_a')).toBeUndefined();
    // peekUserName confirms the sentinel really is in the cache
    expect(peekUserName(ACCT, 'ou_a')).toBe('');
  });

  it('returns the cached name when present', () => {
    setUserName(ACCT, 'ou_a', 'Alice');
    expect(resolveUserName(ACCT, 'ou_a')).toBe('Alice');
  });

  it('returns undefined for missing accountId / openId', () => {
    expect(resolveUserName('', 'ou_a')).toBeUndefined();
    expect(resolveUserName(ACCT, '')).toBeUndefined();
  });
});

// ──────────────────────────────────────────────────────────────────────
// batchResolveUserNames
// ──────────────────────────────────────────────────────────────────────

function makeUatClient(behavior) {
  return {
    account: { accountId: ACCT },
    invoke: vi.fn(async (toolName, sdkCallback, opts) => {
      const captured = {};
      const fakeSdk = {
        request: (req) => {
          captured.req = req;
        },
      };
      sdkCallback(fakeSdk, opts);
      return behavior(captured.req);
    }),
  };
}

describe('batchResolveUserNames', () => {
  it('returns cached names without an API call', async () => {
    setUserName(ACCT, 'ou_a', 'Alice');
    const client = makeUatClient(() => {
      throw new Error('UAT must not be called when cache has the name');
    });
    const result = await batchResolveUserNames({
      client,
      openIds: ['ou_a'],
      log: () => {},
    });
    expect(client.invoke).not.toHaveBeenCalled();
    expect(result.get('ou_a')).toBe('Alice');
  });

  it('dedupes openIds before calling the UAT API', async () => {
    let received;
    const client = makeUatClient((req) => {
      received = req.data.user_ids;
      return { code: 0, data: { users: [{ user_id: 'ou_a', name: 'Alice' }] } };
    });
    await batchResolveUserNames({
      client,
      openIds: ['ou_a', 'ou_a', 'ou_a'],
      log: () => {},
    });
    expect(client.invoke).toHaveBeenCalledTimes(1);
    expect(received).toEqual(['ou_a']);
  });

  it("writes '' sentinel for IDs the API didn't return so subsequent calls don't retry", async () => {
    const client = makeUatClient(() => ({
      code: 0,
      data: { users: [{ user_id: 'ou_a', name: 'Alice' }] },
    }));
    await batchResolveUserNames({
      client,
      openIds: ['ou_a', 'ou_b'],
      log: () => {},
    });
    expect(peekUserName(ACCT, 'ou_b')).toBe('');
    // Second call with the same IDs hits cache for both — no new API.
    await batchResolveUserNames({
      client,
      openIds: ['ou_a', 'ou_b'],
      log: () => {},
    });
    expect(client.invoke).toHaveBeenCalledTimes(1);
  });

  it('chunks at 10 IDs per UAT call', async () => {
    const calls = [];
    const client = makeUatClient((req) => {
      calls.push(req.data.user_ids.slice());
      return {
        code: 0,
        data: {
          users: req.data.user_ids.map((id) => ({
            user_id: id,
            name: id.toUpperCase(),
          })),
        },
      };
    });
    const ids = Array.from({ length: 23 }, (_, i) => `ou_${String(i).padStart(2, '0')}`);
    await batchResolveUserNames({ client, openIds: ids, log: () => {} });
    expect(calls.length).toBe(3);
    expect(calls[0].length).toBe(10);
    expect(calls[1].length).toBe(10);
    expect(calls[2].length).toBe(3);
  });

  it('re-throws structured InvokeError so outer auto-auth handler can run', async () => {
    class UserAuthRequiredError extends Error {
      constructor() {
        super('user auth required');
        this.name = 'UserAuthRequiredError';
      }
    }
    const client = makeUatClient(() => {
      throw new UserAuthRequiredError();
    });
    await expect(
      batchResolveUserNames({ client, openIds: ['ou_a'], log: () => {} })
    ).rejects.toBeInstanceOf(UserAuthRequiredError);
  });

  it('swallows non-InvokeError and returns partial results', async () => {
    const client = makeUatClient(() => {
      throw new Error('network drop');
    });
    const result = await batchResolveUserNames({
      client,
      openIds: ['ou_a'],
      log: () => {},
    });
    expect(result.size).toBe(0);
  });

  it('accepts name as { value: string } shape', async () => {
    const client = makeUatClient(() => ({
      code: 0,
      data: { users: [{ user_id: 'ou_a', name: { value: 'AliceObj' } }] },
    }));
    const result = await batchResolveUserNames({
      client,
      openIds: ['ou_a'],
      log: () => {},
    });
    expect(result.get('ou_a')).toBe('AliceObj');
  });
});

// ──────────────────────────────────────────────────────────────────────
// batchResolveChatNames + resolveChatName
// ──────────────────────────────────────────────────────────────────────

describe('batchResolveChatNames', () => {
  it('caches chat info and warms p2p target user-name cache', async () => {
    const chatInvocations = [];
    const userInvocations = [];
    const client = {
      account: { accountId: ACCT },
      invokeByPath: vi.fn(async (toolName, path, opts) => {
        chatInvocations.push({ path, body: opts.body });
        return {
          code: 0,
          data: {
            items: [
              { chat_id: 'oc_g', name: 'Engineering', chat_mode: 'group' },
              { chat_id: 'oc_p', name: '', chat_mode: 'p2p', p2p_target_id: 'ou_target' },
            ],
          },
        };
      }),
      invoke: vi.fn(async (toolName, sdkCallback, opts) => {
        const captured = {};
        sdkCallback({ request: (r) => { captured.req = r; } }, opts);
        userInvocations.push(captured.req.data.user_ids);
        return {
          code: 0,
          data: { users: [{ user_id: 'ou_target', name: 'TargetUser' }] },
        };
      }),
    };
    const r = await batchResolveChatNames({
      client,
      chatIds: ['oc_g', 'oc_p'],
      log: () => {},
    });
    expect(chatInvocations.length).toBe(1);
    expect(userInvocations.length).toBe(1);
    expect(userInvocations[0]).toEqual(['ou_target']);
    expect(r.get('oc_g').name).toBe('Engineering');
    expect(r.get('oc_p').p2p_target_id).toBe('ou_target');
    expect(resolveChatName(ACCT, 'oc_g').name).toBe('Engineering');
    expect(resolveUserName(ACCT, 'ou_target')).toBe('TargetUser');
    // Second call: full cache hit, no new API.
    await batchResolveChatNames({
      client,
      chatIds: ['oc_g', 'oc_p'],
      log: () => {},
    });
    expect(chatInvocations.length).toBe(1);
    expect(userInvocations.length).toBe(1);
  });

  it('returns empty Map for empty input without invoking the client', async () => {
    const client = { account: { accountId: ACCT }, invoke: vi.fn(), invokeByPath: vi.fn() };
    const r = await batchResolveChatNames({ client, chatIds: [], log: () => {} });
    expect(r.size).toBe(0);
    expect(client.invokeByPath).not.toHaveBeenCalled();
  });
});

// ──────────────────────────────────────────────────────────────────────
// enrichSendersInPlace cascade
// ──────────────────────────────────────────────────────────────────────

describe('enrichSendersInPlace cascade', () => {
  function freshMessages() {
    return [
      {
        sender: { id: 'ou_mention', sender_type: 'user' },
        mentions: [{ id: { open_id: 'ou_mention' }, name: 'MentionUser' }],
      },
      { sender: { id: 'ou_member', sender_type: 'user' } },
      { sender: { id: 'ou_cached', sender_type: 'user' } },
      { sender: { id: 'ou_batch', sender_type: 'user' } },
      { sender: { id: 'ou_unresolved', sender_type: 'user' } },
      { sender: { id: 'cli_a1b2', sender_type: 'app' } },
    ];
  }

  it('cascades: mention prefill → memberCache → user cache → batchResolve', async () => {
    setUserName(ACCT, 'ou_cached', 'CachedUser');
    const memberCache = {
      getName: (id) => (id === 'ou_member' ? 'MemberUser' : null),
    };
    const seen = [];
    const batchResolve = async (ids) => {
      seen.push(ids);
      return new Map([['ou_batch', 'BatchUser']]);
    };
    const messages = freshMessages();
    const r = await enrichSendersInPlace({
      messages,
      accountId: ACCT,
      batchResolve,
      memberCache,
    });
    expect(messages[0].sender.name).toBe('MentionUser');
    expect(messages[1].sender.name).toBe('MemberUser');
    expect(messages[2].sender.name).toBe('CachedUser');
    expect(messages[3].sender.name).toBe('BatchUser');
    expect(messages[4].sender.name).toBeUndefined();
    expect(messages[5].sender.name).toBeUndefined();
    expect(seen.length).toBe(1);
    expect([...seen[0]].sort()).toEqual(['ou_batch', 'ou_unresolved'].sort());
    expect(r.resolvedCount).toBeGreaterThan(0);
    expect(r.missingCount).toBe(1);
  });

  it('does not throw when batchResolve fails — leaves senders unset', async () => {
    const batchResolve = async () => {
      throw new Error('boom');
    };
    const messages = [{ sender: { id: 'ou_x', sender_type: 'user' } }];
    const r = await enrichSendersInPlace({
      messages,
      accountId: ACCT,
      batchResolve,
      log: () => {},
    });
    expect(messages[0].sender.name).toBeUndefined();
    expect(r.missingCount).toBe(1);
  });

  it('skips batchResolve entirely when all senders resolved from caches', async () => {
    setUserName(ACCT, 'ou_x', 'X');
    let called = false;
    const batchResolve = async () => {
      called = true;
      return new Map();
    };
    const messages = [{ sender: { id: 'ou_x', sender_type: 'user' } }];
    await enrichSendersInPlace({ messages, accountId: ACCT, batchResolve });
    expect(called).toBe(false);
    expect(messages[0].sender.name).toBe('X');
  });

  it('handles empty / malformed input without throwing', async () => {
    const batchResolve = async () => new Map();
    await expect(
      enrichSendersInPlace({ messages: [], accountId: ACCT, batchResolve })
    ).resolves.toEqual({ resolvedCount: 0, missingCount: 0 });
    await expect(
      enrichSendersInPlace({ messages: null, accountId: ACCT, batchResolve })
    ).resolves.toEqual({ resolvedCount: 0, missingCount: 0 });
  });
});

// ──────────────────────────────────────────────────────────────────────
// Back-compat shim user-name-uat.js
// ──────────────────────────────────────────────────────────────────────

describe('user-name-uat.js back-compat shim', () => {
  it('getUATUserName / setUATUserNames / batchResolveUserNamesAsUser delegate to resolver', async () => {
    const mod = await import('../src/tools/oapi/im/user-name-uat.js');
    mod.setUATUserNames(
      ACCT,
      new Map([
        ['ou_a', 'Alice'],
        ['ou_b', 'Bob'],
      ])
    );
    expect(mod.getUATUserName(ACCT, 'ou_a')).toBe('Alice');
    expect(mod.getUATUserName(ACCT, 'ou_b')).toBe('Bob');
    // Cache hits → no API.
    const client = { account: { accountId: ACCT }, invoke: vi.fn() };
    const r = await mod.batchResolveUserNamesAsUser({
      client,
      openIds: ['ou_a'],
      log: () => {},
    });
    expect(client.invoke).not.toHaveBeenCalled();
    expect(r.get('ou_a')).toBe('Alice');
  });
});
