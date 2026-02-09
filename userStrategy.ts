import { PublicKey } from '@solana/web3.js';
import rpcPool from './src/utils/rpcPool';
/**
 * Fetch the user's Solana balance
 */
export async function getSolBalance(userSecret: string): Promise<number> {
  const connection = rpcPool.getRpcConnection();
  const secretKey = Uint8Array.from(Buffer.from(userSecret, 'base64'));
  const keypair = require('@solana/web3.js').Keypair.fromSecretKey(secretKey);
  const balance = await connection.getBalance(keypair.publicKey);
  return balance / 1e9; // تحويل من lamports إلى SOL
}
import fs from 'fs';
import path from 'path';
// admin rules and shared locks
const admn = require('./admn.js');
import { userLocks } from './src/utils/userLocks';

/**
 * Record a buy or sell operation in the user's file inside sent_tokens
 */
export function recordUserTrade(userId: string, trade: any) {
  if (!userId || userId === 'undefined') {
    console.warn('[recordUserTrade] Invalid userId, skipping trade record.');
    return;
  }
  const sentTokensDir = path.join(process.cwd(), 'sent_tokens');
  try{
    const ENABLE_ARCHIVE = String(process.env.ENABLE_ARCHIVE || '').toLowerCase() === 'true';
    if(ENABLE_ARCHIVE){ if (!fs.existsSync(sentTokensDir)) fs.mkdirSync(sentTokensDir); }
  }catch(_){ }
  const userFile = path.join(sentTokensDir, `${userId}.json`);
  let userTrades: any[] = [];
  if (fs.existsSync(userFile)) {
    try { userTrades = JSON.parse(fs.readFileSync(userFile, 'utf8')); } catch {}
  }
  userTrades.push({ ...trade, time: Date.now() });
  try{ const ENABLE_ARCHIVE = String(process.env.ENABLE_ARCHIVE || '').toLowerCase() === 'true'; if(ENABLE_ARCHIVE){ fs.writeFileSync(userFile, JSON.stringify(userTrades, null, 2)); } }catch(_){ }
}
// userStrategy.ts
require('dotenv').config();
// Handles Honey Points strategy logic for Telegram bot

// No need to import fs since all operations are on the in-memory users object

export type HoneyToken = {
  address: string;
  buyAmount: number;
  profitPercents: number[]; // Profit percentages for each stage
  soldPercents: number[];   // Sell percentages for each stage
  lastEntryPrice?: number;
  lastSellPrice?: number;
  finished?: boolean;
  status?: 'pending' | 'active' | 'sold' | 'error'; // For bot UI feedback
  currentStage?: number; // Track which profit stage is next
  lastTxId?: string; // Last transaction ID for feedback
  volume?: number;
  ageMinutes?: number;
};

export type HoneySettings = {
  tokens: HoneyToken[];
  repeatOnEntry: boolean;
};

/**
 * Get user's Honey Points strategy settings
 */
export function getHoneySettings(userId: string, users: Record<string, any>): HoneySettings {
  if (!users[userId] || !users[userId].honeySettings) {
    return { tokens: [], repeatOnEntry: true };
  }
  // Ensure tokens is an array
  const settings = users[userId].honeySettings;
  return {
    tokens: Array.isArray(settings.tokens) ? settings.tokens : [],
    repeatOnEntry: typeof settings.repeatOnEntry === 'boolean' ? settings.repeatOnEntry : true
  };
}

/**
 * Save user's Honey Points strategy settings
 */
export function setHoneySettings(userId: string, settings: HoneySettings, users: Record<string, any>) {
  if (!users[userId]) users[userId] = {};
  users[userId].honeySettings = settings;
}

/**
 * Add a new token to the Honey Points strategy
 */
export function addHoneyToken(userId: string, token: HoneyToken, users: Record<string, any>) {
  const settings = getHoneySettings(userId, users);
  if (settings.tokens.length >= 10) throw new Error('Maximum 10 tokens allowed.');
  // Prevent duplicates
  if (settings.tokens.some(t => t.address === token.address)) {
    throw new Error('Token already exists in strategy.');
  }
  settings.tokens.push(token);
  setHoneySettings(userId, settings, users);
}

/**
 * Remove a token from the Honey Points strategy
 */
