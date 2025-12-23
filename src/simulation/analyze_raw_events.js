#!/usr/bin/env node
/**
 * Analyze raw program events and compute ledgerMask, baseline vs forced-liquidity trigger decisions
 */
const fs = require('fs');
const path = require('path');
const { LedgerSignalEngine, BIT_ACCOUNT_CREATED, BIT_ATA_CREATED, BIT_SAME_AUTH, BIT_PROGRAM_INIT, BIT_SLOT_DENSE } = require('./ledger_signal_engine');

// Bits used in FSM (replicate for decision logic)
const BIT_MINT_EXISTS = 1<<0;
const BIT_AUTH_OK = 1<<1;
const BIT_POOL_EXISTS = 1<<2;
const BIT_POOL_INIT = 1<<3;
const BIT_TRANSFERABLE = 1<<4;
const BIT_SLOT_SEQ = 1<<5;
const CORE_MASK = BIT_MINT_EXISTS|BIT_AUTH_OK|BIT_POOL_EXISTS|BIT_POOL_INIT;

// weights (copy from program_fsm_watcher.js)
const WEIGHTS = {
  [BIT_MINT_EXISTS]: 0.20,
  [BIT_AUTH_OK]: 0.20,
  [BIT_POOL_EXISTS]: 0.15,
  [BIT_POOL_INIT]: 0.15,
  [BIT_TRANSFERABLE]: 0.20,
  [BIT_SLOT_SEQ]: 0.10,
};
const LEDGER_WEIGHTS = {
  [BIT_ACCOUNT_CREATED]: 0.06,
  [BIT_ATA_CREATED]: 0.05,
  [BIT_SAME_AUTH]: 0.04,
  [BIT_PROGRAM_INIT]: 0.05,
  [BIT_SLOT_DENSE]: 0.05,
};
const SCORE_THRESHOLD = Number(process.env.READY_SCORE_THRESHOLD || 0.80);

const RAW = process.argv[2] || process.env.RAW_EVENTS_FILE || '/tmp/raw_program_events.jsonl';

function readLines(file){
  try{ if(!fs.existsSync(file)) return []; return fs.readFileSync(file,'utf8').trim().split(/\n+/).map(l=>JSON.parse(l)).filter(Boolean); }catch(e){ console.error('read error', e && e.message || e); return []; }
}

function decodeLedgerMask(mask){
  const names = [];
  const map = {
    [BIT_ACCOUNT_CREATED]: 'AccountCreated',
    [BIT_ATA_CREATED]: 'ATACreated',
    [BIT_SAME_AUTH]: 'SameAuthority',
    [BIT_PROGRAM_INIT]: 'ProgramInit',
    [BIT_SLOT_DENSE]: 'SlotDensity',
  };
  for(const k of Object.keys(map)){
    const bit = Number(k);
    if(mask & bit) names.push(map[k]);
  }
  return names;
}

function scoreFromMask(mask, ledgerMask){
  let score = 0;
  for(const [bit, w] of Object.entries(WEIGHTS)){
    try{ if(mask & Number(bit)) score += Number(w); }catch(e){}
  }
  for(const [bit, w] of Object.entries(LEDGER_WEIGHTS)){
    try{ if(ledgerMask & Number(bit)) score += Number(w); }catch(e){}
  }
  return score;
}

(async ()=>{
  const events = readLines(RAW);
  if(!events.length){ console.error('No raw events found in', RAW); process.exit(2); }
  const engine = new LedgerSignalEngine({ windowSlots: 5, densityThreshold: 3 });
  const analyses = [];
  for(const ev of events){
    // feed into engine first
    try{ engine.processEvent(ev); }catch(_e){}
    const slot = ev && (ev.slot || ev.txBlock || ev.firstBlock || null);
    const fresh = Array.isArray(ev.freshMints) ? ev.freshMints : [];
    for(const m of fresh){
      const ledgerMask = engine.getMaskForMint(m, slot);
      const ledgerNames = decodeLedgerMask(ledgerMask);
      const ledgerStrong = engine.isStrongSignal(m, slot, 2);
      // baseline: assume s.mask=0 (no RPC probes)
      const baselineMask = 0;
      const baselineScore = scoreFromMask(baselineMask, ledgerMask);
      const baselineHasTransferable = Boolean(baselineMask & BIT_TRANSFERABLE);
      const baselineCoreOk = ((baselineMask & CORE_MASK) === CORE_MASK);
      const baselineTriggered = (baselineHasTransferable && (baselineCoreOk || baselineScore >= SCORE_THRESHOLD)) || (ledgerStrong && baselineHasTransferable);
      // forced liquidity: set pool_exists, pool_init, transferable
      const forcedMask = baselineMask | BIT_POOL_EXISTS | BIT_POOL_INIT | BIT_TRANSFERABLE;
      const forcedScore = scoreFromMask(forcedMask, ledgerMask);
      const forcedHasTransferable = Boolean(forcedMask & BIT_TRANSFERABLE);
      const forcedCoreOk = ((forcedMask & CORE_MASK) === CORE_MASK);
      const forcedTriggered = (forcedHasTransferable && (forcedCoreOk || forcedScore >= SCORE_THRESHOLD)) || (ledgerStrong && forcedHasTransferable);

      analyses.push({ mint: m, slot: slot, ledgerMask, ledgerNames, ledgerStrong, baselineScore, baselineTriggered, forcedScore, forcedTriggered, rawEvent: ev });
    }
  }

  // summarize
  const total = analyses.length;
  const ledgerStrongCount = analyses.filter(x=>x.ledgerStrong).length;
  const baselineTriggers = analyses.filter(x=>x.baselineTriggered).length;
  const forcedTriggers = analyses.filter(x=>x.forcedTriggered).length;
  console.log('ANALYSIS SUMMARY: totalEvents=', total, 'ledgerStrong=', ledgerStrongCount, 'baselineTriggers=', baselineTriggers, 'forcedTriggers=', forcedTriggers);
  const examples = analyses.slice(0,10).map(a=>({ mint: a.mint, slot: a.slot, ledgerNames: a.ledgerNames, baselineTriggered: a.baselineTriggered, forcedTriggered: a.forcedTriggered, baselineScore: a.baselineScore, forcedScore: a.forcedScore }));
  console.log('Examples:', JSON.stringify(examples, null, 2));

  // save detailed csv
  const outCsv = process.env.RAW_ANALYZE_CSV || '/tmp/raw_events_analysis.csv';
  const hd = 'mint,slot,ledgerMask,ledgerNames,ledgerStrong,baselineScore,baselineTriggered,forcedScore,forcedTriggered';
  const lines = [hd];
  for(const a of analyses){
    lines.push([a.mint,a.slot, a.ledgerMask, '"' + (a.ledgerNames.join('|')) + '"', a.ledgerStrong ? 1 : 0, a.baselineScore.toFixed(4), a.baselineTriggered ? 1 : 0, a.forcedScore.toFixed(4), a.forcedTriggered ? 1 : 0].join(','));
  }
  fs.writeFileSync(outCsv, lines.join('\n'),'utf8');
  console.log('Wrote CSV to', outCsv);
})();
