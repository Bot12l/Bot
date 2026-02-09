#!/usr/bin/env node
/**
 * المراقب الدائم والمستمر للأسعار والأوامر المعلقة
 * Persistent Price Monitor & Order Manager
 * 
 * يقوم بـ:
 * 1. مراقبة الأسعار من DEX و CEX بشكل دائم
 * 2. إنشاء وإدارة الأوامر المعلقة (Pending Orders)
 * 3. تنفيذ الأوامر تلقائياً عند تحقق الشروط
 * 4. حماية المراكز بـ Stop Loss و Take Profit
 */

require('dotenv').config();
const fs = require('fs');
const path = require('path');

// ========================================
// CONFIGURATION
// ========================================

const CONFIG = {
  // مسار ملفات البيانات
  DATA_DIR: path.join(process.cwd(), 'sent_tokens'),
  USERS_FILE: path.join(process.cwd(), 'users.json'),
  
  // فترات المراقبة
  DEX_CHECK_INTERVAL_MS: Number(process.env.DEX_CHECK_INTERVAL_MS || 5000), // 5 ثوانٍ
  CEX_CHECK_INTERVAL_MS: Number(process.env.CEX_CHECK_INTERVAL_MS || 10000), // 10 ثوانٍ
  ORDER_CHECK_INTERVAL_MS: Number(process.env.ORDER_CHECK_INTERVAL_MS || 3000), // 3 ثوانٍ
  
  // حدود المراقبة
  MAX_CONCURRENT_MONITORS: Number(process.env.MAX_CONCURRENT_MONITORS || 10),
  MAX_ORDERS_PER_USER: Number(process.env.MAX_ORDERS_PER_USER || 50),
  
  // التفعيل
  ENABLE_DEX_MONITOR: process.env.ENABLE_DEX_MONITOR !== 'false',
  ENABLE_CEX_MONITOR: process.env.ENABLE_CEX_MONITOR !== 'false',
  ENABLE_AUTO_EXECUTION: process.env.ENABLE_AUTO_EXECUTION === 'true',
  
  // الأرشفة
  ENABLE_ARCHIVE: process.env.ENABLE_ARCHIVE === 'true',
};

// ========================================
// UTILITIES
// ========================================

function log(tag: string, message: string) {
  const timestamp = new Date().toISOString();
  console.log(`[${timestamp}] [${tag}] ${message}`);
}

function loadUsers(): Record<string, any> {
  try {
    if (fs.existsSync(CONFIG.USERS_FILE)) {
      return JSON.parse(fs.readFileSync(CONFIG.USERS_FILE, 'utf8')) || {};
    }
  } catch (e) {
    log('WARN', `Failed to load users.json: ${e}`);
  }
  return {};
}

function ensureDataDir() {
  try {
    if (!fs.existsSync(CONFIG.DATA_DIR)) {
      fs.mkdirSync(CONFIG.DATA_DIR, { recursive: true });
    }
  } catch (e) {
    log('ERROR', `Failed to create data directory: ${e}`);
  }
}

// ========================================
// PRICE MONITORING SYSTEM
// ========================================

class PriceMonitoringSystem {
  private monitors: Map<string, { stop: () => void; active: boolean }> = new Map();
  private stopped = false;

  constructor(private config: typeof CONFIG) {
    ensureDataDir();
  }

  async start() {
    log('MONITOR', 'Starting persistent price monitoring system...');

    // مراقب الفحص الرئيسي
    setInterval(() => this.updateAndCheckPrices(), this.config.ORDER_CHECK_INTERVAL_MS);

    // مراقب إدارة المراقبات
    setInterval(() => this.manageMonitors(), 30000);

    // جلسة أولية فوراً
    await this.updateAndCheckPrices();
    this.manageMonitors();

    log('MONITOR', '✅ Monitoring system started successfully');
  }

  private async updateAndCheckPrices() {
    if (this.stopped) return;

    try {
      const users = loadUsers();
      const timestamp = Date.now();

      for (const [userId, user] of Object.entries(users)) {
        if (!user || !user.strategy || user.strategy.enabled === false) continue;

        try {
          // تحديث الأسعار
          const prices = this.getCurrentPrices(userId);

          // فحص الأوامر المعلقة
          await this.checkPendingOrders(userId, prices);

          // إنشاء أوامر جديدة إذا لزم الأمر
          await this.createNewOrders(userId, user, prices);

        } catch (e) {
          log('ERROR', `Error processing user ${userId}: ${e}`);
        }
      }

      // سجل حالة النظام كل دقيقة
      if (timestamp % 60000 < this.config.ORDER_CHECK_INTERVAL_MS) {
        this.logSystemStatus();
      }

    } catch (e) {
      log('ERROR', `Update cycle error: ${e}`);
    }
  }