export function removeHoneyToken(userId: string, tokenAddress: string, users: Record<string, any>) {
  const settings = getHoneySettings(userId, users);
  settings.tokens = settings.tokens.filter(t => t.address !== tokenAddress);
  setHoneySettings(userId, settings, users);
}

/**
 * Reset all tokens in the Honey Points strategy
 */
export function resetHoneyTokens(userId: string, users: Record<string, any>) {
  setHoneySettings(userId, { tokens: [], repeatOnEntry: true }, users);
}

/**
 * Execute Honey Points strategy for the user (auto buy/sell by stages)
 */
export async function executeHoneyStrategy(
  userId: string,
  users: Record<string, any>,
  getPrice: (address: string) => Promise<number>,
  autoBuy: (address: string, amount: number, secret: string) => Promise<string>,
  autoSell: (address: string, amount: number, secret: string) => Promise<string>
) {
  const user = users[userId];
  if (!user || !user.secret) throw new Error('Wallet not found');
  const settings = getHoneySettings(userId, users);
  // Filter tokens according to user settings
  const filteredTokens = settings.tokens.filter(token => {
  // Example: Filter by volume and age (can be expanded for other fields)
    if (typeof token.volume !== 'undefined' && user.strategy?.minVolume && token.volume < user.strategy.minVolume) return false;
    if (typeof token.ageMinutes !== 'undefined' && user.strategy?.minAge && token.ageMinutes < user.strategy.minAge) return false;
    return true;
  });
  for (const token of filteredTokens) {
    // Ignore tokens with missing essential data
    if (!token.address || !token.buyAmount || !Array.isArray(token.profitPercents) || !Array.isArray(token.soldPercents) || token.profitPercents.length === 0 || token.soldPercents.length === 0) {
      token.status = 'error';
      continue;
    }
    if (token.finished) {
      token.status = 'sold';
      continue;
    }
    let currentPrice: number;
    try {
      currentPrice = await getPrice(token.address);
    } catch (e) {
      token.status = 'error';
      continue; // Skip token if price fetch fails
    }
    if (!token.lastEntryPrice) {
      // Initial buy
      try {
        const solBalance = await getSolBalance(user.secret);
  if (solBalance < token.buyAmount + 0.002) { // 0.002 SOL estimated for fees
          token.status = 'error';
          recordUserTrade(userId, {
            mode: 'buy',
            token: token.address,
            amount: token.buyAmount,
            entryPrice: currentPrice,
            status: 'fail',
            error: 'Insufficient SOL balance for buy and fees',
          });
          continue;
        }
        const txId = await userLocks.runExclusive(userId, async () => {
          return await autoBuy(token.address, token.buyAmount, user.secret);
        }, admn.VALIDATION_RULES.COMMAND_TIMEOUT_MS || 30000);
        token.lastEntryPrice = currentPrice;
        token.status = 'active';
        token.currentStage = 0;
        token.lastTxId = txId;
        recordUserTrade(userId, {
          mode: 'buy',
          token: token.address,
          amount: token.buyAmount,
          tx: txId,
          entryPrice: currentPrice,
          status: 'success',
        });
      } catch (e) {
        token.status = 'error';
        recordUserTrade(userId, {
          mode: 'buy',
          token: token.address,
          amount: token.buyAmount,
          entryPrice: currentPrice,
          status: 'fail',
          error: e instanceof Error ? e.message : String(e),
        });
        continue; // Skip if buy fails
      }
      continue;
    }
    // Profit stages
    for (let i = token.currentStage || 0; i < token.profitPercents.length; i++) {
      const target = token.lastEntryPrice * (1 + token.profitPercents[i] / 100);
      if (
        currentPrice >= target &&
        (!token.lastSellPrice || currentPrice > token.lastSellPrice)
      ) {
        const sellAmount = token.buyAmount * (token.soldPercents[i] / 100);
        try {
          const solBalance = await getSolBalance(user.secret);
          if (solBalance < sellAmount + 0.002) {
            token.status = 'error';
            recordUserTrade(userId, {
              mode: 'sell',
              token: token.address,
              amount: sellAmount,
              sellPrice: currentPrice,
              status: 'fail',
              error: 'Insufficient SOL balance for sell and fees',
            });
            continue;
          }
          const txId = await userLocks.runExclusive(userId, async () => {
            return await autoSell(token.address, sellAmount, user.secret);
          }, admn.VALIDATION_RULES.COMMAND_TIMEOUT_MS || 30000);
          token.lastSellPrice = currentPrice;
          token.currentStage = i + 1;
          token.lastTxId = txId;
          recordUserTrade(userId, {
            mode: 'sell',
            token: token.address,
            amount: sellAmount,
            tx: txId,
            sellPrice: currentPrice,
            status: 'success',
          });
          if (token.currentStage >= token.profitPercents.length) {
            token.finished = true;
            token.status = 'sold';
          }
        } catch (e) {
          token.status = 'error';
          recordUserTrade(userId, {
            mode: 'sell',
            token: token.address,
            amount: sellAmount,
            sellPrice: currentPrice,
            status: 'fail',
            error: e instanceof Error ? e.message : String(e),
          });
          continue; // Skip if sell fails
        }
      }
    }
    // If all sold and price returns, repeat if allowed
    const totalSold = token.soldPercents.reduce((a, b) => a + b, 0);
    if (
      totalSold >= 100 &&
      settings.repeatOnEntry &&
      currentPrice <= (token.lastEntryPrice ?? 0)
    ) {
      token.finished = false;
      token.lastEntryPrice = undefined;
      token.lastSellPrice = undefined;
      token.status = 'pending';
      token.currentStage = 0;
      token.lastTxId = undefined;
    }
  }
  setHoneySettings(userId, settings, users);
}

