import { userLocks } from '../src/utils/userLocks';
require('dotenv').config();

// Small helper
const delay = (ms: number) => new Promise((res) => setTimeout(res, ms));

/**
 * Minimal runLiveBuySell adapted for tests with dependency injection
 */
export async function runLiveBuySell(opts: {
  secret: any;
  botWalletAddress: string;
  sniperModule?: any;
  unifiedBuy?: (mint: string, amount: number, secret: any) => Promise<any>;
  unifiedSell?: (mint: string, amount: number, secret: any) => Promise<any>;
  walletModule?: any;
  buyAmount?: number;
  dryRun?: boolean;
}) {
  const sniper = opts.sniperModule || { async collectFreshMints() { return []; } };
  const unifiedBuy = opts.unifiedBuy!;
  const unifiedSell = opts.unifiedSell!;
  const walletModule = opts.walletModule!;
  const buyAmount = typeof opts.buyAmount === 'number' ? opts.buyAmount : 0.005;

  const tokens = await sniper.collectFreshMints({ maxCollect: 1 }).catch(() => []);
  if (!tokens || tokens.length === 0) {
    if (opts.dryRun) return { ok: false, reason: 'no_mints' };
    throw new Error('No fresh mints found');
  }
  const tok = tokens[0];
  const mint = tok.mint || tok.tokenAddress || tok.address;

  const buyRes = await unifiedBuy(mint, buyAmount, opts.secret);
  const txSig = buyRes && (buyRes.tx || (buyRes.raw && buyRes.raw.tx)) || null;
  if (!txSig) {
    if (opts.dryRun) return { ok: false, reason: 'no_tx' };
    throw new Error('No txSig from buy');
  }

  const { getConnection } = walletModule;
  const conn = getConnection();
  const tx = await conn.getTransaction(txSig as string);
  const post = (tx && tx.meta && tx.meta.postTokenBalances) || [];
  let baseAmount: number | null = null;
  for (const p of post) {
    try {
      if (p && (p.mint === mint)) {
        const a = p.uiTokenAmount && p.uiTokenAmount.amount ? p.uiTokenAmount.amount : (p.amount || null);
        if (a) { baseAmount = Number(a); break; }
      }
    } catch (e) {}
  }
  if (!baseAmount) {
    if (opts.dryRun) return { ok: false, reason: 'no_amount' };
    throw new Error('Could not determine base amount');
  }

  const sellRes = await unifiedSell(mint, baseAmount, opts.secret);
  return { ok: true, buyRes, sellRes };
}

// --------------------------
// Concurrency test
// --------------------------

async function concurrencyTestSameUser() {
  const events: string[] = [];
  const mint = 'FAKE_TEST_MINT';
  const owner = 'BOT_ADDR_TEST';
  const secret = 'SECRET_TEST';

  const sniper = {
    async collectFreshMints() { return [{ mint, tokenAddress: mint, address: mint }]; }
  };

  // mocks with delays to expose overlap when not locked
  const makeBuy = (label: string) => async (m: string, amt: number, s: any) => {
    events.push(`${label}:buy:start:${Date.now()}`);
    await delay(200);
    events.push(`${label}:buy:end:${Date.now()}`);
    return { tx: `TX_BUY_${label}_${Date.now()}` };
  };

  const makeSell = (label: string) => async (m: string, amt: number, s: any) => {
    events.push(`${label}:sell:start:${Date.now()}`);
    await delay(100);
    events.push(`${label}:sell:end:${Date.now()}`);
    return { tx: `TX_SELL_${label}_${Date.now()}` };
  };

  const wallet = {
    getConnection() {
      return {
        async getTransaction(txSig: string) {
          return { meta: { postTokenBalances: [{ mint, owner, uiTokenAmount: { amount: '123' } }] } };
        }
      };
    }
  };

  // Two concurrent runs for the SAME user id
  const userId = 'same_user';

  const p1 = userLocks.runExclusive(userId, async () => {
    return await runLiveBuySell({ secret, botWalletAddress: owner, sniperModule: sniper, unifiedBuy: makeBuy('A'), unifiedSell: makeSell('A'), walletModule: wallet, dryRun: false });
  }, 5000).then((r:any)=>{ events.push('p1:done'); return r; }).catch(e=>{ events.push('p1:err'); throw e; });

  const p2 = userLocks.runExclusive(userId, async () => {
    return await runLiveBuySell({ secret, botWalletAddress: owner, sniperModule: sniper, unifiedBuy: makeBuy('B'), unifiedSell: makeSell('B'), walletModule: wallet, dryRun: false });
  }, 5000).then((r:any)=>{ events.push('p2:done'); return r; }).catch(e=>{ events.push('p2:err'); throw e; });

  await Promise.all([p1, p2]);

  // Analyze events: ensure that events from B occur after A finished
  const buyEndA = events.find(e => e.startsWith('A:buy:end'));
  const buyStartB = events.find(e => e.startsWith('B:buy:start'));
  if (!buyEndA || !buyStartB) throw new Error('Missing events');
  const tEndA = Number(buyEndA.split(':').pop());
  const tStartB = Number(buyStartB.split(':').pop());
  if (tStartB <= tEndA) {
    throw new Error('userLocks did not serialize executions for same user');
  }

  console.log('concurrencyTestSameUser passed');
}

async function runAll() {
  console.log('Running combined runner: concurrency test');
  try {
    await concurrencyTestSameUser();
    console.log('All tests passed');
  } catch (e) {
    console.error('Tests failed:', e);
    process.exit(2);
  }
}

if (require.main === module) {
  runAll().catch(e=>{ console.error(e); process.exit(1); });
}
