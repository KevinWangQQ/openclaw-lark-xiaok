'use strict';

/**
 * feishu-social — optional in-tree extension (OpenClaw 5.x compatible).
 *
 * Disabled by default. Activates only when `social.enabled: true` is set in
 * pluginConfig. When enabled, registers three hooks:
 *   1. message_received    — observe inbound; storm-guard counter + record last bot @-mention
 *   2. before_prompt_build — inject group history block into the system prompt (incl. last-mention identity hint)
 *   3. message_sending     — rewrite @alias → <at user_id="..."> + outbound circuit-breaker counter
 *
 * Notes:
 * - OpenClaw 5.x deprecated the generic `inbound_claim` hook; this extension
 *   uses `message_received` (fire-and-forget). Group/DM admission is owned by
 *   the host's existing groupPolicy/requireMention config.
 * - register() runs at startup and per-session; only the startup pass receives
 *   `api.config.channels.accounts`. Shared state lives in module-level SHARED;
 *   register() updates it lazily when more config becomes available.
 */

const path = require('path');
const os   = require('os');

const { BotRegistry }                                        = require('./registry');
const { fetchGroupContext, formatContextBlock, ContextCache } = require('./context');
const { StormGuard }                                         = require('./storm-guard');
const { MemberCache, prefetchChatMembers }                   = require('./member-cache');
const { fetchAppOwnerOpenId, uatBatchUserNames }             = require('./uat-fetch');
const { escapeRegExp, makeLogger }                           = require('./utils');
const { enrichSendersInPlace }                               = require('../../tools/oapi/im/name-resolver.js');

// ── 模块级共享状态 ──────────────────────────────────────────────────────────
// startup register（含 api.config.channels）写入；后续 per-session register
// 复用，避免每 session 重新初始化。

const SHARED = {
  // 配置
  feishuAccounts     : {},                                // {accountId: {appId, appSecret}}
  feishuBase         : 'https://open.feishu.cn',
  targetGroups       : new Set(),
  alertReceiverOpenId: null,
  contextCount       : 20,

  // 运行时单例（首次 register 创建一次）
  registry    : null,
  contextCache: null,
  stormGuard  : null,
  memberCache : null,   // Phase 7: open_id → name cache populated via chatMembers API
  log         : null,

  // tenant token 缓存与 inflight 去重
  tokenCache   : new Map(),
  tokenInflight: new Map(),

  // Last bot @-mention per chat (used to inject the addressee identity into
  // the system prompt at before_prompt_build time).
  // chatId → { senderName, senderAtTag, ts }
  lastBotMention: new Map(),

  // Phase 2: per-chat ticket stash. Hook 1 (`message_received`) writes
  // {accountId, ts}; Hook 2 (`before_prompt_build`) reads it to drive UAT
  // enrichment, since `PluginHookAgentContext` carries no accountId.
  lastChatContext: new Map(),

  // Phase 2: lazy owner resolution per accountId. value === undefined means
  // "not yet resolved"; value === null means "resolved-but-not-found"; string
  // is the cached effectiveOwnerOpenId. Resolved via raw fetch to
  // /application/v6/applications/{appId}, mirroring app-scope-checker.
  appOwners        : new Map(), // accountId → ownerOpenId | null
  appOwnersInflight: new Map(), // accountId → Promise<ownerOpenId|null>

  // Phase 2: throttle UAT permission-error warnings. enrich.js:86-95 pattern.
  permissionErrorNotifiedAt: new Map(), // accountId → ts

  // hook 是否已挂到当前 api 的标记（不同 api 对象需各自挂）
  // 因 hooks 是 per-api 的（OpenClaw harness 行为），SHARED 不跟踪
};

