'use strict';

/**
 * uat-fetch.js — extension-layer raw UAT helpers.
 *
 * The architect (review §2) flagged that constructing a full ToolClient
 * inside `before_prompt_build` is too eager: the legacy-plugin guard at
 * core/tool-client.js:152 fires on every group message, and
 * assertOwnerAccessStrict rejects when the speaker isn't the bot owner.
 * To keep the hot loop decoupled from that machinery, we own two thin
 * raw-fetch helpers here and call them with explicit appId/ownerOpenId.
 *
 * - fetchAppOwnerOpenId: one-shot lookup of an app's effective owner via
 *   /application/v6/applications/{appId}, mirroring the extraction
 *   logic in core/app-scope-checker.js#getAppInfo. Uses TAT.
 * - uatBatchUserNames: bot owner's stored UAT → contact basic_batch.
 *   The architect's recommended path (review §2 (a)+(b)+(c)).
 *
 * All failures are silent (warn-log + empty Map / undefined). Caller is
 * responsible for fallback rendering.
 */

// Lazy-require core/token-store inside uatBatchUserNames so this module stays
// load-time safe under vitest's ESM resolution (Phase 0 hit the same chain via
// content-converter → user-name-cache → core/lark-client → core/version).
// require()-on-first-call defers the chain until production runtime, where
// Node's CJS resolution handles it correctly.

const REFRESH_AHEAD_MS = 5 * 60 * 1000; // skip near-expiry tokens; tool-layer auto-auth refreshes them
const BATCH_SIZE = 10;                  // contact/v3/users/basic_batch hard limit
const FETCH_TIMEOUT_MS = 6000;
const APP_INFO_TIMEOUT_MS = 8000;

/**
 * Fetch the effective owner open_id for an app.
 *
 * Mirrors core/app-scope-checker.js#getAppInfo's owner extraction:
 *   ownerType === 2 ? owner.owner_id : (creator_id ?? owner.owner_id)
 *
 * Returns undefined on any failure (HTTP error, non-zero code, missing
 * fields, network error). Caller treats undefined as "no UAT path
 * available" and skips enrichment.
 */
async function fetchAppOwnerOpenId({ appId, baseUrl, tenantToken, log }) {
  if (!appId || !tenantToken || !baseUrl) return undefined;
  try {
    const url = `${baseUrl}/open-apis/application/v6/applications/${encodeURIComponent(appId)}?lang=zh_cn`;
    const res = await fetch(url, {
      headers: { Authorization: `Bearer ${tenantToken}` },
      signal: AbortSignal.timeout(APP_INFO_TIMEOUT_MS),
    });
    if (!res.ok) {
      log?.warn?.(`[uat-fetch] app-info HTTP ${res.status} for ${appId}`);
      return undefined;
    }
    const json = await res.json();
    if (json.code !== 0) {
      log?.warn?.(`[uat-fetch] app-info code=${json.code} msg=${json.msg}`);
      return undefined;
    }
    const app = json.data?.app ?? json.app ?? json.data;
    const owner = app?.owner;
    const creatorId = app?.creator_id;
    const ownerType = owner?.owner_type ?? owner?.type;
    return ownerType === 2 && owner?.owner_id
      ? owner.owner_id
      : (creatorId ?? owner?.owner_id);
  } catch (err) {
    log?.warn?.(`[uat-fetch] app-info fetch failed for ${appId}: ${String(err)}`);
    return undefined;
  }
}

/**
 * Direct UAT call to contact/v3/users/basic_batch using the bot owner's
 * stored access token. Bypasses ToolClient (per architect review §2).
 *
 * @param params.appId        - bot's app_id
 * @param params.ownerOpenId  - effective owner's open_id (key for token-store)
 * @param params.openIds      - target user open_ids to resolve
 * @param params.baseUrl      - https://open.feishu.cn or https://open.larksuite.com
 * @param params.log          - optional logger
 * @returns Promise<Map<openId, name>>  resolved entries; empty Map on any failure
 */
async function uatBatchUserNames({ appId, ownerOpenId, openIds, baseUrl, log }) {
  if (!appId || !ownerOpenId || !Array.isArray(openIds) || openIds.length === 0) {
    return new Map();
  }
  // Lazy require — see top-of-file note for why this is deferred.
  const { getStoredToken } = require('../../core/token-store.js');
  const stored = await getStoredToken(appId, ownerOpenId);
  if (!stored) {
    log?.warn?.(`[uat-fetch] no stored token for ${appId}:${ownerOpenId.slice(-8)}`);
    return new Map();
  }
  if (stored.expiresAt <= Date.now() + REFRESH_AHEAD_MS) {
    log?.warn?.(`[uat-fetch] token near-expiry for ${ownerOpenId.slice(-8)}, skip enrich`);
    return new Map();
  }

  const result = new Map();
  for (let i = 0; i < openIds.length; i += BATCH_SIZE) {
    const chunk = openIds.slice(i, i + BATCH_SIZE);
    try {
      const url = `${baseUrl}/open-apis/contact/v3/users/basic_batch?user_id_type=open_id`;
      const res = await fetch(url, {
        method: 'POST',
        headers: {
          'Authorization': `Bearer ${stored.accessToken}`,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({ user_ids: chunk }),
        signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
      });
      if (!res.ok) {
        log?.warn?.(`[uat-fetch] basic_batch HTTP ${res.status}`);
        continue;
      }
      const json = await res.json();
      if (json.code !== 0) {
        log?.warn?.(`[uat-fetch] basic_batch code=${json.code} msg=${json.msg}`);
        continue;
      }
      for (const u of json.data?.users ?? []) {
        if (!u?.user_id) continue;
        const rawName = u.name;
        const name = typeof rawName === 'string' ? rawName : rawName?.value;
        if (name) result.set(u.user_id, name);
      }
    } catch (err) {
      log?.warn?.(`[uat-fetch] basic_batch chunk failed: ${String(err)}`);
    }
  }
  return result;
}

module.exports = { fetchAppOwnerOpenId, uatBatchUserNames };
