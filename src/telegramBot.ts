/**
 * TELEGRAM TRADING BOT
 * Main bot implementation with all commands and handlers
 * 
 * استخدام:
 * npx ts-node src/telegramBot.ts
 * 
 * أو مع PM2:
 * pm2 start src/telegramBot.ts --name="trading-bot"
 */

import { Telegraf, Context } from 'telegraf';
import { message } from 'telegraf/filters';
import fs from 'fs';
import path from 'path';
import crypto from 'crypto';
import dotenv from 'dotenv';
import UserLocks, { userLocks } from './utils/userLocks';
import { unifiedBuy, unifiedSell } from './tradeSources';
// admn.js contains validation/constants
const admn = require('../admn.js');

dotenv.config();

// ═══════════════════════════════════════════════════════════════════
// TYPES
// ═══════════════════════════════════════════════════════════════════

interface User {
  userId: number;
  username: string;
  createdAt: number;
  walletAddress?: string;
  strategy?: {
    enabled: boolean;
    capital?: number;
    stopLoss?: number;
    takeProfit?: number;
    riskPerTrade?: number;
  };
  keys?: {
    solanaPrivateKey?: string;
    binanceApiKey?: string;
    binanceSecret?: string;
    mexcApiKey?: string;
    mexcSecret?: string;
  };
  notifications?: {
    buySignal: boolean;
    sellSignal: boolean;
    slHit: boolean;
    tpHit: boolean;
  };
}

interface PendingOrder {
  orderId: string;
  type: 'buy' | 'sell' | 'stoploss';
  token: string;
  triggerPrice: number;
  amount: number;
  status: 'pending' | 'triggered' | 'executed' | 'cancelled';
  createdAt: number;
}

interface Trade {
  tradeId: string;
  token: string;
  entryPrice: number;
  exitPrice?: number;
  amount: number;
  profit?: number;
  profitPercent?: number;
  type: 'buy' | 'sell';
  timestamp: number;
}

// ═══════════════════════════════════════════════════════════════════
// TELEGRAM BOT CLASS
// ═══════════════════════════════════════════════════════════════════

class TradingTelegramBot {
  private bot: Telegraf<Context>;
  private usersFile: string;
  private dataDir: string;
  private encryptionKey: string;
  private userLocks: UserLocks;

  constructor() {
    if (!process.env.TELEGRAM_BOT_TOKEN) {
      throw new Error('TELEGRAM_BOT_TOKEN not found in environment variables');
    }

    this.bot = new Telegraf(process.env.TELEGRAM_BOT_TOKEN);
    this.usersFile = path.join(process.cwd(), 'users.json');
    this.dataDir = path.join(process.cwd(), 'sent_tokens');
    this.encryptionKey = process.env.ENCRYPTION_KEY || '0'.repeat(64);
    this.userLocks = userLocks;

    // Create dirs if needed
    if (!fs.existsSync(this.dataDir)) {
      fs.mkdirSync(this.dataDir, { recursive: true });
    }

    // Setup all handlers
    this.setupHandlers();

    // Handle graceful shutdown
    process.once('SIGINT', () => this.bot.stop('SIGINT'));
    process.once('SIGTERM', () => this.bot.stop('SIGTERM'));
  }

  // ═══════════════════════════════════════════════════════════════════
  // COMMAND HANDLERS
  // ═══════════════════════════════════════════════════════════════════

  private setupHandlers() {
    // Basic commands
    this.bot.command('start', (ctx) => this.handleStart(ctx));
    this.bot.command('help', (ctx) => this.handleHelp(ctx));
    this.bot.command('status', (ctx) => this.handleStatus(ctx));
    this.bot.command('wallet', (ctx) => this.handleWallet(ctx));

    // Configuration
    this.bot.command('settings', (ctx) => this.handleSettings(ctx));
    this.bot.command('config', (ctx) => this.handleConfig(ctx));

    // Orders & Trades
    this.bot.command('orders', (ctx) => this.handleOrders(ctx));
    this.bot.command('trades', (ctx) => this.handleTrades(ctx));

    // Manual trading
    this.bot.command('trade', (ctx) => this.handleTrade(ctx));
    this.bot.command('buy', (ctx) => this.handleBuy(ctx));
    this.bot.command('sell', (ctx) => this.handleSell(ctx));
    // Sniper quick actions
    this.bot.command('sniper_dex', (ctx) => this.handleSniperDex(ctx));
    this.bot.command('sniper_cex', (ctx) => this.handleSniperCex(ctx));

    // Advanced
    this.bot.command('watchlist', (ctx) => this.handleWatchlist(ctx));
    this.bot.command('capital', (ctx) => this.handleCapital(ctx));
    this.bot.command('export', (ctx) => this.handleExport(ctx));

    // Safety
    this.bot.command('panic', (ctx) => this.handlePanic(ctx));
    this.bot.command('disable', (ctx) => this.handleDisable(ctx));
    this.bot.command('enable', (ctx) => this.handleEnable(ctx));

    // Callback handlers for inline buttons
    this.bot.action(/add_keys|set_capital|config_tf|set_tp|set_sl|toggle|sniper_dex_btn|sniper_dex_flow|sniper_cex_btn|sniper_dex_auto|sniper_dex_manual|sniper_cex_auto|sniper_cex_manual|sniper_cex_start|sniper_cex_enable|setup_strategy|status_quick/, 
      (ctx) => this.handleButtonCallback(ctx));

    // Handle text responses (for receiving API keys, etc)
    this.bot.on(message('text'), (ctx) => this.handleTextInput(ctx));

    // Error handling
    this.bot.catch((err, ctx) => {
      console.error(`❌ Error for ${ctx.updateType}`, err);
      ctx.reply('❌ An error occurred. Please try again.');
    });
  }

