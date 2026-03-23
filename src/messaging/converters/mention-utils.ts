/**
 * Copyright (c) 2026 ByteDance Ltd. and/or its affiliates
 * SPDX-License-Identifier: MIT
 *
 * Mention extraction and resolution utilities.
 *
 * Extracted from content-converter.ts to break the circular dependency:
 *   content-converter → index → {text, post} → content-converter
 *
 * Individual converters (text.ts, post.ts) import from this module
 * instead of content-converter.ts.
 */

import type { MentionInfo } from '../types';
import type { ConvertContext } from './types';
import { escapeRegExp } from './utils';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** 从 mention 的 id 字段提取 open_id（兼容事件推送的对象格式和 API 响应的字符串格式） */
export function extractMentionOpenId(id: unknown): string {
  if (typeof id === 'string') return id;
  if (id != null && typeof id === 'object' && 'open_id' in id) {
    const openId = (id as Record<string, unknown>).open_id;
    return typeof openId === 'string' ? openId : '';
  }
  return '';
}

// ---------------------------------------------------------------------------
// Mention resolution
// ---------------------------------------------------------------------------

/**
 * Resolve mention placeholders in text.
 *
 * - Bot mentions: remove the placeholder key and any preceding `@botName`
 *   entirely (with trailing whitespace).
 * - Non-bot mentions: replace the placeholder key with readable `@name`.
 */
export function resolveMentions(text: string, ctx: ConvertContext): string {
  if (ctx.mentions.size === 0) return text;

  let result = text;
  for (const [key, info] of ctx.mentions) {
    if (info.isBot && ctx.stripBotMentions) {
      // 仅在事件推送场景才删除 bot mention
      result = result.replace(new RegExp(`@${escapeRegExp(info.name)}\\s*`, 'g'), '').trim();
      result = result.replace(new RegExp(escapeRegExp(key) + '\\s*', 'g'), '').trim();
    } else {
      result = result.replace(new RegExp(escapeRegExp(key), 'g'), `@${info.name}`);
    }
  }
  return result;
}
