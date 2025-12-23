#!/usr/bin/env node
const fs = require('fs');
const path = require('path');
const OUT = process.env.FSM_METRICS_FILE || '/tmp/fsm_metrics.jsonl';
function readAll(){ if(!fs.existsSync(OUT)) return []; const raw = fs.readFileSync(OUT,'utf8').trim(); if(!raw) return []; return raw.split(/\n+/).map(l=>{ try{return JSON.parse(l);}catch(e){return null;} }).filter(Boolean); }
function run(){ const a = readAll(); if(a.length===0){ console.error('no metrics found in', OUT); process.exit(1); }
  // consider only latest per mint (last occurrence)
  const byMint = new Map(); for(const it of a){ if(!it || !it.mint) continue; byMint.set(it.mint, it); }
  const all = Array.from(byMint.values()); const total = all.length;
  let ledgerStrong = 0; let solletCreated = 0; let both = 0; let neither = 0; let disagree = 0;
  for(const it of all){ const ls = !!it.ledgerStrongSignal; const sc = !!it.solletCreatedHere; if(ls) ledgerStrong++; if(sc) solletCreated++; if(ls && sc) both++; if(!ls && !sc) neither++; if((ls&&!sc)||(!ls&&sc)) disagree++; }
  const pct = (v) => (total?((v/total)*100).toFixed(1):'0.0');
  console.log('metrics_file:', OUT);
  console.log('total_mints_analyzed:', total);
  console.log('ledgerStrong:', ledgerStrong, pct(ledgerStrong),'%');
  console.log('solletCreatedHere:', solletCreated, pct(solletCreated),'%');
  console.log('both (agreement):', both, pct(both),'%');
  console.log('neither:', neither, pct(neither),'%');
  console.log('disagree (one true only):', disagree, pct(disagree),'%');
  // print sample disagreements
  const samples = all.filter(it => (!!it.ledgerStrongSignal) !== (!!it.solletCreatedHere)).slice(0,8);
  if(samples.length){ console.log('\nSample disagreements (up to 8):'); for(const s of samples){ console.log(JSON.stringify({ mint:s.mint, slot:s.slot, signature:s.signature, ledgerStrong:!!s.ledgerStrongSignal, sollet:!!s.solletCreatedHere, maskNames:s.maskNames||[] })); } }
}
run();