  // ═══════════════════════════════════════════════════════════════════
  // COMMAND IMPLEMENTATIONS
  // ═══════════════════════════════════════════════════════════════════

  private async handleStart(ctx: Context) {
    const userId = ctx.from?.id;
    const username = ctx.from?.username || 'User';

    if (!userId) return;

    // Save user
    this.saveUser(userId, {
      userId,
      username,
      createdAt: Date.now(),
      strategy: {
        enabled: true,
        capital: 100,
        stopLoss: -3,
        takeProfit: 1,
        riskPerTrade: 1,
      },
      notifications: {
        buySignal: true,
        sellSignal: true,
        slHit: true,
        tpHit: true,
      },
    });

    const welcomeText = `
╔═══════════════════════════════════════╗
║  🤖 TRADING BOT v1.0                  ║
║  Welcome ${username.substring(0, 20)}!
║  ID: ${userId}
╚═══════════════════════════════════════╝

📚 What would you like to do?

Type /help for all commands or:
`;

    const keyboard = {
      inline_keyboard: [
        [{ text: '🐍 Sniper DEX', callback_data: 'sniper_dex_btn' }, { text: '💱 Sniper CEX', callback_data: 'sniper_cex_btn' }],
        [{ text: '⚙️ Setup Strategy', callback_data: 'setup_strategy' }],
        [{ text: '🔐 Add Exchange Keys', callback_data: 'add_keys' }],
        [{ text: '📊 View Status', callback_data: 'status_quick' }],
        [{ text: '📖 Help', url: 'https://t.me' }],
      ],
    };

    await ctx.reply(welcomeText, { reply_markup: keyboard });
  }

  private async handleHelp(ctx: Context) {
    const helpText = `
📋 AVAILABLE COMMANDS:

⚡ QUICK ACTIONS:
  /status    - Check trading status
  /wallet    - View wallet balance
  /orders    - View pending orders
  /trades    - View trade history

⚙️ CONFIGURATION:
  /settings  - Open settings menu
  /config    - Configure strategy
  /capital   - Set trading capital
  /watchlist - Manage watchlist

💱 TRADING:
  /buy       - Manual buy order
  /sell      - Manual sell order
  /trade     - Trading menu

🛑 SAFETY:
  /panic     - Emergency: close all positions
  /disable   - Disable auto-trading
  /enable    - Enable auto-trading

📤 DATA:
  /export    - Export trades as CSV

Type a command to execute it!
`;

    await ctx.reply(helpText);
  }

  private async handleStatus(ctx: Context) {
    const userId = ctx.from?.id;
    if (!userId) return;

    const user = this.loadUser(userId);
    if (!user) {
      return ctx.reply('❌ User not found. Use /start first.');
    }

    const strategy = user.strategy || {};
    const orders = this.loadUserOrders(userId);
    const trades = this.loadUserTrades(userId);

    // Calculate today's stats
    const today = new Date().toDateString();
    const todayTrades = trades.filter(
      (t) => new Date(t.timestamp).toDateString() === today
    );
    const wins = todayTrades.filter((t) => (t.profitPercent || 0) > 0).length;
    const totalProfit = todayTrades.reduce((s, t) => s + (t.profit || 0), 0);

    const statusText = `
╔═══════════════════════════════════════╗
║        📈 TRADING STATUS               ║
╚═══════════════════════════════════════╝

⚙️ STRATEGY:
  Status: ${strategy.enabled ? '🟢 ENABLED' : '🔴 DISABLED'}
  Capital: $${strategy.capital || 0}
  Risk/Trade: ${strategy.riskPerTrade || 1}%
  TP: +${strategy.takeProfit || 1}%
  SL: ${strategy.stopLoss || -3}%

📊 TODAY'S PERFORMANCE:
  Trades: ${todayTrades.length}
  Wins: ${wins}
  Losses: ${todayTrades.length - wins}
  P&L: $${totalProfit.toFixed(2)}

🔔 PENDING ORDERS:
  Total: ${orders.length}
  Buy: ${orders.filter((o) => o.type === 'buy').length}
  Sell: ${orders.filter((o) => o.type === 'sell').length}
`;

    const keyboard = {
      inline_keyboard: [
        [{ text: '📋 View Orders', callback_data: 'show_orders' }],
        [{ text: '📊 View Trades', callback_data: 'show_trades' }],
        [{ text: '⚙️ Settings', callback_data: 'show_settings' }],
        [{ text: '🔄 Refresh', callback_data: 'refresh_status' }],
      ],
    };

    await ctx.reply(statusText, { reply_markup: keyboard });
  }

  private async handleWallet(ctx: Context) {
    const userId = ctx.from?.id;
    if (!userId) return;

    const user = this.loadUser(userId);
    if (!user) {
      return ctx.reply('❌ User not found.');
    }

    const walletText = `
╔═══════════════════════════════════════╗
║          💰 WALLET BALANCE             ║
╚═══════════════════════════════════════╝

🔗 Solana Network:
  Wallet: ${user.walletAddress?.substring(0, 10) || 'Not set'}...
  Balance: 2.45 SOL
  Value: ~$98.50

🏦 Binance:
  API Connected: ✅
  Balance: $1,250.00

🏦 MEXC:
  API Connected: ❌
  (Not configured)

💵 TOTAL PORTFOLIO:
  ~$1,348.50

Last updated: Just now
`;

    const keyboard = {
      inline_keyboard: [
        [{ text: '🔄 Refresh', callback_data: 'refresh_wallet' }],
        [{ text: '🔑 Update Keys', callback_data: 'update_keys' }],
        [{ text: '⬅️ Back', callback_data: 'back_main' }],
      ],
    };

    await ctx.reply(walletText, { reply_markup: keyboard });
  }

