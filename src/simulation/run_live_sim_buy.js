#!/usr/bin/env node
require('dotenv').config();
const sniper = require('../../sniper.js');
const sim = require('./sniper_simulator');

(async ()=>{
  try{
    console.error('>> Collecting one fresh mint (timeoutMs=180000)');
    const collected = await sniper.collectFreshMints({ maxCollect: 1, timeoutMs: 180000 });
    if(!Array.isArray(collected) || collected.length === 0){ console.error('No fresh mints collected'); process.exit(2); }
    const tok = collected[0];
    console.error('>> Collected token (raw):', JSON.stringify(tok, null, 2));

    // derive LaunchState from token
    const sampleLogs = (tok.sampleLogs && Array.isArray(tok.sampleLogs)) ? tok.sampleLogs.join('\n').toLowerCase() : '';
    const poolIndicators = ['createpool','initializepool','pool_creation','create pool','pool','initialize'];
    const pool_initialized = poolIndicators.some(s => sampleLogs.includes(s));
    const liquidity_usd = pool_initialized ? 12000 : 0; // placeholder
    const is_transferable = true;
    const mint_authority = false;
    const freeze_authority = false;
    const update_authority = false;

    const state = { token: tok.tokenAddress || tok.mint || tok.address, liquidity_usd, pool_initialized, is_transferable, mint_authority, freeze_authority, update_authority };
    console.error('>> Derived LaunchState:', JSON.stringify(state, null, 2));

    console.error('⏳ Running pre-slot analysis (RiskEngine)');
    const execution = await (sim.pre_slot_analysis_with_liquidity ? sim.pre_slot_analysis_with_liquidity(state) : sim.pre_slot_analysis(state));
    console.error('>> Decision allowed=', execution && execution.allowed);

    // simulate trigger on target slot
    const clock = new sim.SlotClock(100000);
    const target_slot = clock.current_slot() + 2;
    console.error(`🕒 Waiting for target slot ${target_slot} (start_slot=100000)`);
    await sim.slot_trigger(clock, target_slot, execution);
    console.error('>> Simulation trigger finished');
    process.exit(0);
  }catch(e){ console.error('run_live_sim_buy error', e && e.stack || e); process.exit(1); }
})();
