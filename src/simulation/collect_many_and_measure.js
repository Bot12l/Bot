#!/usr/bin/env node
require('dotenv').config();
const fs = require('fs');
const path = require('path');
const sniper = require('../../sniper.js');
const metrics = require('./fsm_metrics_logger');
const { ProgramFSM } = require('./program_fsm_watcher');

// instantiate FSM watcher locally so it will process emitted events and record metrics
const watcher = new ProgramFSM({ programs: [] });
watcher.on('state', s=>{ /* quiet by default */ });
watcher.on('trigger', t=>{ /* quiet by default */ });

async function sleep(ms){ return new Promise(r=>setTimeout(r,ms)); }

async function run(samples = 10, timeoutMs = 60000){
  samples = Number(samples) || 10;
  timeoutMs = Number(timeoutMs) || 60000;
  console.error(`collect_many_and_measure: samples=${samples} timeoutMs=${timeoutMs}`);
  for(let i=1;i<=samples;i++){
    try{
      console.error(`== Sample ${i}/${samples} -> collecting one mint`);
      const res = await sniper.collectFreshMints({ maxCollect: 1, timeoutMs });
      if(!Array.isArray(res) || res.length===0){ console.error('no mint collected for this sample'); continue; }
      const tok = res[0];
      const mint = tok.tokenAddress || tok.mint || tok.address;
      // emit programEvent (sniper.notifier may already do this in real flow; do it anyway)
      const ev = { time: new Date().toISOString(), program: tok.sourceProgram || tok.program || null, signature: tok.sourceSignature || tok.signature || null, kind: tok.kind || 'initialize', freshMints: [mint], sampleLogs: tok.sampleLogs || [], txBlock: tok.txBlock || tok.firstBlock || null };
      console.error('emitting programEvent for', mint);
      try{ sniper.notifier.emit('programEvent', ev); }catch(_e){}

      // wait for metric to be appended for this mint (timeouted wait)
      const start = Date.now();
      const waitTimeout = 30000;
      let found = false;
      while(Date.now() - start < waitTimeout){
        const all = metrics.readAll();
        if(all.find(x=>x.mint === mint)) { found = true; break; }
        await sleep(200);
      }
      if(found) console.error('metric recorded for', mint);
      else console.error('metric NOT recorded for', mint);
      // small pause between samples
      await sleep(500);
    }catch(e){ console.error('sample error', e && e.stack || e); }
  }
  const summary = metrics.summarize();
  console.log('SUMMARY:', JSON.stringify(summary, null, 2));
}

if(require.main === module){
  const samples = process.argv[2] || process.env.MEASURE_SAMPLES || 10;
  const timeoutMs = process.argv[3] || process.env.MEASURE_TIMEOUT_MS || 60000;
  run(samples, timeoutMs).catch(e=>{ console.error('run error', e && e.stack || e); process.exit(1); });
}
