#!/usr/bin/env node
require('dotenv').config();
const axios = require('axios');

const HELIUS_RPC_URLS = (process.env.HELIUS_RPC_URLS || process.env.HELIUS_RPC_URL || process.env.SOLANA_RPC_URL || '').toString().split(',').map(s=>s.trim()).filter(Boolean);
const HELIUS_KEYS = (process.env.HELIUS_API_KEYS || process.env.HELIUS_API_KEY || '').toString().split(',').map(s=>s.trim()).filter(Boolean);
if(HELIUS_RPC_URLS.length===0) HELIUS_RPC_URLS.push('https://mainnet.helius-rpc.com/');
let callCount = 0;
async function heliusRpc(method, params){
  const url = HELIUS_RPC_URLS[callCount % HELIUS_RPC_URLS.length];
  const headers = Object.assign({'Content-Type':'application/json'}, HELIUS_KEYS[callCount % Math.max(1, HELIUS_KEYS.length)] ? { 'x-api-key': HELIUS_KEYS[callCount % Math.max(1, HELIUS_KEYS.length)] } : {});
  callCount = (callCount + 1) >>> 0;
  try{
    const r = await axios.post(url, { jsonrpc: '2.0', id:1, method, params }, { headers, timeout: 10000 });
    return r.data && (r.data.result || r.data);
  }catch(e){ return { __error: e && e.message ? e.message : String(e) } }
}

async function enrichMint(mint){
  const out = { mint };
  const sigs = await heliusRpc('getSignaturesForAddress', [mint, { limit: 4 }]);
  out.signatures = sigs;
  try{
    if(Array.isArray(sigs) && sigs.length>0){
      const s0 = sigs[0];
      const sig = s0.signature || s0.sig || s0.txHash || null;
      if(sig){
        const tx = await heliusRpc('getParsedTransaction', [sig, 'jsonParsed']);
        out.firstTx = tx || null;
      }
    }
  }catch(e){ out.firstTxError = String(e); }
  try{
    const ai = await heliusRpc('getAccountInfo', [mint, { encoding: 'jsonParsed' }]);
    out.accountInfo = ai || null;
  }catch(e){ out.accountInfoError = String(e); }
  return out;
}

async function main(){
  const args = process.argv.slice(2);
  if(args.length===0){
    console.error('Usage: node enrich_mints.js <mint1> [mint2 ...]');
    process.exit(2);
  }
  const results = [];
  for(const m of args){
    try{ const r = await enrichMint(m); results.push(r); }catch(e){ results.push({ mint: m, error: String(e) }); }
  }
  console.log(JSON.stringify(results, null, 2));
}

if(require.main === module) main();