const LAST_MENTION_TTL_MS = 5 * 60 * 1000; // 5 分钟内最近 bot 提及可注入
const LAST_CHAT_CONTEXT_TTL_MS = 5 * 60 * 1000; // ticket stash 5 分钟超时
const PERMISSION_ERROR_COOLDOWN_MS = 30 * 60 * 1000; // 30 分钟内同 account 不重复 warn
const ENRICH_BUDGET_MS = 3000; // 3s wall-clock 防 15s host hook timeout

// ── helpers ─────────────────────────────────────────────────────────────────

function resolveRef(val) {
  if (typeof val !== 'string') return val;
  return val.replace(/\$\{([^}]+)\}/g, (_, key) => process.env[key] || '');
}

/**
 * 归一化对话 ID：去掉 OpenClaw `toPluginMessageContext` 在 message_received /
 * message_sending ctx 中保留的 `chat:` / `user:` / `channel:` 前缀。
 * 源码：dist/message-hook-mappers stripChannelPrefix
 */
function normalizeConversationId(raw) {
  if (typeof raw !== 'string') return raw;
  for (const p of ['chat:', 'user:', 'channel:']) {
    if (raw.startsWith(p)) return raw.slice(p.length);
  }
  return raw;
}

function captureConfigFromApi(api, cfg) {
  // pluginConfig 在每次 register 都传，可直接取
  if (Array.isArray(cfg.contextGroups)) SHARED.targetGroups = new Set(cfg.contextGroups);
  if (cfg.contextMessageCount) {
    SHARED.contextCount = Math.min(Math.max(Number(cfg.contextMessageCount), 5), 100);
  }
  if (cfg.alertReceiverOpenId !== undefined) {
    SHARED.alertReceiverOpenId = cfg.alertReceiverOpenId || null;
  }

  // api.config 仅在 startup register 含 channels；per-session register 此处为空，跳过
  const ch = api.config?.channels?.feishu;
  if (!ch) return;

  SHARED.feishuBase = ch.domain === 'lark'
    ? 'https://open.larksuite.com'
    : 'https://open.feishu.cn';

  const rawAccounts = ch.accounts || {};
  const resolved = {};
  for (const [id, acct] of Object.entries(rawAccounts)) {
    resolved[id] = {
      ...acct,
      appId    : resolveRef(acct.appId),
      appSecret: resolveRef(acct.appSecret),
    };
  }
  if (Object.keys(resolved).length > 0) SHARED.feishuAccounts = resolved;
}

async function getTenantToken(accountId = 'default') {
  const cached = SHARED.tokenCache.get(accountId);
  if (cached && cached.expiresAt > Date.now() + 60_000) return cached.token;

  const inflight = SHARED.tokenInflight.get(accountId);
  if (inflight) return inflight;

  const promise = (async () => {
    const acctId = accountId === 'default'
      ? Object.keys(SHARED.feishuAccounts)[0]
      : accountId;
    const acct = SHARED.feishuAccounts[acctId];
    if (!acct?.appId || !acct?.appSecret) {
      SHARED.log?.warn(`[token] no credentials for ${acctId}`);
      return null;
    }

    try {
      const res  = await fetch(`${SHARED.feishuBase}/open-apis/auth/v3/tenant_access_token/internal`, {
        method : 'POST',
        headers: { 'Content-Type': 'application/json' },
        body   : JSON.stringify({ app_id: acct.appId, app_secret: acct.appSecret }),
      });
      const json = await res.json();
      if (json.code !== 0) throw new Error(json.msg);
      SHARED.tokenCache.set(accountId, {
        token    : json.tenant_access_token,
        expiresAt: Date.now() + json.expire * 1000,
      });
      SHARED.log?.info(`[token] obtained for ${acctId}, expires in ${json.expire}s`);
      return json.tenant_access_token;
    } catch (e) {
      SHARED.log?.error(`[token] failed: ${e.message}`);
      return null;
    }
  })();

  SHARED.tokenInflight.set(accountId, promise);
  try {
    return await promise;
  } finally {
    SHARED.tokenInflight.delete(accountId);
  }
}

