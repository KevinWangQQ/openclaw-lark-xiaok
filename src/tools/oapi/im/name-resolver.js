"use strict";
/**
 * Copyright (c) 2026 ByteDance Ltd. and/or its affiliates
 * SPDX-License-Identifier: MIT
 *
 * Unified name-resolver for Feishu user/chat display names.
 *
 * Single source of truth for the account-scoped user-name cache:
 * src/messaging/inbound/user-name-cache-store.js#getUserNameCache.
 * Both the inbound TAT path (mention prefill, contact/v3/users/batch) and
 * the tool-layer UAT path (contact/v3/users/basic_batch) write into it,
 * so resolutions performed in either lane are visible to the other.
 *
 * Empty-string sentinel semantics (preserved from TAT writer):
 *   ''       → "API confirmed no name available, don't retry"
 *   string   → resolved display name
 *   undefined→ never seen, callers may attempt to resolve
 *
 * Safe-set rule (this module enforces; the underlying class does not):
 *   - non-empty name: always overwrites (refresh / UAT can resurrect a TAT '' sentinel)
 *   - empty name: only writes the sentinel when no real name is cached
 */
Object.defineProperty(exports, "__esModule", { value: true });
exports.resolveUserName = resolveUserName;
exports.batchResolveUserNames = batchResolveUserNames;
exports.prefillUserNamesFromMentions = prefillUserNamesFromMentions;
exports.resolveChatName = resolveChatName;
exports.batchResolveChatNames = batchResolveChatNames;
exports.enrichSendersInPlace = enrichSendersInPlace;
exports.setUserNameSafe = setUserNameSafe;       // for Phase 1 shim callers
exports.setUserName = setUserName;               // top-level safe-set (account-scoped)
exports.peekUserName = peekUserName;             // raw read incl. '' sentinel (tests + diagnostics)
exports.clearUserNameCacheAll = clearUserNameCacheAll;
exports.clearChatNameCache = clearChatNameCache;
const user_name_cache_store_1 = require("../../../messaging/inbound/user-name-cache-store.js");
// Mirror of content-converter-helpers.extractMentionOpenId. Inlined to keep the
// resolver's import graph leaf-only (so vitest can load it without pulling
// the full content-converter chain that transitively imports core/lark-client).
function extractMentionOpenId(id) {
    if (typeof id === 'string')
        return id;
    if (id != null && typeof id === 'object' && 'open_id' in id) {
        const openId = id.open_id;
        return typeof openId === 'string' ? openId : '';
    }
    return '';
}
// ---------------------------------------------------------------------------
// User-name resolution (delegates cache to the shared TAT/UAT store)
// ---------------------------------------------------------------------------
const USER_BATCH_SIZE = 10; // contact/v3/users/basic_batch hard limit
/**
 * Synchronous read from the shared user-name cache.
 *
 * Returns `undefined` for both "never seen" and "known-unresolvable" (the
 * empty-string sentinel) — callers that want the sentinel directly should
 * use the underlying `getUserNameCache(accountId)` API.
 */
function resolveUserName(accountId, openId) {
    if (!accountId || !openId)
        return undefined;
    const name = (0, user_name_cache_store_1.getUserNameCache)(accountId).get(openId);
    return name ? name : undefined;
}
/**
 * Top-level safe-set into the shared user-name cache. Routes through the
 * resolver's CJS module instance so callers never need a direct reference
 * to `getUserNameCache` (which can resolve to a different instance under
 * vitest ESM resolution). Phase 1 shim and tests should prefer this.
 */
function setUserName(accountId, openId, name) {
    if (!accountId)
        return;
    setUserNameSafe((0, user_name_cache_store_1.getUserNameCache)(accountId), openId, name);
}
/**
 * Raw cache read — returns '' for sentinel, undefined for "never seen",
 * or the cached display name. Useful for diagnostics and tests that need
 * to distinguish the sentinel from a missing entry; callers rendering UI
 * should use {@link resolveUserName} instead.
 */
