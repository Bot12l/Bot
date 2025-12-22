import { EventEmitter } from 'events';

// Constants
export const SLOT_DURATION_MS = 400;
export const TRIGGER_WINDOW_MS = 5;

export interface LaunchState {
  token: string;
  liquidity_usd: number;
  pool_initialized: boolean;
  is_transferable: boolean;
  mint_authority: boolean;
  freeze_authority: boolean;
  update_authority: boolean;
}

export class SlotClock extends EventEmitter {
  private start_time: number;
  private start_slot: number;
  constructor(start_slot: number){
    super();
    this.start_time = Date.now();
    this.start_slot = Number(start_slot) || 0;
  }
  current_slot(): number{
    const elapsed_ms = Date.now() - this.start_time;
    return this.start_slot + Math.floor(elapsed_ms / SLOT_DURATION_MS);
  }
  ms_into_slot(): number{
    const elapsed_ms = Date.now() - this.start_time;
    return elapsed_ms % SLOT_DURATION_MS;
  }
}

export class RiskEngine {
  evaluate(state: LaunchState): boolean{
    if(!state) return false;
    if(state.liquidity_usd < 5000) return false;
    if(state.mint_authority || state.freeze_authority) return false;
    if(!state.pool_initialized) return false;
    if(!state.is_transferable) return false;
    return true;
  }
}

export class ExecutionGraph {
  allowed: boolean;
  constructor(allowed: boolean){ this.allowed = !!allowed; }
  trigger(){
    if(this.allowed) console.error('⚡ EXECUTION TRIGGERED (simulation - ts)');
    else console.error('⛔ BLOCKED BY RISK ENGINE (simulation - ts)');
  }
}

export function pre_slot_analysis(state: LaunchState): ExecutionGraph{
  const engine = new RiskEngine();
  const decision = engine.evaluate(state);
  return new ExecutionGraph(decision);
}

// Runtime liquidity check helper (optional live check via Jupiter)
import { checkLiquidityOnJupiter, estimateLiquidityUsd } from './liquidity';

export async function pre_slot_analysis_with_liquidity(state: LaunchState): Promise<ExecutionGraph>{
  try{
    const res = await checkLiquidityOnJupiter(state.token, 1).catch(()=>({ tradable: false }));
    if(res && (res as any).tradable){
      const estUsd = await estimateLiquidityUsd(state.token, (res as any).estimatedPriceSol).catch(()=>0);
      // attach estimated liquidity and quote info for observability
      (state as any).liquidity_usd = estUsd || state.liquidity_usd || 0;
      (state as any).pool_checked = true;
      (state as any).jupiter_quote = (res as any).quote || null;
      (state as any).jupiter_priceImpact = (res as any).priceImpact || null;
    } else {
      (state as any).pool_checked = false;
    }
  }catch(e){}
  return pre_slot_analysis(state);
}

export function slot_trigger(clock: SlotClock, target_slot: number, execution: ExecutionGraph): Promise<{slot:number, ms:number}>{
  return new Promise((resolve)=>{
    const iv = setInterval(()=>{
      const slot = clock.current_slot();
      const ms = clock.ms_into_slot();
      if(slot === target_slot && ms <= TRIGGER_WINDOW_MS){
        try{ execution.trigger(); }catch(e){}
        clearInterval(iv);
        resolve({ slot, ms });
      }
    }, 0);
  });
}

export const stateStream = new EventEmitter();

export default { SLOT_DURATION_MS, TRIGGER_WINDOW_MS, SlotClock, RiskEngine, ExecutionGraph, pre_slot_analysis, slot_trigger, stateStream };