// ── Phase 2: owner UAT plumbing ─────────────────────────────────────────────

/**
 * Resolve the effective owner open_id for an account, cached + single-flight.
 * Returns null when the account isn't configured or the API call fails — the
 * caller treats null as "no UAT enrich path available" and skips the pre-pass.
 */
async function getOwnerOpenIdForAccount(accountId) {
  if (!accountId) return null;
  if (SHARED.appOwners.has(accountId)) return SHARED.appOwners.get(accountId);
  const inflight = SHARED.appOwnersInflight.get(accountId);
  if (inflight) return inflight;

  const acct = SHARED.feishuAccounts[accountId];
  if (!acct?.appId) {
    SHARED.appOwners.set(accountId, null);
    return null;
  }

  const promise = (async () => {
    const tenantToken = await getTenantToken(accountId);
    if (!tenantToken) return null;
    const ownerOpenId = await fetchAppOwnerOpenId({
      appId      : acct.appId,
      baseUrl    : SHARED.feishuBase,
      tenantToken,
      log        : SHARED.log,
    });
    return ownerOpenId ?? null;
  })();
  SHARED.appOwnersInflight.set(accountId, promise);
  try {
    const v = await promise;
    SHARED.appOwners.set(accountId, v);
    return v;
  } finally {
    SHARED.appOwnersInflight.delete(accountId);
  }
}

/**
 * Throttled permission-error log — mirrors enrich.js:86-95. Same accountId
 * within the cooldown window only logs once.
 */
function logPermissionErrorOnce(accountId, err, log) {
  const last = SHARED.permissionErrorNotifiedAt.get(accountId) || 0;
  if (Date.now() - last < PERMISSION_ERROR_COOLDOWN_MS) return;
  SHARED.permissionErrorNotifiedAt.set(accountId, Date.now());
  log?.warn?.(`[before_prompt_build] enrich UAT failed for ${accountId}: ${String(err?.message || err)}`);
}

/**
 * Best-effort: enrich human sender names on the just-fetched timeline.
 * No-op (silent) when ticket stash is missing/expired or owner can't resolve.
 * Hard-bounded by ENRICH_BUDGET_MS to stay within host's 15s hook timeout.
 */
async function maybeEnrichSenders(chatId, messages, log) {
  const stash = SHARED.lastChatContext.get(chatId);
  if (!stash || Date.now() - stash.ts >= LAST_CHAT_CONTEXT_TTL_MS) return;
  const ownerOpenId = await getOwnerOpenIdForAccount(stash.accountId);
  const acct = SHARED.feishuAccounts[stash.accountId];
  if (!ownerOpenId || !acct?.appId) return;

  const batchResolve = (openIds) => uatBatchUserNames({
    appId      : acct.appId,
    ownerOpenId,
    openIds,
    baseUrl    : SHARED.feishuBase,
    log        : SHARED.log,
  });

  try {
    await Promise.race([
      enrichSendersInPlace({
        messages,
        accountId  : stash.accountId,
        batchResolve,
        memberCache: SHARED.memberCache,
        log        : (msg) => SHARED.log?.debug?.(msg),
      }),
      new Promise((resolve) => setTimeout(resolve, ENRICH_BUDGET_MS)),
    ]);
  } catch (err) {
    logPermissionErrorOnce(stash.accountId, err, log);
  }
}

