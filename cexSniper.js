#!/usr/bin/env node
// Lightweight CEX sniper helper (non-invasive)
// Exposes start/stop/history helpers that accept per-user decrypted keys.
const fs = require('fs');
const path = require('path');

const running = new Map();
const TRADE_DIR = path.join(process.cwd(), 'sent_tokens');
if (!fs.existsSync(TRADE_DIR)) {
  try { fs.mkdirSync(TRADE_DIR, { recursive: true }); } catch (e) {}
}

/**
 * @param {string} userId
 * @returns {string}
 */
function _historyPath(userId) {
  return path.join(TRADE_DIR, `cex_trades_${String(userId)}.json`);
}

/**
 * @param {string} userId
 * @param {{apiKey:string,apiSecret:string,platform?:string}} keys
 * @param {any} [opts]
 */
function startUserCexSniper(userId, keys, opts) {
  // keys: { apiKey, apiSecret, platform }
  if (!userId) return { ok: false, err: 'missing userId' };
  if (!keys || !keys.apiKey || !keys.apiSecret) return { ok: false, err: 'missing keys' };
  if (running.has(String(userId))) return { ok: false, err: 'already_running' };
  // Minimal start: mark running; if opts.live===true we'll flag live-mode but still keep safe by default
  /** @type {any} */
  const liveFlag = Boolean(opts && (opts).live);
  /** @type {any} */
  const meta = /** @type {any} */ ({ startedAt: Date.now(), keys: { ...keys }, opts: opts || {}, live: liveFlag });
  // If live requested, attach a placeholder ccxt client field (not performing real orders here)
  if (meta.live) {
    meta.client = null; // placeholder for future ccxt client instance
  }
  running.set(String(userId), meta);
  return { ok: true, msg: meta.live ? 'CEX sniper started in LIVE mode (orders disabled until fully implemented).' : 'CEX sniper started (simulation). This module currently runs in dry-run mode by default.' };
}

/**
 * @param {string} userId
 */
function stopUserCexSniper(userId) {
  if (!userId) return { ok: false, err: 'missing userId' };
  if (!running.has(String(userId))) return { ok: false, err: 'not_running' };
  running.delete(String(userId));
  return { ok: true, msg: 'CEX sniper stopped' };
}

/**
 * @param {string} userId
 */
function getUserCexSniperStatus(userId) {
  if (!userId) return { ok: false, err: 'missing userId' };
  const r = running.get(String(userId));
  if (!r) return { ok: true, running: false };
  return { ok: true, running: true, since: r.startedAt };
}

/**
 * @param {string} userId
 * @param {object} record
 */
function addTradeRecord(userId, record) {
  try {
    const p = _historyPath(userId);
    let arr = [];
    if (fs.existsSync(p)) {
      try { arr = JSON.parse(fs.readFileSync(p, 'utf8') || '[]'); } catch (e) { arr = []; }
    }
    arr.push(Object.assign({ ts: Date.now() }, record || {}));
    fs.writeFileSync(p, JSON.stringify(arr.slice(-500), null, 2));
    return { ok: true };
  } catch (e) { return { ok: false, err: String(e) }; }
}

/**
 * @param {string} userId
 */
function getUserTradeHistory(userId) {
  try {
    const p = _historyPath(userId);
    if (!fs.existsSync(p)) return { ok: true, trades: [] };
    const arr = JSON.parse(fs.readFileSync(p, 'utf8') || '[]');
    return { ok: true, trades: arr };
  } catch (e) { return { ok: false, err: String(e) }; }
}

// Analyze a symbol by invoking trading.py --analyze and returning parsed JSON
/**
 * Analyze a symbol by invoking trading.py --analyze and returning parsed JSON.
 * Accepts an optional opts object: { platform: 'mexc' } which will set EXCHANGE for the child python process.
 * Backwards compatible: analyzeSymbol(userId, symbol) still works.
 *
 * @param {string} userId
 * @param {string} symbol
 * @param {{platform?:string}} [opts]
 * @returns {Promise<any>}
 */