function peekUserName(accountId, openId) {
    if (!accountId || !openId)
        return undefined;
    return (0, user_name_cache_store_1.getUserNameCache)(accountId).get(openId);
}
/** Clear every account's user-name cache; primarily for test isolation. */
function clearUserNameCacheAll() {
    (0, user_name_cache_store_1.clearUserNameCache)();
}
/**
 * Cache writer that preserves the empty-string sentinel invariant.
 *   - non-empty name → always overwrites (UAT can resurrect a TAT '' sentinel)
 *   - empty name → only writes the sentinel when no real name is cached
 */
function setUserNameSafe(cache, openId, name) {
    if (!openId)
        return;
    if (name) {
        cache.set(openId, name);
        return;
    }
    const existing = cache.get(openId);
    if (existing) return; // truthy means a real name is already cached
    cache.set(openId, '');
}
/**
 * Pre-fill user-name cache from `mentions[].name` carried by message events.
 *
 * Mention names are free information: the inbound event already includes
 * them, so writing them to cache costs nothing. Returns the count of fresh
 * entries written so callers can log cache warm-up size.
 */
function prefillUserNamesFromMentions(accountId, items) {
    if (!accountId || !Array.isArray(items) || items.length === 0)
        return 0;
    const cache = (0, user_name_cache_store_1.getUserNameCache)(accountId);
    let n = 0;
    for (const item of items) {
        const mentions = item?.mentions;
        if (!Array.isArray(mentions))
            continue;
        for (const m of mentions) {
            const openId = extractMentionOpenId(m?.id);
            if (openId && m?.name) {
                setUserNameSafe(cache, openId, m.name);
                n++;
            }
        }
    }
    return n;
}
/**
 * Batch-resolve user display names via UAT contact/v3/users/basic_batch.
 *
 * Behavior:
 *  1. Read shared cache; collect cache misses (treats '' sentinel as miss
 *     for return value, but skips re-querying it — sentinel respected).
 *  2. Dedup misses, chunk to BATCH_SIZE, call basic_batch with as:'user'.
 *  3. Write results into shared cache via safe-set; un-returned IDs become
 *     '' sentinels so subsequent reads don't retry.
 *
 * Errors:
 *  - InvokeError (UserAuthRequiredError, AppScopeMissingError,
 *    UserScopeInsufficientError) re-throws so outer handlers can run
 *    auto-auth flows — preserves existing tool-layer behavior.
 *  - Other errors are logged and swallowed; partial results returned.
 *
 * @param {Object} params
 * @param {Object} params.client     - ToolClient with invoke + account
 * @param {string[]} params.openIds  - user open_ids to resolve
 * @param {(...args:any)=>void} params.log - log function
 * @param {string} [params.accountId] - override; defaults to client.account.accountId
 * @returns {Promise<Map<string,string>>} resolved openId → name (excludes sentinels)
 */
