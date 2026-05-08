'use strict';

/**
 * storm-guard.js — bot reply-loop protection.
 *
 * Layers:
 *   L1 (debounce)  : N bot-inbound @-mentions inside stormWindowMs trips storm; sends an
 *                    optional DM to social.alertReceiverOpenId and feeds the circuit.
 *   L2 (circuit)   : N outbound replies inside circuitWindowMs opens the circuit; the
 *                    chat goes silent for circuitBreakerSilenceMs.
 *   L3 (exemption) : human senders never reach this guard; only bot-typed senders are
 *                    counted (the calling site filters by sender_type before recording).
 */

class StormGuard {
  /**
   * @param {Object} opts
   * @param {number}   [opts.stormThreshold=5]            - bot-inbound mentions inside the storm window that trip the debounce
   * @param {number}   [opts.stormWindowMs=30000]         - rolling window for bot-inbound counting
   * @param {number}   [opts.circuitBreakerMaxOutbound=5] - outbound replies inside the circuit window that open the circuit
   * @param {number}   [opts.circuitWindowMs=60000]       - rolling window for outbound counting
   * @param {number}   [opts.circuitBreakerSilenceMs=300000] - how long the circuit stays open once tripped
   * @param {Function} [opts.onStormDetected]             - async (chatId) => void; invoked once per storm trip
   * @param {Object}   [opts.logger]
   */
  constructor(opts = {}) {
    this.stormThreshold   = opts.stormThreshold              || 5;
    this.stormWindowMs    = opts.stormWindowMs               || 30_000;
    this.maxOutbound      = opts.circuitBreakerMaxOutbound   || 5;
    this.circuitWindowMs  = opts.circuitWindowMs             || 60_000;
    this.silenceMs        = opts.circuitBreakerSilenceMs     || 300_000;
    this.onStormDetected  = opts.onStormDetected             || (() => {});
    this.log              = opts.logger || { info: ()=>{}, warn: ()=>{}, debug: ()=>{} };

    // chatId → { botInboundTs: number[], outboundTs: number[], circuitOpenAt: number|null }
    this._state = new Map();
  }

  _state_(chatId) {
    if (!this._state.has(chatId)) {
      this._state.set(chatId, { botInboundTs: [], outboundTs: [], circuitOpenAt: null });
    }
    return this._state.get(chatId);
  }

  /**
   * Record one bot-inbound @-mention.
   * @returns {{ drop: boolean, reason: string|null }}
   */
  recordBotInbound(chatId) {
    const s   = this._state_(chatId);
    const now = Date.now();

    if (s.circuitOpenAt !== null) {
      if (now - s.circuitOpenAt < this.silenceMs) {
        this.log.info(`[storm-guard] circuit OPEN for ${chatId}, dropping`);
        return { drop: true, reason: 'circuit_open' };
      }
      s.circuitOpenAt  = null;
      s.botInboundTs   = [];
      this.log.info(`[storm-guard] circuit reset for ${chatId}`);
    }

    s.botInboundTs = s.botInboundTs.filter(ts => now - ts < this.stormWindowMs);
    s.botInboundTs.push(now);

    if (s.botInboundTs.length >= this.stormThreshold) {
      this.log.warn(`[storm-guard] storm detected in ${chatId}: ${s.botInboundTs.length} msgs in ${this.stormWindowMs/1000}s`);
      s.botInboundTs = [];
      Promise.resolve().then(() => this.onStormDetected(chatId)).catch(() => {});
      return { drop: true, reason: 'storm_debounce' };
    }

    return { drop: false, reason: null };
  }

  /**
   * Record one agent outbound message (feeds the circuit-breaker counter).
   */
  recordOutbound(chatId) {
    const s   = this._state_(chatId);
    const now = Date.now();
    s.outboundTs = s.outboundTs.filter(ts => now - ts < this.circuitWindowMs);
    s.outboundTs.push(now);

    if (s.outboundTs.length >= this.maxOutbound) {
      s.circuitOpenAt = now;
      s.outboundTs    = [];
      this.log.warn(`[storm-guard] circuit OPENED for ${chatId}: silence ${this.silenceMs/1000}s`);
    }
  }

  /** Manual reset (e.g. operator command to clear the silence window). */
  reset(chatId) {
    this._state.delete(chatId);
    this.log.info(`[storm-guard] manual reset for ${chatId}`);
  }

  getStatus(chatId) {
    const s   = this._state_(chatId);
    const now = Date.now();
    const open = s.circuitOpenAt !== null && now - s.circuitOpenAt < this.silenceMs;
    return {
      chatId,
      circuitOpen       : open,
      circuitRemainingMs: open ? this.silenceMs - (now - s.circuitOpenAt) : 0,
      recentBotInbound  : s.botInboundTs.length,
      recentOutbound    : s.outboundTs.length,
    };
  }
}

module.exports = { StormGuard };
