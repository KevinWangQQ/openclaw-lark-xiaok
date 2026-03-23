/**
 * Verify that the converter module graph can be loaded under CJS semantics
 * (as Jiti / the openclaw framework would load it).
 *
 * Before the fix, this would throw:
 *   ReferenceError: Cannot access 'utils_1' before initialization
 */

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { createJiti } from 'jiti';
import { fileURLToPath } from 'node:url';
import { resolve, dirname } from 'node:path';

const __filename = fileURLToPath(import.meta.url);
const ROOT = resolve(dirname(__filename), '..');

describe('circular dependency safety under CJS (jiti)', () => {
  const jiti = createJiti(__filename, { interopDefault: true });

  it('content-converter loads without ReferenceError', () => {
    const mod = jiti(resolve(ROOT, 'src/messaging/converters/content-converter.ts'));
    assert.strictEqual(typeof mod.convertMessageContent, 'function');
    assert.strictEqual(typeof mod.resolveMentions, 'function');
    assert.strictEqual(typeof mod.extractMentionOpenId, 'function');
  });

  it('text converter loads and can convert a simple message', () => {
    const mod = jiti(resolve(ROOT, 'src/messaging/converters/text.ts'));
    assert.strictEqual(typeof mod.convertText, 'function');

    const ctx = {
      mentions: new Map(),
      mentionsByOpenId: new Map(),
      messageId: 'test',
    };
    const result = mod.convertText('{"text":"hello"}', ctx);
    assert.strictEqual(result.content, 'hello');
  });

  it('post converter loads and can convert a simple message', () => {
    const mod = jiti(resolve(ROOT, 'src/messaging/converters/post.ts'));
    assert.strictEqual(typeof mod.convertPost, 'function');

    const ctx = {
      mentions: new Map(),
      mentionsByOpenId: new Map(),
      messageId: 'test',
    };
    const result = mod.convertPost('{"title":"hi","content":[]}', ctx);
    assert.ok(result.content.includes('hi'));
  });
});
