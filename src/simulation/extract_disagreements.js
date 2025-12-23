#!/usr/bin/env node
const fs = require('fs');
const path = require('path');
const infile = '/tmp/fsm_metrics.jsonl';
const outfile = path.resolve(__dirname, 'sample_mints.json');

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
      out.push({ mint: obj.mint || obj.token, solletCreatedHere: sol, ledgerStrong: led, raw: obj });
    }
  }catch(e){ /* skip */ }
}
fs.writeFileSync(outfile, JSON.stringify(out, null, 2));
console.error('Wrote', out.length, 'disagreement samples to', outfile);
process.exit(0);