function analyzeSymbol(userId, symbol, opts) {
  return new Promise((resolve) => {
    try {
      const { spawn } = require('child_process');
      const script = path.join(process.cwd(), 'trading.py');
      const args = [script, '--analyze', String(symbol)];
      // Prepare env for child: allow overriding EXCHANGE per-call (platform), fallback to existing env
      const childEnv = Object.assign({}, process.env);
      try {
        const platform = opts && opts.platform ? String(opts.platform).trim() : (process.env.EXCHANGE || '');
        if (platform) childEnv.EXCHANGE = platform;
      } catch (e) {}
      const py = spawn('python3', args, { env: childEnv });
      let out = '';
      let err = '';
      py.stdout.on('data', (d) => { out += String(d || ''); });
      py.stderr.on('data', (d) => { err += String(d || ''); });
      py.on('close', (code) => {
        if (out) {
          try { const obj = JSON.parse(out.trim()); return resolve({ ok: true, data: obj }); } catch (e) { return resolve({ ok: false, parse_error: true, out, stderr: err }); }
        }
        return resolve({ ok: false, err: 'no_output', code, out, stderr: err });
      });
    } catch (e) { return resolve({ ok: false, err: String(e) }); }
  });
}

// Simple confirm flow for enabling live trading per-user
const pendingLiveConfirm = new Set();
/**
 * @param {string} userId
 */
function requestEnableLive(userId) {
  if (!userId) return { ok: false, err: 'missing userId' };
  // If already pending, confirm and enable
  if (pendingLiveConfirm.has(String(userId))) {
    pendingLiveConfirm.delete(String(userId));
    // mark running with live flag if keys available
    const ukeys = null; // caller should pass keys
    // we don't have keys here — caller will call startUserCexSniper with live true
    return { ok: true, msg: 'confirmed' };
  }
  pendingLiveConfirm.add(String(userId));
  return { ok: true, msg: 'confirm_needed' };
}

// Safety checks before any real execution
/**
 * @param {any} analysis
 * @param {any} opts
 */
function _passesFilters(analysis, opts) {
  try {
    const minVolume = Number(opts && opts.minVolume || process.env.CEX_MIN_VOLUME_USDT || 10000);
    const maxAtrPct = Number(opts && opts.maxAtrPct || process.env.CEX_MAX_ATR_PCT || 0.2);
    if (analysis.volume && analysis.close) {
      // approximate USD volume if symbol quote is USDT
      if (analysis.volume < minVolume) return { ok: false, reason: 'low_volume' };
    }
    if (analysis.atr && analysis.close) {
      const atrPct = Number(analysis.atr) / Number(analysis.close);
      if (!isNaN(atrPct) && atrPct > maxAtrPct) return { ok: false, reason: 'high_atr' };
    }
    return { ok: true };
  } catch (e) { return { ok: false, reason: 'filter_error', err: String(e) }; }
}

// Stubbed execute order: respects ENABLE_CEX_EXECUTION env var; for safety, default false
/**
 * @param {string} userId
 * @param {string} symbol
 * @param {string} side
 * @param {number} usdtSize
 * @param {any} keys
 * @param {any} opts
 */
async function executeOrder(userId, symbol, side, usdtSize, keys, opts) {
  try {
    const enabled = String(process.env.ENABLE_CEX_EXECUTION || '').toLowerCase() === 'true';
    // record attempt
    addTradeRecord(userId, { action: 'execute_attempt', symbol, side, usdtSize, enabled });
    if (!enabled) return { ok: false, simulated: true, msg: 'execution_disabled' };
    // Real execution would create a ccxt client per user and place market order.
    // For now, return a stubbed success to keep safe.
    addTradeRecord(userId, { action: 'execute_record', symbol, side, usdtSize, note: 'STUBBED_SUCCESS' });
    return { ok: true, simulated: false, note: 'stubbed_success' };
  } catch (e) { return { ok: false, err: String(e) }; }
}

// ========================================
// MULTI-TIMEFRAME STRATEGY EXECUTION (CEX)
// ========================================

/**
 * Execute multi-timeframe strategy on CEX
 * يقوم بتنفيذ الاستراتيجية متعددة الأطر الزمنية على CEX
 * 
 * @param {string} userId 
 * @param {string} symbol - مثل BTCUSDT على Binance / MEXC
 * @param {Record<string, number[]>} priceHistoryByTf - { "1h": [...], "4h": [...], ... }
 * @param {any} keys - { apiKey, apiSecret, platform }
 * @param {any} opts - خيارات الاستراتيجية
 */
