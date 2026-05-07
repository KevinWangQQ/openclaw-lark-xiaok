'use strict';

/**
 * Global open_id → display-name cache, populated lazily by Feishu's
 * im.chatMembers.get API. open_id is unique tenant-wide so a single
 * cache covers all groups + DMs.
 *
 * Design (fork plan §7):
 *   - Cache entries keyed by open_id, valued { name, source, fetchedAt }.
 *   - Per-chat prefetch is throttled to once per CHAT_PREFETCH_THROTTLE_MS
 *     to bound OAPI traffic; a single chat fills many entries at once.
 *   - Per-entry TTL evicts on read after MEMBER_TTL_MS so name changes
 *     in the directory eventually propagate.
 *   - prefetchChatMembers is fire-and-forget from message_received;
 *     reads are sync via getName(openId).
 *
 * Note: chatMembers.get does NOT return bots in the result list (per
 * Feishu SDK docs). For bot identity we still rely on BotRegistry +
 * wiki-bots.json. Phasing-out wiki-bots.json applies only to its
 * "members" section, not the "bots" section.
 */

const MEMBER_TTL_MS = 24 * 60 * 60 * 1000;          // 24h
const CHAT_PREFETCH_THROTTLE_MS = 5 * 60 * 1000;    // 5min per chat
const PAGE_SIZE = 100;

class MemberCache {
  constructor() {
    this._byOpenId       = new Map(); // openId → { name, source, fetchedAt }
    this._chatPrefetched = new Map(); // chatId → last-fetch timestamp
  }

  getName(openId) {
    if (!openId) return null;
    const entry = this._byOpenId.get(openId);
    if (!entry) return null;
    if (Date.now() - entry.fetchedAt > MEMBER_TTL_MS) {
      this._byOpenId.delete(openId);
      return null;
    }
    return entry.name;
  }

  set(openId, name, source = 'chat-members') {
    if (!openId || !name) return;
    this._byOpenId.set(openId, { name, source, fetchedAt: Date.now() });
  }

  shouldPrefetchChat(chatId) {
    if (!chatId) return false;
    const last = this._chatPrefetched.get(chatId) || 0;
    return Date.now() - last > CHAT_PREFETCH_THROTTLE_MS;
  }

  markChatPrefetched(chatId) {
    if (chatId) this._chatPrefetched.set(chatId, Date.now());
  }

  size() { return this._byOpenId.size; }

  stats() {
    return {
      entries: this._byOpenId.size,
      chatsTracked: this._chatPrefetched.size,
    };
  }
}

/**
 * Fire-and-forget chat member prefetch. Idempotent + throttled, so it's
 * safe to call from every message_received tick.
 *
 * Caller passes a `fetcher` (typically the wrapped fetch + bearer-token
 * pattern that fbs's index.js already uses for /im/v1/messages).
 *
 * Returns count of entries upserted, or 0 on throttle/skip/error.
 */
async function prefetchChatMembers({ cache, chatId, fetcher, log }) {
  if (!cache || !chatId || !fetcher) return 0;
  if (!cache.shouldPrefetchChat(chatId)) return 0;
  cache.markChatPrefetched(chatId);

  let total = 0;
  let pageToken;
  try {
    do {
      const params = new URLSearchParams({
        member_id_type: 'open_id',
        page_size: String(PAGE_SIZE),
      });
      if (pageToken) params.set('page_token', pageToken);

      const res = await fetcher(
        `/open-apis/im/v1/chats/${encodeURIComponent(chatId)}/members?${params}`,
        { method: 'GET' },
      );
      if (!res || res.code !== 0) {
        log?.warn(`[member-cache] prefetch ${chatId} failed: code=${res?.code} msg=${res?.msg}`);
        return total;
      }
      const items = res?.data?.items ?? [];
      for (const m of items) {
        if (m.member_id && m.name) {
          cache.set(m.member_id, m.name, 'chat-members');
          total++;
        }
      }
      pageToken = res?.data?.has_more ? res?.data?.page_token : undefined;
    } while (pageToken);
    log?.info(`[member-cache] prefetched ${total} members from ${chatId} (cache size=${cache.size()})`);
  } catch (err) {
    log?.warn(`[member-cache] prefetch ${chatId} threw: ${String(err)}`);
  }
  return total;
}

module.exports = {
  MemberCache,
  prefetchChatMembers,
  MEMBER_TTL_MS,
  CHAT_PREFETCH_THROTTLE_MS,
};