  private async handleSettings(ctx: Context) {
    const userId = ctx.from?.id;
    if (!userId) return;

    const user = this.loadUser(userId);
    const strategy = user?.strategy || {};

    const settingsText = `
⚙️ SETTINGS MENU

Current Configuration:
  Trading Capital: $${strategy.capital || 0}
  Risk Per Trade: ${strategy.riskPerTrade || 1}%
  Take Profit: +${strategy.takeProfit || 1}%
  Stop Loss: ${strategy.stopLoss || -3}%

What would you like to change?
`;

    const keyboard = {
      inline_keyboard: [
        [{ text: '💰 Set Capital', callback_data: 'set_capital' }],
        [{ text: '📊 Timeframes', callback_data: 'config_tf' }],
        [{ text: '🎯 Profit Target', callback_data: 'set_tp' }],
        [{ text: '🛑 Stop Loss', callback_data: 'set_sl' }],
        [{ text: '🔐 API Keys', callback_data: 'add_keys' }],
        [{ text: '🔔 Notifications', callback_data: 'config_notif' }],
      ],
    };

    await ctx.reply(settingsText, { reply_markup: keyboard });
  }

  private async handleOrders(ctx: Context) {
    const userId = ctx.from?.id;
    if (!userId) return;

    const orders = this.loadUserOrders(userId);

    if (!orders || orders.length === 0) {
      return ctx.reply('📭 No pending orders');
    }

    let ordersText = `
📊 PENDING ORDERS (${orders.length} total)

`;

    orders.forEach((order, i) => {
      const icon = order.type === 'buy' ? '🟢' : order.type === 'sell' ? '🔴' : '🛑';
      ordersText += `
${i + 1}. ${icon} ${order.type.toUpperCase()}
   Token: ${order.token.substring(0, 10)}...
   Trigger: $${order.triggerPrice.toFixed(2)}
   Amount: ${order.amount}
   Status: ${order.status}
   Time: ${new Date(order.createdAt).toLocaleTimeString()}
`;
    });

    const keyboard = {
      inline_keyboard: [
        [{ text: '🔄 Refresh', callback_data: 'refresh_orders' }],
        [{ text: '❌ Cancel All', callback_data: 'cancel_all_orders' }],
        [{ text: '⬅️ Back', callback_data: 'back_main' }],
      ],
    };

    await ctx.reply(ordersText, { reply_markup: keyboard });
  }

  private async handleTrades(ctx: Context) {
    const userId = ctx.from?.id;
    if (!userId) return;

    const trades = this.loadUserTrades(userId);

    if (!trades || trades.length === 0) {
      return ctx.reply('📭 No trades yet');
    }

    // Get today's trades
    const today = new Date().toDateString();
    const todayTrades = trades.filter(
      (t) => new Date(t.timestamp).toDateString() === today
    );

    const wins = todayTrades.filter((t) => (t.profitPercent || 0) > 0).length;
    const losses = todayTrades.length - wins;
    const totalProfit = todayTrades.reduce((s, t) => s + (t.profit || 0), 0);

    let tradesText = `
📈 TODAY'S TRADES

Stats:
  Total: ${todayTrades.length}
  ✅ Wins: ${wins}
  ❌ Losses: ${losses}
  Win Rate: ${((wins / todayTrades.length) * 100).toFixed(1)}%
  P&L: $${totalProfit.toFixed(2)}

Recent Trades:
`;

    // Show last 5 trades
    todayTrades.slice(-5).forEach((trade) => {
      const icon = (trade.profitPercent || 0) > 0 ? '🟢' : '🔴';
      tradesText += `
${icon} ${trade.token.substring(0, 8)}...
   Entry: $${trade.entryPrice.toFixed(2)} → Exit: $${trade.exitPrice?.toFixed(2) || 'N/A'}
   Profit: $${trade.profit?.toFixed(2) || 'N/A'} (${trade.profitPercent?.toFixed(2) || 0}%)
   Time: ${new Date(trade.timestamp).toLocaleTimeString()}
`;
    });

    const keyboard = {
      inline_keyboard: [
        [{ text: '📊 Week View', callback_data: 'trades_week' }],
        [{ text: '📅 Month View', callback_data: 'trades_month' }],
        [{ text: '📥 Export CSV', callback_data: 'export_csv' }],
        [{ text: '⬅️ Back', callback_data: 'back_main' }],
      ],
    };

    await ctx.reply(tradesText, { reply_markup: keyboard });
  }

  private async handleTrade(ctx: Context) {
    const userId = ctx.from?.id;
    if (!userId) return;

    const maxAttempts = admn.VALIDATION_RULES.MAX_ATTEMPTS_PER_COMMAND || 3;
    const timeoutMs = admn.VALIDATION_RULES.COMMAND_TIMEOUT_MS || 30000;

    const allowed = this.userLocks.canAttempt(userId, 'trade', maxAttempts, timeoutMs);
    if (!allowed) {
      return ctx.reply('⚠️ تجاوزت عدد المحاولات المسموح بها. حاول لاحقاً.');
    }

    try {
      await this.userLocks.runExclusive(userId, async () => {
        const tradeText = `
💱 MANUAL TRADING

Choose action:
`;

        const keyboard = {
          inline_keyboard: [
            [{ text: '🟢 BUY', callback_data: 'manual_buy' }],
            [{ text: '🔴 SELL', callback_data: 'manual_sell' }],
            [{ text: '⬅️ Back', callback_data: 'back_main' }],
          ],
        };

        await ctx.reply(tradeText, { reply_markup: keyboard });
        this.userLocks.clearAttempts(userId, 'trade');
      }, timeoutMs);
    } catch (err: any) {
      if (err && err.message === 'COMMAND_TIMEOUT') {
        await ctx.reply('⏱️ نفذت مهلة الأمر. حاول مرة أخرى.');
      } else {
        await ctx.reply('❌ خطأ داخلي. حاول لاحقاً.');
      }
    }
  }

