#!/usr/bin/env node
/* Lightweight Slot-aware sniper simulator (no RPC, no trades) */
const { argv } = require('process');

// 1) Constants
const SLOT_DURATION_MS = 400; // average Solana slot duration
const TRIGGER_WINDOW_MS = 5; // first 5ms of slot

// 2) LaunchState model (JS object)
class LaunchState {
  constructor({ token, liquidity_usd, pool_initialized, is_transferable, mint_authority, freeze_authority, update_authority }){
    this.token = token;
    this.liquidity_usd = liquidity_usd;
    this.pool_initialized = pool_initialized;
    this.is_transferable = is_transferable;
    this.mint_authority = mint_authority;
    this.freeze_authority = freeze_authority;
    this.update_authority = update_authority;
  }
}

// 3) SlotClock
class SlotClock {
  constructor(start_slot){
    this.start_time = Date.now();
    this.start_slot = Number(start_slot)||0;
  }
  current_slot(){
    const elapsed_ms = Date.now() - this.start_time;
    return this.start_slot + Math.floor(elapsed_ms / SLOT_DURATION_MS);
  }
  ms_into_slot(){
    const elapsed_ms = Date.now() - this.start_time;
    return elapsed_ms % SLOT_DURATION_MS;
  }
}

// 4) RiskEngine
class RiskEngine {
  evaluate(state){
    if(!state) return false;
    if(state.liquidity_usd < 5000) return false;
    if(state.mint_authority || state.freeze_authority) return false;
    if(!state.pool_initialized) return false;
    if(!state.is_transferable) return false;
    return true;
  }
}

// 5) ExecutionGraph
class ExecutionGraph {
  constructor(allowed){ this.allowed = !!allowed; }
  trigger(){
    if(this.allowed){
      console.error('⚡ EXECUTION TRIGGERED (simulation)');
    } else {
      console.error('⛔ BLOCKED BY RISK ENGINE');
    }
  }
}

// 6) Pre-slot analysis
function pre_slot_analysis(state){
  const engine = new RiskEngine();
  const decision = engine.evaluate(state);
  return new ExecutionGraph(decision);
}

// 7) Zero-decision trigger (busy-wait with micro-sleep)
async function slot_trigger(clock, target_slot, execution){
  return new Promise((resolve)=>{
    const iv = setInterval(()=>{
      const slot = clock.current_slot();
      const ms = clock.ms_into_slot();
      // log a tiny heartbeat for observability
      // Check target and trigger window
      if(slot === target_slot && ms <= TRIGGER_WINDOW_MS){
        try{ execution.trigger(); }catch(e){}
        clearInterval(iv);
        resolve({ slot, ms });
      }
    }, 0);
  });
}

// 8) Runner / CLI
async function runSimulation(opts={}){
  const start_slot = Number(opts.start_slot||100000);
  const target_slot = Number(opts.target_slot|| (start_slot + Number(opts.offset||5)));
  const token = opts.token || 'MEME_SOL';
  const state = new LaunchState({ token, liquidity_usd: Number(opts.liquidity_usd||12000), pool_initialized: opts.pool_initialized!==undefined ? !!opts.pool_initialized : true, is_transferable: opts.is_transferable!==undefined ? !!opts.is_transferable : true, mint_authority: !!opts.mint_authority, freeze_authority: !!opts.freeze_authority, update_authority: !!opts.update_authority });

  console.error('⏳ Pre-slot analysis...');
  const execution_graph = pre_slot_analysis(state);

  console.error(`🕒 Starting SlotClock at ${start_slot} -> waiting for target ${target_slot}`);
  const clock = new SlotClock(start_slot);
  const before = Date.now();
  const res = await slot_trigger(clock, target_slot, execution_graph);
  const elapsed = Date.now() - before;
  console.error(`✅ Trigger attempt finished. slot=${res.slot} msIntoSlot=${res.ms} elapsedMs=${elapsed}`);
}

if(require.main === module){
  // simple CLI parsing
  const start = argv[2] || process.env.SIM_START_SLOT || '100000';
  const offsetOrTarget = argv[3] || process.env.SIM_TARGET || '100005';
  const isOffset = String(offsetOrTarget).includes('+') ? true : false;
  let target = offsetOrTarget;
  if(!isNaN(Number(offsetOrTarget)) && Number(offsetOrTarget) > 1000000){ target = Number(offsetOrTarget); }
  if(!isNaN(Number(offsetOrTarget)) && Number(offsetOrTarget) <= 1000000 && Number(offsetOrTarget) < Number(start)){
    // treat as offset
    target = Number(start) + Number(offsetOrTarget);
  }
  // allow passing offset like +5
  if(String(offsetOrTarget).startsWith('+')) target = Number(start) + Number(offsetOrTarget.replace('+',''));

  // fallback: if second arg omitted use start+5
  if(!target) target = Number(start) + 5;

  const opts = { start_slot: Number(start), target_slot: Number(target), offset: Number(target) - Number(start), token: process.env.SIM_TOKEN || 'MEME_SOL' };
  runSimulation(opts).catch(e=>{ console.error('Simulation failed', e); process.exit(1); });
}

module.exports = { LaunchState, SlotClock, RiskEngine, ExecutionGraph, pre_slot_analysis, slot_trigger, runSimulation };
