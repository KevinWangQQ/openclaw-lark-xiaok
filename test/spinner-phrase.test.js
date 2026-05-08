import { describe, it, expect } from 'vitest';
import { randomSpinnerPhrase } from '../src/card/builder.js';

describe('randomSpinnerPhrase', () => {
  it("returns 'Processing...' when cfg is empty", () => {
    expect(randomSpinnerPhrase({})).toBe('Processing...');
  });

  it("returns 'Processing...' when cfg is undefined", () => {
    expect(randomSpinnerPhrase(undefined)).toBe('Processing...');
  });

  it("returns 'Processing...' when spinnerPhrases is missing", () => {
    expect(randomSpinnerPhrase({ channels: { feishu: {} } })).toBe('Processing...');
  });

  it("returns 'Processing...' when spinnerPhrases is an empty array", () => {
    expect(randomSpinnerPhrase({ channels: { feishu: { spinnerPhrases: [] } } })).toBe('Processing...');
  });

  it('returns the only entry when the pool has size 1', () => {
    const cfg = { channels: { feishu: { spinnerPhrases: ['Only choice'] } } };
    expect(randomSpinnerPhrase(cfg)).toBe('Only choice');
  });

  it('always returns a phrase from the configured pool', () => {
    const pool = ['Foo', 'Bar', 'Baz'];
    const cfg = { channels: { feishu: { spinnerPhrases: pool } } };
    for (let i = 0; i < 50; i++) {
      expect(pool).toContain(randomSpinnerPhrase(cfg));
    }
  });
});