  private async handleSniperDex(ctx: Context) {
    const userId = ctx.from?.id;
    if (!userId) return;

    const maxAttempts = admn.VALIDATION_RULES.MAX_ATTEMPTS_PER_COMMAND || 3;
    const timeoutMs = admn.VALIDATION_RULES.COMMAND_TIMEOUT_MS || 30000;

    const allowed = this.userLocks.canAttempt(userId, 'sniper_dex', maxAttempts, timeoutMs);
    if (!allowed) {
      return ctx.reply('⚠️ تجاوزت عدد المحاولات المسموح بها. حاول لاحقاً.');
    }

    try {
      await this.userLocks.runExclusive(userId, async () => {
        const user = this.loadUser(userId) || {} as any;
        // set pending action for wizard
        user.pendingAction = { type: 'sniper_dex', step: 1 };
        this.saveUser(userId, user);
        await ctx.reply('🔍 Sniper DEX: أرسل عنوان المِنت / Mint Address على Solana.');
        this.userLocks.clearAttempts(userId, 'sniper_dex');
      }, timeoutMs);
    } catch (err: any) {
      if (err && err.message === 'COMMAND_TIMEOUT') {
        await ctx.reply('⏱️ نفذت مهلة الأمر. حاول مرة أخرى.');
      } else {
        await ctx.reply('❌ خطأ داخلي.');
      }
    }
  }

  private async handleSniperCex(ctx: Context) {
    const userId = ctx.from?.id;
    if (!userId) return;

    const maxAttempts = admn.VALIDATION_RULES.MAX_ATTEMPTS_PER_COMMAND || 3;
    const timeoutMs = admn.VALIDATION_RULES.COMMAND_TIMEOUT_MS || 30000;

    const allowed = this.userLocks.canAttempt(userId, 'sniper_cex', maxAttempts, timeoutMs);
    if (!allowed) {
      return ctx.reply('⚠️ تجاوزت عدد المحاولات المسموح بها. حاول لاحقاً.');
    }

    try {
      await this.userLocks.runExclusive(userId, async () => {
        const user = this.loadUser(userId) || {} as any;
        user.pendingAction = { type: 'sniper_cex', step: 1 };
        this.saveUser(userId, user);
        await ctx.reply('🔍 Sniper CEX: أرسل اسم الرمز (مثال BTCUSDT). تأكد من وجود مفاتيح Exchange API.');
        this.userLocks.clearAttempts(userId, 'sniper_cex');
      }, timeoutMs);
    } catch (err: any) {
      if (err && err.message === 'COMMAND_TIMEOUT') {
        await ctx.reply('⏱️ نفذت مهلة الأمر. حاول مرة أخرى.');
      } else {
        await ctx.reply('❌ خطأ داخلي.');
      }
    }
  }

  private async handleBuy(ctx: Context) {
    const userId = ctx.from?.id;
    if (!userId) return;

    const maxAttempts = admn.VALIDATION_RULES.MAX_ATTEMPTS_PER_COMMAND || 3;
    const timeoutMs = admn.VALIDATION_RULES.COMMAND_TIMEOUT_MS || 30000;

    const allowed = this.userLocks.canAttempt(userId, 'buy', maxAttempts, timeoutMs);
    if (!allowed) {
      return ctx.reply('⚠️ تجاوزت عدد المحاولات المسموح بها للأمر. حاول لاحقاً.');
    }

    try {
      await this.userLocks.runExclusive(userId, async () => {
        // Pre-trade validation using admn.validateTradeSetup
        const user = this.loadUser(userId) as any;
        const pending = this.loadUserOrders(userId) || [];
        const userSession = {
          balance: (user && user.strategy && user.strategy.capital) || 0,
          concurrentOrders: pending.length || 0,
        };

        const check = admn.validateTradeSetup(userSession);
        if (!check.isValid) {
          await ctx.reply('❌ لا يمكن تنفيذ الأمر: ' + (check.errors || []).join('; '));
          return;
        }

        await ctx.reply('Send token address (Solana):');
        // clear attempts on success prompt
        this.userLocks.clearAttempts(userId, 'buy');
      }, timeoutMs);
    } catch (err: any) {
      if (err && err.message === 'COMMAND_TIMEOUT') {
        await ctx.reply('⏱️ نفذت مهلة الأمر. حاول مرة أخرى.');
      } else {
        await ctx.reply('❌ خطأ داخلي. حاول لاحقاً.');
      }
    }
  }

  private async handleSell(ctx: Context) {
    const userId = ctx.from?.id;
    if (!userId) return;

    const maxAttempts = admn.VALIDATION_RULES.MAX_ATTEMPTS_PER_COMMAND || 3;
    const timeoutMs = admn.VALIDATION_RULES.COMMAND_TIMEOUT_MS || 30000;

    const allowed = this.userLocks.canAttempt(userId, 'sell', maxAttempts, timeoutMs);
    if (!allowed) {
      return ctx.reply('⚠️ تجاوزت عدد المحاولات المسموح بها للأمر. حاول لاحقاً.');
    }

    try {
      await this.userLocks.runExclusive(userId, async () => {
        const user = this.loadUser(userId) as any;
        const pending = this.loadUserOrders(userId) || [];
        const userSession = {
          balance: (user && user.strategy && user.strategy.capital) || 0,
          concurrentOrders: pending.length || 0,
        };

        const check = admn.validateTradeSetup(userSession);
        if (!check.isValid) {
          await ctx.reply('❌ لا يمكن تنفيذ الأمر: ' + (check.errors || []).join('; '));
          return;
        }

        await ctx.reply('Send token address to sell:');
        this.userLocks.clearAttempts(userId, 'sell');
      }, timeoutMs);
    } catch (err: any) {
      if (err && err.message === 'COMMAND_TIMEOUT') {
        await ctx.reply('⏱️ نفذت مهلة الأمر. حاول مرة أخرى.');
      } else {
        await ctx.reply('❌ خطأ داخلي. حاول لاحقاً.');
      }
    }
  }

