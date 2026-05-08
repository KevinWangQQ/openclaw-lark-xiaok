"use strict";
/**
 * Copyright (c) 2026 ByteDance Ltd. and/or its affiliates
 * SPDX-License-Identifier: MIT
 *
 * Schema for the unified `feishu_im_user_message` tool. Extracted into a
 * leaf module (only depends on @sinclair/typebox + helpers) so vitest tests
 * can validate the union without loading message.js itself, whose CJS
 * dependency chain (core/lark-client → core/version) crashes vitest's ESM
 * resolution. Same trick as Phase 0's extractMentionOpenId inline.
 */
Object.defineProperty(exports, "__esModule", { value: true });
exports.FeishuImMessageSchema = void 0;
const typebox_1 = require("@sinclair/typebox");
// Inline copy of helpers_1.StringEnum (one-liner) so this schema module has
// only a single dep (typebox), keeping it loadable in vitest tests.
const helpers_1 = {
    StringEnum: (values, options) => typebox_1.Type.Unsafe({ type: 'string', enum: values, ...options }),
};
const FeishuImMessageSchema = typebox_1.Type.Union([
    // SEND
    typebox_1.Type.Object({
        action: typebox_1.Type.Literal('send'),
        receive_id_type: (0, helpers_1.StringEnum)(['open_id', 'chat_id'], {
            description: '接收者 ID 类型：open_id（私聊，ou_xxx）、chat_id（群聊，oc_xxx）',
        }),
        receive_id: typebox_1.Type.String({
            description: "接收者 ID，与 receive_id_type 对应。open_id 填 'ou_xxx'，chat_id 填 'oc_xxx'",
        }),
        msg_type: (0, helpers_1.StringEnum)(['text', 'post', 'image', 'file', 'audio', 'media', 'interactive', 'share_chat', 'share_user'], {
            description: '消息类型：text（纯文本）、post（富文本）、image（图片）、file（文件）、interactive（消息卡片）、share_chat（群名片）、share_user（个人名片）等',
        }),
        content: typebox_1.Type.String({
            description: '消息内容（JSON 字符串），格式取决于 msg_type。' +
                '示例：text → \'{"text":"你好"}\'，' +
                'image → \'{"image_key":"img_xxx"}\'，' +
                'share_chat → \'{"chat_id":"oc_xxx"}\'，' +
                'post → \'{"zh_cn":{"title":"标题","content":[[{"tag":"text","text":"正文"}]]}}\'',
        }),
        uuid: typebox_1.Type.Optional(typebox_1.Type.String({
            description: '幂等唯一标识。同一 uuid 在 1 小时内只会发送一条消息，用于去重',
        })),
    }),
    // REPLY
    typebox_1.Type.Object({
        action: typebox_1.Type.Literal('reply'),
        message_id: typebox_1.Type.String({
            description: '被回复消息的 ID（om_xxx 格式）',
        }),
        msg_type: (0, helpers_1.StringEnum)(['text', 'post', 'image', 'file', 'audio', 'media', 'interactive', 'share_chat', 'share_user'], {
            description: '消息类型：text（纯文本）、post（富文本）、image（图片）、interactive（消息卡片）等',
        }),
        content: typebox_1.Type.String({
            description: '回复消息内容（JSON 字符串），格式同 send 的 content',
        }),
        reply_in_thread: typebox_1.Type.Optional(typebox_1.Type.Boolean({
            description: '是否以话题形式回复。true 则消息出现在该消息的话题中，false（默认）则出现在聊天主流',
        })),
        uuid: typebox_1.Type.Optional(typebox_1.Type.String({
            description: '幂等唯一标识',
        })),
    }),
    // LIST — 列出群聊或单聊的历史消息（delegate 到 message-read.executeListMessages）
    typebox_1.Type.Object({
        action: typebox_1.Type.Literal('list'),
        open_id: typebox_1.Type.Optional(typebox_1.Type.String({
            description: '用户 open_id（ou_xxx），获取与该用户的单聊消息。与 chat_id 互斥',
        })),
        chat_id: typebox_1.Type.Optional(typebox_1.Type.String({
            description: '会话 ID（oc_xxx），支持单聊和群聊。与 open_id 互斥',
        })),
        sort_rule: typebox_1.Type.Optional((0, helpers_1.StringEnum)(['create_time_asc', 'create_time_desc'], {
            description: '排序方式，默认 create_time_desc（最新消息在前）',
        })),
        page_size: typebox_1.Type.Optional(typebox_1.Type.Number({ description: '每页消息数（1-50），默认 50', minimum: 1, maximum: 50 })),
        page_token: typebox_1.Type.Optional(typebox_1.Type.String({ description: '分页标记，用于获取下一页' })),
        relative_time: typebox_1.Type.Optional(typebox_1.Type.String({
            description: '相对时间范围：today / yesterday / day_before_yesterday / this_week / last_week / this_month / last_month / last_{N}_{unit}（unit: minutes/hours/days）。与 start_time/end_time 互斥',
        })),
        start_time: typebox_1.Type.Optional(typebox_1.Type.String({
            description: '起始时间（ISO 8601 格式，如 2026-02-27T00:00:00+08:00）。与 relative_time 互斥',
        })),
        end_time: typebox_1.Type.Optional(typebox_1.Type.String({
            description: '结束时间（ISO 8601 格式，如 2026-02-27T23:59:59+08:00）。与 relative_time 互斥',
        })),
    }),
    // GET — 单条消息详情（用 mget 单 ID 形态）
    typebox_1.Type.Object({
        action: typebox_1.Type.Literal('get'),
        message_id: typebox_1.Type.String({ description: '消息 ID（om_xxx 格式）' }),
    }),
    // SEARCH — 跨会话搜索消息
    typebox_1.Type.Object({
        action: typebox_1.Type.Literal('search'),
        query: typebox_1.Type.Optional(typebox_1.Type.String({ description: '搜索关键词，匹配消息内容。可为空字符串表示不按内容过滤' })),
        sender_ids: typebox_1.Type.Optional(typebox_1.Type.Array(typebox_1.Type.String(), {
            description: '发送者 open_id 列表（ou_xxx）。如需根据用户名查找 open_id，请先使用 search_user 工具',
        })),
        chat_id: typebox_1.Type.Optional(typebox_1.Type.String({ description: '限定搜索范围的会话 ID（oc_xxx）' })),
        mention_ids: typebox_1.Type.Optional(typebox_1.Type.Array(typebox_1.Type.String(), { description: '被@用户的 open_id 列表（ou_xxx）' })),
        message_type: typebox_1.Type.Optional((0, helpers_1.StringEnum)(['file', 'image', 'media'], {
            description: '消息类型过滤：file / image / media。为空则搜索所有类型',
        })),
        sender_type: typebox_1.Type.Optional((0, helpers_1.StringEnum)(['user', 'bot', 'all'], {
            description: '发送者类型：user / bot / all。默认 user',
        })),
        chat_type: typebox_1.Type.Optional((0, helpers_1.StringEnum)(['group', 'p2p'], {
            description: '会话类型：group（群聊）/ p2p（单聊）',
        })),
        relative_time: typebox_1.Type.Optional(typebox_1.Type.String({
            description: '相对时间范围。与 start_time/end_time 互斥',
        })),
        start_time: typebox_1.Type.Optional(typebox_1.Type.String({
            description: 'ISO 8601 起始时间。与 relative_time 互斥',
        })),
        end_time: typebox_1.Type.Optional(typebox_1.Type.String({
            description: 'ISO 8601 结束时间。与 relative_time 互斥',
        })),
        page_size: typebox_1.Type.Optional(typebox_1.Type.Number({ description: '每页消息数（1-50），默认 50', minimum: 1, maximum: 50 })),
        page_token: typebox_1.Type.Optional(typebox_1.Type.String({ description: '分页标记' })),
    }),
    // THREAD — 话题内消息
    typebox_1.Type.Object({
        action: typebox_1.Type.Literal('thread'),
        thread_id: typebox_1.Type.String({ description: '话题 ID（omt_xxx 格式）' }),
        sort_rule: typebox_1.Type.Optional((0, helpers_1.StringEnum)(['create_time_asc', 'create_time_desc'], {
            description: '排序方式，默认 create_time_desc',
        })),
        page_size: typebox_1.Type.Optional(typebox_1.Type.Number({ description: '每页消息数（1-50），默认 50', minimum: 1, maximum: 50 })),
        page_token: typebox_1.Type.Optional(typebox_1.Type.String({ description: '分页标记' })),
    }),
    // MEMBERS — 群成员列表
    typebox_1.Type.Object({
        action: typebox_1.Type.Literal('members'),
        chat_id: typebox_1.Type.String({
            description: '群 ID（格式如 oc_xxx）。可以通过 feishu_chat 的 search action 搜索获取',
        }),
        member_id_type: typebox_1.Type.Optional((0, helpers_1.StringEnum)(['open_id', 'union_id', 'user_id'])),
        page_size: typebox_1.Type.Optional(typebox_1.Type.Integer({
            description: '分页大小（默认20）',
            minimum: 1,
        })),
        page_token: typebox_1.Type.Optional(typebox_1.Type.String({ description: '分页标记' })),
    }),
]);
exports.FeishuImMessageSchema = FeishuImMessageSchema;