async function batchResolveUserNames(params) {
    const { client, openIds, log } = params;
    if (!openIds || openIds.length === 0)
        return new Map();
    const accountId = params.accountId ?? client?.account?.accountId;
    if (!accountId)
        return new Map();
    const cache = (0, user_name_cache_store_1.getUserNameCache)(accountId);
    const result = new Map();
    const missing = [];
    for (const id of openIds) {
        if (!id)
            continue;
        // cache.has() respects TTL; cache.get() returns '' for sentinel
        if (cache.has(id)) {
            const v = cache.get(id);
            if (v)
                result.set(id, v); // sentinel '' is filtered from the result
        }
        else {
            missing.push(id);
        }
    }
    const unique = [...new Set(missing)];
    if (unique.length === 0)
        return result;
    const totalBatches = Math.ceil(unique.length / USER_BATCH_SIZE);
    log(`name-resolver.user: resolving ${unique.length} via UAT basic_batch in ${totalBatches} chunk(s), ${result.size} cache hit(s)`);
    for (let i = 0; i < unique.length; i += USER_BATCH_SIZE) {
        const chunk = unique.slice(i, i + USER_BATCH_SIZE);
        const batchIndex = Math.floor(i / USER_BATCH_SIZE) + 1;
        try {
            const res = await client.invoke('feishu_get_user.basic_batch', (sdk, opts) => sdk.request({
                method: 'POST',
                url: '/open-apis/contact/v3/users/basic_batch',
                data: { user_ids: chunk },
                params: { user_id_type: 'open_id' },
            }, opts), { as: 'user' });
            const users = res?.data?.users ?? [];
            const resolved = new Set();
            // First-call diagnostic: log response shape so the actual field name is
            // visible in fbs-debug. Cheap, only runs when the chunk has any user
            // entries (post-Phase-4 hotfix to root-cause why operator_name stayed
            // null after a successful resolving run).
            if (users.length > 0) {
                log(`name-resolver.user: response sample — data keys=[${Object.keys(res?.data || {}).join(',')}], first user keys=[${Object.keys(users[0] || {}).join(',')}]`);
            }
            for (const user of users) {
                // Support multiple field names: basic_batch returns user_id (per
                // Feishu docs), but the same SDK has been observed to return
                // open_id on similar endpoints. Try both before giving up.
                const openId = user.user_id ?? user.open_id ?? user.id;
                const rawName = user.name;
                const name = typeof rawName === 'string' ? rawName : rawName?.value;
                if (openId && name) {
                    setUserNameSafe(cache, openId, name);
                    result.set(openId, name);
                    resolved.add(openId);
                }
            }
            // Unresolved IDs in this chunk: write '' sentinel to suppress retries.
            // safe-set declines to overwrite a real name, so this is safe even if
            // a parallel writer already cached it.
            for (const id of chunk) {
                if (!resolved.has(id))
                    setUserNameSafe(cache, id, '');
            }
            const unresolvedCount = chunk.length - resolved.size;
            if (unresolvedCount > 0) {
                log(`name-resolver.user: chunk ${batchIndex}/${totalBatches}: ${resolved.size} ok, ${unresolvedCount} no-name`);
            }
        }
        catch (err) {
            // Auth / scope errors must propagate so handleInvokeErrorWithAutoAuth
            // can run the OAuth refresh flow. Other errors are best-effort.
            if (isStructuredInvokeError(err))
                throw err;
            log(`name-resolver.user: chunk ${batchIndex}/${totalBatches} failed: ${String(err)}`);
        }
    }
    return result;
}
// Local mirror of helpers.isInvokeError to avoid the resolver depending on
// the broader oapi/helpers surface (which transitively pulls auto-auth).
function isStructuredInvokeError(err) {
    if (!err || typeof err !== 'object')
        return false;
    const name = err.constructor?.name;
    return (name === 'UserAuthRequiredError' ||
        name === 'AppScopeMissingError' ||
        name === 'UserScopeInsufficientError');
}
// ---------------------------------------------------------------------------
// Chat-name resolution (new — independent LRU, TTL 60min, size 200)
// ---------------------------------------------------------------------------
const CHAT_BATCH_SIZE = 50; // chats/batch_query is generous; clamp anyway
const CHAT_TTL_MS = 60 * 60 * 1000;
const CHAT_MAX_SIZE = 200;
const chatRegistry = new Map(); // accountId → Map<chatId, {info, expireAt}>
function getChatCache(accountId) {
    let cache = chatRegistry.get(accountId);
    if (!cache) {
        cache = new Map();
        chatRegistry.set(accountId, cache);
    }
    return cache;
}
function evictChatCache(cache) {
    while (cache.size > CHAT_MAX_SIZE) {
        const oldest = cache.keys().next().value;
        if (oldest === undefined)
            return;
        cache.delete(oldest);
    }
}
function readChatEntry(cache, chatId) {
    const entry = cache.get(chatId);
    if (!entry)
        return undefined;
    if (entry.expireAt <= Date.now()) {
        cache.delete(chatId);
        return undefined;
    }
    // LRU touch
    cache.delete(chatId);
    cache.set(chatId, entry);
    return entry.info;
}
function writeChatEntry(cache, chatId, info) {
    cache.delete(chatId);
    cache.set(chatId, { info, expireAt: Date.now() + CHAT_TTL_MS });
    evictChatCache(cache);
}
/**
 * Synchronous read from the chat-name cache.
 * Returns `{name, chat_mode, p2p_target_id?}` or undefined.
 * For p2p chats whose name field is empty, the caller can derive the
 * displayable chat name from the user-name cache via p2p_target_id.
 */