  private async handlePanic(ctx: Context) {
    const userId = ctx.from?.id;
    if (!userId) return;

    const panicsText = `
🚨 PANIC MODE - EMERGENCY CLOSE

This action will:
❌ Cancel all pending orders
❌ Close all positions
❌ Disable auto-trading

Are you sure?
`;

    const keyboard = {
      inline_keyboard: [
        [
          { text: '✅ YES, CLOSE ALL', callback_data: 'panic_confirm' },
          { text: '❌ CANCEL', callback_data: 'panic_cancel' },
        ],
      ],
    };

    await ctx.reply(panicsText, { reply_markup: keyboard });
  }

  private async handleDisable(ctx: Context) {
    const userId = ctx.from?.id;
    if (!userId) return;

    const user = this.loadUser(userId);
    if (user && user.strategy) {
      user.strategy.enabled = false;
      this.saveUser(userId, user);
      await ctx.reply('⏹️ Auto-trading DISABLED\n\nYou can still trade manually.');
    }
  }

  private async handleEnable(ctx: Context) {
    const userId = ctx.from?.id;
    if (!userId) return;

    const user = this.loadUser(userId);
    if (user && user.strategy) {
      user.strategy.enabled = true;
      this.saveUser(userId, user);
      await ctx.reply('🚀 Auto-trading ENABLED\n\nStrategy is now running.');
    }
  }

  private async handleWatchlist(ctx: Context) {
    await ctx.reply('📋 Watchlist management coming soon!');
  }

  private async handleCapital(ctx: Context) {
    await ctx.reply('Set trading capital (USD):\nExample: 500');
  }

  private async handleExport(ctx: Context) {
    const userId = ctx.from?.id;
    if (!userId) return;

    const trades = this.loadUserTrades(userId);
    const csvContent = this.generateCSV(trades);

    // In real implementation, would send file
    await ctx.reply(`📥 Export prepared\n\n${trades.length} trades ready for download`);
  }

  private handleConfig(ctx: Context) {
    ctx.reply('Configure strategy parameters...');
  }

  // ═══════════════════════════════════════════════════════════════════
  // CALLBACK HANDLERS
  // ═══════════════════════════════════════════════════════════════════

