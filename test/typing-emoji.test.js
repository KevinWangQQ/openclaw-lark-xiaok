// Imports the pure helper directly so the test does not load the Lark SDK
// transitive chain (which trips on src/core/version.js's import.meta.url
// under vitest's ESM loader).
import { describe, it, expect } from 'vitest';
import { getTypingEmojiType } from '../src/messaging/outbound/typing-emoji.js';

describe('getTypingEmojiType', () => {
  it("returns 'Get' when cfg is empty", () => {
    expect(getTypingEmojiType({})).toBe('Get');
  });

  it("returns 'Get' when channels.feishu.typingEmoji is unset", () => {
    expect(getTypingEmojiType({ channels: { feishu: {} } })).toBe('Get');
  });

  it('returns the single emoji name when configured as a plain string', () => {
    expect(getTypingEmojiType({ channels: { feishu: { typingEmoji: 'DONE' } } })).toBe('DONE');
  });

  it('picks one emoji from a comma-separated pool', () => {
    const pool = ['Get', 'DONE', 'JIAYI'];
    const cfg = { channels: { feishu: { typingEmoji: pool.join(',') } } };
    for (let i = 0; i < 50; i++) {
      expect(pool).toContain(getTypingEmojiType(cfg));
    }
  });

  it('trims whitespace around comma-separated entries', () => {
    const cfg = { channels: { feishu: { typingEmoji: ' Get ,  DONE  ' } } };
    for (let i = 0; i < 20; i++) {
      expect(['Get', 'DONE']).toContain(getTypingEmojiType(cfg));
    }
  });

  it('drops empty pool entries (e.g. trailing comma)', () => {
    const cfg = { channels: { feishu: { typingEmoji: 'Get,,,' } } };
    expect(getTypingEmojiType(cfg)).toBe('Get');
  });
});