function resolveChatName(accountId, chatId) {
    if (!accountId || !chatId)
        return undefined;
    return readChatEntry(getChatCache(accountId), chatId);
}
function clearChatNameCache(accountId) {
    if (accountId === undefined) {
        chatRegistry.clear();
        return;
    }
    chatRegistry.get(accountId)?.clear();
    chatRegistry.delete(accountId);
}
/**
 * Batch-resolve chat info via UAT im/v1/chats/batch_query.
 *
 * For p2p chats this also opportunistically resolves the counterparty's
 * user name through batchResolveUserNames so callers can use chat_partner.name
 * without a second call.
 *
 * Errors are best-effort (logged, swallowed) — chat info is supplementary.
 * Returns Map<chatId, {name, chat_mode, p2p_target_id?}>.
 */
async function batchResolveChatNames(params) {
    const { client, chatIds, log } = params;
    if (!chatIds || chatIds.length === 0)
        return new Map();
    const accountId = params.accountId ?? client?.account?.accountId;
    if (!accountId)
        return new Map();
    const cache = getChatCache(accountId);
    const result = new Map();
    const missing = [];
    for (const id of chatIds) {
        if (!id)
            continue;
        const cached = readChatEntry(cache, id);
        if (cached) {
            result.set(id, cached);
        }
        else {
            missing.push(id);
        }
    }
    const unique = [...new Set(missing)];
    if (unique.length === 0)
        return result;
    log(`name-resolver.chat: resolving ${unique.length}, ${result.size} cache hit(s)`);
    for (let i = 0; i < unique.length; i += CHAT_BATCH_SIZE) {
        const chunk = unique.slice(i, i + CHAT_BATCH_SIZE);
        try {
            const res = await client.invokeByPath('feishu_chats.batch_query', '/open-apis/im/v1/chats/batch_query', {
                method: 'POST',
                body: { chat_ids: chunk },
                query: { user_id_type: 'open_id' },
                as: 'user',
            });
            if (res?.code !== 0) {
                log(`name-resolver.chat: code=${res?.code} msg=${res?.msg}`);
                continue;
            }
            for (const c of res.data?.items ?? []) {
                if (!c?.chat_id)
                    continue;
                const info = {
                    name: c.name ?? '',
                    chat_mode: c.chat_mode ?? '',
                    p2p_target_id: c.p2p_target_id,
                };
                writeChatEntry(cache, c.chat_id, info);
                result.set(c.chat_id, info);
            }
        }
        catch (err) {
            if (isStructuredInvokeError(err))
                throw err;
            log(`name-resolver.chat: chunk failed: ${String(err)}`);
        }
    }
    // For p2p chats, opportunistically warm the user-name cache for the
    // counterparty so chat_partner.name lookups don't need another round-trip.
    const targetIds = [
        ...new Set([...result.values()]
            .map((c) => c.p2p_target_id)
            .filter((id) => !!id)),
    ];
    if (targetIds.length > 0) {
        try {
            await batchResolveUserNames({ client, openIds: targetIds, log, accountId });
        }
        catch (err) {
            if (isStructuredInvokeError(err))
                throw err;
            log(`name-resolver.chat: p2p name warm-up failed: ${String(err)}`);
        }
    }
    return result;
}
// ---------------------------------------------------------------------------
// Top-level enrich helper (testable via injected batchResolve)
// ---------------------------------------------------------------------------
/**
 * Cascade-resolve human sender names for a batch of messages, in place.
 *
 * Cascade order (per sender):
 *   1. mention prefill — already cached from inbound or earlier tools
 *   2. memberCache.getName — wiki-bots / chatMembers prefetch (if provided)
 *   3. shared user-name cache — read via resolveUserName
 *   4. injected batchResolve(missingIds[]) — UAT batch (or test stub)
 *
 * Bots are skipped: registry/sender_type='app' resolution is the caller's
 * responsibility. The function only touches sender objects whose
 * sender_type === 'user'.
 *
 * Failure modes:
 *  - batchResolve throws → caller catches; messages are left as-is and
 *    fallback rendering ("用户(last8)") happens at the rendering layer.
 *  - batchResolve resolves partial → unresolved senders stay unresolved;
 *    callers should not assume every sender ends up with a name.
 *
 * @param {Object} params
 * @param {Array} params.messages - feishu API message items (mutated to add sender.name)
 * @param {string} params.accountId
 * @param {(openIds:string[]) => Promise<Map<string,string>>} params.batchResolve
 * @param {{getName:(openId:string)=>string|null}} [params.memberCache]
 * @param {{isBotSender:(openId:string)=>boolean, isBotByAppId:(appId:string)=>boolean}} [params.registry]
 * @param {(...args:any)=>void} [params.log]
 * @returns {Promise<{resolvedCount:number, missingCount:number}>}
 */