// ========================================
// MULTI-TIMEFRAME STRATEGY CORE
// استراتيجية متعددة الأطر الزمنية
// ========================================

/**
 * مؤشرات التحليل الفني المستخدمة في الاستراتيجية
 */
export interface TechnicalIndicators {
  stochRsi_J: number;
  stochRsi_K: number;
  stochRsi_D: number;
  williams_R: number;
  rsi: number;
  timestamp: number;
}

/**
 * إعدادات الاستراتيجية متعددة الأطر
 */
export interface MultiTimeframeStrategy {
  timeframes: string[]; // ["5m", "15m", "4h", "8h"]
  capitalPercent: number; // 10% من المحفظة
  minMatchingTimeframes: number; // 3 أطر على الأقل
  takeProfitRange: { min: number; max: number }; // [1%, 3%]
  reinvestLoss: number; // -3% لإعادة الشراء
  entryConditions: {
    stochRsi_J_max: number; // < 10
    stochRsi_K_max: number; // < 30
    williams_R_min: number; // > 80 (معكوس)
  };
}

/**
 * حساب مؤشر Stochastic RSI
 * Returns: { J, K, D }
 */
export function calculateStochasticRSI(
  prices: number[],
  rsiPeriod = 14,
  stochPeriod = 14,
  kPeriod = 3,
  dPeriod = 3
): { J: number; K: number; D: number } {
  if (prices.length < rsiPeriod + stochPeriod - 1) {
    return { J: 50, K: 50, D: 50 }; // Default neutral values
  }

  // Step 1: Calculate RSI
  const rsiValues: number[] = [];
  for (let i = rsiPeriod; i < prices.length; i++) {
    const slice = prices.slice(i - rsiPeriod, i + 1);
    let gains = 0,
      losses = 0;

    for (let j = 1; j < slice.length; j++) {
      const change = slice[j] - slice[j - 1];
      if (change >= 0) gains += change;
      else losses += Math.abs(change);
    }

    const rs = gains > 0 ? gains / losses : 0;
    const rsi = 100 - 100 / (1 + rs);
    rsiValues.push(rsi);
  }

  // Step 2: Stochastic of RSI
  const kValues: number[] = [];
  for (let i = stochPeriod - 1; i < rsiValues.length; i++) {
    const rsiSlice = rsiValues.slice(i - stochPeriod + 1, i + 1);
    const minRsi = Math.min(...rsiSlice);
    const maxRsi = Math.max(...rsiSlice);

    const k =
      maxRsi !== minRsi ? ((rsiValues[i] - minRsi) / (maxRsi - minRsi)) * 100 : 50;
    kValues.push(k);
  }

  // Step 3: Calculate K (SMA of Stochastic)
  const k =
    kValues.length >= kPeriod
      ? kValues.slice(-kPeriod).reduce((a, b) => a + b) / kPeriod
      : kValues[kValues.length - 1] || 50;

  // Step 4: Calculate D (SMA of K)
  const kSmooth: number[] = [];
  for (let i = kPeriod - 1; i < kValues.length; i++) {
    const avg = kValues.slice(i - kPeriod + 1, i + 1).reduce((a, b) => a + b) / kPeriod;
    kSmooth.push(avg);
  }

  const d =
    kSmooth.length >= dPeriod
      ? kSmooth.slice(-dPeriod).reduce((a, b) => a + b) / dPeriod
      : kSmooth[kSmooth.length - 1] || 50;

  // Step 5: Calculate J = 3K - 2D
  const j = 3 * k - 2 * d;

  return { J: j, K: k, D: d };
}