  private getCurrentPrices(userId: string): Record<string, number> {
    try {
      // DEX prices
      let prices: Record<string, number> = {};

      const dexPricesFile = path.join(CONFIG.DATA_DIR, `${userId}_current_prices.json`);
      if (fs.existsSync(dexPricesFile)) {
        try {
          const dexPrices = JSON.parse(fs.readFileSync(dexPricesFile, 'utf8'));
          Object.assign(prices, dexPrices);
        } catch (e) {}
      }

      // CEX prices
      const cexPricesFile = path.join(CONFIG.DATA_DIR, `${userId}_cex_prices.json`);
      if (fs.existsSync(cexPricesFile)) {
        try {
          const cexPrices = JSON.parse(fs.readFileSync(cexPricesFile, 'utf8'));
          Object.assign(prices, cexPrices);
        } catch (e) {}
      }

      return prices;
    } catch (e) {
      return {};
    }
  }

  private async checkPendingOrders(userId: string, prices: Record<string, number>) {
    try {
      const ordersFile = path.join(CONFIG.DATA_DIR, `${userId}_pending_orders.json`);

      if (!fs.existsSync(ordersFile)) return;

      let orders: any[] = JSON.parse(fs.readFileSync(ordersFile, 'utf8'));
      let updated = false;

      for (const order of orders) {
        if (order.status !== 'pending') continue;

        const currentPrice = prices[order.token];
        if (!currentPrice) continue;

        let shouldExecute = false;

        // فحص شروط التنفيذ
        if (order.type === 'buy') {
          shouldExecute = currentPrice <= order.triggerPrice;
        } else if (order.type === 'sell' || order.type === 'stoploss') {
          shouldExecute = currentPrice >= order.triggerPrice;
        }

        if (shouldExecute) {
          // تنفيذ الأمر
          if (this.config.ENABLE_AUTO_EXECUTION) {
            order.status = 'executed';
            order.executedPrice = currentPrice;
            order.executedAt = Date.now();
            updated = true;

            log('EXECUTION', 
              `${order.type.toUpperCase()} ${order.token} @ ${currentPrice} ` +
              `(trigger: ${order.triggerPrice}) for user ${userId}`
            );

            // سجل الصفقة
            this.recordTrade(userId, {
              mode: order.type === 'buy' ? 'buy' : 'sell',
              token: order.token,
              amount: order.amount,
              price: currentPrice,
              orderId: order.id,
              reason: order.reason,
            });
          } else {
            order.status = 'triggered';
            order.triggeredPrice = currentPrice;
            order.triggeredAt = Date.now();
            updated = true;

            log('ALERT', 
              `Order triggered but not executed (ENABLE_AUTO_EXECUTION=false): ` +
              `${order.type} ${order.token} @ ${currentPrice}`
            );
          }
        }
      }

      // احفظ الأوامر المحدثة
      if (updated && this.config.ENABLE_ARCHIVE) {
        fs.writeFileSync(ordersFile, JSON.stringify(orders, null, 2));
      }
    } catch (e) {
      log('ERROR', `Error checking pending orders for ${userId}: ${e}`);
    }
  }

