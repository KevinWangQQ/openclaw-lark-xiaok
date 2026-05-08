"use strict";
/**
 * Copyright (c) 2026 ByteDance Ltd. and/or its affiliates
 * SPDX-License-Identifier: MIT
 *
 * IM-only URL parser. Pure regex; no API calls. Architect review §7
 * scoped this to IM links only (message + chat); cloud-doc URLs belong
 * in a drive tool.
 *
 * Recognised shapes (live):
 *   https://{tenant}.feishu.cn/im/{...}?msg_id=om_xxx&chat_id=oc_xxx
 *   https://{tenant}.feishu.cn/im/chat/oc_xxx
 *   https://{tenant}.feishu.cn/messenger/chat/oc_xxx
 *   https://{tenant}.larksuite.com/...   (Lark international)
 *
 * Returns:
 *   {resolved: true,  chat_id?: string, message_id?: string, thread_id?: string}
 *   {resolved: false, reason: string}                  (URL didn't match any IM shape)
 */
Object.defineProperty(exports, "__esModule", { value: true });
exports.parseImUrl = parseImUrl;
const MSG_ID_RE = /\b(om_[A-Za-z0-9_-]+)/;
const CHAT_ID_RE = /\b(oc_[A-Za-z0-9_-]+)/;
const THREAD_ID_RE = /\b(omt_[A-Za-z0-9_-]+)/;
const FEISHU_HOST_RE = /(?:feishu\.cn|larksuite\.com)/;
function parseImUrl(rawUrl) {
    if (typeof rawUrl !== 'string' || !rawUrl.trim()) {
        return { resolved: false, reason: 'empty_input' };
    }
    const url = rawUrl.trim();
    if (!FEISHU_HOST_RE.test(url)) {
        return { resolved: false, reason: 'not_feishu_host' };
    }
    // Quick path-discriminator: message links are under /im/, chat links can be
    // /im/chat/ or /messenger/chat/. Any path that isn't IM-shaped is rejected
    // so cloud-doc URLs (/wiki/, /docx/, /sheets/, /drive/) fall through to
    // the agent for routing to the appropriate non-IM tool.
    let pathLooksImShaped = false;
    try {
        const parsed = new URL(url);
        const path = parsed.pathname;
        pathLooksImShaped = /^\/(im|messenger)\b/.test(path);
    }
    catch {
        return { resolved: false, reason: 'invalid_url' };
    }
    if (!pathLooksImShaped) {
        return { resolved: false, reason: 'not_im_url' };
    }
    const messageMatch = MSG_ID_RE.exec(url);
    const chatMatch = CHAT_ID_RE.exec(url);
    const threadMatch = THREAD_ID_RE.exec(url);
    if (!messageMatch && !chatMatch && !threadMatch) {
        return { resolved: false, reason: 'no_id_found' };
    }
    const out = { resolved: true };
    if (messageMatch)
        out.message_id = messageMatch[1];
    if (chatMatch)
        out.chat_id = chatMatch[1];
    if (threadMatch)
        out.thread_id = threadMatch[1];
    return out;
}
