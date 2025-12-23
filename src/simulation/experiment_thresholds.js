#!/usr/bin/env node
/**
 * Run simple offline experiments sweeping READY_SCORE_THRESHOLD values and
 * optionally toggling ledger-strong shortcut behavior, using the already
 * collected raw events and the ledger engine.
 * Usage: node experiment_thresholds.js [raw.jsonl] [--thresholds=0.5,0.6,0.7,0.8] [--out=/tmp/exp.csv]
 */
const fs = require('fs');
const argv = require('minimist')(process.argv.slice(2));
const RAW = argv._[0] || process.env.RAW_EVENTS_FILE || '/tmp/raw_program_events.jsonl';
const OUT = argv.out || process.env.EXP_OUT || '/tmp/experiment_thresholds.csv';
const THS = (argv.thresholds || process.env.EXP_THRESHOLDS || '0.5,0.6,0.7,0.8').split(',').map(s=>Number(s)).filter(x=>!isNaN(x));
const FORCE_LEDGER_STRONG = (argv.forceLedgerStrong === '1' || argv.forceLedgerStrong === 'true' || process.env.FORCE_LEDGER_STRONG === '1');

function readLines(file){
  try{ if(!fs.existsSync(file)) return []; return fs.readFileSync(file,'utf8').trim().split(/\n+/).map(l=>JSON.parse(l)).filter(Boolean); }catch(e){ console.error('read error', e && e.message || e); return []; }
}

const { LedgerSignalEngine } = require('./ledger_signal_engine');
const BIT_MINT_EXISTS = 1<<0;
const BIT_AUTH_OK = 1<<1;
const BIT_POOL_EXISTS = 1<<2;
const BIT_POOL_INIT = 1<<3;
const BIT_TRANSFERABLE = 1<<4;
const BIT_SLOT_SEQ = 1<<5;
const CORE_MASK = BIT_MINT_EXISTS|BIT_AUTH_OK|BIT_POOL_EXISTS|BIT_POOL_INIT;

const WEIGHTS = {
  [BIT_MINT_EXISTS]: 0.20,
  [BIT_AUTH_OK]: 0.20,
  [BIT_POOL_EXISTS]: 0.15,
  [BIT_POOL_INIT]: 0.15,
  [BIT_TRANSFERABLE]: 0.20,
  [BIT_SLOT_SEQ]: 0.10,
};
const LEDGER_WEIGHTS = {
  // small boosts
  [1<<8]: 0.06,
  [1<<9]: 0.05,
  [1<<10]: 0.04,
  [1<<11]: 0.05,
  [1<<12]: 0.05,
};

function scoreFromMask(mask, ledgerMask){
  let score = 0;
  for(const [bit, w] of Object.entries(WEIGHTS)){
    if(mask & Number(bit)) score += Number(w);
  }
  for(const [bit, w] of Object.entries(LEDGER_WEIGHTS)){
    if(ledgerMask & Number(bit)) score += Number(w);
  }
  return score;
}

(async ()=>{
  const events = readLines(RAW);
  if(!events.length){ console.error('No raw events found in', RAW); process.exit(2); }
  const engine = new LedgerSignalEngine({ windowSlots: 5, densityThreshold: 3 });
  const rows = [];
  for(const th of THS){
    let baselineTriggers = 0;
    let forcedTriggers = 0;
    let ledgerStrongTriggers = 0;
    let total = 0;
    engine.reset && engine.reset();
    for(const ev of events){
      try{ engine.processEvent(ev); }catch(_e){}
      const slot = ev && (ev.slot || ev.txBlock || ev.firstBlock || null);
      const fresh = Array.isArray(ev.freshMints) ? ev.freshMints : [];
      for(const m of fresh){
        total++;
        const ledgerMask = engine.getMaskForMint(m, slot);
        const ledgerStrong = engine.isStrongSignal ? engine.isStrongSignal(m, slot, 2) : false;
        // baseline: assume mask=0
        const baselineMask = 0;
        const baselineScore = scoreFromMask(baselineMask, ledgerMask);
        const baselineHasTransferable = Boolean(baselineMask & BIT_TRANSFERABLE);
        const baselineCoreOk = ((baselineMask & CORE_MASK) === CORE_MASK);
        const baselineTriggered = (baselineHasTransferable && (baselineCoreOk || baselineScore >= th)) || (ledgerStrong && baselineHasTransferable);
        // forced liquidity
        const forcedMask = baselineMask | BIT_POOL_EXISTS | BIT_POOL_INIT | BIT_TRANSFERABLE;
        const forcedScore = scoreFromMask(forcedMask, ledgerMask);
        const forcedHasTransferable = Boolean(forcedMask & BIT_TRANSFERABLE);
        const forcedCoreOk = ((forcedMask & CORE_MASK) === CORE_MASK);
        const forcedTriggered = (forcedHasTransferable && (forcedCoreOk || forcedScore >= th)) || (ledgerStrong && forcedHasTransferable);

        if(baselineTriggered) baselineTriggers++;
        if(forcedTriggered) forcedTriggers++;
        if(ledgerStrong && (!baselineTriggered) && forcedHasTransferable) ledgerStrongTriggers++; // ledger would have flipped
      }
    }
    rows.push({ threshold: th, total, baselineTriggers, forcedTriggers, ledgerStrongTriggers });
  }

  // write CSV
  const hd = 'threshold,total,baselineTriggers,forcedTriggers,ledgerStrongTriggers';
  const lines = [hd];
  for(const r of rows) lines.push([r.threshold, r.total, r.baselineTriggers, r.forcedTriggers, r.ledgerStrongTriggers].join(','));
  fs.writeFileSync(OUT, lines.join('\n'),'utf8');
  console.log('Wrote experiment CSV to', OUT);
})();