async function executeCexMultiTimeframeStrategy(userId, symbol, priceHistoryByTf, keys, opts = {}) {
  try {
    if (!userId || !symbol || !keys) {
      return { ok: false, err: 'missing required params' };
    }

    const {
      capitalPercent = 0.10,
      minMatches = 3,
      takeProfitMin = 0.01,
      takeProfitMax = 0.03,
      reinvestLoss = -0.03,
    } = opts;

    // Extract current price from the first timeframe
    const anyTf = Object.keys(priceHistoryByTf)[0];
    if (!anyTf || !Array.isArray(priceHistoryByTf[anyTf])) {
      return { ok: false, err: 'invalid price history format' };
    }

    const prices = priceHistoryByTf[anyTf];
    const currentPrice = prices[prices.length - 1];

    // Calculate Stochastic RSI & Williams %R for all timeframes
    const indicators = {};
    let matchCount = 0;
    const matchedTfs = [];

    for (const [tf, priceArr] of Object.entries(priceHistoryByTf)) {
      if (!Array.isArray(priceArr) || priceArr.length < 40) continue;

      // Calculate indicators
      const stochRsi = _calculateStochasticRSI(priceArr);
      const wr = _calculateWilliamsR(priceArr);

      indicators[tf] = { ...stochRsi, wr };

      // Check entry conditions: J < 10, K < 30, K < D, WR > 80
      const jCond = stochRsi.J < 10;
      const kCond = stochRsi.K < 30 && stochRsi.K < stochRsi.D;
      const wrCond = wr > 80;

      if (jCond && kCond && wrCond) {
        matchCount++;
        matchedTfs.push(tf);
      }
    }

    // Decision: Buy if 3+ timeframes match
    if (matchCount >= minMatches) {
      // Get wallet balance (stub)
      const walletBalance = Number(opts.walletBalance || 100); // USDT
      const buyAmount = walletBalance * capitalPercent;

      // Record position
      addTradeRecord(userId, {
        action: 'entry',
        symbol,
        side: 'BUY',
        amount: buyAmount,
        price: currentPrice,
        matchedTfs: matchedTfs.join(','),
        matchCount,
        reason: `${matchCount}/${Object.keys(priceHistoryByTf).length} TFs matched`,
      });

      // Execute order (respects ENABLE_CEX_EXECUTION)
      const orderResult = await executeOrder(userId, symbol, 'BUY', buyAmount, keys, opts);

      return {
        ok: true,
        action: 'BUY',
        price: currentPrice,
        amount: buyAmount,
        matchCount,
        matchedTfs,
        orderResult,
      };
    }

    // Check for exit signal if already in position (stub: load from file or memory)
    const inPosition = opts.inPosition || false;
    if (inPosition) {
      const entryPrice = opts.entryPrice || currentPrice;
      const priceChange = (currentPrice - entryPrice) / entryPrice;

      // Take Profit: +1% to +3%
      if (priceChange >= takeProfitMin && priceChange <= takeProfitMax) {
        const sellAmount = opts.positionSize || (opts.walletBalance * capitalPercent);

        addTradeRecord(userId, {
          action: 'exit',
          symbol,
          side: 'SELL',
          amount: sellAmount,
          price: currentPrice,
          gain: priceChange,
          reason: `Take Profit at +${(priceChange * 100).toFixed(2)}%`,
        });

        const orderResult = await executeOrder(userId, symbol, 'SELL', sellAmount, keys, opts);

        return {
          ok: true,
          action: 'SELL',
          price: currentPrice,
          amount: sellAmount,
          gain: priceChange,
          orderResult,
        };
      }

      // Re-entry: -3% from last sell
      const lastSellPrice = opts.lastSellPrice || entryPrice;
      if (currentPrice <= lastSellPrice * (1 + reinvestLoss)) {
        const buyAmount = opts.positionSize || (opts.walletBalance * capitalPercent);

        addTradeRecord(userId, {
          action: 'reinvest',
          symbol,
          side: 'BUY',
          amount: buyAmount,
          price: currentPrice,
          reason: `Re-entry at -${Math.abs(reinvestLoss * 100).toFixed(1)}% from last sell`,
        });

        const orderResult = await executeOrder(userId, symbol, 'BUY', buyAmount, keys, opts);

        return {
          ok: true,
          action: 'REINVEST',
          price: currentPrice,
          amount: buyAmount,
          orderResult,
        };
      }
    }

    return {
      ok: true,
      action: 'WAIT',
      matchCount,
      reason: `Only ${matchCount}/${Object.keys(priceHistoryByTf).length} TFs match (need ${minMatches})`,
    };
  } catch (e) {
    return { ok: false, err: String(e) };
  }
}

/**
 * Helper: Calculate Stochastic RSI (J, K, D)
 */