/**
 * حساب مؤشر Williams %R
 */
export function calculateWilliamsR(prices: number[], period = 14): number {
  if (prices.length < period) return -50; // Neutral value

  const slice = prices.slice(-period);
  const highest = Math.max(...slice);
  const lowest = Math.min(...slice);
  const close = slice[slice.length - 1];

  if (highest === lowest) return 0;

  const wr = ((close - highest) / (highest - lowest)) * -100;
  return wr;
}

/**
 * حساب RSI البسيط
 */
export function calculateRSI(prices: number[], period = 14): number {
  if (prices.length < period + 1) return 50;

  let gains = 0,
    losses = 0;

  for (let i = prices.length - period; i < prices.length; i++) {
    const change = prices[i] - prices[i - 1];
    if (change >= 0) gains += change;
    else losses += Math.abs(change);
  }

  const avgGain = gains / period;
  const avgLoss = losses / period;
  const rs = avgGain > 0 ? avgGain / avgLoss : 0;
  const rsi = 100 - 100 / (1 + rs);

  return rsi;
}

/**
 * تحليل إشارات المشهد
 * لكل إطار زمني: هل يطابق شروط الدخول؟
 */
export function analyzeTimeframeSignal(
  priceHistory: number[],
  strategy: MultiTimeframeStrategy
): boolean {
  if (priceHistory.length < 40) return false; // Not enough data

  const { stochRsi_J, stochRsi_K, stochRsi_D, williams_R } = {
    ...calculateStochasticRSI(priceHistory),
    williams_R: calculateWilliamsR(priceHistory),
  };

  const entry = strategy.entryConditions;

  // Check all entry conditions
  const jCondition = stochRsi_J < entry.stochRsi_J_max; // J < 10
  const kCondition = stochRsi_K < entry.stochRsi_K_max && stochRsi_K < stochRsi_D; // K < 30 AND K < D
  const wrCondition = williams_R > entry.williams_R_min; // WR > 80 (معكوس)

  return jCondition && kCondition && wrCondition;
}

/**
 * إدارة موضع التداول الواحد
 */
export interface TradePosition {
  id: string;
  token: string;
  entryPrice: number;
  entryTime: number;
  buyAmount: number; // بـ SOL
  inPosition: boolean;
  lastSellPrice?: number;
  status: 'waiting' | 'active' | 'closed';
  matchingTimeframes: number;
}

/**
 * دالة رئيسية: تشغيل الاستراتيجية متعددة الأطر الزمنية
 */
