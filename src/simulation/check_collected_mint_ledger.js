#!/usr/bin/env node
const { Connection } = require('@solana/web3.js');
const { LedgerSignalEngine } = require('./ledger_signal_engine');

async function main(){
  const sig = process.argv[2];
  const mint = process.argv[3];
  if(!sig || !mint){
    console.error('Usage: node check_collected_mint_ledger.js <signature> <mint>');
    process.exit(2);
  }
  const RPC = process.env.HELIUS_RPC_URL || process.env.SOLANA_RPC_URL || 'https://api.mainnet-beta.solana.com';
  const conn = new Connection(RPC, 'confirmed');
  console.error('Fetching tx', sig, 'from', RPC);
  const tx = await conn.getTransaction(sig, { commitment: 'confirmed', maxSupportedTransactionVersion: 0 });
  if(!tx){ console.error('Transaction not found'); process.exit(1); }
  const slot = tx.slot || (tx.meta && tx.meta.slot) || null;
  const ev = { time: new Date().toISOString(), program: null, signature: sig, kind: null, freshMints: [mint], sampleLogs: (tx.meta && tx.meta.logMessages) || [], transaction: tx.transaction || tx, meta: tx.meta || tx, slot };
  const eng = new LedgerSignalEngine({ windowSlots: 5, densityThreshold: 2 });
  eng.processEvent(ev);
  const mask = eng.getMaskForMint(mint, slot);
  const strong = eng.isStrongSignal(mint, slot, 2);
  // Sollet-like creation indicators
  const logs = (tx.meta && Array.isArray(tx.meta.logMessages)) ? tx.meta.logMessages.join('\n').toLowerCase() : '';
  let solletCreatedHere = false;
  if(logs.includes('instruction: initializemint') || logs.includes('initialize mint') || logs.includes('initialize_mint') || logs.includes('createidempotent')) solletCreatedHere = true;
  // parsed instruction check
  try{
    const msg = tx && (tx.transaction && tx.transaction.message) || tx.transaction || {};
    const instrs = (msg && msg.instructions) || [];
    for(const ins of instrs){ try{ const t = (ins.parsed && ins.parsed.type) || (ins.type || ''); if(t && String(t).toLowerCase().includes('initializemint')) solletCreatedHere = true; const info = ins.parsed && ins.parsed.info; if(info && (info.mint===mint || info.newAccount===mint)) solletCreatedHere = true; }catch(e){} }
  }catch(e){}
  // decode mask bits
  const names = [];
  const map = {
    6: 'AccountCreated',7:'ATACreated',8:'SameAuthority',9:'ProgramInit',10:'SlotDensity',11:'LPStruct',12:'CleanFunding',13:'SlotAligned',14:'CreatorExposed'
  };
  let bit=0; let temp=mask; while(temp){ if(temp&1){ const idx = bit - 6; const name = map[bit] || null; if(name) names.push(name); }
    temp >>>=1; bit++; }
  console.log('mint', mint, 'slot', slot, 'mask', mask, 'strong', strong, 'names', names, 'solletCreatedHere', solletCreatedHere);
}

main().catch(e=>{ console.error(e && e.stack || e); process.exit(1); });