function _calculateStochasticRSI(prices, rsiPeriod = 14, stochPeriod = 14, kPeriod = 3, dPeriod = 3) {
  if (prices.length < rsiPeriod + stochPeriod - 1) {
    return { J: 50, K: 50, D: 50 };
  }

  // Calculate RSI
  const rsiValues = [];
  for (let i = rsiPeriod; i < prices.length; i++) {
    const slice = prices.slice(i - rsiPeriod, i + 1);
    let gains = 0, losses = 0;
    for (let j = 1; j < slice.length; j++) {
      const change = slice[j] - slice[j - 1];
      if (change >= 0) gains += change;
      else losses += Math.abs(change);
    }
    const rs = gains > 0 ? gains / losses : 0;
    const rsi = 100 - 100 / (1 + rs);
    rsiValues.push(rsi);
  }

  // Stochastic of RSI
  const kValues = [];
  for (let i = stochPeriod - 1; i < rsiValues.length; i++) {
    const rsiSlice = rsiValues.slice(i - stochPeriod + 1, i + 1);
    const minRsi = Math.min(...rsiSlice);
    const maxRsi = Math.max(...rsiSlice);
    const k = maxRsi !== minRsi ? ((rsiValues[i] - minRsi) / (maxRsi - minRsi)) * 100 : 50;
    kValues.push(k);
  }

  const k = kValues.length >= kPeriod
    ? kValues.slice(-kPeriod).reduce((a, b) => a + b) / kPeriod
    : kValues[kValues.length - 1] || 50;

  const kSmooth = [];
  for (let i = kPeriod - 1; i < kValues.length; i++) {
    const avg = kValues.slice(i - kPeriod + 1, i + 1).reduce((a, b) => a + b) / kPeriod;
    kSmooth.push(avg);
  }

  const d = kSmooth.length >= dPeriod
    ? kSmooth.slice(-dPeriod).reduce((a, b) => a + b) / dPeriod
    : kSmooth[kSmooth.length - 1] || 50;

  const j = 3 * k - 2 * d;

  return { J: j, K: k, D: d };
}

/**
 * Helper: Calculate Williams %R
 */
function _calculateWilliamsR(prices, period = 14) {
  if (prices.length < period) return -50;

  const slice = prices.slice(-period);
  const highest = Math.max(...slice);
  const lowest = Math.min(...slice);
  const close = slice[slice.length - 1];

  if (highest === lowest) return 0;

  const wr = ((close - highest) / (highest - lowest)) * -100;
  return wr;
}

module.exports.executeDexMultiTimeframeStrategy = executeDexMultiTimeframeStrategy;

// ========================================
// PERSISTENT CEX PRICE MONITORING
// مراقبة الأسعار الدائمة للـ CEX
// ========================================

/**
 * مراقب أسعار CEX دائم
 * يراقب الأزواج والعملات ويحدث الأسعار بشكل مستمر
 */
