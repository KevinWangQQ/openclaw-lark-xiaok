"use strict";
/**
 * Copyright (c) 2026 ByteDance Ltd. and/or its affiliates
 * SPDX-License-Identifier: MIT
 *
 * feishu_im_user_message tool -- 以用户身份发送/回复 IM 消息
 *
 * Actions: send, reply
 *
 * Uses the Feishu IM API:
 *   - send:  POST /open-apis/im/v1/messages?receive_id_type=...
 *   - reply: POST /open-apis/im/v1/messages/:message_id/reply
 *
 * 全部以用户身份（user_access_token）调用，scope 来自 real-scope.json。
 */
Object.defineProperty(exports, "__esModule", { value: true });
exports.registerFeishuImUserMessageTool = registerFeishuImUserMessageTool;
exports.executeGetMessage = executeGetMessage;
exports.executeMgetMessages = executeMgetMessages;
exports.executeReactions = executeReactions;
exports.executeResolveUrl = executeResolveUrl;
const typebox_1 = require("@sinclair/typebox");
const accounts_1 = require("../../../core/accounts.js");
const lark_client_1 = require("../../../core/lark-client.js");
const helpers_1 = require("../helpers.js");
const message_read_1 = require("./message-read.js");
const members_1 = require("../chat/members.js");
const format_messages_1 = require("./format-messages.js");
const message_schema_1 = require("./message-schema.js");
const url_parser_1 = require("./url-parser.js");
const name_resolver_1 = require("./name-resolver.js");
const FEISHU_POST_LOCALE_PRIORITY = ['zh_cn', 'en_us', 'ja_jp'];
/**
 * Check whether a value is a non-null object whose properties can be read.
 *
 * @param value - The value to check
 * @returns Whether the value is a non-null object
 */
function isRecord(value) {
    return value != null && typeof value === 'object';
}
/**
 * Collect post content bodies from a parsed Feishu post payload.
 * Handles both flat (title/content at root) and multi-locale wrapper structures.
 *
 * @param parsed - The parsed JSON object
 * @returns List of post content bodies to process
 */
function collectPostContents(parsed) {
    if ('title' in parsed || 'content' in parsed) {
        return [parsed];
    }
    const bodies = [];
    const seen = new Set();
    // Process well-known locales first
    for (const locale of FEISHU_POST_LOCALE_PRIORITY) {
        const localeContent = parsed[locale];
        if (!isRecord(localeContent)) {
            continue;
        }
        const body = localeContent;
        if (!seen.has(body)) {
            bodies.push(body);
            seen.add(body);
        }
    }
    // Process remaining locales
    for (const value of Object.values(parsed)) {
        if (!isRecord(value)) {
            continue;
        }
        const body = value;
        if (!seen.has(body)) {
            bodies.push(body);
            seen.add(body);
        }
    }
    return bodies;
}
/**
 * Convert markdown tables to the Feishu-compatible list format.
 *
 * Reuses the channel runtime's existing converter so the tool send path
 * behaves identically to the main reply path.
 *
 * @param cfg - Current tool configuration
 * @param text - Raw markdown text
 * @returns Converted text, or the original text when runtime is unavailable
 */
function convertMarkdownTablesForLark(cfg, text) {
    try {
        const runtime = lark_client_1.LarkClient.runtime;
        if (runtime?.channel?.text?.convertMarkdownTables && runtime.channel.text.resolveMarkdownTableMode) {
            const tableMode = runtime.channel.text.resolveMarkdownTableMode({
                cfg,
                channel: 'feishu',
            });
            return runtime.channel.text.convertMarkdownTables(text, tableMode);
        }
    }
    catch {
        // Runtime converter unavailable -- keep text as-is.
    }
    return text;
}
/**
 * Pre-process `tag="md"` text nodes inside `post` messages so the tool send
 * path also renders markdown tables correctly.
 *
 * @param cfg - Current tool configuration
 * @param msgType - Feishu message type
 * @param content - The JSON string from tool parameters
 * @returns Pre-processed JSON string
 */