export async function runMultiTimeframeStrategy(
  userId: string,
  token: string,
  walletBalance: number,
  priceHistoryByTimeframe: Record<string, number[]>, // { "5m": [...], "15m": [...], ... }
  strategy: MultiTimeframeStrategy = {
    timeframes: ['5m', '15m', '4h', '8h'],
    capitalPercent: 0.1,
    minMatchingTimeframes: 3,
    takeProfitRange: { min: 0.01, max: 0.03 },
    reinvestLoss: -0.03,
    entryConditions: {
      stochRsi_J_max: 10,
      stochRsi_K_max: 30,
      williams_R_min: 80,
    },
  }
): Promise<{
  action: 'BUY' | 'SELL' | 'WAIT' | 'REINVEST';
  price: number;
  amount: number;
  reason: string;
  matchCount: number;
}> {
  const capital = walletBalance * strategy.capitalPercent;
  const currentPrice = priceHistoryByTimeframe[strategy.timeframes[0]][
    priceHistoryByTimeframe[strategy.timeframes[0]].length - 1
  ];

  // Count matching timeframes
  let matches = 0;
  const matchedTfs: string[] = [];

  for (const tf of strategy.timeframes) {
    const prices = priceHistoryByTimeframe[tf];
    if (!prices || prices.length < 40) continue;

    if (analyzeTimeframeSignal(prices, strategy)) {
      matches++;
      matchedTfs.push(tf);
    }
  }

  // Load user's current position
  const sentTokensDir = path.join(process.cwd(), 'sent_tokens');
  const positionFile = path.join(sentTokensDir, `${userId}_position_${token}.json`);
  let position: TradePosition | null = null;

  try {
    if (fs.existsSync(positionFile)) {
      position = JSON.parse(fs.readFileSync(positionFile, 'utf8'));
    }
  } catch (e) {
    position = null;
  }

  // Decision logic
  if (!position || !position.inPosition) {
    // NOT IN POSITION
    if (matches >= strategy.minMatchingTimeframes) {
      // ENTRY SIGNAL
      const newPosition: TradePosition = {
        id: `${userId}_${token}_${Date.now()}`,
        token,
        entryPrice: currentPrice,
        entryTime: Date.now(),
        buyAmount: capital,
        inPosition: true,
        status: 'active',
        matchingTimeframes: matches,
      };

      try {
        const ENABLE_ARCHIVE = String(process.env.ENABLE_ARCHIVE || '').toLowerCase() === 'true';
        if (ENABLE_ARCHIVE) {
          fs.writeFileSync(positionFile, JSON.stringify(newPosition, null, 2));
        }
      } catch (e) {}

      return {
        action: 'BUY',
        price: currentPrice,
        amount: capital,
        reason: `${matches}/${strategy.timeframes.length} timeframes matched entry conditions: ${matchedTfs.join(', ')}`,
        matchCount: matches,
      };
    }

    return {
      action: 'WAIT',
      price: currentPrice,
      amount: 0,
      reason: `Only ${matches}/${strategy.timeframes.length} timeframes match conditions (need ${strategy.minMatchingTimeframes})`,
      matchCount: matches,
    };
  }

  // IN POSITION - Check exit conditions
  const priceChange = (currentPrice - position.entryPrice) / position.entryPrice;

  // Take Profit: +1% to +3%
  if (priceChange >= strategy.takeProfitRange.min && priceChange <= strategy.takeProfitRange.max) {
    try {
      fs.unlinkSync(positionFile);
    } catch (e) {}

    return {
      action: 'SELL',
      price: currentPrice,
      amount: position.buyAmount,
      reason: `Take Profit at +${(priceChange * 100).toFixed(2)}%`,
      matchCount: matches,
    };
  }

  // Re-entry after loss: -3% from last sell price
  if (position.lastSellPrice && currentPrice <= position.lastSellPrice * (1 + strategy.reinvestLoss)) {
    const reinvestPosition: TradePosition = {
      ...position,
      entryPrice: currentPrice,
      entryTime: Date.now(),
      lastSellPrice: undefined,
    };

    try {
      const ENABLE_ARCHIVE = String(process.env.ENABLE_ARCHIVE || '').toLowerCase() === 'true';
      if (ENABLE_ARCHIVE) {
        fs.writeFileSync(positionFile, JSON.stringify(reinvestPosition, null, 2));
      }
    } catch (e) {}

    return {
      action: 'REINVEST',
      price: currentPrice,
      amount: position.buyAmount,
      reason: `Re-entry at -${Math.abs(strategy.reinvestLoss * 100).toFixed(1)}% from last sell`,
      matchCount: matches,
    };
  }

  // Still waiting
  return {
    action: 'WAIT',
    price: currentPrice,
    amount: 0,
    reason: `Position active: +${(priceChange * 100).toFixed(2)}% (TP: ${(strategy.takeProfitRange.min * 100).toFixed(1)}-${(strategy.takeProfitRange.max * 100).toFixed(1)}%)`,
    matchCount: matches,
  };
}

// ========================================
// PERSISTENT PRICE MONITORING & PENDING ORDERS
// نظام مراقبة الأسعار والأوامر المعلقة الدائم
// ========================================

/**
 * نوع الأمر المعلق
 */