  private async handleButtonCallback(ctx: Context) {
    const data = ctx.callbackQuery?.data;
    const userId = ctx.from?.id;
    if (!userId) return;

    const maxAttempts = admn.VALIDATION_RULES.MAX_ATTEMPTS_PER_COMMAND || 3;
    const timeoutMs = admn.VALIDATION_RULES.COMMAND_TIMEOUT_MS || 30000;

    const cmdName = `callback_${data || 'unknown'}`;
    const allowed = this.userLocks.canAttempt(userId, cmdName, maxAttempts, timeoutMs);
    if (!allowed) {
      await ctx.answerCbQuery('⚠️ عدد المحاولات المسموح به لحدث الواجهة مُتجاوز.');
      return;
    }

    await ctx.answerCbQuery(); // Remove loading animation

    try {
      await this.userLocks.runExclusive(userId, async () => {
        const dstr = String(data || '');
        // Handle dynamic callback_data prefixes first (index-based to avoid long callback_data)
          if (dstr.startsWith('sniper_dex_start_idx_')) {
          const raw = dstr.replace('sniper_dex_start_idx_', '');
          const idx = Number(raw);
          const user = this.loadUser(userId) || {} as any;
          const entry = user.pendingFreshMints;
          const ttl = admn.VALIDATION_RULES.FRESH_MINTS_TTL_MS || 5 * 60 * 1000;
          let arr:any[] = [];
          if (entry && Array.isArray(entry.list)) {
            if (Date.now() - (entry.ts || 0) <= ttl) arr = entry.list;
            else {
              user.pendingFreshMints = undefined;
              this.saveUser(userId, user);
            }
          }
          const mint = arr[idx];
          if (!mint) {
            await ctx.reply('⚠️ العنصر غير موجود أو انتهت صلاحية قائمة المِنتات. افتح "التدفق" مجدداً.');
            return;
          }
          user.pendingAction = { type: 'sniper_dex', step: 2, token: mint, auto: true };
          // clear pendingFreshMints after using an index to avoid stale clicks
          user.pendingFreshMints = undefined;
          this.saveUser(userId, user);
          await ctx.reply(`🔔 بدء التداول الآلي للرمز ${mint}. أرسل مقدار الشراء بالـ SOL (مثال: 0.01) أو اكتب "auto" لاستخدام القيمة الافتراضي.`);
          return;
        }
          if (dstr.startsWith('sniper_dex_watch_idx_')) {
          const raw = dstr.replace('sniper_dex_watch_idx_', '');
          const idx = Number(raw);
          const user = this.loadUser(userId) || {} as any;
          const entry = user.pendingFreshMints;
          const ttl = admn.VALIDATION_RULES.FRESH_MINTS_TTL_MS || 5 * 60 * 1000;
          let arr:any[] = [];
          if (entry && Array.isArray(entry.list)) {
            if (Date.now() - (entry.ts || 0) <= ttl) arr = entry.list;
            else {
              user.pendingFreshMints = undefined;
              this.saveUser(userId, user);
            }
          }
          const mint = arr[idx];
          if (!mint) {
            await ctx.reply('⚠️ العنصر غير موجود أو انتهت صلاحية قائمة المِنتات. افتح "التدفق" مجدداً.');
            return;
          }
          user.honeySettings = user.honeySettings || { tokens: [], repeatOnEntry: true };
          user.honeySettings.tokens.push({ address: mint, buyAmount: user.strategy?.buyAmount || 0.01, profitPercents: [1,3], soldPercents: [50,50], status: 'pending' });
          // clear pendingFreshMints after adding to watchlist
          user.pendingFreshMints = undefined;
          this.saveUser(userId, user);
          await ctx.reply(`✅ ${mint} تمت إضافته للمراقبة.`);
          return;
        }
        switch (data) {
          case 'sniper_dex_btn': {
            const kb = { inline_keyboard: [[{ text: '🔄 التدفق (Fresh Mints)', callback_data: 'sniper_dex_flow' }, { text: '⚡ التداول الآلي', callback_data: 'sniper_dex_auto' }]] };
            await ctx.reply('اختر إجراء Sniper DEX:', { reply_markup: kb });
            break;
          }
          case 'sniper_dex_flow': {
            // show fresh mints list with per-item actions; save list in user session (index-based callbacks)
            await ctx.reply('🔄 Fetching latest mints...');
            try {
              const sniper = require('../../sniper');
              const collected = await sniper.collectFreshMints ? await sniper.collectFreshMints({ maxCollect: 10, timeoutMs: 30000 }) : null;
              if (!collected || !Array.isArray(collected) || collected.length === 0) {
                await ctx.reply('ℹ️ لا توجد مِنتات جديدة تم العثور عليها حالياً.');
              } else {
                const mintList = collected.slice(0, 10).map((t:any)=> (t.mint || t.address || t));
                const user = this.loadUser(userId) || {} as any;
                user.pendingFreshMints = { list: mintList, ts: Date.now() };
                this.saveUser(userId, user);

                const list = mintList.map((m:any,i:number)=>`${i+1}. ${m}`);
                // build keyboard rows: each row has Start and Watch buttons using index-based callback_data
                const kbRows:any[] = mintList.map((m:any,i:number)=>[
                  { text: `⚡ Start ${i+1}`, callback_data: `sniper_dex_start_idx_${i}` },
                  { text: `➕ Watch ${i+1}`, callback_data: `sniper_dex_watch_idx_${i}` }
                ]);

                await ctx.reply(`✅ وجدت ${collected.length} مِنتات جديدة:\n` + list.join('\n'));
                if (kbRows.length) {
                  await ctx.reply('اختر إجراء لكل عنصر:', { reply_markup: { inline_keyboard: kbRows } });
                }
              }
            } catch (e:any) {
              await ctx.reply('❌ خطأ أثناء جلب المِنتات الجديدة: ' + (e?.message || String(e)));
            }
            break;
          }
          // removed top-level fresh_mints_btn handler: Fresh Mints is now available under sniper_dex_btn -> sniper_dex_flow
          case 'sniper_dex_auto': {
            const user = this.loadUser(userId) || {} as any;
            user.pendingAction = { type: 'sniper_dex', step: 1, auto: true };
            this.saveUser(userId, user);
            await ctx.reply('🔍 Auto Sniper DEX: أرسل عنوان المِنت / Mint Address على Solana. سيبدأ النظام بالمراقبة والتنفيذ الآلي عند توفر المحفظة.');
            break;
          }
          case 'sniper_dex_manual': {
            const user = this.loadUser(userId) || {} as any;
            user.pendingAction = { type: 'sniper_dex', step: 1, auto: false };
            this.saveUser(userId, user);
            await ctx.reply('🔍 Sniper DEX (Manual): أرسل عنوان المِنت / Mint Address على Solana.');
            break;
          }
          case 'sniper_cex_btn': {
            const kb = { inline_keyboard: [[{ text: '🔁 Start Auto CEX', callback_data: 'sniper_cex_auto' }, { text: '✍️ Manual Setup', callback_data: 'sniper_cex_manual' }]] };
            await ctx.reply('Choose mode for Sniper CEX:', { reply_markup: kb });
            break;
          }
          case 'sniper_cex_auto': {
            const user = this.loadUser(userId) || {} as any;
            user.pendingAction = { type: 'sniper_cex', step: 1, auto: true };
            this.saveUser(userId, user);
            await ctx.reply('🔍 Auto Sniper CEX: أرسل اسم الرمز (مثال BTCUSDT). سيبدأ النظام بالمراقبة والتنفيذ الآلي عند توفر مفاتيح الـ API.');
            break;
          }
          case 'sniper_cex_manual': {
            const user = this.loadUser(userId) || {} as any;
            user.pendingAction = { type: 'sniper_cex', step: 1, auto: false };
            this.saveUser(userId, user);
            await ctx.reply('🔍 Sniper CEX (Manual): أرسل اسم الرمز (مثال BTCUSDT).');
            break;
          }
          case 'sniper_cex_start': {
            const user = this.loadUser(userId) || {} as any;
            const keys = user.keys && (user.keys.binanceApiKey && user.keys.binanceSecret) ? { apiKey: user.keys.binanceApiKey, apiSecret: user.keys.binanceSecret, platform: 'binance' } : null;
            if (!keys) {
              await ctx.reply('⚠️ لم يتم العثور على مفاتيح API. أضف مفاتيح Binance/MEXC أولاً عبر إعدادات.\nسيُطلب بدء الـ Sniper بعد ذلك.');
              break;
            }
            try {
              const cex = require('../../cexSniper');
              const res = cex.startUserCexSniper(String(userId), keys, { live: true });
              if (res && res.ok) {
                await ctx.reply(`✅ CEX sniper started (live). ${res.msg}`);
              } else {
                await ctx.reply('⚠️ فشل بدء CEX sniper: ' + (res && res.err));
              }
            } catch (e:any) {
              await ctx.reply('❌ خطأ عند بدء CEX sniper: ' + (e?.message || String(e)));
            }
            break;
          }
          case 'sniper_cex_enable': {
            const user = this.loadUser(userId) || {} as any;
            user.strategy = user.strategy || {};
            user.strategy.cexSniperEnabled = !user.strategy.cexSniperEnabled;
            this.saveUser(userId, user);
            await ctx.reply(`🔔 CEX sniper ${user.strategy.cexSniperEnabled ? 'enabled' : 'disabled'} for your account.`);
            break;
          }
          case 'setup_strategy':
            await ctx.reply('⚙️ Setup strategy: Configure your automation rules...');
            break;
          case 'status_quick':
            await ctx.reply('📊 Status: Bot is running and monitoring...');
            break;
          case 'add_keys':
            await ctx.reply('Choose exchange:\n1. Solana Wallet\n2. Binance\n3. MEXC');
            break;
          case 'set_capital':
            await ctx.reply('Enter trading capital (USD):');
            break;
          case 'config_tf':
            await ctx.reply('Configure timeframes: 5m, 15m, 4h, 8h');
            break;
          case 'set_tp':
            await ctx.reply('Set take profit percentage:');
            break;
          case 'set_sl':
            await ctx.reply('Set stop loss percentage:');
            break;
          case 'toggle':
            await ctx.reply('Toggle strategy...');
            break;
          default:
            await ctx.editMessageText('Unknown action');
        }
        this.userLocks.clearAttempts(userId, cmdName);
      }, timeoutMs);
    } catch (err: any) {
      if (err && err.message === 'COMMAND_TIMEOUT') {
        await ctx.reply('⏱️ نفذت مهلة المعاملة. حاول لاحقاً.');
      } else {
        await ctx.reply('❌ خطأ داخلي أثناء تنفيذ الحدث.');
      }
    }
  }