function ensureSingletons(cfg, api, glog) {
  if (!SHARED.log) {
    const logDir = cfg.logDir || path.join(os.homedir(), '.openclaw', 'feishu-social', 'logs');
    SHARED.log = makeLogger(cfg.debugLog !== false, logDir);
  }
  if (!SHARED.contextCache) {
    SHARED.contextCache = new ContextCache(Number(cfg.contextCacheTtlMs) || 60_000);
  }
  if (!SHARED.stormGuard) {
    SHARED.stormGuard = new StormGuard({
      stormThreshold            : Number(cfg.stormThreshold)            || 5,
      stormWindowMs             : Number(cfg.stormWindowMs)             || 30_000,
      circuitBreakerMaxOutbound : Number(cfg.circuitBreakerMaxOutbound) || 5,
      circuitWindowMs           : Number(cfg.circuitWindowMs)           || 60_000,
      circuitBreakerSilenceMs   : Number(cfg.circuitBreakerSilenceMs)   || 300_000,
      logger                    : SHARED.log,
      onStormDetected           : sendStormDM,
    });
  }
  if (!SHARED.registry) {
    SHARED.registry = new BotRegistry(SHARED.log, { wikiBotsPath: cfg.wikiBotsPath });
    SHARED.registry.load(cfg, api.config || {})
      .then(() => {
        glog?.info('[feishu-social] registry loaded');
        SHARED.log.info('[registry] load complete');
      })
      .catch(e => {
        glog?.warn(`[feishu-social] registry load failed: ${e.message}`);
        SHARED.log.error(`[registry] load failed: ${e.message}`);
      });
  }
  if (!SHARED.memberCache) {
    SHARED.memberCache = new MemberCache();
  }
}

// Phase 7: small helper that wraps getTenantToken + Feishu base URL + JSON parse,
// matching the (path, options) → json shape that prefetchChatMembers expects.
async function larkFetch(pathAndQuery, init = {}) {
  const token = await getTenantToken();
  if (!token) return null;
  const url = `${SHARED.feishuBase}${pathAndQuery}`;
  const res = await fetch(url, {
    method: init.method || 'GET',
    headers: { Authorization: `Bearer ${token}`, ...(init.headers || {}) },
    body: init.body,
    signal: AbortSignal.timeout(6000),
  });
  if (!res.ok) return { code: res.status, msg: `HTTP ${res.status}` };
  return res.json();
}

async function sendStormDM(chatId) {
  if (!SHARED.alertReceiverOpenId) {
    SHARED.log?.info(`[storm-guard] storm in ${chatId} but alertReceiverOpenId not configured, skip DM`);
    return;
  }
  try {
    const token = await getTenantToken();
    if (!token) return;
    await fetch(`${SHARED.feishuBase}/open-apis/im/v1/messages?receive_id_type=open_id`, {
      method : 'POST',
      headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
      body   : JSON.stringify({
        receive_id: SHARED.alertReceiverOpenId,
        msg_type  : 'text',
        content   : JSON.stringify({
          text: `⚠️ [feishu-social] reply-loop risk detected; pausing responses to bot @-mentions in chat ${chatId}`,
        }),
      }),
    });
    SHARED.log?.info(`[storm-guard] DM sent to ${SHARED.alertReceiverOpenId} for ${chatId}`);
  } catch (e) {
    SHARED.log?.warn(`[storm-guard] DM failed: ${e.message}`);
  }
}

// ── Plugin 定义 ─────────────────────────────────────────────────────────────

