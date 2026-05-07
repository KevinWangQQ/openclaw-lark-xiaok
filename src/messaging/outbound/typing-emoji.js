"use strict";
/**
 * Pure helper for resolving the typing-indicator emoji from cfg.
 *
 * Extracted from typing.js so tests can import it without pulling in the
 * Lark SDK transitive deps (lark-client → version → import.meta.url, which
 * Node and vitest disagree on across versions).
 *
 * Read order:
 *   cfg.channels.feishu.typingEmoji = "Get"          → 'Get'
 *   cfg.channels.feishu.typingEmoji = "Get,DONE"     → randomly 'Get' or 'DONE'
 *   cfg.channels.feishu.typingEmoji unset            → 'Get' (default)
 */
Object.defineProperty(exports, "__esModule", { value: true });
exports.getTypingEmojiType = getTypingEmojiType;
function getTypingEmojiType(cfg) {
    const raw = cfg?.channels?.feishu?.typingEmoji ?? 'Get';
    const pool = raw.split(',').map((s) => s.trim()).filter(Boolean);
    return pool[Math.floor(Math.random() * pool.length)];
}
