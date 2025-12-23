#!/usr/bin/env node
require('dotenv').config();
const fs = require('fs');
const path = require('path');
const sniper = require('../../sniper.js');

const OUT = process.env.RAW_EVENTS_FILE || '/tmp/raw_program_events.jsonl';

function append(obj){
  try{ fs.appendFileSync(OUT, JSON.stringify(obj) + '\n', 'utf8'); }catch(e){ console.error('append error', e && e.message || e); }
}

async function sleep(ms){ return new Promise(r=>setTimeout(r, ms)); }

async function run(samples = 20, timeoutMs = 60000){
  samples = Number(samples) || 20;
  timeoutMs = Number(timeoutMs) || 60000;
  console.error(`collect_raw_events: samples=${samples} timeoutMs=${timeoutMs} -> writing to ${OUT}`);
  for(let i=1;i<=samples;i++){
    try{
      console.error(`sample ${i}/${samples}: collecting one mint`);
      const res = await sniper.collectFreshMints({ maxCollect: 1, timeoutMs });
      if(!Array.isArray(res) || res.length===0){ console.error('no mint collected for this sample'); await sleep(500); continue; }
      const tok = res[0];
      const ev = { time: new Date().toISOString(), program: tok.sourceProgram || tok.program || null, signature: tok.sourceSignature || tok.signature || null, kind: tok.kind || 'initialize', freshMints: Array.isArray(tok.freshMints) && tok.freshMints.length>0 ? tok.freshMints : [ tok.tokenAddress || tok.mint || tok.address ], sampleLogs: tok.sampleLogs || [], txBlock: tok.txBlock || tok.firstBlock || null, raw: tok };
      append(ev);
      console.error('WROTE event for', ev.freshMints[0]);
      // small pause
      await sleep(400);
    }catch(e){ console.error('sample error', e && e.stack || e); await sleep(500); }
  }
  console.error('collection finished');
}

if(require.main === module){
  const samples = process.argv[2] || process.env.RAW_SAMPLES || 20;
  const timeoutMs = process.argv[3] || process.env.RAW_TIMEOUT_MS || 60000;
  run(samples, timeoutMs).catch(e=>{ console.error('runner error', e && e.stack || e); process.exit(1); });
}