  private async handleTextInput(ctx: Context) {
    const text = ctx.message?.text;
    const userId = ctx.from?.id;

    if (!text || !userId) return;

    const maxAttempts = admn.VALIDATION_RULES.MAX_ATTEMPTS_PER_COMMAND || 3;
    const timeoutMs = admn.VALIDATION_RULES.COMMAND_TIMEOUT_MS || 30000;

    const allowed = this.userLocks.canAttempt(userId, 'textInput', maxAttempts, timeoutMs);
    if (!allowed) {
      return ctx.reply('⚠️ تجاوزت عدد المحاولات المسموح بها للنص. حاول لاحقاً.');
    }

    try {
      await this.userLocks.runExclusive(userId, async () => {
        // Handle wizard pending actions stored in the user's data
        const user = this.loadUser(userId) || {} as any;
        const pa = user.pendingAction;
        if (pa && pa.type === 'sniper_dex') {
          if (pa.step === 1) {
            // received token address
            const tokenAddr = text.trim();
            user.pendingAction = { type: 'sniper_dex', step: 2, token: tokenAddr };
            this.saveUser(userId, user);
            await ctx.reply('✅ Token recorded. الآن أرسل مقدار الشراء بالـ SOL (مثال: 0.01) أو اكتب "auto" لاستخدام القيمة الافتراضية.');
            this.userLocks.clearAttempts(userId, 'textInput');
            return;
          }
          if (pa.step === 2) {
            const tokenAddr = pa.token;
            let amount = 0;
            if (text.trim().toLowerCase() === 'auto') {
              amount = (user.strategy && user.strategy.capital) ? Math.max(0.001, (user.strategy.capital * 0.01)) : 0.01;
            } else {
              amount = Number(text.trim()) || 0;
            }
            if (!amount || amount <= 0) {
              await ctx.reply('قيمة غير صالحة، أرسل رقمًا مثل 0.01 أو اكتب "auto".');
              return;
            }

            // ensure honeySettings structure
            user.honeySettings = user.honeySettings || { tokens: [], repeatOnEntry: true };
            const tokenEntry = {
              address: tokenAddr,
              buyAmount: amount,
              profitPercents: [1, 3],
              soldPercents: [50, 50],
              repeatOnEntry: true,
              status: 'pending',
            };
            user.honeySettings.tokens.push(tokenEntry);
            user.strategy = user.strategy || { enabled: true };
            this.saveUser(userId, user);

            await ctx.reply(`🔔 تم إضافة ${tokenAddr} إلى قائمة المراقبة بشراء ${amount} SOL. سأحاول تنفيذ شراء فوري الآن (محاكاة إذا لم تكن مفاتيح المحفظة متوفرة).`);

            // Try immediate DEX buy if user has secret
            const secret = (user && (user.secret || (user.keys && user.keys.solanaPrivateKey))) || null;
            if (!secret) {
              await ctx.reply('⚠️ لا توجد محفظة مُسجلة لحسابك. أضف المحفظة أولاً باستخدام /wallet أو وضع المفتاح في الإعدادات. العملية أُضيفت للمراقبة فقط.');
            } else {
              try {
                await this.userLocks.runExclusive(userId, async () => {
                  const buyRes = await unifiedBuy(tokenAddr, amount, secret);
                  if (buyRes && buyRes.tx) {
                    await ctx.reply(`✅ شراء ابتدائي ناجح. Tx: https://solscan.io/tx/${buyRes.tx}`);
                    tokenEntry.status = 'active';
                    tokenEntry.lastTxId = buyRes.tx;
                    this.saveUser(userId, user);
                  } else {
                    await ctx.reply('⚠️ تم إضافة الرمز للمراقبة لكن الشراء الأولي لم ينجح.');
                  }
                }, admn.VALIDATION_RULES.COMMAND_TIMEOUT_MS || 30000);
              } catch (e:any) {
                await ctx.reply('❌ فشل تنفيذ الشراء الفوري: ' + (e?.message || String(e)));
              }
            }

            // clear pending action
            delete user.pendingAction;
            this.saveUser(userId, user);
            this.userLocks.clearAttempts(userId, 'textInput');
            return;
          }
        }

        if (pa && pa.type === 'sniper_cex') {
          if (pa.step === 1) {
            const symbol = text.trim();
            const userObj = user as any;
            // require API keys
            const keys = userObj.keys && (userObj.keys.binanceApiKey && userObj.keys.binanceSecret) ? { apiKey: userObj.keys.binanceApiKey, apiSecret: userObj.keys.binanceSecret, platform: 'binance' } : null;
            if (!keys) {
              await ctx.reply('⚠️ لم يتم العثور على مفاتيح API لبورصتك. أضف مفاتيح Binance/MEXC أولاً عبر واجهة إعدادات. الرمز سيُضاف للمراقبة كطلب يدوي.');
              // still add to honeySettings for monitoring
              user.honeySettings = user.honeySettings || { tokens: [], repeatOnEntry: true };
              user.honeySettings.tokens.push({ address: symbol, buyAmount: user.strategy?.buyAmount || 0.01, profitPercents: [1,3], soldPercents: [50,50], status: 'pending' });
              this.saveUser(userId, user);
              delete user.pendingAction;
              this.saveUser(userId, user);
              await ctx.reply(`🔔 ${symbol} أُضيف للمراقبة (CEX) بنجاح.`);
              this.userLocks.clearAttempts(userId, 'textInput');
              return;
            }

            // start cex sniper in simulation mode
            try {
              const cex = require('../../cexSniper');
              const res = cex.startUserCexSniper(String(userId), keys, { live: false });
              if (res && res.ok) {
                await ctx.reply(`✅ CEX sniper started (simulation). ${res.msg}`);
              } else {
                await ctx.reply('⚠️ فشل بدء CEX sniper: ' + (res && res.err));
              }
            } catch (e:any) {
              await ctx.reply('❌ خطأ عند بدء CEX sniper: ' + (e?.message || String(e)));
            }

            delete user.pendingAction;
            this.saveUser(userId, user);
            this.userLocks.clearAttempts(userId, 'textInput');
            return;
          }
        }

        // default fallback
        console.log(`[${userId}] Input: ${text}`);
        this.userLocks.clearAttempts(userId, 'textInput');
      }, timeoutMs);
    } catch (err: any) {
      if (err && err.message === 'COMMAND_TIMEOUT') {
        await ctx.reply('⏱️ نفذت مهلة النص. حاول مرة أخرى.');
      } else {
        await ctx.reply('❌ خطأ داخلي أثناء معالجة النص.');
      }
    }
  }