function preprocessPostContent(cfg, msgType, content) {
    if (msgType !== 'post') {
        return content;
    }
    try {
        const parsed = JSON.parse(content);
        if (!isRecord(parsed)) {
            return content;
        }
        const postContents = collectPostContents(parsed);
        if (postContents.length === 0) {
            return content;
        }
        let changed = false;
        for (const postContent of postContents) {
            if (!postContent.content || !Array.isArray(postContent.content)) {
                continue;
            }
            for (const line of postContent.content) {
                if (!Array.isArray(line)) {
                    continue;
                }
                for (const block of line) {
                    if (!isRecord(block) || block.tag !== 'md' || typeof block.text !== 'string') {
                        continue;
                    }
                    const convertedText = convertMarkdownTablesForLark(cfg, block.text);
                    if (convertedText !== block.text) {
                        block.text = convertedText;
                        changed = true;
                    }
                }
            }
        }
        return changed ? JSON.stringify(parsed) : content;
    }
    catch {
        return content;
    }
}
// ---------------------------------------------------------------------------
// Read action: get (single message via /im/v1/messages/:id)
// ---------------------------------------------------------------------------
async function executeGetMessage(params, ctx) {
    const { config, log, toolClient } = ctx;
    const p = params;
    try {
        const client = toolClient();
        const account = (0, helpers_1.getFirstAccount)(config);
        const logFn = (...args) => log.info(args.map(String).join(' '));
        log.info(`get: message_id=${p.message_id}`);
        const res = await client.invokeByPath('feishu_im_user_message.get', `/open-apis/im/v1/messages/${encodeURIComponent(p.message_id)}`, {
            method: 'GET',
            query: { user_id_type: 'open_id', card_msg_content_type: 'raw_card_content' },
            as: 'user',
        });
        if (res.code !== 0) {
            return (0, helpers_1.json)({ error: `API error: code=${res.code} msg=${res.msg}` });
        }
        const items = res.data?.items ?? [];
        if (items.length === 0) {
            return (0, helpers_1.json)({ message: null });
        }
        const formatted = await (0, format_messages_1.formatMessageList)(items, account, logFn, client);
        return (0, helpers_1.json)({ message: formatted[0] ?? null });
    }
    catch (err) {
        return await (0, helpers_1.handleInvokeErrorWithAutoAuth)(err, config);
    }
}
// ---------------------------------------------------------------------------
// Read action: mget (batch get via /im/v1/messages/mget?message_ids=...)
// ---------------------------------------------------------------------------
async function executeMgetMessages(params, ctx) {
    const { config, log, toolClient } = ctx;
    const p = params;
    try {
        const client = toolClient();
        const account = (0, helpers_1.getFirstAccount)(config);
        const logFn = (...args) => log.info(args.map(String).join(' '));
        const ids = [...new Set(p.message_ids ?? [])];
        if (ids.length === 0) {
            return (0, helpers_1.json)({ messages: [] });
        }
        log.info(`mget: ${ids.length} message_ids`);
        const queryStr = ids.map((id) => `message_ids=${encodeURIComponent(id)}`).join('&');
        const res = await client.invokeByPath('feishu_im_user_message.mget', `/open-apis/im/v1/messages/mget?${queryStr}`, {
            method: 'GET',
            query: { user_id_type: 'open_id', card_msg_content_type: 'raw_card_content' },
            as: 'user',
        });
        if (res.code !== 0) {
            return (0, helpers_1.json)({ error: `API error: code=${res.code} msg=${res.msg}` });
        }
        const items = res.data?.items ?? [];
        const formatted = await (0, format_messages_1.formatMessageList)(items, account, logFn, client);
        return (0, helpers_1.json)({ messages: formatted });
    }
    catch (err) {
        return await (0, helpers_1.handleInvokeErrorWithAutoAuth)(err, config);
    }
}
// ---------------------------------------------------------------------------
// Read action: reactions (read /im/v1/messages/:id/reactions/list)
// Hotfix (post-Phase-4): switched from invokeByPath to client.invoke +
// sdk.request — the canonical pattern (mirrors user-name-uat.js). The
// invokeByPath path tripped a JSON parse error ("Unexpected non-whitespace
// character after JSON at position 4") on some Feishu reactions responses;
// going through the SDK's typed request handler avoids it.
// ---------------------------------------------------------------------------
async function executeReactions(params, ctx) {
    const { config, log, toolClient } = ctx;
    const p = params;
    try {
        const client = toolClient();
        const account = (0, helpers_1.getFirstAccount)(config);
        const logFn = (...args) => log.info(args.map(String).join(' '));
        log.info(`reactions: message_id=${p.message_id}, reaction_type=${p.reaction_type ?? '*'}`);
        const res = await client.invoke('feishu_im_user_message.reactions', (sdk, opts) => sdk.request({
            method: 'GET',
            url: `/open-apis/im/v1/messages/${encodeURIComponent(p.message_id)}/reactions/list`,
            params: {
                user_id_type: 'open_id',
                ...(p.reaction_type ? { reaction_type: p.reaction_type } : {}),
                ...(p.page_size ? { page_size: p.page_size } : {}),
                ...(p.page_token ? { page_token: p.page_token } : {}),
            },
        }, opts), { as: 'user' });
        if (res?.code !== 0) {
            return (0, helpers_1.json)({ error: `API error: code=${res?.code} msg=${res?.msg}` });
        }
        const items = res.data?.items ?? [];
        // Enrich reactor names through the shared resolver. UAT batch_basic
        // is the same path used by enrichSendersInPlace — names land in the
        // shared cache and benefit later reads.
        const reactorOpenIds = [...new Set(items
            .map((it) => it?.operator?.operator_id)
            .filter((id) => !!id))];
        if (reactorOpenIds.length > 0) {
            await (0, name_resolver_1.batchResolveUserNames)({
                client,
                accountId: account.accountId,
                openIds: reactorOpenIds,
                log: logFn,
            });
        }
        const enriched = items.map((it) => {
            const operatorId = it?.operator?.operator_id;
            const reactorName = operatorId ? (0, name_resolver_1.resolveUserName)(account.accountId, operatorId) : undefined;
            return {
                reaction_id: it?.reaction_id,
                emoji_type: it?.reaction_type?.emoji_type,
                operator: {
                    operator_id: operatorId,
                    operator_name: reactorName ?? null,
                    operator_type: it?.operator?.operator_type,
                },
                action_time: it?.action_time,
            };
        });
        return (0, helpers_1.json)({
            items: enriched,
            has_more: res.data?.has_more ?? false,
            page_token: res.data?.page_token,
        });
    }
    catch (err) {
        return await (0, helpers_1.handleInvokeErrorWithAutoAuth)(err, config);
    }
}
// ---------------------------------------------------------------------------
// Read action: resolve_url (pure regex, no API call)
// IM-only — cloud-doc URLs are out of scope (architect review §7).
// ---------------------------------------------------------------------------
function executeResolveUrl(params) {
    return (0, helpers_1.json)((0, url_parser_1.parseImUrl)(params?.url));
}
// ---------------------------------------------------------------------------
// Registration
// ---------------------------------------------------------------------------
function registerFeishuImUserMessageTool(api) {
    if (!api.config)
        return false;
    const cfg = api.config;
    const { toolClient, log } = (0, helpers_1.createToolContext)(api, 'feishu_im_user_message');
    // Sub-ctx for delegated read actions. Reuses the same toolClient/log so each
    // dispatch gets a fresh client bound to the right account; configurations
    // come from the same api.config root.
    const readCtx = { config: cfg, log, toolClient };
    return (0, helpers_1.registerTool)(api, {
        name: 'feishu_im_user_message',
        label: 'Feishu: IM User Message',
        description: '飞书用户身份 IM 消息工具，统一入口。' +
            '\n\n【写 actions — 安全约束：发出前必须向用户确认对象 + 内容】' +
            '\n- send（发送消息）：发送消息到私聊或群聊。私聊用 receive_id_type=open_id，群聊用 receive_id_type=chat_id' +
            '\n- reply（回复消息）：回复指定 message_id 的消息，支持话题回复（reply_in_thread=true）' +
            '\n\n【读 actions — 优先用此入口，旧的 feishu_im_user_get_messages / _get_thread_messages / _search_messages / feishu_chat_members 已 deprecated】' +
            '\n- list：获取群聊或单聊的历史消息。需要 chat_id 或 open_id（互斥）；支持 relative_time / start_time+end_time 时间过滤；分页 page_size + page_token' +
            '\n- get：通过 message_id 获取单条消息详情' +
            '\n- search：跨会话关键词搜索；可按 sender_ids / mention_ids / chat_id / message_type / sender_type / chat_type 过滤' +
            '\n- thread：通过 thread_id（omt_xxx）获取话题内消息' +
            '\n- members：通过 chat_id 获取群成员列表（不含 bot）' +
            '\n- mget：批量取消息详情（message_ids: string[]，每次最多 50）' +
            '\n- reactions：读消息表情回复列表，reactor 名字会被自动 enrich' +
            '\n- resolve_url：飞书/Lark IM 链接 → ids（纯本地解析，不打 API；云文档链接不支持）' +
            '\n\n【重要】content 必须是合法 JSON 字符串，格式取决于 msg_type。' +
            '最常用：text 类型 content 为 \'{"text":"消息内容"}\'。' +
            '\n\n【安全约束】write actions（send/reply）发出后对方看到的发送者是用户本人。' +
            '调用前必须先向用户确认：1) 发送对象（哪个人或哪个群）2) 消息内容。' +
            '禁止在用户未明确同意的情况下自行发送消息。' +
            'Read actions（list/get/search/thread/members）以用户身份读取，受 group/chat 成员关系约束。',
        parameters: message_schema_1.FeishuImMessageSchema,
        async execute(_toolCallId, params) {
            const p = params;
            try {
                // Dispatch read actions first — they delegate to the existing
                // executeXxx callables. Write actions fall through to the
                // original switch below.
                switch (p.action) {
                    case 'list':        return await (0, message_read_1.executeListMessages)(p, readCtx);
                    case 'thread':      return await (0, message_read_1.executeThreadMessages)(p, readCtx);
                    case 'search':      return await (0, message_read_1.executeSearchMessages)(p, readCtx);
                    case 'members':     return await (0, members_1.executeListMembers)(p, readCtx);
                    case 'get':         return await executeGetMessage(p, readCtx);
                    case 'mget':        return await executeMgetMessages(p, readCtx);
                    case 'reactions':   return await executeReactions(p, readCtx);
                    case 'resolve_url': return executeResolveUrl(p);
                }
                const client = toolClient();
                switch (p.action) {
                    // -----------------------------------------------------------------
                    // SEND MESSAGE
                    // -----------------------------------------------------------------
                    case 'send': {
                        log.info(`send: receive_id_type=${p.receive_id_type}, receive_id=${p.receive_id}, msg_type=${p.msg_type}`);
                        const accountScopedCfg = (0, accounts_1.createAccountScopedConfig)(cfg, client.account.accountId);
                        const processedContent = preprocessPostContent(accountScopedCfg, p.msg_type, p.content);
                        const res = await client.invoke('feishu_im_user_message.send', (sdk, opts) => sdk.im.v1.message.create({
                            params: { receive_id_type: p.receive_id_type },
                            data: {
                                receive_id: p.receive_id,
                                msg_type: p.msg_type,
                                content: processedContent,
                                uuid: p.uuid,
                            },
                        }, opts), {
                            as: 'user',
                        });
                        (0, helpers_1.assertLarkOk)(res);
                        // eslint-disable-next-line @typescript-eslint/no-explicit-any
                        const data = res.data;
                        log.info(`send: message sent, message_id=${data?.message_id}`);
                        return (0, helpers_1.json)({
                            message_id: data?.message_id,
                            chat_id: data?.chat_id,
                            create_time: data?.create_time,
                        });
                    }
                    // -----------------------------------------------------------------
                    // REPLY MESSAGE
                    // -----------------------------------------------------------------
                    case 'reply': {
                        log.info(`reply: message_id=${p.message_id}, msg_type=${p.msg_type}, reply_in_thread=${p.reply_in_thread ?? false}`);
                        const accountScopedCfg = (0, accounts_1.createAccountScopedConfig)(cfg, client.account.accountId);
                        const processedContent = preprocessPostContent(accountScopedCfg, p.msg_type, p.content);
                        const res = await client.invoke('feishu_im_user_message.reply', (sdk, opts) => sdk.im.v1.message.reply({
                            path: { message_id: p.message_id },
                            data: {
                                content: processedContent,
                                msg_type: p.msg_type,
                                reply_in_thread: p.reply_in_thread,
                                uuid: p.uuid,
                            },
                        }, opts), {
                            as: 'user',
                        });
                        (0, helpers_1.assertLarkOk)(res);
                        // eslint-disable-next-line @typescript-eslint/no-explicit-any
                        const data = res.data;
                        log.info(`reply: message sent, message_id=${data?.message_id}`);
                        return (0, helpers_1.json)({
                            message_id: data?.message_id,
                            chat_id: data?.chat_id,
                            create_time: data?.create_time,
                        });
                    }
                }
            }
            catch (err) {
                return await (0, helpers_1.handleInvokeErrorWithAutoAuth)(err, cfg);
            }
        },
    }, { name: 'feishu_im_user_message' });
}
