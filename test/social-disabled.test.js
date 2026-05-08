import { describe, it, expect, vi, beforeEach } from 'vitest';

// The social extension keeps SHARED state at module scope. vi.resetModules
// makes a fresh copy reachable for each test so prior register() calls do
// not leak through SHARED to the next assertion.
beforeEach(() => {
  vi.resetModules();
});

describe('social.enabled gate', () => {
  it('register() is a no-op when social.enabled is missing', async () => {
    const social = await import('../src/extensions/feishu-social/index.js');
    const onSpy = vi.fn();
    const result = social.registerFeishuSocial({
      pluginConfig: {},
      logger: { info: () => {}, warn: () => {} },
      on: onSpy,
    });
    expect(result).toBeUndefined();
    expect(onSpy).not.toHaveBeenCalled();
  });

  it('register() is a no-op when social.enabled is false', async () => {
    const social = await import('../src/extensions/feishu-social/index.js');
    const onSpy = vi.fn();
    social.registerFeishuSocial({
      pluginConfig: { social: { enabled: false } },
      logger: { info: () => {}, warn: () => {} },
      on: onSpy,
    });
    expect(onSpy).not.toHaveBeenCalled();
  });

  it('register() is a no-op when social.enabled is a truthy non-true value', async () => {
    const social = await import('../src/extensions/feishu-social/index.js');
    const onSpy = vi.fn();
    social.registerFeishuSocial({
      pluginConfig: { social: { enabled: 'yes' } },
      logger: { info: () => {}, warn: () => {} },
      on: onSpy,
    });
    expect(onSpy).not.toHaveBeenCalled();
  });

  it('lookupMemberName returns null when the registry was never initialized', async () => {
    const social = await import('../src/extensions/feishu-social/index.js');
    expect(social.lookupMemberName('ou_anything')).toBeNull();
  });
});

describe('social.enabled = true activates hooks', () => {
  it('register() calls api.on for all three hooks', async () => {
    const social = await import('../src/extensions/feishu-social/index.js');
    const onSpy = vi.fn();
    social.registerFeishuSocial({
      pluginConfig: {
        social: {
          enabled: true,
          contextGroups: [],
          debugLog: false,
        },
      },
      config: { channels: { feishu: { accounts: {} } } },
      logger: { info: () => {}, warn: () => {} },
      on: onSpy,
    });
    const hookNames = onSpy.mock.calls.map((c) => c[0]);
    expect(hookNames).toEqual(
      expect.arrayContaining(['message_received', 'before_prompt_build', 'message_sending'])
    );
  });
});
