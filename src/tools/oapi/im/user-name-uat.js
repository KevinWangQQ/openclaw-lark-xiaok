"use strict";
/**
 * Copyright (c) 2026 ByteDance Ltd. and/or its affiliates
 * SPDX-License-Identifier: MIT
 *
 * Re-export shim — see ./name-resolver.js for the implementation.
 *
 * Phase 0 collapsed this file's private uatRegistry LRU into the shared
 * cache at src/messaging/inbound/user-name-cache-store.js so that inbound
 * (TAT) and tool-layer (UAT) name resolutions write into one place. Public
 * exports preserved for callers that still import by these names:
 *
 *   getUATUserName(accountId, openId)              → name-resolver.resolveUserName
 *   setUATUserNames(accountId, entries: Map)       → safe-set into shared cache
 *   batchResolveUserNamesAsUser({client, openIds}) → name-resolver.batchResolveUserNames
 */
Object.defineProperty(exports, "__esModule", { value: true });
exports.getUATUserName = getUATUserName;
exports.setUATUserNames = setUATUserNames;
exports.batchResolveUserNamesAsUser = batchResolveUserNamesAsUser;
const name_resolver_1 = require("./name-resolver.js");
const user_name_cache_store_1 = require("../../../messaging/inbound/user-name-cache-store.js");
function getUATUserName(accountId, openId) {
    return (0, name_resolver_1.resolveUserName)(accountId, openId);
}
function setUATUserNames(accountId, entries) {
    if (!accountId || !entries)
        return;
    const cache = (0, user_name_cache_store_1.getUserNameCache)(accountId);
    for (const [openId, name] of entries) {
        (0, name_resolver_1.setUserNameSafe)(cache, openId, name);
    }
}
async function batchResolveUserNamesAsUser(params) {
    return (0, name_resolver_1.batchResolveUserNames)(params);
}
