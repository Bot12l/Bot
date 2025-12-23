#!/usr/bin/env node
const fs = require('fs');
const path = require('path');
const infile = '/tmp/fsm_metrics.jsonl';
const outfile = path.resolve(__dirname, 'sample_mints_enriched.json');

if(!fs.existsSync(infile)){
  console.error('Metrics file not found:', infile);
  process.exit(2);
}

const lines = fs.readFileSync(infile,'utf8').trim().split(/\n+/).filter(Boolean);
const out = [];
for(const l of lines){
  try{
    const obj = JSON.parse(l);
    const sol = !!obj.solletCreatedHere;
    const led = !!obj.ledgerStrong;
    if(sol !== led){
      const mint = obj.mint || obj.token || obj.tokenAddress || null;
      const signature = obj.signature || obj.sig || obj.txHash || obj.txHash || null;
      const tx = obj.transaction || obj.tx || obj.parsedTransaction || obj.rawTransaction || null;
      const meta = obj.meta || null;
      out.push({
        mint: mint,
        tokenAddress: mint,
        signature: signature,
        slot: obj.slot || obj.slotNum || null,
        solletCreatedHere: sol,
        ledgerStrong: led,
        rawFull: obj,
        transaction: tx,
        meta: meta
      });
    }
  }catch(e){ /* skip */ }
}
fs.writeFileSync(outfile, JSON.stringify(out, null, 2));
console.error('Wrote', out.length, 'enriched disagreement samples to', outfile);
process.exit(0);