async function startCexPriceMonitor(options = {}) {
  try {
    const {
      userIds = [],
      symbols = [], // مثل ['BTCUSDT', 'ETHUSDT']
      checkIntervalMs = 10000, // CEX أبطأ من DEX
      exchangeKeys = {}, // { userId: { apiKey, apiSecret, platform } }
    } = options;

    let stopped = false;

    const stop = () => {
      stopped = true;
      console.log('[CexMonitor] Stopped');
    };

    const monitor = async () => {
      if (stopped) return;

      try {
        const sentTokensDir = path.join(process.cwd(), 'sent_tokens');
        try {
          fs.mkdirSync(sentTokensDir, { recursive: true });
        } catch (e) {}

        // جمع الأسعار من CEX
        const priceUpdates = {};

        for (const symbol of symbols) {
          try {
            // في التطبيق الحقيقي، ستستخدم CCXT أو API مباشرة
            // هنا نحاكي التحديث
            const mockPrice = parseFloat((Math.random() * 50000 + 20000).toFixed(2)); // محاكاة سعر BTC
            priceUpdates[symbol] = {
              symbol,
              price: mockPrice,
              timestamp: Date.now(),
              source: 'binance_mock', // أو mexc_mock
            };
          } catch (e) {}
        }

        // احفظ تحديثات الأسعار لكل مستخدم
        for (const userId of userIds) {
          try {
            const pricesFile = path.join(sentTokensDir, `${userId}_cex_prices.json`);
            const existing = {};

            try {
              if (fs.existsSync(pricesFile)) {
                const prev = JSON.parse(fs.readFileSync(pricesFile, 'utf8'));
                Object.assign(existing, prev);
              }
            } catch (e) {}

            // دمج الأسعار الجديدة
            const updated = {
              ...existing,
              ...Object.fromEntries(
                Object.entries(priceUpdates).map(([symbol, data]) => [
                  symbol,
                  data.price,
                ])
              ),
              _lastUpdate: Date.now(),
              _exchange: exchangeKeys[userId]?.platform || 'binance',
            };

            const ENABLE_ARCHIVE = String(process.env.ENABLE_ARCHIVE || '').toLowerCase() === 'true';
            if (ENABLE_ARCHIVE) {
              fs.writeFileSync(pricesFile, JSON.stringify(updated, null, 2));
            }
          } catch (e) {}
        }

        // سجل آخر التحديثات
        try {
          const logFile = path.join(sentTokensDir, 'cex_monitor.log');
          const logEntry = JSON.stringify({
            timestamp: new Date().toISOString(),
            symbolsMonitored: symbols.length,
            usersMonitored: userIds.length,
            pricesUpdated: Object.keys(priceUpdates).length,
          });

          const ENABLE_ARCHIVE = String(process.env.ENABLE_ARCHIVE || '').toLowerCase() === 'true';
          if (ENABLE_ARCHIVE) {
            const log = [];
            try {
              if (fs.existsSync(logFile)) {
                const prevLog = fs.readFileSync(logFile, 'utf8').split('\n');
                log.push(...prevLog.slice(-99)); // احفظ آخر 100 سطر
              }
            } catch (e) {}

            log.push(logEntry);
            fs.writeFileSync(logFile, log.join('\n'));
          }
        } catch (e) {}

      } catch (error) {
        console.error('[CexMonitor] Error:', error);
      }
    };

    // ابدأ المراقبة
    const monitorInterval = setInterval(monitor, checkIntervalMs);
    console.log(
      `[CexMonitor] Started monitoring ${symbols.length} symbols for ${userIds.length} users (interval: ${checkIntervalMs}ms)`
    );

    // جلسة أولية
    await monitor();

    return stop;
  } catch (e) {
    console.error('[startCexPriceMonitor] Error:', e);
    return () => {};
  }
}

/**
 * قراءة أحدث الأسعار المراقبة على CEX
 */
function getCexCurrentPrices(userId) {
  try {
    const sentTokensDir = path.join(process.cwd(), 'sent_tokens');
    const pricesFile = path.join(sentTokensDir, `${userId}_cex_prices.json`);

    if (fs.existsSync(pricesFile)) {
      return JSON.parse(fs.readFileSync(pricesFile, 'utf8'));
    }
  } catch (e) {}

  return {};
}

/**
 * مراقب CEX و DEX مدمج
 */
async function startDualPriceMonitor(users, options = {}) {
  const {
    checkIntervalMs = 5000,
    dexTokens = [],
    cexSymbols = [],
  } = options;

  let stopped = false;
  const monitors = [];

  const stop = async () => {
    stopped = true;

    for (const mon of monitors) {
      try {
        await mon();
      } catch (e) {}
    }

    console.log('[DualMonitor] All monitors stopped');
  };

  try {
    const userIds = Object.keys(users);

    // ابدأ مراقب DEX
    if (dexTokens.length > 0) {
      try {
        const dexStop = await (typeof module.exports.startDexPriceMonitor === 'function'
          ? module.exports.startDexPriceMonitor({
              userIds,
              tokenAddresses: dexTokens,
              checkIntervalMs,
            })
          : Promise.resolve(() => {}));

        monitors.push(dexStop);
        console.log('[DualMonitor] DEX monitor started');
      } catch (e) {
        console.error('[DualMonitor] Failed to start DEX monitor:', e);
      }
    }

    // ابدأ مراقب CEX
    if (cexSymbols.length > 0) {
      try {
        const cexStop = await startCexPriceMonitor({
          userIds,
          symbols: cexSymbols,
          checkIntervalMs: checkIntervalMs * 2, // CEX أبطأ
        });

        monitors.push(cexStop);
        console.log('[DualMonitor] CEX monitor started');
      } catch (e) {
        console.error('[DualMonitor] Failed to start CEX monitor:', e);
      }
    }

    console.log('[DualMonitor] Started with', monitors.length, 'active monitors');

  } catch (e) {
    console.error('[startDualPriceMonitor] Error:', e);
  }

  return stop;
}

module.exports = {
  ...module.exports,
  startCexPriceMonitor,
  getCexCurrentPrices,
  startDualPriceMonitor,
};