export interface PendingOrder {
  id: string;
  userId: string;
  token: string;
  type: 'buy' | 'sell' | 'stoploss'; // نوع الأمر
  triggerPrice: number; // السعر الذي ينشط الأمر
  amount: number; // الكمية
  createdAt: number;
  status: 'pending' | 'triggered' | 'executed' | 'cancelled';
  executedPrice?: number;
  executedAt?: number;
  reason?: string;
}

/**
 * حفظ أوامر معلقة لمستخدم
 */
export function savePendingOrders(userId: string, orders: PendingOrder[]) {
  try {
    const sentTokensDir = path.join(process.cwd(), 'sent_tokens');
    const ordersFile = path.join(sentTokensDir, `${userId}_pending_orders.json`);
    
    const ENABLE_ARCHIVE = String(process.env.ENABLE_ARCHIVE || '').toLowerCase() === 'true';
    if (ENABLE_ARCHIVE) {
      fs.writeFileSync(ordersFile, JSON.stringify(orders, null, 2));
    }
  } catch (e) {
    console.error('[savePendingOrders] Error:', e);
  }
}

/**
 * تحميل الأوامر المعلقة لمستخدم
 */
export function loadPendingOrders(userId: string): PendingOrder[] {
  try {
    const sentTokensDir = path.join(process.cwd(), 'sent_tokens');
    const ordersFile = path.join(sentTokensDir, `${userId}_pending_orders.json`);
    
    if (fs.existsSync(ordersFile)) {
      const orders = JSON.parse(fs.readFileSync(ordersFile, 'utf8'));
      return Array.isArray(orders) ? orders : [];
    }
  } catch (e) {
    console.error('[loadPendingOrders] Error:', e);
  }
  return [];
}

/**
 * إنشاء أوامر معلقة بناءً على الاستراتيجية
 */
export function createPendingOrdersFromStrategy(
  userId: string,
  token: string,
  decision: any,
  strategy: MultiTimeframeStrategy
): PendingOrder[] {
  const orders: PendingOrder[] = [];
  
  if (decision.action === 'BUY') {
    // عند الشراء: ضع أوامر بيع معلقة
    
    // أمر Take Profit (البيع عند الربح)
    const tpPrice1 = decision.price * (1 + strategy.takeProfitRange.min);
    const tpPrice2 = decision.price * (1 + strategy.takeProfitRange.max);
    
    orders.push({
      id: `${userId}_${token}_tp1_${Date.now()}`,
      userId,
      token,
      type: 'sell',
      triggerPrice: tpPrice1,
      amount: decision.amount * 0.5, // 50% عند الربح الأول
      createdAt: Date.now(),
      status: 'pending',
      reason: `Take Profit 1: +${(strategy.takeProfitRange.min * 100).toFixed(1)}%`,
    });
    
    orders.push({
      id: `${userId}_${token}_tp2_${Date.now()}`,
      userId,
      token,
      type: 'sell',
      triggerPrice: tpPrice2,
      amount: decision.amount * 0.5, // 50% عند الربح الثاني
      createdAt: Date.now(),
      status: 'pending',
      reason: `Take Profit 2: +${(strategy.takeProfitRange.max * 100).toFixed(1)}%`,
    });
    
    // أمر Stop Loss (حماية من الخسارة)
    const slPrice = decision.price * 0.97; // -3% للحماية
    orders.push({
      id: `${userId}_${token}_sl_${Date.now()}`,
      userId,
      token,
      type: 'stoploss',
      triggerPrice: slPrice,
      amount: decision.amount,
      createdAt: Date.now(),
      status: 'pending',
      reason: 'Stop Loss: -3%',
    });
  }
  
  return orders;
}

/**
 * فحص الأوامر المعلقة وتنفيذها
 */
