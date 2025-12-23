#!/usr/bin/env node
require('dotenv').config();
const fs = require('fs');
const path = require('path');
const sniper = require('../../sniper.js');
const sim = require('./sniper_simulator');

(async ()=>{
  try{
    let arg = process.argv[2] || null;
    let tok = null;
    if(arg && arg.endsWith('.json')){
      try{ const j = path.resolve(arg); const data = JSON.parse(fs.readFileSync(j,'utf8')); if(Array.isArray(data) && data.length>0) tok = data[0]; else if(data && typeof data === 'object') tok = data; }catch(e){ console.error('Failed to read JSON arg', e && e.message || e); }
    }

    if(!tok){
      console.error('>> Collecting one fresh mint (timeoutMs=180000)');
      const collected = await sniper.collectFreshMints({ maxCollect: 1, timeoutMs: 180000 });
      if(!Array.isArray(collected) || collected.length === 0){ console.error('No fresh mints collected'); process.exit(2); }
      tok = collected[0];
      console.error('>> Collected token (raw):', JSON.stringify(tok, null, 2));
    } else {
      console.error('>> Using provided token from JSON arg:', tok && (tok.tokenAddress || tok.mint || tok.address));
    }

    // Force liquidity to simulate buy
    const state = { token: tok.tokenAddress || tok.mint || tok.address, liquidity_usd: 15000, pool_initialized: true, is_transferable: true, mint_authority: false, freeze_authority: false, update_authority: false };
    console.error('>> FORCED LaunchState for buy simulation:', JSON.stringify(state, null, 2));

    console.error('⏳ Running pre-slot analysis (RiskEngine)');
    const execution = await (sim.pre_slot_analysis_with_liquidity ? sim.pre_slot_analysis_with_liquidity(state) : sim.pre_slot_analysis(state));
    console.error('>> Decision allowed=', execution && execution.allowed);

    const clock = new sim.SlotClock(100000);
    const target_slot = clock.current_slot() + 2;
    console.error(`🕒 Waiting for target slot ${target_slot} (start_slot=100000)`);
    await sim.slot_trigger(clock, target_slot, execution);
    console.error('>> Simulation trigger finished');
    process.exit(0);
  }catch(e){ console.error('run_live_sim_buy_force error', e && e.stack || e); process.exit(1); }
})();