async function enrichSendersInPlace(params) {
    const { messages, accountId, batchResolve, memberCache, registry, log } = params;
    if (!accountId || !Array.isArray(messages) || messages.length === 0) {
        return { resolvedCount: 0, missingCount: 0 };
    }
    // Step 1: prefill from mentions (free)
    prefillUserNamesFromMentions(accountId, messages);
    // Step 2: collect human sender open_ids needing a name
    const senderIds = new Set();
    for (const item of messages) {
        const sender = item?.sender;
        if (!sender)
            continue;
        const senderType = sender.sender_type ?? sender.id_type ?? 'user';
        // Skip bot senders — registry handles them at render time
        if (senderType === 'app' || senderType === 'bot')
            continue;
        const id = sender.id;
        if (!id)
            continue;
        // Already labeled by a previous pass — leave alone
        if (sender.name)
            continue;
        // Hot path: memberCache hit means we can stamp now without API
        if (memberCache?.getName) {
            const m = memberCache.getName(id);
            if (m) {
                sender.name = m;
                continue;
            }
        }
        // Shared user-name cache hit
        const cached = resolveUserName(accountId, id);
        if (cached) {
            sender.name = cached;
            continue;
        }
        senderIds.add(id);
    }
    if (senderIds.size === 0)
        return { resolvedCount: messages.length, missingCount: 0 };
    // Step 3: batchResolve the rest (production wires UAT batch; tests inject stub)
    let resolvedMap;
    try {
        resolvedMap = await batchResolve([...senderIds]);
    }
    catch (err) {
        // Caller decides how to log; we surface unresolved-state by leaving sender.name unset.
        log?.(`name-resolver.enrich: batchResolve failed: ${String(err)}`);
        return { resolvedCount: 0, missingCount: senderIds.size };
    }
    if (!(resolvedMap instanceof Map)) {
        log?.('name-resolver.enrich: batchResolve returned non-Map; skipping in-place enrich');
        return { resolvedCount: 0, missingCount: senderIds.size };
    }
    // Step 4: stamp resolved names back onto sender objects
    let resolvedCount = 0;
    for (const item of messages) {
        const sender = item?.sender;
        if (!sender || sender.name)
            continue;
        const senderType = sender.sender_type ?? sender.id_type ?? 'user';
        if (senderType === 'app' || senderType === 'bot')
            continue;
        const name = resolvedMap.get(sender.id);
        if (name) {
            sender.name = name;
            resolvedCount++;
        }
    }
    return { resolvedCount, missingCount: senderIds.size - resolvedCount };
}
