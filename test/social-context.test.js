import { describe, it, expect } from 'vitest';
import {
  formatContextBlock,
  DEFAULT_CONTEXT_TEMPLATE,
  renderTemplate,
} from '../src/extensions/feishu-social/context.js';

const fakeRegistry = {
  getDisplayBots: () => [],
  getMembers: () => [],
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
