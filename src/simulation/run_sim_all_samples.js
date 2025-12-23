#!/usr/bin/env node
require('dotenv').config();
const fs = require('fs');
const path = require('path');
const sniper = require('../../sniper.js');
const sim = require('./sniper_simulator');

(async ()=>{
  try{
    const inFile = path.resolve(__dirname, 'sample_mints_enriched.json');
    if(!fs.existsSync(inFile)){ console.error('samples file not found:', inFile); process.exit(2); }
    const arr = JSON.parse(fs.readFileSync(inFile,'utf8'));
    const outPath = '/tmp/sim_batch_results.jsonl';
    try{ fs.writeFileSync(outPath, '', 'utf8'); }catch(e){}
    const results = [];
    for(let i=0;i<arr.length;i++){
      const s = arr[i];
      const tok = s;
      console.error(`Running sample ${i+1}/${arr.length} mint=${tok.mint}`);
      const state = { token: tok.tokenAddress || tok.mint, liquidity_usd: 15000, pool_initialized: true, is_transferable: true, mint_authority: false, freeze_authority: false, update_authority: false };
      let execution = null;
      try{
        execution = await (sim.pre_slot_analysis_with_liquidity ? sim.pre_slot_analysis_with_liquidity(state) : sim.pre_slot_analysis(state));
      }catch(e){ execution = { allowed: false, error: String(e && e.message || e) }; }
      const clock = new sim.SlotClock(100000 + i*10);
      const target_slot = clock.current_slot() + 2;
      let triggered = false;
      try{
        await sim.slot_trigger(clock, target_slot, execution);
        triggered = true;
      }catch(e){ triggered = false; }
      const rec = { index: i, mint: tok.mint, signature: tok.signature, allowed: !!(execution && execution.allowed), triggered: !!triggered, execution: execution || null, time: new Date().toISOString() };
      fs.appendFileSync(outPath, JSON.stringify(rec) + '\n', 'utf8');
      results.push(rec);
    }
    // print summary
    const allowedCount = results.filter(r=>r.allowed).length;
    console.error(`Done: ${results.length} samples, allowed=${allowedCount}/${results.length}, results saved to /tmp/sim_batch_results.jsonl`);
    process.exit(0);
  }catch(e){ console.error('run_sim_all_samples error', e && e.stack || e); process.exit(1); }
})();