export async function checkAndExecutePendingOrders(
  userId: string,
  currentPrices: Record<string, number>, // { token: currentPrice }
  executeCallback?: (order: PendingOrder, currentPrice: number) => Promise<boolean>
): Promise<PendingOrder[]> {
  const orders = loadPendingOrders(userId);
  const executed: PendingOrder[] = [];
  
  for (const order of orders) {
    if (order.status !== 'pending') continue;
    
    const currentPrice = currentPrices[order.token];
    if (!currentPrice) continue;
    
    let shouldExecute = false;
    
    // تحقق من شروط التنفيذ
    if (order.type === 'buy') {
      // أمر شراء: يتم التنفيذ عند السعر أو أقل
      shouldExecute = currentPrice <= order.triggerPrice;
    } else if (order.type === 'sell' || order.type === 'stoploss') {
      // أمر بيع: يتم التنفيذ عند السعر أو أعلى
      shouldExecute = currentPrice >= order.triggerPrice;
    }
    
    if (shouldExecute) {
      // حاول تنفيذ الأمر
      let executed_ok = false;
      
      if (executeCallback) {
        try {
          const lockId = order.userId || userId;
          executed_ok = await userLocks.runExclusive(lockId, async () => {
            return await executeCallback(order, currentPrice);
          }, admn.VALIDATION_RULES.COMMAND_TIMEOUT_MS || 30000);
        } catch (e) {
          console.error('[checkAndExecutePendingOrders] Callback error:', e);
          executed_ok = false;
        }
      } else {
        // بدون callback، افترض النجاح
        executed_ok = true;
      }
      
      if (executed_ok) {
        order.status = 'executed';
        order.executedPrice = currentPrice;
        order.executedAt = Date.now();
        executed.push(order);
        
        recordUserTrade(userId, {
          mode: order.type === 'buy' ? 'buy' : 'sell',
          token: order.token,
          amount: order.amount,
          price: currentPrice,
          status: 'success',
          orderId: order.id,
          trigger: order.reason,
        });
      }
    }
  }
  
  // احفظ الأوامر المحدثة
  savePendingOrders(userId, orders);
  
  return executed;
}

/**
 * نظام مراقبة الأسعار الدائم
 * يراقب الأسعار ويشغل الأوامر تلقائياً
 */
export async function startPriceMonitor(
  userId: string,
  users: Record<string, any>,
  options: {
    checkIntervalMs?: number; // كل كم ms نفحص الأسعار
    priceSource?: 'dex' | 'cex' | 'both'; // مصدر الأسعار
    autoCreateOrders?: boolean; // إنشاء أوامر معلقة تلقائياً
  } = {}
): Promise<() => void> { // إرجاع دالة إيقاف المراقب
  const {
    checkIntervalMs = 5000, // افتراضي: كل 5 ثوان
    priceSource = 'both',
    autoCreateOrders = true,
  } = options;
  
  let stopped = false;
  let monitorInterval: NodeJS.Timeout | null = null;
  
  const stop = () => {
    stopped = true;
    if (monitorInterval) clearInterval(monitorInterval);
    console.log(`[Monitor ${userId}] Stopped`);
  };
  
  const monitor = async () => {
    if (stopped) return;

    try {
      await userLocks.runExclusive(userId, async () => {
        const user = users[userId];
        if (!user || user.strategy?.enabled === false) return;

        // 1. جمع الأسعار الحالية
        const currentPrices: Record<string, number> = {};

        // من الملفات المحفوظة (محاكاة)
        try {
          const sentTokensDir = path.join(process.cwd(), 'sent_tokens');
          const pricesFile = path.join(sentTokensDir, `${userId}_current_prices.json`);

          if (fs.existsSync(pricesFile)) {
            const cached = JSON.parse(fs.readFileSync(pricesFile, 'utf8'));
            Object.assign(currentPrices, cached);
          }
        } catch (e) {}

        // 2. فحص الأوامر المعلقة
        const executed = await checkAndExecutePendingOrders(
          userId,
          currentPrices,
          async (order: PendingOrder, price: number) => {
            // تنفيذ عام (يمكن استبداله بمنطق فعلي للتنفيذ)
            console.log(
              `[Monitor ${userId}] Executing ${order.type.toUpperCase()} ` +
                `${order.token} at ${price} SOL/USDT`
            );
            return true; // نجاح التنفيذ
          }
        );

        // 3. إنشاء أوامر جديدة إذا لزم الأمر
        if (autoCreateOrders) {
          const honeSettings = getHoneySettings(userId, users);

          for (const token of honeSettings.tokens) {
            if (token.status === 'active' && token.lastEntryPrice) {
              // في كل جولة التحقق: أنشئ أوامر معلقة بناءً على السعر الحالي
              const currentPrice = currentPrices[token.address] || token.lastEntryPrice;

              // إذا لم تكن هناك أوامر معلقة، أنشئها
              const existingOrders = loadPendingOrders(userId).filter(
                (o) => o.token === token.address && o.status === 'pending'
              );

              if (existingOrders.length === 0 && token.lastEntryPrice) {
                const newOrders = createPendingOrdersFromStrategy(
                  userId,
                  token.address,
                  {
                    action: 'BUY',
                    price: token.lastEntryPrice,
                    amount: user.strategy?.buyAmount || 0.1,
                  },
                  {
                    timeframes: user.strategy?.timeframes || ['5m', '15m', '4h', '8h'],
                    capitalPercent: user.strategy?.capitalPercent || 0.1,
                    minMatchingTimeframes: user.strategy?.minMatchingTimeframes || 3,
                    takeProfitRange: user.strategy?.takeProfitRange || { min: 0.01, max: 0.03 },
                    reinvestLoss: user.strategy?.reinvestLoss || -0.03,
                    entryConditions: {
                      stochRsi_J_max: 10,
                      stochRsi_K_max: 30,
                      williams_R_min: 80,
                    },
                  }
                );

                const allOrders = [...existingOrders, ...newOrders];
                savePendingOrders(userId, allOrders);
              }
            }
          }
        }
      }, admn.VALIDATION_RULES.COMMAND_TIMEOUT_MS || 30000);
    } catch (error) {
      console.error(`[Monitor ${userId}] Error:`, error);
    }
  };
  
  // ابدأ المراقبة الدورية
  monitorInterval = setInterval(monitor, checkIntervalMs);
  console.log(`[Monitor ${userId}] Started (interval: ${checkIntervalMs}ms)`);
  
  // جلسة أولى فوراً
  await monitor();
  
  // إرجاع دالة الإيقاف
  return stop;
}