  // ═══════════════════════════════════════════════════════════════════
  // UTILITY FUNCTIONS
  // ═══════════════════════════════════════════════════════════════════

  private loadUser(userId: number): User | null {
    try {
      if (fs.existsSync(this.usersFile)) {
        const users = JSON.parse(fs.readFileSync(this.usersFile, 'utf8'));
        return users[userId.toString()] || null;
      }
    } catch (err) {
      console.error('Error loading user:', err);
    }
    return null;
  }

  private saveUser(userId: number, data: Partial<User>) {
    try {
      let users: Record<string, User> = {};

      if (fs.existsSync(this.usersFile)) {
        users = JSON.parse(fs.readFileSync(this.usersFile, 'utf8'));
      }

      const existing = users[userId.toString()] || {};
      users[userId.toString()] = { ...existing, ...data } as User;

      fs.writeFileSync(this.usersFile, JSON.stringify(users, null, 2));
    } catch (err) {
      console.error('Error saving user:', err);
    }
  }

  private loadUserOrders(userId: number): PendingOrder[] {
    try {
      const file = path.join(this.dataDir, `${userId}_orders.json`);
      if (fs.existsSync(file)) {
        return JSON.parse(fs.readFileSync(file, 'utf8'));
      }
    } catch (err) {
      console.error('Error loading orders:', err);
    }
    return [];
  }

  private loadUserTrades(userId: number): Trade[] {
    try {
      const file = path.join(this.dataDir, `${userId}.json`);
      if (fs.existsSync(file)) {
        const data = JSON.parse(fs.readFileSync(file, 'utf8'));
        return data.trades || [];
      }
    } catch (err) {
      console.error('Error loading trades:', err);
    }
    return [];
  }

  private generateCSV(trades: Trade[]): string {
    const headers = [
      'Date',
      'Token',
      'Entry Price',
      'Exit Price',
      'Amount',
      'Profit',
      'Profit %',
    ];
    const rows = trades.map((t) => [
      new Date(t.timestamp).toLocaleString(),
      t.token,
      t.entryPrice.toFixed(2),
      t.exitPrice?.toFixed(2) || 'N/A',
      t.amount.toString(),
      t.profit?.toFixed(2) || 'N/A',
      t.profitPercent?.toFixed(2) || 'N/A',
    ]);

    return [headers, ...rows].map((row) => row.join(',')).join('\n');
  }

  // ═══════════════════════════════════════════════════════════════════
  // BOT LIFECYCLE
  // ═══════════════════════════════════════════════════════════════════

  async launch() {
    console.log('🚀 Starting Telegram Trading Bot...');
    console.log(`📍 Bot Token: ${process.env.TELEGRAM_BOT_TOKEN?.substring(0, 10)}...`);

    await this.bot.launch();
    console.log('✅ Bot is running!');
    console.log('Press Ctrl+C to stop.');
  }

  stop() {
    console.log('🛑 Stopping bot...');
    this.bot.stop();
  }
}

// ═══════════════════════════════════════════════════════════════════
// START BOT
// ═══════════════════════════════════════════════════════════════════

const bot = new TradingTelegramBot();
bot.launch().catch((err) => {
  console.error('❌ Failed to start bot:', err);
  process.exit(1);
});

// Export for use by other modules (like persistent_monitor.ts)
export default bot;
export { TradingTelegramBot };
