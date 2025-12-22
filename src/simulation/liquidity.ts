import { createJupiterApiClient } from '@jup-ag/api';
import { getPriceInSOL } from '../raydium/raydium.service';
import { getPrice } from '../utils/index';

const SOL_MINT = 'So11111111111111111111111111111111111111112';

export async function checkLiquidityOnJupiter(tokenMint: string, amountSol = 1): Promise<{ tradable: boolean; estimatedPriceSol?: number; note?: string; quote?: any; priceImpact?: number }>{
  try{
    const jupiter = createJupiterApiClient();
    const amt = Math.floor(amountSol * 1e9);
    const quote = await jupiter.quoteGet({ inputMint: SOL_MINT, outputMint: tokenMint, amount: amt, slippageBps: 100 });
    if(!quote) return { tradable: false, note: 'no-quote' };
    const hasRoutes = (Array.isArray((quote as any).routePlan) && (quote as any).routePlan.length>0) || (Array.isArray((quote as any).routes) && (quote as any).routes.length>0) || (Array.isArray((quote as any).routesInfos) && (quote as any).routesInfos.length>0);
    if(!hasRoutes) return { tradable: false, note: 'no-routes', quote };
    // attempt to extract an estimated out amount from common fields
    let estOut = 0;
    try{ estOut = Number((quote as any).outAmount || (quote as any).routesInfos?.[0]?.outAmount || (quote as any).routes?.[0]?.outAmount || (quote as any).routePlan?.[0]?.outAmount || 0); }catch(e){}
    // get a fallback price from Raydium if estOut missing
    let estimatedPriceSol = 0;
    if(estOut > 0){
      estimatedPriceSol = amountSol / estOut;
    } else {
      try{ estimatedPriceSol = await getPriceInSOL(tokenMint); }catch(e){}
    }
    // try to extract price impact if present in the quote
    let priceImpact: number | undefined = undefined;
    try{
      const p = (quote as any).priceImpactPct || (quote as any).priceImpact || (quote as any).routesInfos?.[0]?.priceImpactPct || (quote as any).routePlan?.[0]?.priceImpactPct;
      if(typeof p === 'number') priceImpact = p;
      else if(typeof p === 'string') priceImpact = Number(p);
    }catch(e){}
    return { tradable: true, estimatedPriceSol: estimatedPriceSol || undefined, note: 'routes-found', quote, priceImpact };
  }catch(e:any){
    return { tradable: false, note: String(e && e.message ? e.message : e) };
  }
}

export async function estimateLiquidityUsd(tokenMint: string, estimatedPriceSol?: number){
  try{
    const priceUsd = await getPrice(tokenMint).catch(()=>0);
    if(priceUsd && estimatedPriceSol){
      // approximate liquidity by assuming 1 SOL worth of token as baseline
      return priceUsd * (estimatedPriceSol || 0) * 1000; // heuristic
    }
    return 0;
  }catch(e){ return 0; }
}

export default { checkLiquidityOnJupiter, estimateLiquidityUsd };