  private async createNewOrders(userId: string, user: any, prices: Record<string, number>) {
    try {
      const honeSettings = user.honeySettings;
      if (!Array.isArray(honeSettings?.tokens)) return;

      const ordersFile = path.join(CONFIG.DATA_DIR, `${userId}_pending_orders.json`);
      let orders: any[] = [];

      try {
        if (fs.existsSync(ordersFile)) {
          orders = JSON.parse(fs.readFileSync(ordersFile, 'utf8'));
        }
      } catch (e) {}

      // تحقق من كل رمز / عملة
      for (const token of honeSettings.tokens) {
        if (token.status !== 'active' || !token.lastEntryPrice) continue;

        // تحقق من وجود أوامر معلقة بالفعل
        const existingOrders = orders.filter(
          o => o.token === token.address && o.status === 'pending'
        );

        // إذا لم تكن هناك أوامر معلقة، أنشئ أوامر جديدة
        if (existingOrders.length === 0) {
          const entryPrice = token.lastEntryPrice;
          const now = Date.now();

          // أمر Take Profit الأول (+1%)
          orders.push({
            id: `${userId}_${token.address}_tp1_${now}`,
            userId,
            token: token.address,
            type: 'sell',
            triggerPrice: entryPrice * 1.01,
            amount: (user.strategy?.buyAmount || 0.1) * 0.5,
            createdAt: now,
            status: 'pending',
            reason: 'Take Profit 1: +1%',
          });

          // أمر Take Profit الثاني (+3%)
          orders.push({
            id: `${userId}_${token.address}_tp2_${now}`,
            userId,
            token: token.address,
            type: 'sell',
            triggerPrice: entryPrice * 1.03,
            amount: (user.strategy?.buyAmount || 0.1) * 0.5,
            createdAt: now,
            status: 'pending',
            reason: 'Take Profit 2: +3%',
          });

          // أمر Stop Loss (-3%)
          orders.push({
            id: `${userId}_${token.address}_sl_${now}`,
            userId,
            token: token.address,
            type: 'stoploss',
            triggerPrice: entryPrice * 0.97,
            amount: user.strategy?.buyAmount || 0.1,
            createdAt: now,
            status: 'pending',
            reason: 'Stop Loss: -3%',
          });

          log('CREATE_ORDERS', 
            `Created 3 orders for ${token.address} ` +
            `(entry: ${entryPrice}, TP: ${(entryPrice * 1.01).toFixed(6)}-${(entryPrice * 1.03).toFixed(6)}, ` +
            `SL: ${(entryPrice * 0.97).toFixed(6)})`
          );
        }
      }

      // احفظ الأوامر
      if (orders.length > 0 && this.config.ENABLE_ARCHIVE) {
        // قيّد الحد الأقصى للأوامر
        if (orders.length > this.config.MAX_ORDERS_PER_USER) {
          orders = orders.slice(-this.config.MAX_ORDERS_PER_USER);
        }

        fs.writeFileSync(ordersFile, JSON.stringify(orders, null, 2));
      }
    } catch (e) {
      log('ERROR', `Error creating orders for ${userId}: ${e}`);
    }
  }

  private recordTrade(userId: string, trade: any) {
    try {
      const tradeFile = path.join(CONFIG.DATA_DIR, `${userId}.json`);
      let trades: any[] = [];

      try {
        if (fs.existsSync(tradeFile)) {
          trades = JSON.parse(fs.readFileSync(tradeFile, 'utf8'));
        }
      } catch (e) {}

      trades.push({
        ...trade,
        timestamp: Date.now(),
      });

      if (this.config.ENABLE_ARCHIVE) {
        fs.writeFileSync(tradeFile, JSON.stringify(trades.slice(-500), null, 2));
      }
    } catch (e) {
      log('ERROR', `Error recording trade: ${e}`);
    }
  }

  private manageMonitors() {
    const users = loadUsers();
    const userIds = Object.keys(users).filter(
      uid => users[uid] && users[uid].strategy && users[uid].strategy.enabled !== false
    );

    // تقرير الحالة
    log('STATUS', 
      `Active users: ${userIds.length}/${Object.keys(users).length}, ` +
      `Active monitors: ${this.monitors.size}/${this.config.MAX_CONCURRENT_MONITORS}`
    );
  }

  private logSystemStatus() {
    try {
      const users = loadUsers();
      let totalPendingOrders = 0;
      let totalExecutedToday = 0;

      for (const userId of Object.keys(users)) {
        // عد الأوامر المعلقة
        const ordersFile = path.join(CONFIG.DATA_DIR, `${userId}_pending_orders.json`);
        if (fs.existsSync(ordersFile)) {
          try {
            const orders = JSON.parse(fs.readFileSync(ordersFile, 'utf8'));
            totalPendingOrders += orders.filter((o: any) => o.status === 'pending').length;
            totalExecutedToday += orders.filter((o: any) => o.status === 'executed').length;
          } catch (e) {}
        }
      }

      log('STATS', 
        `Pending orders: ${totalPendingOrders}, ` +
        `Executed today: ${totalExecutedToday}`
      );
    } catch (e) {}
  }

  async stop() {
    this.stopped = true;
    log('MONITOR', 'Stopping monitoring system...');
  }
}

// ========================================
// MAIN
// ========================================

async function main() {
  log('INIT', 'Starting persistent monitoring system...');

  const monitor = new PriceMonitoringSystem(CONFIG);
  await monitor.start();

  // معالج الخروج الآمن
  process.on('SIGINT', async () => {
    log('SHUTDOWN', 'Received SIGINT, shutting down gracefully...');
    await monitor.stop();
    process.exit(0);
  });

  process.on('SIGTERM', async () => {
    log('SHUTDOWN', 'Received SIGTERM, shutting down gracefully...');
    await monitor.stop();
    process.exit(0);
  });
}

// شغل النظام
if (require.main === module) {
  main().catch((e) => {
    log('FATAL', `Fatal error: ${e}`);
    process.exit(1);
  });
}

module.exports = { PriceMonitoringSystem };