const plugin = {
  id         : 'feishu-social',
  name       : 'Feishu Social',
  description: 'Optional in-tree extension: group-context injection, sender-name fallback, and bot reply-loop guard for the Feishu channel.',

  register(api) {
    // Config locations:
    //   - bundled inside openclaw-lark-extended: api.pluginConfig.social
    //   - hypothetically as a standalone plugin: api.pluginConfig
    const cfg  = api.pluginConfig?.social ?? api.pluginConfig ?? {};
    const glog = api.logger;

    // Master switch — disabled by default. When the user has not opted in,
    // skip all hook registration and singleton initialization. This keeps a
    // clean install behaviorally identical to upstream openclaw-lark.
    if (cfg.enabled !== true) {
      glog?.info('[feishu-social] disabled (set social.enabled: true to activate)');
      return;
    }

    captureConfigFromApi(api, cfg);
    ensureSingletons(cfg, api, glog);

    const log = SHARED.log;
    log.info('=== feishu-social registering ===');
    log.info(`[init] accounts: ${Object.keys(SHARED.feishuAccounts).join(', ') || '(none)'} | first appId: ${Object.values(SHARED.feishuAccounts)[0]?.appId?.slice(0,8) || 'undefined'}...`);
    log.info(`target groups: ${[...SHARED.targetGroups].join(', ') || '(none)'}`);
    log.info(`context count: ${SHARED.contextCount}`);
    log.info(`alert receiver: ${SHARED.alertReceiverOpenId || '(not configured, DM disabled)'}`);

    // ════════════════════════════════════════════════════════════════════════
    // Hook 1: message_received (replaces the deprecated inbound_claim hook)
    //
    // Triggered after the host has already decided to dispatch this event
    // (groupPolicy / requireMention etc. all passed). Fire-and-forget void
    // hook — cannot drop the event or mutate content.
    //
    // Used here to:
    //   1. Detect if the sender is a bot; record the latest bot @-mention so
    //      Hook 2 can inject sender identity into the system prompt.
    //   2. Storm-guard inbound counting (trips threshold → optional admin DM).
    //   3. Kick off async history-discovery for the registry.
    //
    // ctx fields (per host's toPluginMessageContext):
    //   ctx.channelId      = 'feishu'
    //   ctx.conversationId = oc_xxx (group) / ou_xxx (DM)
    //   ctx.senderId       = sender open_id or app_id
    //   ctx.sessionKey     = 'agent:<id>:feishu:group:oc_xxx'
    // ════════════════════════════════════════════════════════════════════════
    api.on('message_received', (event, ctx) => {
      if (ctx?.channelId !== 'feishu') return;
      // ctx.conversationId 实际格式：'chat:oc_xxx' (group) / 'user:ou_xxx' (DM) — 需归一化
      const chatId = normalizeConversationId(ctx?.conversationId);
      // 仅群消息走下面流程；DM (ou_*) 走单独路径
      if (!chatId || !chatId.startsWith('oc_')) return;

      // Phase 7: prefetch chat members for EVERY oc_ group the bot sees,
      // independent of pluginConfig.contextGroups. Member identity is
      // tenant-wide; the cache benefits all chats. Throttled per-chat to
      // bound OAPI traffic.
      if (SHARED.memberCache && SHARED.memberCache.shouldPrefetchChat(chatId)) {
        prefetchChatMembers({
          cache  : SHARED.memberCache,
          chatId,
          fetcher: larkFetch,
          log    : SHARED.log,
        }).catch(e => SHARED.log?.warn(`[member-cache] prefetch threw: ${e.message}`));
      }

      // Below: storm guard + lastBotMention only fire for explicitly-tracked
      // groups (contextGroups), since they support the context-injection feature.
      if (!SHARED.targetGroups.has(chatId)) return;

      // Phase 2: stash accountId so Hook 2 can derive a UAT ticket.
      // PluginHookAgentContext (Hook 2) carries no accountId, so we have to
      // capture it here on the inbound side. Refreshed on every inbound.
      if (ctx?.accountId) {
        SHARED.lastChatContext.set(chatId, { accountId: ctx.accountId, ts: Date.now() });
      }

      const senderId = ctx?.senderId;
      if (!senderId) return;

      log.debug(`[message_received] chat=${chatId} sender=${senderId}`);

      const reg     = SHARED.registry;
      const senderBot = reg.findByOpenId(senderId) || reg.findByAppId(senderId);

      if (!senderBot) {
        // 人类发件人：不需要记录身份（before_prompt_build 用群历史本身已能呈现）
        return;
      }
      if (senderBot.isSelf || !senderBot.isAI) {
        // 自己 / 非 AI bot（如 CRS告警）：忽略
        return;
      }

      // Storm-guard: count bot inbound @-mention. message_received is
      // fire-and-forget so we cannot drop the event here; the outbound circuit
      // breaker on Hook 3 enforces silence once the storm trips.
      const sr = SHARED.stormGuard.recordBotInbound(chatId);
      if (sr.drop) {
        log.warn(`[message_received] storm condition reached: reason=${sr.reason} chat=${chatId} (cannot drop here; outbound circuit will block replies)`);
      }

      // Record the latest bot mention so Hook 2 can render an addressee block.
      const senderName  = `${senderBot.name}${senderBot.emoji ? ' ' + senderBot.emoji : ''}`;
      const senderAtTag = senderBot.openId
        ? `<at user_id="${senderBot.openId}">${senderBot.name}</at>`
        : senderName;
      SHARED.lastBotMention.set(chatId, {
        senderName,
        senderAtTag,
        senderId,
        ts: Date.now(),
      });
      log.info(`[message_received] bot mention from ${senderName} in ${chatId}`);
      glog?.info(`[feishu-social] bot mention from ${senderName}`);
    });

    // ════════════════════════════════════════════════════════════════════════
    // Hook 2: before_prompt_build
    // 上下文增强：拉取群近期消息（含 bot 消息）注入 system prompt
    //
    // 机制：accumulating merge（所有 plugin 的 appendSystemContext 自动 concat）
    // 返回字段：{ appendSystemContext: string }（不是 systemPromptExtra！）
    // ════════════════════════════════════════════════════════════════════════
    api.on('before_prompt_build', async (event, ctx) => {
      // active-memory 子 session 不需要群上下文
      if (ctx?.sessionKey?.includes(':active-memory:')) return;

      const chatId = ctx?.channelId?.split(':')?.[0];
      log.debug(`[before_prompt_build] channelId=${ctx?.channelId} chatId=${chatId}`);

      if (!chatId || !SHARED.targetGroups.has(chatId)) return;

      // Phase 2: ContextCache.computeOnce 单飞读 — cache hit 直返，inflight 命中
      // 复用同一 Promise，否则起新 Promise 并 enrich + format。三种路径都 await 同一
      // baseBlock，避免并发 inbound 同时打 UAT。
      let baseBlock;
      try {
        baseBlock = await SHARED.contextCache.computeOnce(chatId, async () => {
          const token = await getTenantToken();
          if (!token) {
            log.warn('[before_prompt_build] no token, skip context');
            return null;
          }
          const messages = await fetchGroupContext(chatId, SHARED.contextCount, token, SHARED.feishuBase);
          log.info(`[before_prompt_build] fetched ${messages.length} msgs from ${chatId}`);

          // Phase 2: UAT enrich pre-pass — best-effort, fully bounded by ENRICH_BUDGET_MS
          // and silent on auth/permission errors (logPermissionErrorOnce throttles).
          await maybeEnrichSenders(chatId, messages, log);

          SHARED.registry.discoverFromHistory(chatId, token, SHARED.feishuBase).catch(() => {});

          // accountId 决定 formatMessageTimeline 的 cache cascade。单账号部署
          // （绝大多数 fork install 的形态）下 stash 缺失就回退到 first account。
          const stash = SHARED.lastChatContext.get(chatId);
          const accountId = stash?.accountId ?? Object.keys(SHARED.feishuAccounts)[0];

          return formatContextBlock({
            messages,
            registry   : SHARED.registry,
            chatId,
            cfg,
            accountId,
            memberCache: SHARED.memberCache,
          });
        });
      } catch (e) {
        log.warn(`[before_prompt_build] fetch failed: ${e.message}, degrading`);
        glog?.warn(`[feishu-social] context fetch failed for ${chatId}: ${e.message}`);
        return;
      }
      if (!baseBlock) return;

      // Append the most-recent bot-mention identity hint so the agent knows
      // who triggered this turn (degenerates to empty when no recent mention).
      const mention = SHARED.lastBotMention.get(chatId);
      const mentionBlock = (mention && Date.now() - mention.ts < LAST_MENTION_TTL_MS)
        ? `\n\n[Last bot mention that triggered this turn]\n  ${mention.senderName}\n  to @-reply: ${mention.senderAtTag}`
        : '';

      return { appendSystemContext: baseBlock + mentionBlock };
    });

    // ════════════════════════════════════════════════════════════════════════
    // Hook 3: message_sending
    // 格式修正：@alias → 飞书原生 <at user_id="..."> 标签
    //
    // ctx 字段（源码验证 deliver.js applyMessageSendingHook）：
    //   ctx.channelId      = 'feishu'   始终固定（路由通道名）
    //   ctx.accountId      = '...'
    //   ctx.conversationId = params.to  群=oc_xxx, DM=ou_xxx — 真正的对话 ID
    // ════════════════════════════════════════════════════════════════════════
    api.on('message_sending', (event, ctx) => {
      log.debug(`[message_sending] channelId=${ctx?.channelId} convId=${ctx?.conversationId} len=${event.content?.length}`);
      if (ctx?.channelId !== 'feishu') return;

      let content  = event.content || '';
      let modified = false;

      for (const bot of SHARED.registry.getAtTargets()) {
        for (const alias of (bot.aliases || [])) {
          const pattern = new RegExp(
            `@${escapeRegExp(alias)}(?=[^a-zA-Z0-9一-鿿]|$)`,
            'g'
          );
          const replaced = content.replace(pattern, `<at user_id="${bot.openId}">${bot.name}</at>`);
          if (replaced !== content) {
            log.info(`[message_sending] @${alias} → <at> for ${bot.name}`);
            content  = replaced;
            modified = true;
          }
        }
      }

      // Outbound counter for the circuit breaker. Source the chatId from
      // ctx.conversationId (channelId is fixed to 'feishu' on outbound).
      const chatId = normalizeConversationId(ctx?.conversationId);
      if (chatId && SHARED.targetGroups.has(chatId)) {
        SHARED.stormGuard.recordOutbound(chatId);
        // Drop the cached group history for this chat immediately so the next
        // turn's context block reflects the agent's own reply rather than the
        // pre-reply snapshot still inside the 60s TTL.
        const purged = SHARED.contextCache.invalidate(chatId);
        if (purged > 0) log.debug(`[message_sending] contextCache invalidated for ${chatId} (${purged} keys)`);
      }

      if (modified) return { content };
    });

    log.info('=== feishu-social all hooks registered ===');
    glog?.info('[feishu-social] registered: message_received + before_prompt_build + message_sending');
  },
};