/**
 * نظام مراقبة شامل لعدة مستخدمين
 */
export async function startGlobalPriceMonitor(
  users: Record<string, any>,
  options: {
    checkIntervalMs?: number;
    maxConcurrentMonitors?: number;
  } = {}
): Promise<() => void> {
  const {
    checkIntervalMs = 5000,
    maxConcurrentMonitors = 10,
  } = options;
  
  const monitors: Map<string, () => void> = new Map();
  let stopped = false;
  
  const stop = async () => {
    stopped = true;
    
    // أوقف كل المراقبات
    for (const [userId, stopFn] of monitors) {
      try {
        stopFn();
        monitors.delete(userId);
      } catch (e) {}
    }
    
    console.log('[GlobalMonitor] Stopped');
  };
  
  const manageMonitors = async () => {
    if (stopped) return;
    
    try {
      // احصل على المستخدمين النشطين
      const activeUsers = Object.keys(users).filter(uid => {
        const user = users[uid];
        return user && user.strategy && user.strategy.enabled !== false;
      });
      
      // أضف مراقبات للمستخدمين الجدد
      for (const userId of activeUsers) {
        if (!monitors.has(userId)) {
          if (monitors.size >= maxConcurrentMonitors) break; // لا تتجاوز الحد الأقصى
          
          try {
            const stopFn = await startPriceMonitor(userId, users, { checkIntervalMs });
            monitors.set(userId, stopFn);
            console.log(`[GlobalMonitor] Added monitor for user: ${userId}`);
          } catch (e) {
            console.error(`[GlobalMonitor] Failed to add monitor for ${userId}:`, e);
          }
        }
      }
      
      // أزل مراقبات المستخدمين غير النشطين
      for (const [userId, stopFn] of monitors) {
        const user = users[userId];
        if (!user || user.strategy?.enabled === false) {
          try {
            stopFn();
            monitors.delete(userId);
            console.log(`[GlobalMonitor] Removed monitor for user: ${userId}`);
          } catch (e) {}
        }
      }
      
    } catch (error) {
      console.error('[GlobalMonitor] Error:', error);
    }
  };
  
  // تحديث قائمة المراقبات كل 30 ثانية
  const manageInterval = setInterval(manageMonitors, 30000);
  
  // جلسة أولية فوراً
  await manageMonitors();
  
  return async () => {
    clearInterval(manageInterval);
    await stop();
  };
}