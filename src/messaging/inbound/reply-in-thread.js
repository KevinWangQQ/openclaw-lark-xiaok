"use strict";
/**
 * Pure helper for resolving the effective replyInThread setting (Patch 2).
 *
 * Extracted from dispatch-context.js so tests can import it without pulling
 * in the Lark SDK transitive deps (lark-client → version → import.meta.url).
 *
 * Precedence: per-group > wildcard ('*') > account level. Returns true when
 * the resolved value is `true` or the string `'enabled'`; everything else
 * (including `false`, `undefined`, or unrecognized strings) is treated as
 * "do not force thread".
 */
Object.defineProperty(exports, "__esModule", { value: true });
exports.resolveReplyInThread = resolveReplyInThread;
function resolveReplyInThread(feishuCfg, chatId) {
    const groupCfg = feishuCfg?.groups?.[chatId] || feishuCfg?.groups?.['*'] || {};
    const v = groupCfg.replyInThread ?? feishuCfg?.replyInThread;
    return v === true || v === 'enabled';
}