module.exports = plugin;
module.exports.default = plugin;

// Named export consumed by openclaw-lark/index.js register(api) — see Phase 2.2.
function registerFeishuSocial(api) {
  return plugin.register(api);
}
module.exports.registerFeishuSocial = registerFeishuSocial;

// Local member-name lookup: openclaw-lark's enrich.js consults this when the
// contact OAPI returns no display name (missing permission, cache miss, etc.).
// Returns {name, source} so callers can log which path resolved the identity.
// Resolution order:
//   1. SHARED.memberCache (Phase 7) — populated dynamically by im.chatMembers.get
//      on first contact with each tracked chat. Fresh, accurate, batched.
//   2. SHARED.registry findMemberByOpenId — legacy wiki-bots.json mapping,
//      kept as a transitional fallback until the API cache covers all
//      required senders. Slated for retirement once Phase 7 is stable.
function lookupMemberName(openId) {
  if (!openId) return null;
  const cached = SHARED.memberCache?.getName(openId);
  if (cached) return { name: cached, source: 'member-cache' };
  if (SHARED.registry) {
    const member = SHARED.registry.findMemberByOpenId?.(openId);
    if (member?.name) return { name: member.name, source: 'wiki-bots-registry' };
  }
  return null;
}
module.exports.lookupMemberName = lookupMemberName;
