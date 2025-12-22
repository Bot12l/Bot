#!/usr/bin/env node
require('dotenv').config();
const path = require('path');
const sniper = require('../../sniper.js');
const sim = require('./sniper_simulator');

async function main(){
  console.error('>> Starting live fetch (collectFreshMints maxCollect=1)');
  let collected = null;
  try{
    collected = await sniper.collectFreshMints({ maxCollect: 1, timeoutMs: 30000 });
  }catch(e){ console.error('collectFreshMints failed', e); process.exit(1); }
  if(!collected || collected.length===0){ console.error('No fresh mints found'); process.exit(2); }
  const tok = collected[0];
  console.error('>> Collected token:', JSON.stringify(tok, null, 2));

  // Heuristic derivation of LaunchState fields
  const sampleLogs = (tok.sampleLogs && Array.isArray(tok.sampleLogs)) ? tok.sampleLogs.join('\n').toLowerCase() : '';
  const poolIndicators = ['createpool','initializepool','pool_creation','create pool','pool'];
  const pool_initialized = poolIndicators.some(s=> sampleLogs.includes(s));
  const liquidity_usd = pool_initialized ? 12000 : 0; // best-effort placeholder
  const is_transferable = true;
  const mint_authority = false;
  const freeze_authority = false;
  const update_authority = false;

  const state = { token: tok.tokenAddress || tok.mint || tok.address, liquidity_usd, pool_initialized, is_transferable, mint_authority, freeze_authority, update_authority };
  console.error('>> Derived LaunchState:', JSON.stringify(state, null, 2));

  console.error('⏳ Running pre-slot analysis (RiskEngine)');
  const execution = await (sim.pre_slot_analysis_with_liquidity ? sim.pre_slot_analysis_with_liquidity(state) : sim.pre_slot_analysis(state));
  console.error('>> Decision allowed=', execution.allowed);
  // report Jupiter quote details if available
  try{
    if(state && state.jupiter_quote){
      console.error('>> Jupiter quote (raw):', JSON.stringify(state.jupiter_quote));
    }
    if(state && state.jupiter_priceImpact !== undefined && state.jupiter_priceImpact !== null){
      console.error('>> Jupiter priceImpactPct:', state.jupiter_priceImpact);
    }
  }catch(e){}

  // Prepare slot clock and trigger soon
  const clock = new sim.SlotClock(100000);
  const target_slot = clock.current_slot() + 2;
  console.error(`🕒 Waiting for target slot ${target_slot} (start_slot=100000)`);
  const before = Date.now();
  await sim.slot_trigger(clock, target_slot, execution);
  const elapsed = Date.now() - before;
  console.error('>> Simulation complete. elapsedMs=', elapsed);
}

if(require.main === module) main().catch(e=>{ console.error('Live fetch+sim failed', e); process.exit(1); });
