#!/usr/bin/env node
/**
 * collect_until_mint.js
 * Repeatedly calls sniper.collectFreshMints until at least one mint is collected.
 * Usage: DEBUG_WS=1 node collect_until_mint.js [attempts=10] [timeoutMs=30000] [backoffMs=2000]
 */
require('dotenv').config();
const sniper = require('../../sniper.js');

async function sleep(ms){ return new Promise(r=>setTimeout(r, ms)); }

async function run(attempts = 10, timeoutMs = 30000, backoffMs = 2000){
  attempts = Number(attempts) || 10;
  timeoutMs = Number(timeoutMs) || 30000;
  backoffMs = Number(backoffMs) || 2000;
  console.error(`collect_until_mint: attempts=${attempts} timeoutMs=${timeoutMs} backoffMs=${backoffMs}`);
  for(let i=1;i<=attempts;i++){
    try{
      console.error(`Attempt ${i}/${attempts}: calling collectFreshMints({ maxCollect:1, timeoutMs: ${timeoutMs} })`);
      const res = await sniper.collectFreshMints({ maxCollect: 1, timeoutMs });
      if(Array.isArray(res) && res.length>0){
        console.log('COLLECTED', JSON.stringify(res, null, 2));
        return res;
      }
      console.error(`Attempt ${i} returned no mints.`);
    }catch(e){ console.error(`Attempt ${i} error:`, e && e.stack || e); }
    if(i < attempts) {
      const wait = backoffMs * i; // linear backoff
      console.error(`Waiting ${wait}ms before next attempt...`);
      // small jitter
      await sleep(Math.floor(Math.random()*300));
    }
  }
  console.error('All attempts exhausted without collecting a mint');
  return null;
}

(async ()=>{
  const argv = process.argv.slice(2);
  const attempts = argv[0] || process.env.COLLECT_ATTEMPTS || 10;
  const timeoutMs = argv[1] || process.env.COLLECT_TIMEOUT_MS || 30000;
  const backoffMs = argv[2] || process.env.COLLECT_BACKOFF_MS || 2000;
  const res = await run(attempts, timeoutMs, backoffMs);
  if(!res) process.exit(2);
  process.exit(0);
})();
