"use strict";
/**
 * Copyright (c) 2026 ByteDance Ltd. and/or its affiliates
 * SPDX-License-Identifier: MIT
 *
 * feishu_chat tool -- 管理飞书群聊
 *
 * Actions:
 *   - search: 搜索对用户或机器人可见的群列表
 *   - get:    获取指定群的详细信息
 *
 * Uses the Feishu IM v1 API:
 *   - search: GET /open-apis/im/v1/chats/search
 *   - get:    GET /open-apis/im/v1/chats/:chat_id
 */
Object.defineProperty(exports, "__esModule", { value: true });
exports.registerChatSearchTool = registerChatSearchTool;
const typebox_1 = require("@sinclair/typebox");
const helpers_1 = require("../helpers.js");
const name_resolver_1 = require("../im/name-resolver.js");
// ---------------------------------------------------------------------------
// Schema
// ---------------------------------------------------------------------------
const FeishuChatSchema = typebox_1.Type.Union([
    // SEARCH
    typebox_1.Type.Object({
        action: typebox_1.Type.Literal('search'),
        query: typebox_1.Type.String({
            description: '搜索关键词（必填）。支持匹配群名称、群成员名称。' + '支持多语种、拼音、前缀等模糊搜索。',
        }),
        page_size: typebox_1.Type.Optional(typebox_1.Type.Integer({
            description: '分页大小（默认20）',
            minimum: 1,
        })),
        page_token: typebox_1.Type.Optional(typebox_1.Type.String({
            description: '分页标记。首次请求无需填写',
        })),
        user_id_type: typebox_1.Type.Optional((0, helpers_1.StringEnum)(['open_id', 'union_id', 'user_id'], {
            description: '用户 ID 类型（默认 open_id）',
        })),
    }),
    // GET
    typebox_1.Type.Object({
        action: typebox_1.Type.Literal('get'),
        chat_id: typebox_1.Type.String({
            description: '群 ID（格式如 oc_xxx）',
        }),
        user_id_type: typebox_1.Type.Optional((0, helpers_1.StringEnum)(['open_id', 'union_id', 'user_id'], {
            description: '用户 ID 类型（默认 open_id）',
        })),
    }),
    // RESOLVE_P2P — open_id 批量反查 P2P chat_id（Phase 4 暴露原本私有的能力）
    typebox_1.Type.Object({
        action: typebox_1.Type.Literal('resolve_p2p'),
        open_ids: typebox_1.Type.Array(typebox_1.Type.String({ description: '用户 open_id（ou_xxx）' }), {
            description: '要反查 P2P chat_id 的 open_id 列表。返回 Map<open_id, chat_id>。' +
                '没有历史会话的 open_id 不会出现在返回中',
            minItems: 1,
            maxItems: 50,
        }),
    }),
]);
// ---------------------------------------------------------------------------
// Registration
// ---------------------------------------------------------------------------
function registerChatSearchTool(api) {
    if (!api.config)
        return false;
    const cfg = api.config;
    const { toolClient, log } = (0, helpers_1.createToolContext)(api, 'feishu_chat');
    return (0, helpers_1.registerTool)(api, {
        name: 'feishu_chat',
        label: 'Feishu: Chat Management',
        description: '以用户身份调用飞书群聊管理工具。Actions:' +
            '\n- search：搜索群列表，支持关键词匹配群名称、群成员' +
            '\n- get：获取指定群的详细信息（含 owner_name / chat_creator_name 自动 enrich）' +
            '\n- resolve_p2p：批量反查 open_id → P2P chat_id 映射（无历史会话的 open_id 不出现在返回中）',
        parameters: FeishuChatSchema,
        async execute(_toolCallId, params) {
            const p = params;
            try {
                const client = toolClient();
                switch (p.action) {
                    // -----------------------------------------------------------------
                    // SEARCH
                    // -----------------------------------------------------------------
                    case 'search': {
                        log.info(`search: query="${p.query}", page_size=${p.page_size ?? 20}`);
                        const res = await client.invoke('feishu_chat.search', (sdk, opts) => sdk.im.v1.chat.search({
                            params: {
                                user_id_type: p.user_id_type || 'open_id',
                                query: p.query,
                                page_size: p.page_size,
                                page_token: p.page_token,
                            },
                        }, opts), { as: 'user' });
                        (0, helpers_1.assertLarkOk)(res);
                        const data = res.data;
                        const chatCount = data?.items?.length ?? 0;
                        log.info(`search: found ${chatCount} chats`);
                        return (0, helpers_1.json)({
                            items: data?.items,
                            has_more: data?.has_more ?? false,
                            page_token: data?.page_token,
                        });
                    }
                    // -----------------------------------------------------------------
                    // GET
                    // -----------------------------------------------------------------
                    case 'get': {
                        log.info(`get: chat_id=${p.chat_id}, user_id_type=${p.user_id_type ?? 'open_id'}`);
                        const res = await client.invoke('feishu_chat.get', (sdk, opts) => sdk.im.v1.chat.get({
                            path: {
                                chat_id: p.chat_id,
                            },
                            params: {
                                user_id_type: p.user_id_type || 'open_id',
                            },
                        }, {
                            ...(opts ?? {}),
                            headers: {
                                // eslint-disable-next-line @typescript-eslint/no-explicit-any
                                ...(opts?.headers ?? {}),
                                'X-Chat-Custom-Header': 'enable_chat_list_security_check',
                            },
                            // eslint-disable-next-line @typescript-eslint/no-explicit-any
                        }), { as: 'user' });
                        (0, helpers_1.assertLarkOk)(res);
                        log.info(`get: retrieved chat info for ${p.chat_id}`);
                        const data = res.data;
                        // 仅在 open_id 模式下补 owner_name / chat_creator_name；其他 id_type 由调用方负责
                        if ((p.user_id_type ?? 'open_id') === 'open_id' && data) {
                            const ids = [data.owner_id, data.chat_creator].filter((id) => !!id);
                            if (ids.length > 0) {
                                await (0, name_resolver_1.batchResolveUserNames)({
                                    client,
                                    accountId: client.account.accountId,
                                    openIds: ids,
                                    log: (...args) => log.info(args.map(String).join(' ')),
                                });
                                if (data.owner_id) {
                                    data.owner_name = (0, name_resolver_1.resolveUserName)(client.account.accountId, data.owner_id) ?? null;
                                }
                                if (data.chat_creator) {
                                    data.chat_creator_name = (0, name_resolver_1.resolveUserName)(client.account.accountId, data.chat_creator) ?? null;
                                }
                            }
                        }
                        return (0, helpers_1.json)({
                            chat: data,
                        });
                    }
                    // -----------------------------------------------------------------
                    // RESOLVE_P2P — open_id[] → {open_id → chat_id}
                    // Phase 4 暴露原本只在 message-read.js 内部用的 chat_p2p/batch_query。
                    // -----------------------------------------------------------------
                    case 'resolve_p2p': {
                        const openIds = [...new Set(p.open_ids ?? [])];
                        log.info(`resolve_p2p: ${openIds.length} open_ids`);
                        if (openIds.length === 0) {
                            return (0, helpers_1.json)({ p2p_chats: {} });
                        }
                        const res = await client.invokeByPath('feishu_chat.resolve_p2p', '/open-apis/im/v1/chat_p2p/batch_query', {
                            method: 'POST',
                            body: { chatter_ids: openIds },
                            query: { user_id_type: 'open_id' },
                            as: 'user',
                        });
                        if (res.code !== 0) {
                            return (0, helpers_1.json)({ error: `API error: code=${res.code} msg=${res.msg}` });
                        }
                        const map = {};
                        for (const c of res.data?.p2p_chats ?? []) {
                            if (c?.chatter_id && c?.chat_id) {
                                map[c.chatter_id] = c.chat_id;
                            }
                        }
                        return (0, helpers_1.json)({ p2p_chats: map });
                    }
                }
            }
            catch (err) {
                return await (0, helpers_1.handleInvokeErrorWithAutoAuth)(err, cfg);
            }
        },
    }, { name: 'feishu_chat' });
}
